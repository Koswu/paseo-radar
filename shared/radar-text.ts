import type { ItemArchetype } from "./provider-protocol.ts";

const ISSUE_KEY_RE = /\b[A-Z]{2,10}-\d{1,6}\b/g;
const MR_PR_REF_RE = /(?:^|[\s(（\[])(?:MR\s*!\d+|PR\s*#\d+|!\d+|#\d+)\b/gi;
const MERGED_MR_BOILERPLATE_RE =
  /(?:^|\s*·\s*)关联\s*MR\s*已合并，待核验线上效果后收尾关单[。.]?\s*$/g;
const RAW_URL_RE = /(?:(?:相应|对应|相关)?(?:订单|详情|工单|原)?链接[：:\s]*)?https?:\/\/[^\s)）\]>]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTitleIdentifiers(title: string): string[] {
  const found = new Set<string>();
  for (const m of title.match(ISSUE_KEY_RE) ?? []) found.add(m);
  for (const raw of title.match(MR_PR_REF_RE) ?? []) {
    const trimmed = raw.trim().replace(/^[(（\[]/, "");
    if (trimmed) found.add(trimmed);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * Strips ticket/issue identifiers from an AI summary when the card title already displays them,
 * while preserving new identifiers (such as newly created MR/PR numbers) not in the title.
 */
export function dedupeSummaryWithTitle(summary: string, title: string): string {
  const trimmed = summary.trim();
  if (!trimmed || !title.trim()) return trimmed;

  const titleIds = extractTitleIdentifiers(title);
  if (titleIds.length === 0) return trimmed;

  let out = trimmed;

  for (const id of titleIds) {
    const escaped = escapeRegExp(id);
    // 1. Strip leading `[ID]` or `ID` + separators
    const leadingRe = new RegExp(`^(?:\\[\\s*)?${escaped}(?:\\s*\\])?[：:·,，;；—\\-\\s]*`, "i");
    out = out.replace(leadingRe, "");

    // 2. Strip parenthesized inline `(ID)` / `（ID）`
    const parenRe = new RegExp(`[（(]\\s*${escaped}\\s*[)）]`, "gi");
    out = out.replace(parenRe, "");

    // 3. Strip safe inline occurrences (avoid stripping right after Chinese prepositions or before "的")
    const inlineRe = new RegExp(
      `(?<![A-Za-z0-9_-])[ \\t]*${escaped}[ \\t]*(?![A-Za-z0-9_-])`,
      "gi",
    );
    out = out.replace(inlineRe, (match, offset: number, full: string) => {
      const before = full.slice(0, offset);
      const after = full.slice(offset + match.length);
      if (/(?:关于|针对|对|就|把|将|给|向|为|和|与|及|或|从|在|按)\s*$/.test(before)) {
        return match;
      }
      if (/^\s*(?:的|中|里|内|上|下|前|后|本身|相关)/.test(after)) {
        return match;
      }
      const prevChar = before[before.length - 1] ?? "";
      const nextChar = after[0] ?? "";
      return /[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar) ? " " : "";
    });
  }

  // Re-normalize any spaces around CJK introduced by inline replacements
  out = out
    .replace(/([\u4e00-\u9fff])[ \t]+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/[ \t]+([，。：；！？、)）])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[：:·,，;；—\-\s]+/, "")
    .trim();

  return out || trimmed;
}

/**
 * Cleans a card's external subtitle so it never repeats the card title, workspace boilerplate,
 * raw URLs already shown as link pills, or raw message snippets once an AI summary exists.
 */
export function cleanCardSubtitleText(
  badge: string,
  title: string,
  summary: string,
  projectName?: string | null,
  source?: string,
  hasPrepSummary = false,
  archetype?: ItemArchetype,
): string {
  let s = summary.trim();
  if (!s) return "";

  const normSummary = s.toLowerCase();
  const normTitle = title.trim().toLowerCase();
  if (normSummary === normTitle) return "";
  if (source === "workspace" && (s.startsWith("本地工作区") || normSummary.startsWith("local workspace"))) {
    return "";
  }
  const b = badge.trim();
  const p = (projectName ?? "").trim();
  if (b && p && normSummary === `${b} · ${p}`.toLowerCase()) {
    return "";
  }

  if (hasPrepSummary) {
    // Message and incident snippets are often redundant once a prepared summary exists.
    if (archetype === "incident" || archetype === "message" || source === "slack") {
      return "";
    }
    // Collectors append a generic merged-MR hint for pool cards; drop it once AI summary exists.
    s = s.replace(MERGED_MR_BOILERPLATE_RE, "").trim();
  }

  if (RAW_URL_RE.test(s)) {
    RAW_URL_RE.lastIndex = 0;
    s = s
      .replace(RAW_URL_RE, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[，,；;：:\s]+$/, "")
      .trim();
  }
  if (!s || s.toLowerCase() === normTitle) return "";
  return s;
}

/**
 * Removes opaque machine IDs (hex hashes, Slack thread_ts, note IDs and raw URLs)
 * from human-facing decision proposal metadata.
 */
export function stripMachineIdsForDisplay(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";

  let out = trimmed
    // Parenthesized machine IDs like `(note 324650 下)` or `（discussion b793...）`
    .replace(
      /[（(]\s*(?:note|comment|discussion|thread|thread_ts|ts|sha|commit|hash|record_id)\s*[：:=#\s]*[A-Za-z0-9._-]+\s*(?:下|处|中)?\s*[)）]/gi,
      "",
    )
    .replace(/[（(]\s*(?:[0-9a-f]{16,64}|\d{10}\.\d{4,})\s*[)）]/gi, "")
    // `discussion <hex>` -> `讨论串` (unless `讨论串` already precedes it)
    .replace(/(讨论串\s*)?\bdiscussion\s+[0-9a-f]{12,64}\b/gi, (_m, zhPrefix?: string) =>
      zhPrefix ? zhPrefix : "讨论串",
    )
    .replace(/\b(?:thread_ts|ts)\s*[=:]\s*\d{10}(?:\.\d+)?/gi, "")
    .replace(/\b(?:note|comment)\s*#?\d{5,}\b/gi, "")
    .replace(/\b(?:sha|commit|hash)\s*[=:]?\s*[0-9a-f]{12,64}\b/gi, "")
    .replace(/\b[0-9a-f]{16,64}\b/gi, "")
    .replace(/\b\d{10}\.\d{4,}\b/g, "")
    .replace(RAW_URL_RE, "");

  out = out
    .replace(/([\u4e00-\u9fff])[ \t]+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/[ \t]+([，。：；！？、)）])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[：:·,，;；—\-\s]+/, "")
    .replace(/[,，;；：:\s]+$/, "")
    .trim();

  return out;
}

function normalizeForContainment(text: string): string {
  return text.toLowerCase().replace(/[的\s·,，:：\-_]/g, "");
}

/**
 * Formats decision proposal `target` and `impact` for human review, stripping opaque machine IDs
 * and suppressing `target` when `impact` already names the same target object.
 */
export function cleanDecisionProposalFields(
  rawTarget: string | null | undefined,
  rawImpact: string | null | undefined,
): { target: string | null; impact: string | null } {
  const target = stripMachineIdsForDisplay(rawTarget) || null;
  const impact = stripMachineIdsForDisplay(rawImpact) || null;
  if (!target || !impact) {
    return { target, impact };
  }

  const normTarget = normalizeForContainment(target);
  const normImpact = normalizeForContainment(impact);
  if (normTarget && normImpact.includes(normTarget)) {
    return { target: null, impact };
  }

  const tokens = target
    .toLowerCase()
    .split(/[\s·,，/]+/)
    .map((t) => t.replace(/^的|的$/g, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length > 0 && tokens.every((t) => normImpact.includes(normalizeForContainment(t)))) {
    return { target: null, impact };
  }

  return { target, impact };
}
