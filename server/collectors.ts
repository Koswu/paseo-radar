import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import type { RadarCollectorStatus, RadarLink } from "../shared/radar";
import {
  ARCHETYPE_AUTHORITY_RANK,
  ProvidersConfigFileSchema,
  type EntitySignal,
  type ProviderEntryConfig,
  type ProviderItem,
  type ProviderManifest,
  type ProviderProtocolKind,
  type ProviderWaitCheckResult,
  type WaitPredicate,
} from "../shared/provider-protocol";
import {
  cleanExtractedUrl,
  configureEntityRegistry,
  extractCanonicalEntityKeys,
  isDeterministicClaimEntityKey,
  mergeRadarLinks,
  normalizeCardId,
  normalizeEntityKey,
  resolveItemLinks,
} from "./entity-keys";
import { mergeItemContexts, mergeItemHints } from "./kickoff-prompt";
import { LegacyScriptAdapter, providerHost, type ProviderLaunch } from "./provider-host";
import {
  collectorsConfigPath,
  collectorsDir,
  collectorsSpecPath,
  collectorsStateDir,
  ensureRadarHome,
  paseoHome,
  providerSdkPath,
  providersConfigPath,
  providersDir,
  providersSpecPath,
  providersStateDir,
  readCustomDomainRules,
  readRadarRules,
  readRadarState,
  rulesFilePath,
  updateRadarRules,
  type PersistedCollectorDiag,
  type RadarRules,
  type RawScannedItem,
} from "./store";
import { buildExtendedEnv, resolveUvBinary } from "./runtime-env";
import { DEFAULT_COLLECTORS_CONFIG } from "./collector-seeds";
import { resolveEffectiveTimeZone } from "./wait-utils";

function expandRepoHome(p: string | null | undefined): string | null {
  if (!p) return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export type CollectorScriptStatus = RadarCollectorStatus;
type Config = Record<string, unknown>;

interface Collector {
  filename: string;
  configKey: string;
  configPath: string;
  path: string;
  description: string | null;
  protocol: ProviderProtocolKind;
  disabledReason: "prefix" | "config" | null;
  launch: ProviderLaunch;
  manifest?: ProviderManifest;
  error?: string;
}

interface SingleCollectorResult {
  durationMs: number;
  items: RawScannedItem[];
  entitySignals: EntitySignal[];
  warnings: string[];
}

const lastRunDiagnostics = new Map<string, PersistedCollectorDiag>();
const runningCollectors = new Map<string, string>();
const healthResults = new Map<string, { signature: string; ok: boolean; message: string | null }>();
const scriptMetadata = new Map<string, { mtimeMs: number; description: string | null; protocol: ProviderProtocolKind }>();

function parseDocstringSummary(source: string): string | null {
  const lines = source.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      idx += 1;
      continue;
    }
    break;
  }
  const rest = lines.slice(idx).join("\n").trimStart();
  const quote = rest.startsWith('"""') ? '"""' : rest.startsWith("'''") ? "'''" : null;
  if (!quote) return null;
  const body = rest.slice(3);
  const endIdx = body.indexOf(quote);
  const block = endIdx >= 0 ? body.slice(0, endIdx) : body;
  for (const line of block.split(/\r?\n/)) {
    const clean = line.trim();
    if (clean) return clean.slice(0, 90);
  }
  return null;
}

function collectorStem(filename: string): string {
  return filename.replace(/\.(py|mjs)$/i, "");
}

function record(value: unknown): Config {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Config : {};
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readConfig(path: string): Promise<Config | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as Config;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path}: ${errorText(e)}`);
  }
}

async function scriptNames(dir: string, legacy: boolean): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(e => e.isFile() && !e.name.startsWith(".") && e.name !== "radar_provider.py" &&
        (legacy ? e.name.endsWith(".py") : !e.name.startsWith("_") && /\.(py|mjs)$/.test(e.name)))
      .map(e => e.name).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function inspectScript(path: string) {
  const { mtimeMs } = await stat(path);
  const cached = scriptMetadata.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const source = await readFile(path, "utf8");
  const protocol: ProviderProtocolKind = /\bradar_provider\b|json[-_ ]?rpc|provider\/initialize/i.test(source) ? "jsonrpc" : "legacy";
  const metadata = { mtimeMs, protocol, description: parseDocstringSummary(source.slice(0, 4096)) };
  scriptMetadata.set(path, metadata);
  return metadata;
}

async function discoverCollectors() {
  await ensureRadarHome();
  const dir = providersDir();
  const [newFile, oldFile, files, oldFiles, uv, sdk] = await Promise.all([
    readConfig(providersConfigPath()), readConfig(collectorsConfigPath()),
    scriptNames(dir, false), scriptNames(collectorsDir(), true), resolveUvBinary(), stat(providerSdkPath()),
  ]);
  const modern = ProvidersConfigFileSchema.parse(newFile ?? {});
  const legacy = oldFile ?? {};
  const primaryConfig = newFile || files.length ? providersConfigPath() : collectorsConfigPath();
  const candidates: Array<{ filename: string; key: string; path?: string; entry?: ProviderEntryConfig; old?: boolean }> = [];
  const claimed = new Set<string>();

  for (const [key, entry] of Object.entries(modern.providers)) {
    if (key !== basename(key) || /^[._]/.test(key) || key === "radar_provider.py") continue;
    // Configured commands may point outside the auto-discovery directory. Inspect
    // their script as well, so a protocol/mtime change invalidates the manifest.
    const ref = [entry.command, ...(entry.args ?? [])].find(a => a && !a.startsWith("-") && /\.(py|mjs)$/.test(a));
    const localFile = files.find(f => f === key || collectorStem(f) === key);
    const path = ref ? resolve(dir, ref) : localFile ? join(dir, localFile) : undefined;
    const filename = path && dirname(path) === dir ? basename(path) : key;
    candidates.push({ filename, key, entry, path });
    claimed.add(collectorStem(key));
    claimed.add(collectorStem(filename));
  }
  for (const filename of files) {
    const key = collectorStem(filename);
    if (claimed.has(key)) continue;
    candidates.push({ filename, key, path: join(dir, filename) });
    claimed.add(key);
  }
  for (const filename of oldFiles) {
    const key = collectorStem(filename);
    if (!claimed.has(key)) candidates.push({ filename, key, path: join(collectorsDir(), filename), old: true });
  }

  if (candidates.some(c => !c.old)) await mkdir(providersStateDir(), { recursive: true });
  const collectors = await Promise.all(candidates.map(async ({ filename, key, path, entry, old }): Promise<Collector> => {
    const globals = old ? legacy : modern;
    const globalConfig = {
      defaultRepoPath: typeof globals.defaultRepoPath === "string" ? globals.defaultRepoPath : "",
      issueTeamPrefixes: Array.isArray(globals.issueTeamPrefixes) ? globals.issueTeamPrefixes : [],
    };
    const config = old ? record(legacy[key]) : entry?.config ?? {};
    const configPath = old ? collectorsConfigPath() : providersConfigPath();
    const env = buildExtendedEnv({
      ...entry?.env,
      PASEO_HOME: paseoHome(),
      RADAR_COLLECTORS_CONFIG: configPath,
      RADAR_COLLECTOR_STATE_DIR: old ? collectorsStateDir() : providersStateDir(),
      PYTHONPATH: [dir, entry?.env?.PYTHONPATH ?? process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    });
    let command = entry?.command ?? (path?.endsWith(".mjs") ? process.execPath : uv);
    if (command.startsWith("./") || (path && resolve(dir, command) === path)) command = resolve(dir, command);
    const args = entry?.args?.map(arg => arg.startsWith("./") || (path && resolve(dir, arg) === path) ? resolve(dir, arg) : arg)
      ?? (entry?.command ? [] : path?.endsWith(".mjs") ? [path] : path ? ["run", "--script", path] : []);
    let meta: Awaited<ReturnType<typeof inspectScript>> | undefined;
    let error: string | undefined;
    try {
      if (path) meta = await inspectScript(path);
      else if (!entry?.command) throw new Error(`No provider script or command for ${key}`);
    } catch (e) {
      error = errorText(e);
    }
    const protocol = meta?.protocol ?? "jsonrpc";
    const lifecycle = protocol === "legacy" ? "oneshot" : entry?.lifecycle ?? "oneshot";
    const signature = createHash("sha256").update(JSON.stringify([
      path, meta?.mtimeMs, protocol === "jsonrpc" ? sdk.mtimeMs : null, command, args, entry?.env, lifecycle, config, globalConfig,
    ])).digest("hex");
    return {
      filename, configKey: key, configPath, path: path ?? command, description: meta?.description ?? null, protocol, error,
      disabledReason: filename.startsWith("_") ? "prefix" : (old ? config.enabled : entry?.enabled) === false ? "config" : null,
      launch: { key: join(old ? collectorsDir() : dir, key), signature, command, args, env, config, globalConfig, lifecycle },
    };
  }));
  return { collectors, primaryConfig };
}

let generation = 0;
async function loadCatalog() {
  const epoch = generation;
  const [catalog, domainRules] = await Promise.all([discoverCollectors(), readCustomDomainRules()]);
  if (epoch !== generation) throw new Error("Provider discovery interrupted");
  const enabled = catalog.collectors.filter(c => !c.disabledReason && !c.error && c.protocol === "jsonrpc");
  providerHost.retainDaemons(enabled.filter(c => c.launch.lifecycle === "daemon").map(c => c.launch.key));
  await Promise.all(enabled.map(async c => {
    try { c.manifest = await providerHost.manifest(c.launch); }
    catch (err) { c.error = errorText(err); }
  }));
  if (epoch !== generation) throw new Error("Provider discovery interrupted");
  configureEntityRegistry({ manifests: enabled.flatMap(c => c.manifest ? [c.manifest] : []), domainRules });
  return catalog;
}

function findCollector(collectors: Collector[], key: string) {
  const c = collectors.find(c => c.filename === key || c.path === key || c.configKey === key);
  if (!c) throw new Error(`Unknown provider: ${key}`);
  return c;
}

export async function startDaemonProviders(onChanged: () => void): Promise<void> {
  providerHost.setChangeListener(onChanged);
  await loadCatalog();
}

export function stopDaemonProviders(): void {
  generation++;
  providerHost.setChangeListener(null);
  providerHost.stop();
}

export async function checkProviderWaitCondition(providerId: string, predicate: WaitPredicate): Promise<ProviderWaitCheckResult> {
  const { collectors } = await loadCatalog();
  const enabled = collectors.filter(c => !c.disabledReason);
  const c = enabled.find(c => c.manifest?.id === providerId) ?? findCollector(enabled, providerId);
  if (c.error || !c.manifest?.capabilities.wait) throw new Error(c.error ?? `Provider does not support wait: ${providerId}`);
  return providerHost.wait(c.launch, predicate);
}

export async function checkCollectorHealth(filename: string) {
  const start = Date.now();
  let collector: Collector | undefined;
  let ok = false;
  let message: string | null = null;
  let identity: string | null = null;
  try {
    collector = findCollector((await loadCatalog()).collectors, filename);
    if (collector.error || !collector.manifest?.capabilities.health) {
      throw new Error(collector.error ?? "Provider unavailable or health check unsupported");
    }
    ({ ok, identity, message } = await providerHost.health(collector.launch));
  } catch (err) { message = errorText(err); }
  if (collector) healthResults.set(collector.launch.key, { signature: collector.launch.signature, ok, message });
  return { filename, ok, message, identity, durationMs: Date.now() - start };
}

function normalizeItem(raw: ProviderItem & { prepPrompt?: string; workPrompt?: string }, c: Collector, now: string): RawScannedItem {
  const id = normalizeCardId(raw.id.trim());
  const providerId = c.manifest?.id ?? collectorStem(c.configKey);
  const source = (raw.source?.trim() || providerId).toLowerCase();
  const links = raw.links?.map(l => ({ ...l, url: cleanExtractedUrl(l.url) })).filter(l => l.url);
  const preservePrompts = c.protocol === "legacy" || source === "custom";
  return {
    id, providerId, source,
    // The kickoff builder uses absent archetype/intent to identify legacy prompt overrides.
    archetype: c.protocol === "legacy" && raw.prepPrompt ? undefined : raw.archetype,
    intent: c.protocol === "legacy" && raw.prepPrompt ? undefined : raw.intent,
    group: raw.group, badge: raw.badge.trim() || source, title: raw.title.trim(), summary: raw.summary.trim(),
    url: cleanExtractedUrl(raw.url || links?.[0]?.url || ""),
    secondaryUrl: raw.secondaryUrl ? cleanExtractedUrl(raw.secondaryUrl) : null, links,
    updatedAt: raw.updatedAt?.trim() || now, stateHash: raw.stateHash.trim(),
    entityKeys: raw.entityKeys?.map(normalizeEntityKey).filter(Boolean), relatedKeys: raw.relatedKeys?.filter(Boolean),
    scanText: raw.scanText, context: raw.context, hint: raw.hint,
    promoteToClosingWhen: raw.promoteToClosingWhen, closureGate: raw.closureGate,
    repoPath: expandRepoHome(raw.workspaceHint?.repoPath), existingBranch: raw.workspaceHint?.existingBranch ?? null,
    preferWorktree: raw.workspaceHint?.preferWorktree,
    branchSlug: raw.workspaceHint?.branchSlug?.trim() || id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "task",
    roleHint: raw.roleHint ?? null, recommendedModel: raw.recommendedModel ?? null,
    prepLabel: raw.prepLabel?.trim() || "后台先查", workLabel: raw.workLabel?.trim() || "开会话处理 ↗",
    prepPrompt: preservePrompts ? raw.prepPrompt?.trim() ?? "" : "",
    workPrompt: preservePrompts ? (raw.workPrompt ?? raw.prepPrompt)?.trim() ?? "" : "",
  };
}

async function executeCollector(
  c: Collector, now: string, rules: RadarRules, timeZone?: string | null, knownHashes: Record<string, string> = {},
): Promise<SingleCollectorResult> {
  if (c.error) throw new Error(c.error);
  const start = Date.now();
  runningCollectors.set(c.filename, new Date(start).toISOString());
  try {
    const params = {
      now, timezone: resolveEffectiveTimeZone(timeZone), knownHashes, cursor: null,
      globalConfig: c.launch.globalConfig,
      rules: { mutedKeywords: rules.mutedKeywords, mutedChannels: rules.mutedChannels, mutedItemIds: rules.mutedItemIds },
    };
    const result = c.protocol === "legacy"
      ? await LegacyScriptAdapter.sync(c.launch, {
          ...params, rules, configPath: c.configPath, stateDir: c.launch.env.RADAR_COLLECTOR_STATE_DIR,
        })
      : await providerHost.sync(c.launch, params);
    return {
      durationMs: Date.now() - start, items: result.items.map(i => normalizeItem(i, c, now)),
      entitySignals: result.entitySignals, warnings: result.warnings,
    };
  } finally { runningCollectors.delete(c.filename); }
}

function entityKeys(item: RawScannedItem) {
  return extractCanonicalEntityKeys({
    ...item, cardId: item.id, branchHint: item.existingBranch, prompt: item.scanText,
  });
}

function enrichItemLinksAndPrompts(item: RawScannedItem): void {
  const resolved = resolveItemLinks({ ...item, branchHint: item.existingBranch, prompt: item.scanText });
  item.links = resolved;
  if (!item.url && resolved.length) item.url = resolved[0]!.url;
  item.entityKeys = [...entityKeys(item)];

  for (const field of ["prepPrompt", "workPrompt"] as const) {
    const cur = item[field];
    if (!cur) continue;
    const missing = resolved.filter(l => !cur.includes(l.url));
    if (missing.length) item[field] += `\n关联外部信源：\n${missing.map(l => `- ${l.label}: ${l.url}`).join("\n")}`;
  }
}

export function mergeSecondaryIntoPrimary(primary: RawScannedItem, secondary: RawScannedItem): void {
  primary.links = mergeRadarLinks(primary.links, resolveItemLinks({ ...secondary, branchHint: secondary.existingBranch, prompt: secondary.scanText }));
  primary.contexts = mergeItemContexts(primary, secondary);
  primary.hint = mergeItemHints(primary, secondary);
  primary.entityKeys = [...new Set([...(primary.entityKeys ?? []), ...(secondary.entityKeys ?? [])])];
  primary.relatedKeys = [...new Set([...(primary.relatedKeys ?? []), ...(secondary.relatedKeys ?? [])])];
  if (!primary.secondaryUrl) primary.secondaryUrl = secondary.secondaryUrl || (secondary.url !== primary.url ? secondary.url : null);
  enrichItemLinksAndPrompts(primary);
}

function deterministicMergeAndFilter(results: readonly SingleCollectorResult[], rules: RadarRules): RawScannedItem[] {
  const terminal = new Set<string>();
  const entityLinks = new Map<string, RadarLink[]>();
  for (const res of results) {
    for (const signal of res.entitySignals) {
      const key = normalizeEntityKey(signal.entityKey);
      if (signal.state === "terminal") terminal.add(key);
      if (signal.links) entityLinks.set(key, mergeRadarLinks(entityLinks.get(key), signal.links));
    }
  }

  const candidates: RawScannedItem[] = [];
  for (const res of results) {
    for (const raw of res.items) {
      const item = { ...raw };
      const rule = item.promoteToClosingWhen;
      if (rule) {
        if (rule.allEntitiesTerminal.every(k => terminal.has(normalizeEntityKey(k)))) {
          item.group = "closing";
          if (item.intent) item.intent = "close_out";
          if (rule.closingSummarySuffix) item.summary = [item.summary, rule.closingSummarySuffix].filter(Boolean).join(" · ");
          if (rule.closingHint) item.hint = mergeItemHints(item, { source: item.source, hint: rule.closingHint });
        } else if (rule.dropIfUnmet) continue;
      }
      for (const key of entityKeys(item)) {
        const links = entityLinks.get(key);
        if (!links) continue;
        item.links = mergeRadarLinks(item.links, links);
        item.relatedKeys = [...new Set([...(item.relatedKeys ?? []), ...links.map(l => l.url)])];
      }
      enrichItemLinksAndPrompts(item);
      candidates.push(item);
    }
  }

  const rank = (item: RawScannedItem) => ARCHETYPE_AUTHORITY_RANK[item.archetype ?? "work_item"];
  candidates.sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const kept: RawScannedItem[] = [];
  for (const item of candidates) {
    const primary = kept.find(p => {
      if (p.id === item.id) return true;
      const shared = item.entityKeys?.filter(k => p.entityKeys?.includes(k)) ?? [];
      if (!shared.length) return false;
      if (shared.some(isDeterministicClaimEntityKey) || p.archetype === "code_change" ||
          (p.archetype === "incident" && item.archetype === "message")) return true;
      if (p.archetype === "incident" && item.archetype === "work_item") {
        p.links = item.links = mergeRadarLinks(p.links, item.links);
      }
      return false;
    });
    if (primary) mergeSecondaryIntoPrimary(primary, item);
    else kept.push(item);
  }

  const mutedIds = new Set(rules.mutedItemIds?.map(normalizeCardId));
  const keywords = rules.mutedKeywords?.map(k => k.trim().toLowerCase()).filter(Boolean) ?? [];
  return kept.filter(item => {
    if (mutedIds.has(item.id)) return false;
    const text = [item.title, item.summary, item.url, item.scanText, ...(item.links ?? []).map(l => l.label + " " + l.url)].join(" ").toLowerCase();
    return !keywords.some(k => text.includes(k));
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listCollectorScripts(persistedDiags?: Record<string, PersistedCollectorDiag>) {
  const { collectors, primaryConfig } = await loadCatalog();
  const stored = persistedDiags ?? (await readRadarState().catch(() => null))?.collectorDiagnostics ?? {};
  const scripts: CollectorScriptStatus[] = collectors.map(c => {
    const startedAt = runningCollectors.get(c.filename) ?? null;
    const diag = lastRunDiagnostics.get(c.filename) ?? stored[c.filename];
    const health = healthResults.get(c.launch.key);
    return {
      filename: c.filename, path: c.path, name: collectorStem(c.configKey),
      displayName: c.manifest?.displayName ?? null, description: c.manifest?.description ?? c.description,
      protocol: c.protocol, lifecycle: c.launch.lifecycle, capabilities: c.manifest?.capabilities,
      healthOk: health?.signature === c.launch.signature ? health.ok : null,
      healthNote: health?.signature === c.launch.signature ? health.message : null,
      enabled: !c.disabledReason, disabledReason: c.disabledReason, running: !!startedAt, startedAt,
      lastRunAt: diag?.lastRunAt ?? null, durationMs: diag?.durationMs ?? null,
      itemCount: diag?.itemCount ?? null, deltaCount: diag?.deltaCount ?? null,
      warnings: diag?.warnings ?? [], error: c.error ?? diag?.error ?? null,
    };
  });
  scripts.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.filename.localeCompare(b.filename));
  const modern = primaryConfig === providersConfigPath();
  return { scripts, collectorsDir: modern ? providersDir() : collectorsDir(), configPath: primaryConfig,
    specPath: modern ? providersSpecPath() : collectorsSpecPath() };
}

export async function testCollectorScript(
  scriptNameOrPath: string,
  timeZone?: string | null,
): Promise<{
  ok: boolean;
  scriptPath: string;
  durationMs: number;
  itemCount: number;
  warnings: string[];
  sampleItems: Array<{
    id: string;
    source: string;
    group: string;
    badge: string;
    title: string;
    summary: string;
    url: string;
    roleHint: string | null | undefined;
    entityKeys: string[] | undefined;
  }>;
  error?: string;
}> {
  let resolvedPath = scriptNameOrPath;
  const startedMs = Date.now();
  try {
    const [{ collectors }, rules] = await Promise.all([loadCatalog(), readRadarRules()]);
    const c = findCollector(collectors, scriptNameOrPath);
    resolvedPath = c.path;
    // A manual dry run is allowed for a disabled script, but must not leave a daemon behind.
    const test = { ...c, launch: { ...c.launch, lifecycle: c.disabledReason ? "oneshot" as const : c.launch.lifecycle } };
    if (test.protocol === "jsonrpc" && !test.manifest && !test.error) test.manifest = await providerHost.manifest(test.launch);
    const res = await executeCollector(test, new Date().toISOString(), rules, timeZone);
    for (const it of res.items) enrichItemLinksAndPrompts(it);
    return {
      ok: true,
      scriptPath: resolvedPath,
      durationMs: res.durationMs,
      itemCount: res.items.length,
      warnings: res.warnings,
      sampleItems: res.items.slice(0, 8).map((i) => ({
        id: i.id,
        source: i.source,
        group: i.group,
        badge: i.badge,
        title: i.title,
        summary: i.summary,
        url: i.url,
        roleHint: i.roleHint,
        entityKeys: i.entityKeys,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      scriptPath: resolvedPath,
      durationMs: Date.now() - startedMs,
      itemCount: 0,
      warnings: [],
      sampleItems: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function setCollectorDiagnostic(filename: string, diag: PersistedCollectorDiag): void {
  lastRunDiagnostics.set(filename, diag);
}

export function clearCollectorDiagnosticAlert(filename?: string): void {
  if (filename) {
    const prev = lastRunDiagnostics.get(filename);
    if (prev) {
      lastRunDiagnostics.set(filename, { ...prev, warnings: [], error: null });
    }
    return;
  }
  for (const [k, prev] of lastRunDiagnostics.entries()) {
    if (prev.error || prev.warnings.length > 0) {
      lastRunDiagnostics.set(k, { ...prev, warnings: [], error: null });
    }
  }
}

export async function runAllCollectors(options?: {
  knownHashes?: ReadonlyMap<string, string>;
  persistedDiags?: Record<string, PersistedCollectorDiag>;
  timeZone?: string | null;
}): Promise<{
  scannedAt: string;
  items: RawScannedItem[];
  errors: string[];
  diagnostics: Record<string, PersistedCollectorDiag>;
}> {
  const [{ collectors }, rules] = await Promise.all([loadCatalog(), readRadarRules()]);
  const enabled = collectors.filter(c => !c.disabledReason);
  const scannedAt = new Date().toISOString();
  const knownHashes = options?.knownHashes;
  const fallbackHashes = Object.fromEntries(knownHashes ?? []);
  const persistedDiags = options?.persistedDiags;

  const settled = await Promise.allSettled(
    enabled.map((c) => {
      const { filename } = c;
      const prevDiag = lastRunDiagnostics.get(filename) ?? persistedDiags?.[filename];
      const prevHashes = prevDiag?.itemHashes;
      return executeCollector(c, scannedAt, rules, options?.timeZone, prevHashes ?? fallbackHashes).then(
        (val) => {
          const itemHashes: Record<string, string> = Object.create(null);
          let deltaCount = 0;
          for (const it of val.items) {
            if (it.id in itemHashes) continue;
            itemHashes[it.id] = it.stateHash;
            const baselineHash = prevHashes ? prevHashes[it.id] : knownHashes?.get(it.id);
            if (baselineHash !== it.stateHash) {
              deltaCount += 1;
            }
          }
          lastRunDiagnostics.set(filename, {
            lastRunAt: new Date().toISOString(),
            durationMs: val.durationMs,
            itemCount: val.items.length,
            deltaCount,
            itemHashes,
            warnings: val.warnings,
            error: null,
          });
          return val;
        },
        (reason: unknown) => {
          const msg = reason instanceof Error ? reason.message : String(reason);
          lastRunDiagnostics.set(filename, {
            lastRunAt: new Date().toISOString(),
            durationMs: null,
            itemCount: null,
            deltaCount: null,
            ...(prevHashes ? { itemHashes: prevHashes } : {}),
            warnings: [],
            error: msg,
          });
          throw reason;
        },
      );
    }),
  );

  const successes: SingleCollectorResult[] = [];
  const errors: string[] = [];

  settled.forEach((outcome, idx) => {
    const filename = enabled[idx]!.filename;
    if (outcome.status === "fulfilled") {
      const val = outcome.value;
      successes.push(val);
      for (const w of val.warnings) {
        errors.push(`${filename}: ${w}`);
      }
    } else {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      errors.push(`${filename}: ${msg}`);
    }
  });

  const items = deterministicMergeAndFilter(successes, rules);
  return {
    scannedAt,
    items,
    errors,
    diagnostics: Object.fromEntries(lastRunDiagnostics),
  };
}

async function writeConfig(cfgPath: string, nextCfg: Config): Promise<void> {
  await mkdir(dirname(cfgPath), { recursive: true });
  const tmp = `${cfgPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(nextCfg, null, 2)}\n`, "utf8");
  await rename(tmp, cfgPath);
}

export async function toggleCollectorScript(rawFilename: string, enabled: boolean): Promise<{ filename: string; enabled: boolean }> {
  const { collectors } = await discoverCollectors();
  const c = findCollector(collectors, rawFilename);
  const cfg = await readConfig(c.configPath) ?? {};
  const modern = c.configPath === providersConfigPath();
  const sections = modern ? record(cfg.providers) : cfg;
  let { filename, configKey } = c;
  if (enabled && c.disabledReason === "prefix") {
    const clean = filename.replace(/^_+/, "");
    if (collectors.some(it => it.filename === clean || it.configKey === collectorStem(clean))) throw new Error(`Provider already exists: ${clean}`);
    await rename(c.path, join(dirname(c.path), clean));
    lastRunDiagnostics.delete(filename);
    filename = clean;
    configKey = collectorStem(clean);
  }
  const section = { ...record(sections[configKey]), enabled };
  await writeConfig(c.configPath, modern
    ? { ...cfg, providers: { ...sections, [configKey]: section } }
    : { ...cfg, [configKey]: section });
  await loadCatalog();
  return { filename, enabled };
}

// The settings RPC carries one document. Prefer the provider document after migration;
// until then keep editing the existing collector file. Reading raw text also allows
// the settings editor to repair malformed JSON (unlike discovery, which fails closed).
async function activeConfigPath(): Promise<string> {
  if (await stat(providersConfigPath()).then(() => true, e => {
    if (e.code === "ENOENT") return false;
    throw e;
  }) || (await scriptNames(providersDir(), false)).length) return providersConfigPath();
  return collectorsConfigPath();
}

export async function loadCollectorConfigBundle(): Promise<{
  configPath: string;
  configJson: string;
  rulesPath: string;
  mutedKeywords: string[];
  mutedChannels: string[];
}> {
  await ensureRadarHome();
  const cfgPath = await activeConfigPath();
  const [rawCfgText, rules] = await Promise.all([
    readFile(cfgPath, "utf8").catch(err => {
      if (err.code !== "ENOENT") throw err;
      const defaults = cfgPath === providersConfigPath() ? ProvidersConfigFileSchema.parse({}) : DEFAULT_COLLECTORS_CONFIG;
      return JSON.stringify(defaults, null, 2);
    }),
    readRadarRules(),
  ]);
  let formatted = rawCfgText.trim();
  try {
    formatted = JSON.stringify(JSON.parse(rawCfgText), null, 2);
  } catch {
    // Keep raw text if user has minor formatting edits
  }
  return {
    configPath: cfgPath,
    configJson: formatted,
    rulesPath: rulesFilePath(),
    mutedKeywords: rules.mutedKeywords,
    mutedChannels: rules.mutedChannels,
  };
}

export async function saveCollectorConfigBundle(input: {
  configJson: string;
  mutedKeywords?: string[];
  mutedChannels?: string[];
}): Promise<{ ok: boolean }> {
  await ensureRadarHome();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.configJson);
  } catch (err) {
    throw new Error(
      `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config.json root must be a JSON object");
  }
  const cfg = parsed as Config;
  const path = await activeConfigPath();
  if (path === providersConfigPath()) ProvidersConfigFileSchema.parse(cfg);
  await writeConfig(path, cfg);

  if (input.mutedKeywords !== undefined || input.mutedChannels !== undefined) {
    await updateRadarRules((rules) => {
      if (input.mutedKeywords !== undefined) {
        rules.mutedKeywords = [...new Set(input.mutedKeywords.map((x) => x.trim()).filter(Boolean))];
      }
      if (input.mutedChannels !== undefined) {
        rules.mutedChannels = [...new Set(input.mutedChannels.map((x) => x.trim()).filter(Boolean))];
      }
    });
  }
  return { ok: true };
}

