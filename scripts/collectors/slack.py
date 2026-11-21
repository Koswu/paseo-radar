#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "slack-sdk~=3.33.0",
# ]
# ///
"""
Slack Provider（基于 slack-sdk 与用户 Token）
覆盖：
1. Slack 私聊待回复（最后一条非本人消息，且未由本人添加完成类 emoji 反应）
2. 频道 @提及待回复与催审通知（附最近消息摘录至 context，支持跨源实体自动关联与 thread 回复等待监听）
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import sys
import urllib.parse
from typing import Any
from zoneinfo import ZoneInfo

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from radar_provider import (
    RadarProvider,
    dedupe_strs,
    expand_repo_cwd,
    extract_issue_keys,
    stable_hash,
    utc_now,
)

DONE_REACTIONS = {"white_check_mark", "heavy_check_mark", "ok_hand", "+1", "thumbsup", "100", "done"}
DEFAULT_NOISY_CHANNELS = {"general", "random"}

GITLAB_MR_URL_RE = re.compile(
    r"https?://[^/\s]+/([A-Za-z0-9_./-]+?)/-/merge_requests/(\d+)(?:[/?#][^\s>|)\]]*)?"
)
GITHUB_PR_URL_RE = re.compile(
    r"https?://[^/\s]+/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)(?:[/?#][^\s>|)\]]*)?"
)
BARE_MR_RE = re.compile(r"(?:^|[\s(（\[])!(\d{3,6})\b")

provider = RadarProvider(
    provider_id="slack",
    display_name="Slack",
    description="Slack 私聊与频道 @提及待办（基于 SLACK_USER_TOKEN）",
    icon="slack",
    config_schema={
        "type": "object",
        "properties": {
            "lookbackDays": {"type": "integer", "default": 4, "description": "回溯检索最近 N 天的提及与私聊"},
            "noisyChannels": {
                "type": "array",
                "items": {"type": "string"},
                "default": ["general", "random"],
                "description": "忽略的频道名称列表",
            },
            "token": {"type": "string", "description": "可选 Slack User Token（xoxp-...）"},
            "tokenFile": {"type": "string", "description": "可选凭证文件路径（默认 ~/.config/slack/credentials.json）"},
            "workspaceUrl": {"type": "string", "description": "可选 Slack Workspace URL"},
        },
    },
    link_matchers=[
        {
            "id": "slack-permalink",
            "urlRegex": r"^https://[a-z0-9-]+\.slack\.com/archives/([A-Z0-9]+)/p(\d+)(?:\?([^#]*))?$",
            "flags": "i",
            "kind": "slack",
            "labelTemplate": "Slack",
            "subIdTemplate": "$1",
            "entityKeyTemplate": "slack:$1_upper:$2",
        }
    ],
)


def _get_web_client(token: str) -> Any:
    from slack_sdk import WebClient

    return WebClient(token=token)


def clean_url(raw: str) -> str:
    u = raw.replace("\\~", "~").strip()
    while u and u[-1] in ">|.,;:'\"!?）)】]":
        u = u[:-1]
    while u.endswith(")"):
        if u.count(")") > u.count("("):
            u = u[:-1]
        else:
            break
    return u


def resolve_tz(tz_name: str | None) -> datetime.tzinfo:
    if tz_name:
        try:
            return ZoneInfo(tz_name)
        except Exception:
            pass
    local_tz = datetime.datetime.now().astimezone().tzinfo
    return local_tz or datetime.timezone.utc


def resolve_slack_token(slack_cfg: dict[str, Any]) -> str:
    for env_key in ("SLACK_USER_TOKEN", "SLACK_TOKEN"):
        if os.environ.get(env_key):
            return os.environ[env_key].strip()
    if slack_cfg.get("token"):
        return str(slack_cfg["token"]).strip()
    token_file = slack_cfg.get("tokenFile") or str(
        pathlib.Path.home() / ".config" / "slack" / "credentials.json"
    )
    p = pathlib.Path(token_file).expanduser()
    if p.exists():
        data = json.loads(p.read_text("utf-8"))
        if data.get("token"):
            return str(data["token"]).strip()
    raise RuntimeError(
        "Slack token not configured (set SLACK_USER_TOKEN or configure slack.token / slack.tokenFile in providers.json)"
    )


def format_messages_context(msgs: list[dict[str, Any]], max_msgs: int = 5) -> str:
    lines: list[str] = []
    for m in msgs[-max_msgs:]:
        u = m.get("username") or m.get("user") or "user"
        txt = re.sub(r"\s+", " ", (m.get("text") or "").strip())
        if txt:
            lines.append(f"@{u}: {txt[:300]}")
    return "\n".join(lines)


@provider.health
def check_health(ctx: dict[str, Any]) -> dict[str, Any]:
    token = resolve_slack_token(ctx.get("config") or {})
    client = _get_web_client(token)
    auth = client.auth_test()
    user = str(auth.get("user") or auth.get("user_id") or "")
    team = str(auth.get("team") or "")
    if not user:
        return {"ok": False, "identity": None, "message": "Slack auth.test returned empty user"}
    identity = f"@{user}" + (f" ({team})" if team else "")
    return {"ok": True, "identity": identity, "message": f"Authenticated as {identity}"}


@provider.wait
def check_wait(predicate: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    slack_cfg = ctx.get("config") or {}
    token = resolve_slack_token(slack_cfg)
    client = _get_web_client(token)
    wtype = str(predicate.get("type") or "thread_reply").strip()
    params = predicate.get("params") if isinstance(predicate.get("params"), dict) else {}

    channel = str(params.get("channel") or params.get("channelId") or "").strip()
    thread_ts = str(params.get("threadTs") or params.get("ts") or "").strip()
    since_ts = float(params.get("sinceTs") or thread_ts or 0)

    if not channel:
        return {"status": "failed", "note": "Missing channel in Slack wait predicate"}

    my_uid = str(slack_cfg.get("userId") or "")
    if not my_uid:
        auth = client.auth_test()
        my_uid = str(auth.get("user_id") or "")

    if wtype in ("thread_reply", "new_reply") and thread_ts:
        rep = client.conversations_replies(channel=channel, ts=thread_ts, limit=30)
        msgs = rep.data.get("messages") or []
        newer = [
            m
            for m in msgs
            if float(m.get("ts") or 0) > since_ts
            and m.get("user")
            and m.get("user") != my_uid
            and not m.get("bot_id")
        ]
        if newer:
            last = newer[-1]
            snippet = re.sub(r"\s+", " ", (last.get("text") or "").strip())[:100]
            return {"status": "ready", "note": f"收到新回复: {snippet}"}
        return {"status": "pending", "note": "该讨论串尚无他人新回复"}

    if wtype in ("dm_reply", "channel_reply"):
        hist = client.conversations_history(channel=channel, limit=15)
        msgs = list(reversed(hist.data.get("messages") or []))
        newer = [
            m
            for m in msgs
            if float(m.get("ts") or 0) > since_ts
            and m.get("user")
            and m.get("user") != my_uid
            and not m.get("bot_id")
        ]
        if newer:
            last = newer[-1]
            snippet = re.sub(r"\s+", " ", (last.get("text") or "").strip())[:100]
            return {"status": "ready", "note": f"收到新消息: {snippet}"}
        return {"status": "pending", "note": "频道尚无他人新消息"}

    return {"status": "failed", "note": f"Unsupported Slack wait predicate type: {wtype}"}


@provider.sync
def sync(params: dict[str, Any]) -> dict[str, Any]:
    slack_cfg = params.get("config") or {}
    global_cfg = params.get("globalConfig") or {}
    rules = params.get("rules") or {}

    token = resolve_slack_token(slack_cfg)
    client = _get_web_client(token)
    auth = client.auth_test()
    my_uid: str = str(slack_cfg.get("userId") or auth.get("user_id") or "")
    my_username: str = str(slack_cfg.get("username") or auth.get("user") or "").lower()
    workspace_url: str = str(slack_cfg.get("workspaceUrl") or auth.get("url") or "https://slack.com/").rstrip("/")

    allowed_prefixes = set(slack_cfg.get("issueTeamPrefixes") or global_cfg.get("issueTeamPrefixes") or []) or None
    default_repo: str | None = slack_cfg.get("defaultRepoPath") or global_cfg.get("defaultRepoPath")
    repo_cwd = expand_repo_cwd("", None, default_repo)
    noisy_channels = (
        DEFAULT_NOISY_CHANNELS
        | set(slack_cfg.get("noisyChannels") or [])
        | set(rules.get("mutedChannels") or [])
    )

    items: list[dict[str, Any]] = []
    warnings: list[str] = []

    lookback_days = int(slack_cfg.get("lookbackDays") or 4)
    local_tz = resolve_tz(str(params.get("timezone") or ""))
    start_date = (utc_now() - datetime.timedelta(days=lookback_days)).astimezone(local_tz).strftime("%Y-%m-%d")
    queries = [
        f"<@{my_uid}> after:{start_date}",
        f"to:me after:{start_date}",
    ]
    thread_candidates: dict[tuple[str, str], dict[str, Any]] = {}
    dm_channels: dict[str, dict[str, Any]] = {}

    for q in queries:
        try:
            res = client.search_messages(query=q, count=50, sort="timestamp", sort_dir="desc")
            matches = (res.data.get("messages") or {}).get("matches") or []
            for m in matches:
                ch = m.get("channel") or {}
                ch_id = ch.get("id") or ""
                ch_name = ch.get("name") or ""
                if not ch_id or ch_name in noisy_channels:
                    continue
                text = (m.get("text") or "").strip()
                if not text or any(tag in text for tag in ("<!channel>", "<!here>", "<!everyone>")):
                    continue
                if m.get("user") == my_uid or m.get("username") in ("slackbot", "gitlab", "sentry", "linear"):
                    continue

                if ch.get("is_im"):
                    if ch_id not in dm_channels or float(m.get("ts", 0)) > float(dm_channels[ch_id].get("ts", 0)):
                        dm_channels[ch_id] = m
                    continue

                permalink = m.get("permalink") or ""
                root_ts = m.get("ts") or ""
                if "thread_ts=" in permalink:
                    parsed_ts = urllib.parse.parse_qs(urllib.parse.urlparse(permalink).query).get("thread_ts", [""])[0]
                    if parsed_ts:
                        root_ts = parsed_ts
                key = (ch_id, root_ts)
                if key not in thread_candidates or float(m.get("ts", 0)) > float(thread_candidates[key].get("ts", 0)):
                    thread_candidates[key] = m
        except Exception as exc:
            warnings.append(f"slack search warning ({q}): {exc}")

    code_review_cards_by_key: dict[str, dict[str, Any]] = {}

    # 1. Direct Messages
    for ch_id, hit in list(dm_channels.items())[:12]:
        try:
            hist = client.conversations_history(channel=ch_id, limit=12)
            msgs = list(reversed(hist.data.get("messages") or []))
        except Exception:
            msgs = [hit]

        human_msgs = [m for m in msgs if m.get("user") and not m.get("bot_id")]
        if not human_msgs:
            continue
        last_msg = human_msgs[-1]
        if last_msg.get("user") == my_uid:
            continue
        if any(
            rx.get("name") in DONE_REACTIONS and my_uid in (rx.get("users") or [])
            for rx in (last_msg.get("reactions") or [])
        ):
            continue

        burst: list[str] = []
        for m in reversed(human_msgs):
            if m.get("user") == my_uid:
                break
            t = re.sub(r"\s+", " ", (m.get("text") or "").strip())
            if t:
                burst.append(t)
        burst.reverse()
        combined_text = " / ".join(burst[-3:])
        full_burst_text = "\n".join(burst)
        sender = hit.get("username") or last_msg.get("user") or "同事"
        ts_str = last_msg.get("ts") or hit.get("ts") or "0"
        permalink = f"{workspace_url}/archives/{ch_id}/p{ts_str.replace('.', '')}"
        updated_iso = datetime.datetime.fromtimestamp(float(ts_str), tz=datetime.timezone.utc).isoformat()

        issue_keys = extract_issue_keys(full_burst_text, allowed_prefixes)
        ekeys = [f"issue:{k.lower()}" for k in issue_keys]

        items.append(
            {
                "id": f"slack-dm-{ch_id}",
                "source": "slack",
                "archetype": "message",
                "intent": "reply",
                "group": "urgent",
                "badge": "Slack 私聊",
                "title": f"{sender} 私聊待回复",
                "summary": combined_text[:150],
                "url": permalink,
                "links": [{"kind": "slack", "label": "Slack", "url": permalink}],
                "updatedAt": updated_iso,
                "stateHash": stable_hash({"lastTs": ts_str}),
                "entityKeys": dedupe_strs(ekeys),
                "relatedKeys": dedupe_strs(issue_keys + [permalink]),
                "scanText": full_burst_text[:2000],
                "context": format_messages_context(human_msgs, max_msgs=5),
                "hint": f"Slack 私聊频道 `{ch_id}`；若涉及代码、单据或配置，请只读核实事实并起草回复草稿（未经确认禁止外发）。",
                "workspaceHint": {
                    "repoPath": repo_cwd,
                    "branchSlug": f"dm-{ch_id.lower()}",
                    "preferWorktree": False,
                },
                "roleHint": "backend",
                "prepLabel": "后台先查",
                "workLabel": "开会话处理 ↗",
            }
        )

    # 2. Channel threads mentioning me
    for (ch_id, root_ts), hit in list(thread_candidates.items())[:18]:
        try:
            rep = client.conversations_replies(channel=ch_id, ts=root_ts, limit=30)
            msgs = rep.data.get("messages") or []
        except Exception:
            msgs = [hit]

        if not msgs:
            continue
        human_msgs = [m for m in msgs if m.get("user") and not m.get("bot_id")]
        if not human_msgs:
            continue
        last_msg = human_msgs[-1]
        if last_msg.get("user") == my_uid:
            continue

        my_done_reaction = False
        for check_m in (msgs[0], last_msg):
            for rx in check_m.get("reactions") or []:
                if rx.get("name") in DONE_REACTIONS and my_uid in (rx.get("users") or []):
                    my_done_reaction = True
                    break
        if my_done_reaction:
            continue

        ch_info = hit.get("channel") or {}
        is_dm = bool(ch_info.get("is_im"))
        full_thread_text = "\n".join((m.get("text") or "") for m in human_msgs)
        mentioned = f"<@{my_uid}>" in full_thread_text or (my_username and my_username in full_thread_text.lower())
        if not is_dm and not mentioned:
            continue

        sender = hit.get("username") or last_msg.get("user") or "同事"
        ch_label = "私聊" if is_dm else f"#{ch_info.get('name') or ch_id}"
        permalink = hit.get("permalink") or f"{workspace_url}/archives/{ch_id}/p{root_ts.replace('.', '')}"
        clean_text = re.sub(r"<@[A-Z0-9]+>", "@人", last_msg.get("text") or hit.get("text") or "")
        clean_text = re.sub(r"\s+", " ", clean_text).strip()
        ts_float = float(last_msg.get("ts") or hit.get("ts") or 0)
        updated_iso = datetime.datetime.fromtimestamp(ts_float, tz=datetime.timezone.utc).isoformat()

        issue_keys = extract_issue_keys(full_thread_text, allowed_prefixes)
        bare_mrs = [f"!{m}" for m in BARE_MR_RE.findall(full_thread_text)]
        ekeys = [f"issue:{k.lower()}" for k in issue_keys]
        thread_context = format_messages_context(human_msgs, max_msgs=6)

        mr_match = GITLAB_MR_URL_RE.search(full_thread_text.replace("\\~", "~"))
        pr_match = GITHUB_PR_URL_RE.search(full_thread_text.replace("\\~", "~"))

        if mr_match:
            mr_url = clean_url(mr_match.group(0))
            mr_repo = mr_match.group(1).lower()
            mr_iid = mr_match.group(2)
            mkey = f"mr:{mr_repo}!{mr_iid}"
            ekeys_m = dedupe_strs([mkey] + ekeys)
            if mkey in code_review_cards_by_key:
                existing = code_review_cards_by_key[mkey]
                existing["links"] = list(existing.get("links") or []) + [{"kind": "slack", "label": "Slack", "url": permalink}]
                existing["entityKeys"] = dedupe_strs(list(existing.get("entityKeys") or []) + ekeys_m)
                existing["relatedKeys"] = dedupe_strs(
                    list(existing.get("relatedKeys") or []) + issue_keys + [f"!{mr_iid}", mr_url, permalink]
                )
                continue

            card = {
                "id": f"slack-mr-{ch_id}-{root_ts.replace('.', '')}",
                "source": "gitlab",
                "archetype": "code_change",
                "intent": "review",
                "group": "urgent",
                "badge": "Slack 催审 MR",
                "title": f"{ch_label} · {sender} 请求看 MR !{mr_iid}",
                "summary": clean_text[:140],
                "url": mr_url,
                "secondaryUrl": permalink,
                "links": [
                    {"kind": "gitlab", "label": f"!{mr_iid}", "url": mr_url},
                    {"kind": "slack", "label": "Slack", "url": permalink},
                ],
                "updatedAt": updated_iso,
                "stateHash": stable_hash({"lastTs": last_msg.get("ts"), "mr": mr_url}),
                "entityKeys": ekeys_m,
                "relatedKeys": dedupe_strs(issue_keys + [f"!{mr_iid}", mr_url, permalink]),
                "scanText": full_thread_text[:2000],
                "context": thread_context,
                "hint": "拉取 Slack 讨论串与 GitLab MR diff / 评论状态，核查代码改动并给出审阅结论与回复草稿（未经确认禁止外发）。",
                "workspaceHint": {
                    "repoPath": repo_cwd,
                    "branchSlug": f"slack-mr-{mr_iid}",
                    "preferWorktree": False,
                },
                "roleHint": "backend",
                "prepLabel": "后台先查",
                "workLabel": "开会话处理 ↗",
            }
            code_review_cards_by_key[mkey] = card
            items.append(card)
            continue

        if pr_match:
            pr_url = clean_url(pr_match.group(0))
            pr_repo = pr_match.group(1).lower()
            pr_num = pr_match.group(2)
            pkey = f"gh:{pr_repo}#{pr_num}"
            ekeys_p = dedupe_strs([pkey] + ekeys)
            if pkey in code_review_cards_by_key:
                existing = code_review_cards_by_key[pkey]
                existing["links"] = list(existing.get("links") or []) + [{"kind": "slack", "label": "Slack", "url": permalink}]
                existing["entityKeys"] = dedupe_strs(list(existing.get("entityKeys") or []) + ekeys_p)
                existing["relatedKeys"] = dedupe_strs(
                    list(existing.get("relatedKeys") or []) + issue_keys + [f"{pr_repo}#{pr_num}", pr_url, permalink]
                )
                continue

            card = {
                "id": f"slack-pr-{ch_id}-{root_ts.replace('.', '')}",
                "source": "github",
                "archetype": "code_change",
                "intent": "review",
                "group": "urgent",
                "badge": "Slack 催审 PR",
                "title": f"{ch_label} · {sender} 请求看 PR #{pr_num}",
                "summary": clean_text[:140],
                "url": pr_url,
                "secondaryUrl": permalink,
                "links": [
                    {"kind": "github", "label": f"#{pr_num}", "url": pr_url},
                    {"kind": "slack", "label": "Slack", "url": permalink},
                ],
                "updatedAt": updated_iso,
                "stateHash": stable_hash({"lastTs": last_msg.get("ts"), "pr": pr_url}),
                "entityKeys": ekeys_p,
                "relatedKeys": dedupe_strs(issue_keys + [f"{pr_repo}#{pr_num}", pr_url, permalink]),
                "scanText": full_thread_text[:2000],
                "context": thread_context,
                "hint": "拉取 Slack 讨论串与 GitHub PR diff / 评论状态，核查代码改动并给出审阅结论与回复草稿（未经确认禁止外发）。",
                "workspaceHint": {
                    "repoPath": repo_cwd,
                    "branchSlug": f"slack-pr-{pr_num}",
                    "preferWorktree": False,
                },
                "roleHint": "backend",
                "prepLabel": "后台先查",
                "workLabel": "开会话处理 ↗",
            }
            code_review_cards_by_key[pkey] = card
            items.append(card)
            continue

        items.append(
            {
                "id": f"slack-msg-{ch_id}-{root_ts.replace('.', '')}",
                "source": "slack",
                "archetype": "message",
                "intent": "reply",
                "group": "urgent",
                "badge": f"Slack {ch_label}",
                "title": f"{sender} 在 {ch_label} 提及你未回",
                "summary": clean_text[:140],
                "url": permalink,
                "links": [{"kind": "slack", "label": "Slack", "url": permalink}],
                "updatedAt": updated_iso,
                "stateHash": stable_hash({"lastTs": last_msg.get("ts")}),
                "entityKeys": dedupe_strs(ekeys),
                "relatedKeys": dedupe_strs(issue_keys + bare_mrs + [permalink]),
                "scanText": full_thread_text[:2000],
                "context": thread_context,
                "hint": "读取该 Slack 消息及讨论串上下文；若涉及代码、单据或配置，请只读核实事实并起草回复草稿（未经确认禁止外发）。",
                "workspaceHint": {
                    "repoPath": repo_cwd,
                    "branchSlug": f"slack-{root_ts.split('.')[0][-6:]}",
                    "preferWorktree": False,
                },
                "roleHint": "backend",
                "prepLabel": "后台先查",
                "workLabel": "开会话处理 ↗",
            }
        )

    return {
        "isFullSnapshot": True,
        "items": items,
        "entitySignals": [],
        "warnings": warnings,
    }


if __name__ == "__main__":
    raise SystemExit(provider.run())
