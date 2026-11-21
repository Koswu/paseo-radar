Radar 将来自 GitHub、GitLab、Linear、Slack 及任意自定义 JSON-RPC Provider 的外部研发待办聚合到 Paseo 内的统一分拣看板中，支持跨信源自动归并、一键切出隔离 Git Worktree 启动会话、在卡片内直接审阅编辑待确认外发草稿，以及托管监听外部阻塞条件。

## 工作原理

1. 纯只读 JSON-RPC Provider：每 15 分钟（或手动触发扫描 / 常驻 `daemon` 实时推送时）通过 `uv run --script` 执行 `~/.paseo/plugin-data/paseo-radar/providers/`（并向后兼容 `collectors/`）下已启用的 PEP 723 Python 脚本。内置零依赖 `radar_provider.py` SDK 以及 `github.py`、`gitlab.py`、`linear.py`、`slack.py` 四个通用种子 Provider，也可按同目录 `SPEC.md` 协议接入任意自定义信源。Provider 声明式注册 `linkMatchers`、`entityTemplates` 与 `capabilities`（`health`、`wait`、`push`），并输出结构化 `archetype` + `intent` + `context`/`hint` + `closureGate` + `entitySignals`。
2. 动态实体注册表与增量分拣去重：通过标准化实体键（如 `gh:org/repo#42`、`mr:group/repo!12`、`issue:eng-101`，以及 `home/domain-rules.json` 自定义领域规则）跨源合并同一事项的链接与上下文摘录；仅当出现新条目或外部 `stateHash` 变化时调用轻量分拣模型过滤无行动诉求噪音并分配归属项目与角色槽位，无变动时零 Token 开销。
3. 五态卡片生命周期：卡片在「待办池」「AI 处理中」「待我处理」（细分为可完结、待确认、待补充、待查阅，支持声明式 `closureGate` 完结门禁校验）「等待外部」「已归档」间流转。归档卡片同步归档关联工作区；后续外部状态变更时自动重新唤醒。
4. 等待外部托管巡检：等待审批、CI、部署观察或远端批处理结束时，会话通过 `radar_mark_waiting_external` 配置 5 段 Cron 与必填 `maxTimeout`。支持零 Token 的 `provider` 模式（调用 `provider/checkWait`）、零 Token 只读 `script` 模式（`exit 0` 达标）、同看板子卡 `board` 监听模式与独立评估模型 `ai` 模式，达标或超时后自动唤醒原工作区会话继续推进。
5. 人机协作与执行洞察：通过看板「洞察报告」或 `/radar-insights` 按需增量扫描本地各 Provider 会话与看板闭环记录，生成协作风格画像、工具与模型表现对比、摩擦卡点及可一键复制的 `AGENTS.md` / 工作流改进建议，并支持导出独立 HTML 报告。

## 环境与初始配置

- 版本与系统要求：Paseo `>=0.15.0`，支持 macOS 与 Linux 服务端。
- 外部依赖：服务端需安装 `uv` 以运行 Python Provider 脚本。新安装时各内置 Provider 默认关闭，避免未配置凭证前产生扫描报错。
- 数据源与凭证：在 `Settings -> Radar` 中按需启用 Provider 并在线编辑 `providers/providers.json`（或兼容 `collectors/config.json`），通过已登录的 `gh` / `glab` CLI 或环境变量（`GITHUB_TOKEN`、`LINEAR_API_KEY`、`SLACK_USER_TOKEN`）提供只读拉取凭证。
- 模型配置：各角色槽位默认设为「自动」，自动选用当前服务端已启用的模型 Provider，也可在设置页按角色单独指定模型。

## 能力边界、数据流向与限制说明

- 本地存储与多机隔离：看板状态、Provider 诊断、自定义领域规则、屏蔽规则与巡检脚本均按服务端独立存放在 `~/.paseo/plugin-data/paseo-radar/`。客户端连接多台机器时，看板、设置、工作区顶栏按钮与输入框胶囊均按服务端隔离保活。
- 模型数据流向：增量分拣、回合摘要提炼、看板助手调度及卡片工作区会话会将对应的卡片标题、摘要、链接或对话上下文发送至你在 Paseo 中所选的模型 Provider。
- 进程与会话注入权限：已启用的 Provider 脚本与等待巡检脚本在服务端以当前系统用户权限只读执行。开启「自动纳管所有本地工作区会话」时，Radar 会为交互式工作区会话挂载产物链接登记与状态流转工具；可在设置页关闭该开关以仅跟踪 Radar 关联会话。
- 已知限制：启用 `slack.py` Provider 时，`uv` 会按其 PEP 723 元数据从 PyPI 解析 `slack-sdk` 依赖。
