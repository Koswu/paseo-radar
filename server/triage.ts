import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

import {
  RadarRoleHintSchema,
  type AssignableModelChoice,
  type ProjectOption,
  type RadarLink,
} from "../shared/radar";
import { applyDeterministicAndCachedMerges, isLiveCardMeta } from "./card-dedup";
import { mergeSecondaryIntoPrimary } from "./collectors";
import {
  extractCanonicalEntityKeys,
  normalizeCardId,
  resolveItemLinks,
  setsIntersect,
} from "./entity-keys";
import { ModelChainError, runOneShotPromptWithFallback } from "./llm-oneshot";
import type {
  ItemUserMeta,
  RawScannedItem,
  TriageCacheEntry,
} from "./store";

type PaseoApi = PluginHandlerContext["paseo"];

const TRIAGE_TIMEOUT_MS = 90_000;
const MAX_CACHE_ENTRIES = 300;

const TriageDecisionSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["keep", "drop_noise", "merge"]).default("keep"),
  mergeIntoId: z.string().nullable().optional(),
  group: z.enum(["urgent", "closing", "todo"]).nullable().optional(),
  roleHint: RadarRoleHintSchema.nullable().optional(),
  selectedModel: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

const TriageBatchResponseSchema = z.object({
  decisions: z.array(TriageDecisionSchema).default([]),
});

export interface ActiveBoardDigestItem {
  id: string;
  source: string;
  badge: string;
  title: string;
  summary: string;
  url: string | null;
  hasLiveSession?: boolean;
  prepSummary?: string | null;
}

export interface DismissedExample {
  source?: string | null;
  group?: string | null;
  title?: string | null;
}

function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("分拣模型未返回有效 JSON 对象");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function callTriageModel(params: {
  ruleNotes?: readonly string[];
  triageModels: readonly string[];
  paseo?: PaseoApi | null;
  deltaItems: readonly RawScannedItem[];
  existingContext: readonly ActiveBoardDigestItem[];
  recentDismissed?: readonly DismissedExample[];
  meta: Record<string, ItemUserMeta>;
  projects: readonly ProjectOption[];
  assignableModels: readonly AssignableModelChoice[];
  onFallback?: (info: { failedModel: string; nextModel: string; error: unknown }) => void;
}): Promise<{ decisions: z.infer<typeof TriageDecisionSchema>[]; modelUsed: string; isPrimary: boolean }> {
  const payload = {
    projects: params.projects.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      path: p.path,
      kind: p.kind,
    })),
    assignableModels: params.assignableModels.map((m) => ({
      name: m.name,
      model: m.model,
      description: m.description,
    })),
    recentDismissed: (params.recentDismissed ?? []).slice(0, 12).map((d) => ({
      source: d.source ?? null,
      group: d.group ?? null,
      title: d.title ?? null,
    })),
    existingItems: params.existingContext.slice(0, 60).map((c) => ({
      id: c.id,
      source: c.source,
      badge: c.badge,
      title: c.title,
      summary: c.summary.slice(0, 120),
      url: c.url,
      hasLiveSession: Boolean(c.hasLiveSession),
      prepSummary: c.prepSummary ? c.prepSummary.slice(0, 160) : null,
    })),
    newOrUpdatedItems: params.deltaItems.map((it) => {
      const m = params.meta[it.id];
      return {
        id: it.id,
        archetype: it.archetype,
        intent: it.intent,
        source: it.source,
        group: it.group,
        badge: it.badge,
        title: it.title,
        summary: it.summary.slice(0, 180),
        url: it.url,
        repoPath: it.repoPath ?? null,
        roleHint: it.roleHint ?? null,
        hasLiveSession: isLiveCardMeta(m),
        prepSummary: m?.prepSummary ? m.prepSummary.slice(0, 160) : null,
      };
    }),
  };

  const hasAssignableModels = params.assignableModels.length > 0;
  const prompt = [
    "你是 Paseo Radar 的待办采集增量分拣器（Triage & Dedup）。",
    "请对 `newOrUpdatedItems` 中的每一项做一次性噪音过滤、跨信源语义去重与模型/项目分发，只输出严格合法的 JSON 对象（不要代码块之外的解释文字）：",
    '{"decisions":[{"id":"...","action":"keep|drop_noise|merge","mergeIntoId":null,"group":"urgent|closing|todo","selectedModel":null,"projectId":null,"reason":"..."}]}',
    "",
    "判定准则（保守优先，宁留勿误删）：",
    "1. `drop_noise`：以下情况应标记 `drop_noise`：",
    "   - 明显无需用户采取任何行动的消息：纯礼貌结语（「好的/收到/好的收到/谢谢/辛苦了/OK/+1/LGTM」）、无诉求的表情回复；",
    "   - 私聊摘要若标注 `[最新] ... | [前文] ...`，且 `[最新]` 本身就是收尾确认语（如「好的收到」「好」「谢谢」「LGTM」），说明该轮对话已闭环，即使 `[前文]` 曾有提问也应标 `drop_noise`；",
    "   - message 类纯知会可降噪；有具体问题、截止时间、指派或告警时保留。",
    "   - 可参考 `recentDismissed`（用户近期主动忽略的卡片）作为偏好信号：若新增项与用户近期忽略的纯知会或低价值提及高度同质，可倾向 `drop_noise` 或降级为 `todo`。",
    "2. `merge`：当某条新增项与 `existingItems` 或本次 `newOrUpdatedItems` 中的另一条主卡明确指向**同一个具体事项/故障/单据/MR**时，将从属项标为 `action: \"merge\"` 并填写目标主卡 ID 到 `mergeIntoId`（将链接并入主卡并抑制新建重复卡）。优先级准则：",
    "   - **已有活跃会话优先（最高优先级）**：若某张已有卡（或同批另一张卡）标记了 `hasLiveSession: true`（可结合其 `prepSummary` 判断，例如会话进展中已提到创建或跟进该 MR/PR/Issue），说明用户已在工作区处理该事项；此时即使新增项是代码 MR/PR 或 Issue，也**必须**将新增项标为 `action: \"merge\"` 并以该活跃会话卡为 `mergeIntoId`（禁止因为新卡是 MR 就同时保留两张）。",
    "   - 当双方均无活跃会话（`hasLiveSession: false`）时，按「code_change > incident > work_item > document > message」保留主卡（将从属项 merge 进主卡）。不确定是否为同一事项时保持 `keep`。",
    hasAssignableModels
      ? "3. `selectedModel`：从 `assignableModels` 列表中，根据各模型的 `name` 与 `description` 选出最适合处理该任务的 `model` 字符串（必须精确匹配列表中某一项的 `model` 值）；若无明显偏好可填 `null`。"
      : "3. `selectedModel`：当前未配置可分配模型列表，请填 `null`。",
    "4. `projectId`：根据 `repoPath`、URL 仓库名或标题关键词从 `projects` 列表中选出最匹配的 `projectId`；无把握则填 `null`。",
    "5. `group`：沿用原 `group`，或仅在明显失准时修正（`urgent` 阻塞他人/高优提及/紧急告警；`closing` 待合入/待收尾关单；`todo` 常规开发待办）。",
    "",
    ...(params.ruleNotes?.length ? ["用户自定义分拣偏好：", ...params.ruleNotes] : []),
    "输入数据：",
    JSON.stringify(payload),
  ].join("\n");

  const res = await runOneShotPromptWithFallback({
    modelSpecs: params.triageModels,
    prompt,
    paseo: params.paseo,
    timeoutMs: TRIAGE_TIMEOUT_MS,
    onFallback: params.onFallback,
  });

  try {
    const parsed = TriageBatchResponseSchema.parse(extractJsonObject(res.text));
    return { decisions: parsed.decisions, modelUsed: res.modelUsed, isPrimary: res.isPrimary };
  } catch (err) {
    throw new ModelChainError(res.modelUsed, err);
  }
}

export async function runIncrementalTriage(params: {
  scannedItems: RawScannedItem[];
  prevRawItems: readonly RawScannedItem[];
  prevCache: Record<string, TriageCacheEntry>;
  bootstrapped: boolean;
  meta: Record<string, ItemUserMeta>;
  externalBoardCards: readonly ActiveBoardDigestItem[];
  recentDismissed?: readonly DismissedExample[];
  projects: readonly ProjectOption[];
  assignableModels: readonly AssignableModelChoice[];
  ruleNotes?: readonly string[];
  triageModels: readonly string[];
  paseo?: PaseoApi | null;
  onModelSuccess?: (info: { model: string; isPrimary: boolean }) => void;
  onModelFallback?: (info: { failedModel: string; nextModel: string; error: unknown }) => void;
  onModelError?: (info: { model: string; error: unknown }) => void;
}): Promise<{
  items: RawScannedItem[];
  nextCache: Record<string, TriageCacheEntry>;
  bootstrapped: boolean;
  extraLinkMerges: Record<string, RadarLink[]>;
  absorbedDonorsByTarget: Record<string, string[]>;
  deltaCount: number;
  modelTriggered: boolean;
}> {
  const nowIso = new Date().toISOString();
  const nextCache: Record<string, TriageCacheEntry> = { ...params.prevCache };

  // Smooth upgrade: pre-seed already-known unchanged rawItems once so upgrading doesn't re-triage old board items
  let bootstrapped = params.bootstrapped;
  if (!bootstrapped) {
    for (const prev of params.prevRawItems) {
      if (!nextCache[prev.id]) {
        nextCache[prev.id] = {
          stateHash: prev.stateHash,
          action: "keep",
          roleHint: prev.roleHint ?? null,
          projectId: prev.triageProjectId ?? null,
          triagedAt: nowIso,
        };
      }
    }
    bootstrapped = true;
  }

  const deltaItems = params.scannedItems.filter(
    (it) => nextCache[it.id]?.stateHash !== it.stateHash,
  );
  const deltaIds = new Set(deltaItems.map((i) => i.id));
  let modelTriggered = false;

  const cleanModels = params.triageModels.map((m) => m.trim()).filter(Boolean);
  if (deltaItems.length > 0 && cleanModels.length > 0) {
    modelTriggered = true;
    const unchangedContext: ActiveBoardDigestItem[] = [
      ...params.scannedItems
        .filter((it) => !deltaIds.has(it.id) && nextCache[it.id]?.action !== "drop_noise")
        .map((it) => {
          const m = params.meta[it.id];
          return {
            id: it.id,
            source: it.source,
            badge: it.badge,
            title: it.title,
            summary: it.summary,
            url: it.url || null,
            hasLiveSession: isLiveCardMeta(m),
            prepSummary: m?.prepSummary ?? null,
          };
        }),
      ...params.externalBoardCards,
    ];

    try {
      const { decisions, modelUsed, isPrimary } = await callTriageModel({
        ruleNotes: params.ruleNotes,
        triageModels: cleanModels,
        paseo: params.paseo,
        deltaItems,
        existingContext: unchangedContext,
        recentDismissed: params.recentDismissed,
        meta: params.meta,
        projects: params.projects,
        assignableModels: params.assignableModels,
        onFallback: params.onModelFallback,
      });
      const byId = new Map(decisions.map((d) => [d.id, d]));
      const validProjectIds = new Set(params.projects.map((p) => p.projectId));
      const validAssignableModels = new Set(params.assignableModels.map((m) => m.model));

      for (const item of deltaItems) {
        const d = byId.get(item.id);
        const chosenModel =
          d?.selectedModel && validAssignableModels.has(d.selectedModel) ? d.selectedModel : null;
        nextCache[item.id] = {
          stateHash: item.stateHash,
          action: d?.action ?? "keep",
          mergeIntoId: d?.action === "merge" && d.mergeIntoId && d.mergeIntoId !== item.id ? d.mergeIntoId : null,
          group: d?.group ?? null,
          roleHint: d?.roleHint ?? item.roleHint ?? null,
          selectedModel: chosenModel,
          projectId: d?.projectId && validProjectIds.has(d.projectId) ? d.projectId : null,
          reason: d?.reason ?? null,
          triagedAt: nowIso,
        };
      }
      params.onModelSuccess?.({ model: modelUsed, isPrimary });
    } catch (err) {
      const failedModel = err instanceof ModelChainError ? err.failedModel : (cleanModels[cleanModels.length - 1] ?? "");
      const actualErr = err instanceof ModelChainError ? err.causeError : err;
      console.warn(`[paseo-radar] incremental triage (${failedModel}) failed:`, actualErr);
      params.onModelError?.({ model: failedModel, error: actualErr });
      // Do not cache failed deltaItems so next scan retries; fallback keeps them deterministically
    }
  }

  // Apply cached decisions across scannedItems
  const itemById = new Map(params.scannedItems.map((it) => [it.id, { ...it }]));
  const externalIds = new Set(params.externalBoardCards.map((c) => c.id));
  const droppedOrMergedIds = new Set<string>();

  // First pass: apply keep refinements & drop_noise
  for (const [id, item] of itemById) {
    const entry = nextCache[id];
    if (!entry || entry.stateHash !== item.stateHash) continue;

    const itemMeta = params.meta[id];
    const hasLiveSession = Boolean(itemMeta?.boundWorkspaceId || itemMeta?.boundAgentId);

    if (entry.action === "drop_noise" && !hasLiveSession) {
      droppedOrMergedIds.add(id);
      continue;
    }

    if (entry.roleHint) {
      item.roleHint = entry.roleHint;
    }
    if (entry.selectedModel) {
      item.triageSelectedModel = entry.selectedModel;
    }
    if (entry.projectId) {
      item.triageProjectId = entry.projectId;
    }
    if (entry.group && item.group !== "closing") {
      item.group = entry.group;
    }
  }

  const { extraLinkMerges, absorbedDonorsByTarget } = applyDeterministicAndCachedMerges({
    itemById,
    externalIds,
    droppedOrMergedIds,
    nextCache,
    meta: params.meta,
    ops: {
      normalizeCardId,
      extractCanonicalEntityKeys,
      setsIntersect,
      resolveItemLinks,
      mergeSecondaryIntoPrimary,
    },
  });

  const finalItems = [...itemById.values()].filter((it) => !droppedOrMergedIds.has(it.id));
  finalItems.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  // Prune old cache entries while keeping all currently scanned IDs
  const currentIdSet = new Set(params.scannedItems.map((i) => i.id));
  const cacheEntries = Object.entries(nextCache);
  if (cacheEntries.length > MAX_CACHE_ENTRIES) {
    cacheEntries.sort((a, b) => {
      const aActive = Number(currentIdSet.has(a[0]));
      const bActive = Number(currentIdSet.has(b[0]));
      if (aActive !== bActive) return bActive - aActive;
      return (b[1].triagedAt ?? "").localeCompare(a[1].triagedAt ?? "");
    });
    const pruned: Record<string, TriageCacheEntry> = {};
    for (const [k, v] of cacheEntries.slice(0, MAX_CACHE_ENTRIES)) {
      pruned[k] = v;
    }
    return {
      items: finalItems,
      nextCache: pruned,
      bootstrapped,
      extraLinkMerges,
      absorbedDonorsByTarget,
      deltaCount: deltaItems.length,
      modelTriggered,
    };
  }

  return {
    items: finalItems,
    nextCache,
    bootstrapped,
    extraLinkMerges,
    absorbedDonorsByTarget,
    deltaCount: deltaItems.length,
    modelTriggered,
  };
}
