#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
GitHub PR & Issue Provider（支持已登录的 gh CLI 或 GITHUB_TOKEN / GH_TOKEN）
收集：
1. 请求本人 Review 且尚未 Approve 的非 Draft PR
2. 本人创建的活跃 Open PR 中需要推进的事项（变更请求 / CI 失败 / 已获批且 CI 通过待合并 / Draft 已绿待提审）
3. 指派给本人的活跃 Open Issues
同时输出 entitySignals（含 recently merged PR 的 terminal 信号与关联实体链接）供跨源关联。
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
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

PR_CLOSED_REPLY_RE = (
    r"(?:MR|PR|Merge Request|Pull Request|!\d+|#\d+)[^\n，。；]{0,24}"
    r"(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)(?:已合并|已合入|已关闭)"
    r"|\b(?:MR|PR|Merge Request|Pull Request|!\d+|#\d+)\s+(?:has been\s+)?(?:merged|closed)\b"
)

provider = RadarProvider(
    provider_id="github",
    display_name="GitHub",
    description="GitHub Pull Requests & Issues（基于 gh CLI 或 GITHUB_TOKEN）",
    icon="github",
    config_schema={
        "type": "object",
        "properties": {
            "hostname": {"type": "string", "default": "github.com", "description": "GitHub 主机名（如 github.com）"},
            "token": {"type": "string", "description": "可选 Personal Access Token（默认优先使用环境变量 GITHUB_TOKEN 或 gh CLI）"},
            "repoPaths": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "URL 子串到本地 Git 仓库路径的映射",
            },
        },
    },
    link_matchers=[
        {
            "id": "github-pr-or-issue",
            "urlRegex": r"^https?://[^/\s]+/([A-Za-z0-9_.-]+/([A-Za-z0-9_.-]+))/(?:pull|issues)/(\d+)(?:[/?#].*)?$",
            "flags": "i",
            "kind": "github",
            "labelTemplate": "$2#$3",
            "subIdTemplate": "#$3",
            "entityKeyTemplate": "gh:$1_lower#$3",
        }
    ],
    entity_templates=[
        {
            "entityPrefix": "gh",
            "cardIdRegex": r"^github-(?:own|review|issue)-([a-z0-9_.-]+)-(\d+)$",
            "keyTemplate": "$1_lower#$2",
            "kind": "github",
            "labelTemplate": "#$2",
            "deterministicLiveClaim": True,
        }
    ],
)


def pick_role_hint(title: str) -> str:
    lower = title.lower()
    if any(k in lower for k in ("rfc", "design", "frontend", "react", "ui", "ux", "技术方案", "方案设计", "前端", "架构")):
        return "design"
    return "backend"


def parse_repo_from_html_url(html_url: str) -> str:
    m = re.match(r"^https?://[^/]+/([^/]+/[^/]+)/(?:pull|issues)/\d+", html_url)
    return m.group(1) if m else ""


def short_pr_label(repo_slug: str, number: int | str) -> str:
    short = repo_slug.split("/")[-1] if repo_slug else ""
    return f"{short}#{number}" if short else f"#{number}"


class GitHubClient:
    def __init__(self, hostname: str, token: str | None) -> None:
        self.hostname = hostname.strip() or "github.com"
        self.token = token.strip() if token else ""
        self.has_gh = shutil.which("gh") is not None

    def api_get(self, endpoint: str) -> Any:
        if self.token:
            base = (
                "https://api.github.com"
                if self.hostname == "github.com"
                else f"https://{self.hostname}/api/v3"
            )
            url = f"{base}/{endpoint.lstrip('/')}"
            req = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {self.token}",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "paseo-radar",
                },
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                return json.loads(resp.read().decode("utf-8"))

        if not self.has_gh:
            raise RuntimeError(
                "GitHub authentication not configured (install and log in with `gh auth login`, or set GITHUB_TOKEN / providers.json github.config.token)"
            )
        cmd = ["gh", "api", "--method", "GET"]
        if self.hostname and self.hostname != "github.com":
            cmd.extend(["--hostname", self.hostname])
        cmd.append(endpoint)
        env = {**os.environ, "GH_PROMPT_DISABLED": "1", "GIT_TERMINAL_PROMPT": "0"}
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25, env=env)
        if proc.returncode != 0:
            raise RuntimeError(f"gh api {endpoint} failed: {proc.stderr.strip()[:240]}")
        return json.loads(proc.stdout)


def make_client(cfg: dict[str, Any]) -> GitHubClient:
    hostname = str(cfg.get("hostname") or "github.com")
    token = (
        os.environ.get("GITHUB_TOKEN")
        or os.environ.get("GH_TOKEN")
        or str(cfg.get("token") or "")
    )
    return GitHubClient(hostname=hostname, token=token)


@provider.health
def check_health(ctx: dict[str, Any]) -> dict[str, Any]:
    gh = make_client(ctx.get("config") or {})
    me = gh.api_get("user")
    login = str(me.get("login") or "")
    if not login:
        return {"ok": False, "identity": None, "message": "Unable to resolve current GitHub user"}
    return {"ok": True, "identity": f"@{login}", "message": f"Authenticated as @{login} on {gh.hostname}"}


@provider.wait
def check_wait(predicate: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    gh = make_client(ctx.get("config") or {})
    wtype = str(predicate.get("type") or "pr_status").strip()
    params = predicate.get("params") if isinstance(predicate.get("params"), dict) else {}

    repo = str(params.get("repo") or "").strip()
    number = params.get("number")
    url = str(params.get("url") or "").strip()
    if (not repo or not number) and url:
        m = re.match(r"^https?://[^/]+/([^/]+/[^/]+)/(?:pull|issues)/(\d+)", url)
        if m:
            repo = repo or m.group(1)
            number = number or int(m.group(2))

    if not repo or not number:
        return {"status": "failed", "note": "Missing repo or number in GitHub wait predicate"}

    if wtype in ("pr_merged", "pr_closed", "pr_status", "ci_passed"):
        det = gh.api_get(f"repos/{repo}/pulls/{number}")
        if det.get("merged"):
            return {"status": "ready", "note": f"{repo}#{number} 已合并"}
        state = str(det.get("state") or "").lower()
        if state == "closed":
            return {"status": "ready", "note": f"{repo}#{number} 已关闭"}
        if wtype == "ci_passed":
            sha = ((det.get("head") or {}).get("sha")) or ""
            checks = gh.api_get(f"repos/{repo}/commits/{sha}/check-runs?per_page=50") if sha else {}
            runs = (checks.get("check_runs") or []) if isinstance(checks, dict) else []
            pending = [r for r in runs if r.get("status") != "completed"]
            failed = [
                r.get("name") or "check"
                for r in runs
                if r.get("status") == "completed"
                and r.get("conclusion") in ("failure", "timed_out", "cancelled", "action_required")
            ]
            if runs and not pending and not failed:
                return {"status": "ready", "note": f"{repo}#{number} CI 已全部通过"}
            if failed:
                return {"status": "ready", "note": f"{repo}#{number} CI 出现失败: {', '.join(failed[:3])}"}
        return {"status": "pending", "note": f"{repo}#{number} 仍处于 {state} 状态"}

    if wtype == "issue_closed":
        iss = gh.api_get(f"repos/{repo}/issues/{number}")
        state = str(iss.get("state") or "").lower()
        if state == "closed":
            return {"status": "ready", "note": f"{repo}#{number} 已关闭"}
        return {"status": "pending", "note": f"{repo}#{number} 仍处于 {state} 状态"}

    return {"status": "failed", "note": f"Unsupported GitHub wait predicate type: {wtype}"}


@provider.sync
def sync(params: dict[str, Any]) -> dict[str, Any]:
    gh_cfg = params.get("config") or {}
    global_cfg = params.get("globalConfig") or {}
    gh = make_client(gh_cfg)

    allowed_prefixes = set(gh_cfg.get("issueTeamPrefixes") or global_cfg.get("issueTeamPrefixes") or []) or None
    repo_map: dict[str, str] = gh_cfg.get("repoPaths") or {}
    default_repo: str | None = gh_cfg.get("defaultRepoPath") or global_cfg.get("defaultRepoPath")

    me = gh.api_get("user")
    login = str(me.get("login") or "")
    if not login:
        raise RuntimeError("Unable to resolve current GitHub username")

    items: list[dict[str, Any]] = []
    entity_signals_map: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    cutoff_date = (utc_now() - datetime.timedelta(days=14)).strftime("%Y-%m-%d")

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

    # 1. Recently merged PRs authored by me
    try:
        q_merged = urllib.parse.quote(f"is:pr author:{login} is:merged merged:>={cutoff_date}")
        res_merged = gh.api_get(f"search/issues?q={q_merged}&per_page=40&sort=updated&order=desc")
        for pr in res_merged.get("items") or []:
            html_url = pr.get("html_url") or ""
            num = pr.get("number")
            if not html_url:
                continue
            r_slug = parse_repo_from_html_url(html_url)
            pr_link = {"kind": "github", "label": short_pr_label(r_slug, num or ""), "url": html_url}
            if r_slug and num:
                upsert_signal(f"gh:{r_slug.lower()}#{num}", state="terminal", link=pr_link)
            upsert_signal(f"url:{html_url.lower()}", state="terminal", link=pr_link)
            blob = f"{pr.get('title') or ''}\n{pr.get('body') or ''}"
            for ik in extract_issue_keys(blob, allowed_prefixes):
                upsert_signal(f"issue:{ik.lower()}", link=pr_link)
    except Exception as exc:
        warnings.append(f"merged PRs query warning: {exc}")

    # 2. Open PRs requesting my review
    try:
        q_rev = urllib.parse.quote(f"is:pr is:open review-requested:{login} -is:draft")
        res_rev = gh.api_get(f"search/issues?q={q_rev}&per_page=20&sort=updated&order=desc")
        for pr in (res_rev.get("items") or [])[:12]:
            url = pr.get("html_url") or ""
            number = pr.get("number")
            if not url or not number:
                continue
            repo_slug = parse_repo_from_html_url(url)
            title = pr.get("title") or ""
            body = (pr.get("body") or "").strip()
            author = ((pr.get("user") or {}).get("login")) or "author"
            blob = f"{title}\n{body}"
            issue_keys = extract_issue_keys(blob, allowed_prefixes)

            pr_link = {"kind": "github", "label": short_pr_label(repo_slug, number), "url": url}
            ekeys = [f"gh:{repo_slug.lower()}#{number}"] if repo_slug else [f"gh:#{number}"]
            for ik in issue_keys:
                ekeys.append(f"issue:{ik.lower()}")
                upsert_signal(f"issue:{ik.lower()}", link=pr_link)

            repo_cwd = expand_repo_cwd(url, repo_map, default_repo)
            items.append(
                {
                    "id": f"github-review-{repo_slug.lower().replace('/', '-')}-{number}",
                    "source": "github",
                    "archetype": "code_change",
                    "intent": "review",
                    "group": "urgent",
                    "badge": "PR 待我 Review",
                    "title": f"{short_pr_label(repo_slug, number)} {title}",
                    "summary": f"{author} 请求你 Review Pull Request。",
                    "url": url,
                    "links": [pr_link],
                    "updatedAt": pr.get("updated_at") or utc_now().isoformat(),
                    "stateHash": stable_hash({"updated": pr.get("updated_at"), "title": title}),
                    "entityKeys": dedupe_strs(ekeys),
                    "relatedKeys": dedupe_strs(issue_keys + [f"{repo_slug}#{number}", url]),
                    "context": body[:1200] if body else None,
                    "hint": "拉取 PR 描述、评论串与代码 diff，检查逻辑正确性与边界风险；未经确认禁止公开发表评论或提交 Review。",
                    "workspaceHint": {
                        "repoPath": repo_cwd,
                        "branchSlug": f"review-pr-{number}",
                        "preferWorktree": False,
                    },
                    "roleHint": pick_role_hint(title),
                    "prepLabel": "后台先查",
                    "workLabel": "开会话处理 ↗",
                }
            )
    except Exception as exc:
        warnings.append(f"review-requested PRs warning: {exc}")

    # 3. My own active open PRs
    try:
        q_own = urllib.parse.quote(f"is:pr is:open author:{login}")
        res_own = gh.api_get(f"search/issues?q={q_own}&per_page=15&sort=updated&order=desc")
        own_prs = (res_own.get("items") or [])[:12]

        def fetch_pr_detail(
            pr_item: dict[str, Any]
        ) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], dict[str, Any]] | None:
            html_url = pr_item.get("html_url") or ""
            r_slug = parse_repo_from_html_url(html_url)
            num = pr_item.get("number")
            if not r_slug or not num:
                return None
            try:
                det = gh.api_get(f"repos/{r_slug}/pulls/{num}")
                revs = gh.api_get(f"repos/{r_slug}/pulls/{num}/reviews?per_page=50") or []
                sha = ((det.get("head") or {}).get("sha")) or ""
                checks = gh.api_get(f"repos/{r_slug}/commits/{sha}/check-runs?per_page=50") if sha else {}
                return pr_item, det, revs, checks
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            bundles = [b for b in pool.map(fetch_pr_detail, own_prs) if b is not None]

        for pr_item, det, revs, checks in bundles:
            url = det.get("html_url") or pr_item.get("html_url") or ""
            repo_slug = parse_repo_from_html_url(url)
            number = det.get("number")
            title = det.get("title") or ""
            is_draft = bool(det.get("draft"))
            head_ref = ((det.get("head") or {}).get("ref")) or f"pr-{number}"
            head_sha = ((det.get("head") or {}).get("sha")) or ""

            latest_by_user: dict[str, str] = {}
            for rv in revs:
                u = ((rv.get("user") or {}).get("login")) or ""
                st = str(rv.get("state") or "").upper()
                if u and u != login and st in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
                    latest_by_user[u] = st

            changes_by = [u for u, st in latest_by_user.items() if st == "CHANGES_REQUESTED"]
            approved_by = [u for u, st in latest_by_user.items() if st == "APPROVED"]

            runs = (checks.get("check_runs") or []) if isinstance(checks, dict) else []
            failed_runs = [
                r.get("name") or "check"
                for r in runs
                if r.get("status") == "completed"
                and r.get("conclusion") in ("failure", "timed_out", "cancelled", "action_required")
            ]
            pending_runs = [r for r in runs if r.get("status") != "completed"]
            ci_green = len(runs) > 0 and not failed_runs and not pending_runs

            blob = f"{title}\n{det.get('body') or ''}"
            issue_keys = extract_issue_keys(blob, allowed_prefixes, include_branch_tokens=head_ref)
            pr_link = {"kind": "github", "label": short_pr_label(repo_slug, number), "url": url}
            if repo_slug and number:
                upsert_signal(f"gh:{repo_slug.lower()}#{number}", state="open", link=pr_link)
            upsert_signal(f"url:{url.lower()}", state="open", link=pr_link)
            for ik in issue_keys:
                upsert_signal(f"issue:{ik.lower()}", link=pr_link)

            reason = None
            badge = "我的 PR"
            intent = "resolve_feedback"
            work_label = "新建分支开发 ↗"
            prefer_worktree = True

            if changes_by:
                reason = f"{', '.join(changes_by)} 请求了代码修改（Changes requested）。"
                badge = "PR 待改评审"
                intent = "resolve_feedback"
            elif not is_draft and failed_runs:
                reason = f"CI 检查失败（{', '.join(failed_runs[:3])}），需排查修复或重跑。"
                badge = "PR CI 失败"
                intent = "fix_ci"
            elif not is_draft and approved_by and ci_green:
                reason = f"已获 {', '.join(approved_by)} 批准且 CI 通过，可确认合并。"
                badge = "PR 可合并"
                intent = "merge_ready"
                work_label = "开会话处理 ↗"
                prefer_worktree = False
            elif is_draft and ci_green:
                reason = "Draft PR 当前 CI 已全部通过，可核对是否转为 Ready for review。"
                badge = "Draft 待提审"
                intent = "merge_ready"

            if not reason:
                continue

            ekeys = [f"gh:{repo_slug.lower()}#{number}"] if repo_slug else [f"gh:#{number}"]
            for ik in issue_keys:
                ekeys.append(f"issue:{ik.lower()}")

            repo_cwd = expand_repo_cwd(url, repo_map, default_repo)
            matched_exact_repo = any(pat in url for pat in repo_map if pat)

            items.append(
                {
                    "id": f"github-own-{repo_slug.lower().replace('/', '-')}-{number}",
                    "source": "github",
                    "archetype": "code_change",
                    "intent": intent,
                    "group": "closing",
                    "badge": badge,
                    "title": f"{short_pr_label(repo_slug, number)} {title}",
                    "summary": reason,
                    "url": url,
                    "links": [pr_link],
                    "updatedAt": det.get("updated_at") or utc_now().isoformat(),
                    "stateHash": stable_hash(
                        {
                            "sha": head_sha,
                            "draft": is_draft,
                            "changes": changes_by,
                            "approved": approved_by,
                            "failed": failed_runs,
                            "green": ci_green,
                        }
                    ),
                    "entityKeys": dedupe_strs(ekeys),
                    "relatedKeys": dedupe_strs(issue_keys + [f"{repo_slug}#{number}", url, head_ref]),
                    "hint": f"源分支 `{head_ref}`；检查评审意见、CI 日志与代码改动，涉及对外评论或合并前先向我确认。",
                    "workspaceHint": {
                        "repoPath": repo_cwd,
                        "existingBranch": head_ref if matched_exact_repo else None,
                        "branchSlug": f"pr-{number}",
                        "preferWorktree": prefer_worktree,
                    },
                    "closureGate": {
                        "requireExternalTerminal": True,
                        "terminalBadgeRegex": r"\b(?:Merged|Closed)\b|已合并|已关闭",
                        "terminalReplyRegex": PR_CLOSED_REPLY_RE,
                        "waitPredicate": {
                            "providerId": "github",
                            "type": "pr_merged",
                            "params": {"repo": repo_slug, "number": number, "url": url},
                        },
                    },
                    "roleHint": pick_role_hint(title),
                    "prepLabel": "后台先查",
                    "workLabel": work_label,
                }
            )
    except Exception as exc:
        warnings.append(f"own PRs warning: {exc}")

    # 4. Open GitHub Issues assigned to me
    try:
        q_iss = urllib.parse.quote(f"is:issue is:open assignee:{login}")
        res_iss = gh.api_get(f"search/issues?q={q_iss}&per_page=20&sort=updated&order=desc")
        for iss in (res_iss.get("items") or [])[:15]:
            url = iss.get("html_url") or ""
            number = iss.get("number")
            if not url or not number:
                continue
            repo_slug = parse_repo_from_html_url(url)
            title = iss.get("title") or ""
            body = (iss.get("body") or "").strip()
            labels = [lb.get("name") for lb in (iss.get("labels") or []) if isinstance(lb, dict) and lb.get("name")]
            repo_cwd = expand_repo_cwd(url, repo_map, default_repo)
            iss_link = {"kind": "github", "label": short_pr_label(repo_slug, number), "url": url}

            items.append(
                {
                    "id": f"github-issue-{repo_slug.lower().replace('/', '-')}-{number}",
                    "source": "github",
                    "archetype": "work_item",
                    "intent": "implement",
                    "group": "todo",
                    "badge": "GitHub Issue",
                    "title": f"{short_pr_label(repo_slug, number)} {title}",
                    "summary": " · ".join(labels[:4]) if labels else (repo_slug or "Assigned issue"),
                    "url": url,
                    "links": [iss_link],
                    "updatedAt": iss.get("updated_at") or utc_now().isoformat(),
                    "stateHash": stable_hash({"updated": iss.get("updated_at"), "labels": labels}),
                    "entityKeys": [f"gh:{repo_slug.lower()}#{number}"] if repo_slug else [f"gh:#{number}"],
                    "relatedKeys": [f"{repo_slug}#{number}", url],
                    "context": body[:1200] if body else None,
                    "hint": "阅读 Issue 描述与讨论串，在代码库定位相关模块，输出实施路径或完成修改与测试验证。",
                    "workspaceHint": {
                        "repoPath": repo_cwd,
                        "branchSlug": f"issue-{number}",
                        "preferWorktree": True,
                    },
                    "roleHint": pick_role_hint(title),
                    "prepLabel": "后台先查",
                    "workLabel": "新建分支开发 ↗",
                }
            )
    except Exception as exc:
        warnings.append(f"assigned issues warning: {exc}")

    return {
        "isFullSnapshot": True,
        "items": items,
        "entitySignals": list(entity_signals_map.values()),
        "warnings": warnings,
    }


if __name__ == "__main__":
    raise SystemExit(provider.run())
