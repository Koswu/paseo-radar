import { open } from "node:fs/promises";
import type { ItemUserMeta } from "./store";

export interface AgentReplyTimeLike {
  id: string;
  lastUserMessageAt?: string | null;
}

export interface TurnBeforeScopeMatch {
  inScopeCardIds: string[];
  clearCardIds: string[];
}

export interface ConversationDigest {
  firstUserMessage: string;
  recentUserMessages: string[];
  latestAssistantReply: string;
  hasUnansweredUserMessage: boolean;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isProtectedOtherAgentDecision(meta: ItemUserMeta, agentId: string): boolean {
  if (meta.needsMeTag !== "decision" || meta.decisionProposal === null) {
    return false;
  }
  const ownerId =
    meta.decisionProposal?.agentId ?? meta.needsMeTagAgentId ?? meta.boundAgentId ?? null;
  return Boolean(ownerId && ownerId !== agentId);
}

/** Build a metadata patch that clears any active needsMeTag and records when it was cleared. */
export function buildClearedNeedsMeTagPatch(clearedAt: string): Partial<ItemUserMeta> {
  return {
    needsMeTag: null,
    needsMeTagLocked: false,
    needsMeTagAgentId: null,
    needsMeTagUpdatedAt: null,
    needsMeTagClearedAt: clearedAt,
    decisionProposal: null,
  };
}

export const MR_CLOSED_RE =
  /(?:MR|PR|Merge Request|Pull Request|!\d+|#\d+)[^\n，。；]{0,24}(?<!(?:未|没|没有|尚未|暂未|并未|不要|不用|无需|不)\s*)(?:已合并|已合入|已关闭)|\b(?:MR|PR|Merge Request|Pull Request|!\d+|#\d+)\s+(?:has been\s+)?(?:merged|closed)\b/i;

const MR_OPENED_OR_UPDATED_RE =
  /(?:(?:新建|创建|发起|提交|推送|强推|更新|同步更新|提审|提了|开了|补了)[^\n，。；]{0,20}(?:MR|PR|Merge Request|Pull Request|!\d+)|(?:MR|PR|Merge Request|Pull Request|!\d+)[^\n，。；]{0,24}(?:已创建|已发起|已提交|已推送|已强推|已更新|标题同步更新|提审完成|待合并|等待合并|待\s*review|等待\s*review|等待审批|待合入|等待合入|流水线运行中|CI\s*运行中|pipeline\s*(?:running|pending))|提审动作完成|\b(?:opened|created|submitted|pushed|force-pushed|updated)\s+(?:a\s+|the\s+)?(?:MR|PR|Merge Request|Pull Request)\b|\b(?:MR|PR)\s*(?:!\d+|#\d+)?\s+(?:is\s+)?(?:open|pending\s+(?:review|merge|ci))\b)/i;

const USER_ONLY_OPEN_MR_RE =
  /(?:只需|仅需|只要|只用|只管|仅)[^\n，。；]{0,12}(?:提|创建|更新|提交)\s*(?:MR|PR)|(?:用户|需求)?(?:仅|只)(?:要求|需)(?:提|创建|更新)\s*(?:MR|PR)|不用(?:等|管)[^\n，。；]{0,8}(?:合并|合入)/i;

/** Check whether text describes creating or updating an unmerged MR/PR without terminal merge/close or explicit user opt-out. */
export function hasUnmergedMrActivity(text: string, userRequestText = ""): boolean {
  if (USER_ONLY_OPEN_MR_RE.test(userRequestText) || USER_ONLY_OPEN_MR_RE.test(text)) {
    return false;
  }
  return MR_OPENED_OR_UPDATED_RE.test(text) && !MR_CLOSED_RE.test(text);
}

const DOC_OR_PROPOSAL_ACTIVITY_RE =
  /(?:方案|RFC|设计|技术方案|调研)(?:文档)?[^\n，。；]{0,20}(?:已?(?:同步|写入|覆盖|更新|发布|创建|生成|起草|保存|整理)|已就绪|内容就绪|已完成(?:编写|撰写|起草|更新|重写))/i;

const DOC_EXECUTED_OR_ONLY_DOC_RE =
  /(?:方案|RFC|需求)[^\n，。；]{0,20}(?:已落地|已实施|已上线|已开发完成|已执行完成|已评审通过并完成)|(?:只需|仅需|只要|只用)[^\n，。；]{0,12}(?:写|改|更新)(?:完)?文档(?:即可|就行)/i;

/** Check whether text only reports writing/updating a proposal or design document without execution/implementation. */
export function hasUnexecutedDocOrProposalActivity(text: string, userRequestText = ""): boolean {
  if (DOC_EXECUTED_OR_ONLY_DOC_RE.test(userRequestText) || DOC_EXECUTED_OR_ONLY_DOC_RE.test(text)) {
    return false;
  }
  return DOC_OR_PROPOSAL_ACTIVITY_RE.test(text);
}

/**
 * Resolve all cards associated with a user conversation turn starting on `agent`,
 * splitting between all in-scope cards (to invalidate stale in-flight summaries)
 * and cards whose active tag state should be cleared immediately.
 */
export function findMatchingTurnBeforeCards(
  metaMap: Readonly<Record<string, ItemUserMeta | undefined>>,
  agent: { id: string; workspaceId: string | null },
): TurnBeforeScopeMatch {
  const inScopeSet = new Set<string>();
  const clearSet = new Set<string>();

  if (agent.workspaceId !== null) {
    inScopeSet.add(`ws-${agent.workspaceId}`);
  }

  for (const [cardId, meta] of Object.entries(metaMap)) {
    if (!meta) continue;
    const inCard =
      meta.boundAgentId === agent.id ||
      (agent.workspaceId !== null &&
        (meta.boundWorkspaceId === agent.workspaceId || cardId === `ws-${agent.workspaceId}`));
    if (!inCard) continue;

    inScopeSet.add(cardId);

    const hasTagState = Boolean(
      meta.needsMeTagLocked || meta.needsMeTag !== null || meta.decisionProposal !== null,
    );
    if (!hasTagState) continue;
    if (isProtectedOtherAgentDecision(meta, agent.id)) continue;

    clearSet.add(cardId);
  }

  return {
    inScopeCardIds: [...inScopeSet],
    clearCardIds: [...clearSet],
  };
}

/**
 * Detect whether a user message was sent to any conversation agent in the card
 * after the current `needsMeTag` was set (e.g. if `agent.turn.before` was missed
 * during a plugin reload or failed stale-session dispatch).
 */
export function findUserReplyAfterTag(
  meta: ItemUserMeta | undefined,
  agents: readonly AgentReplyTimeLike[],
): { clearedAt: string } | null {
  if (!meta) return null;
  const hasTagState = Boolean(
    meta.needsMeTagLocked || meta.needsMeTag !== null || meta.decisionProposal !== null,
  );
  if (!hasTagState) return null;

  const tagUpdatedMs = parseTimestampMs(meta.needsMeTagUpdatedAt);
  if (tagUpdatedMs === null) return null;

  let latestReplyIso: string | null = null;
  let latestReplyMs = tagUpdatedMs;

  for (const agent of agents) {
    if (isProtectedOtherAgentDecision(meta, agent.id)) continue;
    const rawReplyAt = agent.lastUserMessageAt;
    const replyMs = parseTimestampMs(rawReplyAt);
    if (replyMs === null || replyMs <= latestReplyMs) continue;
    latestReplyMs = replyMs;
    latestReplyIso = rawReplyAt!;
  }

  return latestReplyIso ? { clearedAt: latestReplyIso } : null;
}

/**
 * Return true when a newer user reply / turn clear happened after `enqueuedAt`,
 * so an older in-flight summary must not re-apply stale tags or summary text.
 */
export function shouldSkipStaleSummaryWrite(
  prev: ItemUserMeta | undefined,
  enqueuedAt: string,
): boolean {
  const clearedMs = parseTimestampMs(prev?.needsMeTagClearedAt);
  const enqueuedMs = parseTimestampMs(enqueuedAt);
  if (clearedMs === null || enqueuedMs === null) return false;
  return clearedMs > enqueuedMs;
}

/**
 * Prevent loadSnapshot backfill from re-tagging an old assistant reply after a user
 * replied (e.g. when the new turn is still pending, failed, or canceled).
 */
export function shouldSkipBackfillAfterUserClear(
  cardMeta: ItemUserMeta | undefined,
  replySig: string,
  hasUnansweredUserMessage: boolean,
): boolean {
  if (hasUnansweredUserMessage) return true;
  if (cardMeta?.needsMeTagClearedAt && cardMeta.prepSummarySig === replySig) {
    return true;
  }
  return false;
}

function extractJsonlContentText(
  content: Array<{ type?: string; text?: string }> | string | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim() !== "")
      .map((c) => c.text!.trim())
      .join("\n")
      .trim();
  }
  return "";
}

/** Read user intent (first + recent user messages) and latest assistant reply from pi .jsonl session file. */
export async function readDigestFromJsonl(jsonlPath: string): Promise<ConversationDigest> {
  const fh = await open(jsonlPath, "r");
  try {
    const stat = await fh.stat();
    if (stat.size === 0) {
      return {
        firstUserMessage: "",
        recentUserMessages: [],
        latestAssistantReply: "",
        hasUnansweredUserMessage: false,
      };
    }

    const parseLines = (lines: string[]) => {
      const msgs: Array<{ role: string; text: string }> = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string };
          };
          if (entry.type !== "message" || !entry.message?.role) continue;
          const role = entry.message.role;
          if (role !== "user" && role !== "assistant") continue;
          const text = extractJsonlContentText(entry.message.content);
          if (text) msgs.push({ role, text });
        } catch {
          // Ignore malformed/partial line
        }
      }
      return msgs;
    };

    const tailBytes = Math.min(stat.size, 256 * 1024);
    const tailBuf = Buffer.alloc(tailBytes);
    await fh.read(tailBuf, 0, tailBytes, stat.size - tailBytes);
    const tailLines = tailBuf.toString("utf8").split("\n");
    if (stat.size > tailBytes && tailLines.length > 1) {
      tailLines.shift();
    }
    const tailMsgs = parseLines(tailLines);

    let firstUserMessage = "";
    if (stat.size <= tailBytes) {
      firstUserMessage = tailMsgs.find((m) => m.role === "user")?.text ?? "";
    } else {
      const headBytes = Math.min(stat.size, 96 * 1024);
      const headBuf = Buffer.alloc(headBytes);
      await fh.read(headBuf, 0, headBytes, 0);
      const headLines = headBuf.toString("utf8").split("\n");
      if (headLines.length > 1) headLines.pop();
      firstUserMessage =
        parseLines(headLines).find((m) => m.role === "user")?.text ??
        tailMsgs.find((m) => m.role === "user")?.text ??
        "";
    }

    let latestAssistantReply = "";
    for (let i = tailMsgs.length - 1; i >= 0; i--) {
      if (tailMsgs[i]!.role === "assistant") {
        latestAssistantReply = tailMsgs[i]!.text;
        break;
      }
    }
    const lastTailRole = tailMsgs[tailMsgs.length - 1]?.role;
    const hasUnansweredUserMessage = lastTailRole === "user";

    const recentUserMessages = tailMsgs
      .filter((m) => m.role === "user")
      .slice(-2)
      .map((m) => m.text);

    return {
      firstUserMessage,
      recentUserMessages,
      latestAssistantReply,
      hasUnansweredUserMessage,
    };
  } finally {
    await fh.close();
  }
}

/** Merge projected Paseo timeline entries with optional disk JSONL digest, detecting trailing unanswered user replies. */
export function buildConversationDigestFromTimeline(
  entries: ReadonlyArray<{ item?: unknown } | null | undefined>,
  diskDigest: ConversationDigest,
): ConversationDigest {
  const assistantParts: string[] = [];
  let sawUserAfterLastAssistant = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) break;
    const item = entry.item as { type?: string; text?: string } | undefined;
    if (!item) continue;
    if (item.type === "assistant_message" && typeof item.text === "string") {
      assistantParts.unshift(item.text);
      continue;
    }
    if (item.type === "plugin" || item.type === "notification") continue;
    if (assistantParts.length > 0) break;
    if (item.type === "user_message") {
      sawUserAfterLastAssistant = true;
    }
  }

  const timelineUsers: string[] = [];
  for (const entry of entries) {
    const item = entry?.item as { type?: string; text?: string } | undefined;
    if (item?.type === "user_message" && typeof item.text === "string" && item.text.trim()) {
      timelineUsers.push(item.text.trim());
    }
  }

  const latestAssistantReply = assistantParts.join("").trim() || diskDigest.latestAssistantReply;
  const firstUserMessage = diskDigest.firstUserMessage || timelineUsers[0] || "";
  const recentUserMessages =
    timelineUsers.length > 0 ? timelineUsers.slice(-2) : diskDigest.recentUserMessages;
  const hasUnansweredUserMessage =
    assistantParts.length > 0
      ? sawUserAfterLastAssistant
      : sawUserAfterLastAssistant || diskDigest.hasUnansweredUserMessage;

  return {
    firstUserMessage,
    recentUserMessages,
    latestAssistantReply,
    hasUnansweredUserMessage,
  };
}
