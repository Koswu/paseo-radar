import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import {
  CardStatusSchema,
  DecisionProposalSchema,
  NeedsMeTagSchema,
  RadarLinkSchema,
  WaitModeSchema,
} from "./radar-primitives";

export const DEFAULT_MAX_P2P_ROUNDS = 4;

export const BoardWatchTargetSchema = z.object({
  cardId: z.string().min(1),
  status: CardStatusSchema.default("archived"),
  needsMeTag: NeedsMeTagSchema.nullable().optional(),
});
export type BoardWatchTarget = z.infer<typeof BoardWatchTargetSchema>;

export const BoardWatchSpecSchema = z.object({
  scope: z.enum(["inner", "outer"]),
  parentCardId: z.string().nullable().default(null),
  targets: z.array(BoardWatchTargetSchema).min(1),
  match: z.enum(["all", "any"]).default("all"),
  wakeOnException: z.boolean().default(true),
});
export type BoardWatchSpec = z.infer<typeof BoardWatchSpecSchema>;

export const ArtifactEntrySchema = z.object({
  relativePath: z.string(),
  absolutePath: z.string(),
  sizeBytes: z.number().int(),
  note: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const SubCardInboxMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  kind: z.enum(["question", "notify", "coordinator_reply"]),
  message: z.string(),
  at: z.string(),
});
export type SubCardInboxMessage = z.infer<typeof SubCardInboxMessageSchema>;

export const SubCardSchema = z.object({
  id: z.string().min(1),
  wave: z.number().int().default(1),
  title: z.string(),
  objective: z.string(),
  isolation: z.enum(["readonly", "worktree"]).default("readonly"),
  selectedModel: z.string().nullable().default(null),
  refCards: z.array(z.string()).default([]),
  requireReview: z.boolean().default(false),
  verifyCommand: z.string().nullable().default(null),

  status: CardStatusSchema,
  needsMeTag: NeedsMeTagSchema.nullable().default(null),
  decisionProposal: DecisionProposalSchema.nullable().default(null),
  waitMode: WaitModeSchema.nullable().default(null),
  waitCondition: z.string().nullable().default(null),
  waitBoard: BoardWatchSpecSchema.nullable().default(null),
  waitCron: z.string().nullable().default(null),
  waitScriptPath: z.string().nullable().default(null),
  waitScheduleId: z.string().nullable().default(null),
  waitStartedAt: z.string().nullable().default(null),
  waitTimeoutAt: z.string().nullable().default(null),
  waitMaxTimeoutLabel: z.string().nullable().default(null),
  waitCheckNote: z.string().nullable().default(null),
  lastWaitCheckAt: z.string().nullable().default(null),
  waitConsecutiveErrors: z.number().int().nullable().default(null),
  waitNextRetryAt: z.string().nullable().default(null),

  boundWorkspaceId: z.string().nullable().default(null),
  boundAgentId: z.string().nullable().default(null),
  gitBranch: z.string().nullable().default(null),
  commitSha: z.string().nullable().default(null),
  links: z.array(RadarLinkSchema).default([]),
  closureEvidence: z.string().nullable().default(null),
  artifacts: z.array(ArtifactEntrySchema).default([]),
  inbox: z.array(SubCardInboxMessageSchema).default([]),
  p2pRoundsByPeer: z.record(z.string(), z.number().int()).default({}),
  canceled: z.boolean().default(false),

  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type SubCard = z.infer<typeof SubCardSchema>;

export const CoordBoardSchema = z.object({
  cardId: z.string(),
  enabled: z.boolean(),
  enabledAt: z.string().nullable().default(null),
  coordinatorAgentId: z.string().nullable().default(null),
  boardDir: z.string(),
  subcards: z.array(SubCardSchema).default([]),
  updatedAt: z.string(),
});
export type CoordBoard = z.infer<typeof CoordBoardSchema>;

export const ActiveSubcardSessionSchema = z.object({
  subcardId: z.string(),
  title: z.string(),
  status: CardStatusSchema,
  workspaceId: z.string(),
  agentId: z.string(),
});
export type ActiveSubcardSession = z.infer<typeof ActiveSubcardSessionSchema>;

export const CoordinationSummarySchema = z.object({
  enabled: z.boolean(),
  total: z.number().int(),
  archived: z.number().int(),
  running: z.number().int(),
  waitingBoard: z.number().int(),
  waitingExternal: z.number().int(),
  needsCoordinator: z.number().int(),
  pool: z.number().int(),
  canceled: z.number().int(),
  frontlineText: z.string().nullable().default(null),
  eventCount: z.number().int().default(0),
  activeSubcardSessions: z.array(ActiveSubcardSessionSchema).default([]),
});
export type CoordinationSummary = z.infer<typeof CoordinationSummarySchema>;

export const CoordEventKindSchema = z.enum([
  "coord.enabled",
  "subcard.created",
  "subcard.started",
  "subcard.canceled",
  "wait.registered",
  "wait.checked",
  "wait.triggered",
  "wait.timeout",
  "gate.rejected",
  "subcard.archived",
  "peer.message",
  "escalated.coordinator",
  "escalated.human",
]);
export type CoordEventKind = z.infer<typeof CoordEventKindSchema>;

export const CoordEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: CoordEventKindSchema,
  actor: z.string(),
  subcardId: z.string().nullable().default(null),
  causedBy: z.string().nullable().default(null),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type CoordEvent = z.infer<typeof CoordEventSchema>;

export const CoordWaveColumnSchema = z.object({
  wave: z.number().int(),
  subcardIds: z.array(z.string()),
});
export type CoordWaveColumn = z.infer<typeof CoordWaveColumnSchema>;

export const CoordBoardDetailSchema = z.object({
  cardId: z.string(),
  cardTitle: z.string(),
  board: CoordBoardSchema,
  summary: CoordinationSummarySchema,
  waves: z.array(CoordWaveColumnSchema),
  events: z.array(CoordEventSchema),
  sharedFiles: z.array(ArtifactEntrySchema),
});
export type CoordBoardDetail = z.infer<typeof CoordBoardDetailSchema>;

export const loadRadarCoordDetailRpc = defineRpc({
  name: "radar.coord.detail",
  input: z.object({
    cardId: z.string().min(1),
    eventLimit: z.number().int().min(1).max(500).default(150),
  }),
  output: CoordBoardDetailSchema,
});

export const readRadarCoordArtifactRpc = defineRpc({
  name: "radar.coord.artifact",
  input: z.object({
    cardId: z.string().min(1),
    relativePath: z.string().min(1),
  }),
  output: z.object({
    relativePath: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    sizeBytes: z.number().int(),
  }),
});

export const coordSubcardActionRpc = defineRpc({
  name: "radar.coord.subcard_action",
  input: z.object({
    cardId: z.string().min(1),
    subcardId: z.string().min(1),
    action: z.enum(["start", "reply", "archive", "cancel"]),
    text: z.string().optional(),
  }),
  output: z.object({
    detail: CoordBoardDetailSchema,
  }),
});

export const lookupRadarSubcardSessionRpc = defineRpc({
  name: "radar.coord.session_lookup",
  input: z.object({
    agentId: z.string().min(1),
  }),
  output: z.object({
    found: z.boolean(),
    parentCardId: z.string().nullable().default(null),
    parentCardTitle: z.string().nullable().default(null),
    coordinatorAgentId: z.string().nullable().default(null),
    subcardId: z.string().nullable().default(null),
    subcardTitle: z.string().nullable().default(null),
    status: CardStatusSchema.nullable().default(null),
    upstreamIds: z.array(z.string()).default([]),
    downstreamIds: z.array(z.string()).default([]),
    upstreamArtifacts: z
      .array(
        z.object({
          subcardId: z.string(),
          relativePath: z.string(),
          sizeBytes: z.number().int(),
          note: z.string().nullable().default(null),
        }),
      )
      .default([]),
    siblings: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: CardStatusSchema,
          agentId: z.string().nullable().default(null),
        }),
      )
      .default([]),
  }),
});
