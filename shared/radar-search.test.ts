import assert from "node:assert/strict";
import test from "node:test";

import type { RadarItem } from "./radar.ts";
import { filterRadarItems, parseRadarSearchTokens } from "./radar-search.ts";

function makeItem(overrides: Partial<RadarItem> = {}): RadarItem {
  return {
    id: "item-1",
    source: "gitlab",
    group: "todo",
    badge: "MR !42",
    title: "Fix OAuth token refresh race",
    summary: "Handles concurrent 401 retries cleanly.",
    url: "https://gitlab.example.com/org/repo/-/merge_requests/42",
    secondaryUrl: null,
    links: [],
    updatedAt: "2026-11-17T00:00:00.000Z",
    stateHash: "hash-1",
    projectId: "proj-1",
    projectName: "auth-service",
    selectedModel: "claude-sonnet",
    status: "pool",
    needsMeTag: null,
    decisionProposal: null,
    needsWorktree: true,
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
    workspace: null,
    ...overrides,
  };
}

test("parseRadarSearchTokens splits and normalizes whitespace", () => {
  assert.deepEqual(parseRadarSearchTokens("   "), []);
  assert.deepEqual(parseRadarSearchTokens("  GitLab   OAuth "), ["gitlab", "oauth"]);
});

test("filterRadarItems matches across title, summary, source, links, workspace, and proposals", () => {
  const items: RadarItem[] = [
    makeItem({
      id: "gitlab-42",
      title: "Fix OAuth token refresh race",
      source: "gitlab",
      projectName: "auth-service",
    }),
    makeItem({
      id: "linear-99",
      source: "linear",
      badge: "ENG-99",
      title: "Billing webhook idempotency",
      summary: "Prevent duplicate invoice charges",
      projectName: "billing",
      links: [
        {
          kind: "slack",
          label: "#inc-billing",
          url: "https://slack.com/archives/C123/p456",
        },
      ],
      workspace: {
        workspaceId: "ws-99",
        workspaceName: "billing-fix",
        cwd: "/Users/dev/billing",
        primaryAgentId: "agent-1",
        agentIds: ["agent-1"],
        sessions: [
          {
            id: "agent-1",
            title: "Investigate Stripe retries",
            status: "idle",
            model: "gpt-5",
            pendingPermissions: 0,
            updatedAt: "2026-11-17T00:00:00.000Z",
          },
        ],
        agentStatus: "idle",
        pendingPermissions: 0,
        updatedAt: "2026-11-17T00:00:00.000Z",
        prepSummary: "Added idempotency key check",
        summarizing: false,
      },
    }),
    makeItem({
      id: "slack-7",
      source: "slack",
      badge: "DM",
      title: "Deploy window confirmation",
      summary: "Check with release team",
      projectName: null,
      decisionProposal: {
        title: "Reply in #release",
        target: "#release",
        impact: "Announce v2.1 rollout",
        draft: "Rolling out v2.1 at 18:00",
        agentId: null,
        updatedAt: null,
      },
    }),
  ];

  assert.equal(filterRadarItems(items, "").length, 3);
  assert.deepEqual(
    filterRadarItems(items, "gitlab oauth").map((i) => i.id),
    ["gitlab-42"],
  );
  assert.deepEqual(
    filterRadarItems(items, "stripe idempotency").map((i) => i.id),
    ["linear-99"],
  );
  assert.deepEqual(
    filterRadarItems(items, "#inc-billing").map((i) => i.id),
    ["linear-99"],
  );
  assert.deepEqual(
    filterRadarItems(items, "v2.1 rollout").map((i) => i.id),
    ["slack-7"],
  );
  assert.deepEqual(filterRadarItems(items, "nonexistent-token"), []);
});
