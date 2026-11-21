import { buildKickoffPrompt } from "./kickoff-prompt";
import { compareCards } from "./card-sort";
import {
  buildCoordinatorTools,
  buildCopilotTools,
  buildSubcardTools,
  buildWaitCheckTools,
  buildWorkerTools,
  captureGitDirtySnapshot,
  findUncommittedSessionChanges,
  mergeGitBaseline,
  validateReadyToArchiveEvidence,
} from "./radar-tools";
import {
  computeCoordinationSummary,
  computeTopologicalWaves,
  detectBoardWatchCycle,
  evaluateBoardWatch,
  formatReferenceManifestPrompt,
  sanitizeBoardCardId,
} from "./coordination-graph";
import {
  appendCoordEvent,
  countCoordEvents,
  ensureCoordBoardDirs,
  ensureSubcardOutputDir,
  readBoardArtifactContent,
  readCoordBoard,
  readCoordEvents,
  sanitizeSubcardDirName,
  scanDirectoryArtifacts,
  subcardOutputDirPath,
  updateCoordBoard,
} from "./coordination-store";
import {
  decodeSubcardWaitKey,
  RadarCoordinationEngine,
  type SubcardPlanCreateSpec,
  type SubcardPlanUpdateSpec,
} from "./coordination-engine";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  execCommand,
  type AgentToolDefinition,
  type AgentToolResult,
  type PluginHandlerContext,
  type PluginSettings,
  type PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import {
  DEFAULT_RADAR_SETTINGS,
  radarModelSettings,
  type RadarModelSettings,
} from "../shared/settings";
import {
  discoverAgentProfiles,
  profileToFullModel,
  resolveEffectiveModels,
} from "./llm-oneshot";
import { buildExtendedEnv, resolvePaseoBinary } from "./runtime-env";

import {
  DEFAULT_GOAL_MAX_TURNS,
  isDelegatedSubagentLabels,
  MAX_GOAL_MAX_TURNS,
  RADAR_LABELS,
  type BoardWatchSpec,
  type CardStatus,
  type CoordBoardDetail,
  type CoordinationSummary,
  type CopilotSummary,
  type DecisionProposal,
  type InsightWindow,
  type LinkedWorkspace,
  type NeedsMeTag,
  type ProjectOption,
  type RadarGoal,
  type RadarItem,
  type RadarLink,
  type RadarLinkInput,
  type RadarModelAlert,
  type RadarSnapshot,
  type ResolvedModels,
  type SnoozePreset,
  type WaitMode,
  type WaitPredicate,
} from "../shared/radar";
import {
  createDaemonSchedule,
  deleteDaemonSchedule,
  sendDaemonAgentMessage,
  setLiveAgentModel,
} from "./daemon-ipc";
import {
  extractCanonicalEntityKeys,
  filterLinksByRemovedKeys,
  getLinkDedupeKeys,
  mergeAttachedLinks,
  mergeRadarLinks,
  normalizeCardId,
  resolveItemLinks,
  setsIntersect,
} from "./entity-keys";
import {
  clampAutoNeedsMeTag,
  computeSummarySig,
  extractConversationDigest,
  formatModelErrorMessage,
  synthesizeRadarGoal,
  TurnSummaryQueue,
  type GoalEvalDecision,
  type SummaryCardContext,
  type SummaryEnqueueParams,
  type SummaryEvalResult,
} from "./summarizer";
import {
  checkProviderWaitCondition,
  clearCollectorDiagnosticAlert,
  startDaemonProviders,
  stopDaemonProviders,
  listCollectorScripts,
  runAllCollectors,
  setCollectorDiagnostic,
  testCollectorScript,
} from "./collectors";
import { RadarInsightsManager, recordInsightEvent } from "./insights";
import {
  boardsRootDir,
  buildCoordinatorSystemPrompt,
  computeSnoozeUntil,
  COPILOT_SYSTEM_PROMPT,
  ensureRadarHome,
  isPiProvider,
  itemVisibility,
  readRadarRules,
  readRadarState,
  updateRadarState,
  waitChecksDir,
  waitScriptsDir,
  withCoordinatorSystemPrompt,
  withWorkerSystemPrompt,
  type ItemUserMeta,
  type PersistedCollectorDiag,
  type RawScannedItem,
} from "./store";
import { findMigratedSupersededItems } from "./card-dedup";
import {
  buildClearedNeedsMeTagPatch,
  findMatchingTurnBeforeCards,
  findUserReplyAfterTag,
  shouldSkipBackfillAfterUserClear,
} from "./needs-me-tag";
import { readHumanInteractions } from "./interaction-log";
import { runIncrementalTriage, type ActiveBoardDigestItem } from "./triage";
import {
  classifyWaitScriptFailure,
  hasWaitPendingExitCode,
  matchesCron5InTimeZone,
  minuteSlotInTimeZone,
  parseCron5,
  parseMaxTimeoutMs,
  WAIT_SCRIPT_MAX_CONSECUTIVE_ERRORS,
  resolveEffectiveTimeZone,
  WAIT_SCRIPT_RETRY_BACKOFF_MS,
} from "./wait-utils";

export type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
type PaseoWorkspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const WAIT_MONITOR_INTERVAL_MS = 20 * 1000;
const COPILOT_TITLE = "Radar 助手";
const STYLE_DIRECTIVE =
  "\n\n【行文与安全要求】中文自然、精简、直接给结论与证据，禁止堆砌免责声明（如「不代表…」「不等同于…」）。未经用户确认，严禁修改生产数据或对外发送外部消息。";
function buildTurnEndToolGuide(isPi = false): string {
  const piHint = isPi ? "（在 `codemode` 下调 `tools.mcp__paseo__radar_mark_waiting_external`）" : "";
  return `仅用 \`radar_attach_links\` 登记本卡产物或处理目标的完整 URL。等待可检查条件时，用 \`radar_mark_waiting_external\`${piHint} 托管监听；若停在「待我处理」，用 \`radar_set_needs_me_tag\` 标记待授权 decision（外发附 draft）、待补充 input 或阶段进展 review。整卡已验证闭环且仓库改动已提交时，才可标 ready_to_archive 并附 closureEvidence。`;
}

function isInternalPluginPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.includes("/.paseo/plugin-data/");
}

async function resolveSymbolicGitRef(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execCommand(
      "git",
      ["symbolic-ref", "--quiet", "--short", ref],
      { cwd, timeout: 4000, env: buildExtendedEnv() },
    );
    const trimmed = stdout.trim();
    return trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolveWorktreeBaseCandidates(
  projectPath: string,
  parentCwd?: string | null,
): Promise<string[]> {
  const [parentBranch, originDefaultRef, projectBranch] = await Promise.all([
    parentCwd && parentCwd !== projectPath ? resolveSymbolicGitRef(parentCwd, "HEAD") : Promise.resolve(null),
    resolveSymbolicGitRef(projectPath, "refs/remotes/origin/HEAD"),
    resolveSymbolicGitRef(projectPath, "HEAD"),
  ]);
  return [
    ...new Set(
      [
        parentBranch,
        originDefaultRef,
        projectBranch,
        "origin/main",
        "origin/master",
        "main",
        "master",
      ].filter((x): x is string => Boolean(x) && x !== "HEAD"),
    ),
  ];
}

function isSubcardAgent(agent: PaseoAgent): boolean {
  return Boolean(agent.labels[RADAR_LABELS.subcard]);
}

function isUserConversationAgent(agent: PaseoAgent): boolean {
  if (isSubcardAgent(agent)) return false;
  if (isDelegatedSubagentLabels(agent.labels)) return false;
  const radarRole = agent.labels[RADAR_LABELS.role];
  if (radarRole === RADAR_LABELS.copilotRole || radarRole === RADAR_LABELS.oneshotRole) return false;
  for (const [k, v] of Object.entries(agent.labels)) {
    if (k.endsWith(".role") && k !== RADAR_LABELS.role && v) return false;
  }
  if (isInternalPluginPath(agent.cwd)) return false;
  return true;
}

function resolveLocalWorkspaceCardTitle(
  ws: PaseoWorkspace,
  userAgents: readonly PaseoAgent[],
): string {
  const explicitWsTitle = decodeSafe(ws.title).trim();
  if (explicitWsTitle) return explicitWsTitle;

  const oldestTitled = [...userAgents]
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .map((a) => decodeSafe(a.title).trim())
    .find(Boolean);
  if (oldestTitled) return oldestTitled;

  return decodeSafe(ws.name).trim() || `工作区 ${ws.id.slice(4, 10)}`;
}

function getAgentCardLabel(agent: PaseoAgent): string | null {
  const raw = agent.labels[RADAR_LABELS.card] ?? agent.labels["paseo-radar.item"] ?? null;
  return raw ? normalizeCardId(raw) : null;
}

function decodeSafe(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function formatFullModel(agent: PaseoAgent | null | undefined, fallback = ""): string {
  if (!agent) return fallback;
  const rawModel = agent.runtimeInfo?.model || agent.model;
  if (rawModel) {
    return rawModel.startsWith(`${agent.provider}/`) ? rawModel : `${agent.provider}/${rawModel}`;
  }
  return agent.provider || fallback;
}

function normalizeAgentStatus(status: string | null | undefined): LinkedWorkspace["agentStatus"] {
  if (status === "initializing" || status === "idle" || status === "running" || status === "error" || status === "closed") {
    return status;
  }
  return null;
}

function normalizeStoredStatus(raw: string | null | undefined): CardStatus | null {
  if (!raw) return null;
  if (raw === "done" || raw === "archived") return "archived";
  if (raw === "waiting" || raw === "waiting_external") return "waiting_external";
  if (raw === "needs_me" || raw === "needs_you" || raw === "needs_decision" || raw === "active") return "needs_me";
  if (raw === "pool" || raw === "inbox" || raw === "pending") return "pool";
  return null;
}

function rawItemEntityKeys(raw: RawScannedItem): Set<string> {
  return extractCanonicalEntityKeys({
    cardId: raw.id,
    entityKeys: raw.entityKeys,
    title: raw.title,
    summary: raw.summary,
    url: raw.url,
    secondaryUrl: raw.secondaryUrl,
    links: raw.links,
    relatedKeys: raw.relatedKeys,
    branchHint: raw.existingBranch ?? null,
  });
}

function resolveWaitingMetaKey(
  metaMap: Record<string, ItemUserMeta>,
  requestedId: string,
  expected?: Pick<ItemUserMeta, "waitMode" | "waitStartedAt">,
): string | null {
  // Ignore late results from a replaced monitor, including after a card migration.
  const matches = (meta?: ItemUserMeta) =>
    normalizeStoredStatus(meta?.customStatus) === "waiting_external" &&
    (!expected || (meta?.waitMode === expected.waitMode && meta?.waitStartedAt === expected.waitStartedAt));
  const norm = normalizeCardId(requestedId);
  if (matches(metaMap[norm])) {
    return norm;
  }
  for (const [id, m] of Object.entries(metaMap)) {
    if (matches(m) && m?.migratedFromIds?.includes(norm)) {
      return id;
    }
  }
  return null;
}

function mergeDonorMetaIntoTarget(
  targetMeta: ItemUserMeta | undefined,
  donorMeta: ItemUserMeta,
  donorId: string,
  targetStateHash: string,
): ItemUserMeta {
  const next: ItemUserMeta = { ...targetMeta };
  const donorIsWaiting =
    normalizeStoredStatus(donorMeta.customStatus) === "waiting_external" &&
    Boolean(donorMeta.waitScriptPath || donorMeta.waitScheduleId || donorMeta.waitCondition);
  const targetIsWaiting =
    normalizeStoredStatus(next.customStatus) === "waiting_external" &&
    Boolean(next.waitScriptPath || next.waitScheduleId || next.waitCondition);

  if (donorIsWaiting && !targetIsWaiting) {
    next.customStatus = "waiting_external";
    next.needsMeTag = null;
    next.needsMeTagLocked = false;
    next.needsMeTagAgentId = null;
    next.needsMeTagUpdatedAt = null;
    next.decisionProposal = null;
    next.waitAgentId = donorMeta.waitAgentId ?? donorMeta.boundAgentId ?? null;
    next.waitMode = donorMeta.waitMode ?? null;
    next.waitProviderId = donorMeta.waitProviderId ?? null;
    next.waitPredicate = donorMeta.waitPredicate ?? null;
    next.waitConsecutiveErrors = donorMeta.waitConsecutiveErrors ?? null;
    next.waitNextRetryAt = donorMeta.waitNextRetryAt ?? null;
    next.waitCondition = donorMeta.waitCondition ?? null;
    next.waitBoard = donorMeta.waitBoard ?? null;
    next.waitScheduleId = donorMeta.waitScheduleId ?? null;
    next.waitScriptPath = donorMeta.waitScriptPath ?? null;
    next.waitCron = donorMeta.waitCron ?? null;
    next.waitStartedAt = donorMeta.waitStartedAt ?? null;
    next.waitTimeoutAt = donorMeta.waitTimeoutAt ?? null;
    next.waitMaxTimeoutLabel = donorMeta.waitMaxTimeoutLabel ?? null;
    next.lastWaitCheckAt = donorMeta.lastWaitCheckAt ?? null;
    next.waitCheckNote = donorMeta.waitCheckNote ?? null;
    next.pendingWakePrompt = donorMeta.pendingWakePrompt ?? null;
    next.autoArchivedHash = targetStateHash;
  } else if (
    !next.customStatus &&
    donorMeta.customStatus &&
    normalizeStoredStatus(donorMeta.customStatus) !== "archived"
  ) {
    next.customStatus = donorMeta.customStatus;
  }

  if (!next.boundWorkspaceId && donorMeta.boundWorkspaceId) {
    next.boundWorkspaceId = donorMeta.boundWorkspaceId;
  }
  if (!next.boundAgentId && donorMeta.boundAgentId) {
    next.boundAgentId = donorMeta.boundAgentId;
  }
  if (!next.selectedProjectId && donorMeta.selectedProjectId) {
    next.selectedProjectId = donorMeta.selectedProjectId;
  }
  if (!next.selectedModel && donorMeta.selectedModel) {
    next.selectedModel = donorMeta.selectedModel;
  }
  if (!next.prepSummary && donorMeta.prepSummary) {
    next.prepSummary = donorMeta.prepSummary;
    next.prepSummarySig = donorMeta.prepSummarySig ?? null;
  }
  if (!next.goal && donorMeta.goal) {
    next.goal = donorMeta.goal;
  }
  if (donorMeta.coordinationEnabled && !next.coordinationEnabled) {
    next.coordinationEnabled = true;
  }
  if (donorMeta.subcardWorkspaceIds && donorMeta.subcardWorkspaceIds.length > 0) {
    next.subcardWorkspaceIds = [
      ...new Set([...(next.subcardWorkspaceIds ?? []), ...donorMeta.subcardWorkspaceIds]),
    ];
  }
  if (normalizeStoredStatus(next.customStatus) !== "waiting_external" && !next.needsMeTag && donorMeta.needsMeTag) {
    next.needsMeTag = donorMeta.needsMeTag;
    next.needsMeTagLocked = donorMeta.needsMeTagLocked ?? false;
    next.needsMeTagAgentId =
      donorMeta.needsMeTagAgentId ?? donorMeta.decisionProposal?.agentId ?? donorMeta.boundAgentId ?? null;
    next.needsMeTagUpdatedAt = donorMeta.needsMeTagUpdatedAt ?? null;
    if (donorMeta.needsMeTag === "decision" && !next.decisionProposal && donorMeta.decisionProposal) {
      next.decisionProposal = donorMeta.decisionProposal;
    }
  }
  if (donorMeta.attachedLinks && donorMeta.attachedLinks.length > 0) {
    next.attachedLinks = mergeAttachedLinks(next.attachedLinks, donorMeta.attachedLinks);
  }
  if (donorMeta.extraLinks && donorMeta.extraLinks.length > 0) {
    next.extraLinks = mergeRadarLinks(next.extraLinks, donorMeta.extraLinks);
  }
  if (donorMeta.removedLinkKeys && donorMeta.removedLinkKeys.length > 0) {
    const activeAttachedKeys = new Set<string>();
    for (const lnk of next.attachedLinks ?? []) {
      for (const k of getLinkDedupeKeys(lnk.url)) activeAttachedKeys.add(k);
    }
    next.removedLinkKeys = [
      ...new Set([...(next.removedLinkKeys ?? []), ...donorMeta.removedLinkKeys]),
    ].filter((k) => !activeAttachedKeys.has(k));
  }
  if (!donorId.startsWith("ws-")) {
    next.migratedFromIds = [
      ...new Set([...(next.migratedFromIds ?? []), ...(donorMeta.migratedFromIds ?? []), normalizeCardId(donorId)]),
    ];
  }
  return next;
}

function resolveCardStatus(
  linked: LinkedWorkspace | null,
  meta: ItemUserMeta | undefined,
): CardStatus {
  const stored = normalizeStoredStatus(meta?.customStatus);

  if (!linked || linked.primaryAgentId === null) {
    if (stored === "archived") return "archived";
    if (stored === "waiting_external") return "waiting_external";
    return "pool";
  }

  // Invariant: while an unarchived conversation exists (`linked !== null && linked.primaryAgentId !== null`), never report "archived"
  if (linked.agentStatus === "running" || linked.agentStatus === "initializing") {
    return "running";
  }

  if (linked.pendingPermissions === 0 && stored === "waiting_external") {
    return "waiting_external";
  }

  return "needs_me";
}

async function listLiveAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      page: cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
    });
    agents.push(...page.entries.map((entry) => entry.agent));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return agents.filter((a) => a.archivedAt === null || a.archivedAt === undefined);
}

async function listLiveWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({
      page: cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
    });
    workspaces.push(...page.entries);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return workspaces.filter((w) => {
    const archivedAt = (w as { archivedAt?: string | null }).archivedAt;
    return (
      (archivedAt === null || archivedAt === undefined) &&
      (w.archivingAt === null || w.archivingAt === undefined)
    );
  });
}

async function listUserProjects(paseo: PaseoApi): Promise<ProjectOption[]> {
  try {
    const res = await paseo.projects.list();
    const raw = res.projects.filter((p) => !isInternalPluginPath(p.projectRootPath));
    const nameCounts = new Map<string, number>();
    for (const p of raw) {
      nameCounts.set(p.projectDisplayName, (nameCounts.get(p.projectDisplayName) ?? 0) + 1);
    }
    return raw
      .map((p) => {
        const kind: "git" | "non_git" = p.projectKind === "git" ? "git" : "non_git";
        const duplicate = (nameCounts.get(p.projectDisplayName) ?? 0) > 1;
        const suffix = duplicate ? (kind === "git" ? " (git)" : ` (${p.projectRootPath.split("/").pop()})`) : "";
        return {
          projectId: p.projectId,
          name: `${p.projectDisplayName}${suffix}`,
          kind,
          path: p.projectRootPath,
        };
      })
      .sort((a, b) => Number(b.kind === "git") - Number(a.kind === "git") || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function suggestProject(raw: RawScannedItem, projects: readonly ProjectOption[]): ProjectOption | null {
  if (projects.length === 0) return null;

  if (raw.triageProjectId) {
    const triaged = projects.find((p) => p.projectId === raw.triageProjectId);
    if (triaged) return triaged;
  }

  if (raw.repoPath) {
    const cleanRepo = raw.repoPath.replace(/\/+$/, "");
    const exactGit = projects.find((p) => p.kind === "git" && p.path.replace(/\/+$/, "") === cleanRepo);
    if (exactGit) return exactGit;
    const exactAny = projects.find((p) => p.path.replace(/\/+$/, "") === cleanRepo);
    if (exactAny) return exactAny;
    const nested = projects.find((p) => {
      const pp = p.path.replace(/\/+$/, "");
      return cleanRepo.startsWith(`${pp}/`) || pp.startsWith(`${cleanRepo}/`);
    });
    if (nested) return nested;
  }

  const hay = `${raw.title} ${raw.summary} ${raw.url}`.toLowerCase();
  const candidates = projects
    .map((p) => {
      const folder = (p.path.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase();
      const baseName = p.name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
      let score = 0;
      if (folder.length >= 3 && hay.includes(folder)) score = Math.max(score, folder.length + (p.kind === "git" ? 10 : 0));
      if (baseName.length >= 3 && hay.includes(baseName)) {
        score = Math.max(score, baseName.length + (p.kind === "git" ? 10 : 0));
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates[0]) return candidates[0].p;

  return projects.find((x) => x.kind === "git") ?? projects[0] ?? null;
}

function buildLinkedWorkspace(
  ws: PaseoWorkspace,
  wsAgents: readonly PaseoAgent[],
  meta: ItemUserMeta | undefined,
  fallbackModel = "",
  summarizing = false,
): LinkedWorkspace {
  const sorted = [...wsAgents].sort((a, b) => {
    const activeDiff = Number(b.status !== "closed") - Number(a.status !== "closed");
    if (activeDiff !== 0) return activeDiff;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
  // Prefer open (non-closed) sessions; if all are closed, show the latest one
  const openOnes = sorted.filter((a) => a.status !== "closed");
  const visibleAgents = openOnes.length > 0 ? openOnes : sorted.slice(0, 1);

  const bound = meta?.boundAgentId
    ? (visibleAgents.find((a) => a.id === meta.boundAgentId) ?? null)
    : null;
  const primary = bound ?? visibleAgents[0] ?? null;
  const anyPerm = visibleAgents.find((a) => (a.pendingPermissions?.length ?? 0) > 0) ?? null;
  const anyRunning = visibleAgents.find((a) => a.status === "running" || a.status === "initializing") ?? null;
  const effective = anyPerm ?? anyRunning ?? primary;
  const pendingPerms = visibleAgents.reduce((sum, a) => sum + (a.pendingPermissions?.length ?? 0), 0);

  return {
    workspaceId: ws.id,
    workspaceName: decodeSafe(ws.name) || null,
    cwd: ws.workspaceDirectory ?? ws.projectRootPath ?? null,
    primaryAgentId: effective?.id ?? null,
    agentIds: visibleAgents.map((a) => a.id),
    sessions: visibleAgents.map((a) => ({
      id: a.id,
      title: decodeSafe(a.title) || a.id.slice(0, 7),
      status: normalizeAgentStatus(a.status) ?? "idle",
      model: formatFullModel(a, fallbackModel),
      pendingPermissions: a.pendingPermissions?.length ?? 0,
      updatedAt: a.updatedAt,
    })),
    agentStatus: normalizeAgentStatus(effective?.status),
    pendingPermissions: pendingPerms,
    updatedAt: effective?.updatedAt ?? new Date().toISOString(),
    prepSummary: meta?.prepSummary ?? null,
    summarizing,
  };
}

async function readAgentTailReply(paseo: PaseoApi, agentId: string, limit = 25): Promise<string> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit,
    projection: "projected",
  });
  const parts: string[] = [];
  for (let i = page.entries.length - 1; i >= 0; i--) {
    const entry = page.entries[i];
    if (!entry) break;
    const item = entry.item as { type?: string; text?: string };
    if (item.type === "assistant_message" && typeof item.text === "string") {
      parts.unshift(item.text);
      continue;
    }
    if (item.type === "plugin" || item.type === "notification") continue;
    break;
  }
  return parts.join("").trim();
}

function resolveConfiguredDefaultModel(
  raw: RawScannedItem,
  models: { resolved: ResolvedModels },
): string {
  if (raw.source === "custom" && raw.recommendedModel) {
    return raw.recommendedModel;
  }
  const assignable = models.resolved.assignableModels;
  if (raw.triageSelectedModel) {
    if (assignable.length === 0 || assignable.some((m) => m.model === raw.triageSelectedModel)) {
      return raw.triageSelectedModel;
    }
  }
  return assignable[0]?.model || models.resolved.defaultWorkerModel;
}

export class RadarEngine {
  private scanningPromise: Promise<void> | null = null;
  private modelAlerts = new Map<string, RadarModelAlert>();
  private pendingTurnStartUntil = new Map<string, number>();
  private followInFlight = new Map<
    string,
    Promise<{ workspaceId: string; agentId: string; mode: "background" | "immediate" }>
  >();
  private insights = new RadarInsightsManager();
  private summaryQueue = new TurnSummaryQueue({
    onSuccess: ({ isPrimary }) => {
      for (const k of this.modelAlerts.keys()) {
        if (k.startsWith("summary:fallback:")) {
          if (isPrimary) this.modelAlerts.delete(k);
        } else if (k.startsWith("summary:")) {
          this.modelAlerts.delete(k);
        }
      }
    },
    onEvaluated: (info) => this.handleGoalPostTurnEval(info),
    onFallback: ({ failedModel, nextModel, cardId, cardTitle, error }) => {
      this.recordModelAlert({
        key: `summary:fallback:${failedModel}`,
        role: "摘要打标",
        model: failedModel,
        fallbackModel: nextModel,
        severity: "warning",
        message: formatModelErrorMessage(error),
        cardTitle,
        cardId,
        retryable: false,
      });
    },
    onError: ({ summaryModel, cardId, cardTitle, error }) => {
      this.recordModelAlert({
        key: `summary:${summaryModel}`,
        role: "摘要打标",
        model: summaryModel,
        severity: "error",
        message: formatModelErrorMessage(error),
        cardTitle,
        cardId,
        retryable: true,
      });
    },
  });
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private waitMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private paseoHandle: PaseoApi | null = null;
  private runningCronChecks = new Set<string>();
  private lastScriptCronSlot = new Map<string, string>();
  private lastEvaluatorReapMs = 0;
  readonly coordination: RadarCoordinationEngine;

  constructor(private readonly settings?: PluginSettings<typeof radarModelSettings.schema>) {
    this.coordination = new RadarCoordinationEngine({
      boardsRootDir,
      waitScriptsDir,
      waitChecksDir,
      graph: {
        sanitizeBoardCardId,
        detectBoardWatchCycle,
        evaluateBoardWatch,
        computeTopologicalWaves,
        computeCoordinationSummary,
        formatReferenceManifestPrompt,
      },
      store: {
        sanitizeSubcardDirName,
        subcardOutputDirPath,
        ensureCoordBoardDirs,
        ensureSubcardOutputDir,
        readCoordBoard,
        updateCoordBoard,
        appendCoordEvent,
        readCoordEvents,
        countCoordEvents,
        scanDirectoryArtifacts,
        readBoardArtifactContent,
      },
      waitUtils: {
        parseCron5,
        parseMaxTimeoutMs,
        resolveEffectiveTimeZone,
        hasWaitPendingExitCode,
        classifyWaitScriptFailure,
        matchesCron5InTimeZone,
        minuteSlotInTimeZone,
        waitScriptRetryBackoffMs: WAIT_SCRIPT_RETRY_BACKOFF_MS,
      },
      gates: {
        validateReadyToArchiveEvidence,
        findUncommittedSessionChanges,
        getGitBaselineForScope: async (scopeKey) => {
          const st = await readRadarState();
          return st.gitBaselines?.[scopeKey];
        },
        execShellCommand: async (command, cwd, timeoutMs = 120_000) => {
          try {
            const { stdout, stderr } = await execCommand("bash", ["-lc", command], {
              cwd: cwd || waitChecksDir(),
              timeout: timeoutMs,
              maxBuffer: 1024 * 1024,
              env: buildExtendedEnv(),
            });
            return { ok: true, stdout, stderr, exitCode: 0, timedOut: false };
          } catch (err: unknown) {
            const e = err as {
              code?: unknown;
              killed?: boolean;
              stdout?: string;
              stderr?: string;
              message?: string;
            };
            return {
              ok: false,
              stdout: e?.stdout ?? "",
              stderr: e?.stderr ?? e?.message ?? "",
              exitCode: (typeof e?.code === "number" || typeof e?.code === "string") ? e.code : 1,
              timedOut: Boolean(e?.killed),
            };
          }
        },
        captureGitBranchAndSha: async (cwd) => {
          let branch: string | null = null;
          let sha: string | null = null;
          try {
            const b = await execCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
              cwd,
              timeout: 2000,
              env: buildExtendedEnv(),
            });
            if (b.stdout.trim()) branch = b.stdout.trim();
          } catch {
            // detached HEAD
          }
          try {
            const s = await execCommand("git", ["rev-parse", "--short", "HEAD"], {
              cwd,
              timeout: 2000,
              env: buildExtendedEnv(),
            });
            if (s.stdout.trim()) sha = s.stdout.trim();
          } catch {
            // ignore
          }
          return { branch, sha };
        },
        mergeAttachedLinks: (incoming, existing) => mergeAttachedLinks(incoming, existing),
      },
      radar: {
        isCoordinationBetaEnabled: async () => (await this.getRawSettings()).coordinationBetaEnabled,
        getEffectiveTimezone: async () => resolveEffectiveTimeZone((await this.getRawSettings()).timezone),
        getDefaultWorkerModel: async () => {
          const [m, profiles] = await Promise.all([
            this.getModels(),
            discoverAgentProfiles(this.paseoHandle),
          ]);
          const seenModels = new Set(m.resolved.assignableModels.map((entry) => entry.model));
          const extraProfiles = profiles
            .map((p) => ({
              id: p.id,
              name: p.name,
              model: profileToFullModel(p),
              notes: p.notes ?? "",
            }))
            .filter((p) => !seenModels.has(p.model));
          return {
            defaultModel: m.resolved.defaultWorkerModel,
            assignable: m.resolved.assignableModels,
            extraProfiles,
          };
        },
        listWaitEvalModels: async () => {
          const m = await this.getModels();
          return m.waitEvalModels.length > 0 ? m.waitEvalModels : m.copilotModels;
        },
        getParentCardContext: async (cardId) => {
          const st = await readRadarState();
          const normId = normalizeCardId(cardId);
          const meta = st.meta[normId] ?? st.meta[cardId];
          const raw = [...st.customItems, ...st.rawItems].find((r) => r.id === normId || r.id === cardId);
          const handle = this.paseoHandle;
          let projects: ProjectOption[] = [];
          let liveWsTitle: string | null = null;
          let liveWsDir: string | null = null;
          let liveWsProjectId: string | null = null;
          if (handle) {
            projects = await listUserProjects(handle).catch(() => []);
            const wsId = meta?.boundWorkspaceId ?? (normId.startsWith("ws-") ? normId.slice(3) : null);
            if (wsId) {
              const ws = await handle.workspaces.ref(wsId).refresh().catch(() => null);
              if (ws) {
                liveWsTitle = decodeSafe(ws.title).trim() || decodeSafe(ws.name).trim() || null;
                liveWsDir = ws.workspaceDirectory ?? ws.projectRootPath ?? null;
                liveWsProjectId = ws.projectId;
              }
            }
          }
          const resolvedProjId = meta?.selectedProjectId ?? liveWsProjectId ?? null;
          const project =
            (resolvedProjId ? projects.find((p) => p.projectId === resolvedProjId) : undefined) ??
            (raw ? suggestProject(raw, projects) : undefined) ??
            projects[0] ??
            null;
          const boundWsId =
            meta?.boundWorkspaceId ?? (normId.startsWith("ws-") ? normId.slice(3) : null);
          if (!meta && !raw && !boundWsId) return null;
          return {
            cardId: normId,
            title: raw?.title ?? liveWsTitle ?? normId,
            coordinationEnabled: Boolean(meta?.coordinationEnabled),
            boundWorkspaceId: boundWsId,
            boundAgentId: meta?.boundAgentId ?? null,
            project,
            cwd: liveWsDir ?? project?.path ?? null,
            waitMode: meta?.waitMode ?? null,
            waitBoard: meta?.waitBoard ?? null,
          };
        },
        listEnabledParentCardIds: async () => {
          const st = await readRadarState();
          return Object.entries(st.meta)
            .filter(([, m]) => Boolean(m?.coordinationEnabled))
            .map(([id]) => id);
        },
        setParentCoordinationMeta: async (cardId, patch) => {
          const nowIso = new Date().toISOString();
          await updateRadarState((s) => {
            const prev = s.meta[cardId] ?? {};
            const nextSubWs = patch.addSubcardWorkspaceId
              ? [...new Set([...(prev.subcardWorkspaceIds ?? []), patch.addSubcardWorkspaceId])]
              : prev.subcardWorkspaceIds;
            s.meta[cardId] = {
              ...prev,
              ...(patch.coordinationEnabled !== undefined
                ? { coordinationEnabled: patch.coordinationEnabled }
                : {}),
              ...(nextSubWs !== undefined ? { subcardWorkspaceIds: nextSubWs } : {}),
              ...(patch.clearParentWait
                ? {
                    customStatus: "needs_me",
                    ...buildClearedNeedsMeTagPatch(nowIso),
                    waitAgentId: null,
                    waitMode: null,
                    waitPredicate: null,
                    waitProviderId: null,
                    waitBoard: null,
                    waitCondition: null,
                    waitScheduleId: null,
                    waitScriptPath: null,
                    waitCron: null,
                    waitStartedAt: null,
                    waitTimeoutAt: null,
                    waitMaxTimeoutLabel: null,
                    waitCheckNote: null,
                    lastWaitCheckAt: nowIso,
                  }
                : {}),
            };
          });
        },
        buildCoordinatorSystemPrompt: (tz, assignable) =>
          buildCoordinatorSystemPrompt(tz, assignable),
        sendCoordinatorPrompt: async (parentCardId, agentId, prompt) => {
          await this.triggerAgentForCard(parentCardId, agentId, prompt);
          return true;
        },
        getAgentSnapshot: async (agentId) => {
          const handle = this.paseoHandle;
          if (!handle) return null;
          const res = await handle.agents.ref(agentId).refresh().catch(() => null);
          if (!res?.agent) return null;
          return {
            id: res.agent.id,
            workspaceId: res.agent.workspaceId ?? null,
            cwd: res.agent.cwd ?? null,
            status: res.agent.status,
            archivedAt: res.agent.archivedAt ?? null,
            labels: res.agent.labels,
          };
        },
        sendAgentMessage: async (agentId, prompt) => {
          const handle = this.paseoHandle;
          this.markAgentTurnPending(agentId);
          try {
            if (handle) {
              await handle.agents.ref(agentId).send(prompt, { activeTurnBehavior: "steer" });
            } else {
              await sendDaemonAgentMessage(agentId, prompt, "steer");
            }
          } catch (err) {
            this.pendingTurnStartUntil.delete(agentId);
            throw err;
          }
        },
        archiveAgent: async (agentId) => {
          await this.paseoHandle?.agents.ref(agentId).archive().catch(() => {});
        },
        archiveWorkspace: async (workspaceId) => {
          await this.paseoHandle?.workspaces.archive(workspaceId).catch(() => {});
        },
        createSubcardSession: async (params) => {
          const handle = this.paseoHandle;
          if (!handle) throw new Error("Paseo 服务端会话尚未就绪，无法创建子卡 Agent");
          const [modelsForWorker, profiles] = await Promise.all([
            this.getModels(handle),
            discoverAgentProfiles(handle),
          ]);
          const requested = params.selectedModel?.trim() || "";
          const reqLower = requested.toLowerCase();
          const matchedAssignable = requested
            ? modelsForWorker.resolved.assignableModels.find(
                (m) =>
                  m.model.toLowerCase() === reqLower ||
                  m.id.toLowerCase() === reqLower ||
                  m.name.toLowerCase() === reqLower,
              )
            : undefined;
          const matchedProfile = requested
            ? profiles.find(
                (p) =>
                  profileToFullModel(p).toLowerCase() === reqLower ||
                  p.id.toLowerCase() === reqLower ||
                  p.name.toLowerCase() === reqLower ||
                  (p.model ?? "").toLowerCase() === reqLower,
              )
            : undefined;
          const chosenProvider =
            matchedAssignable?.model ||
            (matchedProfile ? profileToFullModel(matchedProfile) : requested) ||
            modelsForWorker.resolved.defaultWorkerModel;
          if (!chosenProvider) throw new Error("未找到可用模型，无法创建子卡 Agent");
          const effectiveModeId =
            matchedAssignable?.modeId ??
            matchedProfile?.modeId ??
            (chosenProvider.startsWith("agy/") ? "full-access" : undefined);
          const effectiveThinking =
            matchedAssignable?.thinkingOptionId ?? matchedProfile?.thinkingOptionId ?? "medium";
          const effectiveFeatures =
            matchedAssignable?.featureValues ?? matchedProfile?.featureValues ?? undefined;

          let targetWsId = params.parentWorkspaceId;
          let wsHandle = targetWsId ? handle.workspaces.ref(targetWsId) : null;
          let gitBranch: string | null = null;

          if (params.isolation === "worktree" && params.project?.kind === "git") {
            const baseCandidates = await resolveWorktreeBaseCandidates(
              params.project.path,
              params.parentCwd,
            );
            const slugParent = sanitizeBoardCardId(params.parentCardId).slice(0, 16);
            const slugSub = sanitizeSubcardDirName(params.subcardId).slice(0, 20);
            const uniq = Math.floor(Date.now() / 1000).toString(36).slice(-4);
            const branchName = `radar-sub/${slugParent}-${slugSub}-${uniq}`;

            let createdWs = null;
            let lastErr: unknown;
            for (const baseBranch of baseCandidates) {
              try {
                createdWs = await handle.workspaces.create({
                  title: params.title.slice(0, 48),
                  background: true,
                  source: {
                    kind: "worktree",
                    projectId: params.project.projectId,
                    cwd: params.project.path,
                    action: "branch-off",
                    baseBranch,
                    branchName,
                  },
                });
                break;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.toLowerCase().includes("background")) {
                  try {
                    createdWs = await handle.workspaces.create({
                      title: params.title.slice(0, 48),
                      source: {
                        kind: "worktree",
                        projectId: params.project.projectId,
                        cwd: params.project.path,
                        action: "branch-off",
                        baseBranch,
                        branchName,
                      },
                    });
                    break;
                  } catch (retryErr) {
                    lastErr = retryErr;
                  }
                } else {
                  lastErr = err;
                }
              }
            }
            if (!createdWs) {
              throw lastErr instanceof Error ? lastErr : new Error("创建子卡 Worktree 失败");
            }
            wsHandle = createdWs;
            targetWsId = createdWs.id;
            gitBranch = branchName;
          } else if (!wsHandle) {
            const fallbackDir = params.parentCwd ?? params.project?.path;
            if (!fallbackDir) throw new Error("未找到可用工作目录，无法启动子卡");
            wsHandle = await handle.workspaces.open(fallbackDir);
            targetWsId = wsHandle.id;
          }

          const agent = await wsHandle.agents.create({
            config: {
              provider: chosenProvider,
              ...(effectiveModeId ? { modeId: effectiveModeId } : {}),
              thinkingOptionId: effectiveThinking,
              ...(effectiveFeatures ? { featureValues: effectiveFeatures } : {}),
            },
            ...(params.coordinatorAgentId ? { parent: params.coordinatorAgentId } : {}),
            env: { PASEO_RADAR_ROLE: "subcard" },
            title: params.title.slice(0, 56),
            labels: {
              [RADAR_LABELS.subcard]: params.subcardId,
              [RADAR_LABELS.parentCard]: params.parentCardId,
            },
            prompt: params.buildPrompt ? params.buildPrompt(isPiProvider(chosenProvider)) : params.prompt,
          });
          this.markAgentTurnPending(agent.id);
          return {
            workspaceId: targetWsId!,
            agentId: agent.id,
            gitBranch,
            resolvedModel: chosenProvider,
          };
        },
        createAiWaitSchedule: async (params) => {
          const evalModels = (await this.getModels()).waitEvalModels;
          const fallbackModels = evalModels.length > 0 ? evalModels : (await this.getModels()).copilotModels;
          const fullModel = params.fullModel ?? fallbackModels[0];
          if (!fullModel) throw new Error("未找到可用的 wait-evaluator 模型");
          return createDaemonSchedule({
            name: params.name,
            prompt: params.prompt,
            cron: params.cron,
            fullModel,
            cwd: waitChecksDir(),
            expiresAt: params.timeoutAt,
            timezone: params.timezone,
          });
        },
        deleteWaitSchedule: (id) => this.cleanupWaitSchedule(id),
        deleteWaitScript: (path) => this.cleanupWaitScript(path),
        readAgentTailReply: async (agentId) => {
          const handle = this.paseoHandle;
          if (!handle) return "";
          return readAgentTailReply(handle, agentId, 20);
        },
      },
    });
  }

  private markAgentTurnPending(agentId: string | null | undefined, windowMs = 15_000): void {
    if (!agentId) return;
    this.pendingTurnStartUntil.set(agentId, Date.now() + windowMs);
  }

  recordModelAlert(input: {
    key: string;
    role: string;
    model: string;
    fallbackModel?: string | null;
    severity?: "warning" | "error";
    message: string;
    cardTitle?: string | null;
    cardId?: string | null;
    agentId?: string | null;
    retryable?: boolean;
  }): void {
    const prev = this.modelAlerts.get(input.key);
    this.modelAlerts.set(input.key, {
      key: input.key,
      role: input.role,
      model: input.model,
      fallbackModel: input.fallbackModel ?? prev?.fallbackModel ?? null,
      severity: input.severity ?? "error",
      message: input.message,
      cardTitle: input.cardTitle ?? prev?.cardTitle ?? null,
      cardId: input.cardId ?? prev?.cardId ?? null,
      agentId: input.agentId ?? prev?.agentId ?? null,
      retryable: input.retryable ?? prev?.retryable ?? true,
      count: (prev?.count ?? 0) + 1,
      occurredAt: new Date().toISOString(),
    });
    if (this.modelAlerts.size > 10) {
      const oldestKey = this.modelAlerts.keys().next().value;
      if (oldestKey) this.modelAlerts.delete(oldestKey);
    }
  }

  dismissModelAlerts(key?: string): void {
    if (key) {
      this.modelAlerts.delete(key);
    } else {
      this.modelAlerts.clear();
    }
  }

  async retryModelAlert(
    paseo: PaseoApi,
    key: string,
  ): Promise<{ retried: boolean; message?: string }> {
    const alert = this.modelAlerts.get(key);
    if (!alert) return { retried: false };
    this.modelAlerts.delete(key);

    if (key.startsWith("summary:")) {
      const models = await this.getModels(paseo);
      const count = this.summaryQueue.retryFailedForModel(alert.model, models.summaryModels);
      return count > 0
        ? { retried: true }
        : { retried: false, message: "No cached summary task to retry" };
    }

    if (key.startsWith("triage:")) {
      void this.scan().catch((err: unknown) =>
        console.error("[paseo-radar] retry triage scan failed:", err),
      );
      return { retried: true };
    }

    if (key.startsWith("agent:") && alert.agentId) {
      const live = (await paseo.agents.ref(alert.agentId).refresh().catch(() => null))?.agent ?? null;
      if (!live || live.archivedAt) {
        return { retried: false, message: "Agent session is no longer active" };
      }
      this.markAgentTurnPending(alert.agentId);
      await paseo.agents.ref(alert.agentId).send("请继续完成上一轮失败的操作。", {
        activeTurnBehavior: "steer",
      });
      return { retried: true };
    }

    return { retried: false };
  }

  private parseCollectorFilenameFromError(errText?: string): string | undefined {
    if (!errText) return undefined;
    const m = /^([^:\s]+\.py):\s*/.exec(errText.trim());
    return m?.[1];
  }

  async dismissScanErrors(input: { error?: string; filename?: string }): Promise<void> {
    const targetFile = input.filename ?? this.parseCollectorFilenameFromError(input.error);
    clearCollectorDiagnosticAlert(input.error && !targetFile ? undefined : targetFile);

    await updateRadarState((state) => {
      if (input.error) {
        state.scanErrors = state.scanErrors.filter((e) => e !== input.error);
        if (targetFile) {
          const stillHasErrors = state.scanErrors.some((e) => e.startsWith(`${targetFile}: `));
          if (!stillHasErrors && state.collectorDiagnostics[targetFile]) {
            state.collectorDiagnostics[targetFile] = {
              ...state.collectorDiagnostics[targetFile]!,
              warnings: [],
              error: null,
            };
          }
        }
        return;
      }

      if (targetFile) {
        state.scanErrors = state.scanErrors.filter((e) => !e.startsWith(`${targetFile}: `));
        if (state.collectorDiagnostics[targetFile]) {
          state.collectorDiagnostics[targetFile] = {
            ...state.collectorDiagnostics[targetFile]!,
            warnings: [],
            error: null,
          };
        }
        return;
      }

      state.scanErrors = [];
      for (const [fn, diag] of Object.entries(state.collectorDiagnostics)) {
        if (diag.error || diag.warnings.length > 0) {
          state.collectorDiagnostics[fn] = { ...diag, warnings: [], error: null };
        }
      }
    });
  }

  async syncCollectorTestResult(
    filename: string,
    res: { ok: boolean; durationMs: number; itemCount: number; warnings: string[]; error?: string | null },
  ): Promise<void> {
    let syncedDiag: PersistedCollectorDiag | null = null;
    await updateRadarState((state) => {
      const nextErrors = state.scanErrors.filter((e) => !e.startsWith(`${filename}: `));
      if (!res.ok && res.error) {
        nextErrors.push(`${filename}: ${res.error}`);
      }
      for (const w of res.warnings) {
        nextErrors.push(`${filename}: ${w}`);
      }
      state.scanErrors = nextErrors;
      const prev = state.collectorDiagnostics[filename];
      syncedDiag = {
        ...(prev?.itemHashes ? { itemHashes: prev.itemHashes } : {}),
        lastRunAt: new Date().toISOString(),
        durationMs: Math.round(res.durationMs),
        itemCount: res.itemCount,
        deltaCount: prev?.deltaCount ?? null,
        warnings: res.warnings,
        error: res.error ?? null,
      };
      state.collectorDiagnostics[filename] = syncedDiag;
    });
    if (syncedDiag) {
      setCollectorDiagnostic(filename, syncedDiag);
    }
  }

  async retryScanError(
    paseo: PaseoApi,
    input: { error?: string; filename?: string },
  ): Promise<{ ok: boolean; message?: string }> {
    const targetFile = input.filename ?? this.parseCollectorFilenameFromError(input.error);
    if (targetFile) {
      const cfg = await this.getModels(paseo);
      const res = await testCollectorScript(targetFile, cfg.timezone);
      await this.syncCollectorTestResult(targetFile, res);
      return {
        ok: res.ok && res.warnings.length === 0,
        message: res.error ?? (res.warnings.length > 0 ? res.warnings.join("；") : undefined),
      };
    }

    await this.scan();
    const state = await readRadarState();
    return {
      ok: state.scanErrors.length === 0,
      message: state.scanErrors.length > 0 ? state.scanErrors.join("；") : undefined,
    };
  }

  async getRawSettings(): Promise<RadarModelSettings> {
    if (!this.settings) return { ...DEFAULT_RADAR_SETTINGS };
    try {
      const state = await this.settings.read();
      if (state.status === "ready") return state.values;
    } catch {
      // Fallback
    }
    return { ...DEFAULT_RADAR_SETTINGS };
  }

  async getModels(paseo?: PaseoApi | null) {
    const raw = await this.getRawSettings();
    return resolveEffectiveModels(raw, paseo ?? this.paseoHandle);
  }

  rememberPaseo(paseo: PaseoApi): void {
    this.paseoHandle = paseo;
  }

  private async runAutoScheduledScan(trigger: "boot" | "interval"): Promise<void> {
    const cfg = await this.getModels();
    if (!cfg.autoScanEnabled) return;
    await this.scan().catch((err: unknown) =>
      console.error(`[paseo-radar] ${trigger} scan failed:`, err),
    );
  }

  start(): () => void {
    let stopped = false;
    let pushQueued = false;
    const onChanged = () => {
      if (stopped || pushQueued) return;
      pushQueued = true;
      // An in-flight scan may already have consumed its snapshot. Coalesce pushes
      // and take a fresh snapshot once that scan is finished.
      void (async () => {
        await this.scanningPromise?.catch(() => {});
        pushQueued = false;
        if (!stopped) await this.scan();
      })().catch((err) => console.error("[paseo-radar] provider push scan failed:", err));
    };
    void ensureRadarHome()
      .then(() => stopped ? undefined : startDaemonProviders(onChanged))
      .catch((err) => console.error("[paseo-radar] provider startup failed:", err));
    const bootTimer = setTimeout(() => {
      void this.runAutoScheduledScan("boot");
    }, 1500);

    this.scanTimer = setInterval(() => {
      void this.runAutoScheduledScan("interval");
    }, SCAN_INTERVAL_MS);

    this.waitMonitorTimer = setInterval(() => {
      void this.tickWaitMonitors().catch((err: unknown) =>
        console.error("[paseo-radar] wait monitor tick failed:", err),
      );
    }, WAIT_MONITOR_INTERVAL_MS);

    return () => {
      stopped = true;
      stopDaemonProviders();
      clearTimeout(bootTimer);
      if (this.scanTimer) clearInterval(this.scanTimer);
      if (this.waitMonitorTimer) clearInterval(this.waitMonitorTimer);
      this.scanTimer = null;
      this.waitMonitorTimer = null;
      this.coordination.dispose();
    };
  }

  get isScanning(): boolean {
    return this.scanningPromise !== null;
  }

  async scan(): Promise<void> {
    if (this.scanningPromise !== null) return this.scanningPromise;
    const run = (async () => {
      const [preState, rules, models] = await Promise.all([
        readRadarState(),
        readRadarRules(),
        this.getModels(this.paseoHandle),
      ]);
      const knownHashes = new Map<string, string>();
      for (const raw of preState.rawItems) {
        knownHashes.set(raw.id, raw.stateHash);
      }
      for (const [id, entry] of Object.entries(preState.triageCache)) {
        knownHashes.set(id, entry.stateHash);
      }

      const [collected, projects, liveWorkspaces, liveAgents] = await Promise.all([
        runAllCollectors({
          knownHashes,
          persistedDiags: preState.collectorDiagnostics,
          timeZone: models.timezone,
        }),
        this.paseoHandle ? listUserProjects(this.paseoHandle) : Promise.resolve([] as ProjectOption[]),
        this.paseoHandle ? listLiveWorkspaces(this.paseoHandle).catch(() => [] as PaseoWorkspace[]) : Promise.resolve([] as PaseoWorkspace[]),
        this.paseoHandle ? listLiveAgents(this.paseoHandle).catch(() => [] as PaseoAgent[]) : Promise.resolve([] as PaseoAgent[]),
      ]);

      const externalBoardCards: ActiveBoardDigestItem[] = [];
      for (const c of preState.customItems) {
        const cm = preState.meta[c.id];
        const cStatus = normalizeStoredStatus(cm?.customStatus);
        if (cStatus === "archived") continue;
        externalBoardCards.push({
          id: c.id,
          source: c.source,
          badge: c.badge,
          title: c.title,
          summary: c.summary,
          url: c.url || null,
          hasLiveSession: Boolean(
            cm?.boundWorkspaceId ||
              cm?.boundAgentId ||
              cStatus === "needs_me" ||
              cStatus === "waiting_external",
          ),
          prepSummary: cm?.prepSummary ?? null,
        });
      }
      if (models.trackLocalWorkspaces && liveWorkspaces.length > 0) {
        const boundWsIds = new Set(
          Object.values(preState.meta)
            .map((m) => m?.boundWorkspaceId)
            .filter((x): x is string => Boolean(x)),
        );
        for (const ws of liveWorkspaces) {
          if (boundWsIds.has(ws.id) || isInternalPluginPath(ws.projectRootPath) || isInternalPluginPath(ws.workspaceDirectory)) {
            continue;
          }
          const wsUserAgents = liveAgents.filter((a) => a.workspaceId === ws.id && isUserConversationAgent(a));
          if (wsUserAgents.length === 0) continue;
          const wsTitle = resolveLocalWorkspaceCardTitle(ws, wsUserAgents);
          const wsId = `ws-${ws.id}`;
          const wsMeta = preState.meta[wsId];
          if (normalizeStoredStatus(wsMeta?.customStatus) === "archived") continue;
          externalBoardCards.push({
            id: wsId,
            source: "workspace",
            badge: "本地会话",
            title: wsTitle,
            summary: ws.workspaceDirectory ?? ws.projectRootPath ?? "",
            url: null,
            hasLiveSession: true,
            prepSummary: wsMeta?.prepSummary ?? null,
          });
        }
      }

      const dismissedRes = await readHumanInteractions({ kind: "card.dismiss", limit: 12 }).catch(() => null);
      const recentDismissed = (dismissedRes?.events ?? [])
        .slice()
        .reverse()
        .map((e) => ({
          source: e.cardSource ?? null,
          group: e.cardGroup ?? null,
          title: e.cardTitle ?? null,
        }));

      const triaged = await runIncrementalTriage({
        scannedItems: collected.items,
        ruleNotes: rules.notes,
        prevRawItems: preState.rawItems,
        prevCache: preState.triageCache,
        bootstrapped: preState.triageBootstrapped,
        meta: preState.meta,
        externalBoardCards,
        recentDismissed,
        projects,
        assignableModels: models.resolved.assignableModels,
        triageModels: models.triageModels,
        paseo: this.paseoHandle,
        onModelSuccess: ({ isPrimary }) => {
          for (const k of this.modelAlerts.keys()) {
            if (k.startsWith("triage:fallback:")) {
              if (isPrimary) this.modelAlerts.delete(k);
            } else if (k.startsWith("triage:")) {
              this.modelAlerts.delete(k);
            }
          }
        },
        onModelFallback: ({ failedModel, nextModel, error }) => {
          this.recordModelAlert({
            key: `triage:fallback:${failedModel}`,
            role: "采集分拣",
            model: failedModel,
            fallbackModel: nextModel,
            severity: "warning",
            message: formatModelErrorMessage(error),
            retryable: false,
          });
        },
        onModelError: ({ model, error }) => {
          this.recordModelAlert({
            key: `triage:${model}`,
            role: "采集分拣",
            model,
            severity: "error",
            message: formatModelErrorMessage(error),
          });
        },
      });

      await updateRadarState((state) => {
        state.lastScanAt = collected.scannedAt;
        state.lastScanDeltaCount = triaged.deltaCount;
        state.lastScanTriageTriggered = triaged.modelTriggered;
        state.scanErrors = collected.errors;
        state.collectorDiagnostics = {
          ...state.collectorDiagnostics,
          ...collected.diagnostics,
        };
        state.triageCache = triaged.nextCache;
        state.triageBootstrapped = triaged.bootstrapped;

        for (const [targetId, extraLnks] of Object.entries(triaged.extraLinkMerges)) {
          const prev = state.meta[targetId] ?? {};
          state.meta[targetId] = {
            ...prev,
            extraLinks: mergeRadarLinks(prev.extraLinks, extraLnks),
          };
        }

        const nextItems = triaged.items.map((item) => {
          const nid = normalizeCardId(item.id);
          return nid === item.id ? item : { ...item, id: nid };
        });

        for (const [targetId, donorIds] of Object.entries(triaged.absorbedDonorsByTarget)) {
          const targetMeta = state.meta[targetId];
          const hasTargetMeta = Boolean(targetMeta);
          for (const rawDonorId of donorIds) {
            const donorId = normalizeCardId(rawDonorId);
            if (!donorId || donorId === targetId) continue;
            const donorMeta = state.meta[donorId];
            if (
              donorMeta &&
              (!donorMeta.boundWorkspaceId || donorMeta.boundWorkspaceId === targetMeta?.boundWorkspaceId)
            ) {
              const targetItem = nextItems.find((i) => i.id === targetId);
              state.meta[targetId] = mergeDonorMetaIntoTarget(
                state.meta[targetId],
                donorMeta,
                donorId,
                targetItem?.stateHash ?? targetId,
              );
              delete state.meta[donorId];
            } else if (hasTargetMeta) {
              const prev = state.meta[targetId] ?? {};
              state.meta[targetId] = {
                ...prev,
                migratedFromIds: [...new Set([...(prev.migratedFromIds ?? []), donorId])],
              };
            }
          }
        }
        const nextById = new Set(nextItems.map((i) => i.id));
        const nextWithKeys = nextItems.map((raw) => ({ raw, keys: rawItemEntityKeys(raw) }));
        const retained: RawScannedItem[] = [];

        for (const prevRaw of state.rawItems) {
          if (nextById.has(prevRaw.id)) continue;
          const prevMeta = state.meta[prevRaw.id];
          if (!prevMeta) continue;
          const prevStatus = normalizeStoredStatus(prevMeta.customStatus);
          const isWaiting = prevStatus === "waiting_external";
          const hasActiveBinding =
            Boolean(prevMeta.boundWorkspaceId || prevMeta.boundAgentId) && prevStatus !== "archived";
          if (!isWaiting && !hasActiveBinding) continue;

          const prevKeys = rawItemEntityKeys(prevRaw);
          const replacement = nextWithKeys.find(({ raw, keys }) => {
            const rMeta = state.meta[raw.id];
            if (prevMeta.boundWorkspaceId && rMeta?.boundWorkspaceId === prevMeta.boundWorkspaceId) return true;
            return prevKeys.size > 0 && setsIntersect(prevKeys, keys);
          })?.raw;

          if (replacement) {
            state.meta[replacement.id] = mergeDonorMetaIntoTarget(
              state.meta[replacement.id],
              prevMeta,
              prevRaw.id,
              replacement.stateHash,
            );
            delete state.meta[prevRaw.id];
          } else {
            retained.push(prevRaw);
          }
        }

        state.rawItems = [...nextItems, ...retained];
      });
    })();

    this.scanningPromise = run;
    try {
      await run;
    } finally {
      if (this.scanningPromise === run) this.scanningPromise = null;
    }
  }

  async cleanupWaitSchedule(scheduleId: string | null | undefined): Promise<void> {
    if (!scheduleId) return;
    try {
      await deleteDaemonSchedule(scheduleId);
      return;
    } catch {
      // Fallback to CLI if IPC is unavailable
    }
    const cli = await resolvePaseoBinary();
    await execCommand(cli, ["schedule", "delete", scheduleId], {
      timeout: 8000,
      env: buildExtendedEnv(),
    }).catch(() => {});
  }

  async cleanupWaitScript(scriptPath: string | null | undefined): Promise<void> {
    if (!scriptPath) return;
    await rm(scriptPath, { force: true }).catch(() => {});
  }

  private async triggerAgentForCard(
    cardId: string,
    boundAgentId: string | null | undefined,
    prompt: string,
    paseo?: PaseoApi,
  ): Promise<void> {
    const handle = paseo ?? this.paseoHandle;
    if (boundAgentId) {
      this.markAgentTurnPending(boundAgentId);
      try {
        if (handle) {
          await handle.agents.ref(boundAgentId).send(prompt, { activeTurnBehavior: "steer" });
        } else {
          await sendDaemonAgentMessage(boundAgentId, prompt, "steer");
        }
        return;
      } catch {
        try {
          await sendDaemonAgentMessage(boundAgentId, prompt, "steer");
          return;
        } catch {
          this.pendingTurnStartUntil.delete(boundAgentId);
          // Fall through to followItem / pendingWakePrompt if session was archived
        }
      }
    }

    if (handle) {
      try {
        await this.followItem(handle, { itemId: cardId, mode: "background", note: prompt });
        return;
      } catch (err) {
        console.warn(`[paseo-radar] followItem fallback on wakeup failed for ${cardId}:`, err);
      }
    }

    await updateRadarState((s) => {
      if (s.meta[cardId]) {
        s.meta[cardId].pendingWakePrompt = prompt;
      }
    });
  }

  private async isAgentPiProvider(
    paseo: PaseoApi | null | undefined,
    agentId: string | null | undefined,
    fallbackModel?: string | null,
  ): Promise<boolean> {
    if (paseo && agentId) {
      try {
        const snap = await paseo.agents.ref(agentId).refresh();
        if (snap?.agent?.provider) return isPiProvider(snap.agent.provider);
      } catch {
        // Fallback to model string below
      }
    }
    return isPiProvider(fallbackModel);
  }

  async wakeCardFromWaiting(
    cardId: string,
    reason: "satisfied" | "timeout" | "script_error" | "board_broken",
    detail: string,
    paseo?: PaseoApi,
    expected?: Pick<ItemUserMeta, "waitMode" | "waitStartedAt">,
  ): Promise<boolean> {
    let transitioned = false;
    let scheduleToDelete: string | null = null;
    let scriptToDelete: string | null = null;
    let boundAgentId: string | null = null;
    let selectedModelFallback: string | null = null;
    let waitMode = "ai" as WaitMode;
    let waitCondition = "外部等待事项";
    let maxTimeoutLabel = "设定上限";
    let lastNote = "";
    const nowIso = new Date().toISOString();

    let effectiveCardId = cardId;
    await updateRadarState((s) => {
      const targetKey = resolveWaitingMetaKey(s.meta, cardId, expected);
      if (!targetKey) {
        return;
      }
      effectiveCardId = targetKey;
      const prev = s.meta[targetKey]!;
      transitioned = true;
      scheduleToDelete = prev.waitScheduleId ?? null;
      scriptToDelete = prev.waitScriptPath ?? null;
      boundAgentId = prev.waitAgentId ?? prev.boundAgentId ?? null;
      selectedModelFallback = prev.selectedModel ?? null;
      waitMode = prev.waitMode ?? "ai";
      waitCondition = prev.waitCondition || "外部等待事项";
      maxTimeoutLabel = prev.waitMaxTimeoutLabel || "maxTimeout";
      lastNote = prev.waitCheckNote || "";

      s.meta[targetKey] = {
        ...prev,
        ...(boundAgentId ? { boundAgentId } : {}),
        customStatus: "needs_me",
        ...buildClearedNeedsMeTagPatch(nowIso),
        lastWaitCheckAt: nowIso,
        waitCheckNote:
          reason === "satisfied"
            ? `已达成等待条件，已转交会话处理：${detail}`
            : reason === "script_error"
              ? `检查异常熔断，已退出等待并转交原会话核查：${detail}`
              : reason === "board_broken"
                ? `所监听的看板目标已失效/取消，已退出等待：${detail}`
                : `已到达最大等待时长（${maxTimeoutLabel}），已退出等待并转交原会话核查`,
        waitAgentId: null,
        waitMode: null,
        waitPredicate: null,
        waitProviderId: null,
        waitBoard: null,
        waitScheduleId: null,
        waitScriptPath: null,
        waitCron: null,
        waitStartedAt: null,
        waitTimeoutAt: null,
        waitMaxTimeoutLabel: null,
        waitConsecutiveErrors: null,
        waitNextRetryAt: null,
        autoArchivedHash: null,
      };
    });

    if (!transitioned) return false;
    this.summaryQueue.invalidateCard(effectiveCardId);

    void recordInsightEvent({
      type: "wait_finished",
      at: nowIso,
      result: reason === "satisfied" ? "matched" : "timed_out",
      mode: waitMode,
      cardId: effectiveCardId,
    });

    this.lastScriptCronSlot.delete(cardId);
    this.lastScriptCronSlot.delete(effectiveCardId);
    await Promise.all([
      this.cleanupWaitSchedule(scheduleToDelete),
      this.cleanupWaitScript(scriptToDelete),
    ]);

    const turnEndToolGuide = buildTurnEndToolGuide(
      await this.isAgentPiProvider(paseo ?? this.paseoHandle, boundAgentId, selectedModelFallback),
    );
    const modeDesc =
      waitMode === "script"
        ? "脚本模式（exit 0 达标 / exit 10 继续等待）"
        : waitMode === "provider"
          ? "Provider 只读检查"
          : waitMode === "board"
            ? "看板监听模式（board）"
            : "AI 模式（wait-evaluator）";
    const wakePrompt =
      reason === "satisfied"
        ? [
            "[等外部条件已达成 · 自动恢复处理]",
            `- 原等待条件：${waitCondition}`,
            `- 监听模式：${modeDesc}`,
            `- 达标结果：${detail}`,
            "",
            "外部等待条件现已达成，请基于当前会话上下文继续推进后续步骤；涉及修改生产数据或对外发送消息前仍须向用户确认。",
            `${turnEndToolGuide}最后给出清晰的最新进展。`,
          ].join("\n")
        : reason === "board_broken"
          ? [
              "[看板监听目标已失效 · 请重新编排或核查]",
              `- 原等待条件：${waitCondition}`,
              `- 详情：${detail}`,
              "",
              "所监听的前置卡片或子卡已取消/缺失，已退出等待。请核查并决定后续动作。",
              `${turnEndToolGuide}`,
            ].join("\n")
          : reason === "script_error"
            ? [
                "[等待外部检查异常熔断 · 请排查修复]",
                `- 原等待条件：${waitCondition}`,
                `- 监听模式：${modeDesc}`,
                `- 异常详情：${detail}`,
                lastNote ? `- 最近一次检查记录：${lastNote}` : "",
                "",
                "监听已达到异常重试上限。请核对检查条件、鉴权及服务状态；修复后重新登记监听，无法恢复时请标记 review 或 input。",
                `${turnEndToolGuide}最后给出明确结论与下一步建议。`,
              ]
                .filter(Boolean)
                .join("\n")
            : [
                "[等待外部超时退出 · 请介入核查]",
                `- 原等待条件：${waitCondition}`,
                `- 监听模式：${modeDesc}`,
                `- 最大等待时长：${maxTimeoutLabel}（已超时未唤醒）`,
                lastNote ? `- 最近一次检查记录：${lastNote}` : "",
                "",
                `该卡片在「等待外部」状态已到达设定的 maxTimeout 仍未满足唤醒条件，现已退出等待。请核查当前外部事项受阻原因（如上游未处理、CI/部署异常、或原监听脚本/条件存在偏差）。${turnEndToolGuide}最后给出明确结论与下一步建议。`,
              ]
                .filter(Boolean)
                .join("\n");

    await this.triggerAgentForCard(effectiveCardId, boundAgentId, wakePrompt, paseo);
    return true;
  }

  async reportAiWaitCheck(
    paseo: PaseoApi,
    input: { cardId: string; ready: boolean; note: string },
  ): Promise<AgentToolResult> {
    this.rememberPaseo(paseo);
    const subKey = decodeSubcardWaitKey(input.cardId);
    if (subKey) {
      return this.coordination.reportAiWaitCheck(
        subKey.parentCardId,
        subKey.subcardId,
        input.ready,
        input.note,
      );
    }
    const cleanNote = input.note.trim();
    if (!input.ready) {
      const nowIso = new Date().toISOString();
      await updateRadarState((s) => {
        const targetKey = resolveWaitingMetaKey(s.meta, input.cardId);
        if (!targetKey) return;
        const prev = s.meta[targetKey]!;
        s.meta[targetKey] = {
          ...prev,
          lastWaitCheckAt: nowIso,
          waitCheckNote: cleanNote,
        };
      });
      return { text: `已记录卡片 ${input.cardId} 本次评估结果（继续等待）` };
    }

    await this.wakeCardFromWaiting(input.cardId, "satisfied", cleanNote, paseo);
    return {
      text: `卡片 ${input.cardId} 已满足外部条件，已退出「等外部」并唤醒原会话进入 AI 处理`,
    };
  }

  private async runCronWaitCheck(cardId: string, meta: ItemUserMeta): Promise<void> {
    if (this.runningCronChecks.has(cardId)) return;
    this.runningCronChecks.add(cardId);
    try {
      let status: "ready" | "pending" | "failed";
      let note: string;
      let threshold = WAIT_SCRIPT_MAX_CONSECUTIVE_ERRORS;
      if (meta.waitMode === "provider") {
        try {
          if (!meta.waitProviderId || !meta.waitPredicate) throw new Error("缺少 Provider 或等待谓词");
          const result = await checkProviderWaitCondition(meta.waitProviderId, meta.waitPredicate);
          status = result.status;
          note = result.note || status;
        } catch (err) {
          status = "failed";
          note = err instanceof Error ? err.message : String(err);
        }
      } else {
        if (!meta.waitScriptPath) return;
        const tail = (s?: string) => s?.trim().split("\n").at(-1)?.trim();
        try {
          const { stdout, stderr } = await execCommand("bash", [meta.waitScriptPath], {
            cwd: waitChecksDir(), timeout: 60_000, maxBuffer: 512 * 1024, env: buildExtendedEnv(),
          });
          status = "ready";
          note = tail(stdout) || tail(stderr) || "监听脚本返回 0";
        } catch (err) {
          const e = err as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string; message?: string };
          const result = classifyWaitScriptFailure(e);
          status = result.kind === "pending" ? "pending" : "failed";
          threshold = result.threshold;
          const detail = status === "pending"
            ? tail(e.stdout) || tail(e.stderr) || "条件尚未满足"
            : tail(e.stderr) || tail(e.stdout) || e.message || "脚本执行异常";
          note = `${detail.slice(0, 150)} (${result.statusTag})`;
        }
      }

      if (status === "ready") {
        await this.wakeCardFromWaiting(cardId, "satisfied", note.slice(0, 200), undefined, meta);
        return;
      }
      const nowMs = Date.now();
      const shouldBreak = await updateRadarState((s) => {
        const id = resolveWaitingMetaKey(s.meta, cardId, meta);
        if (!id) return false;
        const prev = s.meta[id]!;
        const errors = status === "failed" ? (prev.waitConsecutiveErrors ?? 0) + 1 : 0;
        const tripped = status === "failed" && errors >= threshold;
        s.meta[id] = {
          ...prev,
          lastWaitCheckAt: new Date(nowMs).toISOString(),
          waitConsecutiveErrors: errors,
          waitNextRetryAt: errors > 0 && !tripped ? new Date(nowMs + WAIT_SCRIPT_RETRY_BACKOFF_MS).toISOString() : null,
          waitCheckNote: errors ? `[异常 ${errors}/${threshold}] ${note.slice(0, 150)}` : note.slice(0, 180),
        };
        return tripped;
      });
      if (shouldBreak) await this.wakeCardFromWaiting(cardId, "script_error", note.slice(0, 200), undefined, meta);
    } catch (err) {
      console.error("[paseo-radar] wait check failed:", cardId, err);
    } finally {
      this.runningCronChecks.delete(cardId);
    }
  }

  private async tickWaitMonitors(): Promise<void> {
    const [state, rawSettings] = await Promise.all([readRadarState(), this.getRawSettings()]);
    const tz = resolveEffectiveTimeZone(rawSettings.timezone);
    const nowMs = Date.now();
    const { slotKey } = minuteSlotInTimeZone(tz, nowMs);

    for (const [cardId, meta] of Object.entries(state.meta)) {
      if (!meta || normalizeStoredStatus(meta.customStatus) !== "waiting_external") continue;

      // Enforce maxTimeout across all wait modes.
      if (meta.waitTimeoutAt) {
        const deadlineMs = Date.parse(meta.waitTimeoutAt);
        if (!Number.isNaN(deadlineMs) && nowMs >= deadlineMs) {
          await this.wakeCardFromWaiting(cardId, "timeout", "已超过设定的 maxTimeout", undefined, meta);
          continue;
        }
      }

      // Zero-token polling shares cron cadence, retry backoff and circuit breaking.
      if ((meta.waitMode === "script" || meta.waitMode === "provider") && meta.waitCron) {
        if (this.runningCronChecks.has(cardId)) continue;
        if (meta.waitNextRetryAt) {
          const retryAtMs = Date.parse(meta.waitNextRetryAt);
          if (!Number.isNaN(retryAtMs)) {
            if (nowMs >= retryAtMs) {
              this.lastScriptCronSlot.set(cardId, slotKey);
              void this.runCronWaitCheck(cardId, meta);
            }
            continue;
          }
        }
        if (this.lastScriptCronSlot.get(cardId) === slotKey) continue;
        if (meta.lastWaitCheckAt) {
          const lastMs = Date.parse(meta.lastWaitCheckAt);
          if (!Number.isNaN(lastMs) && minuteSlotInTimeZone(tz, lastMs).slotKey === slotKey) {
            this.lastScriptCronSlot.set(cardId, slotKey);
            continue;
          }
        }
        if (meta.waitStartedAt) {
          const startedMs = Date.parse(meta.waitStartedAt);
          if (!Number.isNaN(startedMs) && minuteSlotInTimeZone(tz, startedMs).slotKey === slotKey) {
            this.lastScriptCronSlot.set(cardId, slotKey);
            continue;
          }
        }
        if (matchesCron5InTimeZone(meta.waitCron, tz, nowMs)) {
          this.lastScriptCronSlot.set(cardId, slotKey);
          void this.runCronWaitCheck(cardId, meta);
        }
      }
    }

    await this.coordination.tickSubcardWaitMonitors(tz, nowMs);

    if (this.paseoHandle && nowMs - this.lastEvaluatorReapMs >= 120_000) {
      this.lastEvaluatorReapMs = nowMs;
      await this.reapStaleEvaluatorAgents(this.paseoHandle, state.copilotAgentId, nowMs).catch(() => {});
    }
  }

  private async reapStaleEvaluatorAgents(
    paseo: PaseoApi,
    copilotAgentId: string | null,
    nowMs: number,
  ): Promise<void> {
    const live = await listLiveAgents(paseo).catch(() => [] as PaseoAgent[]);
    const copilotWsIds = new Set<string>();
    for (const a of live) {
      if (a.labels[RADAR_LABELS.role] === RADAR_LABELS.copilotRole || a.id === copilotAgentId) {
        if (a.workspaceId) copilotWsIds.add(a.workspaceId);
      }
    }

    const cli = await resolvePaseoBinary();
    const staleWsIds = new Set<string>();
    for (const a of live) {
      if (!a.cwd || !a.cwd.includes("/.paseo/plugin-data/paseo-radar/")) continue;
      if (a.labels[RADAR_LABELS.role] === RADAR_LABELS.copilotRole || a.id === copilotAgentId) continue;

      const isActive = a.status === "running" || a.status === "initializing";
      const refIso = a.createdAt ?? a.updatedAt ?? "";
      const ageMs = refIso ? nowMs - Date.parse(refIso) : Number.POSITIVE_INFINITY;
      if (isActive && (Number.isNaN(ageMs) || ageMs < 8 * 60 * 1000)) continue;

      if (isActive) {
        await execCommand(cli, ["stop", a.id], { timeout: 8000, env: buildExtendedEnv() }).catch(() => {});
      }
      if (a.workspaceId && !copilotWsIds.has(a.workspaceId)) {
        staleWsIds.add(a.workspaceId);
      }
      await paseo.agents.ref(a.id).archive().catch(() => {});
    }

    for (const wsId of staleWsIds) {
      await paseo.workspaces.archive(wsId).catch(() => {});
    }
  }

  async evaluateOuterBoardWatchers(changedCardId: string, paseo?: PaseoApi): Promise<void> {
    const handle = paseo ?? this.paseoHandle;
    const state = await readRadarState();
    const watchers = Object.entries(state.meta).filter(
      ([id, m]) =>
        id !== changedCardId &&
        m &&
        normalizeStoredStatus(m.customStatus) === "waiting_external" &&
        m.waitMode === "board" &&
        m.waitBoard?.scope === "outer" &&
        m.waitBoard.targets.some((t) => normalizeCardId(t.cardId) === normalizeCardId(changedCardId)),
    );
    if (watchers.length === 0) return;

    const snap = handle ? await this.loadSnapshot(handle).catch(() => null) : null;
    const snapById = new Map((snap?.items ?? []).map((it) => [it.id, it]));
    const lookup = (cid: string) => {
      const nid = normalizeCardId(cid);
      const item = snapById.get(nid) ?? snapById.get(cid);
      if (item) {
        return {
          status: item.status,
          needsMeTag: item.needsMeTag,
          canceled: item.visibility === "dismissed",
        };
      }
      const m = state.meta[nid] ?? state.meta[cid];
      if (!m) {
        // Custom/archived items removed from rawItems are treated as archived if known or missing
        return { status: "archived" as CardStatus, needsMeTag: null };
      }
      const st = normalizeStoredStatus(m.customStatus) ?? "pool";
      return {
        status: st,
        needsMeTag: m.needsMeTag ?? null,
      };
    };

    for (const [watcherId, meta] of watchers) {
      if (!meta.waitBoard) continue;
      const res = evaluateBoardWatch(meta.waitBoard, lookup);
      if (res.state === "satisfied") {
        await this.wakeCardFromWaiting(
          watcherId,
          "satisfied",
          `监听的看板卡片 (${res.matchedIds.join(", ")}) 已满足条件`,
          handle ?? undefined,
        );
      } else if (res.state === "broken") {
        await this.wakeCardFromWaiting(
          watcherId,
          "board_broken",
          `目标卡片 (${res.brokenIds.join(", ")}) 已取消或不存在`,
          handle ?? undefined,
        );
      }
    }
  }

  async enterWaitingExternal(input: {
    cardId: string;
    cardTitle: string;
    callerAgentId?: string | null;
    callerWorkspaceId?: string | null;
    mode: WaitMode;
    predicate?: WaitPredicate;
    condition?: string;
    cron?: string;
    maxTimeout?: string;
    script?: string;
    checkPrompt?: string;
    watch?: {
      targets: Array<{ cardId: string; status?: CardStatus; needsMeTag?: NeedsMeTag | null }>;
      match?: "all" | "any";
      wakeOnException?: boolean;
    };
  }): Promise<AgentToolResult> {
    if (input.mode === "board") {
      if (!input.watch || input.watch.targets.length === 0) {
        return {
          text: "mode=\"board\" 时必须提供至少一个 watch.targets（指定监听的 cardId 与目标 status）",
          isError: true,
        };
      }
      const state = await readRadarState();
      const parentMeta = state.meta[input.cardId];
      const definedOuterIds = new Set([...state.rawItems, ...state.customItems].map((r) => r.id));
      const boardDir = this.coordination.boardDirForCard(input.cardId);
      const innerBoard = parentMeta?.coordinationEnabled ? await readCoordBoard(boardDir) : null;
      const innerIds = new Set((innerBoard?.subcards ?? []).map((s) => s.id));

      const targets = input.watch.targets.map((t) => ({
        cardId: t.cardId.trim(),
        status: t.status ?? ("archived" as CardStatus),
        ...(t.needsMeTag !== undefined ? { needsMeTag: t.needsMeTag } : {}),
      }));

      const pointsToInner =
        Boolean(parentMeta?.coordinationEnabled) &&
        targets.some((t) => innerIds.has(t.cardId) || (!definedOuterIds.has(t.cardId) && !t.cardId.startsWith("ws-")));

      const spec: BoardWatchSpec = {
        scope: pointsToInner ? "inner" : "outer",
        parentCardId: pointsToInner ? input.cardId : null,
        targets,
        match: input.watch.match ?? "all",
        wakeOnException: input.watch.wakeOnException ?? true,
      };
      const condition =
        input.condition?.trim() ||
        `看板监听：${targets.map((t) => `${t.cardId}->${t.status}`).join(spec.match === "any" ? " 或 " : " 且 ")}`;

      const nowMs = Date.now();
      const startedAt = new Date(nowMs).toISOString();
      let timeoutAt: string | null = null;
      let maxTimeoutLabel: string | null = null;
      if (input.maxTimeout?.trim()) {
        const ms = parseMaxTimeoutMs(input.maxTimeout.trim());
        if (ms === null) {
          return {
            text: `maxTimeout "${input.maxTimeout}" 格式无效（请使用如 "2h"、"24h"、"3d"）`,
            isError: true,
          };
        }
        timeoutAt = new Date(nowMs + ms).toISOString();
        maxTimeoutLabel = input.maxTimeout.trim();
      }

      if (spec.scope === "inner") {
        if (!innerBoard) {
          return { text: "当前卡片尚未创建任何内层子卡，无法注册内层看板监听。", isError: true };
        }
        const subMap = new Map(innerBoard.subcards.map((s) => [s.id, s]));
        const evalRes = evaluateBoardWatch(spec, (id) => {
          const s = subMap.get(id);
          return s ? { status: s.status, needsMeTag: s.needsMeTag, canceled: s.canceled } : null;
        });
        if (evalRes.state === "broken") {
          return {
            text: `无法注册看板监听：以下子卡不存在或已取消：${evalRes.brokenIds.join(", ")}`,
            isError: true,
          };
        }
        if (evalRes.state === "satisfied") {
          const lines = evalRes.matchedIds.map((id) => {
            const s = subMap.get(id)!;
            return `- ${s.id}「${s.title}」[${s.status}] ${s.closureEvidence ?? ""}`.trim();
          });
          return {
            text: `所监听的子卡条件已全部满足，无需挂起等待：\n${lines.join("\n")}`,
          };
        }

        let oldSched: string | null = null;
        let oldScript: string | null = null;
        this.summaryQueue.invalidateCard(input.cardId);
        await updateRadarState((s) => {
          const prev = s.meta[input.cardId] ?? {};
          oldSched = prev.waitScheduleId ?? null;
          oldScript = prev.waitScriptPath ?? null;
          s.meta[input.cardId] = {
            ...prev,
            ...(input.callerWorkspaceId ? { boundWorkspaceId: input.callerWorkspaceId } : {}),
            ...(input.callerAgentId ? { boundAgentId: input.callerAgentId } : {}),
            waitAgentId: input.callerAgentId ?? prev.boundAgentId ?? null,
            customStatus: "waiting_external",
            ...buildClearedNeedsMeTagPatch(startedAt),
            waitMode: "board",
            waitPredicate: null,
            waitProviderId: null,
            waitBoard: spec,
            waitCondition: condition,
            waitScheduleId: null,
            waitScriptPath: null,
            waitCron: null,
            waitStartedAt: startedAt,
            waitTimeoutAt: timeoutAt,
            waitMaxTimeoutLabel: maxTimeoutLabel,
            lastWaitCheckAt: null,
            waitCheckNote: null,
            waitConsecutiveErrors: 0,
            waitNextRetryAt: null,
            pendingWakePrompt: null,
          };
        });
        await Promise.all([
          this.cleanupWaitSchedule(oldSched),
          this.cleanupWaitScript(oldScript),
        ]);
        await appendCoordEvent(boardDir, {
          kind: "wait.registered",
          actor: "coordinator",
          summary: `协调者注册看板监听：${condition}`,
        });
        return {
          text: `已进入看板监听（${condition}），条件达成或子卡遇例外时将自动唤醒你。`,
        };
      }

      // Outer card board-watch with DFS cycle detection
      const outerEdges = new Map<string, string[]>();
      for (const [mId, mVal] of Object.entries(state.meta)) {
        if (mVal && normalizeStoredStatus(mVal.customStatus) === "waiting_external" && mVal.waitMode === "board" && mVal.waitBoard?.scope === "outer") {
          outerEdges.set(mId, mVal.waitBoard.targets.map((t) => normalizeCardId(t.cardId)));
        }
      }
      const normSelf = normalizeCardId(input.cardId);
      const cycle = detectBoardWatchCycle(
        outerEdges,
        normSelf,
        spec.targets.map((t) => normalizeCardId(t.cardId)),
      );
      if (cycle) {
        return {
          text: `拒绝注册看板监听：检测到循环等待 (${cycle.join(" → ")})`,
          isError: true,
        };
      }

      const snap = this.paseoHandle ? await this.loadSnapshot(this.paseoHandle).catch(() => null) : null;
      const snapById = new Map((snap?.items ?? []).map((it) => [it.id, it]));
      const evalOuter = evaluateBoardWatch(spec, (cid) => {
        const nid = normalizeCardId(cid);
        const it = snapById.get(nid) ?? snapById.get(cid);
        if (it) return { status: it.status, needsMeTag: it.needsMeTag, canceled: it.visibility === "dismissed" };
        const m = state.meta[nid] ?? state.meta[cid];
        if (!m && !definedOuterIds.has(nid)) return null;
        return { status: normalizeStoredStatus(m?.customStatus) ?? "pool", needsMeTag: m?.needsMeTag ?? null };
      });
      if (evalOuter.state === "broken") {
        return {
          text: `无法注册看板监听：目标卡片不存在或已被忽略 (${evalOuter.brokenIds.join(", ")})`,
          isError: true,
        };
      }
      if (evalOuter.state === "satisfied") {
        return {
          text: `所监听的看板卡片条件已满足 (${evalOuter.matchedIds.join(", ")})，无需进入等待。`,
        };
      }

      let oldSched: string | null = null;
      let oldScript: string | null = null;
      this.summaryQueue.invalidateCard(input.cardId);
      await updateRadarState((s) => {
        const prev = s.meta[input.cardId] ?? {};
        oldSched = prev.waitScheduleId ?? null;
        oldScript = prev.waitScriptPath ?? null;
        const raw = [...s.customItems, ...s.rawItems].find((r) => r.id === input.cardId);
        s.meta[input.cardId] = {
          ...prev,
          ...(input.callerWorkspaceId ? { boundWorkspaceId: input.callerWorkspaceId } : {}),
          ...(input.callerAgentId ? { boundAgentId: input.callerAgentId } : {}),
          waitAgentId: input.callerAgentId ?? prev.boundAgentId ?? null,
          customStatus: "waiting_external",
          ...buildClearedNeedsMeTagPatch(startedAt),
          waitMode: "board",
          waitPredicate: null,
          waitProviderId: null,
          waitBoard: spec,
          waitCondition: condition,
          waitScheduleId: null,
          waitScriptPath: null,
          waitCron: null,
          waitStartedAt: startedAt,
          waitTimeoutAt: timeoutAt,
          waitMaxTimeoutLabel: maxTimeoutLabel,
          lastWaitCheckAt: null,
          waitCheckNote: null,
          waitConsecutiveErrors: 0,
          waitNextRetryAt: null,
          pendingWakePrompt: null,
          autoArchivedHash: raw?.stateHash ?? null,
        };
      });
      await Promise.all([
        this.cleanupWaitSchedule(oldSched),
        this.cleanupWaitScript(oldScript),
      ]);
      return {
        text: `已将卡片 ${input.cardId} 转为看板监听（${condition}）。目标卡片状态达成时将自动唤醒当前会话。`,
      };
    }

    const condition = (input.condition ?? "").trim();
    const cron = (input.cron ?? "").trim();
    const maxTimeoutRaw = (input.maxTimeout ?? "").trim();

    if (!condition || !cron || !maxTimeoutRaw) {
      return {
        text: "provider/script/ai 模式下 condition、cron 与 maxTimeout 均为必填项",
        isError: true,
      };
    }

    if (!parseCron5(cron)) {
      return {
        text: `cron 表达式 "${cron}" 不合法，请提供标准的 5 段 cron（如 "*/5 * * * *" 或 "*/30 10-20 * * *"）`,
        isError: true,
      };
    }

    const timeoutMs = parseMaxTimeoutMs(maxTimeoutRaw);
    if (timeoutMs === null) {
      return {
        text: `maxTimeout "${maxTimeoutRaw}" 格式无效或超出范围（1m ~ 30d），请使用如 "30m"、"2h"、"24h"、"3d" 的格式`,
        isError: true,
      };
    }

    await ensureRadarHome();
    const tz = resolveEffectiveTimeZone((await this.getRawSettings()).timezone);
    const nowMs = Date.now();
    const startedAt = new Date(nowMs).toISOString();
    const timeoutAt = new Date(nowMs + timeoutMs).toISOString();

    let newScheduleId: string | null = null;
    let newScriptPath: string | null = null;
    let predicate: WaitPredicate | null = null;
    let providerId: string | null = null;

    if (input.mode === "provider") {
      const state = await readRadarState();
      const raw = [...state.rawItems, ...state.customItems].find(r => r.id === input.cardId);
      predicate = input.predicate ?? raw?.closureGate?.waitPredicate ?? null;
      providerId = predicate?.providerId?.trim() || raw?.providerId || null;
      if (!predicate || !providerId) {
        return { text: "provider 模式需要 predicate（type、params）；非 Provider 卡片还需指定 predicate.providerId。", isError: true };
      }
    } else if (input.mode === "script") {
      const scriptBody = input.script?.trim();
      if (!scriptBody) {
        return {
          text: "mode=\"script\" 时必须提供非空的 script 脚本内容（达成条件时 exit 0，继续等待时 exit 10）",
          isError: true,
        };
      }
      if (!hasWaitPendingExitCode(scriptBody)) {
        return {
          text: "script 脚本中未检测到约定的「继续等待」退出码 `exit 10`。为避免将脚本错误/网络异常误判为正常等待，请显式使用 `exit 10` 表示条件未满足、继续等待（`exit 0` 表示达标；`exit 1` 及其他非 0/10 退出码将被视为执行异常并触发重试熔断）。",
          isError: true,
        };
      }
      const safeName = input.cardId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      newScriptPath = join(waitScriptsDir(), `${safeName}-${nowMs.toString(36)}.sh`);
      const content = scriptBody.startsWith("#!") ? `${scriptBody}\n` : `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`;
      await writeFile(newScriptPath, content, "utf8");
      await chmod(newScriptPath, 0o755);
      this.lastScriptCronSlot.set(input.cardId, minuteSlotInTimeZone(tz, nowMs).slotKey);
    } else {
      const checkBody = input.checkPrompt?.trim();
      if (!checkBody) {
        return {
          text: "mode=\"ai\" 时必须提供非空的 checkPrompt，写清给 wait-evaluator 的只读检查条件与 ready=true/false 判定标准",
          isError: true,
        };
      }
      const models = await this.getModels(this.paseoHandle);
      const evalModels =
        models.waitEvalModels.length > 0 ? models.waitEvalModels : models.copilotModels;
      if (evalModels.length === 0) {
        return {
          text: "当前服务端未找到可用的评估模型，请在 Radar 设置中配置 wait-evaluator 模型或改用 script 模式。",
          isError: true,
        };
      }

      const fullSchedulePrompt = [
        `你是 Paseo Radar 的独立出列评估模型 wait-evaluator（卡片 cardId: "${input.cardId}"，标题：${input.cardTitle}）。`,
        `等待条件：${condition}`,
        "",
        "【严格只读安全约束】",
        "严禁修改任何仓库代码、生产数据、共享单据或文档，严禁对外发送任何消息、触发部署或重启服务。",
        "",
        "【具体检查与判定条件】",
        checkBody,
        "",
        "【必做结果上报】",
        "每次检查结束（包括查询异常）必须调用 radar_report_wait_check，传入：",
        `- cardId: "${input.cardId}"`,
        "- ready: true（完结条件已达成，退出「等外部」并触发原工作会话继续处理）或 false（尚未满足，继续留在「等外部」）",
        "- note: \"一句话事实检查结论\"",
      ].join("\n");

      let lastErr: unknown = null;
      for (let i = 0; i < evalModels.length; i++) {
        const evalModel = evalModels[i]!;
        try {
          const created = await createDaemonSchedule({
            name: `[Radar 等外部] ${input.cardTitle.slice(0, 28)}`,
            prompt: fullSchedulePrompt,
            cron,
            fullModel: evalModel,
            cwd: waitChecksDir(),
            expiresAt: timeoutAt,
            timezone: tz,
          });
          newScheduleId = created.scheduleId;
          break;
        } catch (err) {
          lastErr = err;
          if (i + 1 < evalModels.length) {
            const nextModel = evalModels[i + 1]!;
            console.warn(
              `[paseo-radar] wait-evaluator schedule model (${evalModel}) failed, falling back to (${nextModel}):`,
              err,
            );
            this.recordModelAlert({
              key: `agent:等待评估:fallback:${evalModel}`,
              role: "等待评估",
              model: evalModel,
              fallbackModel: nextModel,
              severity: "warning",
              message: formatModelErrorMessage(err),
              cardTitle: input.cardTitle,
              cardId: input.cardId,
              retryable: false,
            });
          }
        }
      }
      if (!newScheduleId) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        return {
          text: `创建 wait-evaluator 定时评估任务失败：${msg}。请检查 cron 表达式后重新调用 radar_mark_waiting_external。`,
          isError: true,
        };
      }
    }

    let oldScheduleId: string | null = null;
    let oldScriptPath: string | null = null;
    this.summaryQueue.invalidateCard(input.cardId);
    await updateRadarState((s) => {
      const prev = s.meta[input.cardId] ?? {};
      oldScheduleId = prev.waitScheduleId ?? null;
      oldScriptPath = prev.waitScriptPath ?? null;
      const raw = [...s.customItems, ...s.rawItems].find((r) => r.id === input.cardId);
      s.meta[input.cardId] = {
        ...prev,
        ...(input.callerWorkspaceId ? { boundWorkspaceId: input.callerWorkspaceId } : {}),
        ...(input.callerAgentId ? { boundAgentId: input.callerAgentId } : {}),
        waitAgentId: input.callerAgentId ?? prev.boundAgentId ?? null,
        customStatus: "waiting_external",
        ...buildClearedNeedsMeTagPatch(startedAt),
        waitMode: input.mode,
        waitProviderId: providerId,
        waitPredicate: predicate,
        waitCondition: condition,
        waitBoard: null,
        waitScheduleId: newScheduleId,
        waitScriptPath: newScriptPath,
        waitCron: cron,
        waitStartedAt: startedAt,
        waitTimeoutAt: timeoutAt,
        waitMaxTimeoutLabel: maxTimeoutRaw,
        lastWaitCheckAt: null,
        waitCheckNote: null,
        waitConsecutiveErrors: 0,
        waitNextRetryAt: null,
        pendingWakePrompt: null,
        autoArchivedHash: raw?.stateHash ?? null,
      };
    });

    if (oldScheduleId && oldScheduleId !== newScheduleId) {
      await this.cleanupWaitSchedule(oldScheduleId);
    }
    if (oldScriptPath && oldScriptPath !== newScriptPath) {
      await this.cleanupWaitScript(oldScriptPath);
    }

    return {
      text: `已将卡片 ${input.cardId} 转为「等外部」（模式: ${input.mode}，cron: "${cron}"，maxTimeout: ${maxTimeoutRaw}，超时时间: ${timeoutAt}）。条件满足或超时后系统将自动重新唤醒当前会话处理。`,
    };
  }

  async replyToCardSession(
    paseo: PaseoApi,
    input: {
      itemId: string;
      agentId?: string;
      text: string;
      decisionApproval?: {
        edited: boolean;
        title?: string | null;
        target?: string | null;
        draft?: string | null;
      };
    },
  ): Promise<{ agentId: string }> {
    this.rememberPaseo(paseo);
    const extraText = input.text.trim();
    const approval = input.decisionApproval;

    let msg = extraText;
    if (approval) {
      const hasDraft = approval.draft !== undefined && approval.draft !== null && approval.draft.trim() !== "";
      if (hasDraft) {
        const lines: string[] = ["[已在 Radar 卡片确认执行 · 无需重复弹窗确认]"];
        if (approval.title?.trim()) lines.push(`动作：${approval.title.trim()}`);
        if (approval.target?.trim()) lines.push(`目标：${approval.target.trim()}`);
        lines.push(
          approval.edited
            ? "审阅结果：用户已修改草稿，请严格按下方确认终稿执行（禁止使用确认前的旧草稿，保留换行和缩进）。"
            : "审阅结果：草稿已确认，请严格按下方确认终稿执行（保留换行和缩进）。",
        );
        lines.push("", "--- 确认终稿开始 ---", approval.draft!, "--- 确认终稿结束 ---");
        if (extraText) {
          lines.push("", `补充说明：${extraText}`);
        }
        msg = lines.join("\n");
      } else {
        const lines: string[] = ["[已在 Radar 卡片确认授权 · 无需重复确认]"];
        if (approval.title?.trim()) lines.push(`动作：${approval.title.trim()}`);
        if (approval.target?.trim()) lines.push(`目标：${approval.target.trim()}`);
        lines.push(extraText || "请按上述方案执行。");
        msg = lines.join("\n");
      }
    }

    if (!msg) throw new Error("回复内容不能为空");

    const snap = await this.loadSnapshot(paseo);
    const card = snap.items.find((c) => c.id === input.itemId);
    if (!card || !card.workspace) throw new Error("该卡片尚未关联活跃会话");

    const proposalAgentId =
      approval && card.decisionProposal?.agentId && card.workspace.agentIds.includes(card.decisionProposal.agentId)
        ? card.decisionProposal.agentId
        : undefined;
    const targetAgentId = input.agentId ?? proposalAgentId ?? card.workspace.primaryAgentId;
    if (!targetAgentId) throw new Error("未找到可发送的会话");

    this.markAgentTurnPending(targetAgentId);
    await paseo.agents.ref(targetAgentId).send(msg, { activeTurnBehavior: "steer" });

    if (approval) {
      void recordInsightEvent({
        type: "decision_replied",
        at: new Date().toISOString(),
        edited: Boolean(approval.edited),
        cardId: card.id,
      });
    }

    const clearedAt = new Date().toISOString();
    this.summaryQueue.invalidateCard(card.id);
    await updateRadarState((s) => {
      s.meta[card.id] = {
        ...s.meta[card.id],
        boundWorkspaceId: card.workspace!.workspaceId,
        boundAgentId: targetAgentId,
        customStatus: "needs_me",
        ...buildClearedNeedsMeTagPatch(clearedAt),
      };
    });

    return { agentId: targetAgentId };
  }

  async requestWaitExternal(
    paseo: PaseoApi,
    input: { itemId: string; agentId?: string; note: string },
  ): Promise<{ agentId: string }> {
    this.rememberPaseo(paseo);
    const userNote = input.note.trim();
    if (!userNote) throw new Error("请附上等待外部的具体说明。");

    const snap = await this.loadSnapshot(paseo);
    const card = snap.items.find((c) => c.id === input.itemId);
    if (!card) throw new Error("未找到卡片 " + input.itemId);

    const stateBefore = await readRadarState();
    const prevMeta = stateBefore.meta[card.id];
    if (prevMeta?.waitScheduleId) {
      await this.cleanupWaitSchedule(prevMeta.waitScheduleId);
    }
    if (prevMeta?.waitScriptPath) {
      await this.cleanupWaitScript(prevMeta.waitScriptPath);
    }

    let targetAgentId =
      (input.agentId && card.workspace?.agentIds.includes(input.agentId)
        ? input.agentId
        : null) ??
      card.workspace?.primaryAgentId ??
      null;
    let targetWsId = card.workspace?.workspaceId ?? null;
    const modelsForDefault = targetAgentId ? null : await this.getModels(paseo);
    const targetIsPi = await this.isAgentPiProvider(
      paseo,
      targetAgentId,
      card.selectedModel || modelsForDefault?.resolved.defaultWorkerModel,
    );

    const promptForAi = [
      `用户希望将当前卡片（cardId: "${card.id}"，标题：${card.title}）转为「等外部」状态，附上的说明为：`,
      `「${userNote}」`,
      card.links.length > 0
        ? `关联外部信源：${card.links.map((l) => `${l.label} (${l.url})`).join(" 、 ")}`
        : card.url
          ? `关联链接：${card.url}`
          : "",
      "",
      "请你结合当前上下文先判断「完结条件是否已经成熟」：",
      "1. **若条件不成熟**（缺少具体的检查入口链接/单号，或完结标准含糊不清）：**不要调用 `radar_mark_waiting_external`**，保持卡片在「等我处理」，直接用 1~2 句精炼说明还需要用户补充哪些具体信息。",
      `2. **若条件已成熟**（拥有明确、可只读检查的完结动作）：请调用 \`radar_mark_waiting_external\`（传入 \`cardId: "${card.id}"\`${targetIsPi ? "；可在 `codemode` 内调 `await tools.mcp__paseo__radar_mark_waiting_external(...)`" : ""}），并根据条件复杂度选择模式及合理的 \`cron\` 与 \`maxTimeout\`（如 \`2h\`、\`24h\`、\`3d\`）：`,
      "   - 若来源支持等待谓词，优先使用 `mode: \"provider\"` 做零 token 只读检查，可传 `predicate` 或使用卡片预设。",
      "   - 其他可固化的条件用 `mode: \"script\"`：只读 bash 脚本达标时 exit 0，继续等待时 exit 10，其他退出码按异常处理。",
      "   - **AI 模式（`mode: \"ai\"`）**：适用于难以直接用脚本表达的复杂语义检查，填写 `checkPrompt`，系统会定期唤醒独立的便宜 `wait-evaluator` 模型检查。",
      "   （注意：无论达标唤醒还是超过 `maxTimeout` 强制退出，系统都会自动重新唤醒你继续处理；**严禁自行调用 create_schedule 或 create_heartbeat**。）",
    ]
      .filter(Boolean)
      .join("\n");

    if (!targetAgentId) {
      const started = await this.followItem(paseo, {
        itemId: card.id,
        mode: "background",
        note: promptForAi,
      });
      targetAgentId = started.agentId;
      targetWsId = started.workspaceId;
    } else {
      this.markAgentTurnPending(targetAgentId);
      await paseo.agents.ref(targetAgentId).send(promptForAi, { activeTurnBehavior: "steer" });
    }

    // Do NOT switch to waiting_external prematurely; only radar_mark_waiting_external transitions it once AI confirms maturity!
    this.summaryQueue.invalidateCard(card.id);
    await updateRadarState((s) => {
      s.meta[card.id] = {
        ...s.meta[card.id],
        boundWorkspaceId: targetWsId,
        boundAgentId: targetAgentId,
        customStatus: "needs_me",
        ...buildClearedNeedsMeTagPatch(new Date().toISOString()),
        waitAgentId: null,
        waitMode: null,
        waitPredicate: null,
        waitProviderId: null,
        waitScheduleId: null,
        waitScriptPath: null,
        waitCron: null,
        waitStartedAt: null,
        waitTimeoutAt: null,
        waitMaxTimeoutLabel: null,
        waitCheckNote: null,
      };
    });

    return { agentId: targetAgentId };
  }

  async loadSnapshot(paseo: PaseoApi): Promise<RadarSnapshot> {
    this.rememberPaseo(paseo);
    const [state, models] = await Promise.all([readRadarState(), this.getModels(paseo)]);
    const effectiveTz = resolveEffectiveTimeZone(models.timezone);
    if (state.lastScanAt === null && models.autoScanEnabled && !this.isScanning) {
      void this.scan().catch((err: unknown) => console.error("[paseo-radar] lazy scan failed:", err));
    }

    const [projects, workspaces, liveAgents, collectorInfo] = await Promise.all([
      listUserProjects(paseo),
      listLiveWorkspaces(paseo).catch(() => [] as PaseoWorkspace[]),
      listLiveAgents(paseo).catch(() => [] as PaseoAgent[]),
      listCollectorScripts(state.collectorDiagnostics),
    ]);

    const projectById = new Map(projects.map((p) => [p.projectId, p]));
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
    const agentsByWs = new Map<string, PaseoAgent[]>();
    const agentById = new Map<string, PaseoAgent>();

    for (const a of liveAgents) {
      agentById.set(a.id, a);
      if (a.workspaceId) {
        const list = agentsByWs.get(a.workspaceId) ?? [];
        list.push(a);
        agentsByWs.set(a.workspaceId, list);
      }
    }

    const claimedWsIds = new Set<string>();
    const metaKeysToDelete = new Set<string>();
    const nowMs = Date.now();
    const cards: RadarItem[] = [];
    const metaPatches: Record<string, Partial<ItemUserMeta>> = {};

    // Reconcile custom-* cards that have now been superseded by an official scanned rawItem
    const rawEntityCache = state.rawItems.map((r) => ({
      raw: r,
      keys: rawItemEntityKeys(r),
    }));
    const supersededCustomIds = new Set<string>();
    const customIdsToDelete = new Set<string>();
    for (const custom of state.customItems) {
      const cMeta = state.meta[custom.id];
      if (normalizeStoredStatus(cMeta?.customStatus) === "archived") {
        supersededCustomIds.add(custom.id);
        customIdsToDelete.add(custom.id);
        metaKeysToDelete.add(custom.id);
        continue;
      }
      const cKeys = extractCanonicalEntityKeys({
        title: custom.title,
        summary: custom.summary,
        url: custom.url,
        links: custom.links,
        prompt: custom.prepPrompt,
        relatedKeys: custom.relatedKeys,
      });
      const matchedRaw = rawEntityCache.find(({ raw, keys }) => {
        const rMeta = state.meta[raw.id];
        if (cMeta?.boundWorkspaceId && rMeta?.boundWorkspaceId && cMeta.boundWorkspaceId === rMeta.boundWorkspaceId) {
          return true;
        }
        return cKeys.size > 0 && setsIntersect(cKeys, keys);
      })?.raw;

      if (matchedRaw) {
        supersededCustomIds.add(custom.id);
        const rMeta = state.meta[matchedRaw.id];
        const carriedLinks = resolveItemLinks({
          attachedLinks: cMeta?.attachedLinks,
          removedLinkKeys: cMeta?.removedLinkKeys,
          url: custom.url,
          secondaryUrl: custom.secondaryUrl,
          links: custom.links,
          extraLinks: cMeta?.extraLinks,
          title: custom.title,
          summary: custom.summary,
          prompt: custom.prepPrompt,
          relatedKeys: custom.relatedKeys,
        });
        if (carriedLinks.length > 0 || (cMeta?.attachedLinks && cMeta.attachedLinks.length > 0)) {
          metaPatches[matchedRaw.id] = {
            ...rMeta,
            ...metaPatches[matchedRaw.id],
            ...(cMeta?.attachedLinks && cMeta.attachedLinks.length > 0
              ? {
                  attachedLinks: mergeAttachedLinks(
                    rMeta?.attachedLinks,
                    metaPatches[matchedRaw.id]?.attachedLinks,
                    cMeta.attachedLinks,
                  ),
                }
              : {}),
            extraLinks: mergeRadarLinks(rMeta?.extraLinks, metaPatches[matchedRaw.id]?.extraLinks, carriedLinks),
          };
        }
        if (cMeta && !rMeta?.boundWorkspaceId && cMeta.boundWorkspaceId) {
          metaPatches[matchedRaw.id] = {
            ...rMeta,
            ...metaPatches[matchedRaw.id],
            boundWorkspaceId: cMeta.boundWorkspaceId,
            boundAgentId: cMeta.boundAgentId ?? null,
            ...(cMeta.prepSummary && !rMeta?.prepSummary
              ? { prepSummary: cMeta.prepSummary, prepSummarySig: cMeta.prepSummarySig ?? null }
              : {}),
            ...(cMeta.goal && !rMeta?.goal ? { goal: cMeta.goal } : {}),
            ...(cMeta.coordinationEnabled && !rMeta?.coordinationEnabled
              ? { coordinationEnabled: true }
              : {}),
            ...(cMeta.subcardWorkspaceIds && cMeta.subcardWorkspaceIds.length > 0
              ? {
                  subcardWorkspaceIds: [
                    ...new Set([...(rMeta?.subcardWorkspaceIds ?? []), ...cMeta.subcardWorkspaceIds]),
                  ],
                }
              : {}),
            ...(cMeta.needsMeTag && !rMeta?.needsMeTag
              ? {
                  needsMeTag: cMeta.needsMeTag,
                  needsMeTagLocked: cMeta.needsMeTagLocked ?? false,
                  needsMeTagAgentId: cMeta.needsMeTagAgentId ?? cMeta.boundAgentId ?? null,
                  needsMeTagUpdatedAt: cMeta.needsMeTagUpdatedAt ?? null,
                  ...(cMeta.needsMeTag === "decision" && cMeta.decisionProposal && !rMeta?.decisionProposal
                    ? { decisionProposal: cMeta.decisionProposal }
                    : {}),
                }
              : {}),
            ...(cMeta.waitMode && !rMeta?.waitMode
              ? {
                  customStatus: cMeta.customStatus ?? null,
                  waitAgentId: cMeta.waitAgentId ?? cMeta.boundAgentId ?? null,
                  waitMode: cMeta.waitMode,
                  waitPredicate: cMeta.waitPredicate ?? null,
                  waitProviderId: cMeta.waitProviderId ?? null,
                  waitConsecutiveErrors: cMeta.waitConsecutiveErrors ?? null,
                  waitNextRetryAt: cMeta.waitNextRetryAt ?? null,
                  waitCondition: cMeta.waitCondition ?? null,
                  waitBoard: cMeta.waitBoard ?? null,
                  waitScheduleId: cMeta.waitScheduleId ?? null,
                  waitScriptPath: cMeta.waitScriptPath ?? null,
                  waitCron: cMeta.waitCron ?? null,
                  waitStartedAt: cMeta.waitStartedAt ?? null,
                  waitTimeoutAt: cMeta.waitTimeoutAt ?? null,
                  waitMaxTimeoutLabel: cMeta.waitMaxTimeoutLabel ?? null,
                }
              : {}),
          };
        }
        metaPatches[custom.id] = {
          ...cMeta,
          ...metaPatches[custom.id],
          boundWorkspaceId: null,
          boundAgentId: null,
          customStatus: "archived",
          dismissedHash: custom.stateHash,
          autoArchivedAt: new Date().toISOString(),
          autoArchivedHash: custom.stateHash,
        };
      }
    }

    // Reconcile items already absorbed via migratedFromIds so donors never fall back into Pool
    const preCandidateItems = [...state.rawItems, ...state.customItems].filter(
      (r) => !supersededCustomIds.has(r.id),
    );
    const activeLocalWsCardIds = new Set(
      workspaces
        .filter((w) => (agentsByWs.get(w.id) ?? []).some(isUserConversationAgent))
        .map((w) => `ws-${w.id}`),
    );
    const activeTargetIds = new Set<string>([
      ...preCandidateItems.map((r) => r.id),
      ...activeLocalWsCardIds,
    ]);
    const migratedSuperseded = findMigratedSupersededItems({
      candidates: preCandidateItems,
      activeTargetIds,
      meta: state.meta,
      normalizeCardId,
      resolveItemLinks,
    });
    for (const [targetId, carried] of Object.entries(migratedSuperseded.carriedLinksByTarget)) {
      const tMeta = state.meta[targetId];
      metaPatches[targetId] = {
        ...tMeta,
        ...metaPatches[targetId],
        extraLinks: mergeRadarLinks(tMeta?.extraLinks, metaPatches[targetId]?.extraLinks, carried),
      };
    }
    for (const k of migratedSuperseded.metaKeysToDelete) {
      metaKeysToDelete.add(k);
    }

    // Authoritative external rawItems claim workspaces BEFORE customItems
    const activeDefinedItems = preCandidateItems.filter(
      (r) => !migratedSuperseded.supersededIds.has(r.id),
    );
    const rawById = new Map(activeDefinedItems.map((r) => [r.id, r]));
    const definedIds = new Set(rawById.keys());

    const primaryKeyOwners = new Map<string, Set<string>>();
    const explicitlyBoundWsIds = new Set<string>();
    for (const r of activeDefinedItems) {
      const rMeta = { ...state.meta[r.id], ...metaPatches[r.id] };
      if (rMeta.boundWorkspaceId && wsById.has(rMeta.boundWorkspaceId)) {
        explicitlyBoundWsIds.add(rMeta.boundWorkspaceId);
      } else {
        const lblAgent =
          liveAgents.find((a) => getAgentCardLabel(a) === r.id) ??
          (rMeta.boundAgentId ? agentById.get(rMeta.boundAgentId) : undefined);
        if (lblAgent?.workspaceId && wsById.has(lblAgent.workspaceId)) {
          explicitlyBoundWsIds.add(lblAgent.workspaceId);
        }
      }
      const pKeys = extractCanonicalEntityKeys({ cardId: r.id, url: r.url });
      for (const k of pKeys) {
        const owners = primaryKeyOwners.get(k) ?? new Set<string>();
        owners.add(r.id);
        primaryKeyOwners.set(k, owners);
      }
    }

    const subcardWsIds = new Set<string>();
    for (const m of Object.values(state.meta)) {
      for (const wsId of m?.subcardWorkspaceIds ?? []) {
        subcardWsIds.add(wsId);
      }
    }
    for (const a of liveAgents) {
      if (isSubcardAgent(a) && a.workspaceId) {
        const parentCardId = a.labels[RADAR_LABELS.parentCard];
        const parentWsId = parentCardId ? state.meta[parentCardId]?.boundWorkspaceId : null;
        if (!parentWsId || a.workspaceId !== parentWsId) {
          subcardWsIds.add(a.workspaceId);
        }
      }
    }

    const candidateWorkspaces = workspaces
      .filter(
        (w) =>
          !subcardWsIds.has(w.id) &&
          !isInternalPluginPath(w.projectRootPath) &&
          !isInternalPluginPath(w.workspaceDirectory) &&
          (agentsByWs.get(w.id) ?? []).some(isUserConversationAgent),
      )
      .sort((a, b) => {
        const aUp = agentsByWs.get(a.id)?.[0]?.updatedAt ?? "";
        const bUp = agentsByWs.get(b.id)?.[0]?.updatedAt ?? "";
        return bUp.localeCompare(aUp);
      });

    const wsEntityKeysById = new Map<string, Set<string>>();
    for (const w of candidateWorkspaces) {
      const wAgents = (agentsByWs.get(w.id) ?? []).filter(isUserConversationAgent);
      const wAgentIds = new Set(wAgents.map((a) => a.id));
      const keys = extractCanonicalEntityKeys({
        title: wAgents.map((a) => decodeSafe(a.title)).join("\n"),
        branchHint: `${decodeSafe(w.name)}\n${w.workspaceDirectory ?? ""}`,
      });
      for (const a of wAgents) {
        const lbl = getAgentCardLabel(a);
        if (lbl) {
          for (const k of extractCanonicalEntityKeys({ cardId: lbl })) keys.add(k);
        }
      }
      const localWsMeta = state.meta[`ws-${w.id}`];
      if (localWsMeta) {
        for (const k of extractCanonicalEntityKeys({
          links: [...(localWsMeta.attachedLinks ?? []), ...(localWsMeta.extraLinks ?? [])],
        })) {
          keys.add(k);
        }
      }
      for (const [mId, mVal] of Object.entries(state.meta)) {
        if (!mVal || definedIds.has(mId) || mId.startsWith("ws-")) continue;
        if (mVal.boundWorkspaceId === w.id || (mVal.boundAgentId && wAgentIds.has(mVal.boundAgentId))) {
          for (const k of extractCanonicalEntityKeys({
            cardId: mId,
            links: [...(mVal.attachedLinks ?? []), ...(mVal.extraLinks ?? [])],
          })) {
            keys.add(k);
          }
        }
      }
      wsEntityKeysById.set(w.id, keys);
    }

    for (const raw of activeDefinedItems) {
      const meta = { ...state.meta[raw.id], ...metaPatches[raw.id] };
      let matchedWs: PaseoWorkspace | undefined;

      if (meta?.boundWorkspaceId && wsById.has(meta.boundWorkspaceId) && !claimedWsIds.has(meta.boundWorkspaceId)) {
        matchedWs = wsById.get(meta.boundWorkspaceId);
      }
      if (!matchedWs) {
        const labeledAgent =
          liveAgents.find((a) => getAgentCardLabel(a) === raw.id) ??
          (meta?.boundAgentId ? agentById.get(meta.boundAgentId) : undefined);
        if (labeledAgent?.workspaceId && wsById.has(labeledAgent.workspaceId) && !claimedWsIds.has(labeledAgent.workspaceId)) {
          matchedWs = wsById.get(labeledAgent.workspaceId);
        }
      }
      if (!matchedWs) {
        const primaryKeys = extractCanonicalEntityKeys({ cardId: raw.id, url: raw.url });
        const allKeys = rawItemEntityKeys(raw);
        const claimableKeys = new Set<string>();
        for (const k of allKeys) {
          if (primaryKeys.has(k)) {
            claimableKeys.add(k);
            continue;
          }
          const owners = primaryKeyOwners.get(k);
          const ownedByOtherLiveCard = owners ? [...owners].some((id) => id !== raw.id) : false;
          if (!ownedByOtherLiveCard) {
            claimableKeys.add(k);
          }
        }
        if (claimableKeys.size > 0) {
          for (const w of candidateWorkspaces) {
            if (claimedWsIds.has(w.id) || explicitlyBoundWsIds.has(w.id)) continue;
            const wKeys = wsEntityKeysById.get(w.id);
            if (wKeys && setsIntersect(claimableKeys, wKeys)) {
              matchedWs = w;
              break;
            }
          }
        }
      }

      if (matchedWs && (agentsByWs.get(matchedWs.id) ?? []).length === 0 && meta?.boundAgentId && !agentById.has(meta.boundAgentId)) {
        matchedWs = undefined;
      }

      let baseMeta: ItemUserMeta | undefined = meta;
      if (matchedWs) {
        claimedWsIds.add(matchedWs.id);
        const wsAgentsForDonor = (agentsByWs.get(matchedWs.id) ?? []).filter(isUserConversationAgent);
        const wsAgentIds = new Set(wsAgentsForDonor.map((a) => a.id));
        const wsAgentLabels = new Set(
          wsAgentsForDonor.map((a) => getAgentCardLabel(a)).filter((x): x is string => Boolean(x)),
        );
        const donorIds = Object.entries(state.meta)
          .filter(([mId, mVal]) => {
            if (!mVal || mId === raw.id || definedIds.has(mId)) return false;
            if (
              !mId.startsWith("ws-") &&
              normalizeStoredStatus(mVal.customStatus) === "archived" &&
              !mVal.boundWorkspaceId &&
              !mVal.boundAgentId
            ) {
              return false;
            }
            if (mId === `ws-${matchedWs!.id}`) return true;
            if (mVal.boundWorkspaceId === matchedWs!.id) return true;
            if (mVal.boundAgentId && wsAgentIds.has(mVal.boundAgentId)) return true;
            if (wsAgentLabels.has(mId)) return true;
            return false;
          })
          .map(([mId]) => mId)
          .sort((a, b) => Number(a.startsWith("ws-")) - Number(b.startsWith("ws-")));

        for (const donorId of donorIds) {
          const donorMeta = state.meta[donorId];
          if (!donorMeta) continue;
          metaKeysToDelete.add(donorId);
          const merged = mergeDonorMetaIntoTarget(baseMeta, donorMeta, donorId, raw.stateHash);
          baseMeta = merged;
          metaPatches[raw.id] = merged;
        }
      }

      const wsUserAgents = matchedWs
        ? (agentsByWs.get(matchedWs.id) ?? []).filter(isUserConversationAgent)
        : [];
      const linked = matchedWs
        ? buildLinkedWorkspace(
            matchedWs,
            wsUserAgents,
            baseMeta,
            models.resolved.defaultWorkerModel,
            this.summaryQueue.isSummarizing(raw.id),
          )
        : null;

      const hasLiveBoundAgent = Boolean(
        baseMeta?.boundAgentId && wsUserAgents.some((a) => a.id === baseMeta!.boundAgentId),
      );
      const resolvedBoundAgentId = hasLiveBoundAgent
        ? baseMeta!.boundAgentId!
        : (linked?.primaryAgentId ?? null);
      if (
        linked &&
        (baseMeta?.boundWorkspaceId !== linked.workspaceId ||
          baseMeta?.boundAgentId !== resolvedBoundAgentId)
      ) {
        const bindPatch: Partial<ItemUserMeta> = {
          boundWorkspaceId: linked.workspaceId,
          boundAgentId: resolvedBoundAgentId,
        };
        metaPatches[raw.id] = {
          ...metaPatches[raw.id],
          ...bindPatch,
        };
        baseMeta = { ...baseMeta, ...bindPatch };
      }

      let effectiveMeta: ItemUserMeta | undefined = baseMeta;
      if (
        linked &&
        linked.primaryAgentId !== null &&
        normalizeStoredStatus(effectiveMeta?.customStatus) === "archived"
      ) {
        // Self-heal: an unarchived conversation exists, so clear stale archived status
        const healPatch: Partial<ItemUserMeta> = {
          customStatus: "needs_me",
          autoArchivedAt: null,
          autoArchivedHash: null,
        };
        metaPatches[raw.id] = { ...metaPatches[raw.id], ...healPatch };
        effectiveMeta = { ...effectiveMeta, ...healPatch };
      } else if (!linked && (baseMeta?.boundWorkspaceId || baseMeta?.boundAgentId)) {
        const patch: Partial<ItemUserMeta> = {
          boundWorkspaceId: null,
          boundAgentId: null,
          awaitingDecision: false,
          customStatus: "archived",
          autoArchivedAt: new Date().toISOString(),
          autoArchivedHash: raw.stateHash,
        };
        metaPatches[raw.id] = { ...metaPatches[raw.id], ...patch };
        effectiveMeta = { ...baseMeta, ...patch };
      }

      const normCustom = normalizeStoredStatus(effectiveMeta?.customStatus);
      const hasActiveWaitMonitor = Boolean(effectiveMeta?.waitScheduleId || effectiveMeta?.waitScriptPath || effectiveMeta?.waitMode === "provider");
      if (
        effectiveMeta?.autoArchivedHash &&
        effectiveMeta.autoArchivedHash !== raw.stateHash &&
        (normCustom === "archived" || (normCustom === "waiting_external" && !hasActiveWaitMonitor))
      ) {
        metaPatches[raw.id] = {
          ...metaPatches[raw.id],
          customStatus: linked?.primaryAgentId ? "needs_me" : null,
          autoArchivedHash: null,
          autoArchivedAt: null,
          waitCheckNote: "检测到远端新变动，已自动唤醒",
        };
        effectiveMeta = {
          ...effectiveMeta,
          customStatus: linked?.primaryAgentId ? "needs_me" : null,
          autoArchivedHash: null,
          autoArchivedAt: null,
          waitCheckNote: "检测到远端新变动，已自动唤醒",
        };
      }

      const extReplyAfterTag = findUserReplyAfterTag(effectiveMeta, wsUserAgents);
      if (extReplyAfterTag) {
        this.summaryQueue.invalidateCard(raw.id);
        const clearPatch = buildClearedNeedsMeTagPatch(extReplyAfterTag.clearedAt);
        metaPatches[raw.id] = { ...metaPatches[raw.id], ...clearPatch };
        effectiveMeta = { ...effectiveMeta, ...clearPatch };
      }

      const suggestedProj = suggestProject(raw, projects);
      const chosenProj =
        (matchedWs && projectById.get(matchedWs.projectId)) ??
        (effectiveMeta?.selectedProjectId ? projectById.get(effectiveMeta.selectedProjectId) : undefined) ??
        suggestedProj;

      const configuredDefault = resolveConfiguredDefaultModel(raw, models);
      const livePrimary = linked?.primaryAgentId ? agentById.get(linked.primaryAgentId) : undefined;
      // Single source of truth: once a conversation exists, always mirror its actual live model!
      const selectedModel = livePrimary
        ? formatFullModel(livePrimary, configuredDefault)
        : (effectiveMeta?.selectedModel ?? configuredDefault);
      const status = resolveCardStatus(linked, effectiveMeta);
      const { visibility, snoozedUntil } = itemVisibility(raw.stateHash, effectiveMeta, nowMs);
      const needsWorktree = raw.preferWorktree ?? Boolean(raw.existingBranch || raw.workLabel?.includes("分支"));

      const kickoff = buildKickoffPrompt("background", raw);
      const labelContext = [linked?.prepSummary, kickoff].filter(Boolean).join("\n");
      const links = resolveItemLinks({
        attachedLinks: effectiveMeta?.attachedLinks,
        removedLinkKeys: effectiveMeta?.removedLinkKeys,
        url: raw.url,
        secondaryUrl: raw.secondaryUrl,
        links: raw.links,
        extraLinks: effectiveMeta?.extraLinks,
        title: raw.title,
        summary: raw.summary,
        ...(labelContext ? { labelContext } : {}),
        prompt: kickoff,
        relatedKeys: raw.relatedKeys,
        branchHint: raw.existingBranch ?? matchedWs?.name ?? null,
      });

      const effectiveTag = status === "needs_me" ? (effectiveMeta?.needsMeTag ?? null) : null;
      cards.push({
        id: raw.id,
        source: raw.source,
        archetype: raw.archetype,
        group: raw.group,
        badge: raw.badge,
        title: raw.title,
        summary: raw.summary,
        url: links[0]?.url ?? null,
        secondaryUrl: raw.secondaryUrl ?? null,
        links,
        updatedAt: linked?.updatedAt ?? raw.updatedAt,
        stateHash: raw.stateHash,
        projectId: chosenProj?.projectId ?? null,
        projectName: chosenProj?.name ?? (matchedWs ? matchedWs.projectDisplayName : null),
        selectedModel,
        status,
        needsMeTag: effectiveTag,
        decisionProposal: effectiveTag === "decision" ? (effectiveMeta?.decisionProposal ?? null) : null,
        needsWorktree,
        visibility,
        snoozedUntil,
        waitMode: effectiveMeta?.waitMode ?? null,
        waitCondition: effectiveMeta?.waitCondition ?? null,
        waitBoard: effectiveMeta?.waitBoard ?? null,
        waitScheduleId: effectiveMeta?.waitScheduleId ?? null,
        waitCron: effectiveMeta?.waitCron ?? null,
        waitTimeoutAt: effectiveMeta?.waitTimeoutAt ?? null,
        waitCheckNote: effectiveMeta?.waitCheckNote ?? null,
        lastWaitCheckAt: effectiveMeta?.lastWaitCheckAt ?? null,
        goal: effectiveMeta?.goal ?? null,
        coordination: null,
        workspace: linked,
      });
    }

    // 2. Remaining active user workspaces automatically get their own Card (when trackLocalWorkspaces is enabled or goal is bound)
    for (const ws of workspaces) {
      if (claimedWsIds.has(ws.id) || subcardWsIds.has(ws.id)) continue;
      if (!models.trackLocalWorkspaces && !state.meta[`ws-${ws.id}`]?.goal) continue;
      if (isInternalPluginPath(ws.projectRootPath) || isInternalPluginPath(ws.workspaceDirectory)) {
        if (state.meta[`ws-${ws.id}`]) metaKeysToDelete.add(`ws-${ws.id}`);
        continue;
      }

      const wsAgents = agentsByWs.get(ws.id) ?? [];
      const userAgents = wsAgents.filter(isUserConversationAgent);

      const cardId = `ws-${ws.id}`;
      let wsMeta: ItemUserMeta | undefined = state.meta[cardId];
      if (userAgents.length === 0) {
        if (wsMeta && normalizeStoredStatus(wsMeta.customStatus) !== "archived") {
          metaPatches[cardId] = { ...metaPatches[cardId], customStatus: "archived", awaitingDecision: false };
        }
        continue;
      }

      const wsAgentIds = new Set(userAgents.map((a) => a.id));
      const wsAgentLabels = new Set(
        userAgents.map((a) => getAgentCardLabel(a)).filter((x): x is string => Boolean(x)),
      );
      const stateHash = `ws:${ws.id}`;
      for (const [mId, mVal] of Object.entries(state.meta)) {
        if (!mVal || mId === cardId || mId.startsWith("ws-") || definedIds.has(mId)) continue;
        if (
          normalizeStoredStatus(mVal.customStatus) === "archived" &&
          !mVal.boundWorkspaceId &&
          !mVal.boundAgentId
        ) {
          continue;
        }
        if (
          mVal.boundWorkspaceId === ws.id ||
          (mVal.boundAgentId && wsAgentIds.has(mVal.boundAgentId)) ||
          wsAgentLabels.has(mId)
        ) {
          metaKeysToDelete.add(mId);
          const merged = mergeDonorMetaIntoTarget(wsMeta, mVal, mId, stateHash);
          wsMeta = merged;
          metaPatches[cardId] = merged;
        }
      }

      if (normalizeStoredStatus(wsMeta?.customStatus) === "archived") {
        // Self-heal: unarchived conversation agents still exist in this workspace!
        const healPatch: Partial<ItemUserMeta> = {
          customStatus: "needs_me",
          autoArchivedAt: null,
          autoArchivedHash: null,
        };
        metaPatches[cardId] = { ...metaPatches[cardId], ...healPatch };
        wsMeta = { ...wsMeta, ...healPatch };
      }

      const linked = buildLinkedWorkspace(
        ws,
        userAgents,
        wsMeta,
        models.resolved.defaultWorkerModel,
        this.summaryQueue.isSummarizing(cardId),
      );
      const resolvedWsBoundAgentId =
        wsMeta?.boundAgentId && wsAgentIds.has(wsMeta.boundAgentId)
          ? wsMeta.boundAgentId
          : linked.primaryAgentId;
      if (wsMeta?.boundWorkspaceId !== ws.id || wsMeta?.boundAgentId !== resolvedWsBoundAgentId) {
        const rebindPatch: Partial<ItemUserMeta> = {
          boundWorkspaceId: ws.id,
          boundAgentId: resolvedWsBoundAgentId,
        };
        metaPatches[cardId] = { ...metaPatches[cardId], ...rebindPatch };
        wsMeta = { ...wsMeta, ...rebindPatch };
      }
      const wsReplyAfterTag = findUserReplyAfterTag(wsMeta, userAgents);
      if (wsReplyAfterTag) {
        this.summaryQueue.invalidateCard(cardId);
        const clearPatch = buildClearedNeedsMeTagPatch(wsReplyAfterTag.clearedAt);
        metaPatches[cardId] = { ...metaPatches[cardId], ...clearPatch };
        wsMeta = { ...wsMeta, ...clearPatch };
      }
      const primary = linked.primaryAgentId ? agentById.get(linked.primaryAgentId) : undefined;
      const proj = projectById.get(ws.projectId);
      const title = resolveLocalWorkspaceCardTitle(ws, userAgents);
      const branchHint = ws.workspaceKind === "worktree" ? `Worktree · ${ws.name}` : `本地工作区 · ${ws.projectDisplayName}`;
      const { visibility, snoozedUntil } = itemVisibility(stateHash, wsMeta, nowMs);

      const cardStatus = resolveCardStatus(linked, wsMeta);
      const wsLinks = resolveItemLinks({
        attachedLinks: wsMeta?.attachedLinks,
        removedLinkKeys: wsMeta?.removedLinkKeys,
        extraLinks: wsMeta?.extraLinks,
        title,
        ...(linked.prepSummary ? { labelContext: linked.prepSummary } : {}),
        branchHint: `${ws.name} ${ws.workspaceDirectory ?? ""}`,
      });
      const wsEffectiveTag = cardStatus === "needs_me" ? (wsMeta?.needsMeTag ?? null) : null;
      cards.push({
        id: cardId,
        source: "workspace",
        group: "local",
        badge: "本地会话",
        title,
        summary: branchHint,
        url: wsLinks[0]?.url ?? null,
        secondaryUrl: null,
        links: wsLinks,
        updatedAt: linked.updatedAt,
        stateHash,
        projectId: proj?.projectId ?? ws.projectId,
        projectName: proj?.name ?? ws.projectDisplayName,
        selectedModel: primary ? formatFullModel(primary, models.resolved.defaultWorkerModel) : (wsMeta?.selectedModel ?? models.resolved.defaultWorkerModel),
        status: cardStatus,
        needsMeTag: wsEffectiveTag,
        decisionProposal: wsEffectiveTag === "decision" ? (wsMeta?.decisionProposal ?? null) : null,
        needsWorktree: ws.workspaceKind === "worktree",
        visibility,
        snoozedUntil,
        waitMode: wsMeta?.waitMode ?? null,
        waitCondition: wsMeta?.waitCondition ?? null,
        waitBoard: wsMeta?.waitBoard ?? null,
        waitScheduleId: wsMeta?.waitScheduleId ?? null,
        waitCron: wsMeta?.waitCron ?? null,
        waitTimeoutAt: wsMeta?.waitTimeoutAt ?? null,
        waitCheckNote: wsMeta?.waitCheckNote ?? null,
        lastWaitCheckAt: wsMeta?.lastWaitCheckAt ?? null,
        goal: wsMeta?.goal ?? null,
        coordination: null,
        workspace: linked,
      });
    }

    // Populate Coordination Mode summaries on enabled cards (lightweight; never loads events.jsonl bodies)
    await Promise.all(
      cards.map(async (card) => {
        const effMeta = metaPatches[card.id] ? { ...state.meta[card.id], ...metaPatches[card.id] } : state.meta[card.id];
        if (!effMeta?.coordinationEnabled) return;
        const summary = await this.coordination.getCoordinationSummary(card.id);
        if (!summary) return;
        card.coordination = summary;
        if (summary.enabled && card.status === "waiting_external" && card.waitMode === "board") {
          if (summary.running > 0) {
            card.status = "running";
            card.waitCondition = summary.frontlineText;
          } else {
            const agg = await this.coordination.getParentAggregatedWaitingStatus(card.id);
            if (agg.isWaiting && agg.condition) {
              card.waitCondition = agg.condition;
            }
          }
        }
      }),
    );

    if (Object.keys(metaPatches).length > 0 || metaKeysToDelete.size > 0 || customIdsToDelete.size > 0) {
      void updateRadarState((s) => {
        if (customIdsToDelete.size > 0) {
          s.customItems = s.customItems.filter((c) => !customIdsToDelete.has(c.id));
        }
        for (const k of metaKeysToDelete) {
          delete s.meta[k];
        }
        for (const [id, patch] of Object.entries(metaPatches)) {
          s.meta[id] = { ...s.meta[id], ...patch };
        }
      }).catch((err: unknown) => console.error("[paseo-radar] meta reconcile failed:", err));
    }

    cards.sort(compareCards);

    const visibleCards = cards.filter((c) => c.visibility === "active" && c.status !== "archived");
    const poolCards = visibleCards.filter((c) => c.status === "pool");
    const boardCards = visibleCards.filter((c) => c.status !== "pool");
    const urgentPoolCount = poolCards.filter((c) => c.group === "urgent").length;
    const needsMeCount = visibleCards.filter((c) => c.status === "needs_me").length;

    const counts = {
      attention: needsMeCount + urgentPoolCount,
      boardTotal: boardCards.length,
      needsMe: needsMeCount,
      readyToArchive: visibleCards.filter((c) => c.status === "needs_me" && c.needsMeTag === "ready_to_archive").length,
      running: visibleCards.filter((c) => c.status === "running").length,
      waitingExternal: visibleCards.filter((c) => c.status === "waiting_external").length,
      pool: poolCards.length,
      archived: cards.filter((c) => c.visibility === "active" && c.status === "archived").length,
      hidden: cards.filter((c) => c.visibility !== "active").length,
    };

    let copilot: CopilotSummary | null = null;
    if (state.copilotAgentId) {
      const liveCopilot = agentById.get(state.copilotAgentId);
      if (liveCopilot) {
        copilot = {
          id: liveCopilot.id,
          status: normalizeAgentStatus(liveCopilot.status) ?? "idle",
          model: liveCopilot.model ?? liveCopilot.provider,
          updatedAt: liveCopilot.updatedAt,
        };
      }
    }

    // Flush any pending wakeup prompts that failed while no Paseo handle was attached
    for (const [cid, m] of Object.entries(state.meta)) {
      const pendingPrompt = m?.pendingWakePrompt;
      if (!pendingPrompt) continue;
      const wakeTargetId = m.waitAgentId ?? m.boundAgentId;
      void updateRadarState((s) => {
        if (s.meta[cid]) s.meta[cid].pendingWakePrompt = null;
      }).then(() => this.triggerAgentForCard(cid, wakeTargetId, pendingPrompt, paseo));
    }

    // Clear stale summary alerts if user already switched summaryModels in Settings
    for (const [alertKey, alert] of this.modelAlerts) {
      if (alertKey.startsWith("summary:fallback:")) {
        if (alert.model !== models.summaryModels[0]) {
          this.modelAlerts.delete(alertKey);
        }
      } else if (alertKey.startsWith("summary:") && !models.summaryModels.includes(alert.model)) {
        this.modelAlerts.delete(alertKey);
      }
    }

    // Backfill summaries for any active "needs_me" cards whose latest reply hasn't been summarized yet
    for (const card of cards) {
      if (card.visibility !== "active" || card.status !== "needs_me" || !card.workspace?.primaryAgentId) continue;
      if (this.summaryQueue.isSummarizing(card.id)) continue;
      const cardMeta = metaPatches[card.id]
        ? { ...state.meta[card.id], ...metaPatches[card.id] }
        : state.meta[card.id];
      const summaryTargetId =
        (cardMeta?.boundAgentId && card.workspace.agentIds.includes(cardMeta.boundAgentId)
          ? cardMeta.boundAgentId
          : null) ?? card.workspace.primaryAgentId;
      const agent = agentById.get(summaryTargetId);
      if (!agent || agent.status === "running" || agent.status === "initializing") continue;
      if ((this.pendingTurnStartUntil.get(agent.id) ?? 0) > nowMs) continue;
      void extractConversationDigest(paseo, agent).then((digest) => {
        if (digest.hasUnansweredUserMessage) {
          if (cardMeta?.needsMeTag === "ready_to_archive") {
            const clearedAt = new Date().toISOString();
            this.summaryQueue.invalidateCard(card.id);
            void updateRadarState((s) => {
              if (s.meta[card.id]?.needsMeTag === "ready_to_archive") {
                s.meta[card.id] = {
                  ...s.meta[card.id],
                  ...buildClearedNeedsMeTagPatch(clearedAt),
                };
              }
            });
          }
          return;
        }
        const replyText = digest.latestAssistantReply;
        if (!replyText) return;
        const sig = computeSummarySig(agent.id, replyText);
        if (cardMeta?.prepSummary && cardMeta.prepSummarySig === sig && cardMeta.needsMeTag) return;
        if (shouldSkipBackfillAfterUserClear(cardMeta, sig, digest.hasUnansweredUserMessage)) return;
        this.summaryQueue.enqueue({
          cardId: card.id,
          cardTitle: card.title,
          cardContext: {
            id: card.id,
            source: card.source,
            badge: card.badge,
            closureGate: rawById.get(card.id)?.closureGate,
            summary: card.summary,
            links: card.links,
            firstUserMessage: digest.firstUserMessage,
            recentUserMessages: digest.recentUserMessages,
            goal: cardMeta?.goal ?? null,
          },
          workspaceId: card.workspace?.workspaceId ?? null,
          agentId: agent.id,
          fullReply: replyText,
          summaryModels: models.summaryModels,
          paseo,
          allowGoalSteer: false,
        });
      });
    }

    const modelAlerts = [...this.modelAlerts.values()].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt),
    );

    return {
      items: cards,
      projects,
      autoScanEnabled: models.autoScanEnabled,
      trackLocalWorkspaces: models.trackLocalWorkspaces,
      coordinationBetaEnabled: models.coordinationBetaEnabled,
      effectiveTimezone: effectiveTz,
      resolvedModels: models.resolved,
      lastScanAt: state.lastScanAt,
      lastScanDeltaCount: state.lastScanDeltaCount,
      lastScanTriageTriggered: state.lastScanTriageTriggered,
      scanning: this.isScanning,
      scanErrors: state.scanErrors,
      collectorsDir: collectorInfo.collectorsDir,
      collectors: collectorInfo.scripts,
      modelAlerts,
      copilot,
      counts,
    };
  }

  async followItem(
    paseo: PaseoApi,
    input: { itemId: string; mode: "background" | "immediate"; note: string },
  ): Promise<{ workspaceId: string; agentId: string; mode: "background" | "immediate" }> {
    const existing = this.followInFlight.get(input.itemId);
    if (existing) return await existing;

    const promise = this.followItemImpl(paseo, input).finally(() => {
      if (this.followInFlight.get(input.itemId) === promise) {
        this.followInFlight.delete(input.itemId);
      }
    });
    this.followInFlight.set(input.itemId, promise);
    return await promise;
  }

  private async followItemImpl(
    paseo: PaseoApi,
    input: { itemId: string; mode: "background" | "immediate"; note: string },
  ): Promise<{ workspaceId: string; agentId: string; mode: "background" | "immediate" }> {
    this.rememberPaseo(paseo);
    const snap = await this.loadSnapshot(paseo);
    const card = snap.items.find((c) => c.id === input.itemId);
    if (!card) throw new Error(`未找到卡片 ${input.itemId}，请刷新重试。`);

    const state = await readRadarState();
    const raw = [...state.customItems, ...state.rawItems].find((r) => r.id === input.itemId);
    const noteTrimmed = input.note.trim();

    if (card.workspace !== null) {
      const wsId = card.workspace.workspaceId;
      const agentId = card.workspace.primaryAgentId;
      if (agentId) {
        if (input.mode === "background") {
          const turnEndGuide = buildTurnEndToolGuide(
            await this.isAgentPiProvider(paseo, agentId, card.selectedModel),
          );
          const prompt =
            noteTrimmed !== ""
              ? `${noteTrimmed}${STYLE_DIRECTIVE}\n\n${turnEndGuide}并在回复末尾用「### 结论摘要」给出 2~3 行最新结论。`
              : `请结合最新状态继续后台跟进核查；${turnEndGuide}并在回复末尾用「### 结论摘要」给出 2~3 行核心结论。${STYLE_DIRECTIVE}`;
          this.markAgentTurnPending(agentId);
          await paseo.agents.ref(agentId).send(prompt, { activeTurnBehavior: "steer" });
        } else if (noteTrimmed !== "") {
          this.markAgentTurnPending(agentId);
          await paseo.agents.ref(agentId).send(noteTrimmed, { activeTurnBehavior: "steer" });
        }
        const shouldClearTag = input.mode === "background" || noteTrimmed !== "";
        if (shouldClearTag) {
          this.summaryQueue.invalidateCard(card.id);
        }
        await updateRadarState((s) => {
          s.meta[card.id] = {
            ...s.meta[card.id],
            boundWorkspaceId: wsId,
            boundAgentId: agentId,
            customStatus: "needs_me",
            ...(shouldClearTag ? buildClearedNeedsMeTagPatch(new Date().toISOString()) : {}),
            snoozedUntil: null,
            dismissedHash: null,
          };
        });
        return { workspaceId: wsId, agentId, mode: input.mode };
      }
    }

    const targetProject =
      (card.projectId ? snap.projects.find((p) => p.projectId === card.projectId) : undefined) ??
      snap.projects[0];

    if (!targetProject) {
      throw new Error("未找到可用的 Paseo Project，请先在 Paseo 中添加项目目录。");
    }

    const modelsForWorker = await this.getModels(paseo);
    const chosenProvider = card.selectedModel || modelsForWorker.resolved.defaultWorkerModel;
    if (!chosenProvider) {
      throw new Error("未找到可用模型，请先在 Paseo 启用至少一个模型 Provider。");
    }
    const matchedAssignable = modelsForWorker.resolved.assignableModels.find(
      (m) => m.model === chosenProvider,
    );

    const prevBoundWorkspaceId = state.meta[card.id]?.boundWorkspaceId ?? null;
    let createdWorkspace = false;
    let wsHandle;

    if (card.workspace !== null) {
      // Reuse existing workspace that has no primaryAgentId (e.g. previous agent creation failed)
      wsHandle = paseo.workspaces.ref(card.workspace.workspaceId);
    } else {
      const slug = (raw?.branchSlug ?? card.id).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "task";
      const useWorktree = targetProject.kind === "git" && card.needsWorktree;

      if (useWorktree) {
        const baseCandidates = await resolveWorktreeBaseCandidates(targetProject.path);

        const createBranchOff = async (branchName: string) => {
          let lastErr: unknown;
          for (const baseBranch of baseCandidates) {
            try {
              return await paseo.workspaces.create({
                title: card.title.slice(0, 48),
                source: {
                  kind: "worktree",
                  projectId: targetProject.projectId,
                  cwd: targetProject.path,
                  action: "branch-off",
                  baseBranch,
                  branchName,
                },
              });
            } catch (err) {
              lastErr = err;
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error("创建 Worktree 分支失败");
        };

        try {
          if (raw?.existingBranch) {
            wsHandle = await paseo.workspaces.create({
              title: card.title.slice(0, 48),
              source: {
                kind: "worktree",
                projectId: targetProject.projectId,
                cwd: targetProject.path,
                action: "checkout",
                refName: raw.existingBranch,
              },
            });
          } else {
            wsHandle = await createBranchOff(`radar/${slug}`);
          }
        } catch {
          const uniq = Math.floor(Date.now() / 1000).toString(36).slice(-4);
          wsHandle = await createBranchOff(`radar/${slug}-${uniq}`);
        }
      } else {
        wsHandle = await paseo.workspaces.create({
          title: card.title.slice(0, 48),
          source: {
            kind: "directory",
            projectId: targetProject.projectId,
            path: targetProject.path,
          },
        });
      }
      createdWorkspace = true;
    }

    // Persist boundWorkspaceId BEFORE spawning the agent so fast agent.turn.after hooks never fall back to ws-<id>
    this.summaryQueue.invalidateCard(card.id);
    await updateRadarState((s) => {
      s.meta[card.id] = {
        ...s.meta[card.id],
        boundWorkspaceId: wsHandle.id,
        selectedProjectId: targetProject.projectId,
        selectedModel: card.selectedModel,
        customStatus: "needs_me",
        ...buildClearedNeedsMeTagPatch(new Date().toISOString()),
        snoozedUntil: null,
        dismissedHash: null,
      };
    });

    const activeGoal = state.meta[card.id]?.goal?.active ? state.meta[card.id]!.goal! : null;
    const goalSection = activeGoal ? `\n\n${this.formatGoalKickoffBlock(activeGoal)}` : "";
    const extraNote = noteTrimmed !== "" ? `\n\n【用户补充说明】\n${noteTrimmed}` : "";
    const chosenIsPi = isPiProvider(chosenProvider);
    const turnEndGuide = buildTurnEndToolGuide(chosenIsPi);
    const kickoff = raw ? buildKickoffPrompt(input.mode, raw) : card.title;
    const prompt =
      input.mode === "background"
        ? `${kickoff}${extraNote}${goalSection}${STYLE_DIRECTIVE}\n\n${turnEndGuide}并在回复末尾用「### 结论摘要」给出 2~3 行精炼结论（若有外发草稿一并附上）。`
        : `${kickoff}${extraNote}${goalSection}${STYLE_DIRECTIVE}`;

    const isCoordMode = Boolean(state.meta[card.id]?.coordinationEnabled);
    let agent;
    try {
      agent = await wsHandle.agents.create({
        config: {
          provider: chosenProvider,
          ...(matchedAssignable?.modeId ? { modeId: matchedAssignable.modeId } : {}),
          thinkingOptionId: matchedAssignable?.thinkingOptionId ?? "medium",
          ...(matchedAssignable?.featureValues ? { featureValues: matchedAssignable.featureValues } : {}),
          systemPrompt: isCoordMode
            ? withCoordinatorSystemPrompt(
                undefined,
                modelsForWorker.timezone,
                modelsForWorker.resolved.assignableModels,
                chosenIsPi,
              )
            : withWorkerSystemPrompt(undefined, modelsForWorker.timezone, chosenIsPi),
        },
        title: card.title.slice(0, 52),
        labels: {
          [RADAR_LABELS.card]: card.id,
          ...(isCoordMode ? { [RADAR_LABELS.coordMode]: "1" } : {}),
        },
        prompt,
      });
    } catch (err) {
      if (createdWorkspace) {
        await paseo.workspaces.archive(wsHandle.id).catch(() => {});
        await updateRadarState((s) => {
          if (s.meta[card.id]?.boundWorkspaceId === wsHandle.id) {
            s.meta[card.id] = {
              ...s.meta[card.id],
              boundWorkspaceId: prevBoundWorkspaceId,
            };
          }
        }).catch(() => {});
      }
      throw err;
    }
    this.markAgentTurnPending(agent.id);

    await updateRadarState((s) => {
      s.meta[card.id] = {
        ...s.meta[card.id],
        boundWorkspaceId: wsHandle.id,
        boundAgentId: agent.id,
      };
    });

    return { workspaceId: wsHandle.id, agentId: agent.id, mode: input.mode };
  }

  async followBatchBackground(
    paseo: PaseoApi,
    itemIds: readonly string[],
  ): Promise<{ startedCount: number; failedCount: number }> {
    this.rememberPaseo(paseo);
    const queue = [...new Set(itemIds)];
    let startedCount = 0;
    let failedCount = 0;

    async function worker(self: RadarEngine): Promise<void> {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        try {
          await self.followItem(paseo, { itemId: id, mode: "background", note: "" });
          startedCount += 1;
        } catch (err) {
          failedCount += 1;
          console.error(`[paseo-radar] batch follow failed for ${id}:`, err);
        }
      }
    }

    const concurrency = Math.min(3, queue.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker(this)));
    return { startedCount, failedCount };
  }

  async setNeedsMeTag(input: {
    cardId: string;
    tag: NeedsMeTag;
    callerAgentId?: string | null;
    callerWorkspaceId?: string | null;
    title?: string;
    target?: string;
    impact?: string;
    draft?: string;
  }): Promise<void> {
    const cleanField = (v: string | undefined): string | null => {
      if (v === undefined) return null;
      const t = v.trim();
      return t === "" ? null : t;
    };
    const cleanDraft =
      input.draft !== undefined && input.draft.trim() !== ""
        ? input.draft.replace(/\r\n/g, "\n")
        : null;
    const title = cleanField(input.title);
    const target = cleanField(input.target);
    const impact = cleanField(input.impact);
    const hasProposal = Boolean(title || target || impact || cleanDraft !== null);
    const decisionProposal: DecisionProposal | null =
      input.tag === "decision" && hasProposal
        ? {
            title,
            target,
            impact,
            draft: cleanDraft,
            agentId: input.callerAgentId ?? null,
            updatedAt: new Date().toISOString(),
          }
        : null;

    if (input.tag !== "decision" && input.callerAgentId && this.paseoHandle) {
      const stateBefore = await readRadarState();
      const prevMeta = stateBefore.meta[input.cardId];
      const existingDraftOwner =
        prevMeta?.needsMeTag === "decision" && Boolean(prevMeta.decisionProposal?.draft?.trim())
          ? prevMeta.decisionProposal?.agentId ?? prevMeta.needsMeTagAgentId ?? null
          : null;
      if (existingDraftOwner && existingDraftOwner !== input.callerAgentId) {
        const ownerLive = (
          await this.paseoHandle.agents.ref(existingDraftOwner).refresh().catch(() => null)
        )?.agent;
        if (ownerLive && !ownerLive.archivedAt && ownerLive.status !== "closed") {
          return;
        }
      }
    }

    const nowIso = new Date().toISOString();
    await updateRadarState((s) => {
      const prev = s.meta[input.cardId];
      s.meta[input.cardId] = {
        ...prev,
        ...(input.callerWorkspaceId && !prev?.boundWorkspaceId
          ? { boundWorkspaceId: input.callerWorkspaceId }
          : {}),
        ...(input.callerAgentId ? { boundAgentId: input.callerAgentId } : {}),
        needsMeTag: input.tag,
        needsMeTagLocked: true,
        needsMeTagAgentId: input.callerAgentId ?? prev?.boundAgentId ?? null,
        needsMeTagUpdatedAt: nowIso,
        decisionProposal,
      };
    });
    await this.evaluateOuterBoardWatchers(input.cardId);
  }

  async manageCardLinks(
    paseo: PaseoApi | null,
    input: {
      cardId: string;
      add?: RadarLinkInput[];
      removeUrls?: string[];
      callerAgentId?: string | null;
      callerWorkspaceId?: string | null;
    },
  ): Promise<{ added: RadarLink[]; links: RadarLink[] }> {
    if (paseo) this.rememberPaseo(paseo);
    const targetId = normalizeCardId(input.cardId);
    const rawAdd = input.add ?? [];
    const added = mergeAttachedLinks(rawAdd);
    if (rawAdd.length > 0 && added.length === 0) {
      throw new Error("请提供以 http:// 或 https:// 开头的完整链接");
    }

    const keysToUnremove = new Set<string>();
    for (const lnk of added) {
      for (const k of getLinkDedupeKeys(lnk.url)) {
        keysToUnremove.add(k);
      }
    }

    const keysToRemove = new Set<string>();
    for (const rawUrl of input.removeUrls ?? []) {
      for (const k of getLinkDedupeKeys(rawUrl)) {
        if (!keysToUnremove.has(k)) {
          keysToRemove.add(k);
        }
      }
    }

    await updateRadarState((s) => {
      const prev = s.meta[targetId] ?? {};
      const nextRemoved = new Set<string>(prev.removedLinkKeys ?? []);
      for (const k of keysToUnremove) nextRemoved.delete(k);
      for (const k of keysToRemove) nextRemoved.add(k);

      const keptAttached = filterLinksByRemovedKeys(prev.attachedLinks, keysToRemove);
      const nextAttached = added.length > 0 ? mergeAttachedLinks(added, keptAttached) : keptAttached;
      const nextExtra =
        prev.extraLinks && prev.extraLinks.length > 0
          ? filterLinksByRemovedKeys(prev.extraLinks, keysToRemove)
          : prev.extraLinks;

      s.meta[targetId] = {
        ...prev,
        ...(!targetId.startsWith("ws-") && input.callerWorkspaceId && !prev.boundWorkspaceId
          ? { boundWorkspaceId: input.callerWorkspaceId }
          : {}),
        ...(!targetId.startsWith("ws-") && input.callerAgentId && !prev.boundAgentId
          ? { boundAgentId: input.callerAgentId }
          : {}),
        attachedLinks: nextAttached,
        ...(nextExtra !== undefined ? { extraLinks: nextExtra } : {}),
        removedLinkKeys: [...nextRemoved],
      };
    });

    if (paseo) {
      const snap = await this.loadSnapshot(paseo);
      const updatedCard = snap.items.find((i) => i.id === targetId);
      if (updatedCard) {
        return { added, links: updatedCard.links };
      }
    }
    return { added, links: added };
  }

  async updateCard(
    paseo: PaseoApi,
    input: {
      itemId: string;
      targetAgentId?: string;
      selectedModel?: string;
      projectId?: string;
      status?: CardStatus;
      needsMeTag?: NeedsMeTag | null;
    },
  ): Promise<void> {
    this.rememberPaseo(paseo);
    if (input.status === "waiting_external") {
      throw new Error("转入「等外部」需由会话确认完结动作明确后调用 radar_mark_waiting_external 完成");
    }

    let agentToSync: { id: string; provider: string } | null = null;
    if (input.selectedModel) {
      const snap = await this.loadSnapshot(paseo);
      const card = snap.items.find((c) => c.id === input.itemId);
      const targetId = input.targetAgentId ?? card?.workspace?.primaryAgentId ?? null;
      if (targetId) {
        const refreshed = await paseo.agents.ref(targetId).refresh().catch(() => null);
        if (refreshed?.agent) {
          agentToSync = { id: refreshed.agent.id, provider: refreshed.agent.provider };
        }
      }
    }

    // Apply model change to the live session FIRST so we never save a mismatched meta on rejection
    if (agentToSync && input.selectedModel) {
      await setLiveAgentModel(agentToSync.id, agentToSync.provider, input.selectedModel);
    }

    const leavingWait = input.status !== undefined;
    let scheduleToClean: string | null = null;
    let scriptToClean: string | null = null;
    const nowIso = new Date().toISOString();
    if (input.needsMeTag === null) {
      this.summaryQueue.invalidateCard(input.itemId);
    }
    await updateRadarState((s) => {
      const prev = s.meta[input.itemId] ?? {};
      if (leavingWait) {
        scheduleToClean = prev.waitScheduleId ?? null;
        scriptToClean = prev.waitScriptPath ?? null;
      }
      s.meta[input.itemId] = {
        ...prev,
        ...(input.selectedModel !== undefined ? { selectedModel: input.selectedModel } : {}),
        ...(input.projectId !== undefined ? { selectedProjectId: input.projectId } : {}),
        ...(input.needsMeTag !== undefined
          ? input.needsMeTag === null
            ? buildClearedNeedsMeTagPatch(nowIso)
            : {
                needsMeTag: input.needsMeTag,
                needsMeTagLocked: true,
                needsMeTagAgentId: input.targetAgentId ?? prev.boundAgentId ?? null,
                needsMeTagUpdatedAt: nowIso,
                ...(input.needsMeTag !== "decision" ? { decisionProposal: null } : {}),
              }
          : {}),
        ...(input.status !== undefined
          ? {
              customStatus: input.status,
              ...(leavingWait
                ? {
                    waitAgentId: null,
                    waitMode: null,
                    waitPredicate: null,
                    waitProviderId: null,
                    waitCheckNote: null,
                    waitScheduleId: null,
                    waitScriptPath: null,
                    waitCron: null,
                    waitStartedAt: null,
                    waitTimeoutAt: null,
                    waitMaxTimeoutLabel: null,
                    pendingWakePrompt: null,
                  }
                : {}),
            }
          : {}),
      };
    });
    if (leavingWait) {
      this.lastScriptCronSlot.delete(input.itemId);
    }
    await Promise.all([
      this.cleanupWaitSchedule(scheduleToClean),
      this.cleanupWaitScript(scriptToClean),
    ]);
  }

  async archiveBatchCards(paseo: PaseoApi, itemIds: readonly string[]): Promise<number> {
    let archivedCount = 0;
    for (const id of new Set(itemIds)) {
      await this.archiveCardAndSession(paseo, id);
      archivedCount += 1;
    }
    return archivedCount;
  }

  async archiveCardAndSession(paseo: PaseoApi, itemId: string): Promise<void> {
    this.rememberPaseo(paseo);
    const snap = await this.loadSnapshot(paseo);
    const card = snap.items.find((c) => c.id === itemId);
    const prevState = await readRadarState();
    const prevScript = prevState.meta[itemId]?.waitScriptPath ?? null;

    this.lastScriptCronSlot.delete(itemId);
    await Promise.all([
      this.cleanupWaitSchedule(card?.waitScheduleId),
      this.cleanupWaitScript(prevScript),
      this.coordination.cleanupParentBoard(itemId),
    ]);
    if (card?.workspace) {
      const wsId = card.workspace.workspaceId;
      try {
        await paseo.workspaces.archive(wsId);
      } catch (wsErr) {
        let allArchived = true;
        for (const aid of card.workspace.agentIds) {
          try {
            await paseo.agents.ref(aid).archive();
          } catch {
            allArchived = false;
          }
        }
        if (!allArchived) {
          throw wsErr instanceof Error ? wsErr : new Error("归档关联工作区会话失败，请重试");
        }
      }
    }

    await updateRadarState((s) => {
      const isCustom = s.customItems.some((r) => r.id === itemId);
      if (isCustom) {
        s.customItems = s.customItems.filter((r) => r.id !== itemId);
        delete s.meta[itemId];
        return;
      }
      const raw = s.rawItems.find((r) => r.id === itemId);
      s.meta[itemId] = {
        ...s.meta[itemId],
        boundWorkspaceId: null,
        boundAgentId: null,
        awaitingDecision: false,
        needsMeTagAgentId: null,
        decisionProposal: null,
        coordinationEnabled: false,
        subcardWorkspaceIds: [],
        ...(s.meta[itemId]?.goal ? { goal: { ...s.meta[itemId]!.goal!, active: false } } : {}),
        waitAgentId: null,
        waitMode: null,
        waitPredicate: null,
        waitProviderId: null,
        waitBoard: null,
        waitScheduleId: null,
        waitScriptPath: null,
        waitCron: null,
        waitStartedAt: null,
        waitTimeoutAt: null,
        waitMaxTimeoutLabel: null,
        pendingWakePrompt: null,
        customStatus: "archived",
        autoArchivedAt: new Date().toISOString(),
        autoArchivedHash: raw?.stateHash ?? itemId,
      };
    });

    await this.evaluateOuterBoardWatchers(itemId, paseo);
  }

  private formatGoalKickoffBlock(goal: RadarGoal, isResume = false): string {
    const provenanceNote =
      goal.autoRefined && goal.rawSpec && goal.rawSpec !== goal.spec
        ? `（原始诉求：「${goal.rawSpec}」，已结合上下文自动完善）`
        : goal.autoRefined && !goal.rawSpec
          ? "（用户未填写具体目标，以上为结合卡片与会话上下文自动推断的目标；若执行中发现更核心的阻塞或真实诉求，请优先以解决实际问题为准）"
          : "";
    return [
      isResume
        ? `[Radar 目标模式已恢复 · 自动推进直至达标（上限 ${goal.maxTurns} 轮）]`
        : `[Radar 目标模式已开启 · 自动推进直至达标（上限 ${goal.maxTurns} 轮）]`,
      `目标：${goal.spec}`,
      provenanceNote,
      goal.verifyCommand ? `客观验收命令：\`${goal.verifyCommand}\`` : "",
      "",
      "请直接围绕上述目标完成排查、实现与验证，避免仅完成局部子步骤就停下做阶段汇报：",
      "- 若需等待 CI/审批/远端长任务等明确可检外部条件，调用 `radar_mark_waiting_external`（唤醒后目标模式继续生效）；",
      "- 若涉及外发沟通、共享内容修改或需人工拍板的操作，调用 `radar_set_needs_me_tag` 标记 `decision`（附 `draft`）等待确认；",
      "- 若缺少用户侧凭证或信息，调用 `radar_set_needs_me_tag` 标记 `input`；",
      "- 目标全部达成并完成验证（涉及仓库文件修改须按规范执行 `git commit`）后，调用 `radar_set_needs_me_tag` 标记 `ready_to_archive`。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async runGoalVerifyCommand(
    command: string,
    cwd: string | null | undefined,
  ): Promise<{ ok: boolean; excerpt: string }> {
    try {
      const { stdout, stderr } = await execCommand("bash", ["-lc", command], {
        cwd: cwd || waitChecksDir(),
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
        env: buildExtendedEnv(),
      });
      const tail = `${stdout}\n${stderr}`
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(-8)
        .join("\n")
        .slice(-400);
      return { ok: true, excerpt: tail };
    } catch (err: unknown) {
      const e = err as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string; message?: string };
      const combined = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(-12)
        .join("\n")
        .slice(-800);
      const fallback = e?.killed
        ? "验收命令执行超时（>90s）"
        : e?.message || `exit ${String(e?.code ?? 1)}`;
      return { ok: false, excerpt: combined || fallback };
    }
  }

  private async handleGoalPostTurnEval(info: {
    params: SummaryEnqueueParams;
    result: SummaryEvalResult;
    sig: string;
  }): Promise<void> {
    const { params, result } = info;
    if (!params.allowGoalSteer) return;

    const handle = params.paseo ?? this.paseoHandle;
    const state = await readRadarState();
    const meta = state.meta[params.cardId];
    const goal = meta?.goal;
    if (!goal || !goal.active) return;

    if (goal.agentId && goal.agentId !== params.agentId) {
      if (handle) {
        const goalOwner = (await handle.agents.ref(goal.agentId).refresh().catch(() => null))?.agent;
        if (goalOwner && !goalOwner.archivedAt) {
          return;
        }
      } else {
        return;
      }
    }

    const storedStatus = normalizeStoredStatus(meta?.customStatus);
    if (storedStatus === "waiting_external" || storedStatus === "archived") return;

    const nowIso = new Date().toISOString();

    // Respect explicit human approval/input gates locked by Worker tool calls
    if (meta?.needsMeTagLocked && (meta.needsMeTag === "decision" || meta.needsMeTag === "input")) {
      await updateRadarState((s) => {
        const cur = s.meta[params.cardId];
        if (!cur?.goal?.active) return;
        s.meta[params.cardId] = {
          ...cur,
          goal: {
            ...cur.goal,
            lastEvalNote:
              cur.needsMeTag === "decision"
                ? "等待人工确认授权后继续推进目标"
                : "等待补充信息后继续推进目标",
            updatedAt: nowIso,
          },
        };
      });
      return;
    }

    let liveCwd: string | null = null;
    if (handle) {
      const refreshed = await handle.agents.ref(params.agentId).refresh().catch(() => null);
      const liveAgent = refreshed?.agent;
      if (liveAgent) {
        if (
          liveAgent.archivedAt ||
          liveAgent.status === "running" ||
          liveAgent.status === "initializing" ||
          (liveAgent.pendingPermissions?.length ?? 0) > 0
        ) {
          return;
        }
        liveCwd = liveAgent.cwd ?? null;
      }
    }

    let decision: GoalEvalDecision =
      result.tag === "decision" || result.tag === "input"
        ? "blocked"
        : result.goalDecision ?? (result.tag === "ready_to_archive" ? "achieved" : "continue");
    let steerReason = result.goalSteer?.trim() ?? "";

    if (decision === "blocked") {
      const pauseTag: NeedsMeTag = result.tag === "input" ? "input" : "decision";
      await updateRadarState((s) => {
        const cur = s.meta[params.cardId];
        if (!cur?.goal?.active) return;
        s.meta[params.cardId] = {
          ...cur,
          ...(cur.needsMeTagLocked && cur.needsMeTag
            ? {}
            : { needsMeTag: pauseTag, needsMeTagUpdatedAt: nowIso }),
          goal: {
            ...cur.goal,
            lastEvalNote: result.summary || "等待人工确认或补充信息后继续推进",
            updatedAt: nowIso,
          },
        };
      });
      return;
    }

    if (decision === "achieved") {
      const goalSkipsCommit = /(?:暂不|不要|不用|无需|先不|切勿|禁止)\s*(?:提交|git\s+commit|commit)/i.test(
        goal.spec,
      );
      if (liveCwd && !goalSkipsCommit) {
        const baseline =
          (params.workspaceId ? state.gitBaselines?.[params.workspaceId] : undefined) ??
          state.gitBaselines?.[params.agentId];
        const dirty = await findUncommittedSessionChanges(liveCwd, baseline, params.fullReply);
        if (dirty) {
          const preview = dirty.dirtyFiles.slice(0, 6).join(", ");
          const more = dirty.dirtyFiles.length > 6 ? ` 等 ${dirty.dirtyFiles.length} 个文件` : "";
          decision = "continue";
          steerReason = `当前工作区（分支 ${dirty.branch}）仍有未提交改动（${preview}${more}），请完成验证并按规范执行 git commit 后再收尾。`;
        }
      }

      if (decision === "achieved" && goal.verifyCommand?.trim()) {
        const verifyRes = await this.runGoalVerifyCommand(goal.verifyCommand.trim(), liveCwd);
        if (!verifyRes.ok) {
          decision = "continue";
          steerReason = `配置的验收命令 \`${goal.verifyCommand.trim()}\` 未通过：\n${verifyRes.excerpt}\n请修复上述问题并重新运行验收命令直至通过。`;
        }
      }
    }

    if (decision === "achieved") {
      const finalTag = clampAutoNeedsMeTag(
        "ready_to_archive",
        `${params.fullReply}\n${result.summary}`,
        params.cardContext,
      );
      await updateRadarState((s) => {
        const cur = s.meta[params.cardId];
        if (!cur?.goal?.active) return;
        s.meta[params.cardId] = {
          ...cur,
          boundAgentId: params.agentId,
          needsMeTag: finalTag,
          needsMeTagLocked: true,
          needsMeTagAgentId: params.agentId,
          needsMeTagUpdatedAt: nowIso,
          goal: {
            ...cur.goal,
            agentId: params.agentId,
            active: false,
            stopReason: "achieved",
            lastEvalNote: cur.goal.verifyCommand
              ? `目标已达成（验收命令通过）：${result.summary}`
              : `目标已达成：${result.summary}`,
            updatedAt: nowIso,
          },
        };
      });
      return;
    }

    // decision === "continue"
    const nextTurn = goal.turnCount + 1;
    if (nextTurn > goal.maxTurns) {
      await updateRadarState((s) => {
        const cur = s.meta[params.cardId];
        if (!cur?.goal?.active) return;
        s.meta[params.cardId] = {
          ...cur,
          boundAgentId: params.agentId,
          needsMeTag: "review",
          needsMeTagLocked: true,
          needsMeTagAgentId: params.agentId,
          needsMeTagUpdatedAt: nowIso,
          goal: {
            ...cur.goal,
            agentId: params.agentId,
            active: false,
            stopReason: "max_turns",
            lastEvalNote: `已连续自驱 ${cur.goal.maxTurns} 轮仍未达成目标，已暂停交人工核查（剩余事项：${steerReason || result.summary}）`,
            updatedAt: nowIso,
          },
        };
      });
      return;
    }

    let canSteer = false;
    let effectiveSpec = goal.spec;
    let effectiveVerify = goal.verifyCommand;
    let effectiveMax = goal.maxTurns;
    this.summaryQueue.invalidateCard(params.cardId);
    await updateRadarState((s) => {
      const cur = s.meta[params.cardId];
      if (!cur?.goal?.active) return;
      if (normalizeStoredStatus(cur.customStatus) === "waiting_external") return;
      canSteer = true;
      effectiveSpec = cur.goal.spec;
      effectiveVerify = cur.goal.verifyCommand;
      effectiveMax = cur.goal.maxTurns;
      s.meta[params.cardId] = {
        ...cur,
        boundAgentId: params.agentId,
        ...buildClearedNeedsMeTagPatch(nowIso),
        goal: {
          ...cur.goal,
          agentId: params.agentId,
          turnCount: nextTurn,
          lastEvalNote: steerReason || result.summary,
          stopReason: null,
          updatedAt: nowIso,
        },
      };
    });

    if (!canSteer) return;

    const wakePrompt = [
      `[Radar 目标模式自动续推 · 第 ${nextTurn}/${effectiveMax} 轮]`,
      `目标：${effectiveSpec}`,
      effectiveVerify ? `客观验收命令：\`${effectiveVerify}\`` : "",
      `评估反馈：${steerReason || "当前仅完成阶段性进展，尚未完整达成目标，请继续推进剩余事项。"}`,
      "",
      "请直接继续执行剩余步骤（无需重复总结前文已完成内容）：",
      "- 若需等待 CI/审批/远端长任务等明确可检外部条件，调用 `radar_mark_waiting_external`；",
      "- 若遇到必须人工授权的操作（外发消息、提审/合并、共享内容修改等）或缺少用户侧信息，调用 `radar_set_needs_me_tag` 标记 `decision` 或 `input`；",
      "- 全部目标事项与验证（含必要的 `git commit`）完成后，调用 `radar_set_needs_me_tag` 标记 `ready_to_archive`。",
    ]
      .filter(Boolean)
      .join("\n");

    await this.triggerAgentForCard(params.cardId, params.agentId, wakePrompt, handle ?? undefined);
  }

  async setCardGoal(
    paseo: PaseoApi,
    input: {
      itemId?: string;
      workspaceId?: string;
      agentId?: string;
      action: "set" | "stop" | "resume" | "clear";
      spec?: string;
      verifyCommand?: string | null;
      maxTurns?: number;
      steerNow?: boolean;
    },
  ): Promise<{
    cardId: string;
    agentId: string | null;
    goal: RadarGoal | null;
    snapshot: RadarSnapshot;
  }> {
    this.rememberPaseo(paseo);
    const snapBefore = await this.loadSnapshot(paseo);
    const matchedCard =
      (input.itemId
        ? snapBefore.items.find((c) => c.id === normalizeCardId(input.itemId!))
        : undefined) ??
      (input.agentId
        ? snapBefore.items.find((c) => c.workspace?.agentIds.includes(input.agentId!))
        : undefined) ??
      (input.workspaceId
        ? snapBefore.items.find(
            (c) =>
              c.workspace?.workspaceId === input.workspaceId || c.id === `ws-${input.workspaceId}`,
          )
        : undefined);

    const cardId =
      matchedCard?.id ??
      (input.itemId
        ? normalizeCardId(input.itemId)
        : input.workspaceId
          ? `ws-${input.workspaceId}`
          : null);
    if (!cardId) {
      throw new Error("未找到可绑定目标的 Radar 卡片或工作区");
    }

    let targetWsId = input.workspaceId ?? matchedCard?.workspace?.workspaceId ?? null;
    const liveGoalAgentId =
      matchedCard?.goal?.agentId && matchedCard.workspace?.agentIds.includes(matchedCard.goal.agentId)
        ? matchedCard.goal.agentId
        : null;
    let targetAgentId =
      (input.agentId && (!matchedCard?.workspace || matchedCard.workspace.agentIds.includes(input.agentId))
        ? input.agentId
        : null) ??
      liveGoalAgentId ??
      matchedCard?.workspace?.primaryAgentId ??
      null;

    if (!targetAgentId && targetWsId) {
      const live = await listLiveAgents(paseo).catch(() => [] as PaseoAgent[]);
      const wsUserAgents = live
        .filter((a) => a.workspaceId === targetWsId && isUserConversationAgent(a))
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      targetAgentId = wsUserAgents[0]?.id ?? null;
    }

    const nowIso = new Date().toISOString();
    const stateBefore = await readRadarState();
    const prevGoal = stateBefore.meta[cardId]?.goal ?? null;

    if (input.action === "clear") {
      await updateRadarState((s) => {
        if (s.meta[cardId]) {
          s.meta[cardId] = {
            ...s.meta[cardId],
            goal: null,
          };
        }
      });
      return {
        cardId,
        agentId: targetAgentId,
        goal: null,
        snapshot: await this.loadSnapshot(paseo),
      };
    }

    if (input.action === "stop") {
      const stoppedGoal: RadarGoal | null = prevGoal
        ? {
            ...prevGoal,
            active: false,
            stopReason: "manual",
            updatedAt: nowIso,
          }
        : null;
      if (stoppedGoal) {
        await updateRadarState((s) => {
          s.meta[cardId] = {
            ...s.meta[cardId],
            goal: stoppedGoal,
          };
        });
      }
      return {
        cardId,
        agentId: targetAgentId,
        goal: stoppedGoal,
        snapshot: await this.loadSnapshot(paseo),
      };
    }

    let nextGoal: RadarGoal;
    if (input.action === "resume") {
      if (!prevGoal?.spec) {
        throw new Error("当前卡片尚未设置目标，请使用 /radar-goal <目标描述> 开启");
      }
      nextGoal = {
        ...prevGoal,
        active: true,
        agentId: targetAgentId ?? prevGoal.agentId ?? null,
        turnCount: 0,
        maxTurns: Math.min(
          MAX_GOAL_MAX_TURNS,
          Math.max(1, input.maxTurns ?? prevGoal.maxTurns ?? DEFAULT_GOAL_MAX_TURNS),
        ),
        lastEvalNote: null,
        stopReason: null,
        updatedAt: nowIso,
      };
    } else {
      const rawSpec = (input.spec ?? "").trim();
      const cleanVerify =
        input.verifyCommand !== undefined
          ? input.verifyCommand && input.verifyCommand.trim() !== ""
            ? input.verifyCommand.trim()
            : null
          : prevGoal?.verifyCommand ?? null;
      const maxTurns = Math.min(
        MAX_GOAL_MAX_TURNS,
        Math.max(1, input.maxTurns ?? prevGoal?.maxTurns ?? DEFAULT_GOAL_MAX_TURNS),
      );

      let finalSpec = rawSpec;
      let autoRefined = false;
      let storedRawSpec: string | null = rawSpec || null;

      if (rawSpec !== "" && prevGoal?.spec === rawSpec) {
        finalSpec = rawSpec;
        autoRefined = prevGoal.autoRefined ?? false;
        storedRawSpec = prevGoal.rawSpec ?? rawSpec;
      } else {
        const rawItem = [...stateBefore.customItems, ...stateBefore.rawItems].find(
          (r) => normalizeCardId(r.id) === cardId,
        );
        let digest: {
          firstUserMessage?: string;
          recentUserMessages?: string[];
          latestAssistantReply?: string;
        } = {};
        if (targetAgentId) {
          const refreshed = await paseo.agents.ref(targetAgentId).refresh().catch(() => null);
          if (refreshed?.agent) {
            digest = await extractConversationDigest(paseo, refreshed.agent).catch(() => ({}));
          }
        }
        const models = await this.getModels(paseo);
        const synthesized = await synthesizeRadarGoal({
          rawSpec,
          verifyCommand: cleanVerify,
          context: {
            id: cardId,
            title: matchedCard?.title ?? rawItem?.title ?? cardId,
            source: matchedCard?.source ?? rawItem?.source,
            badge: matchedCard?.badge ?? rawItem?.badge,
            summary: matchedCard?.summary ?? rawItem?.summary,
            links: matchedCard?.links ?? rawItem?.links,
            prepPrompt: rawItem?.prepPrompt,
            workPrompt: rawItem?.workPrompt,
            workspaceName: matchedCard?.workspace?.workspaceName ?? null,
            projectName: matchedCard?.projectName ?? null,
            ...digest,
          },
          summaryModels: models.resolved.summaryModels,
          paseo,
        });
        finalSpec = synthesized.spec;
        autoRefined = synthesized.autoRefined;
      }

      nextGoal = {
        spec: finalSpec,
        rawSpec: storedRawSpec,
        autoRefined,
        active: true,
        agentId: targetAgentId ?? prevGoal?.agentId ?? null,
        verifyCommand: cleanVerify,
        turnCount: 0,
        maxTurns,
        lastEvalNote: null,
        stopReason: null,
        updatedAt: nowIso,
      };
    }

    this.summaryQueue.invalidateCard(cardId);
    await updateRadarState((s) => {
      const prev = s.meta[cardId] ?? {};
      const wasArchived = normalizeStoredStatus(prev.customStatus) === "archived";
      s.meta[cardId] = {
        ...prev,
        ...(targetWsId ? { boundWorkspaceId: targetWsId } : {}),
        ...(targetAgentId ? { boundAgentId: targetAgentId } : {}),
        ...(wasArchived
          ? { customStatus: "needs_me", autoArchivedAt: null, autoArchivedHash: null }
          : {}),
        ...buildClearedNeedsMeTagPatch(nowIso),
        goal: nextGoal,
      };
    });

    if (input.steerNow !== false) {
      const kickoffPrompt = this.formatGoalKickoffBlock(nextGoal, input.action === "resume");
      if (targetAgentId) {
        this.markAgentTurnPending(targetAgentId);
        await paseo.agents.ref(targetAgentId).send(kickoffPrompt, { activeTurnBehavior: "steer" });
      } else if (targetWsId) {
        const modelsForWorker = await this.getModels(paseo);
        const chosenProvider =
          matchedCard?.selectedModel || modelsForWorker.resolved.defaultWorkerModel;
        if (!chosenProvider) {
          throw new Error("未找到可用模型，请先在 Paseo 启用至少一个模型 Provider。");
        }
        const matchedAssignable = modelsForWorker.resolved.assignableModels.find(
          (m) => m.model === chosenProvider,
        );
        const created = await paseo.workspaces.ref(targetWsId).agents.create({
          config: {
            provider: chosenProvider,
            ...(matchedAssignable?.modeId ? { modeId: matchedAssignable.modeId } : {}),
            thinkingOptionId: matchedAssignable?.thinkingOptionId ?? "medium",
            ...(matchedAssignable?.featureValues
              ? { featureValues: matchedAssignable.featureValues }
              : {}),
            systemPrompt: withWorkerSystemPrompt(undefined, modelsForWorker.timezone, isPiProvider(chosenProvider)),
          },
          title: nextGoal.spec.slice(0, 52),
          labels: {
            [RADAR_LABELS.card]: cardId,
          },
          prompt: `${kickoffPrompt}${STYLE_DIRECTIVE}`,
        });
        targetAgentId = created.id;
        nextGoal = { ...nextGoal, agentId: created.id };
        this.markAgentTurnPending(created.id);
        await updateRadarState((s) => {
          if (s.meta[cardId]) {
            s.meta[cardId] = {
              ...s.meta[cardId],
              boundWorkspaceId: targetWsId,
              boundAgentId: created.id,
              ...(s.meta[cardId]?.goal ? { goal: { ...s.meta[cardId]!.goal!, agentId: created.id } } : {}),
            };
          }
        });
      } else if (matchedCard) {
        const started = await this.followItem(paseo, {
          itemId: cardId,
          mode: "background",
          note: "",
        });
        targetWsId = started.workspaceId;
        targetAgentId = started.agentId;
        nextGoal = { ...nextGoal, agentId: started.agentId };
        await updateRadarState((s) => {
          if (s.meta[cardId]?.goal) {
            s.meta[cardId] = {
              ...s.meta[cardId],
              goal: { ...s.meta[cardId]!.goal!, agentId: started.agentId },
            };
          }
        });
      }
    }

    return {
      cardId,
      agentId: targetAgentId,
      goal: nextGoal,
      snapshot: await this.loadSnapshot(paseo),
    };
  }

  async snoozeItem(itemId: string, preset: SnoozePreset): Promise<string> {
    const rawSettings = await this.getRawSettings();
    const until = computeSnoozeUntil(preset, new Date(), rawSettings.timezone);
    await updateRadarState((state) => {
      const item = [...state.customItems, ...state.rawItems].find((x) => x.id === itemId);
      const fallbackHash = itemId.startsWith("ws-") ? `ws:${itemId.slice(3)}` : "snoozed";
      state.meta[itemId] = {
        ...state.meta[itemId],
        snoozedUntil: until,
        snoozedHash: item?.stateHash ?? fallbackHash,
      };
    });
    return until;
  }

  async dismissItem(itemId: string): Promise<void> {
    await updateRadarState((state) => {
      const item = [...state.customItems, ...state.rawItems].find((x) => x.id === itemId);
      const fallbackHash = itemId.startsWith("ws-") ? `ws:${itemId.slice(3)}` : "dismissed";
      state.meta[itemId] = {
        ...state.meta[itemId],
        dismissedHash: item?.stateHash ?? fallbackHash,
        snoozedUntil: null,
      };
    });
  }

  async restoreItem(itemId: string): Promise<void> {
    await updateRadarState((state) => {
      if (state.meta[itemId]) {
        state.meta[itemId] = {
          ...state.meta[itemId],
          dismissedHash: null,
          snoozedUntil: null,
          snoozedHash: null,
          customStatus: normalizeStoredStatus(state.meta[itemId].customStatus) === "archived" ? null : state.meta[itemId].customStatus,
          autoArchivedAt: null,
          autoArchivedHash: null,
        };
      }
    });
  }

  async ensureCopilot(paseo: PaseoApi, initialPrompt?: string): Promise<{ agentId: string; created: boolean }> {
    this.rememberPaseo(paseo);
    const models = await this.getModels(paseo);
    const copilotModels = models.copilotModels;
    const copilotModel = copilotModels[0] ?? "";
    if (!copilotModel) {
      throw new Error("当前服务端尚未配置可用的模型 Provider，请先在 Paseo 设置中启用至少一个模型。");
    }
    const state = await readRadarState();
    if (state.copilotAgentId) {
      try {
        const res = await paseo.agents.ref(state.copilotAgentId).refresh();
        if (res?.agent && !res.agent.archivedAt) {
          const curFull = formatFullModel(res.agent, copilotModel);
          if (curFull !== copilotModel) {
            await setLiveAgentModel(res.agent.id, res.agent.provider, copilotModel).catch(() => {});
          }
          return { agentId: res.agent.id, created: false };
        }
      } catch {
        // Recreate below
      }
    }
    const home = await ensureRadarHome();
    const ws = await paseo.workspaces.open(home);
    let lastErr: unknown = null;
    for (let i = 0; i < copilotModels.length; i++) {
      const candidate = copilotModels[i]!;
      try {
        const agent = await ws.agents.create({
          config: {
            provider: candidate,
            thinkingOptionId: "low",
            systemPrompt: COPILOT_SYSTEM_PROMPT,
          },
          title: COPILOT_TITLE,
          labels: { [RADAR_LABELS.role]: RADAR_LABELS.copilotRole },
          ...(initialPrompt ? { prompt: initialPrompt } : {}),
        });
        await updateRadarState((s) => {
          s.copilotAgentId = agent.id;
        });
        return { agentId: agent.id, created: true };
      } catch (err) {
        lastErr = err;
        if (i + 1 < copilotModels.length) {
          const nextModel = copilotModels[i + 1]!;
          console.warn(
            `[paseo-radar] copilot create with (${candidate}) failed, falling back to (${nextModel}):`,
            err,
          );
          this.recordModelAlert({
            key: `agent:看板助手:fallback:${candidate}`,
            role: "看板助手",
            model: candidate,
            fallbackModel: nextModel,
            severity: "warning",
            message: formatModelErrorMessage(err),
            cardTitle: COPILOT_TITLE,
            retryable: false,
          });
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async askCopilot(paseo: PaseoApi, text: string): Promise<string> {
    const { agentId, created } = await this.ensureCopilot(paseo, text);
    if (!created) {
      await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    }
    return agentId;
  }

  async stopCopilot(): Promise<void> {
    const state = await readRadarState();
    if (!state.copilotAgentId) return;
    const cli = await resolvePaseoBinary();
    await execCommand(cli, ["stop", state.copilotAgentId], {
      timeout: 8000,
      env: buildExtendedEnv(),
    }).catch(() => {});
  }

  async archiveCopilot(paseo: PaseoApi, onlyIfIdle = false): Promise<boolean> {
    this.rememberPaseo(paseo);
    const live = await listLiveAgents(paseo).catch(() => [] as PaseoAgent[]);
    const state = await readRadarState();
    const copilotAgents = live.filter(
      (a) => a.labels[RADAR_LABELS.role] === RADAR_LABELS.copilotRole || a.id === state.copilotAgentId,
    );

    if (copilotAgents.length === 0) {
      if (state.copilotAgentId !== null) {
        await updateRadarState((s) => {
          s.copilotAgentId = null;
        });
      }
      return false;
    }

    if (onlyIfIdle && copilotAgents.some((a) => a.status === "running" || a.status === "initializing")) {
      return false;
    }

    const wsIds = new Set<string>();
    for (const a of copilotAgents) {
      if (a.workspaceId) wsIds.add(a.workspaceId);
      await paseo.agents.ref(a.id).archive().catch(() => {});
    }
    for (const wsId of wsIds) {
      await paseo.workspaces.archive(wsId).catch(() => {});
    }

    await updateRadarState((s) => {
      s.copilotAgentId = null;
    });
    return true;
  }

  async onAgentTurnBefore(agent: {
    id: string;
    workspaceId: string | null;
    parentAgentId?: string | null;
    cwd: string;
  }): Promise<void> {
    this.pendingTurnStartUntil.delete(agent.id);
    if (isInternalPluginPath(agent.cwd)) return;

    if (agent.parentAgentId) {
      const live = this.paseoHandle
        ? (await this.paseoHandle.agents.ref(agent.id).refresh().catch(() => null))?.agent
        : null;
      if (!live?.labels?.[RADAR_LABELS.subcard]) {
        return;
      }
      const subScopeKey = agent.workspaceId ?? agent.id;
      const gitSnap = await captureGitDirtySnapshot(agent.cwd);
      if (gitSnap) {
        await updateRadarState((s) => {
          s.gitBaselines = s.gitBaselines ?? {};
          const prev = s.gitBaselines[subScopeKey];
          s.gitBaselines[subScopeKey] = mergeGitBaseline(prev, gitSnap);
        });
      }
      return;
    }

    const nowIso = new Date().toISOString();
    const scopeKey = agent.workspaceId ?? agent.id;
    const state = await readRadarState();
    const { inScopeCardIds, clearCardIds } = findMatchingTurnBeforeCards(state.meta, agent);
    for (const cid of inScopeCardIds) {
      this.summaryQueue.invalidateCard(cid);
    }

    const clearSet = new Set(clearCardIds);
    const hasMetaToStamp = inScopeCardIds.some((id) => Boolean(state.meta[id]));
    if (clearSet.size > 0 || hasMetaToStamp) {
      await updateRadarState((s) => {
        for (const id of inScopeCardIds) {
          if (!s.meta[id]) continue;
          if (clearSet.has(id)) {
            s.meta[id] = {
              ...s.meta[id],
              ...buildClearedNeedsMeTagPatch(nowIso),
            };
          } else {
            s.meta[id] = {
              ...s.meta[id],
              needsMeTagClearedAt: nowIso,
            };
          }
        }
      });
    }

    const gitSnap = await captureGitDirtySnapshot(agent.cwd);
    const prevBaseline = state.gitBaselines?.[scopeKey];
    const nextBaseline = gitSnap ? mergeGitBaseline(prevBaseline, gitSnap) : null;
    const baselineChanged =
      nextBaseline !== null &&
      (!prevBaseline ||
        prevBaseline.repoRoot !== nextBaseline.repoRoot ||
        JSON.stringify(prevBaseline.entries) !== JSON.stringify(nextBaseline.entries));

    if (!baselineChanged || !nextBaseline) return;

    await updateRadarState((s) => {
      s.gitBaselines = s.gitBaselines ?? {};
      s.gitBaselines[scopeKey] = mergeGitBaseline(s.gitBaselines[scopeKey], nextBaseline);
    });
  }

  async onAgentTurnAfter(
    paseo: PaseoApi,
    agentId: string,
    outcome?: PluginTurnOutcome,
    parentAgentId?: string | null,
  ): Promise<void> {
    this.rememberPaseo(paseo);
    this.pendingTurnStartUntil.delete(agentId);
    let live: PaseoAgent | null = null;
    try {
      live = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    } catch {
      return;
    }
    if (!live || live.archivedAt) return;

    // Intercept Radar coordination subcard agents BEFORE skipping delegated subagents
    const subcardId = live.labels[RADAR_LABELS.subcard];
    const parentCardId = live.labels[RADAR_LABELS.parentCard];
    if (subcardId && parentCardId) {
      await this.coordination.onSubcardTurnAfter({
        parentCardId,
        subcardId,
        agentId,
        outcomeKind: outcome?.kind,
        errorMessage: outcome?.kind === "failed" ? outcome.error.message : undefined,
      });
      return;
    }

    if (parentAgentId) return;
    if (isDelegatedSubagentLabels(live.labels)) return;

    const [state, models] = await Promise.all([readRadarState(), this.getModels(paseo)]);
    if (live.labels[RADAR_LABELS.role] === RADAR_LABELS.oneshotRole) return;
    const fullModel = formatFullModel(live, models.resolved.defaultWorkerModel);
    const isCopilot =
      live.labels[RADAR_LABELS.role] === RADAR_LABELS.copilotRole || agentId === state.copilotAgentId;
    const isWaitEval = Boolean(live.cwd?.includes("/.paseo/plugin-data/paseo-radar/wait-checks"));

    if (isCopilot || isWaitEval || isInternalPluginPath(live.cwd)) {
      const internalRole = isCopilot ? "看板助手" : isWaitEval ? "等待评估" : "内部会话";
      const alertKey = `agent:${internalRole}:${fullModel}`;
      const roleModels = isCopilot
        ? models.copilotModels
        : isWaitEval
          ? (models.waitEvalModels.length > 0 ? models.waitEvalModels : models.copilotModels)
          : [];

      if (outcome?.kind === "failed") {
        const idx = roleModels.indexOf(fullModel);
        const nextModel = idx >= 0 && idx + 1 < roleModels.length ? roleModels[idx + 1] : undefined;
        if (nextModel && (isCopilot || isWaitEval)) {
          console.warn(
            `[paseo-radar] ${internalRole} (${fullModel}) failed, falling back to (${nextModel}): ${outcome.error.message}`,
          );
          this.recordModelAlert({
            key: `agent:${internalRole}:fallback:${fullModel}`,
            role: internalRole,
            model: fullModel,
            fallbackModel: nextModel,
            severity: "warning",
            message: formatModelErrorMessage(outcome.error.message),
            cardTitle: decodeSafe(live.title) || null,
            agentId: live.id,
            retryable: false,
          });
          try {
            await setLiveAgentModel(live.id, live.provider, nextModel);
            this.markAgentTurnPending(live.id);
            await paseo.agents.ref(live.id).send("请继续完成上一轮失败的操作。", {
              activeTurnBehavior: "steer",
            });
            return;
          } catch {
            // Cross-provider fallback: recreate agent on nextModel with latest prompt
            try {
              const digest = await extractConversationDigest(paseo, live);
              const prompt =
                (isCopilot
                  ? digest.recentUserMessages[digest.recentUserMessages.length - 1]
                  : digest.firstUserMessage) || "请继续完成上一轮失败的操作。";
              const targetDir = isCopilot ? await ensureRadarHome() : waitChecksDir();
              const ws = await paseo.workspaces.open(targetDir);
              const nextAgent = await ws.agents.create({
                config: {
                  provider: nextModel,
                  thinkingOptionId: "low",
                  ...(isCopilot ? { systemPrompt: COPILOT_SYSTEM_PROMPT } : {}),
                },
                title: decodeSafe(live.title) || (isCopilot ? COPILOT_TITLE : "[Radar 等外部]"),
                ...(isCopilot ? { labels: { [RADAR_LABELS.role]: RADAR_LABELS.copilotRole } } : {}),
                prompt,
              });
              this.markAgentTurnPending(nextAgent.id);
              if (isCopilot) {
                await updateRadarState((s) => {
                  s.copilotAgentId = nextAgent.id;
                });
              }
              await paseo.agents.ref(live.id).archive().catch(() => {});
              return;
            } catch (fallbackErr) {
              console.warn(`[paseo-radar] ${internalRole} cross-provider fallback failed:`, fallbackErr);
            }
          }
        }
        this.recordModelAlert({
          key: alertKey,
          role: internalRole,
          model: fullModel,
          severity: "error",
          message: formatModelErrorMessage(outcome.error.message),
          cardTitle: decodeSafe(live.title) || null,
          agentId: live.id,
          retryable: true,
        });
      } else if (outcome?.kind === "completed") {
        this.modelAlerts.delete(alertKey);
        if (roleModels[0] && fullModel === roleModels[0]) {
          for (const k of this.modelAlerts.keys()) {
            if (k.startsWith(`agent:${internalRole}:fallback:`)) {
              this.modelAlerts.delete(k);
            }
          }
        }
      }
      return;
    }
    const matchBound = (pred: (id: string) => boolean) =>
      Object.entries(state.meta).find(
        ([id, m]) =>
          pred(id) && (m.boundAgentId === agentId || (live?.workspaceId && m.boundWorkspaceId === live.workspaceId)),
      )?.[0];

    const definedIds = new Set([...state.rawItems, ...state.customItems].map((r) => r.id));
    let matchedByTokenCardId: string | undefined;
    const explicitLabel = getAgentCardLabel(live);
    const activeBoundCardId = matchBound((id) => definedIds.has(id));
    const activeExplicitLabel = explicitLabel && definedIds.has(explicitLabel) ? explicitLabel : undefined;

    if (!activeBoundCardId && !activeExplicitLabel) {
      const agentKeys = extractCanonicalEntityKeys({
        cardId: explicitLabel,
        title: decodeSafe(live.title),
        branchHint: live.cwd ?? null,
      });
      if (agentKeys.size > 0) {
        for (const item of [...state.rawItems, ...state.customItems]) {
          const itemMeta = state.meta[item.id];
          if (itemMeta?.boundWorkspaceId && itemMeta.boundWorkspaceId !== live.workspaceId) continue;
          if (setsIntersect(agentKeys, rawItemEntityKeys(item))) {
            matchedByTokenCardId = item.id;
            break;
          }
        }
      }
    }

    const cardId =
      activeBoundCardId ??
      activeExplicitLabel ??
      matchedByTokenCardId ??
      matchBound((id) => !id.startsWith("ws-")) ??
      explicitLabel ??
      matchBound((id) => id.startsWith("ws-")) ??
      (live.workspaceId &&
      (models.trackLocalWorkspaces || Boolean(state.meta[`ws-${live.workspaceId}`]?.goal))
        ? `ws-${live.workspaceId}`
        : null);

    if (!cardId) return;

    const boundRaw = [...state.customItems, ...state.rawItems].find((r) => r.id === cardId);
    if (outcome?.kind) {
      void recordInsightEvent({
        type: "turn_outcome",
        at: new Date().toISOString(),
        outcome: outcome.kind,
        model: fullModel,
        cardId,
      });
    }
    const workerAlertKey = `agent:卡片会话:${fullModel}`;
    if (outcome?.kind === "failed") {
      if (state.meta[cardId]?.needsMeTag === "ready_to_archive") {
        this.summaryQueue.invalidateCard(cardId);
        await updateRadarState((s) => {
          if (s.meta[cardId]?.needsMeTag === "ready_to_archive") {
            s.meta[cardId] = {
              ...s.meta[cardId],
              ...buildClearedNeedsMeTagPatch(new Date().toISOString()),
            };
          }
        });
      }
      this.recordModelAlert({
        key: workerAlertKey,
        role: "卡片会话",
        model: fullModel,
        message: formatModelErrorMessage(outcome.error.message),
        cardTitle: boundRaw?.title ?? (decodeSafe(live.title) || cardId),
        cardId,
        agentId: live.id,
        retryable: true,
      });
      return;
    }
    if (outcome?.kind === "completed") {
      this.modelAlerts.delete(workerAlertKey);
    }

    if (normalizeStoredStatus(state.meta[cardId]?.customStatus) === "waiting_external") return;

    try {
      const [tailReply, digest] = await Promise.all([
        readAgentTailReply(paseo, agentId, 30).catch(() => ""),
        extractConversationDigest(paseo, live),
      ]);
      const replyAfterTag = findUserReplyAfterTag(state.meta[cardId], [live]);
      if (
        replyAfterTag ||
        digest.hasUnansweredUserMessage ||
        (outcome?.kind === "canceled" && state.meta[cardId]?.needsMeTag === "ready_to_archive")
      ) {
        const clearedAt = replyAfterTag?.clearedAt ?? new Date().toISOString();
        this.summaryQueue.invalidateCard(cardId);
        await updateRadarState((s) => {
          if (s.meta[cardId]) {
            s.meta[cardId] = {
              ...s.meta[cardId],
              ...buildClearedNeedsMeTagPatch(clearedAt),
            };
          }
        });
        if (digest.hasUnansweredUserMessage) return;
      }
      const fullText = tailReply || digest.latestAssistantReply;
      if (!fullText) return;

      let shouldNotifyCopilot = false;
      let copilotId: string | null = null;
      const wsCurrentTitle = live.workspaceId
        ? decodeSafe(paseo.workspaces.ref(live.workspaceId).current()?.title).trim()
        : "";
      let cardTitle = (cardId.startsWith("ws-") && wsCurrentTitle ? wsCurrentTitle : "") || decodeSafe(live.title) || cardId;
      let cardContext: SummaryCardContext = {
        id: cardId,
        source: cardId.startsWith("ws-") ? "workspace" : undefined,
        badge: cardId.startsWith("ws-") ? "本地会话" : undefined,
        summary: live.cwd ? `本地工作区 · ${live.cwd}` : "本地工作区会话",
        firstUserMessage: digest.firstUserMessage,
        recentUserMessages: digest.recentUserMessages,
      };

      await updateRadarState((s) => {
        const foundRaw = [...s.customItems, ...s.rawItems].find((r) => r.id === cardId);
        if (foundRaw) {
          cardTitle = foundRaw.title;
          const kickoff = buildKickoffPrompt("background", foundRaw);
          cardContext = {
            id: foundRaw.id,
            source: foundRaw.source,
            badge: foundRaw.badge,
            closureGate: foundRaw.closureGate,
            summary: foundRaw.summary,
            links: resolveItemLinks({
              attachedLinks: s.meta[cardId]?.attachedLinks,
              removedLinkKeys: s.meta[cardId]?.removedLinkKeys,
              url: foundRaw.url,
              secondaryUrl: foundRaw.secondaryUrl,
              links: foundRaw.links,
              extraLinks: s.meta[cardId]?.extraLinks,
              title: foundRaw.title,
              summary: foundRaw.summary,
              labelContext: [s.meta[cardId]?.prepSummary, kickoff].filter(Boolean).join("\n"),
              prompt: kickoff,
              relatedKeys: foundRaw.relatedKeys,
              branchHint: foundRaw.existingBranch ?? null,
            }),
            firstUserMessage: digest.firstUserMessage,
            recentUserMessages: digest.recentUserMessages,
            goal: s.meta[cardId]?.goal ?? null,
          };
        } else {
          cardContext = {
            ...cardContext,
            goal: s.meta[cardId]?.goal ?? null,
          };
        }
        if (normalizeStoredStatus(s.meta[cardId]?.customStatus) === "archived") {
          s.meta[cardId] = {
            ...s.meta[cardId],
            customStatus: "needs_me",
            autoArchivedAt: null,
            autoArchivedHash: null,
          };
        }
        if (matchedByTokenCardId === cardId && live?.workspaceId) {
          s.meta[cardId] = {
            ...s.meta[cardId],
            boundWorkspaceId: live.workspaceId,
            boundAgentId: agentId,
          };
          delete s.meta[`ws-${live.workspaceId}`];
        }
        if (s.meta[cardId]?.notifyCopilotOnFinish) {
          shouldNotifyCopilot = true;
          s.meta[cardId].notifyCopilotOnFinish = false;
        }
        copilotId = s.copilotAgentId;
      });

      this.summaryQueue.enqueue({
        cardId,
        cardTitle,
        cardContext,
        workspaceId: live.workspaceId ?? null,
        agentId,
        fullReply: fullText,
        summaryModels: models.summaryModels,
        paseo,
        allowGoalSteer: true,
      });

      if (shouldNotifyCopilot && copilotId) {
        const relayMsg = `[系统回调：先行调研已完成]\n卡片：${cardTitle} (id: ${cardId}, agentId: ${agentId})\n调研结论摘要：\n${fullText.slice(0, 2500)}\n\n请根据上述调研结果向用户简明汇报核心发现，并按需询问或创建后续具体执行卡片。`;
        await paseo.agents.ref(copilotId).send(relayMsg, { activeTurnBehavior: "steer" }).catch((err: unknown) => {
          console.warn("[paseo-radar] could not relay scout findings to copilot:", err);
        });
      }
    } catch (err) {
      console.warn("[paseo-radar] could not capture turn summary:", err);
    }

    if (state.meta[cardId]?.coordinationEnabled) {
      await this.coordination.onCoordinatorTurnAfter(cardId);
    }
  }

  async onWorkspaceArchived(workspaceId: string, archivedAt: string): Promise<void> {
    const archivedCardIds: string[] = [];
    await updateRadarState((s) => {
      if (s.gitBaselines?.[workspaceId]) {
        delete s.gitBaselines[workspaceId];
      }
      for (const [cardId, meta] of Object.entries(s.meta)) {
        if (meta?.subcardWorkspaceIds?.includes(workspaceId)) {
          s.meta[cardId] = {
            ...meta,
            subcardWorkspaceIds: meta.subcardWorkspaceIds.filter((id) => id !== workspaceId),
          };
        }
        if (meta?.boundWorkspaceId === workspaceId || cardId === `ws-${workspaceId}`) {
          archivedCardIds.push(cardId);
          const raw = [...s.customItems, ...s.rawItems].find((r) => r.id === cardId);
          s.meta[cardId] = {
            ...meta,
            boundWorkspaceId: null,
            boundAgentId: null,
            waitAgentId: null,
            waitMode: null,
            waitPredicate: null,
            waitProviderId: null,
            waitBoard: null,
            needsMeTagAgentId: null,
            awaitingDecision: false,
            coordinationEnabled: false,
            subcardWorkspaceIds: [],
            ...(meta.goal ? { goal: { ...meta.goal, active: false } } : {}),
            customStatus: "archived",
            autoArchivedAt: archivedAt,
            autoArchivedHash: raw?.stateHash ?? `ws:${workspaceId}`,
          };
        }
      }
    });
    for (const cid of archivedCardIds) {
      await this.coordination.cleanupParentBoard(cid);
      await this.evaluateOuterBoardWatchers(cid);
    }
  }

  async onAgentArchived(
    paseo: PaseoApi,
    agent: { id: string; workspaceId: string | null; parentAgentId?: string | null },
    archivedAt: string,
  ): Promise<void> {
    if (agent.parentAgentId) {
      await updateRadarState((s) => {
        if (s.gitBaselines?.[agent.id]) {
          delete s.gitBaselines[agent.id];
        }
      });
      return;
    }

    let remainingAgents: PaseoAgent[] = [];
    if (agent.workspaceId) {
      const live = await listLiveAgents(paseo).catch(() => [] as PaseoAgent[]);
      remainingAgents = live
        .filter((a) => a.id !== agent.id && a.workspaceId === agent.workspaceId && isUserConversationAgent(a))
        .sort((a, b) => {
          const activeDiff = Number(b.status !== "closed") - Number(a.status !== "closed");
          if (activeDiff !== 0) return activeDiff;
          return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        });
    }
    const remainingInWs = remainingAgents.length;
    const handoffAgentId = remainingAgents[0]?.id ?? null;

    const archivedCardIds: string[] = [];
    await updateRadarState((s) => {
      if (s.gitBaselines?.[agent.id]) {
        delete s.gitBaselines[agent.id];
      }
      if (agent.workspaceId && remainingInWs === 0 && s.gitBaselines?.[agent.workspaceId]) {
        delete s.gitBaselines[agent.workspaceId];
      }
      for (const [cardId, meta] of Object.entries(s.meta)) {
        if (!meta) continue;
        const matchedAgent = meta.boundAgentId === agent.id;
        const matchedWs =
          agent.workspaceId !== null &&
          (meta.boundWorkspaceId === agent.workspaceId || cardId === `ws-${agent.workspaceId}`);

        if ((matchedAgent && remainingInWs === 0) || (matchedWs && remainingInWs === 0)) {
          archivedCardIds.push(cardId);
          const raw = [...s.customItems, ...s.rawItems].find((r) => r.id === cardId);
          s.meta[cardId] = {
            ...meta,
            boundWorkspaceId: null,
            boundAgentId: null,
            waitAgentId: null,
            waitMode: null,
            waitPredicate: null,
            waitProviderId: null,
            waitBoard: null,
            needsMeTagAgentId: null,
            awaitingDecision: false,
            coordinationEnabled: false,
            subcardWorkspaceIds: [],
            ...(meta.goal ? { goal: { ...meta.goal, active: false } } : {}),
            customStatus: "archived",
            autoArchivedAt: archivedAt,
            autoArchivedHash: raw?.stateHash ?? (agent.workspaceId ? `ws:${agent.workspaceId}` : "archived"),
          };
        } else if ((matchedAgent || matchedWs) && handoffAgentId) {
          s.meta[cardId] = {
            ...meta,
            ...(meta.boundAgentId === agent.id ? { boundAgentId: handoffAgentId } : {}),
            ...(meta.waitAgentId === agent.id ? { waitAgentId: handoffAgentId } : {}),
            ...(meta.needsMeTagAgentId === agent.id ? { needsMeTagAgentId: handoffAgentId } : {}),
            ...(meta.decisionProposal?.agentId === agent.id
              ? { decisionProposal: { ...meta.decisionProposal, agentId: handoffAgentId } }
              : {}),
            ...(meta.goal?.agentId === agent.id
              ? { goal: { ...meta.goal, agentId: handoffAgentId } }
              : {}),
          };
        }
      }
    });
    for (const cid of archivedCardIds) {
      await this.coordination.cleanupParentBoard(cid);
      await this.evaluateOuterBoardWatchers(cid, paseo);
    }
  }

  async toggleCoordinationByTarget(
    paseo: PaseoApi,
    input: {
      itemId?: string;
      workspaceId?: string;
      agentId?: string;
      enabled: boolean;
      steerNow?: boolean;
    },
  ): Promise<{
    cardId: string;
    enabled: boolean;
    summary: CoordinationSummary;
    snapshot: RadarSnapshot;
  }> {
    this.rememberPaseo(paseo);
    let cardId = input.itemId ? normalizeCardId(input.itemId) : "";
    if (!cardId) {
      const snap = await this.loadSnapshot(paseo);
      const matched =
        (input.agentId
          ? snap.items.find((it) => it.workspace?.agentIds.includes(input.agentId!))
          : undefined) ??
        (input.workspaceId
          ? snap.items.find(
              (it) =>
                it.workspace?.workspaceId === input.workspaceId ||
                it.id === `ws-${input.workspaceId}`,
            )
          : undefined);
      cardId = matched?.id ?? (input.workspaceId ? `ws-${input.workspaceId}` : "");
    }
    if (!cardId) {
      throw new Error("未找到关联的 Radar 卡片");
    }
    const res = await this.coordination.toggleCoordination({
      cardId,
      enabled: input.enabled,
      steerNow: input.steerNow,
      callerAgentId: input.agentId ?? null,
    });
    const snapshot = await this.loadSnapshot(paseo);
    return { ...res, snapshot };
  }

  async getCoordBoardDetail(
    paseo: PaseoApi,
    cardId: string,
    eventLimit = 150,
  ): Promise<CoordBoardDetail> {
    this.rememberPaseo(paseo);
    return this.coordination.getBoardDetail(normalizeCardId(cardId), eventLimit);
  }

  async readCoordArtifact(paseo: PaseoApi, cardId: string, relativePath: string) {
    this.rememberPaseo(paseo);
    return this.coordination.readArtifact(normalizeCardId(cardId), relativePath);
  }

  async handleCoordSubcardAction(
    paseo: PaseoApi,
    input: {
      cardId: string;
      subcardId: string;
      action: "start" | "reply" | "archive" | "cancel";
      text?: string;
    },
  ): Promise<{ detail: CoordBoardDetail }> {
    this.rememberPaseo(paseo);
    const detail = await this.coordination.handleSubcardAction({
      cardId: normalizeCardId(input.cardId),
      subcardId: input.subcardId,
      action: input.action,
      text: input.text,
      actor: "human",
    });
    return { detail };
  }

  async lookupSubcardSession(paseo: PaseoApi, agentId: string) {
    this.rememberPaseo(paseo);
    return this.coordination.lookupSubcardSession(agentId);
  }

  workerTools(): AgentToolDefinition[] {
    return buildWorkerTools(this);
  }

  coordinatorTools(): AgentToolDefinition[] {
    return buildCoordinatorTools(this);
  }

  subcardTools(): AgentToolDefinition[] {
    return buildSubcardTools(this);
  }

  waitCheckTools(): AgentToolDefinition[] {
    return buildWaitCheckTools(this);
  }

  copilotTools(): AgentToolDefinition[] {
    return buildCopilotTools(this);
  }

  async loadInsights(paseo: PaseoApi, reportId?: string) {
    this.rememberPaseo(paseo);
    return this.insights.load(reportId);
  }

  async generateInsights(
    paseo: PaseoApi,
    input: {
      window: InsightWindow;
      customFocus?: string;
      locale?: string;
      forceRefreshCache?: boolean;
    },
  ) {
    this.rememberPaseo(paseo);
    const [models, projects] = await Promise.all([
      this.getModels(paseo),
      listUserProjects(paseo),
    ]);
    return this.insights.generate(input, {
      paseo,
      projects,
      insightModels: models.insightModels,
      timeZone: models.timezone,
      onModelFallback: ({ failedModel, nextModel, error }) => {
        this.recordModelAlert({
          key: `insights:fallback:${failedModel}`,
          role: "洞察分析",
          model: failedModel,
          fallbackModel: nextModel,
          severity: "warning",
          message: formatModelErrorMessage(error),
          retryable: false,
        });
      },
      onModelError: ({ failedModel, error }) => {
        this.recordModelAlert({
          key: `insights:${failedModel}`,
          role: "洞察分析",
          model: failedModel,
          severity: "error",
          message: formatModelErrorMessage(error),
          retryable: false,
        });
      },
    });
  }

  async exportInsightHtml(reportId: string) {
    return this.insights.exportHtml(reportId);
  }

  async deleteInsightReport(reportId: string) {
    return this.insights.deleteReport(reportId);
  }
}
