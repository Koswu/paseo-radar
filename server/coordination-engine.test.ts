import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BoardWatchSpec } from "../shared/coordination.ts";
import type { WaitMode } from "../shared/radar-primitives.ts";
import {
  decodeSubcardWaitKey,
  encodeSubcardWaitKey,
  RadarCoordinationEngine,
  type CoordinationEngineDeps,
} from "./coordination-engine.ts";
import {
  computeCoordinationSummary,
  computeTopologicalWaves,
  detectBoardWatchCycle,
  evaluateBoardWatch,
  formatReferenceManifestPrompt,
  sanitizeBoardCardId,
} from "./coordination-graph.ts";
import {
  appendCoordEvent,
  countCoordEvents,
  ensureCoordBoardDirs,
  ensureSubcardOutputDir,
  readBoardArtifactContent,
  readCoordBoard,
  readCoordEvents,
  sanitizeSubcardDirName,
  scanDirectoryArtifacts,
  subcardOutputDirPath,
  updateCoordBoard,
} from "./coordination-store.ts";
import {
  classifyWaitScriptFailure,
  hasWaitPendingExitCode,
  matchesCron5InTimeZone,
  minuteSlotInTimeZone,
  parseCron5,
  parseMaxTimeoutMs,
  resolveEffectiveTimeZone,
  WAIT_SCRIPT_RETRY_BACKOFF_MS,
} from "./wait-utils.ts";

interface FakeParentCard {
  cardId: string;
  title: string;
  coordinationEnabled: boolean;
  boundWorkspaceId: string | null;
  boundAgentId: string | null;
  cwd: string | null;
  waitMode: WaitMode | null;
  waitBoard: BoardWatchSpec | null;
  subcardWorkspaceIds: string[];
}

function createTestHarness(rootDir: string, initialBeta = true) {
  let betaEnabled = initialBeta;
  let seq = 0;
  let dirtyFiles: string[] = [];
  let verifyShouldPass = true;
  let scriptExecShouldPass = false;
  let failSubcardId: string | null = null;
  let markCoordRunningOnSend = false;
  let onSendAgentMessage: ((agentId: string, prompt: string) => Promise<void> | void) | null = null;

  const parents = new Map<string, FakeParentCard>([
    [
      "card-1",
      {
        cardId: "card-1",
        title: "Fix checkout timeout",
        coordinationEnabled: false,
        boundWorkspaceId: "ws-parent",
        boundAgentId: "ag-coord",
        cwd: rootDir,
        waitMode: null,
        waitBoard: null,
        subcardWorkspaceIds: [],
      },
    ],
  ]);

  const coordinatorPrompts: Array<{ cardId: string; agentId: string | null; prompt: string }> = [];
  const agentMessages: Array<{ agentId: string; prompt: string }> = [];
  const createdSessions: Array<{ subcardId: string; isolation: string; prompt: string; agentId: string }> = [];
  const archivedAgents: string[] = [];
  const archivedWorkspaces: string[] = [];
  const createdSchedules: string[] = [];
  const deletedSchedules: string[] = [];
  const agentStatusMap = new Map<string, string>([["ag-coord", "idle"]]);

  const boardsDir = join(rootDir, "boards");
  const scriptsDir = join(rootDir, "wait-scripts");
  const checksDir = join(rootDir, "wait-checks");

  const deps: CoordinationEngineDeps = {
    boardsRootDir: () => boardsDir,
    waitScriptsDir: () => scriptsDir,
    waitChecksDir: () => checksDir,
    debounceMs: 0,
    graph: {
      sanitizeBoardCardId,
      detectBoardWatchCycle,
      evaluateBoardWatch,
      computeTopologicalWaves,
      computeCoordinationSummary,
      formatReferenceManifestPrompt,
    },
    store: {
      sanitizeSubcardDirName,
      subcardOutputDirPath,
      ensureCoordBoardDirs,
      ensureSubcardOutputDir,
      readCoordBoard,
      updateCoordBoard,
      appendCoordEvent,
      readCoordEvents,
      countCoordEvents,
      scanDirectoryArtifacts,
      readBoardArtifactContent,
    },
    waitUtils: {
      parseCron5,
      parseMaxTimeoutMs,
      resolveEffectiveTimeZone,
      hasWaitPendingExitCode,
      classifyWaitScriptFailure,
      matchesCron5InTimeZone,
      minuteSlotInTimeZone,
      waitScriptRetryBackoffMs: WAIT_SCRIPT_RETRY_BACKOFF_MS,
    },
    gates: {
      validateReadyToArchiveEvidence: (evidence) => {
        const text = (evidence ?? "").trim();
        if (!text || text.length < 4 || text === "ok" || text === "done") {
          return "拒绝：需要具体的 closureEvidence";
        }
        return null;
      },
      findUncommittedSessionChanges: async () =>
        dirtyFiles.length > 0 ? { repoRoot: rootDir, branch: "radar-sub/f1", dirtyFiles } : null,
      getGitBaselineForScope: async () => undefined,
      execShellCommand: async (command) => {
        if (command.startsWith("bash ")) {
          return scriptExecShouldPass
            ? { ok: true, stdout: "CI passed", stderr: "", exitCode: 0, timedOut: false }
            : { ok: false, stdout: "waiting...", stderr: "", exitCode: 10, timedOut: false };
        }
        return verifyShouldPass
          ? { ok: true, stdout: "all tests passed", stderr: "", exitCode: 0, timedOut: false }
          : { ok: false, stdout: "", stderr: "AssertionError: test failed", exitCode: 1, timedOut: false };
      },
      captureGitBranchAndSha: async () => ({ branch: "radar-sub/f1", sha: "deadbee" }),
      mergeAttachedLinks: (incoming, existing = []) => [
        ...existing,
        ...incoming.map((l) => ({ kind: l.kind ?? "link", label: l.label ?? l.url, url: l.url })),
      ],
    },
    radar: {
      isCoordinationBetaEnabled: async () => betaEnabled,
      getEffectiveTimezone: async () => "UTC",
      getDefaultWorkerModel: async () => ({
        defaultModel: "codex/gpt-5",
        assignable: [
          { id: "sol", name: "Sol", model: "pi/openai/gpt-6.2-sol", description: "Code review" },
        ],
        extraProfiles: [
          {
            id: "fast",
            name: "快速实现",
            model: "pi/opencode-go/deepseek-v4.1-flash",
            notes: "Lightweight fast model",
          },
        ],
      }),
      listWaitEvalModels: async () => ["codex/gpt-5-mini"],
      getParentCardContext: async (cardId) => {
        const p = parents.get(cardId);
        if (!p) return null;
        return {
          cardId: p.cardId,
          title: p.title,
          coordinationEnabled: p.coordinationEnabled,
          boundWorkspaceId: p.boundWorkspaceId,
          boundAgentId: p.boundAgentId,
          project: { projectId: "proj-1", name: "app", kind: "git", path: rootDir },
          cwd: p.cwd,
          waitMode: p.waitMode,
          waitBoard: p.waitBoard,
        };
      },
      listEnabledParentCardIds: async () =>
        [...parents.values()].filter((p) => p.coordinationEnabled).map((p) => p.cardId),
      setParentCoordinationMeta: async (cardId, patch) => {
        const p = parents.get(cardId);
        if (!p) return;
        if (patch.coordinationEnabled !== undefined) p.coordinationEnabled = patch.coordinationEnabled;
        if (patch.addSubcardWorkspaceId) p.subcardWorkspaceIds.push(patch.addSubcardWorkspaceId);
        if (patch.clearParentWait) {
          p.waitMode = null;
          p.waitBoard = null;
        }
      },
      buildCoordinatorSystemPrompt: () => "# Coordinator",
      sendCoordinatorPrompt: async (cardId, agentId, prompt) => {
        if (markCoordRunningOnSend && agentId) {
          agentStatusMap.set(agentId, "running");
        }
        coordinatorPrompts.push({ cardId, agentId, prompt });
        return true;
      },
      getAgentSnapshot: async (agentId) => ({
        id: agentId,
        workspaceId: "ws-parent",
        cwd: rootDir,
        status: agentStatusMap.get(agentId) ?? "idle",
        archivedAt: null,
        labels: {},
      }),
      sendAgentMessage: async (agentId, prompt) => {
        if (onSendAgentMessage) {
          await onSendAgentMessage(agentId, prompt);
        }
        agentMessages.push({ agentId, prompt });
      },
      archiveAgent: async (agentId) => {
        archivedAgents.push(agentId);
      },
      archiveWorkspace: async (wsId) => {
        archivedWorkspaces.push(wsId);
      },
      createSubcardSession: async (params) => {
        if (failSubcardId === params.subcardId) {
          throw new Error("Base branch cannot be HEAD when creating a Paseo worktree");
        }
        seq += 1;
        const agentId = `ag-${params.subcardId}-${seq}`;
        const workspaceId = params.isolation === "worktree" ? `ws-${params.subcardId}-${seq}` : "ws-parent";
        agentStatusMap.set(agentId, "running");
        createdSessions.push({
          subcardId: params.subcardId,
          isolation: params.isolation,
          prompt: params.prompt,
          agentId,
        });
        return {
          workspaceId,
          agentId,
          gitBranch: params.isolation === "worktree" ? `radar-sub/${params.subcardId}` : null,
          resolvedModel:
            params.selectedModel === "Sol"
              ? "pi/openai/gpt-6.2-sol"
              : params.selectedModel || "codex/gpt-5",
        };
      },
      createAiWaitSchedule: async () => {
        seq += 1;
        const scheduleId = `sched-${seq}`;
        createdSchedules.push(scheduleId);
        return { scheduleId };
      },
      deleteWaitSchedule: async (id) => {
        if (id) deletedSchedules.push(id);
      },
      deleteWaitScript: async () => {},
      readAgentTailReply: async () => "Turn finished without tool",
    },
  };

  return {
    engine: new RadarCoordinationEngine(deps),
    parents,
    coordinatorPrompts,
    agentMessages,
    createdSessions,
    archivedAgents,
    archivedWorkspaces,
    createdSchedules,
    deletedSchedules,
    agentStatusMap,
    setBeta: (v: boolean) => {
      betaEnabled = v;
    },
    setDirtyFiles: (files: string[]) => {
      dirtyFiles = files;
    },
    setVerifyPass: (v: boolean) => {
      verifyShouldPass = v;
    },
    setScriptPass: (v: boolean) => {
      scriptExecShouldPass = v;
    },
    setFailSubcardId: (id: string | null) => {
      failSubcardId = id;
    },
    setMarkCoordRunningOnSend: (v: boolean) => {
      markCoordRunningOnSend = v;
    },
    setOnSendAgentMessage: (fn: ((agentId: string, prompt: string) => Promise<void> | void) | null) => {
      onSendAgentMessage = fn;
    },
  };
}

test("beta flag gates coordination enabling and planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-beta-"));
  try {
    const h = createTestHarness(root, false);
    await assert.rejects(() => h.engine.toggleCoordination({ cardId: "card-1", enabled: true }));
    const blockedPlan = await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [{ id: "S1", title: "Scout", objective: "Check logs" }],
    });
    assert.equal(blockedPlan.isError, true);

    h.setBeta(true);
    const res = await h.engine.toggleCoordination({ cardId: "card-1", enabled: true });
    assert.equal(res.enabled, true);
    assert.equal(h.coordinatorPrompts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static DAG A -> B triggers B automatically with 0 coordinator wakeups", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-static-"));
  try {
    const h = createTestHarness(root, true);
    const planRes = await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        { id: "A", title: "Backend", objective: "Implement endpoint", isolation: "worktree" },
        {
          id: "B",
          title: "Merge & verify",
          objective: "Merge and test",
          isolation: "worktree",
          refCards: ["A"],
          waitBoard: { targets: [{ cardId: "A", status: "archived" }] },
        },
      ],
    });
    assert.notEqual(planRes.isError, true);
    assert.equal(h.createdSessions.length, 1);
    assert.equal(h.createdSessions[0]!.subcardId, "A");

    // Simulate A writing a large artifact in its own output dir (should NOT be inlined into B!)
    const outDirA = await ensureSubcardOutputDir(h.engine.boardDirForCard("card-1"), "A");
    await writeFile(join(outDirA, "api-notes.md"), "SECRET_FULL_BODY_DO_NOT_INLINE", "utf8");

    // Parent unfinished subcards gate rejects while A & B remain active
    assert.equal((await h.engine.getUnfinishedSubcardsForGate("card-1")).length, 2);

    // Complete A -> passes gates, self-archives, triggers B, 0 coordinator wakeups!
    const compA = await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "A",
      callerAgent: { id: h.createdSessions[0]!.agentId, workspaceId: "ws-A", cwd: root },
      closureEvidence: "Implemented /checkout fix and unit tests passed",
      artifactNotes: { "cards/A/api-notes.md": "Endpoint contract notes" },
    });
    assert.notEqual(compA.isError, true);
    assert.equal(h.coordinatorPrompts.length, 0);
    assert.equal(h.createdSessions.length, 2);
    assert.equal(h.createdSessions[1]!.subcardId, "B");
    // Pull-based manifest pointer included, full body NOT inlined!
    assert.ok(h.createdSessions[1]!.prompt.includes("api-notes.md"));
    assert.ok(!h.createdSessions[1]!.prompt.includes("SECRET_FULL_BODY_DO_NOT_INLINE"));
    // A's agent was archived, A's worktree workspace was preserved!
    assert.deepEqual(h.archivedAgents, [h.createdSessions[0]!.agentId]);
    assert.deepEqual(h.archivedWorkspaces, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic Wave 1 + coordinator wait(board) wakes coordinator once with batched manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-dyn-"));
  try {
    const h = createTestHarness(root, true);
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        { id: "S1", title: "Check DB", objective: "Inspect queries", isolation: "readonly" },
        { id: "S2", title: "Check logs", objective: "Inspect traces", isolation: "readonly" },
      ],
    });
    const parent = h.parents.get("card-1")!;
    parent.waitMode = "board";
    parent.waitBoard = {
      scope: "inner",
      parentCardId: "card-1",
      targets: [
        { cardId: "S1", status: "archived" },
        { cardId: "S2", status: "archived" },
      ],
      match: "all",
      wakeOnException: true,
    };

    // Finish S1: S2 still running -> coordinator stays asleep
    await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "S1",
      callerAgent: { id: h.createdSessions[0]!.agentId, workspaceId: "ws-parent", cwd: root },
      closureEvidence: "DB indexes are healthy",
    });
    assert.equal(h.coordinatorPrompts.length, 0);

    // Finish S2: waitBoard satisfied -> coordinator wakes ONCE with both S1 and S2!
    await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "S2",
      callerAgent: { id: h.createdSessions[1]!.agentId, workspaceId: "ws-parent", cwd: root },
      closureEvidence: "Found timeout spike in upstream gateway",
    });
    assert.equal(h.coordinatorPrompts.length, 1);
    const wakeMsg = h.coordinatorPrompts[0]!.prompt;
    assert.ok(wakeMsg.includes("S1"));
    assert.ok(wakeMsg.includes("S2"));
    assert.ok(wakeMsg.includes("2/2"));
    assert.equal(parent.waitMode, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("3 hard gates and requireReview=true behave deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-gates-"));
  try {
    const h = createTestHarness(root, true);
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        {
          id: "F1",
          title: "Code change",
          objective: "Fix bug",
          isolation: "worktree",
          verifyCommand: "npm test",
          requireReview: true,
        },
      ],
    });
    const agentId = h.createdSessions[0]!.agentId;

    // Gate 1: vague evidence
    const g1 = await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "F1",
      callerAgent: { id: agentId, workspaceId: "ws-F1", cwd: root },
      closureEvidence: "ok",
    });
    assert.equal(g1.isError, true);

    // Gate 2: uncommitted git
    h.setDirtyFiles(["src/index.ts"]);
    const g2 = await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "F1",
      callerAgent: { id: agentId, workspaceId: "ws-F1", cwd: root },
      closureEvidence: "Fixed bug and ran tests",
    });
    assert.equal(g2.isError, true);
    h.setDirtyFiles([]);

    // Gate 3: failing verifyCommand
    h.setVerifyPass(false);
    const g3 = await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "F1",
      callerAgent: { id: agentId, workspaceId: "ws-F1", cwd: root },
      closureEvidence: "Fixed bug and ran tests",
    });
    assert.equal(g3.isError, true);
    h.setVerifyPass(true);

    // Passes all gates -> requireReview=true stops at needs_me & wakes coordinator
    const okRes = await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "F1",
      callerAgent: { id: agentId, workspaceId: "ws-F1", cwd: root },
      closureEvidence: "Fixed bug and npm test passed",
    });
    assert.notEqual(okRes.isError, true);
    const detailBefore = await h.engine.getBoardDetail("card-1");
    assert.equal(detailBefore.board.subcards[0]!.status, "needs_me");
    assert.equal(detailBefore.board.subcards[0]!.needsMeTag, "ready_to_archive");
    assert.equal(h.coordinatorPrompts.length, 1);

    // Coordinator archives it
    await h.engine.coordinatorManage({
      parentCardId: "card-1",
      action: "archive",
      subcardId: "F1",
    });
    assert.equal((await h.engine.getUnfinishedSubcardsForGate("card-1")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controlled P2P handles inbox, live steer, and 4-round limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-p2p-"));
  try {
    const h = createTestHarness(root, true);
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        { id: "A", title: "Backend", objective: "API", isolation: "readonly" },
        { id: "B", title: "Frontend", objective: "UI", isolation: "readonly", startNow: false },
      ],
    });

    // Round 1: B is in pool -> queued to inbox
    const r1 = await h.engine.messagePeer({
      parentCardId: "card-1",
      fromSubcardId: "A",
      toSubcardId: "B",
      kind: "notify",
      message: "Use field user_id",
    });
    assert.notEqual(r1.isError, true);
    assert.ok(r1.text.includes("Inbox"));

    // Start B -> receives inbox message in initial prompt!
    await h.engine.startSubcard("card-1", "B");
    assert.ok(h.createdSessions[1]!.prompt.includes("Use field user_id"));

    // Rounds 2, 3, 4: B is running -> delivered live via sendAgentMessage
    for (let i = 2; i <= 4; i += 1) {
      const r = await h.engine.messagePeer({
        parentCardId: "card-1",
        fromSubcardId: "A",
        toSubcardId: "B",
        kind: "question",
        message: `Round ${i}`,
      });
      assert.notEqual(r.isError, true);
    }
    assert.equal(h.agentMessages.length, 3);

    // Round 5: rejected by 4-round cap!
    const r5 = await h.engine.messagePeer({
      parentCardId: "card-1",
      fromSubcardId: "B",
      toSubcardId: "A",
      kind: "question",
      message: "Round 5",
    });
    assert.equal(r5.isError, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subcard external script/ai waits and cancel propagation work cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-wait-"));
  await writeFile(join(root, ".keep"), "", "utf8");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "wait-scripts"), { recursive: true });
  mkdirSync(join(root, "wait-checks"), { recursive: true });

  try {
    const key = encodeSubcardWaitKey("gh:org/repo#42", "S1");
    assert.deepEqual(decodeSubcardWaitKey(key), { parentCardId: "gh:org/repo#42", subcardId: "S1" });

    const h = createTestHarness(root, true);
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        { id: "A", title: "Deploy & watch", objective: "Wait CI", isolation: "readonly" },
        {
          id: "B",
          title: "Post deploy",
          objective: "Smoke test",
          waitBoard: { targets: [{ cardId: "A", status: "archived" }] },
        },
      ],
    });
    const agentA = h.createdSessions[0]!.agentId;

    // Register script wait on A
    const wRes = await h.engine.enterSubcardWaiting({
      parentCardId: "card-1",
      subcardId: "A",
      callerAgentId: agentA,
      mode: "script",
      condition: "Wait CI",
      cron: "* * * * *",
      maxTimeout: "1h",
      script: "exit 10",
    });
    assert.notEqual(wRes.isError, true);

    // Script succeeds -> wakes subcard A directly, 0 coordinator wakeups
    h.setScriptPass(true);
    await h.engine.wakeSubcardFromWaiting("card-1", "A", "satisfied", "CI green");
    assert.equal(h.agentMessages.length, 1);
    assert.equal(h.agentMessages[0]!.agentId, agentA);
    assert.equal(h.coordinatorPrompts.length, 0);

    // Cancel A -> B becomes broken (needs_me) and wakes coordinator!
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      cancelIds: ["A"],
    });
    const detail = await h.engine.getBoardDetail("card-1");
    const cardB = detail.board.subcards.find((s) => s.id === "B")!;
    assert.equal(cardB.status, "needs_me");
    assert.equal(h.coordinatorPrompts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watcher auto-start failure wakes coordinator once without duplicate post-settle wakeup", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-esc-once-"));
  try {
    const h = createTestHarness(root, true);
    h.setFailSubcardId("F1");
    h.setMarkCoordRunningOnSend(true);

    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        { id: "S1", title: "Audit", objective: "Check", isolation: "readonly" },
        {
          id: "F1",
          title: "Commit fix",
          objective: "Edit README",
          isolation: "worktree",
          waitBoard: { targets: [{ cardId: "S1", status: "archived" }] },
        },
      ],
    });
    const parent = h.parents.get("card-1")!;
    parent.waitMode = "board";
    parent.waitBoard = {
      scope: "inner",
      parentCardId: "card-1",
      targets: [{ cardId: "F1", status: "archived" }],
      match: "all",
      wakeOnException: true,
    };

    const s1Agent = h.createdSessions[0]!.agentId;
    await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "S1",
      callerAgent: { id: s1Agent, workspaceId: "ws-parent", cwd: root },
      closureEvidence: "S1 audit complete",
    });

    // Escalation woke coordinator once; finishing its turn must NOT fire a duplicate S1 wakeup
    assert.equal(h.coordinatorPrompts.length, 1);
    assert.ok(h.coordinatorPrompts[0]!.prompt.includes("自动启动失败"));
    h.agentStatusMap.set("ag-coord", "idle");
    await h.engine.onCoordinatorTurnAfter("card-1");
    assert.equal(h.coordinatorPrompts.length, 1);

    // Retry F1 manually once base branch resolves cleanly
    h.setFailSubcardId(null);
    await h.engine.handleSubcardAction({
      cardId: "card-1",
      subcardId: "F1",
      action: "start",
      actor: "coordinator",
    });
    assert.equal(h.createdSessions.length, 2);
    assert.equal(h.createdSessions[1]!.subcardId, "F1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinatorManage(models) exposes roster and startSubcard persists resolvedModel", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-models-"));
  try {
    const h = createTestHarness(root, true);
    const modelsRes = await h.engine.coordinatorManage({
      parentCardId: "card-1",
      action: "models",
    });
    assert.notEqual(modelsRes.isError, true);
    const parsedModels = JSON.parse(modelsRes.text) as {
      defaultWorkerModel: string;
      assignableModels: Array<{ model: string }>;
      extraProfiles: Array<{ model: string }>;
    };
    assert.equal(parsedModels.defaultWorkerModel, "codex/gpt-5");
    assert.equal(parsedModels.assignableModels[0]!.model, "pi/openai/gpt-6.2-sol");
    assert.equal(parsedModels.extraProfiles[0]!.model, "pi/opencode-go/deepseek-v4.1-flash");

    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        {
          id: "S1",
          title: "Cross-provider task",
          objective: "Analyze repo",
          isolation: "readonly",
          selectedModel: "Sol",
        },
      ],
    });
    const detail = await h.engine.getBoardDetail("card-1");
    assert.equal(detail.board.subcards[0]!.selectedModel, "pi/openai/gpt-6.2-sol");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waking subcard preserves concurrent P2P fallback messages added to inbox in flight", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-inbox-race-"));
  try {
    const h = createTestHarness(root, true);
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        { id: "A", title: "Upstream", objective: "Produce signal", isolation: "readonly" },
        { id: "B", title: "Waiter", objective: "Wait A then act", isolation: "readonly" },
        { id: "C", title: "Peer", objective: "Message B", isolation: "readonly" },
      ],
    });

    const agA = h.createdSessions.find((s) => s.subcardId === "A")!.agentId;
    const agB = h.createdSessions.find((s) => s.subcardId === "B")!.agentId;

    // Put B into waiting_external on inner board for A -> archived
    await h.engine.enterSubcardWaiting({
      parentCardId: "card-1",
      subcardId: "B",
      callerAgentId: agB,
      mode: "board",
      watch: { targets: [{ cardId: "A", status: "archived" }], match: "all" },
    });

    // Queue an initial inbox message while B is waiting
    await h.engine.messagePeer({
      parentCardId: "card-1",
      fromSubcardId: "C",
      toSubcardId: "B",
      kind: "notify",
      message: "INITIAL_INBOX_MSG",
    });

    // While B is being woken, simulate a concurrent P2P steer error from C that falls back into B's inbox
    let injected = false;
    h.setOnSendAgentMessage(async (agentId, prompt) => {
      if (agentId === agB && prompt.includes("CONCURRENT_FALLBACK_MSG")) {
        throw new Error("transient steer failure");
      }
      if (agentId === agB && prompt.includes("所等待的看板前置条件已达成") && !injected) {
        injected = true;
        await h.engine.messagePeer({
          parentCardId: "card-1",
          fromSubcardId: "C",
          toSubcardId: "B",
          kind: "notify",
          message: "CONCURRENT_FALLBACK_MSG",
        });
      }
    });

    await h.engine.completeSubcard({
      parentCardId: "card-1",
      subcardId: "A",
      callerAgent: { id: agA, workspaceId: "ws-parent", cwd: root },
      closureEvidence: "Upstream signal ready",
    });

    assert.equal(injected, true);
    const wakeMsg = h.agentMessages.find((m) => m.agentId === agB);
    assert.ok(wakeMsg?.prompt.includes("INITIAL_INBOX_MSG"));

    const detail = await h.engine.getBoardDetail("card-1");
    const cardB = detail.board.subcards.find((s) => s.id === "B")!;
    assert.deepEqual(
      cardB.inbox.map((m) => m.message),
      ["CONCURRENT_FALLBACK_MSG"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("codemode hint is only included for pi provider subcards and peer messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-pi-hint-"));
  try {
    const h = createTestHarness(root, true);
    await h.engine.planSubcards({
      parentCardId: "card-1",
      callerAgentId: "ag-coord",
      create: [
        {
          id: "S_CODEX",
          title: "Codex subcard",
          objective: "Run on codex",
          isolation: "readonly",
          selectedModel: "codex/gpt-5",
          startNow: true,
        },
        {
          id: "S_PI",
          title: "Pi subcard",
          objective: "Run on pi",
          isolation: "readonly",
          selectedModel: "pi/openai/gpt-6.2-sol",
          startNow: true,
        },
      ],
    });

    const codexSession = h.createdSessions.find((s) => s.subcardId === "S_CODEX")!;
    const piSession = h.createdSessions.find((s) => s.subcardId === "S_PI")!;
    assert.equal(codexSession.prompt.includes("codemode"), false);
    assert.equal(codexSession.prompt.includes("mcp__paseo__"), false);
    assert.equal(piSession.prompt.includes("codemode"), true);
    assert.equal(piSession.prompt.includes("mcp__paseo__radar_complete_subcard"), true);

    await h.engine.messagePeer({
      parentCardId: "card-1",
      fromSubcardId: "S_PI",
      toSubcardId: "S_CODEX",
      kind: "question",
      message: "Ping codex",
    });
    await h.engine.messagePeer({
      parentCardId: "card-1",
      fromSubcardId: "S_CODEX",
      toSubcardId: "S_PI",
      kind: "notify",
      message: "Pong pi",
    });

    const toCodex = h.agentMessages.find((m) => m.agentId === codexSession.agentId)!;
    const toPi = h.agentMessages.find((m) => m.agentId === piSession.agentId)!;
    assert.equal(toCodex.prompt.includes("codemode"), false);
    assert.equal(toCodex.prompt.includes("mcp__paseo__"), false);
    assert.equal(toPi.prompt.includes("codemode"), true);
    assert.equal(toPi.prompt.includes("mcp__paseo__subradar_message_peer"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
