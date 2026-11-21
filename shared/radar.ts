import { ItemArchetypeSchema, ProviderProtocolKindSchema, ProviderLifecycleSchema, ProviderCapabilitiesSchema } from "./provider-protocol";
export * from "./provider-protocol";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { BoardWatchSpecSchema, CoordinationSummarySchema } from "./coordination";
import {
  CardStatusSchema,
  DecisionProposalSchema,
  NeedsMeTagSchema,
  RadarLinkInputSchema,
  RadarLinkKindSchema,
  RadarLinkSchema,
  WaitModeSchema,
} from "./radar-primitives";

export * from "./radar-primitives";

export const RADAR_SCREEN_ID = "radar";
export const RADAR_PANEL_ID = "radar-card-panel";

export const RADAR_LABELS = {
  role: "paseo-radar.role",
  copilotRole: "copilot",
  oneshotRole: "oneshot",
  card: "paseo-radar.card",
  subcard: "paseo-radar.subcard",
  parentCard: "paseo-radar.parent-card",
  coordMode: "paseo-radar.coord-mode",
  parentAgent: "paseo.parent-agent-id",
} as const;

export function isDelegatedSubagentLabels(
  labels: Record<string, string | undefined> | null | undefined,
): boolean {
  const parentId = labels?.[RADAR_LABELS.parentAgent];
  return typeof parentId === "string" && parentId.trim().length > 0;
}

export const CARD_STATUS_META: Record<z.infer<typeof CardStatusSchema>, { label: string; selectableWithSession: boolean }> = {
  pool: { label: "待办池", selectableWithSession: false },
  running: { label: "AI 处理中", selectableWithSession: false },
  needs_me: { label: "待我处理", selectableWithSession: true },
  waiting_external: { label: "等待外部", selectableWithSession: true },
  archived: { label: "已归档", selectableWithSession: false },
};

export const RadarGroupSchema = z.enum(["urgent", "closing", "todo", "local"]);
export type RadarGroup = z.infer<typeof RadarGroupSchema>;

export const RadarRoleHintSchema = z.enum(["backend", "design", "light"]);
export type RadarRoleHint = z.infer<typeof RadarRoleHintSchema>;

export const RadarSourceSchema = z.string().min(1);
export type RadarSource = z.infer<typeof RadarSourceSchema>;

export const SnoozePresetSchema = z.enum(["4h", "tomorrow", "next_monday"]);
export type SnoozePreset = z.infer<typeof SnoozePresetSchema>;

export const ProjectOptionSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  kind: z.enum(["git", "non_git"]),
  path: z.string(),
});
export type ProjectOption = z.infer<typeof ProjectOptionSchema>;

export const LinkedSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]),
  model: z.string(),
  pendingPermissions: z.number().int(),
  updatedAt: z.string(),
});
export type LinkedSession = z.infer<typeof LinkedSessionSchema>;

export const LinkedWorkspaceSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  cwd: z.string().nullable(),
  primaryAgentId: z.string().nullable(),
  agentIds: z.array(z.string()),
  sessions: z.array(LinkedSessionSchema).default([]),
  agentStatus: z.enum(["initializing", "idle", "running", "error", "closed"]).nullable(),
  pendingPermissions: z.number().int(),
  updatedAt: z.string(),
  prepSummary: z.string().nullable(),
  summarizing: z.boolean().default(false),
});
export type LinkedWorkspace = z.infer<typeof LinkedWorkspaceSchema>;

export const NEEDS_ME_TAG_META: Record<
  z.infer<typeof NeedsMeTagSchema>,
  { label: string; subtitle: string; icon: string }
> = {
  ready_to_archive: {
    label: "可完结",
    subtitle: "事项已完成闭环，默认下一步为归档",
    icon: "CheckCircle2",
  },
  decision: {
    label: "待确认",
    subtitle: "方案、草稿或变更操作已就绪，待确认后执行",
    icon: "Zap",
  },
  input: {
    label: "待补充",
    subtitle: "需补充上下文信息、环境材料或执行结果",
    icon: "MessageSquarePlus",
  },
  review: {
    label: "待查阅",
    subtitle: "阶段排查结论或进展已同步，待查阅并明确下一步",
    icon: "UserCheck",
  },
};

export const DEFAULT_GOAL_MAX_TURNS = 50;
export const MAX_GOAL_MAX_TURNS = 200;

export const GoalStopReasonSchema = z.enum(["achieved", "max_turns", "manual", "blocked"]);
export type GoalStopReason = z.infer<typeof GoalStopReasonSchema>;

export const RadarGoalSchema = z.object({
  spec: z.string(),
  rawSpec: z.string().nullable().default(null),
  autoRefined: z.boolean().default(false),
  active: z.boolean(),
  agentId: z.string().nullable().default(null),
  verifyCommand: z.string().nullable().default(null),
  turnCount: z.number().int().default(0),
  maxTurns: z.number().int().default(DEFAULT_GOAL_MAX_TURNS),
  lastEvalNote: z.string().nullable().default(null),
  stopReason: GoalStopReasonSchema.nullable().default(null),
  updatedAt: z.string(),
});
export type RadarGoal = z.infer<typeof RadarGoalSchema>;

export type ParsedGoalCommand =
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "clear" }
  | {
      kind: "set";
      spec: string;
      verifyCommand: string | null;
      maxTurns: number;
    };

export function parseGoalCommandArgs(rawArgs: string): ParsedGoalCommand {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      kind: "set",
      spec: "",
      verifyCommand: null,
      maxTurns: DEFAULT_GOAL_MAX_TURNS,
    };
  }

  const lower = trimmed.toLowerCase();
  if (lower === "help" || lower === "--help" || lower === "-h" || trimmed === "?" || trimmed === "帮助") {
    return { kind: "help" };
  }
  if (
    lower === "off" ||
    lower === "stop" ||
    lower === "pause" ||
    lower === "cancel" ||
    trimmed === "关闭" ||
    trimmed === "停止" ||
    trimmed === "暂停" ||
    trimmed === "退出"
  ) {
    return { kind: "stop" };
  }
  if (lower === "resume" || lower === "continue" || trimmed === "继续" || trimmed === "恢复") {
    return { kind: "resume" };
  }
  if (lower === "clear" || lower === "reset" || trimmed === "清除") {
    return { kind: "clear" };
  }

  let body = trimmed;
  let verifyCommand: string | null = null;
  const verifyMatch = /(?:^|\s)--verify(?:=|\s+)([\s\S]+)$/i.exec(body);
  if (verifyMatch) {
    const cmd = (verifyMatch[1] ?? "").trim();
    if (cmd) verifyCommand = cmd;
    body = body.slice(0, verifyMatch.index).trim();
  }

  let maxTurns = DEFAULT_GOAL_MAX_TURNS;
  body = body
    .replace(/(?:^|\s)--max(?:-turns)?(?:=|\s+)(\d+)(?=\s|$)/gi, (_m, numStr: string) => {
      const n = Number(numStr);
      if (Number.isInteger(n) && n >= 1) {
        maxTurns = Math.min(MAX_GOAL_MAX_TURNS, Math.max(1, n));
      }
      return " ";
    })
    .trim();

  return {
    kind: "set",
    spec: body,
    verifyCommand,
    maxTurns,
  };
}

export const RadarItemSchema = z.object({
  id: z.string(),
  source: RadarSourceSchema,
  archetype: ItemArchetypeSchema.optional(),
  group: RadarGroupSchema,
  badge: z.string(),
  title: z.string(),
  summary: z.string(),
  url: z.string().nullable(),
  secondaryUrl: z.string().nullable().default(null),
  links: z.array(RadarLinkSchema).default([]),
  updatedAt: z.string(),
  stateHash: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  selectedModel: z.string(),
  status: CardStatusSchema,
  needsMeTag: NeedsMeTagSchema.nullable().default(null),
  decisionProposal: DecisionProposalSchema.nullable().default(null),
  needsWorktree: z.boolean(),
  visibility: z.enum(["active", "snoozed", "dismissed"]),
  snoozedUntil: z.string().nullable().default(null),
  waitMode: WaitModeSchema.nullable().default(null),
  waitCondition: z.string().nullable().default(null),
  waitBoard: BoardWatchSpecSchema.nullable().default(null),
  waitScheduleId: z.string().nullable().default(null),
  waitCron: z.string().nullable().default(null),
  waitTimeoutAt: z.string().nullable().default(null),
  waitCheckNote: z.string().nullable().default(null),
  lastWaitCheckAt: z.string().nullable().default(null),
  goal: RadarGoalSchema.nullable().default(null),
  coordination: CoordinationSummarySchema.nullable().default(null),
  workspace: LinkedWorkspaceSchema.nullable().default(null),
});
export type RadarItem = z.infer<typeof RadarItemSchema>;

export const CopilotSummarySchema = z.object({
  id: z.string(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]),
  model: z.string().nullable(),
  updatedAt: z.string(),
});
export type CopilotSummary = z.infer<typeof CopilotSummarySchema>;

export const RadarModelAlertSchema = z.object({
  key: z.string(),
  role: z.string(),
  model: z.string(),
  fallbackModel: z.string().nullable().optional(),
  severity: z.enum(["warning", "error"]).default("error"),
  message: z.string(),
  cardTitle: z.string().nullable().default(null),
  cardId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  retryable: z.boolean().default(true),
  count: z.number().int().default(1),
  occurredAt: z.string(),
});
export type RadarModelAlert = z.infer<typeof RadarModelAlertSchema>;

export const RadarCollectorStatusSchema = z.object({
  displayName: z.string().nullable().optional(),
  protocol: ProviderProtocolKindSchema.default("jsonrpc").optional(),
  lifecycle: ProviderLifecycleSchema.default("oneshot").optional(),
  capabilities: ProviderCapabilitiesSchema.optional(),
  healthOk: z.boolean().nullable().optional(),
  healthNote: z.string().nullable().optional(),
  filename: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  path: z.string(),
  enabled: z.boolean(),
  disabledReason: z.enum(["prefix", "config"]).nullable().default(null),
  running: z.boolean().default(false),
  startedAt: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  durationMs: z.number().int().nullable().default(null),
  itemCount: z.number().int().nullable().default(null),
  deltaCount: z.number().int().nullable().default(null),
  warnings: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});
export const checkProviderHealthRpc = defineRpc({
  name: "radar.provider.health",
  input: z.object({ filename: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(), filename: z.string(), identity: z.string().nullable().default(null),
    message: z.string().nullable().default(null), durationMs: z.number().int(),
  }),
});
export type RadarCollectorStatus = z.infer<typeof RadarCollectorStatusSchema>;

export const AssignableModelChoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  description: z.string(),
  profileId: z.string().nullable().default(null),
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type AssignableModelChoice = z.infer<typeof AssignableModelChoiceSchema>;

export const ResolvedModelsSchema = z.object({
  copilotModel: z.string(),
  triageModel: z.string(),
  waitEvalModel: z.string(),
  summaryModel: z.string(),
  insightModel: z.string().default(""),
  copilotModels: z.array(z.string()).default([]),
  triageModels: z.array(z.string()).default([]),
  waitEvalModels: z.array(z.string()).default([]),
  summaryModels: z.array(z.string()).default([]),
  insightModels: z.array(z.string()).default([]),
  defaultWorkerModel: z.string().default(""),
  assignableModels: z.array(AssignableModelChoiceSchema).default([]),
});
export type ResolvedModels = z.infer<typeof ResolvedModelsSchema>;

export const RadarSnapshotSchema = z.object({
  items: z.array(RadarItemSchema),
  projects: z.array(ProjectOptionSchema),
  autoScanEnabled: z.boolean().default(true),
  trackLocalWorkspaces: z.boolean().default(true),
  coordinationBetaEnabled: z.boolean().default(false),
  effectiveTimezone: z.string().default("UTC"),
  resolvedModels: ResolvedModelsSchema.optional(),
  lastScanAt: z.string().nullable(),
  lastScanDeltaCount: z.number().int().nullable().default(null),
  lastScanTriageTriggered: z.boolean().default(false),
  scanning: z.boolean(),
  scanErrors: z.array(z.string()),
  collectorsDir: z.string().default(""),
  collectors: z.array(RadarCollectorStatusSchema).default([]),
  modelAlerts: z.array(RadarModelAlertSchema).default([]),
  copilot: CopilotSummarySchema.nullable(),
  counts: z.object({
    attention: z.number().int(),
    boardTotal: z.number().int(),
    needsMe: z.number().int(),
    readyToArchive: z.number().int().default(0),
    running: z.number().int(),
    waitingExternal: z.number().int(),
    pool: z.number().int(),
    archived: z.number().int(),
    hidden: z.number().int(),
  }),
});
export type RadarSnapshot = z.infer<typeof RadarSnapshotSchema>;

export const loadRadarRpc = defineRpc({
  name: "radar.load",
  input: z.object({}),
  output: RadarSnapshotSchema,
});

export const scanRadarRpc = defineRpc({
  name: "radar.scan",
  input: z.object({}),
  output: RadarSnapshotSchema,
});

export const followRadarItemRpc = defineRpc({
  name: "radar.item.follow",
  input: z.object({
    itemId: z.string().min(1),
    mode: z.enum(["background", "immediate"]),
    note: z.string().default(""),
  }),
  output: z.object({
    workspaceId: z.string(),
    agentId: z.string(),
    mode: z.enum(["background", "immediate"]),
  }),
});

export const followBatchRadarItemsRpc = defineRpc({
  name: "radar.item.follow_batch",
  input: z.object({
    itemIds: z.array(z.string().min(1)).min(1),
  }),
  output: z.object({
    startedCount: z.number().int(),
    failedCount: z.number().int(),
  }),
});

export const replyRadarCardRpc = defineRpc({
  name: "radar.item.reply",
  input: z.object({
    itemId: z.string().min(1),
    agentId: z.string().optional(),
    text: z.string().default(""),
    decisionApproval: z
      .object({
        edited: z.boolean(),
        title: z.string().nullable().optional(),
        target: z.string().nullable().optional(),
        draft: z.string().nullable().optional(),
      })
      .optional(),
  }),
  output: z.object({ agentId: z.string() }),
});

/** Sends the user's waiting note to the card's AI session; transitions to waiting_external only if the AI confirms a concrete, inspectable completion action */
export const requestWaitExternalRpc = defineRpc({
  name: "radar.item.request_wait",
  input: z.object({
    itemId: z.string().min(1),
    agentId: z.string().optional(),
    note: z.string().min(1),
  }),
  output: z.object({ agentId: z.string() }),
});

export const updateRadarCardRpc = defineRpc({
  name: "radar.item.update",
  input: z.object({
    itemId: z.string().min(1),
    targetAgentId: z.string().optional(),
    selectedModel: z.string().optional(),
    projectId: z.string().optional(),
    status: CardStatusSchema.optional(),
    needsMeTag: NeedsMeTagSchema.nullable().optional(),
  }),
  output: z.object({}),
});

export const setRadarGoalRpc = defineRpc({
  name: "radar.item.goal",
  input: z.object({
    itemId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    action: z.enum(["set", "stop", "resume", "clear"]),
    spec: z.string().optional(),
    verifyCommand: z.string().nullable().optional(),
    maxTurns: z.number().int().min(1).max(MAX_GOAL_MAX_TURNS).optional(),
    steerNow: z.boolean().default(true),
  }),
  output: z.object({
    cardId: z.string(),
    agentId: z.string().nullable(),
    goal: RadarGoalSchema.nullable(),
    snapshot: RadarSnapshotSchema,
  }),
});

export const manageRadarCardLinksRpc = defineRpc({
  name: "radar.item.links",
  input: z.object({
    itemId: z.string().min(1),
    add: z.array(RadarLinkInputSchema).optional(),
    removeUrls: z.array(z.string().min(1)).optional(),
  }),
  output: z.object({
    links: z.array(RadarLinkSchema),
  }),
});

export const archiveRadarCardRpc = defineRpc({
  name: "radar.item.archive",
  input: z.object({ itemId: z.string().min(1) }),
  output: z.object({}),
});

export const archiveBatchRadarCardsRpc = defineRpc({
  name: "radar.item.archive_batch",
  input: z.object({ itemIds: z.array(z.string().min(1)).min(1) }),
  output: z.object({ archivedCount: z.number().int() }),
});

export const snoozeRadarItemRpc = defineRpc({
  name: "radar.item.snooze",
  input: z.object({
    itemId: z.string().min(1),
    preset: SnoozePresetSchema,
  }),
  output: z.object({ snoozedUntil: z.string() }),
});

export const dismissRadarItemRpc = defineRpc({
  name: "radar.item.dismiss",
  input: z.object({ itemId: z.string().min(1) }),
  output: z.object({}),
});

export const restoreRadarItemRpc = defineRpc({
  name: "radar.item.restore",
  input: z.object({ itemId: z.string().min(1) }),
  output: z.object({}),
});

export const askCopilotRpc = defineRpc({
  name: "radar.copilot.ask",
  input: z.object({ text: z.string().min(1) }),
  output: z.object({ agentId: z.string() }),
});

export const resetCopilotRpc = defineRpc({
  name: "radar.copilot.reset",
  input: z.object({ onlyIfIdle: z.boolean().default(false) }),
  output: z.object({ archived: z.boolean() }),
});

export const dismissModelAlertsRpc = defineRpc({
  name: "radar.alerts.dismiss",
  input: z.object({ key: z.string().optional() }),
  output: z.object({}),
});

export const retryModelAlertRpc = defineRpc({
  name: "radar.alerts.retry",
  input: z.object({ key: z.string().min(1) }),
  output: z.object({
    retried: z.boolean(),
    message: z.string().optional(),
  }),
});

export const dismissScanErrorsRpc = defineRpc({
  name: "radar.scan_errors.dismiss",
  input: z.object({
    error: z.string().optional(),
    filename: z.string().optional(),
  }),
  output: z.object({}),
});

export const retryScanErrorRpc = defineRpc({
  name: "radar.scan_errors.retry",
  input: z.object({
    error: z.string().optional(),
    filename: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string().optional(),
  }),
});

export const stopCopilotRpc = defineRpc({
  name: "radar.copilot.stop",
  input: z.object({}),
  output: z.object({}),
});

export const toggleRadarCollectorRpc = defineRpc({
  name: "radar.collector.toggle",
  input: z.object({
    filename: z.string().min(1),
    enabled: z.boolean(),
  }),
  output: z.object({
    filename: z.string(),
    enabled: z.boolean(),
  }),
});

export const testRadarCollectorRpc = defineRpc({
  name: "radar.collector.test",
  input: z.object({
    filename: z.string().min(1),
  }),
  output: z.object({
    ok: z.boolean(),
    filename: z.string(),
    durationMs: z.number().int(),
    itemCount: z.number().int(),
    warnings: z.array(z.string()),
    error: z.string().nullable().default(null),
  }),
});

export const loadCollectorConfigRpc = defineRpc({
  name: "radar.collector.config.load",
  input: z.object({}),
  output: z.object({
    configPath: z.string(),
    configJson: z.string(),
    rulesPath: z.string(),
    mutedKeywords: z.array(z.string()),
    mutedChannels: z.array(z.string()),
  }),
});

export const saveCollectorConfigRpc = defineRpc({
  name: "radar.collector.config.save",
  input: z.object({
    configJson: z.string(),
    mutedKeywords: z.array(z.string()).optional(),
    mutedChannels: z.array(z.string()).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});

export const toggleRadarCoordRpc = defineRpc({
  name: "radar.coord.toggle",
  input: z.object({
    itemId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    enabled: z.boolean(),
    steerNow: z.boolean().default(true),
  }),
  output: z.object({
    cardId: z.string(),
    enabled: z.boolean(),
    summary: CoordinationSummarySchema,
    snapshot: RadarSnapshotSchema,
  }),
});

export * from "./coordination";
export * from "./insights";
export * from "./interactions";
