import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const InsightWindowSchema = z.enum(["7d", "14d", "30d", "all"]);
export type InsightWindow = z.infer<typeof InsightWindowSchema>;

export interface ParsedInsightsCommand {
  window: InsightWindow;
  focus: string;
}

export function parseInsightsCommandArgs(rawArgs: string): ParsedInsightsCommand {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { window: "30d", focus: "" };
  }
  const tokens = trimmed.split(/\s+/);
  const first = (tokens[0] ?? "").toLowerCase();
  let window: InsightWindow | null = null;
  if (first === "7d" || first === "7" || first === "week" || first === "7天" || first === "近7天") {
    window = "7d";
  } else if (first === "14d" || first === "14" || first === "14天" || first === "近14天") {
    window = "14d";
  } else if (first === "30d" || first === "30" || first === "month" || first === "30天" || first === "近30天") {
    window = "30d";
  } else if (first === "all" || first === "全部" || first === "全量") {
    window = "all";
  }

  if (window) {
    return {
      window,
      focus: tokens.slice(1).join(" ").trim(),
    };
  }
  return {
    window: "30d",
    focus: trimmed,
  };
}

export const InsightDailyPointSchema = z.object({
  date: z.string(),
  sessions: z.number().int(),
  userMessages: z.number().int(),
  toolCalls: z.number().int(),
});
export type InsightDailyPoint = z.infer<typeof InsightDailyPointSchema>;

export const InsightModelStatSchema = z.object({
  model: z.string(),
  provider: z.string(),
  sessions: z.number().int(),
  userMessages: z.number().int(),
  toolCalls: z.number().int(),
  failedToolCalls: z.number().int(),
  readyToArchiveCount: z.number().int(),
  errorTurns: z.number().int(),
});
export type InsightModelStat = z.infer<typeof InsightModelStatSchema>;

export const InsightProjectStatSchema = z.object({
  name: z.string(),
  sessions: z.number().int(),
  userMessages: z.number().int(),
  toolCalls: z.number().int(),
  archivedCards: z.number().int(),
});
export type InsightProjectStat = z.infer<typeof InsightProjectStatSchema>;

export const InsightToolStatSchema = z.object({
  name: z.string(),
  calls: z.number().int(),
  failures: z.number().int(),
});
export type InsightToolStat = z.infer<typeof InsightToolStatSchema>;

export const InsightRadarExecutionSchema = z.object({
  cardsActiveOrClosedInWindow: z.number().int(),
  cardsArchived: z.number().int(),
  cardsReadyToArchive: z.number().int(),
  cardsDecision: z.number().int(),
  cardsInput: z.number().int(),
  cardsReview: z.number().int(),
  cardsWaitingExternal: z.number().int(),
  scriptWaits: z.number().int(),
  aiWaits: z.number().int(),
  goalsTotal: z.number().int(),
  goalsAchieved: z.number().int(),
  goalsBlocked: z.number().int(),
  goalsAutoRefined: z.number().int(),
  avgGoalTurns: z.number(),
  telemetry: z.object({
    turnsCompleted: z.number().int(),
    turnsFailed: z.number().int(),
    turnsCanceled: z.number().int(),
    permissionsAllowed: z.number().int(),
    permissionsDenied: z.number().int(),
    gateRejections: z.number().int(),
    decisionsApproved: z.number().int(),
    decisionsEdited: z.number().int(),
    waitsCompleted: z.number().int(),
    waitsTimedOut: z.number().int(),
  }),
});
export type InsightRadarExecution = z.infer<typeof InsightRadarExecutionSchema>;

export const RadarInsightMetricsSchema = z.object({
  totalSessions: z.number().int(),
  analyzedSessions: z.number().int(),
  activeSessions: z.number().int(),
  archivedSessions: z.number().int(),
  radarLinkedSessions: z.number().int(),
  standaloneSessions: z.number().int(),
  activeDays: z.number().int(),
  totalUserMessages: z.number().int(),
  avgUserMessagesPerSession: z.number(),
  avgFirstPromptChars: z.number().int(),
  shortPromptRatio: z.number(),
  multiTurnSteerSessions: z.number().int(),
  totalAssistantTurns: z.number().int(),
  totalToolCalls: z.number().int(),
  failedToolCalls: z.number().int(),
  toolSuccessRate: z.number(),
  sessionsWithToolErrors: z.number().int(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCachedTokens: z.number().int(),
  estimatedCostUsd: z.number(),
  dailyActivity: z.array(InsightDailyPointSchema),
  models: z.array(InsightModelStatSchema),
  projects: z.array(InsightProjectStatSchema),
  topTools: z.array(InsightToolStatSchema),
  radarExecution: InsightRadarExecutionSchema,
});
export type RadarInsightMetrics = z.infer<typeof RadarInsightMetricsSchema>;

export const RadarInsightDeltasSchema = z.object({
  prevReportId: z.string(),
  prevCreatedAt: z.string(),
  sessionsDelta: z.number().int(),
  userMessagesDelta: z.number().int(),
  toolSuccessRateDelta: z.number(),
  avgMessagesPerSessionDelta: z.number(),
  cardsArchivedDelta: z.number().int(),
});
export type RadarInsightDeltas = z.infer<typeof RadarInsightDeltasSchema>;

export const InsightWinItemSchema = z.object({
  title: z.string(),
  detail: z.string(),
  evidence: z.string().nullable().default(null),
});
export type InsightWinItem = z.infer<typeof InsightWinItemSchema>;

export const InsightFrictionItemSchema = z.object({
  title: z.string(),
  severity: z.enum(["high", "medium", "low"]).default("medium"),
  detail: z.string(),
  evidence: z.string().nullable().default(null),
});
export type InsightFrictionItem = z.infer<typeof InsightFrictionItemSchema>;

export const InsightRecommendationCategorySchema = z.enum([
  "agents_md",
  "workflow",
  "radar_config",
]);
export type InsightRecommendationCategory = z.infer<typeof InsightRecommendationCategorySchema>;

export const InsightRecommendationItemSchema = z.object({
  category: InsightRecommendationCategorySchema.default("workflow"),
  title: z.string(),
  rationale: z.string(),
  snippet: z.string().nullable().default(null),
});
export type InsightRecommendationItem = z.infer<typeof InsightRecommendationItemSchema>;

export const RadarInsightNarrativeSchema = z.object({
  headline: z.string(),
  executiveSummary: z.string(),
  interactionStyle: z.object({
    archetype: z.string(),
    traits: z.array(z.string()).default([]),
    analysis: z.string(),
  }),
  wins: z.array(InsightWinItemSchema).default([]),
  frictions: z.array(InsightFrictionItemSchema).default([]),
  recommendations: z.array(InsightRecommendationItemSchema).default([]),
});
export type RadarInsightNarrative = z.infer<typeof RadarInsightNarrativeSchema>;

export const RadarInsightReportSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  window: InsightWindowSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  customFocus: z.string().nullable().default(null),
  locale: z.string().default("zh-CN"),
  modelUsed: z.string().nullable().default(null),
  aiGenerated: z.boolean().default(true),
  htmlPath: z.string().nullable().default(null),
  metrics: RadarInsightMetricsSchema,
  deltas: RadarInsightDeltasSchema.nullable().default(null),
  narrative: RadarInsightNarrativeSchema,
  markdown: z.string(),
});
export type RadarInsightReport = z.infer<typeof RadarInsightReportSchema>;

export const RadarInsightReportSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  window: InsightWindowSchema,
  headline: z.string(),
  totalSessions: z.number().int(),
  totalUserMessages: z.number().int(),
  toolSuccessRate: z.number(),
  modelUsed: z.string().nullable().default(null),
});
export type RadarInsightReportSummary = z.infer<typeof RadarInsightReportSummarySchema>;

export const RadarInsightStatusSchema = z.object({
  generating: z.boolean(),
  stage: z.string().nullable().default(null),
  progressText: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  window: InsightWindowSchema.nullable().default(null),
  lastError: z.string().nullable().default(null),
});
export type RadarInsightStatus = z.infer<typeof RadarInsightStatusSchema>;

export const loadRadarInsightsRpc = defineRpc({
  name: "radar.insights.load",
  input: z.object({
    reportId: z.string().optional(),
  }),
  output: z.object({
    status: RadarInsightStatusSchema,
    reports: z.array(RadarInsightReportSummarySchema),
    activeReport: RadarInsightReportSchema.nullable(),
  }),
});

export const generateRadarInsightsRpc = defineRpc({
  name: "radar.insights.generate",
  input: z.object({
    window: InsightWindowSchema.default("30d"),
    customFocus: z.string().optional(),
    locale: z.string().optional(),
    forceRefreshCache: z.boolean().default(false),
  }),
  output: z.object({
    report: RadarInsightReportSchema,
    reports: z.array(RadarInsightReportSummarySchema),
  }),
});

export const exportRadarInsightHtmlRpc = defineRpc({
  name: "radar.insights.export_html",
  input: z.object({
    reportId: z.string().min(1),
  }),
  output: z.object({
    htmlPath: z.string(),
    latestHtmlPath: z.string(),
    htmlContent: z.string(),
  }),
});

export const deleteRadarInsightReportRpc = defineRpc({
  name: "radar.insights.delete",
  input: z.object({
    reportId: z.string().min(1),
  }),
  output: z.object({
    ok: z.boolean(),
    reports: z.array(RadarInsightReportSummarySchema),
    activeReport: RadarInsightReportSchema.nullable(),
  }),
});
