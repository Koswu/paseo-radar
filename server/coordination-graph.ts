import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ArtifactEntry,
  BoardWatchSpec,
  CoordBoard,
  CoordWaveColumn,
  CoordinationSummary,
  SubCard,
  SubCardInboxMessage,
} from "../shared/coordination";
import type { CardStatus, NeedsMeTag, RadarLink } from "../shared/radar-primitives";

export function sanitizeBoardCardId(cardId: string): string {
  const trimmed = cardId.trim();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    return trimmed;
  }
  const safePrefix =
    trimmed
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "card";
  const hash = createHash("sha1").update(trimmed).digest("hex").slice(0, 8);
  return `${safePrefix}-${hash}`;
}

export function resolveSafeBoardPath(boardDir: string, relativePath: string): string | null {
  const raw = relativePath.trim();
  if (!raw || raw.includes("\0") || isAbsolute(raw)) {
    return null;
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    return null;
  }
  const base = resolve(boardDir);
  const target = resolve(base, raw);
  const rel = relative(base, target);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return target;
}

/**
 * Checks whether adding edges `fromId -> toIds` creates a cycle in a wait-dependency graph.
 * Each edge `u -> v` means `u` waits for `v`.
 */
export function detectBoardWatchCycle(
  existingEdges: ReadonlyMap<string, readonly string[]>,
  fromId: string,
  toIds: readonly string[],
): string[] | null {
  for (const target of toIds) {
    if (target === fromId) {
      return [fromId, fromId];
    }
  }

  const visited = new Set<string>();
  const dfs = (current: string, path: string[]): string[] | null => {
    if (current === fromId) {
      return path;
    }
    if (visited.has(current)) return null;
    visited.add(current);
    const nexts = existingEdges.get(current) ?? [];
    for (const next of nexts) {
      const cycle = dfs(next, [...path, next]);
      if (cycle) return cycle;
    }
    return null;
  };

  for (const target of toIds) {
    const cycle = dfs(target, [fromId, target]);
    if (cycle) return cycle;
  }
  return null;
}

export interface WatchTargetStateSnapshot {
  status: CardStatus;
  needsMeTag: NeedsMeTag | null;
  canceled?: boolean;
}

export interface BoardWatchEvalResult {
  state: "satisfied" | "pending" | "broken";
  matchedIds: string[];
  brokenIds: string[];
  pendingIds: string[];
}

export function evaluateBoardWatch(
  spec: BoardWatchSpec,
  lookup: (cardId: string) => WatchTargetStateSnapshot | null,
): BoardWatchEvalResult {
  const matchedIds: string[] = [];
  const brokenIds: string[] = [];
  const pendingIds: string[] = [];

  for (const target of spec.targets) {
    const info = lookup(target.cardId);
    if (!info || info.canceled) {
      brokenIds.push(target.cardId);
      continue;
    }
    const statusMatches = info.status === target.status;
    const tagMatches =
      target.status !== "needs_me" ||
      !target.needsMeTag ||
      info.needsMeTag === target.needsMeTag;
    if (statusMatches && tagMatches) {
      matchedIds.push(target.cardId);
    } else {
      pendingIds.push(target.cardId);
    }
  }

  if (spec.match === "any") {
    if (matchedIds.length > 0) {
      return { state: "satisfied", matchedIds, brokenIds, pendingIds };
    }
    if (pendingIds.length === 0 && brokenIds.length > 0) {
      return { state: "broken", matchedIds, brokenIds, pendingIds };
    }
    return { state: "pending", matchedIds, brokenIds, pendingIds };
  }

  if (brokenIds.length > 0) {
    return { state: "broken", matchedIds, brokenIds, pendingIds };
  }
  if (pendingIds.length === 0 && matchedIds.length === spec.targets.length) {
    return { state: "satisfied", matchedIds, brokenIds, pendingIds };
  }
  return { state: "pending", matchedIds, brokenIds, pendingIds };
}

export function computeTopologicalWaves(subcards: readonly SubCard[]): CoordWaveColumn[] {
  const byId = new Map(subcards.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const card = byId.get(id);
    if (!card) return 1;
    if (visiting.has(id)) return Math.max(1, card.wave || 1);
    visiting.add(id);

    const depIds = new Set<string>();
    if (card.waitBoard && card.waitBoard.scope === "inner") {
      for (const t of card.waitBoard.targets) {
        if (byId.has(t.cardId) && t.cardId !== id) depIds.add(t.cardId);
      }
    }
    for (const refId of card.refCards) {
      if (byId.has(refId) && refId !== id) depIds.add(refId);
    }

    let maxDep = 0;
    for (const depId of depIds) {
      maxDep = Math.max(maxDep, depthOf(depId));
    }
    visiting.delete(id);

    const computed = Math.max(1, card.wave || 1, maxDep > 0 ? maxDep + 1 : 1);
    memo.set(id, computed);
    return computed;
  };

  const buckets = new Map<number, string[]>();
  for (const s of subcards) {
    const w = depthOf(s.id);
    const list = buckets.get(w) ?? [];
    list.push(s.id);
    buckets.set(w, list);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, subcardIds]) => ({ wave, subcardIds }));
}

function truncateText(text: string, maxLen: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

export function computeCoordinationSummary(
  board: CoordBoard,
  eventCount: number,
): CoordinationSummary {
  const active = board.subcards.filter((s) => !s.canceled);
  const canceled = board.subcards.length - active.length;
  let archived = 0;
  let running = 0;
  let waitingBoard = 0;
  let waitingExternal = 0;
  let needsCoordinator = 0;
  let pool = 0;

  for (const s of active) {
    if (s.status === "archived") archived += 1;
    else if (s.status === "running") running += 1;
    else if (s.status === "needs_me") needsCoordinator += 1;
    else if (s.status === "waiting_external") {
      if (s.waitMode === "board") waitingBoard += 1;
      else waitingExternal += 1;
    } else {
      pool += 1;
    }
  }

  const total = active.length;
  let frontlineText: string | null = null;
  if (board.enabled) {
    if (total === 0) {
      frontlineText = "已开启协调模式，等待拆解子卡";
    } else if (needsCoordinator > 0) {
      const first = active.find((s) => s.status === "needs_me")!;
      const extra = needsCoordinator > 1 ? ` 等 ${needsCoordinator} 项` : "";
      frontlineText = `${first.id}「${truncateText(first.title, 18)}」待协调处理${extra}`;
    } else if (running > 0) {
      const runningIds = active
        .filter((s) => s.status === "running")
        .slice(0, 2)
        .map((s) => s.id)
        .join("、");
      const suffix =
        running > 2 ? ` 等 ${running} 项执行中` : " 执行中";
      const extras: string[] = [];
      if (waitingExternal > 0) extras.push(`${waitingExternal} 项等外部`);
      if (waitingBoard > 0) extras.push(`${waitingBoard} 项等前置`);
      frontlineText = `${runningIds}${suffix}${extras.length > 0 ? `；${extras.join("，")}` : ""}`;
    } else if (waitingExternal > 0) {
      const first = active.find(
        (s) => s.status === "waiting_external" && s.waitMode !== "board",
      )!;
      const cond = first.waitCondition ? `：${truncateText(first.waitCondition, 28)}` : "";
      frontlineText = `${first.id} 等待外部${cond}`;
    } else if (waitingBoard > 0) {
      frontlineText = `${waitingBoard} 项子卡等待前置条件满足`;
    } else if (archived === total) {
      frontlineText = `全部 ${total} 项子卡已完结`;
    } else {
      frontlineText = `${pool} 项子卡待派发`;
    }
  }

  return {
    enabled: board.enabled,
    total,
    archived,
    running,
    waitingBoard,
    waitingExternal,
    needsCoordinator,
    pool,
    canceled,
    frontlineText,
    eventCount,
    activeSubcardSessions: board.subcards
      .filter((s) => !s.canceled && Boolean(s.boundAgentId) && Boolean(s.boundWorkspaceId))
      .map((s) => ({
        subcardId: s.id,
        title: s.title,
        status: s.status,
        workspaceId: s.boundWorkspaceId!,
        agentId: s.boundAgentId!,
      })),
  };
}

export interface UpstreamCardManifest {
  id: string;
  title: string;
  status: CardStatus;
  closureEvidence: string | null;
  gitBranch: string | null;
  commitSha: string | null;
  links: readonly RadarLink[];
  artifacts: readonly ArtifactEntry[];
}

export interface SiblingRosterItem {
  id: string;
  title: string;
  status: CardStatus;
  isolation: "readonly" | "worktree";
  gitBranch: string | null;
  canceled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function formatReferenceManifestPrompt(params: {
  boardDir: string;
  subcardId: string;
  subcardOutputDir: string;
  upstreamCards: readonly UpstreamCardManifest[];
  inboxMessages?: readonly SubCardInboxMessage[];
  siblings?: readonly SiblingRosterItem[];
}): string {
  const lines: string[] = [
    `[内层看板共享目录] ${params.boardDir}`,
    `[你的专属产出目录] ${params.subcardOutputDir}（长报告、日志切片、结构化结果请写入此目录，供下游按需读取）`,
  ];

  if (params.upstreamCards.length > 0) {
    lines.push("", "[关联上游引用（仅提供指针索引，请按需用文件工具或 subradar_inspect 读取）]");
    for (const card of params.upstreamCards) {
      lines.push(`- ${card.id}「${card.title}」[${card.status}]`);
      if (card.closureEvidence) {
        lines.push(`  结论：${truncateText(card.closureEvidence, 160)}`);
      }
      if (card.gitBranch) {
        const sha = card.commitSha ? ` (commit ${card.commitSha})` : "";
        lines.push(`  Git 分支：${card.gitBranch}${sha}`);
      }
      if (card.links.length > 0) {
        const preview = card.links
          .slice(0, 4)
          .map((l) => `${l.label}: ${l.url}`)
          .join(" | ");
        lines.push(`  链接：${preview}`);
      }
      if (card.artifacts.length > 0) {
        lines.push("  产物清单：");
        for (const art of card.artifacts.slice(0, 12)) {
          const notePart = art.note ? ` — ${truncateText(art.note, 80)}` : "";
          lines.push(`    · ${art.absolutePath} (${formatBytes(art.sizeBytes)})${notePart}`);
        }
        if (card.artifacts.length > 12) {
          lines.push(`    · ...另有 ${card.artifacts.length - 12} 个文件`);
        }
      }
    }
  }

  if (params.inboxMessages && params.inboxMessages.length > 0) {
    lines.push("", "[待收消息（Inbox）]");
    for (const msg of params.inboxMessages) {
      lines.push(`- 来自 ${msg.from} [${msg.kind}] (${msg.at}): ${msg.message}`);
    }
  }

  const peers = (params.siblings ?? []).filter(
    (s) => s.id !== params.subcardId && !s.canceled,
  );
  if (peers.length > 0) {
    lines.push("", "[同看板兄弟子卡（可通过 subradar_inspect / subradar_message_peer 协同）]");
    for (const peer of peers) {
      const branch = peer.gitBranch ? `, branch: ${peer.gitBranch}` : "";
      lines.push(`- ${peer.id}: ${peer.title} [${peer.status}${branch}]`);
    }
  }

  return lines.join("\n");
}
