import assert from "node:assert/strict";
import test from "node:test";

import { classifyUrl, configureEntityRegistry, resetEntityRegistry, extractCanonicalEntityKeys, isDeterministicClaimEntityKey, mergeAttachedLinks, resolveItemLinks } from "./entity-keys.ts";

test("registered templates resolve text, branches, card IDs and canonical URLs", t => {
  t.after(resetEntityRegistry);
  configureEntityRegistry({ domainRules: {
    resourceLabels: { widgets: "组件" },
    linkMatchers: [{ flags: "i", urlRegex: "/manual/([^?#]+)", kind: "manual",
      labelTemplate: "指南", entityKeyTemplate: "manual:$1_docslug",
      canonicalUrlTemplate: "https://example.test/manual/$1_lower", subIdTemplate: "$1_tail4" }],
    entityTemplates: [{ entityPrefix: "manual", tokenRegex: "Guide:(\\w+)", branchTokenRegex: "^guide/(.+)",
      cardIdRegex: "^guide-(.+)", keyTemplate: "$1_lower", urlTemplate: "https://example.test/manual/$1_lower",
      kind: "manual", labelTemplate: "$1_upper", deterministicLiveClaim: true }],
  } });
  const url = "https://example.test/manual/New--ABCD?view=1";
  assert.equal(classifyUrl(url)?.dedupeKey, "manual:abcd");
  assert.equal(classifyUrl(url)?.subId, "ABCD");
  assert.equal(classifyUrl(url)?.url, "https://example.test/manual/new--abcd");
  assert.equal(classifyUrl("https://example.test/widgets/123", true)?.baseLabel, "组件 · 123");
  assert.deepEqual(extractCanonicalEntityKeys({ url, title: "Guide:Alpha", branchHint: "guide/Beta", cardId: "guide-Gamma" }),
    new Set(["manual:abcd", "manual:alpha", "manual:beta", "manual:gamma"]));
  assert.equal(resolveItemLinks({ title: "Guide:Alpha" })[0]?.label, "ALPHA");
  assert.ok(isDeterministicClaimEntityKey("manual:abc"));
  resetEntityRegistry();
  assert.equal(classifyUrl(url), null);
  assert.equal(isDeterministicClaimEntityKey("manual:abc"), false);
  assert.ok(isDeterministicClaimEntityKey("mr:!123"));
});

test("machine hashes do not override structured labels", () => {
  assert.equal(mergeAttachedLinks([{ url: "https://gitlab.example.org/org/repo/-/merge_requests/12",
    label: "b793bec6c0d8b4f909b221ac91c6c52612186a39" }])[0]?.label, "repo!12");
});

test("classifyUrl and mergeAttachedLinks derive semantic labels instead of '链接 1 / 链接 2'", () => {
  const merged = mergeAttachedLinks([
    {
      url: "https://assets.example.org/alerts/12061593151132800551",
      label: "链接",
    },
    {
      url: "https://assets.example.org/docs/1305128514153437080",
      label: "链接 2",
    },
    {
      url: "https://ops.example.com/api/v2/batch-jobs/99887766/details",
    },
    {
      url: "https://ops.example.com/",
    },
  ]);

  assert.deepEqual(
    merged.map((l) => l.label),
    ["告警 · 0551", "文档 · 7080", "batch-jobs · 7766", "ops.example.com"],
  );
});

test("finalizeCandidates distinguishes multiple CI links by pipeline/job id", () => {
  const merged = mergeAttachedLinks([
    { url: "https://gitlab.example.com/org/repo/-/pipelines/9812345" },
    { url: "https://gitlab.example.com/org/repo/-/jobs/6754321" },
  ]);
  assert.deepEqual(
    merged.map((l) => l.label),
    ["CI · 2345", "CI · 4321"],
  );
});

test("resolveItemLinks enriches derived labels from card context while preserving explicit labels", () => {
  const links = resolveItemLinks({
    title: "需要核验任务记录",
    summary: "相应任务链接https://assets.example.org/tasks/1299",
    labelContext: "文档1305128514153437080的9件原始明细已核验准确；后台导出入口：https://ops.example.com/export",
    links: [
      { kind: "link", label: "链接", url: "https://assets.example.org/custom-route/1305128514153437080" },
      { kind: "link", label: "链接", url: "https://assets.example.org/tasks/1299" },
      { kind: "link", label: "链接", url: "https://ops.example.com/export" },
      { kind: "link", label: "人工指定名称", url: "https://ops.example.com/other/1234567" },
    ],
  });

  assert.deepEqual(
    links.map((l) => l.label),
    ["文档 · 7080", "任务 · 1299", "后台导出", "人工指定名称"],
  );
});
