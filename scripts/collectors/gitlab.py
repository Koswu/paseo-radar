#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
GitLab MR Provider（依赖本机已登录的 glab CLI）
收集：
1. 指派我 Review 且尚未 Approve 的非 Draft MR
2. 我自己的活跃 Open MR 中需要推进的事项（未决评论 / CI 失败 / 已批且全绿可合并 / Draft 已绿待提审）
同时输出 entitySignals（含 recently merged MR 的 terminal 信号与关联实体链接）供跨源关联。
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from radar_provider import (
    RadarProvider,
    dedupe_strs,
    expand_repo_cwd,
    extract_issue_keys,
    stable_hash,
    utc_now,
)

MR_CLOSED_REPLY_RE = (
    r"(?:MR|PR|Merge Request|Pull Request|!\d+|#\d+)[^\n，。；]{0,24}"
    r"(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)(?:已合并|已合入|已关闭)"
    r"|\b(?:MR|PR|Merge Request|Pull Request|!\d+|#\d+)\s+(?:has been\s+)?(?:merged|closed)\b"
)

provider = RadarProvider(
    provider_id="gitlab",
    display_name="GitLab",
    description="GitLab Merge Requests（基于 glab CLI）",
    icon="gitlab",
    config_schema={
        "type": "object",
        "properties": {
            "hostname": {"type": "string", "default": "", "description": "GitLab 主机名（留空使用 glab 默认登录主机）"},
            "userId": {"type": "integer", "description": "可选 GitLab 用户 ID（留空时自动通过 glab api user 解析）"},
            "repoPaths": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "URL 子串到本地 Git 仓库路径的映射",
            },
        },
    },
    link_matchers=[
        {
            "id": "gitlab-mr",
            "urlRegex": r"^https?://[^/\s]+/([A-Za-z0-9_./-]+?)/-/merge_requests/(\d+)(?:[/?#].*)?$",
            "flags": "i",
            "kind": "gitlab",
            "labelTemplate": "!$2",
            "subIdTemplate": "!$2",
            "entityKeyTemplate": "mr:$1_lower!$2",
        }
    ],
    entity_templates=[
        {
            "entityPrefix": "mr",
            "tokenRegex": r"(?:^|[\s(（\[])!(\d{3,6})\b",
            "cardIdRegex": r"^gitlab-(?:own|review)-\d+-(\d+)$",
            "keyTemplate": "!$1",
            "kind": "gitlab",
            "labelTemplate": "!$1",
            "deterministicLiveClaim": True,
        }
    ],
)


def pick_role_hint(title: str) -> str:
    lower = title.lower()
    if any(k in lower for k in ("rfc", "技术方案", "方案设计", "前端", "react", "ui", "拆解", "架构")):
        return "design"
    return "backend"


def gl_api(hostname: str, endpoint: str, paginate: bool = False) -> Any:
    cmd = ["glab", "api", "--method", "GET"]
    if hostname:
        cmd.extend(["--hostname", hostname])
    cmd.append(endpoint)
    if paginate:
        cmd.append("--paginate")
    env = {**os.environ, "GLAB_CHECK_UPDATE": "false", "GIT_TERMINAL_PROMPT": "0"}
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"glab {endpoint} failed: {proc.stderr.strip()[:240]}")
    return json.loads(proc.stdout)


def mr_repo_slug(web_url: str) -> str:
    m = re.match(r"^https?://[^/]+/(.+?)/-/merge_requests/\d+", web_url)
    return m.group(1) if m else ""


def mr_short_label(repo_slug: str, iid: int | str) -> str:
    parts = repo_slug.lower().split("/")
    if len(parts) == 2 and parts[0] == parts[1]:
        return f"!{iid}"
    short = parts[-1] if parts else repo_slug
    return f"{short}!{iid}" if short else f"!{iid}"


def load_detail_cache() -> dict[str, dict[str, Any]]:
    state_dir = os.environ.get("RADAR_PROVIDER_STATE_DIR") or os.environ.get("RADAR_COLLECTOR_STATE_DIR") or ""
    if not state_dir:
        return {}
    p = pathlib.Path(state_dir) / "gitlab_mr_cache.json"
    if p.exists():
        try:
            data = json.loads(p.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            pass
    return {}


def save_detail_cache(cache: dict[str, dict[str, Any]]) -> None:
    state_dir = os.environ.get("RADAR_PROVIDER_STATE_DIR") or os.environ.get("RADAR_COLLECTOR_STATE_DIR") or ""
    if not state_dir:
        return
    try:
        d = pathlib.Path(state_dir)
        d.mkdir(parents=True, exist_ok=True)
        (d / "gitlab_mr_cache.json").write_text(json.dumps(cache, ensure_ascii=False), "utf-8")
    except Exception:
        pass


@provider.health
def check_health(ctx: dict[str, Any]) -> dict[str, Any]:
    gl_cfg = ctx.get("config") or {}
    hostname = str(gl_cfg.get("hostname") or "")
    me = gl_api(hostname, "user")
    username = str(me.get("username") or "")
    uid = me.get("id")
    if not username and not uid:
        return {"ok": False, "identity": None, "message": "Unable to resolve current GitLab user"}
    host_note = f" on {hostname}" if hostname else ""
    return {
        "ok": True,
        "identity": f"@{username}" if username else f"uid:{uid}",
        "message": f"Authenticated as @{username} (id={uid}){host_note}",
    }


@provider.wait
def check_wait(predicate: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    gl_cfg = ctx.get("config") or {}
    hostname = str(gl_cfg.get("hostname") or "")
    wtype = str(predicate.get("type") or "mr_merged").strip()
    params = predicate.get("params") if isinstance(predicate.get("params"), dict) else {}

    pid = params.get("projectId") or params.get("repo")
    iid = params.get("iid")
    url = str(params.get("url") or "").strip()
    if (not pid or not iid) and url:
        m = re.match(r"^https?://[^/]+/(.+?)/-/merge_requests/(\d+)", url)
        if m:
            pid = pid or urllib.parse.quote(m.group(1), safe="")
            iid = iid or int(m.group(2))
    elif isinstance(pid, str) and "/" in pid:
        pid = urllib.parse.quote(pid, safe="")

    if not pid or not iid:
        return {"status": "failed", "note": "Missing projectId/repo or iid in GitLab wait predicate"}

    det = gl_api(hostname, f"projects/{pid}/merge_requests/{iid}")
    state = str(det.get("state") or "").lower()
    if state in ("merged", "closed"):
        return {"status": "ready", "note": f"!{iid} 已变为 {state}"}

    if wtype == "pipeline_success":
        head_pipe = det.get("head_pipeline") or {}
        p_status = str(head_pipe.get("status") or "").lower()
        if p_status in ("success", "failed", "canceled"):
            return {"status": "ready", "note": f"!{iid} 流水线已结束，状态: {p_status}"}
        return {"status": "pending", "note": f"!{iid} 流水线状态: {p_status or 'running'}"}

    if wtype == "mr_approved":
        app = gl_api(hostname, f"projects/{pid}/merge_requests/{iid}/approvals")
        approvers = [
            a["user"]["username"]
            for a in app.get("approved_by", [])
            if a.get("user") and not a["user"].get("bot")
        ]
        if approvers:
            return {"status": "ready", "note": f"!{iid} 已获 {', '.join(approvers)} Approve"}
        return {"status": "pending", "note": f"!{iid} 尚未获得 Approve"}

    return {"status": "pending", "note": f"!{iid} 仍处于 {state} 状态"}


@provider.sync
def sync(params: dict[str, Any]) -> dict[str, Any]:
    gl_cfg = params.get("config") or {}
    global_cfg = params.get("globalConfig") or {}
    known_hashes: dict[str, str] = params.get("knownHashes") or {}

    hostname = str(gl_cfg.get("hostname") or "")
    allowed_prefixes = set(gl_cfg.get("issueTeamPrefixes") or global_cfg.get("issueTeamPrefixes") or []) or None
    repo_map: dict[str, str] = gl_cfg.get("repoPaths") or {}
    default_repo: str | None = gl_cfg.get("defaultRepoPath") or global_cfg.get("defaultRepoPath")

    uid = gl_cfg.get("userId")
    if not uid:
        me = gl_api(hostname, "user")
        uid = me["id"]

    items: list[dict[str, Any]] = []
    entity_signals_map: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    cutoff_recent = (utc_now() - datetime.timedelta(days=14)).isoformat()

    def upsert_signal(ekey: str, state: str | None = None, link: dict[str, str] | None = None) -> None:
        norm = ekey.strip().lower()
        if not norm:
            return
        entry = entity_signals_map.setdefault(norm, {"entityKey": norm})
        if state:
            entry["state"] = state
        if link and link.get("url"):
            links_list: list[dict[str, str]] = entry.setdefault("links", [])
            if not any(x.get("url") == link["url"] for x in links_list):
                links_list.append(link)

    # 1. Recently merged MRs by me (for downstream closing detection)
    try:
        merged_q = urllib.parse.urlencode(
            {"scope": "all", "author_id": uid, "state": "merged", "updated_after": cutoff_recent, "per_page": 50}
        )
        for mr in gl_api(hostname, f"merge_requests?{merged_q}"):
            web_url = mr.get("web_url") or ""
            iid = mr.get("iid")
            if not web_url:
                continue
            r_slug = mr_repo_slug(web_url)
            mr_link = {"kind": "gitlab", "label": mr_short_label(r_slug, iid or ""), "url": web_url}
            if r_slug and iid:
                upsert_signal(f"mr:{r_slug.lower()}!{iid}", state="terminal", link=mr_link)
            if iid:
                upsert_signal(f"mr:!{iid}", state="terminal", link=mr_link)
            upsert_signal(f"url:{web_url.lower()}", state="terminal", link=mr_link)
            blob = f"{mr.get('title') or ''}\n{mr.get('description') or ''}"
            branch = mr.get("source_branch") or ""
            for ik in extract_issue_keys(blob, allowed_prefixes, include_branch_tokens=branch):
                upsert_signal(f"issue:{ik.lower()}", link=mr_link)
    except Exception as exc:
        warnings.append(f"merged MRs query failed: {exc}")

    detail_cache = load_detail_cache()
    next_cache: dict[str, dict[str, Any]] = {}

    # 2. MRs waiting on my review
    rev_q = urllib.parse.urlencode(
        {"scope": "all", "reviewer_id": uid, "state": "opened", "per_page": 30, "order_by": "updated_at", "sort": "desc"}
    )
    reviewer_mrs = gl_api(hostname, f"merge_requests?{rev_q}")
    for mr in reviewer_mrs[:12]:
        if mr.get("draft") or mr.get("work_in_progress"):
            continue
        pid = mr["project_id"]
        iid = mr["iid"]
        card_id = f"gitlab-review-{pid}-{iid}"
        list_sig = stable_hash({"sha": mr.get("sha"), "updated": mr.get("updated_at")})
        cached_rev = detail_cache.get(card_id)

        if cached_rev and cached_rev.get("listSig") == list_sig and (
            known_hashes.get(card_id) == list_sig or cached_rev.get("approvedByMe") is not None
        ):
            approved_by_me = bool(cached_rev.get("approvedByMe"))
            next_cache[card_id] = cached_rev
        else:
            approved_by_me = False
            try:
                approvals = gl_api(hostname, f"projects/{pid}/merge_requests/{iid}/approvals")
                approved_ids = {a["user"]["id"] for a in approvals.get("approved_by", []) if a.get("user")}
                approved_by_me = uid in approved_ids
                next_cache[card_id] = {"listSig": list_sig, "approvedByMe": approved_by_me}
            except Exception:
                pass

        if approved_by_me:
            continue

        author = (mr.get("author") or {}).get("username") or "同事"
        ref = mr.get("references", {}).get("full") or f"!{iid}"
        url = mr["web_url"]
        repo_slug = mr_repo_slug(url)
        title = mr.get("title", "")
        desc = (mr.get("description") or "").strip()
        blob = f"{title}\n{desc}"
        issue_keys = extract_issue_keys(blob, allowed_prefixes, include_branch_tokens=mr.get("source_branch") or "")

        mr_link = {"kind": "gitlab", "label": mr_short_label(repo_slug, iid), "url": url}
        ekeys = [f"mr:{repo_slug.lower()}!{iid}"] if repo_slug else [f"mr:!{iid}"]
        for ik in issue_keys:
            ekeys.append(f"issue:{ik.lower()}")
            upsert_signal(f"issue:{ik.lower()}", link=mr_link)

        repo_cwd = expand_repo_cwd(url, repo_map, default_repo)
        repo_flag = f" -R {repo_slug}" if repo_slug else ""
        items.append(
            {
                "id": card_id,
                "source": "gitlab",
                "archetype": "code_change",
                "intent": "review",
                "group": "urgent",
                "badge": "待我 Review",
                "title": f"{ref} {title}",
                "summary": f"{author} 指派你 Review，尚未 Approve。",
                "url": url,
                "links": [mr_link],
                "updatedAt": mr.get("updated_at") or utc_now().isoformat(),
                "stateHash": list_sig,
                "entityKeys": dedupe_strs(ekeys),
                "relatedKeys": dedupe_strs(issue_keys + [f"!{iid}", url]),
                "scanText": desc[:2000] if desc else None,
                "context": desc[:1200] if desc else None,
                "hint": (
                    f"可用 `glab mr view {iid}{repo_flag} --comments` 与 `glab mr diff` 查看改动与评论上下文；"
                    "聚焦确凿逻辑或边界风险，未经确认禁止对外发表评论或 Approve。"
                ),
                "workspaceHint": {
                    "repoPath": repo_cwd,
                    "branchSlug": f"review-mr-{iid}",
                    "preferWorktree": False,
                },
                "roleHint": pick_role_hint(title),
                "prepLabel": "后台先查",
                "workLabel": "开会话处理 ↗",
            }
        )

    # 3. My own active open MRs (updated in last 14 days)
    own_q = urllib.parse.urlencode(
        {
            "scope": "all",
            "author_id": uid,
            "state": "opened",
            "updated_after": cutoff_recent,
            "per_page": 30,
            "order_by": "updated_at",
            "sort": "desc",
        }
    )
    own_mrs = (gl_api(hostname, f"merge_requests?{own_q}") or [])[:15]

    for mr in own_mrs:
        url = mr["web_url"]
        repo_slug = mr_repo_slug(url)
        iid = mr["iid"]
        title = mr.get("title", "")
        list_branch = mr.get("source_branch") or ""
        list_blob = f"{title}\n{mr.get('description') or ''}"
        list_issue_keys = extract_issue_keys(list_blob, allowed_prefixes, include_branch_tokens=list_branch)
        mr_link = {"kind": "gitlab", "label": mr_short_label(repo_slug, iid), "url": url}
        if repo_slug and iid:
            upsert_signal(f"mr:{repo_slug.lower()}!{iid}", state="open", link=mr_link)
        if iid:
            upsert_signal(f"mr:!{iid}", state="open", link=mr_link)
        upsert_signal(f"url:{url.lower()}", state="open", link=mr_link)
        for ik in list_issue_keys:
            upsert_signal(f"issue:{ik.lower()}", link=mr_link)

    mrs_to_fetch: list[dict[str, Any]] = []
    cached_bundles: list[tuple[dict[str, Any], dict[str, Any]]] = []

    for mr in own_mrs:
        pid = mr["project_id"]
        iid = mr["iid"]
        card_id = f"gitlab-own-{pid}-{iid}"
        list_sig = stable_hash(
            {
                "sha": mr.get("sha"),
                "updated": mr.get("updated_at"),
                "draft": bool(mr.get("draft") or mr.get("work_in_progress")),
            }
        )
        cached = detail_cache.get(card_id)
        if (
            cached
            and cached.get("listSig") == list_sig
            and isinstance(cached.get("summaryState"), dict)
            and (
                not cached.get("stateHash")
                or known_hashes.get(card_id) == cached.get("stateHash")
            )
        ):
            next_cache[card_id] = cached
            cached_bundles.append((mr, cached["summaryState"]))
        else:
            mrs_to_fetch.append(mr)

    def fetch_own_mr_summary(mr_obj: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
        p_id = mr_obj["project_id"]
        m_iid = mr_obj["iid"]
        try:
            det = gl_api(hostname, f"projects/{p_id}/merge_requests/{m_iid}")
            app = gl_api(hostname, f"projects/{p_id}/merge_requests/{m_iid}/approvals")
            disc = gl_api(hostname, f"projects/{p_id}/merge_requests/{m_iid}/discussions?per_page=100")

            head_pipe = det.get("head_pipeline") or {}
            pipe_status = head_pipe.get("status") if head_pipe.get("sha") == det.get("sha") else "stale"
            approved_by = [
                a["user"]["username"]
                for a in app.get("approved_by", [])
                if a.get("user") and a["user"]["id"] != uid and not a["user"].get("bot")
            ]
            unresolved_authors: list[str] = []
            unresolved_excerpts: list[str] = []
            for d in disc:
                for note in d.get("notes", []) or []:
                    if note.get("resolvable") and not note.get("resolved"):
                        au = note.get("author") or {}
                        if au.get("id") != uid and not au.get("bot"):
                            uname = au.get("username") or "reviewer"
                            unresolved_authors.append(uname)
                            body_txt = re.sub(r"\s+", " ", (note.get("body") or "").strip())
                            if body_txt:
                                unresolved_excerpts.append(f"@{uname}: {body_txt[:240]}")

            reviewers = [r.get("username") for r in (det.get("reviewers") or []) if r.get("username")]
            summary_state = {
                "sha": det.get("sha"),
                "updated_at": det.get("updated_at") or mr_obj.get("updated_at"),
                "description": det.get("description") or mr_obj.get("description") or "",
                "source_branch": det.get("source_branch") or mr_obj.get("source_branch") or f"mr-{m_iid}",
                "pipe_status": pipe_status,
                "approved_by": approved_by,
                "unresolved_authors": unresolved_authors,
                "unresolved_excerpts": unresolved_excerpts[:5],
                "reviewers": reviewers,
            }
            return mr_obj, summary_state
        except Exception:
            return None

    fetched_bundles: list[tuple[dict[str, Any], dict[str, Any]]] = []
    if mrs_to_fetch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            fetched_bundles = [b for b in pool.map(fetch_own_mr_summary, mrs_to_fetch) if b is not None]

    for mr, sstate in cached_bundles + fetched_bundles:
        pid = mr["project_id"]
        iid = mr["iid"]
        card_id = f"gitlab-own-{pid}-{iid}"
        url = mr["web_url"]
        repo_slug = mr_repo_slug(url)
        title = mr.get("title", "")
        is_draft = bool(mr.get("draft") or mr.get("work_in_progress"))
        mr_link = {"kind": "gitlab", "label": mr_short_label(repo_slug, iid), "url": url}

        pipe_status = sstate.get("pipe_status")
        approved_by: list[str] = list(sstate.get("approved_by") or [])
        unresolved_authors: list[str] = list(sstate.get("unresolved_authors") or [])
        unresolved_excerpts: list[str] = list(sstate.get("unresolved_excerpts") or [])
        reviewers: list[str] = list(sstate.get("reviewers") or [])
        desc = str(sstate.get("description") or "")
        source_branch = str(sstate.get("source_branch") or f"mr-{iid}")

        state_hash = stable_hash(
            {
                "sha": sstate.get("sha"),
                "draft": is_draft,
                "pipe": pipe_status,
                "approved": approved_by,
                "unresolved": len(unresolved_authors),
            }
        )
        list_sig = stable_hash(
            {
                "sha": mr.get("sha"),
                "updated": mr.get("updated_at"),
                "draft": is_draft,
            }
        )
        next_cache[card_id] = {
            "listSig": list_sig,
            "stateHash": state_hash,
            "summaryState": sstate,
        }

        blob = f"{title}\n{desc}"
        lin_keys = extract_issue_keys(blob, allowed_prefixes, include_branch_tokens=source_branch)

        reason = None
        badge = "我的 MR"
        intent = "resolve_feedback"
        work_label = "新建分支开发 ↗"
        prefer_worktree = True

        if unresolved_authors:
            who = "、".join(sorted(set(unresolved_authors)))
            reason = f"有 {len(unresolved_authors)} 条来自 {who} 的未 resolve 评审评论；当前 CI 状态：{pipe_status or '无'}。"
            badge = "MR 待改评论"
            intent = "resolve_feedback"
        elif not is_draft and pipe_status in ("failed", "canceled"):
            reason = f"非 Draft MR 的最新流水线失败（{pipe_status}），需排查修复或重跑。"
            badge = "MR CI 失败"
            intent = "fix_ci"
        elif not is_draft and approved_by and pipe_status == "success":
            reason = f"已获 {'、'.join(approved_by)} 批准且最新 CI 全绿，可确认合并与上线。"
            badge = "MR 可合并"
            intent = "merge_ready"
            work_label = "开会话处理 ↗"
            prefer_worktree = False
        elif is_draft and pipe_status == "success":
            rev_note = f"已指派 {'、'.join(reviewers)}" if reviewers else "尚未指派 Reviewer"
            reason = f"Draft 状态但 CI 已通过（{rev_note}），可核对是否转 Ready 提审。"
            badge = "Draft 待提审"
            intent = "merge_ready"

        if not reason:
            continue

        ekeys = [f"mr:{repo_slug.lower()}!{iid}"] if repo_slug else [f"mr:!{iid}"]
        for ik in lin_keys:
            ekeys.append(f"issue:{ik.lower()}")

        repo_cwd = expand_repo_cwd(url, repo_map, default_repo)
        matched_exact_repo = any(pat in url for pat in repo_map if pat)
        context_text = "\n".join(unresolved_excerpts) if unresolved_excerpts else (desc[:800] if desc else None)

        items.append(
            {
                "id": card_id,
                "source": "gitlab",
                "archetype": "code_change",
                "intent": intent,
                "group": "closing",
                "badge": badge,
                "title": f"!{iid} {title}",
                "summary": reason,
                "url": url,
                "links": [mr_link],
                "updatedAt": sstate.get("updated_at") or utc_now().isoformat(),
                "stateHash": state_hash,
                "entityKeys": dedupe_strs(ekeys),
                "relatedKeys": dedupe_strs(lin_keys + [f"!{iid}", url, source_branch]),
                "scanText": desc[:2000] if desc else None,
                "context": context_text,
                "hint": f"源分支 `{source_branch}`；拉齐 MR 评论、CI 状态与关联单据，涉及对外评论、催审或合并前先向我确认。",
                "workspaceHint": {
                    "repoPath": repo_cwd,
                    "existingBranch": source_branch if matched_exact_repo else None,
                    "branchSlug": f"mr-{iid}",
                    "preferWorktree": prefer_worktree,
                },
                "closureGate": {
                    "requireExternalTerminal": True,
                    "terminalBadgeRegex": r"\b(?:Merged|Closed)\b|已合并|已关闭",
                    "terminalReplyRegex": MR_CLOSED_REPLY_RE,
                    "waitPredicate": {
                        "providerId": "gitlab",
                        "type": "mr_merged",
                        "params": {"projectId": pid, "iid": iid, "url": url},
                    },
                },
                "roleHint": pick_role_hint(title),
                "prepLabel": "后台先查",
                "workLabel": work_label,
            }
        )

    save_detail_cache(next_cache)

    return {
        "isFullSnapshot": True,
        "items": items,
        "entitySignals": list(entity_signals_map.values()),
        "warnings": warnings,
    }


if __name__ == "__main__":
    raise SystemExit(provider.run())
