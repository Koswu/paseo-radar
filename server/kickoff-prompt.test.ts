import assert from "node:assert/strict";
import test from "node:test";
import type { RawScannedItem } from "./store";
import { buildKickoffPrompt, mergeItemContexts, mergeItemHints } from "./kickoff-prompt.ts";

const item: RawScannedItem = {
  id: "demo", source: "tracker", archetype: "incident", intent: "investigate", group: "todo",
  badge: "Open", title: "排查超时", summary: "请求未返回", updatedAt: "", stateHash: "v1", branchSlug: "demo",
  url: "https://example.org/tasks/1", prepPrompt: "旧准备", workPrompt: "旧执行", context: "首次发现", hint: "核对日志",
};

test("structured kickoff distinguishes read-only preparation and execution", () => {
  assert.match(buildKickoffPrompt("background", item), /只读准备/);
  const prompt = buildKickoffPrompt("immediate", item);
  for (const needle of ["开始处理", item.title, item.url, "定位问题", "[tracker] 首次发现", "核对日志"]) assert.ok(prompt.includes(needle));
  assert.ok(!prompt.includes(item.workPrompt));
});

test("absorbed context and hints retain provenance and survive repeated merges", () => {
  const secondary = { source: "chat", context: "已复现", hint: "检查超时阈值" };
  const merged = { ...item, contexts: mergeItemContexts(item, secondary), hint: mergeItemHints(item, secondary) };
  assert.deepEqual(mergeItemContexts(merged, secondary), merged.contexts);
  assert.equal(mergeItemHints(merged, secondary), merged.hint);
  const prompt = buildKickoffPrompt("background", merged);
  for (const needle of ["[tracker] 首次发现", "[chat] 已复现", "核对日志", "检查超时阈值"]) assert.equal(prompt.split(needle).length, 2);
});

test("custom and legacy items preserve mode-specific instructions", () => {
  assert.equal(buildKickoffPrompt("background", { ...item, source: "custom" }), item.prepPrompt);
  assert.equal(buildKickoffPrompt("immediate", { ...item, archetype: undefined, intent: undefined }), item.workPrompt);
});
