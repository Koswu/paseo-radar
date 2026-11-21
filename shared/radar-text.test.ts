import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanCardSubtitleText,
  cleanDecisionProposalFields,
  dedupeSummaryWithTitle,
} from "./radar-text.ts";

test("dedupeSummaryWithTitle removes leading and safe inline ticket IDs already in title", () => {
  assert.equal(
    dedupeSummaryWithTitle(
      "ENG-314 核查发现旧回调仍有流量，MR!42 暂不能关闭。",
      "ENG-314 迁移构建回调地址",
    ),
    "核查发现旧回调仍有流量，MR!42 暂不能关闭。",
  );

  assert.equal(
    dedupeSummaryWithTitle(
      "已完成 ENG-101 预研，整理了构建配置清单",
      "ENG-101 整理构建配置",
    ),
    "已完成预研，整理了构建配置清单",
  );
});

test("dedupeSummaryWithTitle preserves prepositional references and non-title MR IDs", () => {
  assert.equal(
    dedupeSummaryWithTitle(
      "MR !43 修复已提交且 CI 通过，仍为 Draft，待 review 确认后合并。",
      "跟进构建失败",
    ),
    "MR !43 修复已提交且 CI 通过，仍为 Draft，待 review 确认后合并。",
  );

  assert.equal(
    dedupeSummaryWithTitle(
      "针对 ENG-101 的配置已核查完成",
      "ENG-101 整理构建配置",
    ),
    "针对 ENG-101 的配置已核查完成",
  );
});

test("cleanCardSubtitleText strips merged-MR boilerplate and raw snippets when prepSummary exists", () => {
  assert.equal(
    cleanCardSubtitleText(
      "Linear",
      "ENG-314 迁移构建回调地址",
      "In Progress · High · 构建可靠性 · Cycle 18 · 关联 MR 已合并，待核验线上效果后收尾关单",
      "Example",
      "linear",
      true,
    ),
    "In Progress · High · 构建可靠性 · Cycle 18",
  );

  assert.equal(
    cleanCardSubtitleText(
      "Slack",
      "跟进构建失败",
      "构建失败，详情链接 https://example.com/jobs/1299",
      "Example",
      "external",
      true,
      "incident",
    ),
    "",
  );

  assert.equal(
    cleanCardSubtitleText(
      "Slack",
      "跟进构建失败",
      "构建已恢复，链接 https://example.com/jobs/123",
      "Example",
      "slack",
      false,
    ),
    "构建已恢复"
  );
});

test("cleanDecisionProposalFields strips hex hashes, note IDs, and redundant target", () => {
  assert.deepEqual(
    cleanDecisionProposalFields(
      "GitLab MR !42 discussion 0123456789abcdef0123456789abcdef01234567",
      "在 GitLab MR !42 的讨论串 0123456789abcdef0123456789abcdef01234567（note 324650 下）追加精确引用位置说明；不改代码或生产数据。",
    ),
    {
      target: null,
      impact: "在 GitLab MR !42 的讨论串追加精确引用位置说明；不改代码或生产数据。",
    },
  );

  assert.deepEqual(
    cleanDecisionProposalFields(
      "GitLab MR !42 discussion 0123456789abcdef0123456789abcdef01234567",
      "仅追加说明，不改代码。",
    ),
    {
      target: "GitLab MR !42 讨论串",
      impact: "仅追加说明，不改代码。",
    },
  );

  assert.deepEqual(
    cleanDecisionProposalFields("#oncall-bot (thread_ts: 1731900123.456789)", null),
    {
      target: "#oncall-bot",
      impact: null,
    },
  );
});
