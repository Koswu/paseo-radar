import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const AssignableModelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  model: z.string().default(""),
  description: z.string().default(""),
  profileId: z.string().nullable().optional(),
});
export type AssignableModelEntry = z.infer<typeof AssignableModelEntrySchema>;

export function normalizeModelList(raw: unknown): string[] {
  const items =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export const DEFAULT_MODELS: {
  copilotModel: string[];
  triageModel: string[];
  waitEvalModel: string[];
  summaryModel: string[];
  insightModel: string[];
} = {
  copilotModel: [],
  triageModel: [],
  waitEvalModel: [],
  summaryModel: [],
  insightModel: [],
};

export const radarModelSettings = defineSettings({
  id: "models",
  scope: "host",
  version: 5,
  schema: z.object({
    autoScanEnabled: z.boolean().default(true),
    trackLocalWorkspaces: z.boolean().default(true),
    coordinationBetaEnabled: z.boolean().default(false),
    timezone: z.string().default(""),
    assignableModels: z.array(AssignableModelEntrySchema).default([]),
    copilotModel: z.array(z.string()).default([]),
    triageModel: z.array(z.string()).default([]),
    waitEvalModel: z.array(z.string()).default([]),
    summaryModel: z.array(z.string()).default([]),
    insightModel: z.array(z.string()).default([]),
  }),
  migrate(raw, fromVersion) {
    if (!raw || typeof raw !== "object") return raw;
    const obj = { ...(raw as Record<string, unknown>) };
    if (fromVersion < 2) {
      const existing = Array.isArray(obj.assignableModels) ? obj.assignableModels : [];
      if (existing.length === 0) {
        const legacyEntries: Array<{
          id: string;
          name: string;
          model: string;
          description: string;
        }> = [
          {
            id: "legacy-backend",
            name: "后端编码与排查",
            model: typeof obj.backendModel === "string" ? obj.backendModel.trim() : "",
            description: "后端开发、PR/MR 审阅、线上根因排查与常规技术答疑",
          },
          {
            id: "legacy-design",
            name: "前端 / RFC / 架构拆解",
            model: typeof obj.designModel === "string" ? obj.designModel.trim() : "",
            description: "前端 UI/React、技术方案与 RFC 撰写或审阅、复杂架构拆解与先行调研",
          },
          {
            id: "legacy-schedule",
            name: "轻量收尾与核对",
            model: typeof obj.scheduleModel === "string" ? obj.scheduleModel.trim() : "",
            description: "100% 进度项目结项核查、简单状态同步等轻量待办",
          },
        ];

        const merged: AssignableModelEntry[] = [];
        for (const item of legacyEntries) {
          if (!item.model) continue;
          const dup = merged.find((m) => m.model === item.model);
          if (dup) {
            dup.name = `${dup.name} / ${item.name}`;
            dup.description = `${dup.description}；${item.description}`;
          } else {
            merged.push({ ...item, profileId: null });
          }
        }
        obj.assignableModels = merged;
      }
      delete obj.backendModel;
      delete obj.designModel;
      delete obj.scheduleModel;
    }
    if (fromVersion < 3) {
      for (const key of ["copilotModel", "triageModel", "waitEvalModel", "summaryModel"] as const) {
        obj[key] = normalizeModelList(obj[key]);
      }
    }
    if (fromVersion < 4) {
      obj.insightModel = normalizeModelList(obj.insightModel);
    }
    if (fromVersion < 5) {
      obj.coordinationBetaEnabled =
        typeof obj.coordinationBetaEnabled === "boolean" ? obj.coordinationBetaEnabled : false;
    }
    return obj;
  },
});

export type RadarModelSettings = z.infer<typeof radarModelSettings.schema>;

export type RadarModelRoleKey = keyof typeof DEFAULT_MODELS;

export const DEFAULT_RADAR_SETTINGS: RadarModelSettings = {
  autoScanEnabled: true,
  trackLocalWorkspaces: true,
  coordinationBetaEnabled: false,
  timezone: "",
  assignableModels: [],
  ...DEFAULT_MODELS,
};
