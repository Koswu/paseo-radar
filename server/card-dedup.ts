import { isDeterministicClaimEntityKey } from "./entity-keys.ts";
import type { RadarItem, RadarLink } from "../shared/radar";
import type { ItemUserMeta, RawScannedItem, TriageCacheEntry } from "./store";

export interface CardDedupOps {
  normalizeCardId: (id: string | null | undefined) => string;
  extractCanonicalEntityKeys: (input: {
    cardId?: string | null;
    entityKeys?: readonly string[] | null;
    title?: string | null;
    summary?: string | null;
    url?: string | null;
    secondaryUrl?: string | null;
    links?: readonly RadarLink[] | null;
    prompt?: string | null;
    relatedKeys?: readonly string[] | null;
    branchHint?: string | null;
  }) => Set<string>;
  setsIntersect: (a: ReadonlySet<string>, b: ReadonlySet<string>) => boolean;
  resolveItemLinks: (input: {
    attachedLinks?: readonly RadarLink[] | null;
    removedLinkKeys?: readonly string[] | null;
    url?: string | null;
    secondaryUrl?: string | null;
    links?: readonly RadarLink[] | null;
    extraLinks?: readonly RadarLink[] | null;
    title?: string | null;
    summary?: string | null;
    prompt?: string | null;
    relatedKeys?: readonly string[] | null;
    branchHint?: string | null;
  }) => RadarLink[];
  mergeSecondaryIntoPrimary: (primary: RawScannedItem, secondary: RawScannedItem) => void;
}

export function hasBoundSessionMeta(itemMeta: ItemUserMeta | undefined): boolean {
  if (!itemMeta || itemMeta.customStatus === "archived") return false;
  return Boolean(itemMeta.boundWorkspaceId || itemMeta.boundAgentId);
}

export function isLiveCardMeta(itemMeta: ItemUserMeta | undefined): boolean {
  if (!itemMeta) return false;
  if (itemMeta.customStatus === "archived" || itemMeta.customStatus === "done") return false;
  return Boolean(
    itemMeta.boundWorkspaceId ||
      itemMeta.boundAgentId ||
      itemMeta.customStatus === "needs_me" ||
      itemMeta.customStatus === "waiting_external",
  );
}

export function buildMigratedDonorTargetMap(
  meta: Record<string, ItemUserMeta>,
  validTargets: ReadonlySet<string>,
  normalizeCardId: (id: string | null | undefined) => string,
): Map<string, string> {
  const donorToTarget = new Map<string, string>();
  const entries = Object.entries(meta).sort(([, a], [, b]) => {
    return Number(hasBoundSessionMeta(b)) - Number(hasBoundSessionMeta(a));
  });
  for (const [targetId, targetMeta] of entries) {
    if (!targetMeta || targetMeta.customStatus === "archived") continue;
    if (!validTargets.has(targetId)) continue;
    for (const rawDonor of targetMeta.migratedFromIds ?? []) {
      const donorId = normalizeCardId(rawDonor);
      if (!donorId || donorId === targetId || donorToTarget.has(donorId)) continue;
      donorToTarget.set(donorId, targetId);
    }
  }
  return donorToTarget;
}

export function collectLiveDeterministicEntityKeys(
  item: RawScannedItem | undefined,
  itemMeta: ItemUserMeta | undefined,
  extractCanonicalEntityKeys: CardDedupOps["extractCanonicalEntityKeys"],
): Set<string> {
  const keys = new Set<string>();
  const attached = [...(itemMeta?.attachedLinks ?? []), ...(itemMeta?.extraLinks ?? [])];
  for (const k of extractCanonicalEntityKeys({
    links: attached,
    prompt: itemMeta?.decisionProposal?.target ?? null,
  })) {
    keys.add(k);
  }
  if (itemMeta?.prepSummary) {
    for (const k of extractCanonicalEntityKeys({ summary: itemMeta.prepSummary })) {
      if (isDeterministicClaimEntityKey(k)) {
        keys.add(k);
      }
    }
  }
  if (item) {
    for (const k of extractCanonicalEntityKeys({
      entityKeys: item.entityKeys,
      url: item.url,
      secondaryUrl: item.secondaryUrl,
      links: item.links,
    })) {
      if (isDeterministicClaimEntityKey(k)) {
        keys.add(k);
      }
    }
  }
  return keys;
}

/**
 * Applies deterministic dedup (`migratedFromIds` suppression and live-session artifact matching)
 * followed by cached semantic merges, preventing bound/unbound duplicate cards from splitting.
 */
export function applyDeterministicAndCachedMerges(params: {
  itemById: Map<string, RawScannedItem>;
  externalIds: ReadonlySet<string>;
  droppedOrMergedIds: Set<string>;
  nextCache: Record<string, TriageCacheEntry>;
  meta: Record<string, ItemUserMeta>;
  ops: CardDedupOps;
}): {
  extraLinkMerges: Record<string, RadarLink[]>;
  absorbedDonorsByTarget: Record<string, string[]>;
} {
  const { itemById, externalIds, droppedOrMergedIds, nextCache, meta, ops } = params;
  const extraLinkMerges: Record<string, RadarLink[]> = {};
  const absorbedDonorsByTarget: Record<string, string[]> = {};
  const absorbedIntoMap = new Map<string, string>();

  const validTargets = new Set<string>([...itemById.keys(), ...externalIds]);
  const migratedTargetByDonor = buildMigratedDonorTargetMap(meta, validTargets, ops.normalizeCardId);

  function absorbItem(primaryId: string, secondary: RawScannedItem): boolean {
    if (primaryId === secondary.id || droppedOrMergedIds.has(secondary.id)) return false;
    if (itemById.has(primaryId) && !droppedOrMergedIds.has(primaryId)) {
      ops.mergeSecondaryIntoPrimary(itemById.get(primaryId)!, secondary);
      droppedOrMergedIds.add(secondary.id);
      absorbedIntoMap.set(secondary.id, primaryId);
      absorbedDonorsByTarget[primaryId] = [
        ...(absorbedDonorsByTarget[primaryId] ?? []),
        secondary.id,
      ];
      return true;
    }
    if (externalIds.has(primaryId)) {
      const links = ops.resolveItemLinks({
        url: secondary.url,
        secondaryUrl: secondary.secondaryUrl,
        links: secondary.links,
        title: secondary.title,
        summary: secondary.summary,
        relatedKeys: secondary.relatedKeys,
      });
      if (links.length > 0) {
        extraLinkMerges[primaryId] = [...(extraLinkMerges[primaryId] ?? []), ...links];
      }
      droppedOrMergedIds.add(secondary.id);
      absorbedIntoMap.set(secondary.id, primaryId);
      absorbedDonorsByTarget[primaryId] = [
        ...(absorbedDonorsByTarget[primaryId] ?? []),
        secondary.id,
      ];
      return true;
    }
    return false;
  }

  // Pass 2a: Enforce persisted migratedFromIds & deterministic live-session entity ownership
  const liveEntityKeysByTarget = new Map<string, Set<string>>();
  for (const targetId of validTargets) {
    if (droppedOrMergedIds.has(targetId)) continue;
    const targetMeta = meta[targetId];
    if (!isLiveCardMeta(targetMeta)) continue;
    const keys = collectLiveDeterministicEntityKeys(
      itemById.get(targetId),
      targetMeta,
      ops.extractCanonicalEntityKeys,
    );
    if (keys.size > 0) {
      liveEntityKeysByTarget.set(targetId, keys);
    }
  }

  for (const [id, item] of itemById) {
    if (droppedOrMergedIds.has(id)) continue;
    const itemMeta = meta[id];
    const itemBound = hasBoundSessionMeta(itemMeta);

    const migratedTarget = migratedTargetByDonor.get(id);
    if (migratedTarget && migratedTarget !== id && !droppedOrMergedIds.has(migratedTarget)) {
      const targetMeta = meta[migratedTarget];
      const sameWorkspace = Boolean(
        itemMeta?.boundWorkspaceId && itemMeta.boundWorkspaceId === targetMeta?.boundWorkspaceId,
      );
      if ((!itemBound || sameWorkspace) && absorbItem(migratedTarget, item)) {
        continue;
      }
    }

    if (!itemBound) {
      const primaryKeys = ops.extractCanonicalEntityKeys({ cardId: item.id, url: item.url });
      if (primaryKeys.size > 0) {
        let matchedTarget: string | null = null;
        for (const [targetId, targetKeys] of liveEntityKeysByTarget) {
          if (targetId === id || droppedOrMergedIds.has(targetId)) continue;
          if (ops.setsIntersect(primaryKeys, targetKeys)) {
            matchedTarget = targetId;
            break;
          }
        }
        if (matchedTarget && absorbItem(matchedTarget, item)) {
          continue;
        }
      }
    }
  }

  function resolveMergeRoot(startId: string): string | null {
    let cur = startId;
    const visited = new Set<string>([startId]);
    while (true) {
      const redirected = absorbedIntoMap.get(cur);
      if (redirected && !visited.has(redirected)) {
        visited.add(redirected);
        cur = redirected;
        continue;
      }
      const entry = nextCache[cur];
      const nextTarget =
        entry && entry.action === "merge" && entry.mergeIntoId ? entry.mergeIntoId : null;
      if (!nextTarget) return cur === startId ? null : cur;
      if (visited.has(nextTarget)) return null;
      visited.add(nextTarget);
      const resolvedNext = absorbedIntoMap.get(nextTarget) ?? nextTarget;
      if (externalIds.has(resolvedNext)) return resolvedNext;
      const targetItem = itemById.get(resolvedNext);
      if (!targetItem || droppedOrMergedIds.has(resolvedNext)) return null;
      const targetCache = nextCache[resolvedNext];
      if (!targetCache || targetCache.stateHash !== targetItem.stateHash || targetCache.action !== "merge") {
        return resolvedNext;
      }
      cur = resolvedNext;
    }
  }

  // Pass 2b: Apply LLM triage semantic merges (including shared-workspace or live-absorbs-pool cases)
  for (const [id, item] of itemById) {
    if (droppedOrMergedIds.has(id)) continue;
    const entry = nextCache[id];
    if (!entry || entry.stateHash !== item.stateHash || entry.action !== "merge") continue;

    const targetId = resolveMergeRoot(id);
    if (!targetId || targetId === id) continue;

    const itemMeta = meta[id];
    const targetMeta = meta[targetId];
    const itemBound = hasBoundSessionMeta(itemMeta);
    const targetBound = hasBoundSessionMeta(targetMeta);

    if (!itemBound) {
      absorbItem(targetId, item);
    } else if (itemMeta?.boundWorkspaceId && itemMeta.boundWorkspaceId === targetMeta?.boundWorkspaceId) {
      absorbItem(targetId, item);
    } else if (!targetBound && itemById.has(targetId) && !droppedOrMergedIds.has(targetId)) {
      absorbItem(id, itemById.get(targetId)!);
    }
  }

  return { extraLinkMerges, absorbedDonorsByTarget };
}

/**
 * Reconciles items already absorbed via `migratedFromIds` during snapshot rendering so donor
 * items never fall back into the Pool between scans.
 */
export function findMigratedSupersededItems(params: {
  candidates: readonly RawScannedItem[];
  activeTargetIds: ReadonlySet<string>;
  meta: Record<string, ItemUserMeta>;
  normalizeCardId: (id: string | null | undefined) => string;
  resolveItemLinks: CardDedupOps["resolveItemLinks"];
}): {
  supersededIds: Set<string>;
  carriedLinksByTarget: Record<string, RadarLink[]>;
  metaKeysToDelete: string[];
} {
  const donorToTarget = buildMigratedDonorTargetMap(
    params.meta,
    params.activeTargetIds,
    params.normalizeCardId,
  );
  const supersededIds = new Set<string>();
  const carriedLinksByTarget: Record<string, RadarLink[]> = {};
  const metaKeysToDelete: string[] = [];

  for (const r of params.candidates) {
    const targetId = donorToTarget.get(r.id);
    if (!targetId || targetId === r.id) continue;
    const rMeta = params.meta[r.id];
    const tMeta = params.meta[targetId];
    const rHasDistinctLiveWs =
      rMeta?.customStatus !== "archived" &&
      Boolean(rMeta?.boundWorkspaceId || rMeta?.boundAgentId) &&
      (!tMeta?.boundWorkspaceId || rMeta?.boundWorkspaceId !== tMeta.boundWorkspaceId);
    if (rHasDistinctLiveWs) continue;

    supersededIds.add(r.id);
    const carried = params.resolveItemLinks({
      attachedLinks: rMeta?.attachedLinks,
      removedLinkKeys: rMeta?.removedLinkKeys,
      url: r.url,
      secondaryUrl: r.secondaryUrl,
      links: r.links,
      extraLinks: rMeta?.extraLinks,
      title: r.title,
      summary: r.summary,
      relatedKeys: r.relatedKeys,
    });
    if (carried.length > 0) {
      carriedLinksByTarget[targetId] = [...(carriedLinksByTarget[targetId] ?? []), ...carried];
    }
    if (rMeta) {
      metaKeysToDelete.push(r.id);
    }
  }

  return { supersededIds, carriedLinksByTarget, metaKeysToDelete };
}

/**
 * Resolves the target Radar card for worker tools (`radar_attach_links`,
 * `radar_mark_waiting_external`, `radar_set_needs_me_tag`), preferring the
 * card bound to the caller's live session over stale/merged or unbound duplicates.
 */
export function resolveWorkerTargetCard(params: {
  items: readonly RadarItem[];
  meta: Record<string, ItemUserMeta>;
  agentId: string;
  workspaceId: string | null;
  requestedCardId?: string;
  normalizeCardId: (id: string | null | undefined) => string;
}): RadarItem | undefined {
  const sessionCard = params.items.find(
    (i) =>
      i.workspace?.agentIds.includes(params.agentId) ||
      (params.workspaceId !== null && i.workspace?.workspaceId === params.workspaceId),
  );
  const rawReq = params.requestedCardId?.trim();
  if (!rawReq) {
    return sessionCard;
  }

  const normalizedReq = params.normalizeCardId(rawReq);
  const findItem = (id: string) =>
    params.items.find((i) => i.id === id || params.normalizeCardId(i.id) === id);

  const requestedCard = findItem(rawReq) ?? findItem(normalizedReq);

  if (sessionCard && !sessionCard.id.startsWith("ws-")) {
    if (!requestedCard || requestedCard.id === sessionCard.id) {
      return sessionCard;
    }
    const sessionMigrated = new Set(
      (params.meta[sessionCard.id]?.migratedFromIds ?? []).map((d) => params.normalizeCardId(d)),
    );
    if (requestedCard.workspace === null || sessionMigrated.has(normalizedReq)) {
      return sessionCard;
    }
  }

  if (requestedCard) {
    return requestedCard;
  }

  for (const [targetId, tMeta] of Object.entries(params.meta)) {
    if (!tMeta || tMeta.customStatus === "archived") continue;
    const migrated = tMeta.migratedFromIds ?? [];
    if (migrated.some((d) => d === rawReq || params.normalizeCardId(d) === normalizedReq)) {
      const redirected = findItem(targetId);
      if (redirected) return redirected;
    }
  }

  return sessionCard;
}
