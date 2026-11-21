import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CustomDomainRulesSchema, type CustomDomainRules, type ClosureGate, type WaitPredicate,
  type ItemArchetype, type ItemIntent, type PromoteToClosingRule } from "../shared/provider-protocol.ts";
import type {
  BoardWatchSpec,
  CardStatus,
  DecisionProposal,
  NeedsMeTag,
  RadarGoal,
  RadarGroup,
  RadarLink,
  RadarRoleHint,
  RadarSource,
  SnoozePreset,
  WaitMode,
} from "../shared/radar";
import {
  COLLECTOR_SPEC_MD,
  DEFAULT_PROVIDERS_CONFIG,
  RADAR_PROVIDER_SDK_PY,
  SEED_COLLECTOR_SCRIPTS,
} from "./collector-seeds.ts";
import { normalizeCardId } from "./entity-keys.ts";
import { computeSnoozeUntilInTimeZone, resolveEffectiveTimeZone } from "./wait-utils.ts";

export interface RawScannedItem {
  providerId?: string;
  archetype?: ItemArchetype;
  intent?: ItemIntent;
  scanText?: string;
  context?: string | null;
  contexts?: Array<{ source: string; text: string }>;
  hint?: string | null;
  preferWorktree?: boolean;
  promoteToClosingWhen?: PromoteToClosingRule;
  closureGate?: ClosureGate;
  id: string;
  source: RadarSource;
  group: Exclude<RadarGroup, "local">;
  badge: string;
  title: string;
  summary: string;
  url: string;
  secondaryUrl?: string | null;
  links?: RadarLink[];
  updatedAt: string;
  stateHash: string;
  entityKeys?: string[];
  relatedKeys?: string[];
  mrUrls?: string[];
  onlyIfMergedMrs?: boolean;
  repoPath?: string | null;
  existingBranch?: string | null;
  branchSlug: string;
  roleHint?: RadarRoleHint | null;
  triageProjectId?: string | null;
  triageSelectedModel?: string | null;
  recommendedModel?: string | null;
  prepLabel?: string;
  workLabel?: string;
  prepPrompt: string;
  workPrompt: string;
}

export interface TriageCacheEntry {
  stateHash: string;
  action: "keep" | "drop_noise" | "merge";
  mergeIntoId?: string | null;
  group?: Exclude<RadarGroup, "local"> | null;
  roleHint?: RadarRoleHint | null;
  selectedModel?: string | null;
  projectId?: string | null;
  reason?: string | null;
  triagedAt: string;
}

export interface ItemUserMeta {
  dismissedHash?: string | null;
  snoozedUntil?: string | null;
  snoozedHash?: string | null;
  boundWorkspaceId?: string | null;
  boundAgentId?: string | null;
  selectedModel?: string | null;
  selectedProjectId?: string | null;
  customStatus?: string | null;
  waitPredicate?: WaitPredicate | null;
  waitProviderId?: string | null;
  waitAgentId?: string | null;
  waitMode?: WaitMode | null;
  waitCondition?: string | null;
  waitBoard?: BoardWatchSpec | null;
  waitScheduleId?: string | null;
  waitScriptPath?: string | null;
  waitCron?: string | null;
  waitStartedAt?: string | null;
  waitTimeoutAt?: string | null;
  waitMaxTimeoutLabel?: string | null;
  waitCheckNote?: string | null;
  lastWaitCheckAt?: string | null;
  waitConsecutiveErrors?: number | null;
  waitNextRetryAt?: string | null;
  pendingWakePrompt?: string | null;
  coordinationEnabled?: boolean;
  subcardWorkspaceIds?: string[];
  awaitingDecision?: boolean;
  needsMeTag?: NeedsMeTag | null;
  needsMeTagLocked?: boolean;
  needsMeTagAgentId?: string | null;
  needsMeTagUpdatedAt?: string | null;
  needsMeTagClearedAt?: string | null;
  decisionProposal?: DecisionProposal | null;
  goal?: RadarGoal | null;
  prepSummary?: string | null;
  prepSummarySig?: string | null;
  autoArchivedAt?: string | null;
  autoArchivedHash?: string | null;
  notifyCopilotOnFinish?: boolean;
  attachedLinks?: RadarLink[];
  removedLinkKeys?: string[];
  extraLinks?: RadarLink[];
  migratedFromIds?: string[];
}

export interface PersistedCollectorDiag {
  lastRunAt: string | null;
  durationMs: number | null;
  itemCount: number | null;
  deltaCount: number | null;
  itemHashes?: Record<string, string>;
  warnings: string[];
  error: string | null;
}

export interface GitDirtyBaseline {
  repoRoot: string;
  entries: Record<string, string>;
}

export interface PersistedRadarState {
  lastScanAt: string | null;
  lastScanDeltaCount: number | null;
  lastScanTriageTriggered: boolean;
  scanErrors: string[];
  collectorDiagnostics: Record<string, PersistedCollectorDiag>;
  copilotAgentId: string | null;
  customItems: RawScannedItem[];
  rawItems: RawScannedItem[];
  meta: Record<string, ItemUserMeta>;
  gitBaselines?: Record<string, GitDirtyBaseline>;
  triageCache: Record<string, TriageCacheEntry>;
  triageBootstrapped: boolean;
}

export interface RadarRules {
  mutedKeywords: string[];
  mutedChannels: string[];
  mutedItemIds: string[];
  notes: string[];
}

const DEFAULT_STATE: PersistedRadarState = {
  lastScanAt: null,
  lastScanDeltaCount: null,
  lastScanTriageTriggered: false,
  scanErrors: [],
  collectorDiagnostics: {},
  copilotAgentId: null,
  customItems: [],
  rawItems: [],
  meta: {},
  gitBaselines: {},
  triageCache: {},
  triageBootstrapped: false,
};

const DEFAULT_RULES: RadarRules = {
  mutedKeywords: [],
  mutedChannels: [],
  mutedItemIds: [],
  notes: [],
};

const RADAR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#2563eb"/><g transform="translate(12 12) scale(1.666)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/></g></svg>`;

export const COPILOT_SYSTEM_PROMPT = `你是 Paseo Radar 的看板助手（Copilot），负责理解意图、快速核实上下文、拆解建卡、管理外部采集脚本与全局调度。

【两层调研与调度原则】
1. **允许轻量只读核实（最多 2~3 步，总耗时 < 10 秒）**：
   - 需要确认本地仓库目录路径、查询单号 / MR 标题、或查看 \`providers/\` 外部采集脚本状态时，可执行 1~3 次极简只读操作核实事实，避免凭空猜测。
   - **安全边界**：禁止在助手会话中连接远程 SSH、精读大段业务源码、执行全量搜索/测试，或修改业务仓库代码。
2. **深度外部调研 / 方案探索 → 派发「异步调研卡（Scout）」**：
   - 若事项需深入查阅多轮讨论、完整阅读技术方案、检索监控日志/数据库或梳理代码架构后才能明确行动方案：
   - 立即调用 \`radar_create_card\`（设 \`isScout: true\`, \`startInBackground: true\`），交由后台会话异步执行，并告知用户已启动调研。
   - 后台调研完成后系统会自动回调结论，再向用户同步核心发现或拆解后续执行卡片。
3. **外挂采集脚本扩展（\`providers/\`）**：
   - 外部待办池由 \`~/.paseo/plugin-data/paseo-radar/providers/\` 下的 Provider 并行采集，规范见同目录 \`SPEC.md\`。
   - 可调用 \`radar_list_collectors\` 查看当前已安装的采集脚本与最近运行状态；若用户希望新增或调整采集源，按 \`SPEC.md\` 编写/修改脚本后调用 \`radar_test_collector\` 干跑验证，确认通过后调用 \`radar_rescan\` 刷新看板。
4. **常规明确任务 / 已有卡片调度**：
   - 新任务调用 \`radar_create_card\`；已有卡片按需调用 \`radar_follow_background\`、\`radar_update_cards\`、\`radar_archive_cards\`、\`radar_snooze_items\`、\`radar_dismiss_items\`、\`radar_update_rules\`。
   - 若卡片需转入「等待外部」，调用 \`radar_request_wait_external\` 交由卡片会话核验完结条件是否明确可检（支持脚本模式与独立评估模型巡检模式，均配置 \`maxTimeout\`；条件达成或超时退出后均自动重新唤醒原会话继续处理）。
5. **表达规范**：中文自然、精简、克制，1~3 句直接给出结论与动作，不堆砌客套话或免责声明。`;

export function isPiProvider(providerOrModel?: string | null): boolean {
  const norm = (providerOrModel ?? "").trim().toLowerCase();
  return norm === "pi" || norm.startsWith("pi/");
}

export const WORKER_SYSTEM_PROMPT_HEADING = "# Radar 状态流转工具";

export function buildWorkerSystemPrompt(timeZone?: string | null, isPi = false): string {
  const tz = resolveEffectiveTimeZone(timeZone);
  const toolIntro = isPi
    ? "当前工作区会话由 Paseo Radar 跟踪卡片状态，可调用以下三个工具（若在 `codemode` 沙箱下未直接列出，请调用 `await tools.mcp__paseo__radar_attach_links(...)`、`await tools.mcp__paseo__radar_mark_waiting_external(...)` 或 `await tools.mcp__paseo__radar_set_needs_me_tag(...)`，参数定义可用 `await describeTool(\"mcp__paseo__radar_attach_links\")` 查看）："
    : "当前工作区会话由 Paseo Radar 跟踪卡片状态，可调用以下三个工具：";
  return `${WORKER_SYSTEM_PROMPT_HEADING}

${toolIntro}

1. \`radar_attach_links\`：登记本卡实际产物或主事项的完整 URL，并附简明 label。不登记参考资料或不确定的链接。
2. \`radar_mark_waiting_external\`：有可只读检查的等待条件时，用 provider + predicate、script（达标 exit 0，继续等 exit 10）、ai + checkPrompt 或 board + watch。定时检查填写 cron（${tz}）和 maxTimeout，不自行创建后台轮询。
3. \`radar_set_needs_me_tag\`：需授权标 decision 并附 title、target、impact、draft；缺材料标 input；阶段结论标 review。仅在主事项已验证闭环、代码已提交且无待合入变更时标 ready_to_archive，并附 closureEvidence。`;
}

export const WORKER_SYSTEM_PROMPT = buildWorkerSystemPrompt();

export function withWorkerSystemPrompt(
  existing: string | undefined,
  timeZone?: string | null,
  isPi = false,
): string {
  const latest = buildWorkerSystemPrompt(timeZone, isPi);
  if (existing?.includes(WORKER_SYSTEM_PROMPT_HEADING)) {
    if (existing.includes(latest)) return existing;
    if (existing.includes(COORDINATOR_SYSTEM_PROMPT_HEADING)) {
      const coordIdx = existing.indexOf(COORDINATOR_SYSTEM_PROMPT_HEADING);
      const coordSuffix = existing.slice(coordIdx);
      const workerIdx = existing.indexOf(WORKER_SYSTEM_PROMPT_HEADING);
      const prefix = existing.slice(0, workerIdx).trimEnd();
      return [prefix, latest, coordSuffix].filter(Boolean).join("\n\n");
    }
    const idx = existing.indexOf(WORKER_SYSTEM_PROMPT_HEADING);
    const prefix = existing.slice(0, idx).trimEnd();
    return [prefix, latest].filter(Boolean).join("\n\n");
  }
  return [existing, latest].filter(Boolean).join("\n\n");
}

export const COORDINATOR_SYSTEM_PROMPT_HEADING = "# Radar 协调模式（纯调度协议）";

export function buildCoordinatorSystemPrompt(
  timeZone?: string | null,
  assignableModels?: ReadonlyArray<{ name?: string; model: string; description?: string }>,
): string {
  const tz = resolveEffectiveTimeZone(timeZone);
  const roster = (assignableModels ?? []).filter((m) => m.model.trim() !== "");
  const modelListBlock =
    roster.length > 0
      ? [
          "",
          "当前可用的角色模型（请按任务性质为不同子卡指定最合适的 `selectedModel`；需要查看全部可选 Profile 时可调 `radar_coord_manage(action: \"models\")`）：",
          ...roster.map((m) => {
            const label = m.name?.trim() || m.model;
            const desc = m.description?.trim() ? `：${m.description.trim()}` : "";
            return `- ${label} (\`${m.model}\`)${desc}`;
          }),
        ].join("\n")
      : "";
  return `${COORDINATOR_SYSTEM_PROMPT_HEADING}

当前卡片已开启 Radar 协调模式（Beta）。你的职责是**纯调度协调者**，严禁直接修改业务仓库代码或陷入实现细节：
1. **调研探索（动态图）**：若尚未明确修改方案，先调用 \`radar_coord_plan\` 创建只读调研子卡（\`isolation: "readonly"\`），再调用 \`radar_mark_waiting_external(mode: "board", ...)\` 监听这些调研子卡归档；收到极简索引结论后再展开 Wave 2 实施子卡。
2. **流水线编排（静态图）**：对于明确的并行或串行任务，一次性通过 \`radar_coord_plan\` 批量创建子卡并用 \`waitBoard\` 声明依赖（如 A、B 自归档后自动触发合流子卡 M），避免「A → 主 → B」绕远路。
3. **跨模型选型（按需派单）**：派发子卡前可调 \`radar_coord_manage(action: "models")\` 查看可用角色模型与适用说明，为不同子卡匹配最合适的 \`selectedModel\`（例如复杂诊断/CR 选推理强的分析模型、实现改代码选工程落地模型、轻量盘点选快速模型）。
4. **隔离与收口原则**：
   - 只读调研/核查派 \`isolation: "readonly"\`；
   - 任何涉及文件修改的任务必须派 \`isolation: "worktree"\`（独立分支提交），并尽量指定客观 \`verifyCommand\`；
   - 分支合流与集成验证也应作为末端收口子卡派发，不要由你自己动手改代码。
5. **传引用不传正文**：建下游子卡时使用 \`refCards\` 引用上游子卡 ID，并在共享产物目录 \`boards/<cardId>/\` 按需读取清单，不把大段报告硬塞进提示词。
6. **例外接管与向人类升级**：子卡遇内部分歧停在 \`needs_me\` 时，通过 \`radar_coord_manage\` 回复裁决；涉及外发沟通、生产数据变更或产品决策时，在父卡调用 \`radar_set_needs_me_tag(tag: "decision", ...)\` 升级给人类确认（当前时区 \`${tz}\`）。全部非取消子卡 \`archived\` 后，方可将父卡标为 \`ready_to_archive\`。${modelListBlock}`;
}

export function withCoordinatorSystemPrompt(
  existing: string | undefined,
  timeZone?: string | null,
  assignableModels?: ReadonlyArray<{ name?: string; model: string; description?: string }>,
  isPi = false,
): string {
  const base = withWorkerSystemPrompt(existing, timeZone, isPi);
  const latest = buildCoordinatorSystemPrompt(timeZone, assignableModels);
  if (base.includes(COORDINATOR_SYSTEM_PROMPT_HEADING)) {
    if (base.includes(latest)) return base;
    const idx = base.indexOf(COORDINATOR_SYSTEM_PROMPT_HEADING);
    const prefix = base.slice(0, idx).trimEnd();
    return [prefix, latest].filter(Boolean).join("\n\n");
  }
  return [base, latest].filter(Boolean).join("\n\n");
}

const COPILOT_AGENTS_MD = `# Radar 看板助手（Copilot）\n\n${COPILOT_SYSTEM_PROMPT}\n`;
const WAIT_CHECK_AGENTS_MD = `# Radar 外部等待出列评估（wait-evaluator）\n\n你是独立的外部等待出列评估模型：只读检查外部完结条件是否已达成，严禁修改任何仓库代码、生产数据或共享文档，严禁对外发送任何外部消息。检查结束后必须调用 \`radar_report_wait_check\` 汇报 \`ready: true/false\`。\n`;
const ONESHOT_AGENTS_MD = `# Radar Internal Task\n\nStrictly output only the requested structured text without calling tools or modifying files.\n`;

export function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export function radarDataDir(): string {
  return join(paseoHome(), "plugin-data", "paseo-radar");
}

export function boardsRootDir(): string {
  return join(radarDataDir(), "boards");
}

export function radarHomeDir(): string {
  return join(radarDataDir(), "home");
}

export function waitChecksDir(): string {
  return join(radarDataDir(), "wait-checks");
}

export function waitScriptsDir(): string {
  return join(radarDataDir(), "wait-scripts");
}

export function oneshotDir(): string {
  return join(radarDataDir(), "oneshot");
}

export function collectorsDir(): string {
  return join(radarDataDir(), "collectors");
}

export function collectorsStateDir(): string {
  return join(collectorsDir(), "state");
}

export function collectorsConfigPath(): string {
  return join(collectorsDir(), "config.json");
}

export function collectorsSpecPath(): string {
  return join(collectorsDir(), "SPEC.md");
}

export const providersDir = () => join(radarDataDir(), "providers");
export const providersStateDir = () => join(providersDir(), "state");
export const providersConfigPath = () => join(providersDir(), "providers.json");
export const providersSpecPath = () => join(providersDir(), "SPEC.md");
export const providerSdkPath = () => join(providersDir(), "radar_provider.py");
export const domainRulesPath = () => join(radarHomeDir(), "domain-rules.json");

export async function readCustomDomainRules(): Promise<CustomDomainRules> {
  try {
    return CustomDomainRulesSchema.parse(JSON.parse(await readFile(domainRulesPath(), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return CustomDomainRulesSchema.parse({});
    throw error;
  }
}

function stateFilePath(): string {
  return join(radarDataDir(), "state.json");
}

export function rulesFilePath(): string {
  return join(radarHomeDir(), "rules.json");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function ensureRadarHome(): Promise<string> {
  const home = radarHomeDir();
  const checksDir = waitChecksDir();
  const oneDir = oneshotDir();
  const pDir = providersDir();
  await mkdir(home, { recursive: true });
  await mkdir(checksDir, { recursive: true });
  await mkdir(oneDir, { recursive: true });
  await mkdir(waitScriptsDir(), { recursive: true });
  await mkdir(providersStateDir(), { recursive: true });
  await writeFile(join(home, "AGENTS.md"), COPILOT_AGENTS_MD, "utf8");
  await writeFile(join(home, "icon.svg"), RADAR_ICON_SVG, "utf8");
  await writeFile(join(checksDir, "AGENTS.md"), WAIT_CHECK_AGENTS_MD, "utf8");
  await writeFile(join(oneDir, "AGENTS.md"), ONESHOT_AGENTS_MD, "utf8");
  await writeFile(providersSpecPath(), COLLECTOR_SPEC_MD, "utf8");
  // Refresh the managed SDK atomically so a Python import never sees a partial file.
  if (await readFile(providerSdkPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }) !== RADAR_PROVIDER_SDK_PY) {
    const tmp = join(pDir, `.sdk-${randomUUID()}.tmp`);
    await writeFile(tmp, RADAR_PROVIDER_SDK_PY, "utf8");
    await rename(tmp, providerSdkPath());
  }

  // A legacy installation keeps running its own scripts until explicitly migrated.
  // Defaults are only installed on first run and never shadow local counterparts.
  if (!(await pathExists(providersConfigPath())) && !(await pathExists(collectorsDir()))) {
    for (const seed of SEED_COLLECTOR_SCRIPTS) {
      const target = join(pDir, seed.filename);
      await writeFile(target, seed.content, { encoding: "utf8", flag: "wx", mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    await atomicWriteJson(providersConfigPath(), DEFAULT_PROVIDERS_CONFIG);
  }

  if (!(await pathExists(rulesFilePath()))) {
    await atomicWriteJson(rulesFilePath(), DEFAULT_RULES);
  }
  return home;
}

function mergeLegacyMeta(existing: ItemUserMeta | undefined, incoming: ItemUserMeta): ItemUserMeta {
  if (!existing) return { ...incoming };
  const existingHasSession = Boolean(
    existing.boundWorkspaceId || existing.boundAgentId || existing.waitScriptPath || existing.waitScheduleId,
  );
  const incomingHasSession = Boolean(
    incoming.boundWorkspaceId || incoming.boundAgentId || incoming.waitScriptPath || incoming.waitScheduleId,
  );
  if (incomingHasSession && !existingHasSession) {
    return { ...existing, ...incoming };
  }
  if (existingHasSession && !incomingHasSession) {
    return { ...incoming, ...existing };
  }
  return { ...existing, ...incoming };
}

export async function readRadarState(): Promise<PersistedRadarState> {
  try {
    const raw = JSON.parse(await readFile(stateFilePath(), "utf8")) as Partial<PersistedRadarState>;
    const rawMeta =
      typeof raw.meta === "object" && raw.meta !== null ? (raw.meta as Record<string, ItemUserMeta>) : {};
    const normalizedMeta: Record<string, ItemUserMeta> = {};
    for (const [k, v] of Object.entries(rawMeta)) {
      if (!v) continue;
      const nk = normalizeCardId(k);
      normalizedMeta[nk] = mergeLegacyMeta(normalizedMeta[nk], v);
    }

    const rawList = Array.isArray(raw.rawItems) ? (raw.rawItems as RawScannedItem[]) : [];
    const seenRawIds = new Set<string>();
    const normalizedRawItems: RawScannedItem[] = [];
    for (const item of rawList) {
      const nid = normalizeCardId(item.id);
      if (seenRawIds.has(nid)) continue;
      seenRawIds.add(nid);
      const normalizedBadge =
        nid.startsWith("linear-issue-") && item.badge.startsWith("Linear ") ? "Linear" : item.badge;
      const normalizedSummary =
        nid.startsWith("linear-issue-") && item.summary.startsWith("Linear 处于 ")
          ? item.summary.slice("Linear ".length)
          : item.summary;
      normalizedRawItems.push({ ...item, id: nid, badge: normalizedBadge, summary: normalizedSummary,
        prepPrompt: item.prepPrompt ?? "", workPrompt: item.workPrompt ?? "" });
    }

    const rawTriage =
      typeof raw.triageCache === "object" && raw.triageCache !== null
        ? (raw.triageCache as Record<string, TriageCacheEntry>)
        : {};
    const normalizedTriage: Record<string, TriageCacheEntry> = {};
    for (const [k, v] of Object.entries(rawTriage)) {
      if (!v || typeof v.stateHash !== "string") continue;
      normalizedTriage[normalizeCardId(k)] = v;
    }

    const rawDiag =
      typeof raw.collectorDiagnostics === "object" && raw.collectorDiagnostics !== null
        ? (raw.collectorDiagnostics as Record<string, Partial<PersistedCollectorDiag>>)
        : {};
    const collectorDiagnostics: Record<string, PersistedCollectorDiag> = {};
    for (const [k, v] of Object.entries(rawDiag)) {
      if (!v || typeof v !== "object") continue;
      let itemHashes: Record<string, string> | undefined;
      if (typeof v.itemHashes === "object" && v.itemHashes !== null) {
        itemHashes = {};
        for (const [ik, ih] of Object.entries(v.itemHashes)) {
          if (typeof ih === "string") itemHashes[normalizeCardId(ik)] = ih;
        }
      }
      collectorDiagnostics[k] = {
        lastRunAt: typeof v.lastRunAt === "string" ? v.lastRunAt : null,
        durationMs: typeof v.durationMs === "number" ? Math.round(v.durationMs) : null,
        itemCount: typeof v.itemCount === "number" ? Math.round(v.itemCount) : null,
        deltaCount: typeof v.deltaCount === "number" ? Math.round(v.deltaCount) : null,
        ...(itemHashes ? { itemHashes } : {}),
        warnings: Array.isArray(v.warnings) ? v.warnings.filter((x): x is string => typeof x === "string") : [],
        error: typeof v.error === "string" ? v.error : null,
      };
    }

    const rawBaselines =
      typeof raw.gitBaselines === "object" && raw.gitBaselines !== null
        ? (raw.gitBaselines as Record<string, Partial<GitDirtyBaseline>>)
        : {};
    const gitBaselines: Record<string, GitDirtyBaseline> = {};
    for (const [k, v] of Object.entries(rawBaselines)) {
      if (!v || typeof v.repoRoot !== "string" || typeof v.entries !== "object" || v.entries === null) {
        continue;
      }
      const entries: Record<string, string> = {};
      for (const [ek, ev] of Object.entries(v.entries)) {
        if (typeof ev === "string") entries[ek] = ev;
      }
      gitBaselines[k] = { repoRoot: v.repoRoot, entries };
    }

    return {
      lastScanAt: typeof raw.lastScanAt === "string" ? raw.lastScanAt : null,
      lastScanDeltaCount: typeof raw.lastScanDeltaCount === "number" ? Math.round(raw.lastScanDeltaCount) : null,
      lastScanTriageTriggered: Boolean(raw.lastScanTriageTriggered),
      scanErrors: Array.isArray(raw.scanErrors) ? raw.scanErrors.filter((x): x is string => typeof x === "string") : [],
      collectorDiagnostics,
      copilotAgentId: typeof raw.copilotAgentId === "string" ? raw.copilotAgentId : null,
      customItems: Array.isArray(raw.customItems) ? raw.customItems.map(item => ({ ...item, prepPrompt: item.prepPrompt ?? "", workPrompt: item.workPrompt ?? "" })) : [],
      rawItems: normalizedRawItems,
      meta: normalizedMeta,
      gitBaselines,
      triageCache: normalizedTriage,
      triageBootstrapped: Boolean(raw.triageBootstrapped),
    };
  } catch {
    return { ...DEFAULT_STATE, collectorDiagnostics: {}, meta: {}, gitBaselines: {}, triageCache: {} };
  }
}

export function updateRadarState<T>(
  mutator: (state: PersistedRadarState) => T | Promise<T>,
): Promise<T> {
  return serialized(async () => {
    const state = await readRadarState();
    const result = await mutator(state);
    await atomicWriteJson(stateFilePath(), state);
    return result;
  });
}

export async function readRadarRules(): Promise<RadarRules> {
  try {
    const raw = JSON.parse(await readFile(rulesFilePath(), "utf8")) as Partial<RadarRules>;
    return {
      mutedKeywords: Array.isArray(raw.mutedKeywords) ? raw.mutedKeywords : [],
      mutedChannels: Array.isArray(raw.mutedChannels) ? raw.mutedChannels : [],
      mutedItemIds: Array.isArray(raw.mutedItemIds) ? raw.mutedItemIds : [],
      notes: Array.isArray(raw.notes) ? raw.notes : [],
    };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

export async function updateRadarRules(
  mutator: (rules: RadarRules) => void | Promise<void>,
): Promise<RadarRules> {
  return serialized(async () => {
    await ensureRadarHome();
    const rules = await readRadarRules();
    await mutator(rules);
    await atomicWriteJson(rulesFilePath(), rules);
    return rules;
  });
}

export function computeSnoozeUntil(
  preset: SnoozePreset,
  now = new Date(),
  timeZone?: string | null,
): string {
  return computeSnoozeUntilInTimeZone(preset, timeZone, now);
}

export function itemVisibility(
  stateHash: string,
  meta: ItemUserMeta | undefined,
  nowMs = Date.now(),
): { visibility: "active" | "snoozed" | "dismissed"; snoozedUntil: string | null } {
  if (!meta) return { visibility: "active", snoozedUntil: null };
  if (meta.dismissedHash && meta.dismissedHash === stateHash) {
    return { visibility: "dismissed", snoozedUntil: null };
  }
  if (meta.snoozedUntil && meta.snoozedHash === stateHash) {
    const untilMs = Date.parse(meta.snoozedUntil);
    if (!Number.isNaN(untilMs) && untilMs > nowMs) {
      return { visibility: "snoozed", snoozedUntil: meta.snoozedUntil };
    }
  }
  return { visibility: "active", snoozedUntil: null };
}
