import type { RadarItem } from "./radar";

/**
 * Extracts all user-relevant searchable fields of a Radar card into a single
 * lowercase string for fast client-side substring matching.
 */
export function buildRadarItemSearchText(item: RadarItem): string {
  const parts: string[] = [
    item.id,
    item.title,
    item.summary,
    item.source,
    item.badge,
  ];

  if (item.projectName) parts.push(item.projectName);
  if (item.url) parts.push(item.url);
  if (item.secondaryUrl) parts.push(item.secondaryUrl);

  for (const link of item.links) {
    parts.push(link.kind, link.label, link.url);
  }

  if (item.workspace) {
    if (item.workspace.workspaceName) parts.push(item.workspace.workspaceName);
    if (item.workspace.cwd) parts.push(item.workspace.cwd);
    if (item.workspace.prepSummary) parts.push(item.workspace.prepSummary);
    for (const session of item.workspace.sessions) {
      parts.push(session.title, session.model);
    }
  }

  if (item.decisionProposal) {
    if (item.decisionProposal.title) parts.push(item.decisionProposal.title);
    if (item.decisionProposal.target) parts.push(item.decisionProposal.target);
    if (item.decisionProposal.impact) parts.push(item.decisionProposal.impact);
    if (item.decisionProposal.draft) parts.push(item.decisionProposal.draft);
  }

  if (item.waitCondition) parts.push(item.waitCondition);
  if (item.waitCheckNote) parts.push(item.waitCheckNote);

  if (item.goal) {
    parts.push(item.goal.spec);
    if (item.goal.rawSpec) parts.push(item.goal.rawSpec);
  }

  return parts.join("\n").toLowerCase();
}

/**
 * Splits a search query into normalized lowercase whitespace-delimited tokens.
 */
export function parseRadarSearchTokens(rawQuery: string): string[] {
  const trimmed = rawQuery.trim().toLowerCase();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Returns true if every token appears in the card's searchable text.
 */
export function matchesRadarSearch(item: RadarItem, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = buildRadarItemSearchText(item);
  for (const token of tokens) {
    if (!haystack.includes(token)) return false;
  }
  return true;
}

/**
 * Filters a list of Radar items by a raw search query using AND-token semantics.
 */
export function filterRadarItems(items: readonly RadarItem[], rawQuery: string): RadarItem[] {
  const tokens = parseRadarSearchTokens(rawQuery);
  if (tokens.length === 0) return items.slice();
  return items.filter((item) => matchesRadarSearch(item, tokens));
}
