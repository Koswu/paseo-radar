import assert from "node:assert/strict";
import test from "node:test";

import type { RadarItem } from "../shared/radar.ts";
import {
  applyDeterministicAndCachedMerges,
  findMigratedSupersededItems,
  resolveWorkerTargetCard,
} from "./card-dedup.ts";
import {
  extractCanonicalEntityKeys,
  mergeRadarLinks,
  normalizeCardId,
  resolveItemLinks,
  setsIntersect,
} from "./entity-keys.ts";
import type { ItemUserMeta, RawScannedItem, TriageCacheEntry } from "./store.ts";

function makeRawItem(overrides: Partial<RawScannedItem> & { id: string }): RawScannedItem {
  return {
    source: "signal",
    group: "urgent",
    badge: "Signal",
    title: overrides.id,
    summary: "",
    url: `https://example.com/${overrides.id}`,
    secondaryUrl: null,
    links: [],
    updatedAt: "2026-11-18T05:00:00.000Z",
    stateHash: `hash-${overrides.id}`,
    branchSlug: overrides.id,
    prepPrompt: "prep",
    workPrompt: "work",
    ...overrides,
  };
}

function makeRadarCard(overrides: Partial<RadarItem> & { id: string }): RadarItem {
  return {
    source: "signal",
    group: "urgent",
    badge: "Signal",
    title: overrides.id,
    summary: "",
    url: null,
    secondaryUrl: null,
    links: [],
    updatedAt: "2026-11-18T05:00:00.000Z",
    stateHash: `hash-${overrides.id}`,
    projectId: null,
    projectName: null,
    selectedModel: "agy/gemini-4-hydrogen",
    status: "pool",
    needsMeTag: null,
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
    workspace: null,
    ...overrides,
  };
}

const dedupOps = {
  normalizeCardId,
  extractCanonicalEntityKeys,
  setsIntersect,
  resolveItemLinks,
  mergeSecondaryIntoPrimary(primary: RawScannedItem, secondary: RawScannedItem) {
    primary.links = mergeRadarLinks(primary.links, secondary.links);
    primary.entityKeys = [
      ...new Set([...(primary.entityKeys ?? []), ...(secondary.entityKeys ?? [])]),
    ];
    primary.relatedKeys = [
      ...new Set([...(primary.relatedKeys ?? []), ...(secondary.relatedKeys ?? [])]),
    ];
  },
};

test("applyDeterministicAndCachedMerges suppresses re-scanned donor listed in active card migratedFromIds", () => {
  const signal = makeRawItem({
    id: "signal-event47",
    url: "https://signals.example.org/events/event47",
    links: [
      {
        kind: "signal",
        label: "Signal",
        url: "https://signals.example.org/events/event47",
      },
    ],
  });
  const mr = makeRawItem({
    id: "gitlab-own-1-18256",
    source: "gitlab",
    group: "closing",
    badge: "MR",
    url: "https://gitlab.example.net/example/example/-/merge_requests/18256",
    links: [
      {
        kind: "gitlab",
        label: "!18256",
        url: "https://gitlab.example.net/example/example/-/merge_requests/18256",
      },
    ],
  });

  const itemById = new Map<string, RawScannedItem>([
    [mr.id, { ...mr }],
    [signal.id, { ...signal }],
  ]);
  const droppedOrMergedIds = new Set<string>();

  applyDeterministicAndCachedMerges({
    itemById,
    externalIds: new Set<string>(),
    droppedOrMergedIds,
    nextCache: {},
    meta: {
      "gitlab-own-1-18256": {
        customStatus: "needs_me",
        boundWorkspaceId: "wks_old",
        boundAgentId: "agent_old",
        migratedFromIds: ["signal-event47"],
      },
    },
    ops: dedupOps,
  });

  assert.deepEqual([...droppedOrMergedIds], ["signal-event47"]);
  assert.ok(itemById.get("gitlab-own-1-18256")!.links?.some((l) => l.url.includes("event47")));
});

test("applyDeterministicAndCachedMerges deterministically merges MR referenced by a live card prepSummary", () => {
  const signal = makeRawItem({
    id: "signal-event47",
    url: "https://signals.example.org/events/event47",
  });
  const mr = makeRawItem({
    id: "gitlab-own-1-18256",
    source: "gitlab",
    group: "closing",
    badge: "MR",
    url: "https://gitlab.example.net/example/example/-/merge_requests/18256",
    links: [
      {
        kind: "gitlab",
        label: "!18256",
        url: "https://gitlab.example.net/example/example/-/merge_requests/18256",
      },
    ],
  });

  const itemById = new Map<string, RawScannedItem>([
    [mr.id, { ...mr }],
    [signal.id, { ...signal }],
  ]);
  const droppedOrMergedIds = new Set<string>();

  const { absorbedDonorsByTarget } = applyDeterministicAndCachedMerges({
    itemById,
    externalIds: new Set<string>(),
    droppedOrMergedIds,
    nextCache: {},
    meta: {
      "signal-event47": {
        customStatus: "needs_me",
        boundWorkspaceId: "wks_live",
        boundAgentId: "agent_live",
        prepSummary: "已定位问题，修复 MR !18256 仍待解决2条评审讨论。",
      },
    },
    ops: dedupOps,
  });

  assert.deepEqual([...droppedOrMergedIds], ["gitlab-own-1-18256"]);
  assert.deepEqual(absorbedDonorsByTarget["signal-event47"], ["gitlab-own-1-18256"]);
  assert.ok(itemById.get("signal-event47")!.links?.some((l) => l.url.includes("merge_requests/18256")));
});

test("applyDeterministicAndCachedMerges lets bound card absorb unbound triage target instead of leaving duplicate in pool", () => {
  const signal = makeRawItem({
    id: "signal-event47",
    url: "https://signals.example.org/events/event47",
  });
  const mr = makeRawItem({
    id: "gitlab-own-1-18256",
    source: "gitlab",
    group: "closing",
    badge: "MR",
    url: "https://gitlab.example.net/example/example/-/merge_requests/18256",
  });

  const nextCache: Record<string, TriageCacheEntry> = {
    "signal-event47": { stateHash: signal.stateHash, action: "keep", triagedAt: "2026-11-18T00:00:00Z" },
    "gitlab-own-1-18256": {
      stateHash: mr.stateHash,
      action: "merge",
      mergeIntoId: "signal-event47",
      triagedAt: "2026-11-18T00:00:00Z",
    },
  };

  const itemById = new Map<string, RawScannedItem>([
    [mr.id, { ...mr }],
    [signal.id, { ...signal }],
  ]);
  const droppedOrMergedIds = new Set<string>();

  const { absorbedDonorsByTarget } = applyDeterministicAndCachedMerges({
    itemById,
    externalIds: new Set<string>(),
    droppedOrMergedIds,
    nextCache,
    meta: {
      "gitlab-own-1-18256": {
        customStatus: "needs_me",
        boundWorkspaceId: "wks_5e5a",
        boundAgentId: "agent_old",
      },
    },
    ops: dedupOps,
  });

  assert.deepEqual([...droppedOrMergedIds], ["signal-event47"]);
  assert.deepEqual(absorbedDonorsByTarget["gitlab-own-1-18256"], ["signal-event47"]);
});

test("applyDeterministicAndCachedMerges merges cards sharing the same boundWorkspaceId and keeps distinct live workspaces", () => {
  const cardA = makeRawItem({ id: "signal-1" });
  const cardB = makeRawItem({ id: "gitlab-1", source: "gitlab" });
  const cardC = makeRawItem({ id: "signal-2" });
  const cardD = makeRawItem({ id: "gitlab-2", source: "gitlab" });

  const nextCache: Record<string, TriageCacheEntry> = {
    "signal-1": { stateHash: cardA.stateHash, action: "keep", triagedAt: "2026-11-18T00:00:00Z" },
    "gitlab-1": {
      stateHash: cardB.stateHash,
      action: "merge",
      mergeIntoId: "signal-1",
      triagedAt: "2026-11-18T00:00:00Z",
    },
    "signal-2": { stateHash: cardC.stateHash, action: "keep", triagedAt: "2026-11-18T00:00:00Z" },
    "gitlab-2": {
      stateHash: cardD.stateHash,
      action: "merge",
      mergeIntoId: "signal-2",
      triagedAt: "2026-11-18T00:00:00Z",
    },
  };

  const itemById = new Map<string, RawScannedItem>([
    [cardA.id, { ...cardA }],
    [cardB.id, { ...cardB }],
    [cardC.id, { ...cardC }],
    [cardD.id, { ...cardD }],
  ]);
  const droppedOrMergedIds = new Set<string>();

  applyDeterministicAndCachedMerges({
    itemById,
    externalIds: new Set<string>(),
    droppedOrMergedIds,
    nextCache,
    meta: {
      "signal-1": { boundWorkspaceId: "wks_shared", boundAgentId: "a1" },
      "gitlab-1": { boundWorkspaceId: "wks_shared", boundAgentId: "a1" },
      "signal-2": { boundWorkspaceId: "wks_distinct_1", boundAgentId: "a2" },
      "gitlab-2": { boundWorkspaceId: "wks_distinct_2", boundAgentId: "a3" },
    },
    ops: dedupOps,
  });

  const remaining = [...itemById.keys()].filter((id) => !droppedOrMergedIds.has(id)).sort();
  assert.deepEqual(remaining, ["gitlab-2", "signal-1", "signal-2"]);
});

test("findMigratedSupersededItems suppresses migrated donors in loadSnapshot while carrying links", () => {
  const signal = makeRawItem({
    id: "signal-event47",
    url: "https://signals.example.org/events/event47",
  });
  const mr = makeRawItem({
    id: "gitlab-own-1-18256",
    source: "gitlab",
    url: "https://gitlab.example.net/example/example/-/merge_requests/18256",
  });

  const res = findMigratedSupersededItems({
    candidates: [signal, mr],
    activeTargetIds: new Set(["signal-event47", "gitlab-own-1-18256"]),
    meta: {
      "signal-event47": {
        boundWorkspaceId: "wks_5e5a",
        boundAgentId: "agent_d491",
        migratedFromIds: ["gitlab-own-1-18256"],
      },
    },
    normalizeCardId,
    resolveItemLinks,
  });

  assert.deepEqual([...res.supersededIds], ["gitlab-own-1-18256"]);
  assert.ok(
    res.carriedLinksByTarget["signal-event47"]?.some((l) => l.url.includes("merge_requests/18256")),
  );
});

test("resolveWorkerTargetCard prevents cross-card draft writes onto unbound duplicate and redirects merged IDs", () => {
  const boundCard = makeRadarCard({
    id: "gitlab-own-1-18256",
    status: "needs_me",
    workspace: {
      workspaceId: "wks_5e5a",
      workspaceName: "MR !18256",
      cwd: "/workspace/repo",
      primaryAgentId: "agent_d491",
      agentIds: ["agent_d491"],
      sessions: [],
      agentStatus: "idle",
      pendingPermissions: 0,
      updatedAt: "2026-11-18T05:00:00.000Z",
      prepSummary: null,
      summarizing: false,
    },
  });
  const unboundDuplicate = makeRadarCard({
    id: "signal-event47",
    status: "pool",
    workspace: null,
  });
  const localWsCard = makeRadarCard({
    id: "ws-wks_local",
    source: "workspace",
    group: "local",
    status: "needs_me",
    workspace: {
      workspaceId: "wks_local",
      workspaceName: "local",
      cwd: "/workspace/repo",
      primaryAgentId: "agent_local",
      agentIds: ["agent_local"],
      sessions: [],
      agentStatus: "idle",
      pendingPermissions: 0,
      updatedAt: "2026-11-18T05:00:00.000Z",
      prepSummary: null,
      summarizing: false,
    },
  });

  const meta: Record<string, ItemUserMeta> = {
    "gitlab-own-1-18256": {
      customStatus: "needs_me",
      boundWorkspaceId: "wks_5e5a",
      boundAgentId: "agent_d491",
      migratedFromIds: ["signal-event47"],
    },
  };

  const resolved = resolveWorkerTargetCard({
    items: [unboundDuplicate, boundCard, localWsCard],
    meta,
    agentId: "agent_d491",
    workspaceId: "wks_5e5a",
    requestedCardId: "signal-event47",
    normalizeCardId,
  });
  assert.equal(resolved?.id, "gitlab-own-1-18256");

  const redirected = resolveWorkerTargetCard({
    items: [boundCard, localWsCard],
    meta,
    agentId: "agent_local",
    workspaceId: "wks_local",
    requestedCardId: "signal-event47",
    normalizeCardId,
  });
  assert.equal(redirected?.id, "gitlab-own-1-18256");
});
