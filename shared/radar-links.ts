import type { RadarLink, RadarLinkKind } from "./radar";

export type KnownLinkKind = Exclude<RadarLinkKind, "link">;

export interface HeaderLinkGroup {
  kind: RadarLinkKind;
  isUnknown: boolean;
  links: RadarLink[];
}

/**
 * Returns `itemUrl` only when it is non-empty and not already present in `links`,
 * avoiding duplicate external-link buttons when a drawer or header already renders `links`.
 */
export function resolveFallbackExternalUrl(
  itemUrl: string | null | undefined,
  links: readonly { url: string }[],
): string | null {
  const trimmed = itemUrl?.trim() ?? "";
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  const alreadyLinked = links.some((link) => link.url.trim().replace(/\/+$/, "") === normalized);
  return alreadyLinked ? null : trimmed;
}

/**
 * Groups attached links + fallback `itemUrl` for the compact card header strip:
 * - Known platforms (`gitlab`, `github`, `linear`, ...) appear first in first-seen order.
 * - Unknown links (`kind === "link"`) are always merged into a single trailing `"link"` group.
 */
export function buildHeaderLinkGroups(
  source: string,
  itemUrl: string | null | undefined,
  links: readonly RadarLink[],
  fallbackLabel = "Open Link",
): HeaderLinkGroup[] {
  const allLinks: RadarLink[] = [...links];
  const fallbackUrl = resolveFallbackExternalUrl(itemUrl, links);
  const normalizedSource = source.trim().toLowerCase();

  if (fallbackUrl) {
    const fallbackKind: RadarLinkKind = normalizedSource && !["custom", "workspace"].includes(normalizedSource)
      ? normalizedSource : "link";
    allLinks.push({ kind: fallbackKind, label: fallbackLabel, url: fallbackUrl });
  }

  const knownByKind = new Map<KnownLinkKind, RadarLink[]>();
  const unknownLinks: RadarLink[] = [];

  for (const lnk of allLinks) {
    if (lnk.kind === "link") {
      unknownLinks.push(lnk);
    } else {
      const existing = knownByKind.get(lnk.kind);
      if (existing) existing.push(lnk);
      else knownByKind.set(lnk.kind, [lnk]);
    }
  }

  const groups: HeaderLinkGroup[] = [];
  for (const [kind, grouped] of knownByKind.entries()) {
    groups.push({ kind, isUnknown: false, links: grouped });
  }
  if (unknownLinks.length > 0) {
    groups.push({ kind: "link", isUnknown: true, links: unknownLinks });
  }
  return groups;
}

/**
 * External sources with no links still show a static source glyph in the header;
 * local `workspace` / `custom` sources omit the source glyph to avoid visual clutter.
 */
export function shouldShowStaticSourceBadge(
  source: string,
  headerGroups: readonly HeaderLinkGroup[],
): boolean {
  const normalized = source.trim().toLowerCase();
  if (!normalized || normalized === "workspace" || normalized === "custom") {
    return false;
  }
  return !headerGroups.some((g) => !g.isUnknown && g.kind === normalized);
}

/**
 * Formats a compact URL preview that keeps the host and leading path segment intact
 * before truncating long trailing IDs or query strings.
 */
export function shortUrlPreview(rawUrl: string, maxLen = 46): string {
  const stripped = rawUrl.trim().replace(/^https?:\/\/(?:www\.)?/i, "");
  if (stripped.length <= maxLen) return stripped;

  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.replace(/^www\./i, "") + (parsed.port ? `:${parsed.port}` : "");
    const firstSeg = parsed.pathname.split("/").find(Boolean);
    if (firstSeg && stripped.toLowerCase().startsWith(host.toLowerCase())) {
      const prefix = `${host}/${firstSeg}`;
      if (prefix.length <= maxLen - 8) {
        const remain = stripped.slice(prefix.length);
        if (remain.startsWith("/")) {
          const tailLen = Math.max(4, maxLen - prefix.length - 2);
          return `${prefix}/…${remain.slice(-tailLen)}`;
        }
        const tailLen = Math.max(4, maxLen - prefix.length - 1);
        return `${prefix}…${remain.slice(-tailLen)}`;
      }
    }
  } catch {
    // Fall back to balanced truncation on non-standard URLs
  }

  const headLen = Math.max(8, Math.ceil((maxLen - 1) * 0.54));
  const tailLen = Math.max(6, maxLen - 1 - headLen);
  return `${stripped.slice(0, headLen)}…${stripped.slice(-tailLen)}`;
}
