Radar brings external engineering work from GitHub, GitLab, Linear, Slack, and custom JSON-RPC Providers into a unified triage board inside Paseo. It groups cross-source items onto single cards, launches isolated Git worktree sessions in one click, lets you review and edit outbound drafts inline before execution, and monitors external blockers on a schedule.

## How it works

1. Read-only JSON-RPC Providers: Every 15 minutes (or on manual scan / daemon push), Radar runs enabled PEP 723 Python Providers in `~/.paseo/plugin-data/paseo-radar/providers/` (with backward compatibility for legacy `collectors/`) over NDJSON JSON-RPC 2.0 via the zero-dependency `radar_provider.py` SDK. Built-in seed providers cover GitHub PRs and issues, GitLab MRs, Linear cycle issues and 100% projects, and Slack mentions or DMs. Providers declare `linkMatchers`, `entityTemplates`, `capabilities` (`health`, `wait`, `push`), and emit structured `archetype` + `intent` + `context`/`hint` + `closureGate` + `entitySignals`.
2. Dynamic entity registry and incremental triage: Canonical entity keys (`gh:org/repo#42`, `mr:group/repo!12`, `issue:eng-101`, plus custom domain rules in `home/domain-rules.json`) merge related links and cross-source context excerpts deterministically. Only new or `stateHash`-changed items invoke the lightweight triage model to filter non-actionable chat noise and assign project and role slots. Unchanged scans consume zero model tokens.
3. Five-state card lifecycle: Cards move across `Pool`, `Running`, `Needs Me` (sub-tagged as `Ready to Archive`, `Decision Needed`, `Input Needed`, or `For Review` with declarative `closureGate` verification), `Waiting`, and `Archived`. Archiving a card archives its linked Paseo workspace, and future upstream state changes wake the card automatically.
4. Managed external waiting: Sessions waiting on CI, code review, or background jobs call `radar_mark_waiting_external` with a 5-field cron and a required `maxTimeout`. Supports zero-token `provider` mode (`provider/checkWait` predicates), zero-token read-only `script` mode (exit code 0), `board` subcard watch mode, and `ai` evaluator mode. When satisfied or timed out, Radar wakes the original session automatically.
5. Interaction and execution insights: Run `/radar-insights` or open the Insights view to incrementally audit local multi-provider sessions and Radar closure loops—surfacing collaboration archetypes, model/tool reliability, friction hotspots, copyable `AGENTS.md` recommendations, and standalone HTML/Markdown reports.

## Setup

- Supported versions: Paseo `>=0.15.0` on macOS and Linux.
- External tools: Install `uv` on the daemon host to run Python Provider scripts. Seed providers are disabled by default so fresh installations do not fail before credentials are configured.
- Credentials: Enable the providers you use in `Settings -> Radar` and supply read-only credentials through `providers/providers.json` (or `collectors/config.json`), environment variables (`GITHUB_TOKEN`, `LINEAR_API_KEY`, `SLACK_USER_TOKEN`), or authenticated `gh` and `glab` CLIs.
- Models: Role slots default to `Auto` and select from providers already enabled on your Paseo host. You can pin specific models per role in `Settings -> Radar`.

## Capabilities, data access, and limitations

- Local storage: Board state, provider diagnostics, custom domain rules, mute rules, and wait scripts live on each daemon host under `~/.paseo/plugin-data/paseo-radar/`. Multi-host clients isolate state, settings, composer pills, and header buttons per host.
- Data sent to model providers: Card titles, summaries, URLs, and conversation turns are sent to the model providers configured on your Paseo daemon during triage, turn summarization, Copilot scheduling, and card sessions.
- Subprocess and tool permissions: Enabled provider scripts and wait checks execute as read-only child processes under the daemon user account. When `Track all local workspace sessions` is enabled in settings, Radar attaches `radar_attach_links`, `radar_mark_waiting_external`, and `radar_set_needs_me_tag` to interactive workspace sessions; turn it off to restrict injection to Radar-linked sessions only.
- Limitations: `slack.py` declares `slack-sdk` via PEP 723 script metadata, which `uv` resolves from PyPI when the Slack provider is enabled.
