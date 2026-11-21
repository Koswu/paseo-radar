import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ArtifactEntry,
  BoardWatchSpec,
  CoordBoard,
  CoordBoardDetail,
  CoordEvent,
  CoordinationSummary,
  SubCard,
  SubCardInboxMessage,
} from "../shared/coordination";
import type {
  CardStatus,
  DecisionProposal,
  NeedsMeTag,
  RadarLink,
  RadarLinkInput,
  WaitMode,
} from "../shared/radar-primitives";
import type { ProjectOption } from "../shared/radar";
import type {
  BoardWatchEvalResult,
  SiblingRosterItem,
  UpstreamCardManifest,
  WatchTargetStateSnapshot,
} from "./coordination-graph";
import type { AppendCoordEventInput } from "./coordination-store";
import type { GitDirtyBaseline } from "./store";

function isPiProvider(providerOrModel?: string | null): boolean {
  const norm = (providerOrModel ?? "").trim().toLowerCase();
  return norm === "pi" || norm.startsWith("pi/");
}

export interface CoordToolResult {
  text: string;
  isError?: boolean;
}

export interface SubcardPlanCreateSpec {
  id: string;
  wave?: number;
  title: string;
  objective: string;
  isolation?: "readonly" | "worktree";
  selectedModel?: string | null;
  refCards?: string[];
  requireReview?: boolean;
  verifyCommand?: string | null;
  waitBoard?: {
    targets: Array<{ cardId: string; status?: CardStatus; needsMeTag?: NeedsMeTag | null }>;
    match?: "all" | "any";
  } | null;
  startNow?: boolean;
}

export interface SubcardPlanUpdateSpec {
  id: string;
  title?: string;
  objective?: string;
  wave?: number;
  refCards?: string[];
  requireReview?: boolean;
  verifyCommand?: string | null;
  waitBoard?: {
    targets: Array<{ cardId: string; status?: CardStatus; needsMeTag?: NeedsMeTag | null }>;
    match?: "all" | "any";
  } | null;
  startNow?: boolean;
}

export interface CoordAgentHandle {
  id: string;
  workspaceId: string | null;
  cwd: string | null;
  status: string;
  archivedAt?: string | null;
  labels: Readonly<Record<string, string>>;
}

export interface CoordinationEngineDeps {
  boardsRootDir: () => string;
  waitScriptsDir: () => string;
  waitChecksDir: () => string;
  maxP2pRounds?: number;
  debounceMs?: number;

  graph: {
    sanitizeBoardCardId: (cardId: string) => string;
    detectBoardWatchCycle: (
      existingEdges: ReadonlyMap<string, readonly string[]>,
      fromId: string,
      toIds: readonly string[],
    ) => string[] | null;
    evaluateBoardWatch: (
      spec: BoardWatchSpec,
      lookup: (cardId: string) => WatchTargetStateSnapshot | null,
    ) => BoardWatchEvalResult;
    computeTopologicalWaves: (subcards: readonly SubCard[]) => Array<{ wave: number; subcardIds: string[] }>;
    computeCoordinationSummary: (board: CoordBoard, eventCount: number) => CoordinationSummary;
    formatReferenceManifestPrompt: (params: {
      boardDir: string;
      subcardId: string;
      subcardOutputDir: string;
      upstreamCards: readonly UpstreamCardManifest[];
      inboxMessages?: readonly SubCardInboxMessage[];
      siblings?: readonly SiblingRosterItem[];
    }) => string;
  };

  store: {
    sanitizeSubcardDirName: (subcardId: string) => string;
    subcardOutputDirPath: (boardDir: string, subcardId: string) => string;
    ensureCoordBoardDirs: (boardDir: string) => Promise<void>;
    ensureSubcardOutputDir: (boardDir: string, subcardId: string) => Promise<string>;
    readCoordBoard: (boardDir: string) => Promise<CoordBoard | null>;
    updateCoordBoard: <T>(
      boardDir: string,
      cardId: string,
      mutator: (board: CoordBoard) => T | Promise<T>,
    ) => Promise<T>;
    appendCoordEvent: (
      boardDir: string,
      input: AppendCoordEventInput,
    ) => Promise<CoordEvent>;
    readCoordEvents: (
      boardDir: string,
      limit?: number,
    ) => Promise<{ events: CoordEvent[]; totalCount: number }>;
    countCoordEvents: (boardDir: string) => Promise<number>;
    scanDirectoryArtifacts: (
      boardDir: string,
      subDirRelative: string,
      notesByRelPath?: Readonly<Record<string, string>>,
    ) => Promise<ArtifactEntry[]>;
    readBoardArtifactContent: (
      boardDir: string,
      relativePath: string,
      maxBytes?: number,
    ) => Promise<{ relativePath: string; content: string; truncated: boolean; sizeBytes: number }>;
  };

  waitUtils: {
    parseCron5: (expr: string) => unknown;
    parseMaxTimeoutMs: (raw: string) => number | null;
    resolveEffectiveTimeZone: (preferred?: string | null) => string;
    hasWaitPendingExitCode: (script: string) => boolean;
    classifyWaitScriptFailure: (err: {
      code?: unknown;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    }) => { kind: "pending" | "fast_fail" | "transient"; threshold: number; statusTag: string };
    matchesCron5InTimeZone: (cron: string, tz: string, nowMs: number) => boolean;
    minuteSlotInTimeZone: (tz: string, nowMs: number) => { slotKey: string };
    waitScriptRetryBackoffMs: number;
  };

  gates: {
    validateReadyToArchiveEvidence: (evidence: string | undefined) => string | null;
    findUncommittedSessionChanges: (
      cwd: string,
      baseline: GitDirtyBaseline | undefined,
      closureEvidence?: string,
    ) => Promise<{ repoRoot: string; branch: string; dirtyFiles: string[] } | null>;
    getGitBaselineForScope: (scopeKey: string) => Promise<GitDirtyBaseline | undefined>;
    execShellCommand: (
      command: string,
      cwd: string,
      timeoutMs?: number,
    ) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | string | null; timedOut: boolean }>;
    captureGitBranchAndSha: (cwd: string) => Promise<{ branch: string | null; sha: string | null }>;
    mergeAttachedLinks: (
      incoming: readonly RadarLinkInput[],
      existing?: readonly RadarLink[],
    ) => RadarLink[];
  };

  radar: {
    isCoordinationBetaEnabled: () => Promise<boolean>;
    getEffectiveTimezone: () => Promise<string>;
    getDefaultWorkerModel: () => Promise<{
      defaultModel: string;
      assignable: Array<{
        id?: string;
        name?: string;
        model: string;
        description?: string;
        modeId?: string | null;
        thinkingOptionId?: string | null;
        featureValues?: Record<string, unknown> | null;
      }>;
      extraProfiles?: Array<{
        id: string;
        name: string;
        model: string;
        notes: string;
      }>;
    }>;
    listWaitEvalModels: () => Promise<string[]>;
    getParentCardContext: (cardId: string) => Promise<{
      cardId: string;
      title: string;
      coordinationEnabled: boolean;
      boundWorkspaceId: string | null;
      boundAgentId: string | null;
      project: ProjectOption | null;
      cwd: string | null;
      waitMode: WaitMode | null;
      waitBoard: BoardWatchSpec | null;
    } | null>;
    listEnabledParentCardIds: () => Promise<string[]>;
    setParentCoordinationMeta: (
      cardId: string,
      patch: {
        coordinationEnabled?: boolean;
        addSubcardWorkspaceId?: string;
        clearParentWait?: boolean;
      },
    ) => Promise<void>;
    buildCoordinatorSystemPrompt: (
      timeZone: string,
      assignable?: ReadonlyArray<{ name?: string; model: string; description?: string }>,
    ) => string;
    sendCoordinatorPrompt: (
      parentCardId: string,
      agentId: string | null,
      prompt: string,
    ) => Promise<boolean>;
    getAgentSnapshot: (agentId: string) => Promise<CoordAgentHandle | null>;
    sendAgentMessage: (agentId: string, prompt: string) => Promise<void>;
    archiveAgent: (agentId: string) => Promise<void>;
    archiveWorkspace: (workspaceId: string) => Promise<void>;
    createSubcardSession: (params: {
      parentCardId: string;
      subcardId: string;
      title: string;
      isolation: "readonly" | "worktree";
      parentWorkspaceId: string | null;
      parentCwd: string | null;
      project: ProjectOption | null;
      coordinatorAgentId: string | null;
      selectedModel: string | null;
      prompt: string;
      buildPrompt?: (isPi: boolean) => string;
    }) => Promise<{
      workspaceId: string;
      agentId: string;
      gitBranch: string | null;
      resolvedModel?: string | null;
    }>;
    createAiWaitSchedule: (params: {
      name: string;
      prompt: string;
      cron: string;
      timeoutAt: string;
      timezone: string;
      fullModel?: string;
    }) => Promise<{ scheduleId: string }>;
    deleteWaitSchedule: (scheduleId: string | null | undefined) => Promise<void>;
    deleteWaitScript: (scriptPath: string | null | undefined) => Promise<void>;
    readAgentTailReply: (agentId: string) => Promise<string>;
  };
}

export function encodeSubcardWaitKey(parentCardId: string, subcardId: string): string {
  return `sub:${encodeURIComponent(parentCardId)}:${encodeURIComponent(subcardId)}`;
}

export function decodeSubcardWaitKey(
  rawKey: string,
): { parentCardId: string; subcardId: string } | null {
  if (!rawKey.startsWith("sub:")) return null;
  const parts = rawKey.split(":");
  if (parts.length !== 3) return null;
  try {
    const parentCardId = decodeURIComponent(parts[1]!);
    const subcardId = decodeURIComponent(parts[2]!);
    if (!parentCardId || !subcardId) return null;
    return { parentCardId, subcardId };
  } catch {
    return null;
  }
}

function buildSubcardSystemGuide(
  subcardId: string,
  parentCardId: string,
  outputDir: string,
  isPi = false,
): string {
  const lines = [
    `[Radar 子卡执行协议 · 子卡 ${subcardId}（父卡 ${parentCardId}）]`,
    `- 你的专属产物目录：\`${outputDir}\`（长报告、日志片段、分析结果请落盘至此，下游将按需读取）。`,
    "- 正常完工时必须调用 `radar_complete_subcard` 并提交具体的 `closureEvidence`（修改了代码的 worktree 子卡须先 `git commit` 且不加署名/Co-Authored-By，并确保验收命令通过）；门禁通过后子卡将自动归档并触发下游，无需主协调者介入。",
    "- 如需等待外部条件（CI/审批/远端脚本）或等待同看板前置子卡，请调用 `radar_mark_waiting_external`（支持 `script` / `ai` / `board` 模式）。",
    "- 如遇内部技术分歧、缺少信息或阶段同步，请调用 `radar_set_needs_me_tag`（`decision` / `input` / `review`）升级给协调者；勿私自越权外发消息或修改生产数据。",
    "- 同看板兄弟子卡信息与产物清单可通过 `subradar_inspect` 拉取；并行期间需要向特定兄弟子卡问询或通知时，可用 `subradar_message_peer`（上限 4 轮）。",
  ];
  if (isPi) {
    lines.push(
      "- 若在 `codemode` 沙箱环境且工具未直接列出，请通过 `await tools.mcp__paseo__radar_complete_subcard(...)`、`await tools.mcp__paseo__subradar_message_peer(...)`、`await tools.mcp__paseo__subradar_inspect(...)`、`await tools.mcp__paseo__radar_mark_waiting_external(...)`、`await tools.mcp__paseo__radar_set_needs_me_tag(...)` 调用（参数可用 `await describeTool(\"mcp__paseo__<工具名>\")` 查询）。",
    );
  }
  return lines.join("\n");
}

function formatWatchConditionLabel(spec: BoardWatchSpec): string {
  const joiner = spec.match === "any" ? " 或 " : " 且 ";
  const items = spec.targets
    .map((t) => `${t.cardId}->${t.status}${t.needsMeTag ? `(${t.needsMeTag})` : ""}`)
    .join(joiner);
  return `看板条件：${items}`;
}

class PlanValidationError extends Error {}

function truncateOneLine(raw: string, maxLen: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

export class RadarCoordinationEngine {
  private readonly deps: CoordinationEngineDeps;
  private readonly maxP2pRounds: number;
  private readonly debounceMs: number;
  private readonly runningScriptChecks = new Set<string>();
  private readonly lastScriptCronSlot = new Map<string, string>();
  private readonly pendingWakeEvents = new Map<string, CoordEvent[]>();
  private readonly wakeDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: CoordinationEngineDeps) {
    this.deps = deps;
    this.maxP2pRounds = deps.maxP2pRounds ?? 4;
    this.debounceMs = deps.debounceMs ?? 3000;
  }

  boardDirForCard(cardId: string): string {
    return join(this.deps.boardsRootDir(), this.deps.graph.sanitizeBoardCardId(cardId));
  }

  dispose(): void {
    for (const timer of this.wakeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.wakeDebounceTimers.clear();
    this.pendingWakeEvents.clear();
  }

  private subcardWaitEdgeMap(subcards: readonly SubCard[]): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    for (const s of subcards) {
      if (s.canceled) continue;
      if (s.status === "waiting_external" && s.waitMode === "board" && s.waitBoard?.scope === "inner") {
        edges.set(
          s.id,
          s.waitBoard.targets.map((t) => t.cardId),
        );
      }
    }
    return edges;
  }

  private lookupSubcardWatchMap(subcards: readonly SubCard[]): (id: string) => WatchTargetStateSnapshot | null {
    const map = new Map(subcards.map((s) => [s.id, s]));
    return (id: string) => {
      const card = map.get(id);
      if (!card) return null;
      return {
        status: card.status,
        needsMeTag: card.needsMeTag,
        canceled: card.canceled,
      };
    };
  }

  private buildUpstreamManifests(
    board: CoordBoard,
    targetIds: readonly string[],
  ): UpstreamCardManifest[] {
    const byId = new Map(board.subcards.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const out: UpstreamCardManifest[] = [];
    for (const id of targetIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const card = byId.get(id);
      if (!card) continue;
      out.push({
        id: card.id,
        title: card.title,
        status: card.status,
        closureEvidence: card.closureEvidence,
        gitBranch: card.gitBranch,
        commitSha: card.commitSha,
        links: card.links,
        artifacts: card.artifacts,
      });
    }
    return out;
  }

  async getCoordinationSummary(cardId: string): Promise<CoordinationSummary | null> {
    const boardDir = this.boardDirForCard(cardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board || !board.enabled) return null;
    const eventCount = await this.deps.store.countCoordEvents(boardDir);
    return this.deps.graph.computeCoordinationSummary(board, eventCount);
  }

  async getUnfinishedSubcardsForGate(cardId: string): Promise<SubCard[]> {
    const boardDir = this.boardDirForCard(cardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board || !board.enabled) return [];
    return board.subcards.filter((s) => !s.canceled && s.status !== "archived");
  }

  async getParentAggregatedWaitingStatus(cardId: string): Promise<{
    isWaiting: boolean;
    condition: string | null;
  }> {
    const ctx = await this.deps.radar.getParentCardContext(cardId);
    if (!ctx?.coordinationEnabled) return { isWaiting: false, condition: null };
    const board = await this.deps.store.readCoordBoard(this.boardDirForCard(cardId));
    if (!board || !board.enabled) return { isWaiting: false, condition: null };
    const active = board.subcards.filter((s) => !s.canceled);
    if (active.length === 0) return { isWaiting: false, condition: null };
    const anyRunning = active.some((s) => s.status === "running");
    const anyNeedsMe = active.some((s) => s.status === "needs_me");
    const waitingExt = active.filter(
      (s) => s.status === "waiting_external" && s.waitMode !== "board",
    );
    if (!anyRunning && !anyNeedsMe && waitingExt.length > 0 && ctx.waitMode === "board") {
      const preview = waitingExt
        .slice(0, 2)
        .map((s) => `${s.id}:${truncateOneLine(s.waitCondition ?? "等外部", 24)}`)
        .join("；");
      return {
        isWaiting: true,
        condition: `等待 ${waitingExt.length} 个子卡外部条件（${preview}）`,
      };
    }
    return { isWaiting: false, condition: null };
  }

  async toggleCoordination(input: {
    cardId: string;
    enabled: boolean;
    steerNow?: boolean;
    callerAgentId?: string | null;
  }): Promise<{ cardId: string; enabled: boolean; summary: CoordinationSummary }> {
    const ctx = await this.deps.radar.getParentCardContext(input.cardId);
    if (!ctx) {
      throw new Error(`未找到卡片 ${input.cardId}`);
    }

    if (input.enabled) {
      const betaOn = await this.deps.radar.isCoordinationBetaEnabled();
      if (!betaOn && !ctx.coordinationEnabled) {
        throw new Error(
          "协调模式当前为 Beta 功能且尚未开启。请前往「设置 -> Radar -> 协调模式（Beta）」开启后再使用。",
        );
      }
    }

    const boardDir = this.boardDirForCard(input.cardId);
    await this.deps.store.ensureCoordBoardDirs(boardDir);
    const nowIso = new Date().toISOString();
    const coordAgentId = input.callerAgentId ?? ctx.boundAgentId ?? null;

    const board = await this.deps.store.updateCoordBoard(boardDir, input.cardId, (b) => {
      b.enabled = input.enabled;
      if (input.enabled && !b.enabledAt) {
        b.enabledAt = nowIso;
      }
      if (coordAgentId) {
        b.coordinatorAgentId = coordAgentId;
      }
      return { ...b };
    });

    await this.deps.radar.setParentCoordinationMeta(input.cardId, {
      coordinationEnabled: input.enabled,
    });

    await this.deps.store.appendCoordEvent(boardDir, {
      kind: "coord.enabled",
      actor: input.callerAgentId ? "coordinator" : "human",
      summary: input.enabled ? "开启卡片协调模式（Beta）" : "关闭卡片协调模式",
      detail: { enabled: input.enabled },
    });

    if (input.enabled && input.steerNow !== false && coordAgentId) {
      const [tz, workerModels] = await Promise.all([
        this.deps.radar.getEffectiveTimezone(),
        this.deps.radar.getDefaultWorkerModel().catch(() => ({ defaultModel: "", assignable: [] })),
      ]);
      const rolePrompt = this.deps.radar.buildCoordinatorSystemPrompt(tz, workerModels.assignable);
      await this.deps.radar.sendCoordinatorPrompt(
        input.cardId,
        coordAgentId,
        `[系统通知：本卡片已切换为协调模式]\n\n${rolePrompt}\n\n共享看板目录：\`${boardDir}\`。请以纯调度协调者身份拆解并派发子卡。`,
      );
    }

    const eventCount = await this.deps.store.countCoordEvents(boardDir);
    return {
      cardId: input.cardId,
      enabled: board.enabled,
      summary: this.deps.graph.computeCoordinationSummary(board, eventCount),
    };
  }

  async planSubcards(input: {
    parentCardId: string;
    callerAgentId: string;
    create?: SubcardPlanCreateSpec[];
    update?: SubcardPlanUpdateSpec[];
    cancelIds?: string[];
  }): Promise<CoordToolResult> {
    const ctx = await this.deps.radar.getParentCardContext(input.parentCardId);
    if (!ctx) {
      return { text: `未找到父卡 ${input.parentCardId}`, isError: true };
    }
    const betaOn = await this.deps.radar.isCoordinationBetaEnabled();
    if (!betaOn && !ctx.coordinationEnabled) {
      return {
        text: "协调模式当前为 Beta 功能且尚未开启。请先在「设置 -> Radar -> 协调模式（Beta）」开启后再调用 radar_coord_plan。",
        isError: true,
      };
    }

    const boardDir = this.boardDirForCard(input.parentCardId);
    await this.deps.store.ensureCoordBoardDirs(boardDir);

    if (!ctx.coordinationEnabled) {
      await this.toggleCoordination({
        cardId: input.parentCardId,
        enabled: true,
        steerNow: false,
        callerAgentId: input.callerAgentId,
      });
    }

    const nowIso = new Date().toISOString();
    const toStart: Array<{ subcardId: string; triggerNote?: string }> = [];
    const createdEvents: AppendCoordEventInput[] = [];
    const canceledIds: string[] = [];
    const touchedIds = new Set<string>([
      ...(input.create ?? []).map((c) => c.id.trim()).filter(Boolean),
      ...(input.update ?? []).map((u) => u.id.trim()).filter(Boolean),
    ]);

    try {
      await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (board) => {
        board.enabled = true;
        if (!board.enabledAt) board.enabledAt = nowIso;
        board.coordinatorAgentId = input.callerAgentId;

        const byId = new Map(board.subcards.map((s) => [s.id, s]));

        for (const spec of input.create ?? []) {
          const cleanId = spec.id.trim();
          if (!cleanId) {
            throw new PlanValidationError("子卡 id 不能为空");
          }
          const existing = byId.get(cleanId);
          if (existing && !existing.canceled) {
            throw new PlanValidationError(`子卡 ID "${cleanId}" 已存在，请使用 update 或更换唯一 ID`);
          }
          if (existing && existing.canceled) {
            // Replace previously canceled slot cleanly
            board.subcards = board.subcards.filter((s) => s.id !== cleanId);
            byId.delete(cleanId);
          }

          let waitBoard: BoardWatchSpec | null = null;
          if (spec.waitBoard && spec.waitBoard.targets.length > 0) {
            waitBoard = {
              scope: "inner",
              parentCardId: input.parentCardId,
              targets: spec.waitBoard.targets.map((t) => ({
                cardId: t.cardId.trim(),
                status: t.status ?? "archived",
                ...(t.needsMeTag !== undefined ? { needsMeTag: t.needsMeTag } : {}),
              })),
              match: spec.waitBoard.match ?? "all",
              wakeOnException: true,
            };
            const edges = this.subcardWaitEdgeMap(board.subcards);
            const cycle = this.deps.graph.detectBoardWatchCycle(
              edges,
              cleanId,
              waitBoard.targets.map((t) => t.cardId),
            );
            if (cycle) {
              throw new PlanValidationError(
                `拒绝创建子卡 "${cleanId}"：检测到循环等待依赖 (${cycle.join(" → ")})`,
              );
            }
          }

          const sub: SubCard = {
            id: cleanId,
            wave: spec.wave ?? 1,
            title: spec.title.trim(),
            objective: spec.objective.trim(),
            isolation: spec.isolation ?? "readonly",
            selectedModel: spec.selectedModel?.trim() || null,
            refCards: [...new Set((spec.refCards ?? []).map((x) => x.trim()).filter(Boolean))],
            requireReview: Boolean(spec.requireReview),
            verifyCommand: spec.verifyCommand?.trim() || null,
            status: waitBoard ? "waiting_external" : "pool",
            needsMeTag: null,
            decisionProposal: null,
            waitMode: waitBoard ? "board" : null,
            waitCondition: waitBoard ? formatWatchConditionLabel(waitBoard) : null,
            waitBoard,
            waitCron: null,
            waitScriptPath: null,
            waitScheduleId: null,
            waitStartedAt: waitBoard ? nowIso : null,
            waitTimeoutAt: null,
            waitMaxTimeoutLabel: null,
            waitCheckNote: null,
            lastWaitCheckAt: null,
            waitConsecutiveErrors: null,
            waitNextRetryAt: null,
            boundWorkspaceId: null,
            boundAgentId: null,
            gitBranch: null,
            commitSha: null,
            links: [],
            closureEvidence: null,
            artifacts: [],
            inbox: [],
            p2pRoundsByPeer: {},
            canceled: false,
            createdAt: nowIso,
            startedAt: null,
            finishedAt: null,
            updatedAt: nowIso,
          };
          board.subcards.push(sub);
          byId.set(cleanId, sub);
          createdEvents.push({
            kind: "subcard.created",
            actor: "coordinator",
            subcardId: cleanId,
            causedBy: null,
            summary: `创建子卡 ${cleanId}「${sub.title}」(${sub.isolation})`,
            detail: { wave: sub.wave, isolation: sub.isolation },
          });
          if (waitBoard) {
            createdEvents.push({
              kind: "wait.registered",
              actor: "coordinator",
              subcardId: cleanId,
              causedBy: null,
              summary: `${cleanId} 注册${sub.waitCondition}`,
            });
          }
        }

        for (const upd of input.update ?? []) {
          const sub = byId.get(upd.id.trim());
          if (!sub || sub.canceled) {
            throw new PlanValidationError(`未找到待更新的子卡 "${upd.id}"`);
          }
          if (upd.title !== undefined) sub.title = upd.title.trim();
          if (upd.objective !== undefined) sub.objective = upd.objective.trim();
          if (upd.wave !== undefined) sub.wave = upd.wave;
          if (upd.refCards !== undefined) {
            sub.refCards = [...new Set(upd.refCards.map((x) => x.trim()).filter(Boolean))];
          }
          if (upd.requireReview !== undefined) sub.requireReview = upd.requireReview;
          if (upd.verifyCommand !== undefined) sub.verifyCommand = upd.verifyCommand?.trim() || null;

          if (upd.waitBoard !== undefined) {
            if (upd.waitBoard === null || upd.waitBoard.targets.length === 0) {
              if (sub.waitMode === "board" && sub.status === "waiting_external") {
                sub.status = sub.boundAgentId ? "needs_me" : "pool";
              }
              sub.waitMode = null;
              sub.waitBoard = null;
              sub.waitCondition = null;
              sub.waitStartedAt = null;
            } else {
              const nextWatch: BoardWatchSpec = {
                scope: "inner",
                parentCardId: input.parentCardId,
                targets: upd.waitBoard.targets.map((t) => ({
                  cardId: t.cardId.trim(),
                  status: t.status ?? "archived",
                  ...(t.needsMeTag !== undefined ? { needsMeTag: t.needsMeTag } : {}),
                })),
                match: upd.waitBoard.match ?? "all",
                wakeOnException: true,
              };
              const edges = this.subcardWaitEdgeMap(board.subcards);
              const cycle = this.deps.graph.detectBoardWatchCycle(
                edges,
                sub.id,
                nextWatch.targets.map((t) => t.cardId),
              );
              if (cycle) {
                throw new PlanValidationError(
                  `更新子卡 "${sub.id}" 失败：检测到循环等待 (${cycle.join(" → ")})`,
                );
              }
              sub.waitMode = "board";
              sub.waitBoard = nextWatch;
              sub.waitCondition = formatWatchConditionLabel(nextWatch);
              sub.waitStartedAt = nowIso;
              if (sub.status === "pool") sub.status = "waiting_external";
            }
          }
          sub.updatedAt = nowIso;
        }

        for (const rawCancelId of input.cancelIds ?? []) {
          const sub = byId.get(rawCancelId.trim());
          if (!sub || sub.canceled) continue;
          sub.canceled = true;
          sub.status = "archived";
          sub.finishedAt = nowIso;
          sub.updatedAt = nowIso;
          sub.waitMode = null;
          sub.waitBoard = null;
          sub.waitCondition = null;
          canceledIds.push(sub.id);
          createdEvents.push({
            kind: "subcard.canceled",
            actor: "coordinator",
            subcardId: sub.id,
            causedBy: null,
            summary: `取消子卡 ${sub.id}「${sub.title}」`,
          });
        }

        // Check immediate readiness & pre-satisfied waitBoard conditions
        const lookup = this.lookupSubcardWatchMap(board.subcards);
        const startMap = new Map<string, boolean>();
        for (const c of input.create ?? []) {
          startMap.set(c.id.trim(), c.startNow ?? true);
        }
        for (const u of input.update ?? []) {
          if (u.startNow !== undefined) startMap.set(u.id.trim(), u.startNow);
        }

        for (const sub of board.subcards) {
          if (sub.canceled) continue;
          if (sub.status === "waiting_external" && sub.waitMode === "board" && sub.waitBoard) {
            const evalRes = this.deps.graph.evaluateBoardWatch(sub.waitBoard, lookup);
            if (evalRes.state === "satisfied") {
              sub.status = "pool";
              sub.waitMode = null;
              sub.waitBoard = null;
              sub.waitCondition = null;
              sub.waitStartedAt = null;
              sub.waitCheckNote = `依赖已满足 (${evalRes.matchedIds.join(", ")})`;
              if (startMap.get(sub.id) !== false && !sub.boundAgentId) {
                toStart.push({
                  subcardId: sub.id,
                  triggerNote: `前置子卡 (${evalRes.matchedIds.join(", ")}) 已满足条件`,
                });
              }
            } else if (evalRes.state === "broken" && touchedIds.has(sub.id)) {
              throw new PlanValidationError(
                `子卡 "${sub.id}" 监听的依赖不存在或已取消 (${evalRes.brokenIds.join(", ")})`,
              );
            }
          } else if (sub.status === "pool" && startMap.get(sub.id) === true && !sub.boundAgentId) {
            toStart.push({ subcardId: sub.id });
          }
        }
      });
    } catch (err) {
      if (err instanceof PlanValidationError) {
        return { text: err.message, isError: true };
      }
      throw err;
    }

    for (const ev of createdEvents) {
      await this.deps.store.appendCoordEvent(boardDir, ev);
    }

    for (const sub of await this.getSubcardsByIds(boardDir, (input.create ?? []).map((c) => c.id.trim()))) {
      await this.deps.store.ensureSubcardOutputDir(boardDir, sub.id);
    }

    // Cancel live resources for canceled subcards and propagate broken dependencies
    for (const cid of canceledIds) {
      const board = await this.deps.store.readCoordBoard(boardDir);
      const canceledCard = board?.subcards.find((s) => s.id === cid);
      if (canceledCard) {
        await Promise.all([
          this.deps.radar.deleteWaitSchedule(canceledCard.waitScheduleId),
          this.deps.radar.deleteWaitScript(canceledCard.waitScriptPath),
          canceledCard.boundAgentId
            ? this.deps.radar.archiveAgent(canceledCard.boundAgentId).catch(() => {})
            : Promise.resolve(),
          canceledCard.boundWorkspaceId
            ? this.deps.radar.archiveWorkspace(canceledCard.boundWorkspaceId).catch(() => {})
            : Promise.resolve(),
        ]);
      }
      await this.evaluateInnerBoardWatchers(input.parentCardId, cid, null);
    }

    const startedIds: string[] = [];
    const startErrors: string[] = [];
    for (const item of toStart) {
      try {
        await this.startSubcard(input.parentCardId, item.subcardId, item.triggerNote);
        startedIds.push(item.subcardId);
      } catch (err) {
        startErrors.push(
          `${item.subcardId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const latestBoard = await this.deps.store.readCoordBoard(boardDir);
    const eventCount = await this.deps.store.countCoordEvents(boardDir);
    const summary = latestBoard
      ? this.deps.graph.computeCoordinationSummary(latestBoard, eventCount)
      : null;

    return {
      text: JSON.stringify(
        {
          ok: startErrors.length === 0,
          boardDir,
          startedIds,
          startErrors,
          canceledIds,
          summary,
        },
        null,
        2,
      ),
      ...(startErrors.length > 0 && startedIds.length === 0 ? { isError: true } : {}),
    };
  }

  private async getSubcardsByIds(boardDir: string, ids: readonly string[]): Promise<SubCard[]> {
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) return [];
    const idSet = new Set(ids);
    return board.subcards.filter((s) => idSet.has(s.id));
  }

  async startSubcard(
    parentCardId: string,
    subcardId: string,
    triggerNote?: string,
  ): Promise<{ workspaceId: string; agentId: string }> {
    const ctx = await this.deps.radar.getParentCardContext(parentCardId);
    if (!ctx) throw new Error(`未找到父卡 ${parentCardId}`);

    const boardDir = this.boardDirForCard(parentCardId);
    const outputDir = await this.deps.store.ensureSubcardOutputDir(boardDir, subcardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) throw new Error(`未找到父卡 ${parentCardId} 的协调看板`);

    const sub = board.subcards.find((s) => s.id === subcardId && !s.canceled);
    if (!sub) throw new Error(`未找到可启动的子卡 ${subcardId}`);
    if (sub.status === "archived") throw new Error(`子卡 ${subcardId} 已归档`);
    if (sub.status === "running" && sub.boundAgentId) {
      return { workspaceId: sub.boundWorkspaceId ?? "", agentId: sub.boundAgentId };
    }

    const upstreamIds = [
      ...sub.refCards,
      ...(sub.waitBoard?.scope === "inner" ? sub.waitBoard.targets.map((t) => t.cardId) : []),
    ];
    const upstreamCards = this.buildUpstreamManifests(board, upstreamIds);
    const siblings: SiblingRosterItem[] = board.subcards.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      isolation: s.isolation,
      gitBranch: s.gitBranch,
      canceled: s.canceled,
    }));

    const deliveredInboxIds = new Set(sub.inbox.map((m) => m.id));
    const manifestBlock = this.deps.graph.formatReferenceManifestPrompt({
      boardDir,
      subcardId: sub.id,
      subcardOutputDir: outputDir,
      upstreamCards,
      inboxMessages: sub.inbox,
      siblings,
    });

    const buildPrompt = (isPi: boolean) => {
      const guide = buildSubcardSystemGuide(sub.id, parentCardId, outputDir, isPi);
      return [
        `# 子卡任务：${sub.id}「${sub.title}」`,
        triggerNote ? `【触发原因】${triggerNote}` : "",
        `## 任务目标与要求\n${sub.objective}`,
        sub.verifyCommand
          ? `## 客观验收命令\n完结前必须在工作目录执行并确保通过：\`${sub.verifyCommand}\``
          : "",
        manifestBlock,
        guide,
      ]
        .filter(Boolean)
        .join("\n\n");
    };
    const prompt = buildPrompt(isPiProvider(sub.selectedModel));

    const session = await this.deps.radar.createSubcardSession({
      parentCardId,
      subcardId: sub.id,
      title: `[${sub.id}] ${sub.title}`.slice(0, 56),
      isolation: sub.isolation,
      parentWorkspaceId: ctx.boundWorkspaceId,
      parentCwd: ctx.cwd,
      project: ctx.project,
      coordinatorAgentId: board.coordinatorAgentId ?? ctx.boundAgentId,
      selectedModel: sub.selectedModel,
      prompt,
      buildPrompt,
    });

    if (sub.isolation === "worktree" && session.workspaceId !== ctx.boundWorkspaceId) {
      await this.deps.radar.setParentCoordinationMeta(parentCardId, {
        addSubcardWorkspaceId: session.workspaceId,
      });
    }

    const nowIso = new Date().toISOString();
    await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
      const target = b.subcards.find((s) => s.id === subcardId);
      if (!target) return;
      target.status = "running";
      target.needsMeTag = null;
      target.decisionProposal = null;
      target.waitMode = null;
      target.waitBoard = null;
      target.waitCondition = null;
      target.boundWorkspaceId = session.workspaceId;
      target.boundAgentId = session.agentId;
      if (session.resolvedModel) target.selectedModel = session.resolvedModel;
      if (session.gitBranch) target.gitBranch = session.gitBranch;
      if (deliveredInboxIds.size > 0) {
        target.inbox = target.inbox.filter((m) => !deliveredInboxIds.has(m.id));
      }
      target.startedAt = target.startedAt ?? nowIso;
      target.updatedAt = nowIso;
    });

    const effectiveModel = session.resolvedModel ?? sub.selectedModel;
    await this.deps.store.appendCoordEvent(boardDir, {
      kind: "subcard.started",
      actor: "engine",
      subcardId: sub.id,
      summary: `启动子卡 ${sub.id} (${sub.isolation}${effectiveModel ? ` · ${effectiveModel}` : ""}${session.gitBranch ? ` · ${session.gitBranch}` : ""})`,
      detail: {
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        isolation: sub.isolation,
        selectedModel: effectiveModel,
      },
    });

    return { workspaceId: session.workspaceId, agentId: session.agentId };
  }

  async completeSubcard(input: {
    parentCardId: string;
    subcardId: string;
    callerAgent: { id: string; workspaceId: string | null; cwd: string | null };
    closureEvidence: string;
    artifactNotes?: Record<string, string>;
  }): Promise<CoordToolResult> {
    const boardDir = this.boardDirForCard(input.parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) return { text: "未找到关联的协调看板", isError: true };
    const sub = board.subcards.find((s) => s.id === input.subcardId);
    if (!sub || sub.canceled) return { text: `子卡 ${input.subcardId} 不存在或已取消`, isError: true };
    if (sub.status === "archived") return { text: `子卡 ${input.subcardId} 已归档`, isError: false };

    // Gate 1: closureEvidence
    const invalidEvidence = this.deps.gates.validateReadyToArchiveEvidence(input.closureEvidence);
    if (invalidEvidence) {
      await this.deps.store.appendCoordEvent(boardDir, {
        kind: "gate.rejected",
        actor: sub.id,
        subcardId: sub.id,
        summary: `子卡 ${sub.id} 结单门禁拦截（闭环证据不充分）`,
        detail: { gate: "evidence" },
      });
      return { text: invalidEvidence, isError: true };
    }

    // Gate 2: Git uncommitted changes (for worktree subcards)
    let gitBranch: string | null = sub.gitBranch;
    let commitSha: string | null = sub.commitSha;
    const liveCwd = input.callerAgent.cwd ?? "";
    if (sub.isolation === "worktree" && liveCwd) {
      const scopeKey = input.callerAgent.workspaceId ?? input.callerAgent.id;
      const baseline = await this.deps.gates.getGitBaselineForScope(scopeKey);
      const dirty = await this.deps.gates.findUncommittedSessionChanges(
        liveCwd,
        baseline,
        input.closureEvidence,
      );
      if (dirty) {
        const preview = dirty.dirtyFiles.slice(0, 6).join(", ");
        const more = dirty.dirtyFiles.length > 6 ? ` 等 ${dirty.dirtyFiles.length} 个文件` : "";
        await this.deps.store.appendCoordEvent(boardDir, {
          kind: "gate.rejected",
          actor: sub.id,
          subcardId: sub.id,
          summary: `子卡 ${sub.id} 结单门禁拦截（存在未提交 Git 改动）`,
          detail: { gate: "uncommitted_git", dirtyFiles: dirty.dirtyFiles.slice(0, 10) },
        });
        return {
          text:
            `拒绝完结子卡 ${sub.id}：当前 Worktree（分支 ${dirty.branch}）仍有未提交改动（${preview}${more}）。` +
            "请先在子卡分支完成 git commit（严禁添加工具署名或 Co-Authored-By），再重新调用 radar_complete_subcard。",
          isError: true,
        };
      }
      const gitInfo = await this.deps.gates.captureGitBranchAndSha(liveCwd);
      if (gitInfo.branch) gitBranch = gitInfo.branch;
      if (gitInfo.sha) commitSha = gitInfo.sha;
    }

    // Gate 3: Objective verifyCommand
    if (sub.verifyCommand && sub.verifyCommand.trim()) {
      const cwdToRun = liveCwd || this.deps.waitChecksDir();
      const verifyRes = await this.deps.gates.execShellCommand(
        sub.verifyCommand.trim(),
        cwdToRun,
        120_000,
      );
      if (!verifyRes.ok) {
        const tail = `${verifyRes.stdout}\n${verifyRes.stderr}`.trim().slice(-600);
        await this.deps.store.appendCoordEvent(boardDir, {
          kind: "gate.rejected",
          actor: sub.id,
          subcardId: sub.id,
          summary: `子卡 ${sub.id} 验收命令失败`,
          detail: { gate: "verify_failed", command: sub.verifyCommand.trim() },
        });
        return {
          text: `拒绝完结子卡 ${sub.id}：客观验收命令 \`${sub.verifyCommand.trim()}\` 未通过：\n${tail}\n请修复后重新运行并调用 radar_complete_subcard。`,
          isError: true,
        };
      }
    }

    // Refresh artifact manifest for this subcard
    const subDirRel = join("cards", this.deps.store.sanitizeSubcardDirName(sub.id));
    const artifacts = await this.deps.store.scanDirectoryArtifacts(
      boardDir,
      subDirRel,
      input.artifactNotes,
    );

    const nowIso = new Date().toISOString();
    const cleanEvidence = input.closureEvidence.trim();

    if (sub.requireReview) {
      await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
        const target = b.subcards.find((s) => s.id === sub.id);
        if (!target) return;
        target.status = "needs_me";
        target.needsMeTag = "ready_to_archive";
        target.closureEvidence = cleanEvidence;
        target.gitBranch = gitBranch;
        target.commitSha = commitSha;
        target.artifacts = artifacts;
        target.updatedAt = nowIso;
      });
      const ev = await this.deps.store.appendCoordEvent(boardDir, {
        kind: "escalated.coordinator",
        actor: sub.id,
        subcardId: sub.id,
        summary: `子卡 ${sub.id} 已过门禁，等待协调者复核验收（requireReview=true）`,
        detail: { artifacts: artifacts.length, gitBranch, commitSha },
      });
      await this.enqueueCoordinatorWakeup(input.parentCardId, ev, { urgent: true });
      return {
        text: `子卡 ${sub.id} 已通过门禁校验；因设置了 requireReview=true，已提交给协调者验收。`,
      };
    }

    // Self-archive! (Archive subcard agent, KEEP worktree branch for downstream merge)
    let scheduleToDelete: string | null = null;
    let scriptToDelete: string | null = null;
    let durationMs: number | null = null;

    await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
      const target = b.subcards.find((s) => s.id === sub.id);
      if (!target) return;
      scheduleToDelete = target.waitScheduleId;
      scriptToDelete = target.waitScriptPath;
      if (target.startedAt) {
        const ms = Date.parse(nowIso) - Date.parse(target.startedAt);
        if (Number.isFinite(ms) && ms >= 0) durationMs = ms;
      }
      target.status = "archived";
      target.needsMeTag = null;
      target.decisionProposal = null;
      target.waitMode = null;
      target.waitBoard = null;
      target.waitCondition = null;
      target.waitCron = null;
      target.waitScheduleId = null;
      target.waitScriptPath = null;
      target.waitTimeoutAt = null;
      target.closureEvidence = cleanEvidence;
      target.gitBranch = gitBranch;
      target.commitSha = commitSha;
      target.artifacts = artifacts;
      target.finishedAt = nowIso;
      target.updatedAt = nowIso;
    });

    await Promise.all([
      this.deps.radar.deleteWaitSchedule(scheduleToDelete),
      this.deps.radar.deleteWaitScript(scriptToDelete),
      sub.boundAgentId ? this.deps.radar.archiveAgent(sub.boundAgentId).catch(() => {}) : Promise.resolve(),
    ]);

    const archivedEvent = await this.deps.store.appendCoordEvent(boardDir, {
      kind: "subcard.archived",
      actor: sub.id,
      subcardId: sub.id,
      summary: `子卡 ${sub.id} 已自主归档：${truncateOneLine(cleanEvidence, 80)}`,
      detail: {
        durationMs,
        gitBranch,
        commitSha,
        artifactCount: artifacts.length,
      },
    });

    const { triggeredCount, escalatedCount } = await this.evaluateInnerBoardWatchers(
      input.parentCardId,
      sub.id,
      archivedEvent.id,
    );

    if (escalatedCount === 0) {
      await this.maybeNotifyCoordinatorAfterSubcardChange(
        input.parentCardId,
        archivedEvent,
        triggeredCount,
      );
    }

    return {
      text: `子卡 ${sub.id} 已通过门禁校验并自主归档（产物 ${artifacts.length} 个${triggeredCount > 0 ? `，已自动触发 ${triggeredCount} 个下游` : ""}）。`,
    };
  }

  async setSubcardNeedsMeTag(input: {
    parentCardId: string;
    subcardId: string;
    callerAgentId: string;
    tag: NeedsMeTag;
    title?: string;
    target?: string;
    impact?: string;
    draft?: string;
  }): Promise<CoordToolResult> {
    if (input.tag === "ready_to_archive") {
      return {
        text: "子卡结单归档请调用 `radar_complete_subcard`（会自动校验门禁、保留分支并触发下游），勿用 radar_set_needs_me_tag。",
        isError: true,
      };
    }

    const boardDir = this.boardDirForCard(input.parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    const sub = board?.subcards.find((s) => s.id === input.subcardId && !s.canceled);
    if (!sub) return { text: `未找到子卡 ${input.subcardId}`, isError: true };

    const nowIso = new Date().toISOString();
    const cleanField = (v: string | undefined) => {
      const t = v?.trim();
      return t ? t : null;
    };
    const cleanDraft = input.draft?.trim() ? input.draft.replace(/\r\n/g, "\n") : null;
    const title = cleanField(input.title);
    const target = cleanField(input.target);
    const impact = cleanField(input.impact);
    const proposal: DecisionProposal | null =
      input.tag === "decision" && (title || target || impact || cleanDraft)
        ? {
            title,
            target,
            impact,
            draft: cleanDraft,
            agentId: input.callerAgentId,
            updatedAt: nowIso,
          }
        : null;

    let oldSchedule: string | null = null;
    let oldScript: string | null = null;
    await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
      const card = b.subcards.find((s) => s.id === input.subcardId);
      if (!card) return;
      oldSchedule = card.waitScheduleId;
      oldScript = card.waitScriptPath;
      card.status = "needs_me";
      card.needsMeTag = input.tag;
      card.decisionProposal = proposal;
      card.waitMode = null;
      card.waitBoard = null;
      card.waitCondition = null;
      card.waitScheduleId = null;
      card.waitScriptPath = null;
      card.waitCron = null;
      card.waitTimeoutAt = null;
      card.updatedAt = nowIso;
    });

    await Promise.all([
      this.deps.radar.deleteWaitSchedule(oldSchedule),
      this.deps.radar.deleteWaitScript(oldScript),
    ]);

    const ev = await this.deps.store.appendCoordEvent(boardDir, {
      kind: "escalated.coordinator",
      actor: sub.id,
      subcardId: sub.id,
      summary: `子卡 ${sub.id} 标记为 ${input.tag}${title ? `（${title}）` : ""}，请求协调者处理`,
      detail: { tag: input.tag, title },
    });

    await this.enqueueCoordinatorWakeup(input.parentCardId, ev, { urgent: true });
    return {
      text: `已将子卡 ${sub.id} 标记为 ${input.tag} 并通知主协调者，请等待协调者回复。`,
    };
  }

  async attachSubcardLinks(input: {
    parentCardId: string;
    subcardId: string;
    links: RadarLinkInput[];
  }): Promise<CoordToolResult> {
    const added = this.deps.gates.mergeAttachedLinks(input.links);
    if (input.links.length > 0 && added.length === 0) {
      return { text: "请提供以 http:// 或 https:// 开头的完整链接", isError: true };
    }
    const boardDir = this.boardDirForCard(input.parentCardId);
    const nowIso = new Date().toISOString();
    let found = false;
    await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
      const sub = b.subcards.find((s) => s.id === input.subcardId);
      if (!sub) return;
      found = true;
      sub.links = this.deps.gates.mergeAttachedLinks(added, sub.links);
      sub.updatedAt = nowIso;
    });
    if (!found) return { text: `未找到子卡 ${input.subcardId}`, isError: true };
    return {
      text: `已为子卡 ${input.subcardId} 挂载链接：${added.map((l) => `${l.label} (${l.url})`).join("、")}`,
    };
  }

  async enterSubcardWaiting(input: {
    parentCardId: string;
    subcardId: string;
    callerAgentId: string;
    mode: WaitMode;
    condition?: string;
    cron?: string;
    maxTimeout?: string;
    script?: string;
    checkPrompt?: string;
    watch?: {
      targets: Array<{ cardId: string; status?: CardStatus; needsMeTag?: NeedsMeTag | null }>;
      match?: "all" | "any";
    };
  }): Promise<CoordToolResult> {
    const boardDir = this.boardDirForCard(input.parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    const sub = board?.subcards.find((s) => s.id === input.subcardId && !s.canceled);
    if (!board || !sub) {
      return { text: `未找到子卡 ${input.subcardId}`, isError: true };
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (input.mode === "board") {
      if (!input.watch || input.watch.targets.length === 0) {
        return { text: "mode=\"board\" 时必须提供至少一个 watch.targets", isError: true };
      }
      const spec: BoardWatchSpec = {
        scope: "inner",
        parentCardId: input.parentCardId,
        targets: input.watch.targets.map((t) => ({
          cardId: t.cardId.trim(),
          status: t.status ?? "archived",
          ...(t.needsMeTag !== undefined ? { needsMeTag: t.needsMeTag } : {}),
        })),
        match: input.watch.match ?? "all",
        wakeOnException: true,
      };
      const edges = this.subcardWaitEdgeMap(board.subcards);
      const cycle = this.deps.graph.detectBoardWatchCycle(
        edges,
        sub.id,
        spec.targets.map((t) => t.cardId),
      );
      if (cycle) {
        return {
          text: `拒绝注册看板等待：检测到循环等待 (${cycle.join(" → ")})`,
          isError: true,
        };
      }

      const lookup = this.lookupSubcardWatchMap(board.subcards);
      const evalRes = this.deps.graph.evaluateBoardWatch(spec, lookup);
      if (evalRes.state === "broken") {
        return {
          text: `无法注册看板等待：目标不存在或已取消 (${evalRes.brokenIds.join(", ")})`,
          isError: true,
        };
      }
      if (evalRes.state === "satisfied") {
        const manifests = this.buildUpstreamManifests(board, evalRes.matchedIds);
        const manifestText = manifests
          .map((m) => `- ${m.id}「${m.title}」[${m.status}] ${m.closureEvidence ?? ""}`.trim())
          .join("\n");
        return {
          text: `所监听的看板条件已满足，无需挂起，请直接继续推进：\n${manifestText}`,
        };
      }

      const conditionLabel = input.condition?.trim() || formatWatchConditionLabel(spec);
      let timeoutAt: string | null = null;
      let maxTimeoutLabel: string | null = null;
      if (input.maxTimeout?.trim()) {
        const ms = this.deps.waitUtils.parseMaxTimeoutMs(input.maxTimeout.trim());
        if (ms === null) {
          return { text: `maxTimeout "${input.maxTimeout}" 格式无效`, isError: true };
        }
        timeoutAt = new Date(nowMs + ms).toISOString();
        maxTimeoutLabel = input.maxTimeout.trim();
      }

      await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
        const card = b.subcards.find((s) => s.id === sub.id);
        if (!card) return;
        card.status = "waiting_external";
        card.needsMeTag = null;
        card.waitMode = "board";
        card.waitBoard = spec;
        card.waitCondition = conditionLabel;
        card.waitCron = null;
        card.waitScheduleId = null;
        card.waitScriptPath = null;
        card.waitStartedAt = nowIso;
        card.waitTimeoutAt = timeoutAt;
        card.waitMaxTimeoutLabel = maxTimeoutLabel;
        card.waitCheckNote = null;
        card.updatedAt = nowIso;
      });

      await this.deps.store.appendCoordEvent(boardDir, {
        kind: "wait.registered",
        actor: sub.id,
        subcardId: sub.id,
        summary: `${sub.id} 进入看板等待：${conditionLabel}`,
      });

      return {
        text: `子卡 ${sub.id} 已进入看板等待（${conditionLabel}），满足条件后将自动唤醒本会话。`,
      };
    }

    // Script or AI external wait for subcard
    const condition = input.condition?.trim() ?? "";
    const cron = input.cron?.trim() ?? "";
    const maxTimeoutRaw = input.maxTimeout?.trim() ?? "";
    if (!condition || !cron || !maxTimeoutRaw) {
      return { text: "script/ai 模式下 condition、cron 与 maxTimeout 均为必填项", isError: true };
    }
    if (!this.deps.waitUtils.parseCron5(cron)) {
      return { text: `cron 表达式 "${cron}" 不合法`, isError: true };
    }
    const timeoutMs = this.deps.waitUtils.parseMaxTimeoutMs(maxTimeoutRaw);
    if (timeoutMs === null) {
      return { text: `maxTimeout "${maxTimeoutRaw}" 格式无效或超出范围 (1m ~ 30d)`, isError: true };
    }

    const tz = this.deps.waitUtils.resolveEffectiveTimeZone(await this.deps.radar.getEffectiveTimezone());
    const timeoutAt = new Date(nowMs + timeoutMs).toISOString();
    const compositeKey = encodeSubcardWaitKey(input.parentCardId, sub.id);
    let newScriptPath: string | null = null;
    let newScheduleId: string | null = null;

    if (input.mode === "script") {
      const scriptBody = input.script?.trim() ?? "";
      if (!scriptBody) {
        return { text: "mode=\"script\" 时必须提供 script 内容", isError: true };
      }
      if (!this.deps.waitUtils.hasWaitPendingExitCode(scriptBody)) {
        return {
          text: "script 脚本中未检测到 `exit 10`（继续等待退出码），请显式使用 `exit 0` 达标、`exit 10` 继续等待。",
          isError: true,
        };
      }
      const safeName = `sub-${this.deps.graph.sanitizeBoardCardId(input.parentCardId)}-${this.deps.store.sanitizeSubcardDirName(sub.id)}`.slice(0, 64);
      newScriptPath = join(this.deps.waitScriptsDir(), `${safeName}-${nowMs.toString(36)}.sh`);
      const content = scriptBody.startsWith("#!")
        ? `${scriptBody}\n`
        : `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`;
      await writeFile(newScriptPath, content, "utf8");
      await chmod(newScriptPath, 0o755);
      this.lastScriptCronSlot.set(compositeKey, this.deps.waitUtils.minuteSlotInTimeZone(tz, nowMs).slotKey);
    } else {
      const checkBody = input.checkPrompt?.trim() ?? "";
      if (!checkBody) {
        return { text: "mode=\"ai\" 时必须提供非空的 checkPrompt", isError: true };
      }
      const evalModels = await this.deps.radar.listWaitEvalModels();
      if (evalModels.length === 0) {
        return { text: "未找到可用的 wait-evaluator 模型，请配置模型或改用 script 模式。", isError: true };
      }
      const fullPrompt = [
        `你是 Paseo Radar 的独立出列评估模型 wait-evaluator（子卡 cardId: "${compositeKey}"，标题：${sub.title}）。`,
        `等待条件：${condition}`,
        "",
        "【严格只读安全约束】",
        "严禁修改任何仓库代码、生产数据、共享单据或文档，严禁对外发送任何消息。",
        "",
        "【具体检查与判定条件】",
        checkBody,
        "",
        "【必做结果上报】",
        `每次检查结束必须调用 radar_report_wait_check，传入 cardId: "${compositeKey}", ready: true/false, note: "一句话结论"。`,
      ].join("\n");

      let lastErr: unknown = null;
      for (const model of evalModels) {
        try {
          const created = await this.deps.radar.createAiWaitSchedule({
            name: `[Radar 子卡等外部] ${sub.id}:${sub.title.slice(0, 22)}`,
            prompt: fullPrompt,
            cron,
            timeoutAt,
            timezone: tz,
            fullModel: model,
          });
          newScheduleId = created.scheduleId;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!newScheduleId) {
        return {
          text: `创建子卡 wait-evaluator 失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
          isError: true,
        };
      }
    }

    let oldScheduleId: string | null = null;
    let oldScriptPath: string | null = null;
    await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
      const card = b.subcards.find((s) => s.id === sub.id);
      if (!card) return;
      oldScheduleId = card.waitScheduleId;
      oldScriptPath = card.waitScriptPath;
      card.status = "waiting_external";
      card.needsMeTag = null;
      card.waitMode = input.mode;
      card.waitBoard = null;
      card.waitCondition = condition;
      card.waitCron = cron;
      card.waitScheduleId = newScheduleId;
      card.waitScriptPath = newScriptPath;
      card.waitStartedAt = nowIso;
      card.waitTimeoutAt = timeoutAt;
      card.waitMaxTimeoutLabel = maxTimeoutRaw;
      card.lastWaitCheckAt = null;
      card.waitCheckNote = null;
      card.waitConsecutiveErrors = 0;
      card.waitNextRetryAt = null;
      card.updatedAt = nowIso;
    });

    if (oldScheduleId && oldScheduleId !== newScheduleId) {
      await this.deps.radar.deleteWaitSchedule(oldScheduleId);
    }
    if (oldScriptPath && oldScriptPath !== newScriptPath) {
      await this.deps.radar.deleteWaitScript(oldScriptPath);
    }

    await this.deps.store.appendCoordEvent(boardDir, {
      kind: "wait.registered",
      actor: sub.id,
      subcardId: sub.id,
      summary: `${sub.id} 注册外部等待 (${input.mode}): ${condition}`,
      detail: { mode: input.mode, cron, maxTimeout: maxTimeoutRaw },
    });

    return {
      text: `已将子卡 ${sub.id} 转为「等待外部」（模式: ${input.mode}，cron: "${cron}"，maxTimeout: ${maxTimeoutRaw}）。条件达成后将直接唤醒本子卡继续执行。`,
    };
  }

  async reportAiWaitCheck(
    parentCardId: string,
    subcardId: string,
    ready: boolean,
    note: string,
  ): Promise<CoordToolResult> {
    const boardDir = this.boardDirForCard(parentCardId);
    const cleanNote = note.trim();
    if (!ready) {
      const nowIso = new Date().toISOString();
      await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
        const sub = b.subcards.find((s) => s.id === subcardId && s.status === "waiting_external");
        if (!sub) return;
        sub.lastWaitCheckAt = nowIso;
        sub.waitCheckNote = cleanNote;
        sub.updatedAt = nowIso;
      });
      await this.deps.store.appendCoordEvent(boardDir, {
        kind: "wait.checked",
        actor: "wait-evaluator",
        subcardId,
        summary: `子卡 ${subcardId} 外部等待检查（继续等待）：${truncateOneLine(cleanNote, 80)}`,
      });
      return { text: `已记录子卡 ${subcardId} 检查结果（继续等待）` };
    }
    await this.wakeSubcardFromWaiting(parentCardId, subcardId, "satisfied", cleanNote);
    return { text: `子卡 ${subcardId} 已满足外部条件，已唤醒原会话继续推进` };
  }

  async tickSubcardWaitMonitors(tz: string, nowMs: number): Promise<void> {
    const parentIds = await this.deps.radar.listEnabledParentCardIds();
    const { slotKey } = this.deps.waitUtils.minuteSlotInTimeZone(tz, nowMs);

    for (const parentCardId of parentIds) {
      const boardDir = this.boardDirForCard(parentCardId);
      const board = await this.deps.store.readCoordBoard(boardDir);
      if (!board || !board.enabled) continue;

      for (const sub of board.subcards) {
        if (sub.canceled || sub.status !== "waiting_external") continue;

        if (sub.waitTimeoutAt) {
          const deadline = Date.parse(sub.waitTimeoutAt);
          if (!Number.isNaN(deadline) && nowMs >= deadline) {
            await this.wakeSubcardFromWaiting(parentCardId, sub.id, "timeout", "已超过设定的 maxTimeout");
            continue;
          }
        }

        if (sub.waitMode === "script" && sub.waitScriptPath && sub.waitCron) {
          const compositeKey = encodeSubcardWaitKey(parentCardId, sub.id);
          if (this.runningScriptChecks.has(compositeKey)) continue;
          if (sub.waitNextRetryAt) {
            const retryAt = Date.parse(sub.waitNextRetryAt);
            if (!Number.isNaN(retryAt)) {
              if (nowMs >= retryAt) {
                this.lastScriptCronSlot.set(compositeKey, slotKey);
                void this.runSingleSubcardScriptWaitCheck(parentCardId, sub.id, sub.waitScriptPath);
              }
              continue;
            }
          }
          if (this.lastScriptCronSlot.get(compositeKey) === slotKey) continue;
          if (sub.lastWaitCheckAt) {
            const lastMs = Date.parse(sub.lastWaitCheckAt);
            if (!Number.isNaN(lastMs) && this.deps.waitUtils.minuteSlotInTimeZone(tz, lastMs).slotKey === slotKey) {
              this.lastScriptCronSlot.set(compositeKey, slotKey);
              continue;
            }
          }
          if (sub.waitStartedAt) {
            const startMs = Date.parse(sub.waitStartedAt);
            if (!Number.isNaN(startMs) && this.deps.waitUtils.minuteSlotInTimeZone(tz, startMs).slotKey === slotKey) {
              this.lastScriptCronSlot.set(compositeKey, slotKey);
              continue;
            }
          }
          if (this.deps.waitUtils.matchesCron5InTimeZone(sub.waitCron, tz, nowMs)) {
            this.lastScriptCronSlot.set(compositeKey, slotKey);
            void this.runSingleSubcardScriptWaitCheck(parentCardId, sub.id, sub.waitScriptPath);
          }
        }
      }
    }
  }

  private async runSingleSubcardScriptWaitCheck(
    parentCardId: string,
    subcardId: string,
    scriptPath: string,
  ): Promise<void> {
    const compositeKey = encodeSubcardWaitKey(parentCardId, subcardId);
    if (this.runningScriptChecks.has(compositeKey)) return;
    this.runningScriptChecks.add(compositeKey);
    try {
      const res = await this.deps.gates.execShellCommand(
        `bash ${JSON.stringify(scriptPath)}`,
        this.deps.waitChecksDir(),
        60_000,
      );
      const stdoutLines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const stderrLines = res.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
      const picked = stdoutLines[stdoutLines.length - 1] ?? stderrLines[stderrLines.length - 1];
      if (res.ok) {
        const lastLine = picked?.slice(0, 180) || "监听脚本返回 0（外部条件已达成）";
        await this.wakeSubcardFromWaiting(parentCardId, subcardId, "satisfied", lastLine);
        return;
      }

      const classification = this.deps.waitUtils.classifyWaitScriptFailure({
        code: res.exitCode,
        killed: res.timedOut,
        stdout: res.stdout,
        stderr: res.stderr,
      });
      const tail =
        classification.kind === "pending"
          ? stdoutLines[stdoutLines.length - 1] || stderrLines[stderrLines.length - 1] || "条件尚未满足"
          : stderrLines[stderrLines.length - 1] ||
            stdoutLines[stdoutLines.length - 1] ||
            (res.timedOut ? "脚本执行超时" : `exit ${String(res.exitCode)}`);

      const boardDir = this.boardDirForCard(parentCardId);
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      if (classification.kind === "pending") {
        await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
          const card = b.subcards.find((s) => s.id === subcardId && s.status === "waiting_external");
          if (!card) return;
          card.lastWaitCheckAt = nowIso;
          card.waitCheckNote = `${tail.slice(0, 150)} (${classification.statusTag})`;
          card.waitConsecutiveErrors = 0;
          card.waitNextRetryAt = null;
          card.updatedAt = nowIso;
        });
      } else {
        let shouldBreak = false;
        let nextErrorCount = 1;
        await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
          const card = b.subcards.find((s) => s.id === subcardId && s.status === "waiting_external");
          if (!card) return;
          nextErrorCount = (card.waitConsecutiveErrors ?? 0) + 1;
          shouldBreak = nextErrorCount >= classification.threshold;
          card.lastWaitCheckAt = nowIso;
          card.waitConsecutiveErrors = nextErrorCount;
          card.waitNextRetryAt = shouldBreak
            ? null
            : new Date(nowMs + this.deps.waitUtils.waitScriptRetryBackoffMs).toISOString();
          card.waitCheckNote = shouldBreak
            ? `[异常熔断 ${nextErrorCount}/${classification.threshold}] ${tail.slice(0, 120)}`
            : `[异常 ${nextErrorCount}/${classification.threshold}] ${tail.slice(0, 120)}`;
          card.updatedAt = nowIso;
        });
        if (shouldBreak) {
          await this.wakeSubcardFromWaiting(
            parentCardId,
            subcardId,
            "script_error",
            `连续 ${nextErrorCount} 次异常（${classification.statusTag}）：${tail.slice(0, 200)}`,
          );
        }
      }
    } finally {
      this.runningScriptChecks.delete(compositeKey);
    }
  }

  async wakeSubcardFromWaiting(
    parentCardId: string,
    subcardId: string,
    reason: "satisfied" | "timeout" | "script_error",
    detail: string,
  ): Promise<boolean> {
    const boardDir = this.boardDirForCard(parentCardId);
    const nowIso = new Date().toISOString();
    let scheduleToDelete: string | null = null;
    let scriptToDelete: string | null = null;
    let boundAgentId: string | null = null;
    let waitMode: WaitMode | null = null;
    let waitCondition = "外部等待条件";
    let transitioned = false;

    await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
      const card = b.subcards.find((s) => s.id === subcardId && s.status === "waiting_external");
      if (!card) return;
      transitioned = true;
      scheduleToDelete = card.waitScheduleId;
      scriptToDelete = card.waitScriptPath;
      boundAgentId = card.boundAgentId;
      waitMode = card.waitMode;
      waitCondition = card.waitCondition || "外部等待条件";
      card.status = boundAgentId ? "running" : "needs_me";
      card.needsMeTag = boundAgentId ? null : "review";
      card.lastWaitCheckAt = nowIso;
      card.waitCheckNote =
        reason === "satisfied"
          ? `条件已达成：${detail}`
          : reason === "script_error"
            ? `脚本异常熔断：${detail}`
            : `已超时：${detail}`;
      card.waitMode = null;
      card.waitBoard = null;
      card.waitScheduleId = null;
      card.waitScriptPath = null;
      card.waitCron = null;
      card.waitStartedAt = null;
      card.waitTimeoutAt = null;
      card.waitMaxTimeoutLabel = null;
      card.waitConsecutiveErrors = null;
      card.waitNextRetryAt = null;
      card.updatedAt = nowIso;
    });

    if (!transitioned) return false;

    this.lastScriptCronSlot.delete(encodeSubcardWaitKey(parentCardId, subcardId));
    await Promise.all([
      this.deps.radar.deleteWaitSchedule(scheduleToDelete),
      this.deps.radar.deleteWaitScript(scriptToDelete),
    ]);

    const ev = await this.deps.store.appendCoordEvent(boardDir, {
      kind: reason === "satisfied" ? "wait.triggered" : "wait.timeout",
      actor: "engine",
      subcardId,
      summary:
        reason === "satisfied"
          ? `子卡 ${subcardId} 外部等待达标（${waitMode ?? "wait"}）：${truncateOneLine(detail, 80)}`
          : `子卡 ${subcardId} 外部等待退出（${reason}）：${truncateOneLine(detail, 80)}`,
    });

    const wakePrompt =
      reason === "satisfied"
        ? [
            "[子卡外部等待条件已达成 · 自动恢复处理]",
            `- 原等待条件：${waitCondition}`,
            `- 达标结果：${detail}`,
            "",
            "请基于当前上下文继续执行；完成后请调用 `radar_complete_subcard` 交卷。",
          ].join("\n")
        : [
            `[子卡外部等待异常退出 (${reason}) · 请排查]`,
            `- 原等待条件：${waitCondition}`,
            `- 详情：${detail}`,
            "",
            "请核查原因：若可修正等待脚本请重新调用 `radar_mark_waiting_external`；若无法继续推进请调用 `radar_set_needs_me_tag(tag=\"review\" | \"decision\")` 上报主协调者。",
          ].join("\n");

    let sentToSubagent = false;
    if (boundAgentId) {
      try {
        await this.deps.radar.sendAgentMessage(boundAgentId, wakePrompt);
        sentToSubagent = true;
      } catch {
        sentToSubagent = false;
      }
    }

    if (!sentToSubagent) {
      await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
        const card = b.subcards.find((s) => s.id === subcardId);
        if (!card) return;
        card.status = "needs_me";
        card.needsMeTag = "review";
        card.updatedAt = new Date().toISOString();
      });
      await this.enqueueCoordinatorWakeup(parentCardId, ev, { urgent: true });
    } else if (reason !== "satisfied") {
      // Let subagent attempt recovery first; if it escalates, coordinator gets notified immediately.
    }

    return true;
  }

  /**
   * Evaluates inner `mode: "board"` watchers inside a coordination board after a subcard changes state.
   * Returns counts of downstream subcards started/woken and urgent coordinator escalations emitted.
   */
  async evaluateInnerBoardWatchers(
    parentCardId: string,
    changedSubcardId: string,
    causedByEventId: string | null,
  ): Promise<{ triggeredCount: number; escalatedCount: number }> {
    const boardDir = this.boardDirForCard(parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board || !board.enabled) return { triggeredCount: 0, escalatedCount: 0 };

    const toStart: Array<{ subcardId: string; triggerNote: string; causedBy: string | null }> = [];
    const toWakeRunning: Array<{
      subcardId: string;
      agentId: string;
      matchedIds: string[];
      causedBy: string | null;
    }> = [];
    const brokenWatchers: Array<{ subcardId: string; brokenIds: string[] }> = [];

    const nowIso = new Date().toISOString();

    await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
      const lookup = this.lookupSubcardWatchMap(b.subcards);
      for (const watcher of b.subcards) {
        if (watcher.canceled) continue;
        if (watcher.status !== "waiting_external" || watcher.waitMode !== "board" || !watcher.waitBoard) {
          continue;
        }
        const watchesTarget = watcher.waitBoard.targets.some((t) => t.cardId === changedSubcardId);
        if (!watchesTarget) continue;

        const res = this.deps.graph.evaluateBoardWatch(watcher.waitBoard, lookup);
        if (res.state === "satisfied") {
          watcher.waitMode = null;
          watcher.waitBoard = null;
          watcher.waitCondition = null;
          watcher.waitStartedAt = null;
          watcher.waitTimeoutAt = null;
          watcher.waitCheckNote = `看板依赖已达成 (${res.matchedIds.join(", ")})`;
          watcher.updatedAt = nowIso;

          if (!watcher.boundAgentId) {
            watcher.status = "pool";
            toStart.push({
              subcardId: watcher.id,
              triggerNote: `前置子卡 (${res.matchedIds.join(", ")}) 已满足条件`,
              causedBy: causedByEventId,
            });
          } else {
            watcher.status = "running";
            toWakeRunning.push({
              subcardId: watcher.id,
              agentId: watcher.boundAgentId,
              matchedIds: res.matchedIds,
              causedBy: causedByEventId,
            });
          }
        } else if (res.state === "broken") {
          watcher.status = "needs_me";
          watcher.needsMeTag = "review";
          watcher.waitMode = null;
          watcher.waitBoard = null;
          watcher.waitCondition = null;
          watcher.waitCheckNote = `前置依赖已取消或失效 (${res.brokenIds.join(", ")})`;
          watcher.updatedAt = nowIso;
          brokenWatchers.push({ subcardId: watcher.id, brokenIds: res.brokenIds });
        }
      }
    });

    let triggered = 0;
    let escalated = 0;

    for (const item of toStart) {
      await this.deps.store.appendCoordEvent(boardDir, {
        kind: "wait.triggered",
        actor: "engine",
        subcardId: item.subcardId,
        causedBy: item.causedBy,
        summary: `看板事件触发启动子卡 ${item.subcardId}（由 ${changedSubcardId} 驱动）`,
      });
      try {
        await this.startSubcard(parentCardId, item.subcardId, item.triggerNote);
        triggered += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const failEv = await this.deps.store.appendCoordEvent(boardDir, {
          kind: "escalated.coordinator",
          actor: "engine",
          subcardId: item.subcardId,
          causedBy: item.causedBy,
          summary: `子卡 ${item.subcardId} 自动启动失败：${msg}`,
        });
        await this.enqueueCoordinatorWakeup(parentCardId, failEv, { urgent: true });
        escalated += 1;
      }
    }

    for (const item of toWakeRunning) {
      const freshBoard = await this.deps.store.readCoordBoard(boardDir);
      const sub = freshBoard?.subcards.find((s) => s.id === item.subcardId);
      const deliveredInboxIds = new Set((sub?.inbox ?? []).map((m) => m.id));
      const manifests = freshBoard
        ? this.buildUpstreamManifests(freshBoard, [...(sub?.refCards ?? []), ...item.matchedIds])
        : [];
      const outputDir = this.deps.store.subcardOutputDirPath(boardDir, item.subcardId);
      const manifestPrompt = this.deps.graph.formatReferenceManifestPrompt({
        boardDir,
        subcardId: item.subcardId,
        subcardOutputDir: outputDir,
        upstreamCards: manifests,
        inboxMessages: sub?.inbox,
      });
      await this.deps.store.appendCoordEvent(boardDir, {
        kind: "wait.triggered",
        actor: "engine",
        subcardId: item.subcardId,
        causedBy: item.causedBy,
        summary: `看板事件唤醒子卡 ${item.subcardId}（${item.matchedIds.join(", ")} 已达成）`,
      });
      try {
        await this.deps.radar.sendAgentMessage(
          item.agentId,
          `[所等待的看板前置条件已达成]\n\n${manifestPrompt}\n\n请基于以上索引按需读取产物并继续执行。`,
        );
        if (deliveredInboxIds.size > 0) {
          await this.deps.store.updateCoordBoard(boardDir, parentCardId, (b) => {
            const card = b.subcards.find((s) => s.id === item.subcardId);
            if (card) {
              card.inbox = card.inbox.filter((m) => !deliveredInboxIds.has(m.id));
            }
          });
        }
        triggered += 1;
      } catch {
        const failEv = await this.deps.store.appendCoordEvent(boardDir, {
          kind: "escalated.coordinator",
          actor: "engine",
          subcardId: item.subcardId,
          summary: `子卡 ${item.subcardId} 唤醒失败，转交协调者处理`,
        });
        await this.enqueueCoordinatorWakeup(parentCardId, failEv, { urgent: true });
        escalated += 1;
      }
    }

    for (const broken of brokenWatchers) {
      const ev = await this.deps.store.appendCoordEvent(boardDir, {
        kind: "escalated.coordinator",
        actor: "engine",
        subcardId: broken.subcardId,
        causedBy: causedByEventId,
        summary: `子卡 ${broken.subcardId} 依赖已取消/失效 (${broken.brokenIds.join(", ")})，需协调者重排`,
      });
      await this.enqueueCoordinatorWakeup(parentCardId, ev, { urgent: true });
      escalated += 1;
    }

    return { triggeredCount: triggered, escalatedCount: escalated };
  }

  private async maybeNotifyCoordinatorAfterSubcardChange(
    parentCardId: string,
    event: CoordEvent,
    downstreamTriggeredCount: number,
  ): Promise<void> {
    const [ctx, board] = await Promise.all([
      this.deps.radar.getParentCardContext(parentCardId),
      this.deps.store.readCoordBoard(this.boardDirForCard(parentCardId)),
    ]);
    if (!ctx || !board || !board.enabled) return;

    const active = board.subcards.filter((s) => !s.canceled);
    const anyRunning = active.some((s) => s.status === "running");
    const anyWaiting = active.some((s) => s.status === "waiting_external");
    const anyNeedsMe = active.some((s) => s.status === "needs_me");

    if (ctx.waitMode === "board" && ctx.waitBoard?.scope === "inner") {
      const lookup = this.lookupSubcardWatchMap(board.subcards);
      const evalRes = this.deps.graph.evaluateBoardWatch(ctx.waitBoard, lookup);
      if (evalRes.state === "satisfied" || evalRes.state === "broken") {
        await this.deps.radar.setParentCoordinationMeta(parentCardId, { clearParentWait: true });
        await this.deps.store.appendCoordEvent(this.boardDirForCard(parentCardId), {
          kind: "wait.triggered",
          actor: "engine",
          causedBy: event.id,
          summary:
            evalRes.state === "satisfied"
              ? `协调者监听条件已达成 (${evalRes.matchedIds.join(", ")})`
              : `协调者监听目标失效 (${evalRes.brokenIds.join(", ")})`,
        });
        await this.enqueueCoordinatorWakeup(parentCardId, event, {
          urgent: evalRes.state === "broken",
        });
      } else if (
        event.subcardId &&
        ctx.waitBoard.targets.some((t) => t.cardId === event.subcardId)
      ) {
        const q = this.pendingWakeEvents.get(parentCardId) ?? [];
        q.push(event);
        this.pendingWakeEvents.set(parentCardId, q);
      }
      return;
    }

    // If downstream subcards were automatically triggered or other active work is in flight, stay silent!
    // Still buffer wave-leaf completions so the final sibling wakes Coordinator with the whole wave's manifest pointers.
    if (downstreamTriggeredCount > 0) {
      return;
    }
    if (anyRunning || anyWaiting) {
      const q = this.pendingWakeEvents.get(parentCardId) ?? [];
      q.push(event);
      this.pendingWakeEvents.set(parentCardId, q);
      return;
    }

    // All active subcards settled (archived / pool / needs_me): wake coordinator (debounced unless needs_me)
    await this.enqueueCoordinatorWakeup(parentCardId, event, { urgent: anyNeedsMe });
  }

  async enqueueCoordinatorWakeup(
    parentCardId: string,
    event: CoordEvent,
    opts: { urgent?: boolean } = {},
  ): Promise<void> {
    const queue = this.pendingWakeEvents.get(parentCardId) ?? [];
    queue.push(event);
    this.pendingWakeEvents.set(parentCardId, queue);

    const existingTimer = this.wakeDebounceTimers.get(parentCardId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.wakeDebounceTimers.delete(parentCardId);
    }

    if (opts.urgent || this.debounceMs <= 0) {
      await this.flushCoordinatorWakeup(parentCardId);
      return;
    }

    const timer = setTimeout(() => {
      this.wakeDebounceTimers.delete(parentCardId);
      void this.flushCoordinatorWakeup(parentCardId).catch((err) => {
        console.warn(`[paseo-radar] flushCoordinatorWakeup failed for ${parentCardId}:`, err);
      });
    }, this.debounceMs);
    this.wakeDebounceTimers.set(parentCardId, timer);
  }

  async onCoordinatorTurnAfter(parentCardId: string): Promise<void> {
    if (!this.pendingWakeEvents.has(parentCardId)) return;
    const queue = this.pendingWakeEvents.get(parentCardId) ?? [];
    if (queue.length === 0) return;
    const existingTimer = this.wakeDebounceTimers.get(parentCardId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.wakeDebounceTimers.delete(parentCardId);
    }
    await this.flushCoordinatorWakeup(parentCardId, { skipRunningCheck: true });
  }

  async flushCoordinatorWakeup(
    parentCardId: string,
    opts: { skipRunningCheck?: boolean } = {},
  ): Promise<boolean> {
    const events = this.pendingWakeEvents.get(parentCardId);
    if (!events || events.length === 0) return false;

    const ctx = await this.deps.radar.getParentCardContext(parentCardId);
    if (!ctx || !ctx.coordinationEnabled) {
      this.pendingWakeEvents.delete(parentCardId);
      return false;
    }

    const boardDir = this.boardDirForCard(parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board || !board.enabled) {
      this.pendingWakeEvents.delete(parentCardId);
      return false;
    }

    const coordAgentId = board.coordinatorAgentId ?? ctx.boundAgentId;
    if (coordAgentId && !opts.skipRunningCheck) {
      const live = await this.deps.radar.getAgentSnapshot(coordAgentId).catch(() => null);
      if (live && (live.status === "running" || live.status === "initializing")) {
        // Hold buffered events until coordinator finishes current turn!
        return false;
      }
    }

    const drained = [...events];
    this.pendingWakeEvents.delete(parentCardId);

    if (ctx.waitMode === "board") {
      await this.deps.radar.setParentCoordinationMeta(parentCardId, { clearParentWait: true });
    }

    const eventCount = await this.deps.store.countCoordEvents(boardDir);
    const summary = this.deps.graph.computeCoordinationSummary(board, eventCount);

    const touchedSubIds = [...new Set(drained.map((e) => e.subcardId).filter((x): x is string => Boolean(x)))];
    const manifests = this.buildUpstreamManifests(board, touchedSubIds);

    const lines: string[] = [
      `[Radar 协调模式汇总回调 · 进度 ${summary.archived}/${summary.total}（运行 ${summary.running} · 待协调 ${summary.needsCoordinator} · 等外部 ${summary.waitingExternal} · 等前置 ${summary.waitingBoard}）]`,
      "",
      "## 新增事件",
      ...drained.map((e) => `- [${e.kind}] ${e.summary}`),
    ];

    if (manifests.length > 0) {
      lines.push("", "## 相关子卡状态与产物指针（按需读取，切勿直接搬运大段正文）");
      for (const m of manifests) {
        lines.push(`- ${m.id}「${m.title}」[${m.status}]`);
        if (m.closureEvidence) lines.push(`  结论：${truncateOneLine(m.closureEvidence, 180)}`);
        if (m.gitBranch) lines.push(`  分支：${m.gitBranch}${m.commitSha ? ` (${m.commitSha})` : ""}`);
        if (m.artifacts.length > 0) {
          for (const a of m.artifacts.slice(0, 8)) {
            lines.push(`  · ${a.absolutePath} (${a.sizeBytes}B)${a.note ? ` — ${a.note}` : ""}`);
          }
        }
      }
    }

    lines.push(
      "",
      "## 协调者下一步",
      summary.needsCoordinator > 0
        ? "- 存在停在 `needs_me` 的子卡：内部决策请调 `radar_coord_manage` 回复放行；涉及外发/生产数据/产品决策请调 `radar_set_needs_me_tag(tag=\"decision\", ...)` 升级给人类。"
        : summary.total > 0 && summary.archived === summary.total
          ? "- 所有非取消子卡均已归档！若整体目标已达成，请核验后总结结论并调用 `radar_set_needs_me_tag(tag=\"ready_to_archive\", closureEvidence=...)`。"
          : "- 请依据最新状态调用 `radar_coord_plan` 展开下一波子卡，或调用 `radar_mark_waiting_external(mode=\"board\", ...)` 继续监听后续节点。",
    );

    const sent = await this.deps.radar.sendCoordinatorPrompt(
      parentCardId,
      coordAgentId,
      lines.join("\n"),
    );
    return sent;
  }

  async inspectSubcardBoard(input: {
    parentCardId: string;
    action: "board" | "get_card";
    targetSubcardId?: string;
  }): Promise<CoordToolResult> {
    const boardDir = this.boardDirForCard(input.parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) return { text: "未找到当前协调看板", isError: true };

    if (input.action === "get_card") {
      const id = input.targetSubcardId?.trim();
      const sub = id ? board.subcards.find((s) => s.id === id) : undefined;
      if (!sub) return { text: `未找到子卡 ${id ?? ""}`, isError: true };
      return {
        text: JSON.stringify(
          {
            id: sub.id,
            wave: sub.wave,
            title: sub.title,
            objective: sub.objective,
            isolation: sub.isolation,
            selectedModel: sub.selectedModel,
            status: sub.status,
            needsMeTag: sub.needsMeTag,
            canceled: sub.canceled,
            waitCondition: sub.waitCondition,
            gitBranch: sub.gitBranch,
            commitSha: sub.commitSha,
            links: sub.links,
            closureEvidence: sub.closureEvidence,
            artifacts: sub.artifacts.map((a) => ({
              relativePath: a.relativePath,
              absolutePath: a.absolutePath,
              sizeBytes: a.sizeBytes,
              note: a.note,
            })),
          },
          null,
          2,
        ),
      };
    }

    const [eventCount, sharedFiles] = await Promise.all([
      this.deps.store.countCoordEvents(boardDir),
      this.deps.store.scanDirectoryArtifacts(boardDir, "shared"),
    ]);
    return {
      text: JSON.stringify(
        {
          boardDir,
          summary: this.deps.graph.computeCoordinationSummary(board, eventCount),
          sharedFiles: sharedFiles.map((f) => ({
            relativePath: f.relativePath,
            absolutePath: f.absolutePath,
            sizeBytes: f.sizeBytes,
          })),
          subcards: board.subcards.map((s) => ({
            id: s.id,
            wave: s.wave,
            title: s.title,
            isolation: s.isolation,
            selectedModel: s.selectedModel,
            status: s.status,
            needsMeTag: s.needsMeTag,
            canceled: s.canceled,
            waitCondition: s.waitCondition,
            gitBranch: s.gitBranch,
            commitSha: s.commitSha,
            artifactCount: s.artifacts.length,
          })),
        },
        null,
        2,
      ),
    };
  }

  async messagePeer(input: {
    parentCardId: string;
    fromSubcardId: string;
    toSubcardId: string;
    kind: "question" | "notify";
    message: string;
  }): Promise<CoordToolResult> {
    const fromId = input.fromSubcardId.trim();
    const toId = input.toSubcardId.trim();
    if (!toId || fromId === toId) {
      return { text: "目标兄弟子卡 ID 无效或不能给自己发消息", isError: true };
    }
    const cleanMsg = input.message.trim();
    if (!cleanMsg) return { text: "消息内容不能为空", isError: true };

    const boardDir = this.boardDirForCard(input.parentCardId);
    let rejection: string | null = null;
    let deliveryTargetAgentId: string | null = null;
    let deliveryTargetSelectedModel: string | null = null;
    let deliveryImmediate = false;
    let roundAfter = 0;

    const nowIso = new Date().toISOString();

    await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
      const fromCard = b.subcards.find((s) => s.id === fromId && !s.canceled);
      const toCard = b.subcards.find((s) => s.id === toId && !s.canceled);
      if (!fromCard || !toCard) {
        rejection = `未找到目标子卡 ${toId}（或已取消）`;
        return;
      }
      if (toCard.status === "archived") {
        rejection = `子卡 ${toId} 已归档，无法继续发 P2P 消息；请用 subradar_inspect 直接查看其产物清单。`;
        return;
      }
      const currentRounds = Math.max(
        fromCard.p2pRoundsByPeer[toId] ?? 0,
        toCard.p2pRoundsByPeer[fromId] ?? 0,
      );
      if (currentRounds >= this.maxP2pRounds) {
        rejection =
          `与子卡 ${toId} 的点对点协商已达上限（${this.maxP2pRounds} 轮）。为防止死循环，请调用 radar_set_needs_me_tag(tag="decision") 升级给协调者裁决。`;
        return;
      }

      roundAfter = currentRounds + 1;
      fromCard.p2pRoundsByPeer[toId] = roundAfter;
      toCard.p2pRoundsByPeer[fromId] = roundAfter;

      if (toCard.boundAgentId && (toCard.status === "running" || toCard.status === "needs_me")) {
        deliveryTargetAgentId = toCard.boundAgentId;
        deliveryTargetSelectedModel = toCard.selectedModel;
        deliveryImmediate = true;
      } else {
        toCard.inbox.push({
          id: `msg-${randomUUID().slice(0, 8)}`,
          from: fromId,
          kind: input.kind,
          message: cleanMsg,
          at: nowIso,
        });
      }
      fromCard.updatedAt = nowIso;
      toCard.updatedAt = nowIso;
    });

    if (rejection) return { text: rejection, isError: true };

    if (deliveryImmediate && deliveryTargetAgentId) {
      const piHint = isPiProvider(deliveryTargetSelectedModel)
        ? "（`codemode` 下可用 `await tools.mcp__paseo__subradar_message_peer(...)`）"
        : "";
      const steerText =
        `[兄弟子卡 P2P 消息 (${input.kind} · 第 ${roundAfter}/${this.maxP2pRounds} 轮) · 来自 ${fromId}]\n` +
        `${cleanMsg}\n\n` +
        `如需回复请调用 \`subradar_message_peer(toSubcardId="${fromId}", ...)\`${piHint}；如遇方案冲突请调 \`radar_set_needs_me_tag(tag="decision")\` 升级协调者。`;
      try {
        await this.deps.radar.sendAgentMessage(deliveryTargetAgentId, steerText);
      } catch {
        // Fallback to inbox if live send failed
        deliveryImmediate = false;
        await this.deps.store.updateCoordBoard(boardDir, input.parentCardId, (b) => {
          const toCard = b.subcards.find((s) => s.id === toId);
          toCard?.inbox.push({
            id: `msg-${randomUUID().slice(0, 8)}`,
            from: fromId,
            kind: input.kind,
            message: cleanMsg,
            at: nowIso,
          });
        });
      }
    }

    await this.deps.store.appendCoordEvent(boardDir, {
      kind: "peer.message",
      actor: fromId,
      subcardId: toId,
      summary: `${fromId} → ${toId} [${input.kind} ${roundAfter}/${this.maxP2pRounds}]: ${truncateOneLine(cleanMsg, 80)}`,
      detail: { from: fromId, to: toId, kind: input.kind, round: roundAfter, immediate: deliveryImmediate },
    });

    return {
      text: deliveryImmediate
        ? `已实时投递给子卡 ${toId}（第 ${roundAfter}/${this.maxP2pRounds} 轮）`
        : `子卡 ${toId} 暂未启动或正等待中，消息已存入其 Inbox（第 ${roundAfter}/${this.maxP2pRounds} 轮），启动/唤醒时将自动附带。`,
    };
  }

  async coordinatorManage(input: {
    parentCardId: string;
    action: "models" | "list" | "get_card" | "start" | "reply" | "archive" | "events";
    subcardId?: string;
    text?: string;
    limit?: number;
  }): Promise<CoordToolResult> {
    if (input.action === "models") {
      const m = await this.deps.radar.getDefaultWorkerModel();
      return {
        text: JSON.stringify(
          {
            defaultWorkerModel: m.defaultModel,
            assignableModels: m.assignable.map((entry) => ({
              id: entry.id ?? null,
              name: entry.name ?? null,
              model: entry.model,
              description: entry.description ?? "",
            })),
            extraProfiles: m.extraProfiles ?? [],
          },
          null,
          2,
        ),
      };
    }
    if (input.action === "list") {
      return this.inspectSubcardBoard({ parentCardId: input.parentCardId, action: "board" });
    }
    if (input.action === "get_card") {
      return this.inspectSubcardBoard({
        parentCardId: input.parentCardId,
        action: "get_card",
        targetSubcardId: input.subcardId,
      });
    }
    const boardDir = this.boardDirForCard(input.parentCardId);
    if (input.action === "events") {
      const res = await this.deps.store.readCoordEvents(boardDir, input.limit ?? 40);
      return { text: JSON.stringify(res, null, 2) };
    }
    const subId = input.subcardId?.trim();
    if (!subId) return { text: "必须指定 subcardId", isError: true };

    if (input.action === "start") {
      const started = await this.startSubcard(input.parentCardId, subId, input.text);
      return { text: `已启动子卡 ${subId} (agentId: ${started.agentId})` };
    }
    if (input.action === "reply") {
      if (!input.text?.trim()) return { text: "reply 必须传入回复内容 text", isError: true };
      const detail = await this.handleSubcardAction({
        cardId: input.parentCardId,
        subcardId: subId,
        action: "reply",
        text: input.text,
        actor: "coordinator",
      });
      return { text: `已回复子卡 ${subId}，当前进度 ${detail.summary.archived}/${detail.summary.total}` };
    }
    if (input.action === "archive") {
      const detail = await this.handleSubcardAction({
        cardId: input.parentCardId,
        subcardId: subId,
        action: "archive",
        text: input.text,
        actor: "coordinator",
      });
      return { text: `已验收归档子卡 ${subId}，当前进度 ${detail.summary.archived}/${detail.summary.total}` };
    }
    return { text: `不支持的操作 ${input.action}`, isError: true };
  }

  async handleSubcardAction(input: {
    cardId: string;
    subcardId: string;
    action: "start" | "reply" | "archive" | "cancel";
    text?: string;
    actor?: "human" | "coordinator";
  }): Promise<CoordBoardDetail> {
    const actor = input.actor ?? "human";
    const boardDir = this.boardDirForCard(input.cardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) throw new Error(`未找到卡片 ${input.cardId} 的协调看板`);
    const sub = board.subcards.find((s) => s.id === input.subcardId);
    if (!sub) throw new Error(`未找到子卡 ${input.subcardId}`);

    if (input.action === "start") {
      await this.startSubcard(input.cardId, input.subcardId, input.text);
    } else if (input.action === "reply") {
      const replyText = input.text?.trim();
      if (!replyText) throw new Error("回复内容不能为空");
      const nowIso = new Date().toISOString();
      if (sub.boundAgentId) {
        await this.deps.store.updateCoordBoard(boardDir, input.cardId, (b) => {
          const c = b.subcards.find((s) => s.id === input.subcardId);
          if (!c) return;
          c.status = "running";
          c.needsMeTag = null;
          c.decisionProposal = null;
          c.updatedAt = nowIso;
        });
        await this.deps.radar.sendAgentMessage(
          sub.boundAgentId,
          `[${actor === "coordinator" ? "主协调者裁决回复" : "人工指令回复"}]\n${replyText}`,
        );
      } else {
        await this.deps.store.updateCoordBoard(boardDir, input.cardId, (b) => {
          const c = b.subcards.find((s) => s.id === input.subcardId);
          if (!c) return;
          c.inbox.push({
            id: `msg-${randomUUID().slice(0, 8)}`,
            from: actor,
            kind: "coordinator_reply",
            message: replyText,
            at: nowIso,
          });
          c.needsMeTag = null;
          c.decisionProposal = null;
          c.updatedAt = nowIso;
        });
      }
      await this.deps.store.appendCoordEvent(boardDir, {
        kind: "peer.message",
        actor,
        subcardId: input.subcardId,
        summary: `${actor === "coordinator" ? "协调者" : "人工"}回复子卡 ${input.subcardId}：${truncateOneLine(replyText, 80)}`,
      });
    } else if (input.action === "archive") {
      const nowIso = new Date().toISOString();
      const subDirRel = join("cards", this.deps.store.sanitizeSubcardDirName(sub.id));
      const artifacts = await this.deps.store.scanDirectoryArtifacts(boardDir, subDirRel);
      let sched: string | null = null;
      let script: string | null = null;

      await this.deps.store.updateCoordBoard(boardDir, input.cardId, (b) => {
        const c = b.subcards.find((s) => s.id === input.subcardId);
        if (!c) return;
        sched = c.waitScheduleId;
        script = c.waitScriptPath;
        c.status = "archived";
        c.needsMeTag = null;
        c.decisionProposal = null;
        c.waitMode = null;
        c.waitBoard = null;
        c.waitCondition = null;
        c.waitScheduleId = null;
        c.waitScriptPath = null;
        if (input.text?.trim() && !c.closureEvidence) {
          c.closureEvidence = input.text.trim();
        }
        c.artifacts = artifacts;
        c.finishedAt = nowIso;
        c.updatedAt = nowIso;
      });

      await Promise.all([
        this.deps.radar.deleteWaitSchedule(sched),
        this.deps.radar.deleteWaitScript(script),
        sub.boundAgentId ? this.deps.radar.archiveAgent(sub.boundAgentId).catch(() => {}) : Promise.resolve(),
      ]);

      const ev = await this.deps.store.appendCoordEvent(boardDir, {
        kind: "subcard.archived",
        actor,
        subcardId: sub.id,
        summary: `${actor === "coordinator" ? "协调者验收" : "人工归档"}子卡 ${sub.id}`,
      });
      const { triggeredCount, escalatedCount } = await this.evaluateInnerBoardWatchers(
        input.cardId,
        sub.id,
        ev.id,
      );
      if (actor === "human" && escalatedCount === 0) {
        await this.maybeNotifyCoordinatorAfterSubcardChange(input.cardId, ev, triggeredCount);
      }
    } else if (input.action === "cancel") {
      const nowIso = new Date().toISOString();
      let sched: string | null = null;
      let script: string | null = null;
      await this.deps.store.updateCoordBoard(boardDir, input.cardId, (b) => {
        const c = b.subcards.find((s) => s.id === input.subcardId);
        if (!c) return;
        sched = c.waitScheduleId;
        script = c.waitScriptPath;
        c.canceled = true;
        c.status = "archived";
        c.waitMode = null;
        c.waitBoard = null;
        c.waitCondition = null;
        c.waitScheduleId = null;
        c.waitScriptPath = null;
        c.finishedAt = nowIso;
        c.updatedAt = nowIso;
      });
      await Promise.all([
        this.deps.radar.deleteWaitSchedule(sched),
        this.deps.radar.deleteWaitScript(script),
        sub.boundAgentId ? this.deps.radar.archiveAgent(sub.boundAgentId).catch(() => {}) : Promise.resolve(),
        sub.boundWorkspaceId ? this.deps.radar.archiveWorkspace(sub.boundWorkspaceId).catch(() => {}) : Promise.resolve(),
      ]);
      const ev = await this.deps.store.appendCoordEvent(boardDir, {
        kind: "subcard.canceled",
        actor,
        subcardId: sub.id,
        summary: `${actor === "coordinator" ? "协调者" : "人工"}取消子卡 ${sub.id}`,
      });
      await this.evaluateInnerBoardWatchers(input.cardId, sub.id, ev.id);
    }

    return this.getBoardDetail(input.cardId);
  }

  async getBoardDetail(cardId: string, eventLimit = 150): Promise<CoordBoardDetail> {
    const ctx = await this.deps.radar.getParentCardContext(cardId);
    const boardDir = this.boardDirForCard(cardId);
    const board = (await this.deps.store.readCoordBoard(boardDir)) ?? {
      cardId,
      enabled: Boolean(ctx?.coordinationEnabled),
      enabledAt: null,
      coordinatorAgentId: ctx?.boundAgentId ?? null,
      boardDir,
      subcards: [],
      updatedAt: new Date().toISOString(),
    };
    const [{ events, totalCount }, sharedFiles] = await Promise.all([
      this.deps.store.readCoordEvents(boardDir, eventLimit),
      this.deps.store.scanDirectoryArtifacts(boardDir, "shared"),
    ]);

    return {
      cardId,
      cardTitle: ctx?.title ?? cardId,
      board,
      summary: this.deps.graph.computeCoordinationSummary(board, totalCount),
      waves: this.deps.graph.computeTopologicalWaves(board.subcards),
      events,
      sharedFiles,
    };
  }

  async readArtifact(cardId: string, relativePath: string) {
    const boardDir = this.boardDirForCard(cardId);
    return this.deps.store.readBoardArtifactContent(boardDir, relativePath);
  }

  async lookupSubcardSession(agentId: string): Promise<{
    found: boolean;
    parentCardId: string | null;
    parentCardTitle: string | null;
    coordinatorAgentId: string | null;
    subcardId: string | null;
    subcardTitle: string | null;
    status: CardStatus | null;
    upstreamIds: string[];
    downstreamIds: string[];
    upstreamArtifacts: Array<{
      subcardId: string;
      relativePath: string;
      sizeBytes: number;
      note: string | null;
    }>;
    siblings: Array<{
      id: string;
      title: string;
      status: CardStatus;
      agentId: string | null;
    }>;
  }> {
    const agent = await this.deps.radar.getAgentSnapshot(agentId);
    const parentCardId = agent?.labels["paseo-radar.parent-card"];
    const subcardId = agent?.labels["paseo-radar.subcard"];
    if (!parentCardId || !subcardId) {
      return {
        found: false,
        parentCardId: null,
        parentCardTitle: null,
        coordinatorAgentId: null,
        subcardId: null,
        subcardTitle: null,
        status: null,
        upstreamIds: [],
        downstreamIds: [],
        upstreamArtifacts: [],
        siblings: [],
      };
    }

    const [ctx, board] = await Promise.all([
      this.deps.radar.getParentCardContext(parentCardId),
      this.deps.store.readCoordBoard(this.boardDirForCard(parentCardId)),
    ]);
    const sub = board?.subcards.find((s) => s.id === subcardId);
    if (!board || !sub) {
      return {
        found: false,
        parentCardId: null,
        parentCardTitle: null,
        coordinatorAgentId: null,
        subcardId: null,
        subcardTitle: null,
        status: null,
        upstreamIds: [],
        downstreamIds: [],
        upstreamArtifacts: [],
        siblings: [],
      };
    }

    const upstreamSet = new Set<string>([
      ...sub.refCards,
      ...(sub.waitBoard?.scope === "inner" ? sub.waitBoard.targets.map((t) => t.cardId) : []),
    ]);
    const downstreamIds = board.subcards
      .filter(
        (other) =>
          !other.canceled &&
          other.id !== sub.id &&
          (other.refCards.includes(sub.id) ||
            (other.waitBoard?.scope === "inner" &&
              other.waitBoard.targets.some((t) => t.cardId === sub.id))),
      )
      .map((other) => other.id);

    const upstreamArtifacts: Array<{
      subcardId: string;
      relativePath: string;
      sizeBytes: number;
      note: string | null;
    }> = [];
    for (const upId of upstreamSet) {
      const upCard = board.subcards.find((s) => s.id === upId);
      if (!upCard) continue;
      for (const art of upCard.artifacts) {
        upstreamArtifacts.push({
          subcardId: upCard.id,
          relativePath: art.relativePath,
          sizeBytes: art.sizeBytes,
          note: art.note,
        });
      }
    }

    return {
      found: true,
      parentCardId,
      parentCardTitle: ctx?.title ?? parentCardId,
      coordinatorAgentId: board.coordinatorAgentId ?? ctx?.boundAgentId ?? null,
      subcardId: sub.id,
      subcardTitle: sub.title,
      status: sub.status,
      upstreamIds: [...upstreamSet],
      downstreamIds,
      upstreamArtifacts,
      siblings: board.subcards
        .filter((s) => !s.canceled)
        .map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          agentId: s.boundAgentId,
        })),
    };
  }

  async onSubcardTurnAfter(params: {
    parentCardId: string;
    subcardId: string;
    agentId: string;
    outcomeKind: "completed" | "failed" | "canceled" | undefined;
    errorMessage?: string;
  }): Promise<void> {
    const boardDir = this.boardDirForCard(params.parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) return;
    const sub = board.subcards.find((s) => s.id === params.subcardId && !s.canceled);
    if (!sub || sub.status === "archived" || sub.status === "waiting_external") {
      return;
    }

    const nowIso = new Date().toISOString();
    if (params.outcomeKind === "failed") {
      await this.deps.store.updateCoordBoard(boardDir, params.parentCardId, (b) => {
        const card = b.subcards.find((s) => s.id === sub.id);
        if (!card) return;
        card.status = "needs_me";
        card.needsMeTag = "review";
        card.waitCheckNote = params.errorMessage
          ? `执行异常：${truncateOneLine(params.errorMessage, 140)}`
          : "子卡会话执行失败";
        card.updatedAt = nowIso;
      });
      const ev = await this.deps.store.appendCoordEvent(boardDir, {
        kind: "escalated.coordinator",
        actor: sub.id,
        subcardId: sub.id,
        summary: `子卡 ${sub.id} 执行失败${params.errorMessage ? `：${truncateOneLine(params.errorMessage, 80)}` : ""}`,
      });
      await this.enqueueCoordinatorWakeup(params.parentCardId, ev, { urgent: true });
      return;
    }

    if (sub.status === "running") {
      // Subagent finished turn without calling radar_complete_subcard / waiting / needs_me_tag
      const tail = await this.deps.radar.readAgentTailReply(params.agentId).catch(() => "");
      const excerpt = tail ? truncateOneLine(tail, 160) : "子卡回合结束但未调用结单/状态工具";
      await this.deps.store.updateCoordBoard(boardDir, params.parentCardId, (b) => {
        const card = b.subcards.find((s) => s.id === sub.id);
        if (!card || card.status !== "running") return;
        card.status = "needs_me";
        card.needsMeTag = "review";
        card.waitCheckNote = excerpt;
        card.updatedAt = nowIso;
      });
      const ev = await this.deps.store.appendCoordEvent(boardDir, {
        kind: "escalated.coordinator",
        actor: sub.id,
        subcardId: sub.id,
        summary: `子卡 ${sub.id} 回合结束待协调核查：${truncateOneLine(excerpt, 80)}`,
      });
      await this.enqueueCoordinatorWakeup(params.parentCardId, ev, { urgent: true });
    }
  }

  async cleanupParentBoard(parentCardId: string): Promise<void> {
    const existingTimer = this.wakeDebounceTimers.get(parentCardId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.wakeDebounceTimers.delete(parentCardId);
    }
    this.pendingWakeEvents.delete(parentCardId);

    const boardDir = this.boardDirForCard(parentCardId);
    const board = await this.deps.store.readCoordBoard(boardDir);
    if (!board) return;

    const cleanups: Array<Promise<unknown>> = [];
    for (const sub of board.subcards) {
      this.lastScriptCronSlot.delete(encodeSubcardWaitKey(parentCardId, sub.id));
      cleanups.push(this.deps.radar.deleteWaitSchedule(sub.waitScheduleId));
      cleanups.push(this.deps.radar.deleteWaitScript(sub.waitScriptPath));
      if (sub.boundAgentId) {
        cleanups.push(this.deps.radar.archiveAgent(sub.boundAgentId).catch(() => {}));
      }
      if (sub.boundWorkspaceId) {
        cleanups.push(this.deps.radar.archiveWorkspace(sub.boundWorkspaceId).catch(() => {}));
      }
    }
    await Promise.all(cleanups);
  }
}
