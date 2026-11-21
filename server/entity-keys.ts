import type { CustomDomainRules, ProviderManifest, EntityUrlTemplate, DeclarativeLinkMatcher } from "../shared/provider-protocol";
import type { RadarLink, RadarLinkInput, RadarLinkKind } from "../shared/radar";

const NON_ISSUE_PREFIXES = new Set([
  "UTF",
  "SHA",
  "MD",
  "RSA",
  "AES",
  "GCM",
  "GPT",
  "GLM",
  "UTC",
  "GMT",
  "ISO",
  "CVE",
  "RFC",
  "HTTP",
  "HTTPS",
  "SSL",
  "TLS",
  "SSH",
  "TCP",
  "UDP",
  "DNS",
  "CPU",
  "GPU",
  "RAM",
  "PID",
  "UID",
  "API",
  "SQL",
  "CLI",
  "SDK",
  "RPC",
  "URL",
  "URI",
  "DOM",
  "CSS",
  "SVG",
  "PDF",
  "PNG",
  "JPG",
  "SLB",
  "ECS",
  "RDS",
  "SLS",
  "PR",
  "MR",
  "ID",
]);

const ISSUE_TOKEN_RE = /\b([A-Z]{2,8})-(\d{1,6})\b/g;
const ISSUE_BRANCH_TOKEN_RE = /(?:^|[/_-])([a-z]{2,8})-(\d{1,6})\b/gi;
const GITLAB_MR_URL_RE =
  /https?:\/\/[^/\s]+\/([A-Za-z0-9_./-]+?)\/-\/merge_requests\/(\d+)(?:[/?#][^\s>|)\]"']*)?/gi;
const GITHUB_PR_OR_ISSUE_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)(?:[/?#][^\s>|)\]"']*)?/gi;
const BARE_MR_RE = /(?:^|[\s(（\[])!(\d{3,6})\b/g;
const ANY_URL_RE = /https?:\/\/[^\s<>|\]"']+/gi;

export function cleanExtractedUrl(raw: string): string {
  let u = raw.replace(/\\~/g, "~").trim();
  while (u.length > 0 && /[>|.,;:'"!?）)】\]]/.test(u[u.length - 1]!)) {
    u = u.slice(0, -1);
  }
  while (u.endsWith(")")) {
    const opens = (u.match(/\(/g) ?? []).length;
    const closes = (u.match(/\)/g) ?? []).length;
    if (closes > opens) {
      u = u.slice(0, -1);
    } else {
      break;
    }
  }
  return u;
}

interface ParsedLinkCandidate {
  dedupeKey: string;
  kind: RadarLinkKind;
  baseLabel: string;
  subId?: string;
  labelSource: "explicit" | "platform" | "derived";
  rawId?: string;
  url: string;
}

const GENERIC_PLACEHOLDER_LABELS = new Set(["", "链接", "原文", "link", "url"]);
const AUTO_NUMBERED_LABEL_RE =
  /^(?:Slack|Sentry|GitLab|GitHub|Metabase|CI|Linear 项目|链接)\s*\d*$/i;
const MACHINE_ID_LABEL_RE =
  /^(?:(?:Record|Thread|Discussion|Note|Commit|Sha|Id)\s*[:：·#\-\s]*)?(?:[0-9a-f]{16,64}|\d{10}\.\d{4,})$/i;

const GENERIC_URL_PREFIX_SEGMENTS = new Set([
  "api",
  "admin",
  "app",
  "web",
  "v1",
  "v2",
  "v3",
  "v4",
  "internal",
  "manage",
  "management",
  "console",
  "portal",
  "pages",
]);

const GENERIC_URL_ACTION_SEGMENTS = new Set([
  "detail",
  "details",
  "view",
  "edit",
  "show",
  "info",
  "index",
  "list",
  "new",
]);

const URL_RESOURCE_LABELS: Record<string, string> = {
  "tickets": "工单",
  "ticket": "工单",
  "docs": "文档",
  "doc": "文档",
  "dashboards": "看板",
  "dashboard": "看板",
  "reports": "报表",
  "report": "报表",
  "alerts": "告警",
  "alert": "告警",
  "logs": "日志",
  "deployments": "部署",
  "pipelines": "流水线",
  "jobs": "任务",
};

type RegistryInput = { manifests?: readonly ProviderManifest[]; domainRules?: CustomDomainRules | null };

function buildRegistry({ manifests = [], domainRules }: RegistryInput) {
  const sources = [...(domainRules ? [domainRules] : []), ...manifests];
  const labels = new Map(Object.entries(URL_RESOURCE_LABELS));
  const matchers: Array<{ rule: DeclarativeLinkMatcher; regex: RegExp }> = [];
  const templates: Array<{ rule: EntityUrlTemplate; token?: RegExp; branch?: RegExp; card?: RegExp }> = [];
  const claimPrefixes = new Set(["mr", "gh"]);
  for (const source of [...sources].reverse()) {
    for (const [key, label] of Object.entries(source.resourceLabels)) labels.set(key.toLowerCase(), label);
  }
  for (const source of sources) {
    for (const rule of source.linkMatchers) {
      matchers.push({ rule, regex: new RegExp(rule.urlRegex, rule.flags.replace(/[gy]/g, "")) });
    }
    for (const rule of source.entityTemplates) {
      templates.push({
        rule, token: rule.tokenRegex ? new RegExp(rule.tokenRegex, "g") : undefined,
        branch: rule.branchTokenRegex ? new RegExp(rule.branchTokenRegex, "gi") : undefined,
        card: rule.cardIdRegex ? new RegExp(rule.cardIdRegex, "gi") : undefined,
      });
      if (rule.deterministicLiveClaim) claimPrefixes.add(rule.entityPrefix.replace(/:$/, "").toLowerCase());
    }
  }
  return { labels, matchers, templates, claimPrefixes };
}

let registry = buildRegistry({});
export function configureEntityRegistry(input: RegistryInput): void { registry = buildRegistry(input); }
export function resetEntityRegistry(): void { configureEntityRegistry({}); }
export function isDeterministicClaimEntityKey(key: string): boolean {
  const colon = key.indexOf(":");
  return colon > 0 && key.length > colon + 1 && registry.claimPrefixes.has(key.slice(0, colon).toLowerCase());
}

function expand(pattern: string, m: RegExpMatchArray): string {
  return pattern.replace(/\$([1-9])(?:_(lower|upper|tail4|docslug))?/g, (_, n, op) => {
    const value = m[Number(n)] ?? "";
    switch (op) {
      case "lower": return value.toLowerCase();
      case "upper": return value.toUpperCase();
      case "tail4": return value.slice(-4);
      case "docslug": return value.split("--").pop()!.toLowerCase();
      default: return value;
    }
  });
}

function* templateMatches(text: string, field: "token" | "branch" | "card") {
  for (const entry of registry.templates) {
    const regex = entry[field];
    if (!regex) continue;
    for (const m of text.matchAll(regex)) {
      const { rule } = entry;
      const suffix = expand(rule.keyTemplate, m);
      if (suffix) yield { rule, m, key: normalizeEntityKey(rule.entityPrefix.replace(/:$/, "") + ":" + suffix) };
    }
  }
}

const CONTEXT_STOP_WORDS = new Set([
  "点击",
  "打开",
  "查看",
  "详见",
  "参见",
  "参考",
  "相关",
  "相应",
  "对应",
  "原来",
  "这里",
  "如下",
  "链接",
  "地址",
  "网址",
  "核验",
  "确认",
  "处理",
  "关联",
  "关于",
  "针对",
  "编号",
  "记录",
  "以及",
  "或者",
  "url",
  "link",
]);

function clipLinkLabel(label: string, maxLen = 28): string {
  const trimmed = label.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeSafe(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function parseUrlIdToken(seg: string): { rawId: string; shortId: string } | null {
  if (/^\d{3,}$/.test(seg)) {
    return { rawId: seg, shortId: seg.length > 6 ? seg.slice(-4) : seg };
  }
  if (/^[0-9a-f]{12,}$/i.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{12,}$/i.test(seg)) {
    return { rawId: seg, shortId: seg.slice(-4) };
  }
  if (/^[A-Za-z]{1,8}-\d{1,6}$/.test(seg)) {
    return { rawId: seg, shortId: seg };
  }
  if (/^[A-Za-z0-9_-]{12,}$/.test(seg) && (seg.match(/\d/g)?.length ?? 0) >= 4) {
    return { rawId: seg, shortId: seg.slice(-4) };
  }
  return null;
}

function formatResourceSegment(rawSeg: string): string {
  const cleaned = rawSeg
    .replace(/\.(?:html?|php|aspx?)$/i, "")
    .replace(/-[0-9a-f]{24,32}$/i, "")
    .trim();
  if (!cleaned) return "";
  const mapped = registry.labels.get(cleaned.toLowerCase());
  if (mapped) return mapped;
  return cleaned;
}

function deriveUrlMeta(rawUrl: string): { label: string; rawId?: string; subId?: string } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segs = parsed.pathname
      .split("/")
      .map((s) => decodeSafe(s).trim())
      .filter(Boolean);

    while (segs.length > 1 && GENERIC_URL_PREFIX_SEGMENTS.has(segs[0]!.toLowerCase())) {
      segs.shift();
    }
    while (segs.length > 1 && GENERIC_URL_ACTION_SEGMENTS.has(segs[segs.length - 1]!.toLowerCase())) {
      segs.pop();
    }

    let idInfo: { rawId: string; shortId: string } | null = null;
    let idIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      const parsedId = parseUrlIdToken(segs[i]!);
      if (parsedId) {
        idInfo = parsedId;
        idIdx = i;
        break;
      }
    }

    if (!idInfo) {
      for (const key of ["id", "record_id", "docId", "doc_id", "ticketId", "ticket_id"]) {
        const val = parsed.searchParams.get(key)?.trim();
        if (val) {
          const parsedId = parseUrlIdToken(val);
          if (parsedId) {
            idInfo = parsedId;
            break;
          }
        }
      }
    }

    let resourceLabel = "";
    const candidateSegs = idIdx >= 0 ? segs.slice(0, idIdx) : segs;
    for (let i = candidateSegs.length - 1; i >= 0; i--) {
      const seg = candidateSegs[i]!;
      if (/^(?:v?\d{1,2}|en|zh|zh-cn)$/i.test(seg) && i < candidateSegs.length - 1) continue;
      const formatted = formatResourceSegment(seg);
      if (formatted) {
        resourceLabel = formatted;
        break;
      }
    }

    if (!resourceLabel && segs.length > 0 && idIdx < 0) {
      resourceLabel = formatResourceSegment(segs[segs.length - 1]!);
    }

    if (resourceLabel && idInfo) {
      const suffix = ` · ${idInfo.shortId}`;
      const maxPrefixLen = Math.max(8, 24 - suffix.length);
      return {
        label: `${clipLinkLabel(resourceLabel, maxPrefixLen)}${suffix}`,
        rawId: idInfo.rawId,
        subId: idInfo.shortId,
      };
    }
    if (resourceLabel) {
      return { label: clipLinkLabel(resourceLabel, 24) };
    }
    if (idInfo) {
      const hostTag = host.split(".")[0] || host;
      return {
        label: `${clipLinkLabel(hostTag, 14)} · ${idInfo.shortId}`,
        rawId: idInfo.rawId,
        subId: idInfo.shortId,
      };
    }
    return { label: clipLinkLabel(host, 24) || "链接" };
  } catch {
    return { label: "链接" };
  }
}

function isPlaceholderLinkLabel(trimmed: string): boolean {
  return (
    !trimmed ||
    GENERIC_PLACEHOLDER_LABELS.has(trimmed.toLowerCase()) ||
    AUTO_NUMBERED_LABEL_RE.test(trimmed) ||
    MACHINE_ID_LABEL_RE.test(trimmed)
  );
}

function cleanCustomLinkLabel(raw: string | undefined, maxLen = 28): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isPlaceholderLinkLabel(trimmed)) return null;
  return clipLinkLabel(trimmed, maxLen);
}

function pickStructuredLabel(
  autoLabel: string,
  explicitLabel: string | undefined,
  preferExplicitLabel: boolean,
): { label: string; isExplicit: boolean } {
  if (!preferExplicitLabel || !explicitLabel) {
    return { label: autoLabel, isExplicit: false };
  }
  const trimmed = explicitLabel.trim();
  if (isPlaceholderLinkLabel(trimmed) || trimmed.length > 24) {
    return { label: autoLabel, isExplicit: false };
  }
  return { label: trimmed, isExplicit: true };
}

export function classifyUrl(
  rawUrl: string,
  allowGenericExplicit = false,
  explicitLabel?: string,
  preferExplicitLabel = false,
  explicitKind?: RadarLinkKind,
): ParsedLinkCandidate | null {
  const url = cleanExtractedUrl(rawUrl);
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  for (const { rule, regex } of registry.matchers) {
    const m = regex.exec(url);
    if (!m) continue;
    const canonical = rule.canonicalUrlTemplate ? expand(rule.canonicalUrlTemplate, m) : url;
    if (!/^https?:\/\//i.test(canonical)) continue;
    const label = explicitLabel && !m.slice(1).includes(explicitLabel.trim())
      ? cleanCustomLinkLabel(explicitLabel, 24) : null;
    return {
      dedupeKey: rule.entityKeyTemplate ? normalizeEntityKey(expand(rule.entityKeyTemplate, m)) : "url:" + canonical.toLowerCase(),
      kind: rule.kind, url: canonical, baseLabel: label ?? expand(rule.labelTemplate, m),
      subId: rule.subIdTemplate ? expand(rule.subIdTemplate, m) : undefined,
      labelSource: label ? "explicit" : "platform",
    };
  }

  // 2. GitLab MR (any GitLab instance using /-/merge_requests/<iid>)
  const glMrMatch = url.match(
    /^https?:\/\/[^/\s]+\/([A-Za-z0-9_./-]+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i,
  );
  if (glMrMatch?.[1] && glMrMatch[2]) {
    const repo = glMrMatch[1];
    const iid = glMrMatch[2];
    const repoLower = repo.toLowerCase();
    const parts = repoLower.split("/");
    const shortRepo = parts[parts.length - 1] ?? repo;
    const isSameGroupRepo = parts.length === 2 && parts[0] === parts[1];
    const autoLabel = isSameGroupRepo ? `!${iid}` : `${shortRepo}!${iid}`;
    const picked = pickStructuredLabel(autoLabel, explicitLabel, preferExplicitLabel);
    return {
      dedupeKey: `mr:${repoLower}!${iid}`,
      kind: "gitlab",
      baseLabel: picked.label,
      labelSource: picked.isExplicit ? "explicit" : "platform",
      url,
    };
  }

  // Ignore GitLab / GitHub source file citations (/blob/, /tree/, /raw/, /commit/, /commits/) in freeform text
  if (
    /^https?:\/\/[^/\s]+\/.+\/(?:-\/)?(?:blob|tree|raw|commit|commits)\//i.test(url) &&
    !allowGenericExplicit
  ) {
    return null;
  }

  // 3. GitHub PR or Issue
  const ghMatch = url.match(
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+))\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i,
  );
  if (ghMatch?.[1] && ghMatch[2] && ghMatch[3] && ghMatch[4]) {
    const fullRepo = ghMatch[1].toLowerCase();
    const shortRepo = ghMatch[2];
    const num = ghMatch[4];
    const picked = pickStructuredLabel(`${shortRepo}#${num}`, explicitLabel, preferExplicitLabel);
    return {
      dedupeKey: `gh:${fullRepo}#${num}`,
      kind: "github",
      baseLabel: picked.label,
      labelSource: picked.isExplicit ? "explicit" : "platform",
      url,
    };
  }

  // 4. Linear Issue or Project (any Linear workspace)
  const linIssueMatch = url.match(
    /^https:\/\/linear\.app\/[^/\s?#]+\/issue\/([A-Za-z]{2,8}-\d{1,6})(?:\/[^\s?#]*)?/i,
  );
  if (linIssueMatch?.[1]) {
    const ident = linIssueMatch[1].toUpperCase();
    const picked = pickStructuredLabel(ident, explicitLabel, preferExplicitLabel);
    return {
      dedupeKey: `issue:${ident.toLowerCase()}`,
      kind: "linear",
      baseLabel: picked.label,
      labelSource: picked.isExplicit ? "explicit" : "platform",
      url,
    };
  }
  const linProjMatch = url.match(/^https:\/\/linear\.app\/[^/\s?#]+\/project\/([^\s/?#]+)/i);
  if (linProjMatch?.[1]) {
    const customLabel = cleanCustomLinkLabel(explicitLabel, 24);
    return {
      dedupeKey: `linear-project:${linProjMatch[1].toLowerCase()}`,
      kind: "linear",
      baseLabel: customLabel || "Linear 项目",
      labelSource: customLabel ? "explicit" : "platform",
      url,
    };
  }

  // 5. Jira Issue (/browse/PROJ-123)
  const jiraMatch = url.match(/^https?:\/\/[^/\s]+\/browse\/([A-Z][A-Z0-9]{1,9}-\d{1,6})(?:[/?#].*)?$/i);
  if (jiraMatch?.[1]) {
    const ident = jiraMatch[1].toUpperCase();
    const picked = pickStructuredLabel(ident, explicitLabel, preferExplicitLabel);
    return {
      dedupeKey: `issue:${ident.toLowerCase()}`,
      kind: "jira",
      baseLabel: picked.label,
      labelSource: picked.isExplicit ? "explicit" : "platform",
      url,
    };
  }

  // 7. Slack Archive / Thread Permalink (any Slack workspace)
  const slackMatch = url.match(
    /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)(?:\?([^#]*))?/i,
  );
  if (slackMatch?.[1] && slackMatch[2]) {
    const chId = slackMatch[1].toUpperCase();
    const pDigits = slackMatch[2];
    let threadKey = pDigits;
    if (slackMatch[3]) {
      try {
        const sp = new URLSearchParams(slackMatch[3]);
        const tts = sp.get("thread_ts");
        if (tts) threadKey = tts.replace(".", "");
      } catch {
        // Ignore query parse error
      }
    }
    const picked = pickStructuredLabel("Slack", explicitLabel, preferExplicitLabel);
    return {
      dedupeKey: `slack:${chId}:${threadKey}`,
      kind: "slack",
      baseLabel: picked.label,
      labelSource: picked.isExplicit ? "explicit" : "platform",
      url,
    };
  }

  // 8. Sentry Issue (self-hosted or sentry.io)
  if (/^https?:\/\/(?:sentry\.[^/\s]+|[^/\s]+\.sentry\.io)\//i.test(url)) {
    const base = url.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
    const picked = pickStructuredLabel("Sentry", explicitLabel, preferExplicitLabel);
    return {
      dedupeKey: `sentry:${base.toLowerCase()}`,
      kind: "sentry",
      baseLabel: picked.label,
      labelSource: picked.isExplicit ? "explicit" : "platform",
      url,
    };
  }

  if (!allowGenericExplicit) return null;

  const customLabel = cleanCustomLinkLabel(explicitLabel, 28);
  const derived = deriveUrlMeta(url);
  if (customLabel) {
    return {
      dedupeKey: `url:${url.toLowerCase()}`,
      kind: explicitKind ?? "link",
      baseLabel: customLabel,
      subId: derived.subId,
      labelSource: "explicit",
      rawId: derived.rawId,
      url,
    };
  }

  let platformFallback = "";
  if (/metabase/i.test(url)) platformFallback = "Metabase";
  else if (/\/-\/(?:pipelines|jobs)\/|\/actions\/runs\//i.test(url)) platformFallback = "CI";
  else if (/gitlab/i.test(url)) platformFallback = "GitLab";
  else if (/github\.com/i.test(url)) platformFallback = "GitHub";

  if (platformFallback) {
    return {
      dedupeKey: `url:${url.toLowerCase()}`,
      kind: explicitKind ?? "link",
      baseLabel: platformFallback,
      subId: derived.subId,
      labelSource: "platform",
      rawId: derived.rawId,
      url,
    };
  }

  return {
    dedupeKey: `url:${url.toLowerCase()}`,
    kind: explicitKind ?? "link",
    baseLabel: derived.label,
    subId: derived.subId,
    labelSource: "derived",
    rawId: derived.rawId,
    url,
  };
}

function finalizeCandidates(candidates: readonly ParsedLinkCandidate[]): RadarLink[] {
  const byKey = new Map<string, ParsedLinkCandidate>();
  for (const c of candidates) {
    const existing = byKey.get(c.dedupeKey);
    if (!existing) {
      byKey.set(c.dedupeKey, c);
      continue;
    }
    let merged = existing;
    if (c.dedupeKey.startsWith("issue:") && c.url.length > existing.url.length) {
      merged = { ...merged, url: c.url };
    }
    if (existing.labelSource !== "explicit" && c.labelSource === "explicit") {
      merged = { ...merged, baseLabel: c.baseLabel, labelSource: "explicit" };
    }
    if (merged !== existing) {
      byKey.set(c.dedupeKey, merged);
    }
  }

  const unique = [...byKey.values()];
  const counts = new Map<string, number>();
  for (const c of unique) {
    counts.set(c.baseLabel, (counts.get(c.baseLabel) ?? 0) + 1);
  }

  const subCounts = new Map<string, number>();
  for (const c of unique) {
    if ((counts.get(c.baseLabel) ?? 1) > 1 && c.subId) {
      const k = `${c.baseLabel}\0${c.subId}`;
      subCounts.set(k, (subCounts.get(k) ?? 0) + 1);
    }
  }

  const seenIndex = new Map<string, number>();
  return unique.map((c) => {
    const total = counts.get(c.baseLabel) ?? 1;
    if (total <= 1) {
      return { kind: c.kind, label: c.baseLabel, url: c.url };
    }
    if (c.subId && (subCounts.get(`${c.baseLabel}\0${c.subId}`) ?? 0) === 1) {
      return { kind: c.kind, label: `${c.baseLabel} · ${c.subId}`, url: c.url };
    }
    const idx = (seenIndex.get(c.baseLabel) ?? 0) + 1;
    seenIndex.set(c.baseLabel, idx);
    return { kind: c.kind, label: `${c.baseLabel} ${idx}`, url: c.url };
  });
}

export function getLinkDedupeKeys(rawUrl: string): string[] {
  const cleaned = cleanExtractedUrl(rawUrl);
  if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) return [];
  const keys = new Set<string>([`raw:${cleaned.toLowerCase()}`]);
  const parsed = classifyUrl(cleaned, true);
  if (parsed) {
    keys.add(parsed.dedupeKey);
    keys.add(`raw:${parsed.url.toLowerCase()}`);
  }
  return [...keys];
}

export function mergeRadarLinks(...groups: Array<readonly RadarLink[] | null | undefined>): RadarLink[] {
  const candidates: ParsedLinkCandidate[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const item of group) {
      if (!item?.url) continue;
      const parsed = classifyUrl(item.url, true, item.label, false, item.kind);
      if (parsed) candidates.push(parsed);
    }
  }
  return finalizeCandidates(candidates);
}

export function mergeAttachedLinks(
  ...groups: Array<readonly (RadarLink | RadarLinkInput)[] | null | undefined>
): RadarLink[] {
  const candidates: ParsedLinkCandidate[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const item of group) {
      if (!item?.url) continue;
      const parsed = classifyUrl(item.url, true, item.label, true, item.kind);
      if (parsed) candidates.push(parsed);
    }
  }
  return finalizeCandidates(candidates);
}

export function filterLinksByRemovedKeys(
  links: readonly RadarLink[] | null | undefined,
  removedKeys: ReadonlySet<string>,
): RadarLink[] {
  if (!links || links.length === 0) return [];
  if (removedKeys.size === 0) return [...links];
  return links.filter((l) => !getLinkDedupeKeys(l.url).some((k) => removedKeys.has(k)));
}

function inferLinearOrgBase(candidates: readonly ParsedLinkCandidate[]): string | null {
  for (const c of candidates) {
    const m = c.url.match(/^(https:\/\/linear\.app\/[^/\s?#]+)/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

function cleanContextNoun(raw: string): string | null {
  let s = raw.trim().replace(/^[·:：#＃\-_/\s]+|[·:：#＃\-_/\s]+$/g, "");
  s = s.replace(/^(?:相应|对应|相关|原)(?=[\u4e00-\u9fff]{2,})/, "").trim();
  if (s.length < 2 || s.length > 14) return null;
  if (/^https?:/i.test(s) || /^[0-9]+$/.test(s)) return null;
  if (/[的了是在把将和与及或，,。.;；!！?？]/.test(s)) return null;
  if (CONTEXT_STOP_WORDS.has(s.toLowerCase()) || isPlaceholderLinkLabel(s)) return null;
  return s;
}

function formatWithSubId(label: string, subId?: string): string {
  const clean = clipLinkLabel(label, 24);
  if (!subId || clean.includes(subId)) return clean;
  const suffix = ` · ${subId}`;
  const maxPrefix = Math.max(6, 24 - suffix.length);
  return `${clipLinkLabel(clean, maxPrefix)}${suffix}`;
}

function enrichDerivedLinkLabels(
  candidates: ParsedLinkCandidate[],
  context: {
    title?: string | null;
    summary?: string | null;
    labelContext?: string | null;
    prompt?: string | null;
  },
): void {
  const literalBlob = [context.title, context.summary, context.labelContext, context.prompt]
    .filter(Boolean)
    .join("\n")
    .replace(/\\~/g, "~");
  const nounBlob = [context.title, context.summary, context.labelContext]
    .filter(Boolean)
    .join("\n")
    .replace(/\\~/g, "~");

  if (!literalBlob && !nounBlob) return;

  for (const c of candidates) {
    if (c.labelSource !== "derived") continue;

    if (literalBlob) {
      const escapedUrl = escapeRegExp(c.url.replace(/\/+$/, ""));
      const urlPattern = `${escapedUrl}\\/?`;

      // 1. Slack <url|label> or Markdown [label](url)
      const slackMatch = literalBlob.match(new RegExp(`<${urlPattern}\\|([^>|\\n]{1,32})>`, "i"));
      const mdMatch = literalBlob.match(new RegExp(`\\[([^\\]\\n]{1,32})\\]\\(${urlPattern}\\)`, "i"));
      const anchored = cleanCustomLinkLabel(slackMatch?.[1] ?? mdMatch?.[1], 24);
      if (anchored && !/^https?:/i.test(anchored)) {
        c.baseLabel = formatWithSubId(anchored, c.subId);
        c.labelSource = "explicit";
        continue;
      }

      // 2. Prefix right before URL
      const colonPrefixMatch = literalBlob.match(
        new RegExp(
          `(?:^|[\\s，,；;。.(（\\[])([^\\s:：，,；;。.\\[\\]()（）<>]{2,14}?)(?:链接|地址|入口)?\\s*[：:]\\s*${urlPattern}`,
          "i",
        ),
      );
      const tightPrefixMatch = literalBlob.match(
        new RegExp(
          `(?:^|[\\s，,；;。.(（\\[])([^\\s:：，,；;。.\\[\\]()（）<>]{2,10})链接\\s*${urlPattern}`,
          "i",
        ),
      );
      const rawPrefix = colonPrefixMatch?.[1] ?? tightPrefixMatch?.[1];
      if (rawPrefix) {
        const cleanedPrefix = cleanContextNoun(rawPrefix);
        if (cleanedPrefix) {
          c.baseLabel = formatWithSubId(cleanedPrefix, c.subId);
          continue;
        }
      }
    }

    // 3. Long ID preceding noun in title / summary / labelContext
    if (nounBlob && c.rawId && c.rawId.length >= 6) {
      const idRe = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(c.rawId)}(?![A-Za-z0-9])`);
      const idMatch = idRe.exec(nounBlob);
      if (idMatch && idMatch.index > 0) {
        const before = nounBlob.slice(Math.max(0, idMatch.index - 24), idMatch.index);
        const nounMatch = before.match(/([\u4e00-\u9fff]{2,6})(?:[#＃:：\-\s]*)$/);
        if (nounMatch?.[1]) {
          const noun = cleanContextNoun(nounMatch[1]);
          if (noun) {
            c.baseLabel = formatWithSubId(noun, c.subId ?? c.rawId.slice(-4));
          }
        }
      }
    }
  }
}

export function resolveItemLinks(input: {
  attachedLinks?: readonly RadarLink[] | null;
  removedLinkKeys?: readonly string[] | null;
  url?: string | null;
  secondaryUrl?: string | null;
  links?: readonly RadarLink[] | null;
  extraLinks?: readonly RadarLink[] | null;
  title?: string | null;
  summary?: string | null;
  labelContext?: string | null;
  prompt?: string | null;
  relatedKeys?: readonly string[] | null;
  branchHint?: string | null;
}): RadarLink[] {
  const candidates: ParsedLinkCandidate[] = [];

  if (input.attachedLinks) {
    for (const l of input.attachedLinks) {
      if (!l?.url) continue;
      const p = classifyUrl(l.url, true, l.label, true, l.kind);
      if (p) candidates.push(p);
    }
  }

  if (input.url) {
    const p = classifyUrl(input.url, true);
    if (p) candidates.push(p);
  }

  if (input.links) {
    for (const l of input.links) {
      if (!l?.url) continue;
      const p = classifyUrl(l.url, true, l.label, false, l.kind);
      if (p) candidates.push(p);
    }
  }

  if (input.secondaryUrl) {
    const p = classifyUrl(input.secondaryUrl, true, "Slack");
    if (p) candidates.push(p);
  }

  if (input.extraLinks) {
    for (const l of input.extraLinks) {
      if (!l?.url) continue;
      const p = classifyUrl(l.url, true, l.label, false, l.kind);
      if (p) candidates.push(p);
    }
  }

  const textBlob = [...(input.relatedKeys ?? []), input.title, input.summary, input.prompt]
    .filter(Boolean)
    .join("\n")
    .replace(/\\~/g, "~");

  if (textBlob) {
    for (const m of textBlob.matchAll(ANY_URL_RE)) {
      const p = classifyUrl(m[0], false);
      if (p) candidates.push(p);
    }

    const linearBase = inferLinearOrgBase(candidates);
    if (linearBase) {
      for (const m of textBlob.matchAll(ISSUE_TOKEN_RE)) {
        const prefix = m[1]!;
        const num = m[2]!;
        if (!NON_ISSUE_PREFIXES.has(prefix)) {
          const ident = `${prefix}-${num}`;
          candidates.push({
            dedupeKey: `issue:${ident.toLowerCase()}`,
            kind: "linear",
            baseLabel: ident,
            labelSource: "platform",
            url: `${linearBase}/issue/${ident}`,
          });
        }
      }
    }
  }

  const linearBase = inferLinearOrgBase(candidates);
  if (input.branchHint && linearBase) {
    for (const m of input.branchHint.matchAll(ISSUE_BRANCH_TOKEN_RE)) {
      const prefix = m[1]!.toUpperCase();
      if (!NON_ISSUE_PREFIXES.has(prefix)) {
        const ident = `${prefix}-${m[2]!}`;
        candidates.push({
          dedupeKey: `issue:${ident.toLowerCase()}`,
          kind: "linear",
          baseLabel: ident,
          labelSource: "platform",
          url: `${linearBase}/issue/${ident}`,
        });
      }
    }
  }

  for (const { rule, key, m } of [
    ...templateMatches(textBlob, "token"), ...templateMatches(input.branchHint ?? "", "branch"),
  ]) {
    if (!rule.urlTemplate) continue;
    const url = expand(rule.urlTemplate, m);
    if (!/^https?:\/\//i.test(url)) continue;
    candidates.push({ dedupeKey: key, kind: rule.kind, url, baseLabel: expand(rule.labelTemplate, m),
      subId: rule.subIdTemplate ? expand(rule.subIdTemplate, m) : undefined, labelSource: "platform" });
  }

  enrichDerivedLinkLabels(candidates, {
    title: input.title,
    summary: input.summary,
    labelContext: input.labelContext,
    prompt: input.prompt,
  });

  const filtered =
    input.removedLinkKeys && input.removedLinkKeys.length > 0
      ? (() => {
          const removedSet = new Set(input.removedLinkKeys);
          return candidates.filter(
            (c) => !removedSet.has(c.dedupeKey) && !removedSet.has(`raw:${c.url.toLowerCase()}`),
          );
        })()
      : candidates;

  return finalizeCandidates(filtered);
}

/**
 * Unifies legacy split Linear IDs (`linear-todo-ops-1048` / `linear-close-ops-1048`)
 * into a single stable card ID (`linear-issue-ops-1048`).
 */
export function normalizeCardId(id: string | null | undefined): string {
  if (!id) return "";
  const m = id.match(/^linear-(?:todo|close)-(.+)$/);
  if (m?.[1]) {
    return `linear-issue-${m[1].toLowerCase()}`;
  }
  return id;
}

export function normalizeEntityKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed) return "";
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    const rest = trimmed.slice(colonIdx + 1).trim();
    if (!rest) return "";
    return `${prefix}:${rest.toLowerCase()}`;
  }
  return trimmed.toLowerCase();
}

/**
 * Extracts raw tokens (`ENG-204`, `!42`) suitable for `relatedKeys`
 * and workspace strong-token claiming.
 */
export function extractRelatedTokens(...inputs: Array<string | null | undefined>): string[] {
  const blob = inputs.filter(Boolean).join("\n").replace(/\\~/g, "~");
  if (!blob) return [];

  const out = new Set<string>();

  for (const m of blob.matchAll(ISSUE_TOKEN_RE)) {
    const prefix = m[1]!;
    if (!NON_ISSUE_PREFIXES.has(prefix)) {
      out.add(`${prefix}-${m[2]!}`);
    }
  }

  for (const m of blob.matchAll(GITLAB_MR_URL_RE)) {
    out.add(`!${m[2]!}`);
    out.add(cleanExtractedUrl(m[0]));
  }

  for (const m of blob.matchAll(GITHUB_PR_OR_ISSUE_URL_RE)) {
    out.add(`${m[1]}#${m[3]}`);
    out.add(cleanExtractedUrl(m[0]));
  }

  for (const m of blob.matchAll(BARE_MR_RE)) {
    out.add(`!${m[1]!}`);
  }

  for (const { m } of templateMatches(blob, "token")) out.add(m[1] ?? m[0]);

  return [...out];
}

/**
 * Extracts canonical entity fingerprints (`issue:ops-1048`, `mr:repo!18246`, `gh:org/repo#42`)
 * for deterministic cross-source and custom-card deduplication.
 */
export function extractCanonicalEntityKeys(input: {
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
}): Set<string> {
  const keys = new Set<string>();

  if (input.entityKeys) {
    for (const ek of input.entityKeys) {
      const norm = normalizeEntityKey(ek);
      if (norm) keys.add(norm);
    }
  }

  if (input.cardId) {
    const cid = input.cardId.trim();
    const linMatch = cid.match(/^linear-(?:issue|todo|close)-([a-z]{2,8}-\d{1,6})$/i);
    if (linMatch?.[1]) {
      keys.add(`issue:${linMatch[1].toLowerCase()}`);
    }
    const glMatch = cid.match(/^gitlab-(?:own|review)-(\d+)-(\d+)$/i);
    if (glMatch?.[1] && glMatch[2]) {
      const iid = glMatch[2];
      if (iid.length >= 3) {
        keys.add(`mr:!${iid}`);
      }
    }
    for (const { key } of templateMatches(cid, "card")) keys.add(key);
  }

  if (input.branchHint) {
    for (const m of input.branchHint.matchAll(ISSUE_BRANCH_TOKEN_RE)) {
      const prefix = m[1]!.toUpperCase();
      if (!NON_ISSUE_PREFIXES.has(prefix)) {
        keys.add(`issue:${m[1]!.toLowerCase()}-${m[2]!}`);
      }
    }
  }

  const parts = [
    input.title,
    input.summary,
    input.url,
    input.secondaryUrl,
    ...(input.links?.map((l) => l.url) ?? []),
    input.prompt,
    ...(input.relatedKeys ?? []),
    input.branchHint,
  ];
  const blob = parts.filter(Boolean).join("\n").replace(/\\~/g, "~");
  if (!blob) return keys;

  for (const m of blob.matchAll(ISSUE_TOKEN_RE)) {
    const prefix = m[1]!;
    if (!NON_ISSUE_PREFIXES.has(prefix)) {
      keys.add(`issue:${prefix.toLowerCase()}-${m[2]!}`);
    }
  }

  for (const m of blob.matchAll(GITLAB_MR_URL_RE)) {
    const repo = m[1]!.toLowerCase();
    const iid = m[2]!;
    keys.add(`mr:${repo}!${iid}`);
    const segs = repo.split("/");
    if (segs.length === 2 && segs[0] === segs[1] && iid.length >= 3) {
      keys.add(`mr:!${iid}`);
    }
  }

  for (const m of blob.matchAll(GITHUB_PR_OR_ISSUE_URL_RE)) {
    keys.add(`gh:${m[1]!.toLowerCase()}#${m[3]!}`);
  }

  for (const m of blob.matchAll(BARE_MR_RE)) {
    keys.add(`mr:!${m[1]!}`);
  }

  for (const { key } of templateMatches(blob, "token")) keys.add(key);
  for (const { key } of templateMatches(input.branchHint ?? "", "branch")) keys.add(key);
  for (const m of blob.matchAll(ANY_URL_RE)) {
    const url = cleanExtractedUrl(m[0]);
    for (const { rule, regex } of registry.matchers) {
      const match = regex.exec(url);
      if (!match) continue;
      if (rule.entityKeyTemplate) {
        const key = normalizeEntityKey(expand(rule.entityKeyTemplate, match));
        if (key) keys.add(key);
      }
      break;
    }
  }

  return keys;
}

export function setsIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const k of a) {
    if (b.has(k)) return true;
  }
  return false;
}

function normalizeTitleForCompare(title: string): string {
  return title
    .toLowerCase()
    .replace(/^draft:\s*/i, "")
    .replace(/\[p\d\]/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export function isSameNormalizedTitle(a: string, b: string): boolean {
  const na = normalizeTitleForCompare(a);
  const nb = normalizeTitleForCompare(b);
  if (na.length < 6 || nb.length < 6) return na !== "" && na === nb;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 10 && longer.includes(shorter);
}
