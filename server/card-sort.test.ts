import assert from "node:assert/strict";
import test from "node:test";

import type { RadarItem } from "../shared/radar.ts";
import { compareCards } from "./card-sort.ts";

function makeCard(overrides: Partial<RadarItem> = {}): RadarItem {
  return {
    id: "card-1",
    source: "workspace",
    group: "todo",
    badge: "会话",
    title: "Test card",
    summary: "Summary",
    url: null,
    secondaryUrl: null,
    links: [],
    updatedAt: "2026-11-18T00:00:00.000Z",
    stateHash: "hash-1",
    projectId: null,
    projectName: null,
    selectedModel: "",
    status: "needs_me",
    needsMeTag: "review",
    decisionProposal: null,
    needsWorktree: false,
    visibility: "active",
    snoozedUntil: null,
    waitMode: null,
    waitCondition: null,
    waitScheduleId: null,
    waitCron: null,
    waitTimeoutAt: null,
    waitCheckNote: null,
    lastWaitCheckAt: null,
    waitBoard: null,
    goal: null,
    coordination: null,
    workspace: {
      workspaceId: "ws-1",
      workspaceName: "ws-1",
      cwd: "/tmp/repo",
      primaryAgentId: "agent-1",
      agentIds: ["agent-1"],
      sessions: [],
      agentStatus: "idle",
      pendingPermissions: 0,
      updatedAt: "2026-11-18T00:00:00.000Z",
      prepSummary: null,
      summarizing: false,
    },
    ...overrides,
  };
}

test("compareCards ranks document requests and incidents independently of the provider name", () => {
  const pool = { source: "external", status: "pool", workspace: null } as const;
  const document = makeCard({ ...pool, id: "doc", archetype: "document", group: "urgent" });
  const code = makeCard({ ...pool, id: "code", archetype: "code_change", group: "urgent" });
  const incident = makeCard({ ...pool, id: "incident", archetype: "incident" });
  const ticket = makeCard({ ...pool, id: "ticket", archetype: "work_item", badge: "Urgent" });
  assert.deepEqual([ticket, code, incident, document].sort(compareCards).map(card => card.id),
    ["doc", "code", "incident", "ticket"]);
});

test("compareCards ranks document requests and incidents independently of the provider name", () => {
  const pool = { source: "external", status: "pool", workspace: null } as const;
  const document = makeCard({ ...pool, id: "doc", archetype: "document", group: "urgent" });
  const code = makeCard({ ...pool, id: "code", archetype: "code_change", group: "urgent" });
  const incident = makeCard({ ...pool, id: "incident", archetype: "incident" });
  const ticket = makeCard({ ...pool, id: "ticket", archetype: "work_item", badge: "Urgent" });
  assert.deepEqual([ticket, code, incident, document].sort(compareCards).map(card => card.id),
    ["doc", "code", "incident", "ticket"]);
});

test("compareCards sorts needs_me cards from oldest to newest", () => {
  const newestUrgent = makeCard({
    id: "newest-urgent",
    source: "gitlab",
    group: "urgent",
    updatedAt: "2026-11-18T12:00:00.000Z",
  });
  const middle = makeCard({
    id: "middle",
    source: "linear",
    updatedAt: "2026-11-17T12:00:00.000Z",
  });
  const oldestWorkspace = makeCard({
    id: "oldest-workspace",
    source: "workspace",
    updatedAt: "2026-11-16T12:00:00.000Z",
  });

  const sorted = [newestUrgent, middle, oldestWorkspace].sort(compareCards);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["oldest-workspace", "middle", "newest-urgent"],
  );
});

test("compareCards keeps priority rank and newest-first order for non-needs_me cards", () => {
  const poolOldUrgent = makeCard({
    id: "pool-old-urgent",
    status: "pool",
    source: "slack",
    group: "urgent",
    workspace: null,
    updatedAt: "2026-11-16T12:00:00.000Z",
  });
  const poolNewTodo = makeCard({
    id: "pool-new-todo",
    status: "pool",
    source: "linear",
    group: "todo",
    workspace: null,
    updatedAt: "2026-11-18T12:00:00.000Z",
  });
  const poolOlderTodo = makeCard({
    id: "pool-older-todo",
    status: "pool",
    source: "linear",
    group: "todo",
    workspace: null,
    updatedAt: "2026-11-17T12:00:00.000Z",
  });

  const sorted = [poolOlderTodo, poolNewTodo, poolOldUrgent].sort(compareCards);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["pool-old-urgent", "pool-new-todo", "pool-older-todo"],
  );
});
