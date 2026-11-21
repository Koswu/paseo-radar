# Paseo Radar Provider 规范（JSON-RPC 2.0 & `radar_provider.py` SDK）

Radar 通过扫描 `~/.paseo/plugin-data/paseo-radar/providers/`（优先）与兼容目录 `collectors/` 下的脚本收集外部研发待办、执行只读健康检查与外部阻塞条件巡检。
任何以 `_` 或 `.` 开头的文件（如 `_disabled_jira.py`）以及 SDK 文件 `radar_provider.py` 会被自动跳过，不会作为独立 Provider 执行。

## 1. 运行方式、生命周期与依赖声明

每个 Provider 默认是独立的 PEP 723 Python 单文件脚本（Python `>=3.11`），由 Radar 通过 `uv run --script <file.py>` 启动，并通过 `stdio` 上的 **NDJSON JSON-RPC 2.0** 协议（每行一个 JSON 对象）通信，`stderr` 仅用于输出诊断日志：

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
from radar_provider import RadarProvider, stable_hash

provider = RadarProvider(
    provider_id="my-source",
    display_name="My Source",
    description="Custom task provider",
)
```

- **`lifecycle: "oneshot"`（默认）**：每次定时扫描（每 15 分钟）或手动刷新时，Radar 启动子进程，在同一进程内依次发送 `provider/initialize` 与 `provider/sync`（或 `provider/checkHealth` / `provider/checkWait`），随后关闭 `stdin` 退出。
- **`lifecycle: "daemon"`（常驻推送）**：后台常驻进程，支持通过 `provider.notify_changed(upserts=[...], removed_ids=[...], entity_signals=[...])` 向 `stdout` 主动发送 `notifications/changed` 增量推送。
- **纯只读安全边界**：Provider 协议严禁包含任何写操作 RPC，只需最小只读凭证。

## 2. JSON-RPC 2.0 协议方法

### 2.1 `provider/initialize`（必选）
传入该 Provider 的配置 `config` 与全局配置 `globalConfig`（`defaultRepoPath`、`issueTeamPrefixes`），返回 `ProviderManifest`：
- `protocolVersion`: `"1.0"`
- `id` / `displayName` / `description` / `icon`
- `capabilities`: `{ "health": true, "wait": true, "push": false }`
- `configSchema`: JSON Schema 对象
- `linkMatchers`: 声明式 URL 识别与实体键提取规则（支持 `$1`..`$9`、`$1_lower`、`$1_upper`、`$1_tail4`、`$1_docslug`）
- `entityTemplates`: 声明式正文/分支/卡片 ID 实体模板（支持 `tokenRegex`、`branchTokenRegex`、`cardIdRegex`、`urlTemplate`、`deterministicLiveClaim`）
- `resourceLabels`: URL 路径段到展示名称的映射词表

### 2.2 `provider/sync`（必选）
**请求 `params`**：
```json
{
  "now": "2026-04-06T08:00:00.000Z",
  "timezone": "UTC",
  "cursor": null,
  "knownHashes": { "github-own-org-repo-42": "9f8e7d6c5b4a3210" },
  "globalConfig": {
    "defaultRepoPath": "/path/to/default/repo",
    "issueTeamPrefixes": ["ENG", "OPS"]
  },
  "rules": {
    "mutedKeywords": [],
    "mutedChannels": [],
    "mutedItemIds": []
  }
}
```
> 提示：可利用 `knownHashes` 结合 `RADAR_PROVIDER_STATE_DIR` 跳过未变更事项的子接口请求。

**返回 `result`（`ProviderSyncResult`）**：
```json
{
  "isFullSnapshot": true,
  "items": [
    {
      "id": "github-own-org-repo-42",
      "source": "github",
      "archetype": "code_change",
      "intent": "resolve_feedback",
      "group": "closing",
      "badge": "PR 待改评审",
      "title": "repo#42 Fix race condition",
      "summary": "alice 请求了代码修改（Changes requested）。",
      "url": "https://github.com/org/repo/pull/42",
      "links": [
        { "kind": "github", "label": "repo#42", "url": "https://github.com/org/repo/pull/42" }
      ],
      "updatedAt": "2026-04-06T07:50:00Z",
      "stateHash": "9f8e7d6c5b4a3210",
      "entityKeys": ["gh:org/repo#42", "issue:eng-101"],
      "relatedKeys": ["ENG-101", "org/repo#42", "fix-race"],
      "context": "@alice: Please guard the shared map access with a mutex.",
      "hint": "源分支 `fix-race`；检查评审意见与 CI 日志，涉及对外评论或合并前先向我确认。",
      "workspaceHint": {
        "repoPath": "/path/to/local/repo",
        "existingBranch": "fix-race",
        "branchSlug": "pr-42",
        "preferWorktree": true
      },
      "closureGate": {
        "requireExternalTerminal": true,
        "terminalBadgeRegex": "\\b(?:Merged|Closed)\\b|已合并|已关闭",
        "waitPredicate": {
          "providerId": "github",
          "type": "pr_merged",
          "params": { "repo": "org/repo", "number": 42 }
        }
      },
      "roleHint": "backend"
    }
  ],
  "entitySignals": [
    {
      "entityKey": "gh:org/repo#40",
      "state": "terminal",
      "links": [{ "kind": "github", "label": "repo#40", "url": "https://github.com/org/repo/pull/40" }]
    }
  ],
  "warnings": []
}
```

### 2.3 `provider/checkHealth`（可选，`capabilities.health = true`）
快速验证凭证有效性并返回当前身份：
```json
{ "ok": true, "identity": "@alice", "message": "Authenticated as @alice", "latencyMs": 120 }
```

### 2.4 `provider/checkWait`（可选，`capabilities.wait = true`）
供 `radar_mark_waiting_external(mode="provider", predicate={...})` 零 Token 定时巡检外部条件是否达成：
- 输入：`{ "predicate": { "providerId": "github", "type": "pr_merged", "params": { "repo": "org/repo", "number": 42 } } }`
- 输出：`{ "status": "ready" | "pending" | "failed", "note": "org/repo#42 已合并" }`

## 3. `ProviderItem` 核心字段说明

1. **`id`（必填，全局稳定唯一）**：同一外部事项在多次扫描间必须保持相同 `id`（如 `gitlab-own-12-345`、`linear-issue-eng-101`、`slack-dm-C123`）。
2. **`archetype` & `intent`（推荐，结构化首轮指令）**：
   - `archetype`：`"code_change"`（权威度 90）| `"incident"`（80）| `"work_item"`（70）| `"document"`（60）| `"message"`（40）。跨源共享同一实体键时，高权威度主卡自动吸收低权威度消息卡，并合并双方的 `links` 与 `context` 摘录。
   - `intent`：`"review"` | `"resolve_feedback"` | `"fix_ci"` | `"merge_ready"` | `"implement"` | `"investigate"` | `"close_out"` | `"reply"`。
   - **`context` & `hint`**：Provider 无需手工拼接冗长的 `prepPrompt` / `workPrompt`；只需在 `context` 中附上采集时拿到的原始消息/评论/描述摘录，在 `hint` 中附上 1~2 句领域处理提示，Radar 会在启动后台预查或立即处理会话时统一组装精炼首轮消息。
3. **`stateHash`（必填，外部状态指纹）**：仅由外部事项的状态字段计算（`stable_hash(...)`），切勿混入当前时间 `now`。`stateHash` 未变时不会消耗任何分拣模型 Token。
4. **`promoteToClosingWhen`（可选，跨源收尾晋升）**：如 `{ "allEntitiesTerminal": ["mr:group/repo!12"], "dropIfUnmet": false }`，当关联代码变更在 `entitySignals` 中均为 `"terminal"`（已合并）时，自动将工单晋升至 `closing`（待合入/收尾）分组。
5. **`closureGate`（可选，完结门禁）**：声明 `requireExternalTerminal: true` 与 `terminalBadgeRegex` / `terminalReplyRegex`，防止外部单据或 MR 尚未真正合入/关单时被误标为 `ready_to_archive`。

## 4. 使用 `radar_provider.py` SDK 与命令行调试

同目录内置零依赖 `radar_provider.py`，通过装饰器 `@provider.sync`、`@provider.health`、`@provider.wait`、`@provider.manifest` 即可编写标准 Provider。

SDK 自带命令行调试回退：当在终端直接运行或通过管道传入 `{}` 时，自动执行一次 `sync` 并输出格式化 JSON：
```bash
# 直接运行单次同步调试
uv run --script ~/.paseo/plugin-data/paseo-radar/providers/github.py --cli-sync

# 查看 Provider Manifest
uv run --script ~/.paseo/plugin-data/paseo-radar/providers/github.py --cli-manifest

# 测试 JSON-RPC initialize 握手
echo '{"jsonrpc":"2.0","id":1,"method":"provider/initialize","params":{}}' | uv run --script ~/.paseo/plugin-data/paseo-radar/providers/github.py
```
