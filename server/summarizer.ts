import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

import type { ClosureGate, NeedsMeTag, RadarGoal, RadarLink, RadarSource } from "../shared/radar";
import { dedupeSummaryWithTitle } from "../shared/radar-text";
import { ModelChainError, runOneShotPromptWithFallback } from "./llm-oneshot";
import {
  buildConversationDigestFromTimeline,
  hasUnexecutedDocOrProposalActivity,
  hasUnmergedMrActivity,
  MR_CLOSED_RE,
  readDigestFromJsonl,
  shouldSkipStaleSummaryWrite,
  type ConversationDigest,
} from "./needs-me-tag";
import { updateRadarState, type ItemUserMeta } from "./store";

export { readDigestFromJsonl, type ConversationDigest };

export type GoalEvalDecision = "achieved" | "continue" | "blocked";

export interface SummaryEvalResult {
  summary: string;
  tag: NeedsMeTag;
  goalDecision?: GoalEvalDecision;
  goalSteer?: string | null;
}

export interface SummaryCardContext {
  closureGate?: ClosureGate;
  id: string;
  source?: RadarSource;
  badge?: string;
  summary?: string;
  links?: RadarLink[];
  firstUserMessage?: string;
  recentUserMessages?: string[];
  goal?: RadarGoal | null;
}

export function computeSummarySig(agentId: string, text: string): string {
  const h = createHash("sha1").update(text).digest("hex").slice(0, 12);
  return `${agentId}:${h}`;
}

export async function readLatestAssistantFromJsonl(jsonlPath: string): Promise<string> {
  const digest = await readDigestFromJsonl(jsonlPath);
  return digest.latestAssistantReply;
}

export async function extractConversationDigest(
  paseo: PaseoApi,
  agent: PaseoAgent,
): Promise<ConversationDigest> {
  const nativeHandle = (agent.persistence as { nativeHandle?: unknown } | null)?.nativeHandle;
  let diskDigest: ConversationDigest = {
    firstUserMessage: "",
    recentUserMessages: [],
    latestAssistantReply: "",
    hasUnansweredUserMessage: false,
  };
  if (typeof nativeHandle === "string" && nativeHandle.endsWith(".jsonl")) {
    diskDigest = await readDigestFromJsonl(nativeHandle).catch(() => diskDigest);
  }
  if (agent.status === "closed") return diskDigest;

  try {
    const page = await paseo.agents.ref(agent.id).timeline.refetch({
      direction: "tail",
      limit: 40,
      projection: "projected",
    });
    return buildConversationDigestFromTimeline(page.entries, diskDigest);
  } catch {
    return diskDigest;
  }
}

export async function extractLatestAssistantReply(paseo: PaseoApi, agent: PaseoAgent): Promise<string> {
  const digest = await extractConversationDigest(paseo, agent);
  return digest.latestAssistantReply;
}

function clipShort(text: string, maxLen = 500): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}…`;
}

function clipForPrompt(text: string): string {
  const clean = text.trim();
  if (clean.length <= 4500) return clean;
  return `${clean.slice(0, 1200)}\n...(中间省略)...\n${clean.slice(-3000)}`;
}

export function inferDefaultClosureGate({ id, source }: SummaryCardContext): ClosureGate | undefined {
  if (id.startsWith("gitlab-own-")) return {
    requireExternalTerminal: true, terminalBadgeRegex: "\\b(?:Merged|Closed)\\b|已合并|已关闭",
    terminalReplyRegex: MR_CLOSED_RE.source,
  };
  if (id.startsWith("linear-proj-")) return {
    requireExternalTerminal: true,
    terminalReplyRegex: "^(?![\\s\\S]*(?:草稿|待确认|确认后))[\\s\\S]*" + /(?:Project Update|项目动态|项目状态|项目)[^\n，。；]{0,28}(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)(?:已发布|已发出|已提交|已更新为\s*[`*"'「]*(?:Completed|Canceled)|已完成收尾)/i.source,
  };
  if (id.startsWith("linear-issue-") || id.startsWith("linear-todo-") || id.startsWith("linear-close-") || source === "linear") return {
    requireExternalTerminal: true, terminalBadgeRegex: "\\b(?:Completed|Done|Canceled|Cancelled|Duplicate)\\b",
    terminalReplyRegex: /(?:Linear|Issue|单据|状态|[A-Z]{2,10}-\d+)[^\n，。；]{0,28}(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)(?:已更新为|已改为|已设为|已标为|已流转为|更新为|改为)\s*[`*"'「]*(?:Completed|Done|Canceled|Cancelled|Duplicate)\b/i.source + "|" + /(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)已(?:将\s*[A-Z]{2,10}-\d+\s*)?(?:关单|取消单据)/.source,
  };
}

export function clampAutoNeedsMeTag(
  tag: NeedsMeTag,
  evidenceText: string,
  cardContext?: SummaryCardContext,
): NeedsMeTag {
  if (tag !== "ready_to_archive" || !cardContext) return tag;
  const { badge = "", closureGate } = cardContext;
  const gate = closureGate ?? inferDefaultClosureGate(cardContext);
  if (gate?.requireExternalTerminal) {
    const status = !closureGate && cardContext.id.startsWith("linear-")
      ? badge + " " + (cardContext.summary ?? "") : badge;
    try {
      const terminal = (gate.terminalBadgeRegex && new RegExp(gate.terminalBadgeRegex, "i").test(status))
        || (gate.terminalReplyRegex && new RegExp(gate.terminalReplyRegex, "i").test(evidenceText));
      return terminal ? tag : "review";
    } catch {
      return "review"; // Invalid provider pattern cannot authorize archival.
    }
  }

  const userRequestText = [
    cardContext.firstUserMessage ?? "",
    ...(cardContext.recentUserMessages ?? []),
  ].join("\n");
  if (
    !/(?:Merged|Closed|已合并|已关闭)/i.test(badge) &&
    hasUnmergedMrActivity(evidenceText, userRequestText)
  ) {
    return "review";
  }
  if (hasUnexecutedDocOrProposalActivity(evidenceText, userRequestText)) {
    return "review";
  }

  return tag;
}

export function inferNeedsMeTagHeuristic(text: string, cardContext?: SummaryCardContext): NeedsMeTag {
  const clean = text.trim();
  const politeTailOnly = /待确认[：:]\s*是否还(需要|有)(补充)?其他(操作|问题|事项)/.test(clean);
  if (!politeTailOnly) {
    if (/(贴回|提供.*证据|补充.*信息|手动执行)/.test(clean)) {
      return "input";
    }
    if (/(待确认[：:]|是否授权|是否直接提审|是否认可|是否合并|确认后再执行|是否提交)/.test(clean)) {
      return "decision";
    }
  }
  const readyToArchive =
    politeTailOnly ||
    /(已更新为\s*(?:Completed|Done)|已改为\s*(?:Canceled|Cancelled)|已完成收尾|已全部完成|已实质闭环)/i.test(clean) ||
    /(?<!(?:未|没|没有|尚未|暂未|不|切勿|勿)\s*)(?:可|可以|即可)\s*(?:直接|一键)?归档/.test(clean);
  if (readyToArchive) {
    return clampAutoNeedsMeTag("ready_to_archive", clean, cardContext);
  }
  return "review";
}

function extractFallbackSummary(text: string): string {
  const clean = text.trim();
  const secMatch = clean.match(/(?:^|\n)#{1,4}\s*结论摘要[^\n]*\n+([\s\S]+)$/);
  const candidate = (secMatch?.[1] ?? clean)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (candidate.length <= 80) return candidate;
  return secMatch ? `${candidate.slice(0, 80)}…` : `…${candidate.slice(-80)}`;
}

export function formatModelErrorMessage(raw: unknown): string {
  const text = (raw instanceof Error ? raw.message : String(raw ?? "模型调用失败"))
    .replace(/^Error:\s*/i, "")
    .split(/\n\s*at\s+/)[0]!
    .trim();
  const codeMatch = text.match(/^(\d{3})\b\s*[:：-]?\s*/);
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
        message?: unknown;
        error?: { message?: unknown } | unknown;
      };
      const innerMsg =
        typeof parsed.message === "string"
          ? parsed.message
          : typeof (parsed.error as { message?: unknown } | undefined)?.message === "string"
            ? (parsed.error as { message: string }).message
            : typeof parsed.error === "string"
              ? parsed.error
              : null;
      if (innerMsg) {
        const formatted = `${codeMatch?.[1] ? `${codeMatch[1]}: ` : ""}${innerMsg.trim()}`;
        return formatted.length > 200 ? `${formatted.slice(0, 200)}…` : formatted;
      }
    } catch {
      // Keep plain text below
    }
  }
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine || "模型调用异常";
}

function parseSummaryAndTag(
  rawOutput: string,
  fallbackSource: string,
  cardContext?: SummaryCardContext,
  cardTitle?: string,
): SummaryEvalResult {
  const cleaned = rawOutput.replace(/\*\*/g, "").trim();
  const tagMatch = cleaned.match(/(?:^|\n)\s*TAG\s*[：:]\s*(ready_to_archive|decision|input|review)\b/i);
  const rawTag =
    (tagMatch?.[1]?.toLowerCase() as NeedsMeTag | undefined) ??
    inferNeedsMeTagHeuristic(cleaned || fallbackSource, cardContext);

  const goalMatch = cleaned.match(/(?:^|\n)\s*GOAL_STATUS\s*[：:]\s*(achieved|continue|blocked)\b/i);
  const steerMatch = cleaned.match(/(?:^|\n)\s*NEXT_STEER\s*[：:]\s*([^\n]+)/i);

  let body = cleaned
    .replace(/(?:^|\n)\s*TAG\s*[：:]\s*(?:ready_to_archive|decision|input|review)[^\n]*\n?/gi, "")
    .replace(/(?:^|\n)\s*GOAL_STATUS\s*[：:]\s*(?:achieved|continue|blocked)[^\n]*\n?/gi, "")
    .replace(/(?:^|\n)\s*NEXT_STEER\s*[：:][^\n]*\n?/gi, "")
    .replace(/^\s*SUMMARY\s*[：:]\s*/i, "")
    .replace(/^["「]|["」]$/g, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!body) {
    body = fallbackSource.replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 180).trim();
  }
  if (cardTitle) {
    body = dedupeSummaryWithTitle(body, cardTitle);
  }
  const tag = clampAutoNeedsMeTag(rawTag, `${fallbackSource}\n${body}`, cardContext);

  if (!cardContext?.goal?.active) {
    return { summary: body, tag };
  }

  let goalDecision: GoalEvalDecision;
  if (rawTag === "decision" || rawTag === "input") {
    goalDecision = "blocked";
  } else if (goalMatch?.[1]) {
    goalDecision = goalMatch[1].toLowerCase() as GoalEvalDecision;
  } else if (rawTag === "ready_to_archive") {
    goalDecision = "achieved";
  } else {
    goalDecision = "continue";
  }

  const rawSteer = (steerMatch?.[1] ?? "").replace(/^["「]|["」]$/g, "").trim();
  const goalSteer =
    goalDecision === "continue" && rawSteer && !/^none$/i.test(rawSteer) ? rawSteer : null;

  return { summary: body, tag, goalDecision, goalSteer };
}

export async function runDeepSeekSummary(
  cardTitle: string,
  assistantReply: string,
  summaryModels: readonly string[],
  cardContext?: SummaryCardContext,
  paseo?: PaseoApi | null,
  onFallback?: (info: { failedModel: string; nextModel: string; error: unknown }) => void,
): Promise<SummaryEvalResult & { modelUsed: string; isPrimary: boolean }> {
  const clean = assistantReply.trim();
  const activeGoal = cardContext?.goal?.active ? cardContext.goal : null;
  const isLocalWorkspaceCard =
    cardContext?.source === "workspace" || Boolean(cardContext?.id.startsWith("ws-"));
  const contextLines: string[] = [`卡片标题：${cardTitle}`];
  if (isLocalWorkspaceCard) {
    contextLines.push(
      `卡片性质：本地独立工作区会话（${cardContext?.summary || "本地对话"}；注意：卡片标题仅自动截取自首条消息第一行，可能只是引用的单号或报错文本，并非外部跟踪单据。本会话的任务边界完全以「会话初始用户诉求」与「最近用户指令」为准，严禁根据标题中的单号臆造用户未要求的外部任务！）`,
    );
  } else {
    if (cardContext?.badge || cardContext?.summary) {
      const statusParts = [cardContext.badge, cardContext.summary].filter(Boolean).join(" · ");
      if (statusParts) contextLines.push(`卡片外部状态：${statusParts}`);
    }
    if (cardContext?.links && cardContext.links.length > 0) {
      const linkDesc = cardContext.links.map((l) => `${l.label} (${l.url})`).join("；");
      contextLines.push(`关联外部信源：${linkDesc}`);
    }
  }
  if (cardContext?.firstUserMessage) {
    contextLines.push(`会话初始用户诉求：${clipShort(cardContext.firstUserMessage, 500)}`);
  }
  const extraRecentUsers = (cardContext?.recentUserMessages ?? []).filter(
    (m) => m.trim() && m.trim() !== (cardContext?.firstUserMessage ?? "").trim(),
  );
  if (extraRecentUsers.length > 0) {
    contextLines.push(`最近用户指令：${extraRecentUsers.map((m) => clipShort(m, 300)).join(" -> ")}`);
  }
  if (activeGoal) {
    contextLines.push(
      `当前目标模式（已自驱 ${activeGoal.turnCount}/${activeGoal.maxTurns} 轮）：${activeGoal.spec}`,
    );
    if (activeGoal.verifyCommand) {
      contextLines.push(`配置的验收命令：${activeGoal.verifyCommand}`);
    }
    if (activeGoal.lastEvalNote) {
      contextLines.push(`上一轮目标评估：${clipShort(activeGoal.lastEvalNote, 240)}`);
    }
  }

  const formatBlock = activeGoal
    ? [
        "当前卡片处于「目标模式（Goal）」，请同时判断细分标签（TAG）、提炼一句话进度总结（单句中文不换行，控制在 60 字以内），并对照「当前目标模式」评估是否已完整达成目标（GOAL_STATUS）。",
        "",
        "严格按以下四行纯文本格式输出（不要标题、不要加粗符号 **、不要代码块或客套话）：",
        "TAG: <ready_to_archive | decision | input | review>",
        "SUMMARY: <用一句话总结已完成结论/关键进展及当前卡点，控制在 60 字以内；不要重复「卡片标题」中已有的单号或主题词，仅在出现标题之外的新 MR/PR 号时保留>",
        "GOAL_STATUS: <achieved | continue | blocked>",
        "NEXT_STEER: <仅当 GOAL_STATUS=continue 时用 1~2 句直接写出给执行会话的具体下一步推进指令；其他状态输出 NONE>",
      ]
    : [
        "请阅读下面这张 Radar 卡片的上下文、用户诉求与 AI 会话的最新回复，判断卡片停在「待我处理」时的细分标签（TAG），并提炼一句话进度总结（单句中文不换行，控制在 60 字以内）。",
        "",
        "严格按以下两行纯文本格式输出（不要标题、不要加粗符号 **、不要代码块或客套话）：",
        "TAG: <ready_to_archive | decision | input | review>",
        "SUMMARY: <用一句话总结已完成结论/关键进展及当前卡点，控制在 60 字以内；不要重复「卡片标题」中已有的单号或主题词，仅在出现标题之外的新 MR/PR 号时保留>",
      ];

  const goalCriteriaBlock = activeGoal
    ? [
        "",
        "目标模式（GOAL_STATUS）判定准则：",
        "- achieved：「当前目标模式」中要求的全部目标事项与验证收尾动作均已实质完成，没有遗漏子项，也无待确认动作。",
        "- blocked：当前推进必须等待人工确认或授权（对应 TAG: decision，如外发沟通、提审/合并、共享内容修改或生产变更），或缺少只有用户能提供的材料/凭证/决策（对应 TAG: input），或遇到 AI 无法自行绕开的硬性环境/权限阻塞。",
        "- continue：目标尚未全部完成（如仅做完排查或部分步骤、仍有报错未修、漏了验证或 git commit，或习惯性停下做阶段汇报），且无需人工拍板即可由 AI 继续推进；NEXT_STEER 须直接点明剩余待完成动作。",
      ]
    : [];

  const prompt = [
    ...formatBlock,
    "",
    "标签判定准则：",
    "- ready_to_archive（可完结）：当前卡片承载的任务已实质闭环完成，没有尚未执行的后续动作。注意区分两类卡片：1）若为「本地独立工作区会话」，仅当排查答疑已彻底解答（纯咨询），或代码/数据修改已实际执行、验证通过且提交完毕且无后续待评审/待落地动作时，才标 ready_to_archive（不要被首行截取的会话标题误导）；若本轮创建、推送或更新了尚未合并的 MR/PR（如“已提审”“强推更新 MR”“等待 Review/CI/合并”），或仅起草/更新了方案、RFC、设计文档（方案尚未评审或落地执行），严禁标 ready_to_archive，应标 review；2）若为「外部单据/MR 跟踪卡」（如 Linear Todo / In Progress / In Review 或未合并 MR），则要求外部主单据已关单/取消或 MR 已合入闭环——仅完成阶段子步骤（如预研、RFC、未合入 MR）或仅处理支线问答时严禁标 ready_to_archive，应标 review；3）只要仍有提审、合并、改单据状态、外发消息、运行脚本等动作待用户确认，必须标 decision。",
    "- decision（待确认）：方案、草稿、MR 或脚本已备好，明确等待用户确认或授权后执行具体动作。",
    "- input（待补充）：需用户提供材料/证据、补充背景，或手动运行命令后将输出贴回。",
    "- review（待查阅）：阶段性排查结论、子步骤进展同步或支线核对结果，任务尚未最终闭环且暂无明确待授权动作，待用户查阅并指示下一步。",
    ...goalCriteriaBlock,
    "",
    ...contextLines,
    "AI 最新回复：",
    clipForPrompt(clean),
  ].join("\n");

  const res = await runOneShotPromptWithFallback({
    modelSpecs: summaryModels,
    prompt,
    paseo,
    timeoutMs: 90_000,
    onFallback,
  });
  const parsed = parseSummaryAndTag(res.text, clean, cardContext, cardTitle);
  return { ...parsed, modelUsed: res.modelUsed, isPrimary: res.isPrimary };
}

export interface GoalSynthesisContext {
  id: string;
  title: string;
  source?: RadarSource;
  badge?: string;
  summary?: string;
  links?: RadarLink[];
  prepPrompt?: string;
  workPrompt?: string;
  firstUserMessage?: string;
  recentUserMessages?: string[];
  latestAssistantReply?: string;
  workspaceName?: string | null;
  projectName?: string | null;
}

export interface GoalSynthesisResult {
  spec: string;
  autoRefined: boolean;
}

export function parseSynthesizedGoal(rawReply: string, userSpec: string): GoalSynthesisResult {
  const cleaned = rawReply.replace(/\r\n/g, "\n").trim();
  const modeMatch = cleaned.match(/(?:^|\n)\s*MODE\s*[：:]\s*(GENERATED|REFINED|KEPT)\b/i);
  const goalMatch = cleaned.match(/(?:^|\n)\s*GOAL\s*[：:]\s*([\s\S]+?)(?=\n\s*[A-Z_]+\s*[：:]|$)/i);

  const mode = (modeMatch?.[1] ?? "").toUpperCase();
  const parsedGoal = (goalMatch?.[1] ?? "")
    .replace(/\*\*/g, "")
    .replace(/^["「]|["」]$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (mode === "KEPT" && userSpec) {
    return {
      spec: parsedGoal || userSpec,
      autoRefined: false,
    };
  }
  if (parsedGoal) {
    return {
      spec: parsedGoal,
      autoRefined: !userSpec || parsedGoal !== userSpec,
    };
  }
  return {
    spec: userSpec,
    autoRefined: false,
  };
}

function buildFallbackGoalFromContext(ctx: GoalSynthesisContext): string {
  const recentUsers = (ctx.recentUserMessages ?? []).filter((m) => m.trim() !== "");
  const seed =
    recentUsers[recentUsers.length - 1] ||
    ctx.firstUserMessage?.trim() ||
    ctx.workPrompt?.trim() ||
    ctx.summary?.trim() ||
    ctx.title.trim();
  const clipped = clipShort(seed.replace(/\s+/g, " "), 120);
  return clipped
    ? `围绕「${clipped}」完成排查、处理与验证，确认无遗漏后收尾。`
    : "完成当前任务排查、实现与验证，确认无遗漏后收尾。";
}

export async function synthesizeRadarGoal(params: {
  rawSpec?: string | null;
  verifyCommand?: string | null;
  context: GoalSynthesisContext;
  summaryModels: readonly string[];
  paseo?: PaseoApi | null;
}): Promise<GoalSynthesisResult> {
  const userSpec = (params.rawSpec ?? "").trim();
  const ctx = params.context;

  if (params.summaryModels.length === 0) {
    return userSpec
      ? { spec: userSpec, autoRefined: false }
      : { spec: buildFallbackGoalFromContext(ctx), autoRefined: true };
  }

  const isLocalWorkspaceCard = ctx.source === "workspace" || ctx.id.startsWith("ws-");
  const contextLines: string[] = [`卡片标题：${ctx.title}`];
  if (ctx.projectName) contextLines.push(`关联项目：${ctx.projectName}`);
  if (ctx.workspaceName) contextLines.push(`工作区：${ctx.workspaceName}`);
  if (isLocalWorkspaceCard) {
    contextLines.push(
      `卡片类型：本地独立工作区会话（若标题仅是首条消息截取的报错或单号，请以实际用户对话诉求为准，不要臆造外部任务）`,
    );
  } else {
    const statusParts = [ctx.badge, ctx.summary].filter(Boolean).join(" · ");
    if (statusParts) contextLines.push(`外部卡片状态：${statusParts}`);
    if (ctx.links && ctx.links.length > 0) {
      contextLines.push(`关联链接：${ctx.links.map((l) => `${l.label} (${l.url})`).join("；")}`);
    }
    if (ctx.workPrompt) {
      contextLines.push(`卡片预设处理指令：${clipShort(ctx.workPrompt, 500)}`);
    } else if (ctx.prepPrompt) {
      contextLines.push(`卡片预设排查指令：${clipShort(ctx.prepPrompt, 400)}`);
    }
  }
  if (ctx.firstUserMessage) {
    contextLines.push(`会话初始用户诉求：${clipShort(ctx.firstUserMessage, 500)}`);
  }
  const extraRecentUsers = (ctx.recentUserMessages ?? []).filter(
    (m) => m.trim() && m.trim() !== (ctx.firstUserMessage ?? "").trim(),
  );
  if (extraRecentUsers.length > 0) {
    contextLines.push(`最近用户指令：${extraRecentUsers.map((m) => clipShort(m, 300)).join(" -> ")}`);
  }
  if (ctx.latestAssistantReply) {
    contextLines.push(`AI 最新回复摘要：${clipShort(ctx.latestAssistantReply, 500)}`);
  }
  if (params.verifyCommand?.trim()) {
    contextLines.push(`用户指定的验收命令：${params.verifyCommand.trim()}`);
  }

  const prompt = [
    "你是 Paseo Radar「目标模式」的目标规划助手。目标模式会在每轮 AI 回复后自动评估是否达成目标，未达成则继续自动续推，直到闭环或遇到人工卡点。",
    "用户开启目标模式时可能留空，也可能只给出模糊、不完整或缺少验收标准的描述。请结合下方上下文，输出一个清晰、具体、可验证的最终目标描述（1~3 句中文）。",
    "",
    "规则：",
    "1. 若「用户目标输入」为空（未填写）：结合卡片信息与对话上下文，推断出最合理、可执行、可验证的闭环目标（MODE: GENERATED）。",
    "2. 若「用户目标输入」模糊、宽泛、缺少关键对象或验收收尾标准（如「修一下」「搞定这个」「继续」「优化性能」等）：结合上下文将其补充完善为具体、有明确交付与验证边界的目标（MODE: REFINED）。",
    "3. 若「用户目标输入」已经清晰具体且合理：保持其核心语义与要求不变（MODE: KEPT）。",
    "4. 严格尊重用户的显式约束：例如用户要求「只排查不改代码」「暂不提交 commit」「先出方案」，绝对不要擅自加入修改代码或 git commit 的要求；仅在确实涉及代码改动且用户未禁止提交时，可自然包含验证与提交收尾。",
    "5. 严禁脱离上下文凭空编造不存在的文件名、单号或需求。",
    "",
    "严格按以下两行纯文本格式输出（不要加粗、不要 markdown 标题、不要代码块）：",
    "MODE: <GENERATED | REFINED | KEPT>",
    "GOAL: <1~3 句简洁明确的中文目标描述>",
    "",
    `用户目标输入：${userSpec ? userSpec : "（未填写）"}`,
    "",
    ...contextLines,
  ].join("\n");

  try {
    const res = await runOneShotPromptWithFallback({
      modelSpecs: params.summaryModels,
      prompt,
      paseo: params.paseo,
      timeoutMs: 60_000,
    });
    const parsed = parseSynthesizedGoal(res.text, userSpec);
    if (parsed.spec) return parsed;
  } catch (err) {
    console.warn(`[paseo-radar] synthesizeRadarGoal failed for ${ctx.id}:`, err);
  }

  return userSpec
    ? { spec: userSpec, autoRefined: false }
    : { spec: buildFallbackGoalFromContext(ctx), autoRefined: true };
}

const SUMMARY_FAILURE_RETRY_COOLDOWN_MS = 60_000;

export interface SummaryQueueCallbacks {
  onSuccess?: (info: { summaryModel: string; isPrimary: boolean; cardId: string }) => void;
  onEvaluated?: (info: {
    params: SummaryEnqueueParams;
    result: SummaryEvalResult;
    sig: string;
  }) => Promise<void> | void;
  onFallback?: (info: {
    failedModel: string;
    nextModel: string;
    cardId: string;
    cardTitle: string;
    error: unknown;
  }) => void;
  onError?: (info: {
    summaryModel: string;
    cardId: string;
    cardTitle: string;
    error: unknown;
  }) => void;
}

export type SummaryEnqueueParams = {
  cardId: string;
  cardTitle: string;
  cardContext?: SummaryCardContext;
  workspaceId?: string | null;
  agentId: string;
  fullReply: string;
  summaryModels: string[];
  paseo?: PaseoApi | null;
  allowGoalSteer?: boolean;
};

function shouldPreserveOtherAgentDecision(
  prev: ItemUserMeta | undefined,
  incomingAgentId: string,
): boolean {
  if (!prev?.needsMeTagLocked || prev.needsMeTag !== "decision") return false;
  const ownerId = prev.decisionProposal?.agentId ?? prev.needsMeTagAgentId ?? null;
  return Boolean(ownerId && ownerId !== incomingAgentId);
}

function applySummaryMetaUpdate(
  prev: ItemUserMeta | undefined,
  opts: {
    params: SummaryEnqueueParams;
    sig: string;
    summary: string;
    tag: NeedsMeTag;
    persistSig: boolean;
    enqueuedAt: string;
    nowIso: string;
  },
): ItemUserMeta | null {
  if (shouldPreserveOtherAgentDecision(prev, opts.params.agentId)) return null;
  if (shouldSkipStaleSummaryWrite(prev, opts.enqueuedAt)) return null;
  const keepExistingSummary = Boolean(prev?.prepSummary && prev.prepSummarySig === opts.sig);
  const keepLockedTag = Boolean(prev?.needsMeTagLocked && prev.needsMeTag);
  return {
    ...prev,
    ...(opts.params.workspaceId ? { boundWorkspaceId: opts.params.workspaceId } : {}),
    boundAgentId: opts.params.agentId,
    ...(opts.persistSig
      ? {
          prepSummary: keepExistingSummary ? prev!.prepSummary : opts.summary,
          prepSummarySig: opts.sig,
        }
      : keepExistingSummary
        ? {}
        : { prepSummary: opts.summary, prepSummarySig: null }),
    ...(keepLockedTag
      ? {}
      : {
          needsMeTag: opts.tag,
          needsMeTagAgentId: opts.params.agentId,
          needsMeTagUpdatedAt: opts.nowIso,
        }),
  };
}

export class TurnSummaryQueue {
  private inFlightSlots = new Set<string>();
  private inFlightKeyBySlot = new Map<string, string>();
  private cardEpoch = new Map<string, number>();
  private pendingGoalSteerKeys = new Set<string>();
  private steeredKeys = new Set<string>();
  private succeededResults = new Map<string, SummaryEvalResult>();
  private succeededSigs = new Set<string>();
  private failedAtByKey = new Map<string, { atMs: number; modelKey: string }>();
  private failedParamsByModel = new Map<string, Map<string, { dedupeKey: string; params: SummaryEnqueueParams }>>();
  private activeWorkers = 0;
  private queue: Array<() => Promise<void>> = [];
  private readonly callbacks: SummaryQueueCallbacks | undefined;

  constructor(callbacks?: SummaryQueueCallbacks) {
    this.callbacks = callbacks;
  }

  /** Invalidate any in-flight or cached summary work for `cardId` when a new user turn begins. */
  invalidateCard(cardId: string): void {
    this.cardEpoch.set(cardId, (this.cardEpoch.get(cardId) ?? 0) + 1);
    const prefix = `${cardId}|`;
    for (const k of [...this.succeededSigs]) {
      if (k.startsWith(prefix)) this.succeededSigs.delete(k);
    }
    for (const k of [...this.succeededResults.keys()]) {
      if (k.startsWith(prefix)) this.succeededResults.delete(k);
    }
    for (const k of [...this.steeredKeys]) {
      if (k.startsWith(prefix)) this.steeredKeys.delete(k);
    }
    for (const k of [...this.pendingGoalSteerKeys]) {
      if (k.startsWith(prefix)) this.pendingGoalSteerKeys.delete(k);
    }
    for (const k of [...this.failedAtByKey.keys()]) {
      if (k.startsWith(prefix)) this.failedAtByKey.delete(k);
    }
    for (const entries of this.failedParamsByModel.values()) {
      for (const slot of [...entries.keys()]) {
        if (slot.startsWith(prefix)) entries.delete(slot);
      }
    }
  }

  private isCardEpochCurrent(cardId: string, epoch: number): boolean {
    return (this.cardEpoch.get(cardId) ?? 0) === epoch;
  }

  isSummarizing(cardId: string): boolean {
    const prefix = `${cardId}|`;
    for (const slot of this.inFlightSlots) {
      if (slot.startsWith(prefix)) return true;
    }
    return false;
  }

  retryFailedForModel(summaryModel: string, overrideModels?: string[]): number {
    const entries = this.failedParamsByModel.get(summaryModel);
    if (!entries || entries.size === 0) return 0;
    const items = [...entries.values()];
    this.failedParamsByModel.delete(summaryModel);
    let count = 0;
    for (const item of items) {
      this.failedAtByKey.delete(item.dedupeKey);
      this.enqueue({
        ...item.params,
        summaryModels: overrideModels ?? item.params.summaryModels,
      });
      count += 1;
    }
    return count;
  }

  enqueue(params: SummaryEnqueueParams): void {
    const text = params.fullReply.trim();
    if (!text) return;
    const sig = computeSummarySig(params.agentId, text);
    const slotKey = `${params.cardId}|${params.agentId}`;
    const dedupeKey = `${params.cardId}|${sig}`;
    const enqueuedAt = new Date().toISOString();
    const epoch = this.cardEpoch.get(params.cardId) ?? 0;

    if (params.allowGoalSteer) {
      if (this.inFlightKeyBySlot.get(slotKey) === dedupeKey) {
        this.pendingGoalSteerKeys.add(dedupeKey);
        return;
      }
      const cached = this.succeededResults.get(dedupeKey);
      if (cached && !this.steeredKeys.has(dedupeKey)) {
        this.steeredKeys.add(dedupeKey);
        void Promise.resolve(
          this.callbacks?.onEvaluated?.({
            params: { ...params, allowGoalSteer: true },
            result: cached,
            sig,
          }),
        ).catch((err: unknown) =>
          console.warn(`[paseo-radar] post-turn goal evaluation failed for ${params.cardId}:`, err),
        );
        return;
      }
    }

    if (this.inFlightSlots.has(slotKey) || this.succeededSigs.has(dedupeKey)) {
      return;
    }
    const cleanModels = params.summaryModels.map((m) => m.trim()).filter(Boolean);
    if (cleanModels.length === 0) {
      const fallback = dedupeSummaryWithTitle(extractFallbackSummary(text), params.cardTitle);
      const fallbackTag = inferNeedsMeTagHeuristic(text, params.cardContext);
      const fallbackResult: SummaryEvalResult = {
        summary: fallback,
        tag: fallbackTag,
        ...(params.cardContext?.goal?.active
          ? {
              goalDecision:
                fallbackTag === "decision" || fallbackTag === "input"
                  ? "blocked"
                  : fallbackTag === "ready_to_archive"
                    ? "achieved"
                    : "continue",
            }
          : {}),
      };
      this.succeededSigs.add(dedupeKey);
      this.succeededResults.set(dedupeKey, fallbackResult);
      void updateRadarState((s) => {
        if (!this.isCardEpochCurrent(params.cardId, epoch)) return;
        const nextMeta = applySummaryMetaUpdate(s.meta[params.cardId], {
          params,
          sig,
          summary: fallback,
          tag: fallbackTag,
          persistSig: true,
          enqueuedAt,
          nowIso: new Date().toISOString(),
        });
        if (nextMeta) s.meta[params.cardId] = nextMeta;
      }).then(async () => {
        if (!this.isCardEpochCurrent(params.cardId, epoch)) return;
        if (params.allowGoalSteer && !this.steeredKeys.has(dedupeKey)) {
          this.steeredKeys.add(dedupeKey);
          await this.callbacks?.onEvaluated?.({
            params: { ...params, allowGoalSteer: true },
            result: fallbackResult,
            sig,
          });
        }
      });
      return;
    }
    const modelKey = cleanModels.join(",");
    const prevFail = this.failedAtByKey.get(dedupeKey);
    if (
      prevFail &&
      prevFail.modelKey === modelKey &&
      Date.now() - prevFail.atMs < SUMMARY_FAILURE_RETRY_COOLDOWN_MS
    ) {
      return;
    }
    this.inFlightSlots.add(slotKey);
    this.inFlightKeyBySlot.set(slotKey, dedupeKey);
    if (params.allowGoalSteer) {
      this.pendingGoalSteerKeys.add(dedupeKey);
    }

    this.queue.push(async () => {
      try {
        const res = await runDeepSeekSummary(
          params.cardTitle,
          text,
          cleanModels,
          params.cardContext,
          params.paseo,
          (fb) => {
            this.callbacks?.onFallback?.({
              failedModel: fb.failedModel,
              nextModel: fb.nextModel,
              cardId: params.cardId,
              cardTitle: params.cardTitle,
              error: fb.error,
            });
          },
        );
        if (!this.isCardEpochCurrent(params.cardId, epoch)) {
          return;
        }
        this.succeededSigs.add(dedupeKey);
        this.succeededResults.set(dedupeKey, res);
        if (this.succeededResults.size > 300) {
          const oldest = this.succeededResults.keys().next().value;
          if (oldest) this.succeededResults.delete(oldest);
        }
        this.failedAtByKey.delete(dedupeKey);
        for (const m of cleanModels) {
          this.failedParamsByModel.get(m)?.delete(slotKey);
        }
        this.callbacks?.onSuccess?.({
          summaryModel: res.modelUsed,
          isPrimary: res.isPrimary,
          cardId: params.cardId,
        });
        let appliedWrite = false;
        await updateRadarState((s) => {
          if (!this.isCardEpochCurrent(params.cardId, epoch)) return;
          const nextMeta = applySummaryMetaUpdate(s.meta[params.cardId], {
            params,
            sig,
            summary: res.summary,
            tag: res.tag,
            persistSig: true,
            enqueuedAt,
            nowIso: new Date().toISOString(),
          });
          if (nextMeta) {
            s.meta[params.cardId] = nextMeta;
            appliedWrite = true;
          }
        });
        const shouldSteer =
          appliedWrite &&
          this.isCardEpochCurrent(params.cardId, epoch) &&
          this.pendingGoalSteerKeys.has(dedupeKey) &&
          !this.steeredKeys.has(dedupeKey);
        this.pendingGoalSteerKeys.delete(dedupeKey);
        if (shouldSteer) {
          this.steeredKeys.add(dedupeKey);
          await this.callbacks?.onEvaluated?.({
            params: { ...params, allowGoalSteer: true },
            result: res,
            sig,
          });
        }
      } catch (err) {
        if (!this.isCardEpochCurrent(params.cardId, epoch)) {
          return;
        }
        const lastModel = err instanceof ModelChainError ? err.failedModel : (cleanModels[cleanModels.length - 1] ?? "");
        const actualErr = err instanceof ModelChainError ? err.causeError : err;
        this.failedAtByKey.set(dedupeKey, { atMs: Date.now(), modelKey });
        let modelFailures = this.failedParamsByModel.get(lastModel);
        if (!modelFailures) {
          modelFailures = new Map();
          this.failedParamsByModel.set(lastModel, modelFailures);
        }
        modelFailures.set(slotKey, { dedupeKey, params });
        console.warn(`[paseo-radar] summary model (${lastModel}) failed for ${params.cardId}:`, actualErr);
        this.callbacks?.onError?.({
          summaryModel: lastModel,
          cardId: params.cardId,
          cardTitle: params.cardTitle,
          error: actualErr,
        });
        const fallback = dedupeSummaryWithTitle(extractFallbackSummary(text), params.cardTitle);
        const fallbackTag = inferNeedsMeTagHeuristic(text, params.cardContext);
        await updateRadarState((s) => {
          if (!this.isCardEpochCurrent(params.cardId, epoch)) return;
          const nextMeta = applySummaryMetaUpdate(s.meta[params.cardId], {
            params,
            sig,
            summary: fallback,
            tag: fallbackTag,
            persistSig: false,
            enqueuedAt,
            nowIso: new Date().toISOString(),
          });
          if (nextMeta) s.meta[params.cardId] = nextMeta;
        });
      } finally {
        this.inFlightSlots.delete(slotKey);
        if (this.inFlightKeyBySlot.get(slotKey) === dedupeKey) {
          this.inFlightKeyBySlot.delete(slotKey);
        }
      }
    });

    this.pump();
  }

  private pump(): void {
    while (this.activeWorkers < 2 && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.activeWorkers += 1;
      void job().finally(() => {
        this.activeWorkers -= 1;
        this.pump();
      });
    }
  }
}
