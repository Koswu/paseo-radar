import type { RadarItem } from "../shared/radar.ts";

export function cardPriorityRank(card: RadarItem): number {
  const text = `${card.badge} ${card.title} ${card.summary}`;
  const isWakeup =
    card.waitCheckNote?.startsWith("已达成等待条件") ||
    card.waitCheckNote?.startsWith("已满足推进条件") ||
    card.waitCheckNote?.startsWith("检测到远端新变动");

  // For cards WITH an active workspace/session:
  if (card.workspace !== null) {
    if ((card.workspace.pendingPermissions ?? 0) > 0) return 1000;
    if (isWakeup) return 950;
    if (card.workspace.prepSummary) return 850;
    if (card.group === "urgent") return 800;
    if (/\[P0\]|\[P1\]|\bUrgent\b|\bHigh\b/i.test(text)) return 750;
    if (card.source !== "workspace") return 700;
    return 500;
  }

  if (isWakeup) return 950;

  // For Pool cards (no conversation yet):
  // Tier 1: Direct messages, document requests, and other urgent items.
  if (card.group === "urgent") {
    if (card.archetype === "message" || card.archetype === "document" || card.source === "slack") return 980;
    if (card.archetype === "code_change" || card.source === "gitlab") return 960;
    return 940;
  }
  // Tier 2: Own active MRs ready to push forward (comments / failed CI / approved / green draft)
  if ((card.archetype === "code_change" || card.source === "gitlab") && card.group === "closing") {
    if (card.badge.includes("失败") || card.badge.includes("评论")) return 900;
    if (card.badge.includes("可合并")) return 880;
    return 850;
  }
  // Tier 3: Incidents and high-priority work items.
  if (card.archetype === "incident") return 820;
  if (/\[P0\]|\bUrgent\b/i.test(text)) return 800;
  if (/\[P1\]|\bHigh\b/i.test(text)) {
    return /\bIn Progress\b/i.test(text) ? 780 : 760;
  }
  // Tier 4: Normal cycle development items (In Progress > Medium > Low > No priority)
  if (card.group === "todo") {
    if (/\bIn Progress\b/i.test(text)) return 700;
    if (/\bMedium\b/i.test(text)) return 660;
    if (/\bLow\b/i.test(text)) return 620;
    return 600;
  }
  // Tier 5: Closing issues (MR merged) > In Review > 100% historical projects at the very bottom
  if (card.badge.includes("100%")) return 200;
  return 400;
}

export function compareCards(a: RadarItem, b: RadarItem): number {
  const aNeedsMe = a.status === "needs_me";
  const bNeedsMe = b.status === "needs_me";
  if (aNeedsMe !== bNeedsMe) return aNeedsMe ? -1 : 1;
  if (aNeedsMe && bNeedsMe) {
    return (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
  }
  const rankDiff = cardPriorityRank(b) - cardPriorityRank(a);
  if (rankDiff !== 0) return rankDiff;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}
