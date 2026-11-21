import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { z } from "zod";
import { classifyUrl } from "./entity-keys.ts";
import {
  PROVIDER_PROTOCOL_VERSION, ProviderChangeMessageSchema, ProviderResponseSchema,
  ProviderManifestSchema, ProviderItemSchema, ProviderRawLinkSchema, ProviderSyncResultSchema,
  ProviderSyncParamsSchema, ProviderHealthResultSchema, ProviderWaitCheckResultSchema,
  type ProviderManifest, type ProviderChangedNotification, type ProviderSyncResult, type WaitPredicate,
} from "../shared/provider-protocol.ts";

export interface ProviderLaunch {
  key: string;
  signature: string; // mtime + config hash; never log config or env
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  config: Record<string, unknown>;
  globalConfig: Record<string, unknown>;
  lifecycle: "daemon" | "oneshot";
}
const TIMEOUT = 45_000;
const MAX_FRAME = 16 * 1024 * 1024;
function spawn(launch: ProviderLaunch) {
  return spawnProcess(launch.command, launch.args, { stdio: "pipe", env: launch.env, shell: false });
}
function kill(child: ReturnType<typeof spawn>) {
  void terminateProcess(child).catch(() => {});
}

/** One request table per process. A fatal framing/transport error rejects *all* its callers. */
class Session {
  readonly child: ReturnType<typeof spawn>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;
  private timeout: number;
  constructor(launch: ProviderLaunch, timeout: number, changed: (delta: ProviderChangedNotification) => void, disconnected: () => void) {
    this.timeout = timeout;
    const child = this.child = spawn(launch);
    let buffer = "", stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.ended) return;
      buffer += chunk;
      try {
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          if (newline > MAX_FRAME) throw new Error("Provider frame too large");
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.method === "notifications/changed") {
            changed(ProviderChangeMessageSchema.parse(msg).params);
            continue;
          }
          const response = ProviderResponseSchema.parse(msg);
          const p = typeof response.id === "number" && this.pending.get(response.id);
          if (!p) throw new Error("Unexpected provider response id");
          this.pending.delete(response.id as number);
          clearTimeout(p.timer);
          if ("error" in response) p.reject(new Error(`${response.error.code}: ${response.error.message}`));
          else p.resolve(response.result);
        }
        if (buffer.length > MAX_FRAME) throw new Error("Provider frame too large");
      } catch (e) { this.abort(new Error(`Invalid provider message: ${e instanceof Error ? e.message : e}`)); }
    });
    child.stdin.on("error", e => this.abort(e));
    child.on("error", e => this.abort(e));
    child.once("close", code => {
      this.abort(new Error(`Provider exited (${code}): ${stderr.trim()}`));
      disconnected();
    });
  }
  abort(e: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    kill(this.child);
  }
  finish() {
    this.child.stdin.end();
    if (this.ended) return;
    const timer = setTimeout(() => this.abort(new Error("Provider ignored EOF")), 500).unref();
    this.child.once("close", () => clearTimeout(timer));
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("Provider disconnected"));
    const id = ++this.nextId;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(new Error(`${method} timed out`)), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame);
    });
  }
}

interface Connection { session: Session; manifest: ProviderManifest }
interface Daemon {
  launch: ProviderLaunch;
  session?: Session;
  connecting?: Promise<Connection>;
  failures: number;
  retry?: NodeJS.Timeout;
}
interface Snapshot {
  signature: string;
  data?: ProviderSyncResult;
  deltas: ProviderChangedNotification[];
  scanning?: Promise<ProviderSyncResult>;
}
function applyDelta(base: ProviderSyncResult, items: ProviderSyncResult['items'], removed: string[], signals: ProviderSyncResult['entitySignals']) {
  const byId = new Map(base.items.map(it => [it.id, it]));
  for (const item of items) byId.set(item.id, item);
  for (const id of removed) byId.delete(id);
  const byKey = new Map(base.entitySignals.map(s => [s.entityKey, s]));
  for (const s of signals) byKey.set(s.entityKey, { ...byKey.get(s.entityKey), ...s });
  return { ...base, items: [...byId.values()], entitySignals: [...byKey.values()] };
}

export class ProviderHost {
  private timeout: number;
  private manifests = new Map<string, { signature: string; value: ProviderManifest }>();
  private daemons = new Map<string, Daemon>();
  private snapshots = new Map<string, Snapshot>();
  private changed: (() => void) | null = null;
  constructor(timeout = TIMEOUT) { this.timeout = timeout; }
  setChangeListener(fn: (() => void) | null) { this.changed = fn; }
  private snapshot(l: ProviderLaunch) {
    let s = this.snapshots.get(l.key);
    if (!s || s.signature !== l.signature) {
      s = { signature: l.signature, deltas: [] };
      this.snapshots.set(l.key, s);
    }
    return s;
  }
  private async initialize(l: ProviderLaunch, session: Session) {
    const manifest = ProviderManifestSchema.parse(await session.request("provider/initialize", {
      protocolVersion: PROVIDER_PROTOCOL_VERSION, config: l.config, globalConfig: l.globalConfig,
    }));
    if (manifest.protocolVersion !== PROVIDER_PROTOCOL_VERSION) throw new Error(`Unsupported provider protocol ${manifest.protocolVersion}`);
    this.manifests.set(l.key, { signature: l.signature, value: manifest });
    return { session, manifest };
  }
  private connect(d: Daemon): Promise<Connection> {
    if (d.connecting) return d.connecting;
    if (d.retry) return Promise.reject(new Error("Provider reconnect pending"));
    const l = d.launch;
    const session = new Session(l, this.timeout, delta => {
      if (this.daemons.get(l.key) !== d) return;
      // A notification can arrive in the same chunk as the initialize response.
      void d.connecting?.then(({ manifest }) => {
        if (manifest.capabilities.push && this.daemons.get(l.key) === d) {
          const s = this.snapshot(l);
          s.deltas.push(delta);
          // A provider can outpace the engine (e.g. during triage). Bound the
          // backlog; recover from overflow with an authoritative sync.
          if (s.deltas.length > 128) this.snapshots.delete(l.key);
          this.changed?.();
        }
      }).catch(() => {});
    }, () => {
      if (this.daemons.get(l.key) !== d) return;
      d.connecting = undefined;
      d.session = undefined;
      // Missed notifications after disconnection require an authoritative sync.
      this.snapshots.delete(l.key);
      const delay = Math.min(60_000, 500 * 2 ** Math.min(d.failures++, 7));
      d.retry = setTimeout(() => {
        d.retry = undefined;
        void Promise.resolve().then(() => this.connect(d)).then(() => this.changed?.()).catch(() => {});
      }, delay).unref();
    });
    d.session = session;
    d.connecting = this.initialize(l, session).catch(e => { session.abort(e); throw e; });
    return d.connecting;
  }
  private async use<T>(l: ProviderLaunch, fn: (c: Connection) => Promise<T>): Promise<T> {
    if (l.lifecycle === "daemon") {
      let d = this.daemons.get(l.key);
      if (d?.launch.signature !== l.signature) {
        if (d) this.dropDaemon(l.key, d);
        d = { launch: l, failures: 0 };
        this.daemons.set(l.key, d);
      }
      return fn(await this.connect(d!));
    }
    const session = new Session(l, this.timeout, () => {}, () => {});
    try { return await fn(await this.initialize(l, session)); }
    finally { session.finish(); }
  }
  private dropDaemon(key: string, d: Daemon) {
    this.daemons.delete(key);
    if (this.snapshots.get(key)?.signature === d.launch.signature) this.snapshots.delete(key);
    clearTimeout(d.retry);
    d.session?.abort(new Error("Provider stopped"));
  }
  retainDaemons(keys: string[]) {
    const retained = new Set(keys);
    for (const [key, d] of this.daemons) if (!retained.has(key)) this.dropDaemon(key, d);
  }
  stop() { this.changed = null; this.retainDaemons([]); this.snapshots.clear(); this.manifests.clear(); }
  async manifest(l: ProviderLaunch) {
    const cached = this.manifests.get(l.key);
    if (l.lifecycle !== "daemon" && cached?.signature === l.signature) return cached.value;
    return this.use(l, async c => c.manifest);
  }
  async health(l: ProviderLaunch) {
    return this.use(l, async ({ manifest, session }) => {
      if (!manifest.capabilities.health) throw new Error("Provider does not support health checks");
      return ProviderHealthResultSchema.parse(await session.request("provider/checkHealth", {}));
    });
  }
  async wait(l: ProviderLaunch, predicate: WaitPredicate) {
    return this.use(l, async ({ manifest, session }) => {
      if (!manifest.capabilities.wait) throw new Error("Provider does not support wait checks");
      return ProviderWaitCheckResultSchema.parse(await session.request("provider/checkWait", { predicate }));
    });
  }
  async sync(l: ProviderLaunch, params: unknown): Promise<ProviderSyncResult> {
    const s = this.snapshot(l);
    if (s.scanning) return s.scanning;
    s.scanning = (async () => {
      if (!s.data || !s.deltas.length) {
        const p = ProviderSyncParamsSchema.parse(params);
        const res = await this.use(l, async ({ session }) => ProviderSyncResultSchema.parse(await session.request("provider/sync", {
          ...p, cursor: s.data?.nextCursor ?? p.cursor,
        })));
        if (res.isFullSnapshot) s.data = res;
        else {
          const base = s.data ?? ProviderSyncResultSchema.parse({});
          s.data = { ...applyDelta(base, res.items, res.removedIds, res.entitySignals), warnings: res.warnings, nextCursor: res.nextCursor };
        }
        const daemon = this.daemons.get(l.key);
        if (daemon) daemon.failures = 0;
      }
      for (const d of s.deltas.splice(0)) s.data = applyDelta(s.data, d.upserts, d.removedIds, d.entitySignals);
      return s.data;
    })();
    try { return await s.scanning; } finally { s.scanning = undefined; }
  }
}
export const providerHost = new ProviderHost();

const LegacyItem = ProviderItemSchema.extend({
  source: z.string().min(1), prepPrompt: z.string(), workPrompt: z.string().optional(),
  mrUrls: z.array(z.string()).optional(), onlyIfMergedMrs: z.boolean().optional(),
  repoPath: z.string().nullable().optional(), existingBranch: z.string().nullable().optional(), branchSlug: z.string().optional(),
});
const LegacyOutput = z.object({
  items: z.array(LegacyItem).default([]), warnings: z.array(z.string()).default([]), errors: z.array(z.string()).default([]),
  signals: z.object({ mergedUrls: z.array(z.string()).optional(), entityLinks: z.record(z.string(), z.array(ProviderRawLinkSchema)).optional() }).optional(),
});
const urlKey = (url: string) => {
  const clean = url.trim().replace(/\/$/, "");
  return classifyUrl(clean, true)?.dedupeKey ?? `url:${clean.toLowerCase()}`;
};
export class LegacyScriptAdapter {
  static async sync(l: ProviderLaunch, params: unknown, timeout = TIMEOUT) {
    const child = spawn(l);
    const raw = await new Promise<string>((resolve, reject) => {
      let out = "", err = "";
      const fail = (e: Error) => { kill(child); reject(e); };
      const timer = setTimeout(() => fail(new Error("Legacy provider timed out")), timeout);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.setEncoding("utf8").on("data", chunk => {
        if (out.length <= MAX_FRAME) out += chunk;
        if (out.length > MAX_FRAME) fail(new Error("Legacy provider output too large"));
      });
      child.stderr.setEncoding("utf8").on("data", chunk => { err = (err + chunk).slice(-1000); });
      child.once("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`Legacy provider exited (${code}): ${err.trim()}`));
      });
      child.stdin.end(JSON.stringify(params));
    });
    const result = LegacyOutput.parse(JSON.parse(raw));
    return {
      isFullSnapshot: true, removedIds: [], warnings: [...result.warnings, ...result.errors],
      items: result.items.map(item => ({ ...item,
        workspaceHint: { repoPath: item.repoPath, existingBranch: item.existingBranch, branchSlug: item.branchSlug },
        promoteToClosingWhen: item.mrUrls?.length ? { allEntitiesTerminal: item.mrUrls.map(urlKey), dropIfUnmet: !!item.onlyIfMergedMrs } : undefined,
      })),
      entitySignals: [
        ...(result.signals?.mergedUrls ?? []).map(url => ({ entityKey: urlKey(url), state: "terminal" as const })),
        ...Object.entries(result.signals?.entityLinks ?? {}).map(([entityKey, links]) => ({ entityKey, links })),
      ],
    } satisfies ProviderSyncResult;
  }
}
