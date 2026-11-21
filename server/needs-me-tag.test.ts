import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildClearedNeedsMeTagPatch,
  buildConversationDigestFromTimeline,
  findMatchingTurnBeforeCards,
  findUserReplyAfterTag,
  hasUnexecutedDocOrProposalActivity,
  hasUnmergedMrActivity,
  readDigestFromJsonl,
  shouldSkipBackfillAfterUserClear,
  shouldSkipStaleSummaryWrite,
} from "./needs-me-tag.ts";
import type { ItemUserMeta } from "./store.ts";

test("findMatchingTurnBeforeCards matches ws-* card even when boundWorkspaceId is missing", () => {
  const metaMap: Record<string, ItemUserMeta> = {
    "ws-wks_1": {
      needsMeTag: "ready_to_archive",
      needsMeTagLocked: true,
    },
  };

  const res = findMatchingTurnBeforeCards(metaMap, {
    id: "agent-1",
    workspaceId: "wks_1",
  });

  assert.deepEqual(res.inScopeCardIds, ["ws-wks_1"]);
  assert.deepEqual(res.clearCardIds, ["ws-wks_1"]);
});

test("findMatchingTurnBeforeCards clears ready_to_archive even when another session in same workspace replies", () => {
  const metaMap: Record<string, ItemUserMeta> = {
    "ws-wks_1": {
      boundWorkspaceId: "wks_1",
      boundAgentId: "agent-old",
      needsMeTag: "ready_to_archive",
      needsMeTagLocked: true,
      needsMeTagAgentId: "agent-old",
    },
  };

  const res = findMatchingTurnBeforeCards(metaMap, {
    id: "agent-new",
    workspaceId: "wks_1",
  });

  assert.deepEqual(res.clearCardIds, ["ws-wks_1"]);
});

test("findMatchingTurnBeforeCards preserves another agent's active decisionProposal", () => {
  const metaMap: Record<string, ItemUserMeta> = {
    "oncall-1": {
      boundWorkspaceId: "wks_1",
      boundAgentId: "agent-a",
      needsMeTag: "decision",
      needsMeTagLocked: true,
      needsMeTagAgentId: "agent-a",
      decisionProposal: {
        title: "回复线程",
        target: "#oncall",
        impact: null,
        draft: "已修复",
        agentId: "agent-a",
        updatedAt: "2026-11-18T07:00:00.000Z",
      },
    },
  };

  const fromOther = findMatchingTurnBeforeCards(metaMap, {
    id: "agent-b",
    workspaceId: "wks_1",
  });
  assert.deepEqual(fromOther.inScopeCardIds, ["ws-wks_1", "oncall-1"]);
  assert.deepEqual(fromOther.clearCardIds, []);

  const fromOwner = findMatchingTurnBeforeCards(metaMap, {
    id: "agent-a",
    workspaceId: "wks_1",
  });
  assert.deepEqual(fromOwner.clearCardIds, ["oncall-1"]);
});

test("findUserReplyAfterTag clears ready_to_archive when user replied after tag was set", () => {
  const meta: ItemUserMeta = {
    needsMeTag: "ready_to_archive",
    needsMeTagLocked: true,
    needsMeTagAgentId: "agent-1",
    needsMeTagUpdatedAt: "2026-11-18T07:40:00.000Z",
  };

  assert.equal(
    findUserReplyAfterTag(meta, [{ id: "agent-1", lastUserMessageAt: "2026-11-18T07:39:00.000Z" }]),
    null,
  );

  assert.deepEqual(
    findUserReplyAfterTag(meta, [
      { id: "agent-1", lastUserMessageAt: "2026-11-18T07:39:00.000Z" },
      { id: "agent-2", lastUserMessageAt: "2026-11-18T07:41:00.000Z" },
    ]),
    { clearedAt: "2026-11-18T07:41:00.000Z" },
  );
});

test("stale summary and backfill guards prevent restoring old ready_to_archive after user reply", () => {
  const clearedPatch = buildClearedNeedsMeTagPatch("2026-11-18T07:41:00.000Z");
  const clearedMeta: ItemUserMeta = {
    prepSummary: "已完成并提交",
    prepSummarySig: "agent-1:abc123",
    ...clearedPatch,
  };

  assert.equal(clearedMeta.needsMeTag, null);
  assert.equal(clearedMeta.needsMeTagLocked, false);
  assert.equal(shouldSkipStaleSummaryWrite(clearedMeta, "2026-11-18T07:40:59.000Z"), true);
  assert.equal(shouldSkipStaleSummaryWrite(clearedMeta, "2026-11-18T07:41:01.000Z"), false);

  assert.equal(shouldSkipBackfillAfterUserClear(clearedMeta, "agent-1:abc123", false), true);
  assert.equal(shouldSkipBackfillAfterUserClear(clearedMeta, "agent-1:new456", true), true);
  assert.equal(shouldSkipBackfillAfterUserClear(clearedMeta, "agent-1:new456", false), false);
});

test("readDigestFromJsonl marks hasUnansweredUserMessage when trailing message is from user", async () => {
  const dir = await mkdtemp(join(tmpdir(), "radar-digest-"));
  try {
    const file = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "修复一下" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "已完成修复并验证" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "我测试还是有问题" } }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const unanswered = await readDigestFromJsonl(file);
    assert.equal(unanswered.hasUnansweredUserMessage, true);
    assert.equal(unanswered.latestAssistantReply, "已完成修复并验证");

    await writeFile(
      file,
      [
        ...lines,
        JSON.stringify({ type: "message", message: { role: "assistant", content: "我再来排查下" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    const answered = await readDigestFromJsonl(file);
    assert.equal(answered.hasUnansweredUserMessage, false);
    assert.equal(answered.latestAssistantReply, "我再来排查下");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildConversationDigestFromTimeline detects unanswered user_message even with trailing error or tool_call", () => {
  const emptyDisk = {
    firstUserMessage: "",
    recentUserMessages: [],
    latestAssistantReply: "",
    hasUnansweredUserMessage: false,
  };

  const pendingDigest = buildConversationDigestFromTimeline(
    [
      { item: { type: "user_message", text: "第一轮" } },
      { item: { type: "assistant_message", text: "第一轮回复" } },
      { item: { type: "user_message", text: "第二轮追问" } },
      { item: { type: "error", text: "turn failed" } },
    ],
    emptyDisk,
  );
  assert.equal(pendingDigest.hasUnansweredUserMessage, true);
  assert.equal(pendingDigest.latestAssistantReply, "第一轮回复");

  const repliedDigest = buildConversationDigestFromTimeline(
    [
      { item: { type: "user_message", text: "第一轮" } },
      { item: { type: "assistant_message", text: "第一轮回复" } },
      { item: { type: "user_message", text: "第二轮追问" } },
      { item: { type: "assistant_message", text: "第二轮回复" } },
    ],
    emptyDisk,
  );
  assert.equal(repliedDigest.hasUnansweredUserMessage, false);
  assert.equal(repliedDigest.latestAssistantReply, "第二轮回复");
});

test("hasUnmergedMrActivity detects unmerged MR creation/update and allows merged or explicit-only requests", () => {
  assert.equal(
    hasUnmergedMrActivity(
      "已按 ci: 修正提交并强推，MR !18293 标题同步更新，提审动作完成。",
      "接口测试失败告警改为 #backend",
    ),
    true,
  );
  assert.equal(
    hasUnmergedMrActivity(
      "已创建 MR !18293 并推送代码，等待流水线和 Review。",
      "接口测试失败告警改为 #backend",
    ),
    true,
  );
  assert.equal(
    hasUnmergedMrActivity(
      "MR !18293 已合并，流水线通过。",
      "接口测试失败告警改为 #backend",
    ),
    false,
  );
  assert.equal(
    hasUnmergedMrActivity(
      "已创建 MR !18293。",
      "帮我改完只提 MR 即可，不用管合并",
    ),
    false,
  );
  assert.equal(
    hasUnmergedMrActivity("用户仅要求提 MR，已创建 MR !18293 并通过本地单测"),
    false,
  );
});

test("hasUnexecutedDocOrProposalActivity detects proposal/RFC/文档 doc updates without execution", () => {
  assert.equal(
    hasUnexecutedDocOrProposalActivity(
      "精简版方案文档已覆盖同步至 协作文档，内容就绪，暂无待执行动作。",
      "按RFC规范重写优化调度文档",
    ),
    true,
  );
  assert.equal(
    hasUnexecutedDocOrProposalActivity(
      "RFC 文档已起草并同步到 文档",
      "调研并输出优化调度方案",
    ),
    true,
  );
  assert.equal(
    hasUnexecutedDocOrProposalActivity(
      "方案已落地并完成单测，相关代码已提交 commit",
      "优化调度",
    ),
    false,
  );
  assert.equal(
    hasUnexecutedDocOrProposalActivity(
      "方案文档已同步至 文档",
      "只需写完文档即可，不用开发",
    ),
    false,
  );
});
