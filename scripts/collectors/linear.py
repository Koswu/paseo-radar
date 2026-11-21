#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Linear Provider（GraphQL API）
覆盖：
1. 分配给本人的活跃 Cycle / 高优 / In Progress / In Review 单据
2. 本人担任 Lead 且进度已达 100% 的待收尾 Project
同时输出 entitySignals 与 promoteToClosingWhen，由 Radar 自动交叉核对已合并 MR/PR 与跨源合并链接。
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import sys
import tomllib
import urllib.request
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from radar_provider import (
    RadarProvider,
    dedupe_strs,
    expand_repo_cwd,
    stable_hash,
    utc_now,
)

LINEAR_ISSUE_TERMINAL_REPLY_RE = (
    r"(?:Linear|Issue|单据|状态|[A-Z]{2,10}-\d+)[^\n，。；]{0,28}"
    r"(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)"
    r"(?:已更新为|已改为|已设为|已标为|已流转为|更新为|改为)\s*[`\"'*「]*(?:Completed|Done|Canceled|Cancelled|Duplicate)\b"
    r"|(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)已(?:将\s*[A-Z]{2,10}-\d+\s*)?(?:关单|取消单据)"
)

LINEAR_PROJECT_TERMINAL_REPLY_RE = (
    r"^(?![\s\S]*(?:草稿|待确认|确认后))[\s\S]*"
    r"(?:Project Update|项目动态|项目状态|项目)[^\n，。；]{0,28}"
    r"(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)"
    r"(?:已发布|已发出|已提交|已更新为\s*[`\"'*「]*(?:Completed|Canceled)|已完成收尾)"
)

GITLAB_MR_URL_RE = re.compile(
    r"^https?://[^/\s]+/([A-Za-z0-9_./-]+?)/-/merge_requests/(\d+)(?:[/?#].*)?$",
    re.I,
)
GITHUB_PR_URL_RE = re.compile(
    r"^https?://[^/\s]+/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)(?:[/?#].*)?$",
    re.I,
)

provider = RadarProvider(
    provider_id="linear",
    display_name="Linear",
    description="Linear Issues & 100% Projects（基于 GraphQL API）",
    icon="linear",
    config_schema={
        "type": "object",
        "properties": {
            "orgSlug": {"type": "string", "default": "", "description": "Linear Workspace URL slug（用于把单号自动还原为 Linear 链接）"},
            "profile": {"type": "string", "default": "", "description": "~/.config/linear/credentials.toml 中的 profile 名"},
            "token": {"type": "string", "description": "可选 Linear API Key（默认优先读取 LINEAR_API_KEY 或 credentials.toml）"},
            "credentialsFile": {"type": "string", "description": "可选 credentials.toml 路径"},
            "teamPrefixes": {
                "type": "array",
                "items": {"type": "string"},
                "description": "当前团队 Issue 前缀列表（留空时回退读取全局 issueTeamPrefixes）",
            },
        },
    },
    link_matchers=[
        {
            "id": "linear-issue",
            "urlRegex": r"^https://linear\.app/[^/\s?#]+/issue/([A-Za-z]{2,8}-\d{1,6})(?:/[^\s?#]*)?$",
            "flags": "i",
            "kind": "linear",
            "labelTemplate": "$1_upper",
            "entityKeyTemplate": "issue:$1_lower",
        },
        {
            "id": "linear-project",
            "urlRegex": r"^https://linear\.app/[^/\s?#]+/project/([^\s/?#]+)",
            "flags": "i",
            "kind": "linear",
            "labelTemplate": "Linear 项目",
            "entityKeyTemplate": "linear-project:$1_lower",
        },
    ],
)


@provider.manifest
def build_dynamic_manifest(cfg: dict[str, Any], global_cfg: dict[str, Any]) -> dict[str, Any]:
    org_slug = str(cfg.get("orgSlug") or "").strip().strip("/")
    raw_prefixes = cfg.get("teamPrefixes") or global_cfg.get("issueTeamPrefixes") or []
    prefixes = [
        re.sub(r"[^A-Za-z0-9]", "", str(p)).upper()
        for p in raw_prefixes
        if str(p).strip()
    ]
    prefixes = [p for p in prefixes if p]

    if prefixes:
        prefix_alt = "|".join(re.escape(p) for p in prefixes)
        token_re = rf"\b((?:{prefix_alt})-\d{{1,6}})\b"
        branch_re = rf"(?:^|[/_-])((?:{prefix_alt})-\d{{1,6}})\b"
    else:
        token_re = r"\b([A-Z]{2,8}-\d{1,6})\b"
        branch_re = r"(?:^|[/_-])([a-z]{2,8}-\d{1,6})\b"

    issue_template: dict[str, Any] = {
        "entityPrefix": "issue",
        "tokenRegex": token_re,
        "branchTokenRegex": branch_re,
        "cardIdRegex": r"^linear-(?:issue|todo|close)-([a-z]{2,8}-\d{1,6})$",
        "keyTemplate": "$1_lower",
        "kind": "linear",
        "labelTemplate": "$1_upper",
        "deterministicLiveClaim": False,
    }
    if org_slug:
        issue_template["urlTemplate"] = f"https://linear.app/{org_slug}/issue/$1_upper"

    return {"entityTemplates": [issue_template]}


def resolve_linear_token(lin_cfg: dict[str, Any]) -> str:
    if os.environ.get("LINEAR_API_KEY"):
        return os.environ["LINEAR_API_KEY"].strip()
    if lin_cfg.get("token"):
        return str(lin_cfg["token"]).strip()
    cred_file = lin_cfg.get("credentialsFile") or str(
        pathlib.Path.home() / ".config" / "linear" / "credentials.toml"
    )
    p = pathlib.Path(cred_file).expanduser()
    if p.exists():
        parsed = tomllib.loads(p.read_text("utf-8"))
        profile = lin_cfg.get("profile")
        if profile and parsed.get(profile):
            return str(parsed[profile]).strip()
        for val in parsed.values():
            if isinstance(val, str) and val.strip():
                return val.strip()
    raise RuntimeError("Linear token not configured (set LINEAR_API_KEY or ~/.config/linear/credentials.toml)")


def linear_graphql(token: str, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"query": query}
    if variables:
        payload["variables"] = variables
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": token},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if body.get("errors"):
        msg = "; ".join(str(e.get("message") or e) for e in body["errors"])
        raise RuntimeError(f"Linear GraphQL error: {msg[:240]}")
    return body.get("data") or {}


def pick_role_hint(text: str) -> str:
    lower = text.lower()
    if any(k in lower for k in ("rfc", "技术方案", "方案设计", "前端", "react", "ui", "拆解", "架构")):
        return "design"
    return "backend"


def code_change_entity_keys_from_urls(urls: list[str]) -> list[str]:
    keys: list[str] = []
    for raw_url in urls:
        u = raw_url.strip()
        if not u:
            continue
        m_gl = GITLAB_MR_URL_RE.match(u)
        if m_gl:
            keys.append(f"mr:{m_gl.group(1).lower()}!{m_gl.group(2)}")
            continue
        m_gh = GITHUB_PR_URL_RE.match(u)
        if m_gh:
            keys.append(f"gh:{m_gh.group(1).lower()}#{m_gh.group(2)}")
            continue
        keys.append(f"url:{u.lower()}")
    return dedupe_strs(keys)


@provider.health
def check_health(ctx: dict[str, Any]) -> dict[str, Any]:
    token = resolve_linear_token(ctx.get("config") or {})
    data = linear_graphql(token, "{ viewer { id name email } }")
    viewer = data.get("viewer") or {}
    name = str(viewer.get("name") or viewer.get("email") or viewer.get("id") or "")
    if not name:
        return {"ok": False, "identity": None, "message": "Unable to resolve Linear viewer"}
    return {"ok": True, "identity": name, "message": f"Authenticated as {name}"}


@provider.wait
def check_wait(predicate: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    token = resolve_linear_token(ctx.get("config") or {})
    wtype = str(predicate.get("type") or "issue_completed").strip()
    params = predicate.get("params") if isinstance(predicate.get("params"), dict) else {}

    if wtype in ("issue_completed", "issue_state"):
        ident = str(params.get("identifier") or params.get("id") or "").strip()
        if not ident:
            return {"status": "failed", "note": "Missing identifier in Linear wait predicate"}
        data = linear_graphql(
            token,
            "query($id: String!) { issue(id: $id) { identifier state { name type } } }",
            {"id": ident},
        )
        iss = data.get("issue") or {}
        st = iss.get("state") or {}
        st_type = str(st.get("type") or "").lower()
        st_name = str(st.get("name") or "")
        if st_type in ("completed", "canceled"):
            return {"status": "ready", "note": f"{ident} 状态已变为 {st_name} ({st_type})"}
        return {"status": "pending", "note": f"{ident} 当前状态: {st_name}"}

    if wtype == "project_completed":
        pid = str(params.get("projectId") or params.get("id") or "").strip()
        if not pid:
            return {"status": "failed", "note": "Missing projectId in Linear wait predicate"}
        data = linear_graphql(
            token,
            "query($id: String!) { project(id: $id) { name status { name type } } }",
            {"id": pid},
        )
        proj = data.get("project") or {}
        st = proj.get("status") or {}
        st_type = str(st.get("type") or "").lower()
        st_name = str(st.get("name") or "")
        if st_type in ("completed", "canceled"):
            return {"status": "ready", "note": f"项目 {proj.get('name') or pid} 已变为 {st_name}"}
        return {"status": "pending", "note": f"项目当前状态: {st_name}"}

    return {"status": "failed", "note": f"Unsupported Linear wait predicate type: {wtype}"}


@provider.sync
def sync(params: dict[str, Any]) -> dict[str, Any]:
    lin_cfg = params.get("config") or {}
    global_cfg = params.get("globalConfig") or {}
    token = resolve_linear_token(lin_cfg)

    default_repo: str | None = lin_cfg.get("defaultRepoPath") or global_cfg.get("defaultRepoPath")
    repo_cwd = expand_repo_cwd("", None, default_repo)

    query = """
    {
      viewer {
        id
        assignedIssues(
          first: 80,
          filter: { state: { type: { in: ["unstarted", "started"] } } }
        ) {
          nodes {
            id
            identifier
            title
            description
            url
            priority
            priorityLabel
            updatedAt
            archivedAt
            state { name type }
            project { id name url }
            cycle { number name startsAt endsAt }
            attachments { nodes { url title } }
          }
        }
      }
      projects(
        first: 50,
        filter: {
          lead: { isMe: { eq: true } },
          status: { type: { in: ["planned", "started"] } }
        }
      ) {
        nodes {
          id
          name
          url
          progress
          updatedAt
          archivedAt
          status { name type }
        }
      }
    }
    """
    data = linear_graphql(token, query)

    items: list[dict[str, Any]] = []
    entity_signals: list[dict[str, Any]] = []
    now = utc_now()

    for iss in ((data.get("viewer") or {}).get("assignedIssues") or {}).get("nodes") or []:
        if iss.get("archivedAt"):
            continue
        ident = iss["identifier"]
        title = iss["title"]
        desc = (iss.get("description") or "").strip()
        url = iss["url"]
        state_name = iss["state"]["name"]
        prio_label = iss.get("priorityLabel") or "No priority"
        proj_name = (iss.get("project") or {}).get("name")
        cycle = iss.get("cycle")
        att_nodes = (iss.get("attachments") or {}).get("nodes") or []
        att_urls = [a.get("url") or "" for a in att_nodes if a.get("url")]
        mr_atts = [u for u in att_urls if "merge_requests" in u or "/pull/" in u]
        mr_entity_keys = code_change_entity_keys_from_urls(mr_atts)

        links: list[dict[str, str]] = [{"kind": "linear", "label": ident, "url": url}]
        for a in att_nodes:
            a_url = a.get("url") or ""
            if a_url:
                links.append({"kind": "link", "label": a.get("title") or "链接", "url": a_url})

        ekeys = dedupe_strs([f"issue:{ident.lower()}"] + mr_entity_keys)
        entity_signals.append(
            {
                "entityKey": f"issue:{ident.lower()}",
                "state": "open",
                "links": links,
            }
        )

        closure_gate = {
            "requireExternalTerminal": True,
            "terminalBadgeRegex": r"\b(?:Completed|Done|Canceled|Cancelled|Duplicate)\b",
            "terminalReplyRegex": LINEAR_ISSUE_TERMINAL_REPLY_RE,
            "waitPredicate": {
                "providerId": "linear",
                "type": "issue_completed",
                "params": {"identifier": ident},
            },
        }

        is_in_review = state_name.lower() == "in review"
        if is_in_review:
            why = f"{state_name} · {proj_name or '独立单据'} · 待核对验收条件并收尾"
            items.append(
                {
                    "id": f"linear-issue-{ident.lower()}",
                    "source": "linear",
                    "archetype": "work_item",
                    "intent": "close_out",
                    "group": "closing",
                    "badge": "Linear",
                    "title": f"{ident} {title}",
                    "summary": why,
                    "url": url,
                    "links": links,
                    "updatedAt": iss["updatedAt"],
                    "stateHash": stable_hash({"state": state_name, "updated": iss["updatedAt"], "mrs": mr_atts}),
                    "entityKeys": ekeys,
                    "relatedKeys": dedupe_strs([ident, url] + mr_atts),
                    "scanText": desc[:2000] if desc else None,
                    "context": desc[:1200] if desc else None,
                    "hint": "检查单据正文与评论、关联 MR/PR 合并与部署记录；若满足完结条件请准备完结评论草稿（未经确认禁止修改 Linear 状态）。",
                    "workspaceHint": {
                        "repoPath": repo_cwd,
                        "branchSlug": ident.lower(),
                        "preferWorktree": False,
                    },
                    "closureGate": closure_gate,
                    "roleHint": "backend",
                    "prepLabel": "后台先查",
                    "workLabel": "开会话处理 ↗",
                }
            )
            continue

        in_active_cycle = False
        if cycle and cycle.get("endsAt"):
            try:
                ends = datetime.datetime.fromisoformat(cycle["endsAt"].replace("Z", "+00:00"))
                starts_ok = True
                if cycle.get("startsAt"):
                    starts = datetime.datetime.fromisoformat(cycle["startsAt"].replace("Z", "+00:00"))
                    starts_ok = starts <= (now + datetime.timedelta(days=1))
                in_active_cycle = starts_ok and ends >= (now - datetime.timedelta(days=2))
            except Exception:
                in_active_cycle = True

        qualifies_active = in_active_cycle or iss.get("priority", 0) in (1, 2) or state_name == "In Progress"
        if not qualifies_active and not mr_entity_keys:
            continue

        role_hint = pick_role_hint(f"{title} {proj_name or ''}")
        is_rfc = "rfc" in title.lower() or "方案" in title
        meta_parts = [state_name, prio_label]
        if proj_name:
            meta_parts.append(proj_name)
        if cycle and cycle.get("number"):
            meta_parts.append(f"Cycle {cycle['number']}")

        item_dict: dict[str, Any] = {
            "id": f"linear-issue-{ident.lower()}",
            "source": "linear",
            "archetype": "work_item",
            "intent": "implement",
            "group": "todo",
            "badge": "Linear",
            "title": f"{ident} {title}",
            "summary": " · ".join(meta_parts),
            "url": url,
            "links": links,
            "updatedAt": iss["updatedAt"],
            "stateHash": stable_hash({"state": state_name, "prio": prio_label, "updated": iss["updatedAt"], "mrs": mr_atts}),
            "entityKeys": ekeys,
            "relatedKeys": dedupe_strs([ident, url] + mr_atts),
            "scanText": desc[:2000] if desc else None,
            "context": desc[:1200] if desc else None,
            "hint": f"所属项目：{proj_name or '无'}；读取单据上下文与关联文档，在代码库定位模块并推进实现与验证。",
            "workspaceHint": {
                "repoPath": repo_cwd,
                "branchSlug": ident.lower(),
                "preferWorktree": not is_rfc,
            },
            "closureGate": closure_gate,
            "roleHint": role_hint,
            "prepLabel": "后台先查",
            "workLabel": "开会话处理 ↗" if is_rfc else "新建分支开发 ↗",
        }

        if mr_entity_keys:
            item_dict["promoteToClosingWhen"] = {
                "allEntitiesTerminal": mr_entity_keys,
                "dropIfUnmet": not qualifies_active,
                "closingSummarySuffix": "关联 MR/PR 已合并，待核验线上效果后收尾关单",
                "closingHint": "关联代码变更已合并，请核验部署与验收条件，准备完结评论草稿（未经确认禁止修改外部单据状态）。",
            }

        items.append(item_dict)

    for proj in (data.get("projects") or {}).get("nodes") or []:
        if proj.get("archivedAt"):
            continue
        prog = float(proj.get("progress") or 0)
        if prog >= 0.99:
            pname = proj["name"]
            purl = proj["url"]
            pid = proj["id"][:8]
            items.append(
                {
                    "id": f"linear-proj-{pid}",
                    "source": "linear",
                    "archetype": "work_item",
                    "intent": "close_out",
                    "group": "closing",
                    "badge": "100% 项目待收尾",
                    "title": f"项目：{pname}",
                    "summary": f"Linear 项目进度已达 100%（状态：{proj['status']['name']}），可核对旗下 Issue 是否均已上线并起草结项说明。",
                    "url": purl,
                    "links": [{"kind": "linear", "label": "Linear 项目", "url": purl}],
                    "updatedAt": proj["updatedAt"],
                    "stateHash": stable_hash({"status": proj["status"]["name"], "progress": prog}),
                    "entityKeys": [f"linear-project:{pid.lower()}"],
                    "relatedKeys": [pname, purl],
                    "hint": "检查项目下所有 Issue 是否均已真实合并上线、有无遗留开关或观察期要求；若确已闭环，起草简短完结 Project Update 草稿供确认。",
                    "workspaceHint": {
                        "repoPath": repo_cwd,
                        "branchSlug": f"proj-{pid}",
                        "preferWorktree": False,
                    },
                    "closureGate": {
                        "requireExternalTerminal": True,
                        "terminalReplyRegex": LINEAR_PROJECT_TERMINAL_REPLY_RE,
                        "waitPredicate": {
                            "providerId": "linear",
                            "type": "project_completed",
                            "params": {"projectId": proj["id"]},
                        },
                    },
                    "roleHint": "light",
                    "prepLabel": "后台先查",
                    "workLabel": "开会话处理 ↗",
                }
            )

    return {
        "isFullSnapshot": True,
        "items": items,
        "entitySignals": entity_signals,
        "warnings": [],
    }


if __name__ == "__main__":
    raise SystemExit(provider.run())
