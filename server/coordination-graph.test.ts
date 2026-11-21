import assert from "node:assert/strict";
import test from "node:test";

import type { BoardWatchSpec, CoordBoard, SubCard } from "../shared/coordination.ts";
import {
  computeCoordinationSummary,
  computeTopologicalWaves,
  detectBoardWatchCycle,
  evaluateBoardWatch,
  formatReferenceManifestPrompt,
  resolveSafeBoardPath,
  sanitizeBoardCardId,
} from "./coordination-graph.ts";

function makeSubcard(overrides: Partial<SubCard> & { id: string }): SubCard {
  const now = "2026-11-19T10:00:00.000Z";
  return {
    wave: 1,
    title: overrides.id,
    objective: `Do ${overrides.id}`,
    isolation: "readonly",
    selectedModel: null,
    refCards: [],
    requireReview: false,
    verifyCommand: null,
    status: "pool",
    needsMeTag: null,
    decisionProposal: null,
    waitMode: null,
    waitCondition: null,
    waitBoard: null,
    waitCron: null,
    waitScriptPath: null,
    waitScheduleId: null,
    waitStartedAt: null,
    waitTimeoutAt: null,
    waitMaxTimeoutLabel: null,
    waitCheckNote: null,
    lastWaitCheckAt: null,
    waitConsecutiveErrors: null,
    waitNextRetryAt: null,
    boundWorkspaceId: null,
    boundAgentId: null,
    gitBranch: null,
    commitSha: null,
    links: [],
    closureEvidence: null,
    artifacts: [],
    inbox: [],
    p2pRoundsByPeer: {},
    canceled: false,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

test("sanitizeBoardCardId preserves safe IDs and disambiguates special-char IDs", () => {
  assert.equal(sanitizeBoardCardId("ws-wks_123abc"), "ws-wks_123abc");
  const a = sanitizeBoardCardId("gh:org/repo#42");
  const b = sanitizeBoardCardId("gh:org-repo#42");
  assert.match(a, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(a, b);
  assert.equal(a, sanitizeBoardCardId("gh:org/repo#42"));
});

test("resolveSafeBoardPath permits internal relative paths and blocks traversal/escapes", () => {
  const base = "/tmp/boards/card-1";
  assert.equal(resolveSafeBoardPath(base, "cards/S1/report.md"), "/tmp/boards/card-1/cards/S1/report.md");
  assert.equal(resolveSafeBoardPath(base, "shared/spec.json"), "/tmp/boards/card-1/shared/spec.json");
  assert.equal(resolveSafeBoardPath(base, ""), null);
  assert.equal(resolveSafeBoardPath(base, "."), null);
  assert.equal(resolveSafeBoardPath(base, "../secret.json"), null);
  assert.equal(resolveSafeBoardPath(base, "cards/../../etc/passwd"), null);
  assert.equal(resolveSafeBoardPath(base, "/etc/passwd"), null);
  assert.equal(resolveSafeBoardPath(base, "cards/a\0b.txt"), null);
});

test("detectBoardWatchCycle catches self-loop, 2-cycle, 3-cycle, and permits diamond DAG", () => {
  const edges = new Map<string, string[]>([
    ["B", ["A"]],
    ["C", ["B"]],
  ]);
  assert.deepEqual(detectBoardWatchCycle(edges, "A", ["A"]), ["A", "A"]);
  assert.deepEqual(detectBoardWatchCycle(edges, "A", ["B"]), ["A", "B", "A"]);
  assert.deepEqual(detectBoardWatchCycle(edges, "A", ["C"]), ["A", "C", "B", "A"]);

  const diamond = new Map<string, string[]>([
    ["B", ["A"]],
    ["C", ["A"]],
  ]);
  assert.equal(detectBoardWatchCycle(diamond, "D", ["B", "C"]), null);
});

test("evaluateBoardWatch handles all/any matching, needsMeTag, and broken targets", () => {
  const stateMap = new Map([
    ["S1", { status: "archived" as const, needsMeTag: null, canceled: false }],
    ["S2", { status: "running" as const, needsMeTag: null, canceled: false }],
    ["S3", { status: "needs_me" as const, needsMeTag: "decision" as const, canceled: false }],
    ["S4", { status: "archived" as const, needsMeTag: null, canceled: true }],
  ]);
  const lookup = (id: string) => stateMap.get(id) ?? null;

  const allSpec: BoardWatchSpec = {
    scope: "inner",
    parentCardId: "p1",
    targets: [
      { cardId: "S1", status: "archived" },
      { cardId: "S2", status: "archived" },
    ],
    match: "all",
    wakeOnException: true,
  };
  assert.equal(evaluateBoardWatch(allSpec, lookup).state, "pending");

  const anySpec: BoardWatchSpec = { ...allSpec, match: "any" };
  const anyRes = evaluateBoardWatch(anySpec, lookup);
  assert.equal(anyRes.state, "satisfied");
  assert.deepEqual(anyRes.matchedIds, ["S1"]);

  const brokenAll: BoardWatchSpec = {
    ...allSpec,
    targets: [
      { cardId: "S1", status: "archived" },
      { cardId: "S4", status: "archived" },
    ],
  };
  assert.equal(evaluateBoardWatch(brokenAll, lookup).state, "broken");

  const tagSpec: BoardWatchSpec = {
    scope: "inner",
    parentCardId: "p1",
    targets: [{ cardId: "S3", status: "needs_me", needsMeTag: "decision" }],
    match: "all",
    wakeOnException: true,
  };
  assert.equal(evaluateBoardWatch(tagSpec, lookup).state, "satisfied");
});

test("computeTopologicalWaves orders dependent nodes into subsequent waves", () => {
  const s1 = makeSubcard({ id: "S1", wave: 1 });
  const s2 = makeSubcard({ id: "S2", wave: 1 });
  const f1 = makeSubcard({
    id: "F1",
    wave: 1,
    waitBoard: {
      scope: "inner",
      parentCardId: "p1",
      targets: [
        { cardId: "S1", status: "archived" },
        { cardId: "S2", status: "archived" },
      ],
      match: "all",
      wakeOnException: true,
    },
  });
  const m = makeSubcard({ id: "M", wave: 1, refCards: ["F1"] });

  const waves = computeTopologicalWaves([m, f1, s2, s1]);
  assert.deepEqual(waves, [
    { wave: 1, subcardIds: ["S2", "S1"] },
    { wave: 2, subcardIds: ["F1"] },
    { wave: 3, subcardIds: ["M"] },
  ]);
});

test("computeCoordinationSummary counts states and builds deterministic frontlineText", () => {
  const board: CoordBoard = {
    cardId: "c1",
    enabled: true,
    enabledAt: "2026-11-19T10:00:00.000Z",
    coordinatorAgentId: "ag-coord",
    boardDir: "/tmp/boards/c1",
    updatedAt: "2026-11-19T10:05:00.000Z",
    subcards: [
      makeSubcard({ id: "S1", status: "archived" }),
      makeSubcard({ id: "F1", status: "running" }),
      makeSubcard({ id: "F2", status: "waiting_external", waitMode: "script", waitCondition: "Wait CI" }),
      makeSubcard({ id: "M", status: "waiting_external", waitMode: "board" }),
      makeSubcard({ id: "OLD", status: "archived", canceled: true }),
    ],
  };

  const summary = computeCoordinationSummary(board, 7);
  assert.equal(summary.total, 4);
  assert.equal(summary.canceled, 1);
  assert.equal(summary.archived, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.waitingExternal, 1);
  assert.equal(summary.waitingBoard, 1);
  assert.equal(summary.eventCount, 7);
  assert.ok(summary.frontlineText?.includes("F1"));
});

test("computeCoordinationSummary.activeSubcardSessions keeps only uncanceled dual-bound subcards", () => {
  const bindings = { boundWorkspaceId: "ws-1", boundAgentId: "ag-1" };
  const board: CoordBoard = {
    cardId: "c1",
    enabled: true,
    enabledAt: "2026-11-19T10:00:00.000Z",
    coordinatorAgentId: "ag-coord",
    boardDir: "/tmp/boards/c1",
    updatedAt: "2026-11-19T10:05:00.000Z",
    subcards: [
      makeSubcard({ id: "bound", status: "needs_me", ...bindings }),
      makeSubcard({ id: "canceled", status: "running", canceled: true, ...bindings }),
      makeSubcard({ id: "agent-only", status: "running", boundAgentId: "ag-2" }),
      makeSubcard({ id: "workspace-only", status: "running", boundWorkspaceId: "ws-3" }),
    ],
  };

  assert.deepEqual(computeCoordinationSummary(board, 0).activeSubcardSessions, [
    { subcardId: "bound", title: "bound", status: "needs_me", workspaceId: "ws-1", agentId: "ag-1" },
  ]);
});

test("formatReferenceManifestPrompt emits pointers only without inlining large artifact contents", () => {
  const prompt = formatReferenceManifestPrompt({
    boardDir: "/tmp/boards/c1",
    subcardId: "F1",
    subcardOutputDir: "/tmp/boards/c1/cards/F1",
    upstreamCards: [
      {
        id: "S1",
        title: "Investigate timeout",
        status: "archived",
        closureEvidence: "Identified connection pool saturation in pool.ts",
        gitBranch: "radar-sub/s1",
        commitSha: "abc1234",
        links: [{ kind: "github", label: "PR #12", url: "https://github.com/org/repo/pull/12" }],
        artifacts: [
          {
            relativePath: "cards/S1/trace.log",
            absolutePath: "/tmp/boards/c1/cards/S1/trace.log",
            sizeBytes: 245760,
            note: "Full stack traces",
            updatedAt: "2026-11-19T10:01:00.000Z",
          },
        ],
      },
    ],
    inboxMessages: [
      { id: "m1", from: "S2", kind: "notify", message: "Check port 8080", at: "2026-11-19T10:02:00.000Z" },
    ],
    siblings: [
      { id: "F1", title: "Fix pool", status: "running", isolation: "worktree", gitBranch: "radar-sub/f1" },
      { id: "F2", title: "Add test", status: "pool", isolation: "worktree", gitBranch: null },
    ],
  });

  assert.ok(prompt.includes("/tmp/boards/c1/cards/S1/trace.log (240 KB) — Full stack traces"));
  assert.ok(prompt.includes("仅提供指针索引"));
  assert.ok(prompt.includes("Check port 8080"));
  assert.ok(prompt.includes("F2: Add test"));
  assert.ok(!prompt.includes("F1: Fix pool"));
});
