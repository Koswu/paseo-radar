import type { ActiveSubcardSession, RadarItem, RadarSnapshot } from "../shared/radar";

export interface RadarOpenTarget {
  cardId?: string;
  coordCardId?: string;
}

interface HostRadarStore {
  snapshotCache: RadarSnapshot | null;
  lastUpdatedMs: number;
  listeners: Set<() => void>;
  screenOpener: ((target?: RadarOpenTarget) => void) | null;
  settingsOpener: (() => void) | null;
}

export interface MatchedSubcardSession {
  parentCard: RadarItem;
  subcardId: string;
  title: string;
  status: ActiveSubcardSession["status"];
  workspaceId: string;
  agentId: string;
}

const storesByHost = new WeakMap<object, HostRadarStore>();

function getStore(scope: object): HostRadarStore {
  let store = storesByHost.get(scope);
  if (!store) {
    store = {
      snapshotCache: null,
      lastUpdatedMs: 0,
      listeners: new Set(),
      screenOpener: null,
      settingsOpener: null,
    };
    storesByHost.set(scope, store);
  }
  return store;
}

export function bindRadarSettingsOpener(scope: object, opener: (() => void) | null): void {
  getStore(scope).settingsOpener = opener;
}

export function openRadarSettings(scope: object): void {
  getStore(scope).settingsOpener?.();
}

export function getCachedRadarSnapshot(scope: object): RadarSnapshot | null {
  return getStore(scope).snapshotCache;
}

export function getLastSnapshotUpdatedMs(scope: object): number {
  return getStore(scope).lastUpdatedMs;
}

export function setCachedRadarSnapshot(scope: object, next: RadarSnapshot): void {
  const store = getStore(scope);
  store.snapshotCache = next;
  store.lastUpdatedMs = Date.now();
  store.listeners.forEach((fn) => fn());
}

export function subscribeRadarSnapshot(scope: object, listener: () => void): () => void {
  const store = getStore(scope);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function bindRadarScreenOpener(
  scope: object,
  opener: ((target?: RadarOpenTarget) => void) | null,
): void {
  getStore(scope).screenOpener = opener;
}

export function openRadarToCard(scope: object, cardId?: string): void {
  getStore(scope).screenOpener?.(cardId ? { cardId } : undefined);
}

export function openRadarToCoordBoard(scope: object, coordCardId: string): void {
  getStore(scope).screenOpener?.({ coordCardId });
}

export function findSubcardSessionInSnapshot(
  snap: RadarSnapshot | null,
  workspaceId?: string | null,
  agentId?: string | null,
): MatchedSubcardSession | null {
  if (!snap) return null;
  if (agentId) {
    for (const card of snap.items) {
      const sub = card.coordination?.activeSubcardSessions?.find((s) => s.agentId === agentId);
      if (sub) {
        return {
          parentCard: card,
          subcardId: sub.subcardId,
          title: sub.title,
          status: sub.status,
          workspaceId: sub.workspaceId,
          agentId: sub.agentId,
        };
      }
    }
  }
  if (!agentId && workspaceId) {
    for (const card of snap.items) {
      const sub = card.coordination?.activeSubcardSessions?.find(
        (s) => s.workspaceId === workspaceId && s.workspaceId !== card.workspace?.workspaceId,
      );
      if (sub) {
        return {
          parentCard: card,
          subcardId: sub.subcardId,
          title: sub.title,
          status: sub.status,
          workspaceId: sub.workspaceId,
          agentId: sub.agentId,
        };
      }
    }
  }
  return null;
}

export function findCardForWorkspaceOrAgent(
  snap: RadarSnapshot | null,
  workspaceId?: string | null,
  agentId?: string | null,
): RadarItem | null {
  if (!snap) return null;
  if (agentId) {
    const byAgent = snap.items.find((it) => it.workspace?.agentIds.includes(agentId));
    if (byAgent) return byAgent;
  }
  if (workspaceId) {
    const byWs = snap.items.find(
      (it) => it.workspace?.workspaceId === workspaceId || it.id === `ws-${workspaceId}`,
    );
    if (byWs) return byWs;
  }
  return null;
}
