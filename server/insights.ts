import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { PluginHandlerContext } from "@getpaseo/plugin/server";

import {
  RADAR_LABELS,
  RadarInsightNarrativeSchema,
  type InsightDailyPoint,
  type InsightModelStat,
  type InsightProjectStat,
  type InsightRadarExecution,
  type InsightToolStat,
  type InsightWindow,
  type NeedsMeTag,
  type ProjectOption,
  type RadarInsightDeltas,
  type RadarInsightMetrics,
  type RadarInsightNarrative,
  type RadarInsightReport,
  type RadarInsightReportSummary,
  type RadarInsightStatus,
  WaitMode,
} from "../shared/radar";
import { normalizeCardId } from "./entity-keys";
import { ModelChainError, runOneShotPromptWithFallback } from "./llm-oneshot";
import { paseoHome, radarDataDir, readRadarState, type PersistedRadarState } from "./store";
import { formatModelErrorMessage } from "./summarizer";
import { resolveEffectiveTimeZone } from "./wait-utils";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

const MAX_SAVED_REPORTS = 20;
const MAX_TELEMETRY_EVENTS = 3000;
const MAX_SESSION_CACHE_ENTRIES = 1200;
const MAX_DEEP_SESSIONS = 400;
const MAX_TIMELINE_REFETCH_CLOSED = 20;

export type InsightTelemetryEvent =
  | { type: "turn_outcome"; at: string; outcome: "completed" | "failed" | "canceled"; model?: string; cardId?: string | null }
  | { type: "permission_resolved"; at: string; behavior: "allow" | "deny"; toolName?: string }
  | { type: "gate_rejected"; at: string; reason: "uncommitted_git" | "invalid_evidence"; cardId?: string | null }
  | { type: "needs_me_tagged"; at: string; tag: NeedsMeTag; cardId?: string | null }
  | { type: "decision_replied"; at: string; edited: boolean; cardId?: string | null }
  | { type: "wait_finished"; at: string; result: "matched" | "timed_out"; mode: WaitMode; cardId?: string | null }
  | { type: "goal_finished"; at: string; reason: "achieved" | "blocked" | "max_turns"; turns: number; cardId?: string | null };

interface SessionToolCounter {
  calls: number;
  failures: number;
}

interface CachedSessionFacet {
  cacheKey: string;
  agentId: string;
  parsedFrom: "jsonl" | "timeline" | "meta_only";
  userMessages: number;
  autoSteerMessages: number;
  firstPrompt: string;
  firstPromptChars: number;
  followUpPrompts: string[];
  assistantTurns: number;
  latestAssistantSnippet: string;
  toolCalls: number;
  failedToolCalls: number;
  tools: Record<string, SessionToolCounter>;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  hasError: boolean;
}

interface UnifiedAgentRecord {
  id: string;
  provider: string;
  model: string;
  cwd: string;
  workspaceId: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  labels: Record<string, string>;
  internal: boolean;
  nativeHandle: string | null;
  sessionId: string | null;
  pluginConversationId: string | null;
}

function insightsDir(): string {
  return join(radarDataDir(), "insights");
}

function insightsReportsHtmlDir(): string {
  return join(insightsDir(), "reports");
}

function sessionCachePath(): string {
  return join(insightsDir(), "session-cache.json");
}

function telemetryEventsPath(): string {
  return join(insightsDir(), "events.json");
}

function savedReportsPath(): string {
  return join(insightsDir(), "reports.json");
}

let insightIoQueue: Promise<unknown> = Promise.resolve();

function serializedInsightIo<T>(fn: () => Promise<T>): Promise<T> {
  const next = insightIoQueue.then(fn, fn);
  insightIoQueue = next.catch(() => {});
  return next;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export async function recordInsightEvent(event: InsightTelemetryEvent): Promise<void> {
  await serializedInsightIo(async () => {
    try {
      let events: InsightTelemetryEvent[] = [];
      try {
        const raw = JSON.parse(await readFile(telemetryEventsPath(), "utf8")) as unknown;
        if (Array.isArray(raw)) {
          events = raw as InsightTelemetryEvent[];
        }
      } catch {
        // Fresh events file
      }
      events.push(event);
      if (events.length > MAX_TELEMETRY_EVENTS) {
        events = events.slice(events.length - MAX_TELEMETRY_EVENTS);
      }
      await atomicWriteJson(telemetryEventsPath(), events);
    } catch (err) {
      console.warn("[paseo-radar] failed to record insight event:", err);
    }
  });
}

async function readTelemetryEvents(): Promise<InsightTelemetryEvent[]> {
  try {
    const raw = JSON.parse(await readFile(telemetryEventsPath(), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as InsightTelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

async function readSessionCache(): Promise<Record<string, CachedSessionFacet>> {
  try {
    const raw = JSON.parse(await readFile(sessionCachePath(), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, CachedSessionFacet>;
    }
  } catch {
    // Empty cache
  }
  return {};
}

async function writeSessionCache(cache: Record<string, CachedSessionFacet>): Promise<void> {
  const keys = Object.keys(cache);
  if (keys.length > MAX_SESSION_CACHE_ENTRIES) {
    const toDrop = keys.slice(0, keys.length - MAX_SESSION_CACHE_ENTRIES);
    for (const k of toDrop) delete cache[k];
  }
  await serializedInsightIo(() => atomicWriteJson(sessionCachePath(), cache));
}

async function readSavedReports(): Promise<RadarInsightReport[]> {
  try {
    const raw = JSON.parse(await readFile(savedReportsPath(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: RadarInsightReport[] = [];
    for (const item of raw) {
      const parsed = safeParseReport(item);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

function safeParseReport(raw: unknown): RadarInsightReport | null {
  if (!raw || typeof raw !== "object") return null;
  try {
    // Ensure backwards compatibility if minor fields evolve
    const obj = raw as RadarInsightReport;
    if (typeof obj.id === "string" && typeof obj.createdAt === "string" && obj.metrics && obj.narrative) {
      return obj;
    }
  } catch {
    // Ignore malformed entry
  }
  return null;
}

function toReportSummary(r: RadarInsightReport): RadarInsightReportSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    window: r.window,
    headline: r.narrative.headline,
    totalSessions: r.metrics.totalSessions,
    totalUserMessages: r.metrics.totalUserMessages,
    toolSuccessRate: r.metrics.toolSuccessRate,
    modelUsed: r.modelUsed ?? null,
  };
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_GH_TOKEN]")
    .replace(/\bglpat-[A-Za-z0-9\-_]{12,}\b/g, "[REDACTED_GL_TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9\-]{12,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\blin_api_[A-Za-z0-9]{16,}\b/g, "[REDACTED_LINEAR_KEY]")
    .replace(/\bsk-[A-Za-z0-9\-_]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, "Bearer [REDACTED]");
}

function cleanSingleLine(text: string, maxLen: number): string {
  const redacted = redactSensitiveText(text)
    .replace(/<USER_REQUEST>|<\/USER_REQUEST>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}…`;
}

function isAutoInjectedUserPrompt(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("[Radar 目标模式") ||
    t.startsWith("[系统回调：") ||
    t.startsWith("[已在 Radar 卡片确认授权") ||
    t.startsWith("[Radar 外部等待已达成") ||
    t.startsWith("[Radar 外部等待超时") ||
    t === "请继续完成上一轮失败的操作。"
  );
}

function decodeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isInternalUserExcludedAgent(rec: {
  internal?: boolean;
  cwd?: string | null;
  labels?: Record<string, string> | null;
}): boolean {
  if (rec.internal) return true;
  if (rec.cwd && rec.cwd.includes("/.paseo/plugin-data/")) return true;
  const labels = rec.labels ?? {};
  const role = labels[RADAR_LABELS.role];
  if (role === RADAR_LABELS.copilotRole || role === RADAR_LABELS.oneshotRole) return true;
  for (const [k, v] of Object.entries(labels)) {
    if ((k.endsWith(".role") && k !== RADAR_LABELS.role && v) || k.endsWith(".bot")) {
      return true;
    }
  }
  return false;
}

function formatFullModelSpec(provider: string, rawModel: string | null | undefined): string {
  const prov = (provider || "unknown").trim();
  const mod = (rawModel ?? "").trim();
  if (!mod) return prov;
  return mod.startsWith(`${prov}/`) ? mod : `${prov}/${mod}`;
}

async function walkJsonFiles(dir: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(full);
      }
    }
  }
  await walk(dir, 0);
  return out;
}

async function buildClaudeTranscriptIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const projectsDir = join(homedir(), ".claude", "projects");
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        map.set(e.name.slice(0, -6), full);
      }
    }
  }
  await walk(projectsDir, 0);
  return map;
}

function extractPluginConvId(persistence: unknown): string | null {
  if (!persistence || typeof persistence !== "object") return null;
  const meta = (persistence as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== "object") return null;
  const ppp = (meta as { pluginProviderPersistence?: unknown }).pluginProviderPersistence;
  if (!ppp || typeof ppp !== "object") return null;
  const data = (ppp as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const cid =
    (data as { conversationId?: unknown; sessionId?: unknown }).conversationId ??
    (data as { sessionId?: unknown }).sessionId;
  return typeof cid === "string" && cid.trim() ? cid.trim() : null;
}

async function discoverAllUserAgents(paseo: PaseoApi | null | undefined): Promise<UnifiedAgentRecord[]> {
  const byId = new Map<string, UnifiedAgentRecord>();

  if (paseo) {
    try {
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({
          page: cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
        });
        for (const entry of page.entries) {
          const a = entry.agent;
          const labels = (a.labels ?? {}) as Record<string, string>;
          const internal = Boolean((a as { internal?: boolean }).internal);
          if (isInternalUserExcludedAgent({ internal, cwd: a.cwd, labels })) continue;
          const persistence = (a.persistence ?? null) as {
            sessionId?: unknown;
            nativeHandle?: unknown;
            metadata?: unknown;
          } | null;
          const rawModel = a.runtimeInfo?.model || a.model || null;
          const updatedAt =
            (a as { lastActivityAt?: string | null }).lastActivityAt ||
            a.updatedAt ||
            (a as { createdAt?: string | null }).createdAt ||
            new Date().toISOString();
          const createdAt = (a as { createdAt?: string | null }).createdAt || updatedAt;

          byId.set(a.id, {
            id: a.id,
            provider: a.provider || "unknown",
            model: formatFullModelSpec(a.provider || "unknown", rawModel),
            cwd: a.cwd || "",
            workspaceId: a.workspaceId ?? null,
            title: decodeTitle(a.title) || a.id.slice(0, 8),
            status: a.status || "closed",
            createdAt,
            updatedAt,
            archivedAt: a.archivedAt ?? null,
            labels,
            internal,
            nativeHandle:
              typeof persistence?.nativeHandle === "string" ? persistence.nativeHandle : null,
            sessionId: typeof persistence?.sessionId === "string" ? persistence.sessionId : null,
            pluginConversationId: extractPluginConvId(persistence),
          });
        }
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor !== undefined);
    } catch (err) {
      console.warn("[paseo-radar] agents.list failed during insights discovery, falling back to disk:", err);
    }
  }

  // Supplement from ~/.paseo/agents/**/*.json on disk to catch any historical archived records
  const agentsDir = join(paseoHome(), "agents");
  const diskFiles = await walkJsonFiles(agentsDir, 2);
  for (const file of diskFiles) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : null;
      if (!id || byId.has(id)) continue;
      const internal = Boolean(raw.internal);
      const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
      const labels =
        raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)
          ? (raw.labels as Record<string, string>)
          : {};
      if (isInternalUserExcludedAgent({ internal, cwd, labels })) continue;

      const provider = typeof raw.provider === "string" ? raw.provider : "unknown";
      const rt = raw.runtimeInfo as { model?: unknown } | undefined;
      const cfg = raw.config as { model?: unknown } | undefined;
      const modelStr =
        (typeof rt?.model === "string" && rt.model) ||
        (typeof cfg?.model === "string" && cfg.model) ||
        null;
      const persistence = raw.persistence as {
        sessionId?: unknown;
        nativeHandle?: unknown;
        metadata?: unknown;
      } | null;
      const updatedAt =
        (typeof raw.lastActivityAt === "string" && raw.lastActivityAt) ||
        (typeof raw.updatedAt === "string" && raw.updatedAt) ||
        (typeof raw.createdAt === "string" && raw.createdAt) ||
        "";
      if (!updatedAt) continue;

      byId.set(id, {
        id,
        provider,
        model: formatFullModelSpec(provider, modelStr),
        cwd,
        workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : null,
        title: decodeTitle(typeof raw.title === "string" ? raw.title : "") || id.slice(0, 8),
        status: typeof raw.lastStatus === "string" ? raw.lastStatus : "closed",
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : updatedAt,
        updatedAt,
        archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
        labels,
        internal,
        nativeHandle: typeof persistence?.nativeHandle === "string" ? persistence.nativeHandle : null,
        sessionId: typeof persistence?.sessionId === "string" ? persistence.sessionId : null,
        pluginConversationId: extractPluginConvId(persistence),
      });
    } catch {
      // Skip unreadable file
    }
  }

  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readBoundedJsonlLines(filePath: string): Promise<{ lines: string[]; size: number; mtimeMs: number }> {
  const fh = await open(filePath, "r");
  try {
    const st = await fh.stat();
    if (st.size === 0) return { lines: [], size: 0, mtimeMs: st.mtimeMs };
    const maxFullRead = 3 * 1024 * 1024;
    if (st.size <= maxFullRead) {
      const buf = Buffer.alloc(st.size);
      await fh.read(buf, 0, st.size, 0);
      return { lines: buf.toString("utf8").split("\n"), size: st.size, mtimeMs: st.mtimeMs };
    }
    const headSize = 512 * 1024;
    const tailSize = 2 * 1024 * 1024;
    const headBuf = Buffer.alloc(headSize);
    const tailBuf = Buffer.alloc(tailSize);
    await fh.read(headBuf, 0, headSize, 0);
    await fh.read(tailBuf, 0, tailSize, st.size - tailSize);
    const headLines = headBuf.toString("utf8").split("\n");
    if (headLines.length > 1) headLines.pop();
    const tailLines = tailBuf.toString("utf8").split("\n");
    if (tailLines.length > 1) tailLines.shift();
    return {
      lines: [...headLines, ...tailLines],
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } finally {
    await fh.close();
  }
}

function normalizeToolName(rawName: string | undefined | null): string {
  const clean = (rawName ?? "").trim();
  if (!clean) return "unknown";
  return clean.replace(/^mcp__[^_]+__/, "").replace(/^default_api:/, "");
}

function addToolCount(
  map: Record<string, SessionToolCounter>,
  rawName: string | undefined | null,
  failed: boolean,
): void {
  const name = normalizeToolName(rawName);
  const cur = map[name] ?? { calls: 0, failures: 0 };
  cur.calls += 1;
  if (failed) cur.failures += 1;
  map[name] = cur;
}

function extractTextFromContentBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          parts.push(p.text.trim());
        }
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

function parsePiOrClaudeJsonlLines(
  agent: UnifiedAgentRecord,
  cacheKey: string,
  lines: readonly string[],
): CachedSessionFacet {
  let userMessages = 0;
  let autoSteerMessages = 0;
  let firstPrompt = "";
  let firstPromptChars = 0;
  const followUpPrompts: string[] = [];
  let assistantTurns = 0;
  let latestAssistantSnippet = "";
  let toolCalls = 0;
  let failedToolCalls = 0;
  const tools: Record<string, SessionToolCounter> = {};
  const toolNameByCallId = new Map<string, string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let hasError = agent.status === "error";

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = entry.type;

    // Pi format: { type: "message", message: { role: "user"|"assistant"|"toolResult", content, usage, stopReason } }
    if (entryType === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      const role = msg.role;
      if (role === "user") {
        const txt = extractTextFromContentBlocks(msg.content);
        if (!txt) continue;
        if (isAutoInjectedUserPrompt(txt)) {
          autoSteerMessages += 1;
        } else {
          userMessages += 1;
          const cleaned = cleanSingleLine(txt, 260);
          if (!firstPrompt) {
            firstPrompt = cleaned;
            firstPromptChars = txt.trim().length;
          } else if (followUpPrompts.length < 4 && cleaned) {
            followUpPrompts.push(cleanSingleLine(txt, 160));
          }
        }
      } else if (role === "assistant") {
        assistantTurns += 1;
        const txt = extractTextFromContentBlocks(msg.content);
        if (txt) latestAssistantSnippet = cleanSingleLine(txt, 220);
        if (msg.stopReason === "error") hasError = true;

        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part || typeof part !== "object") continue;
            const p = part as { type?: unknown; id?: unknown; name?: unknown };
            if (p.type === "toolCall" || p.type === "tool_use") {
              const tName = typeof p.name === "string" ? p.name : "tool";
              if (typeof p.id === "string") toolNameByCallId.set(p.id, tName);
              toolCalls += 1;
              addToolCount(tools, tName, false);
            }
          }
        }

        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          if (typeof usage.input === "number") inputTokens += usage.input;
          else if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens;
          if (typeof usage.output === "number") outputTokens += usage.output;
          else if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
          if (typeof usage.cacheRead === "number") cachedTokens += usage.cacheRead;
          else if (typeof usage.cache_read_input_tokens === "number") {
            cachedTokens += usage.cache_read_input_tokens;
          }
          if (typeof usage.cost === "number") costUsd += usage.cost;
          else if (usage.cost && typeof usage.cost === "object") {
            const totalCost = (usage.cost as { total?: unknown }).total;
            if (typeof totalCost === "number") costUsd += totalCost;
          }
        }
      } else if (role === "toolResult") {
        const isErr = Boolean(msg.isError);
        if (isErr) {
          failedToolCalls += 1;
          const tName =
            (typeof msg.toolName === "string" && msg.toolName) ||
            (typeof msg.toolCallId === "string" ? toolNameByCallId.get(msg.toolCallId) : undefined) ||
            "unknown";
          const norm = normalizeToolName(tName);
          if (tools[norm]) {
            tools[norm]!.failures += 1;
          } else {
            addToolCount(tools, norm, true);
          }
        }
      }
      continue;
    }

    // Claude Code JSONL format: { type: "user" | "assistant", message: { content, usage } }
    if ((entryType === "user" || entryType === "assistant") && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      if (entryType === "user") {
        if (Array.isArray(msg.content)) {
          let sawToolResult = false;
          for (const part of msg.content) {
            if (!part || typeof part !== "object") continue;
            const p = part as { type?: unknown; tool_use_id?: unknown; is_error?: unknown };
            if (p.type === "tool_result") {
              sawToolResult = true;
              if (p.is_error) {
                failedToolCalls += 1;
                const tName =
                  typeof p.tool_use_id === "string"
                    ? toolNameByCallId.get(p.tool_use_id) ?? "unknown"
                    : "unknown";
                const norm = normalizeToolName(tName);
                if (tools[norm]) tools[norm]!.failures += 1;
                else addToolCount(tools, norm, true);
              }
            }
          }
          if (sawToolResult) continue;
        }
        const txt = extractTextFromContentBlocks(msg.content);
        if (!txt) continue;
        if (isAutoInjectedUserPrompt(txt)) {
          autoSteerMessages += 1;
        } else {
          userMessages += 1;
          const cleaned = cleanSingleLine(txt, 260);
          if (!firstPrompt) {
            firstPrompt = cleaned;
            firstPromptChars = txt.trim().length;
          } else if (followUpPrompts.length < 4 && cleaned) {
            followUpPrompts.push(cleanSingleLine(txt, 160));
          }
        }
      } else {
        assistantTurns += 1;
        const txt = extractTextFromContentBlocks(msg.content);
        if (txt) latestAssistantSnippet = cleanSingleLine(txt, 220);
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part || typeof part !== "object") continue;
            const p = part as { type?: unknown; id?: unknown; name?: unknown };
            if (p.type === "tool_use") {
              const tName = typeof p.name === "string" ? p.name : "tool";
              if (typeof p.id === "string") toolNameByCallId.set(p.id, tName);
              toolCalls += 1;
              addToolCount(tools, tName, false);
            }
          }
        }
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
          if (typeof usage.cache_read_input_tokens === "number") {
            cachedTokens += usage.cache_read_input_tokens;
          }
        }
      }
      continue;
    }

    // Antigravity / AGY transcript.jsonl format: { type: "USER_INPUT" | "PLANNER_RESPONSE", status, content, tool_calls }
    if (entryType === "USER_INPUT") {
      const txt = typeof entry.content === "string" ? entry.content.trim() : "";
      if (!txt) continue;
      if (isAutoInjectedUserPrompt(txt)) {
        autoSteerMessages += 1;
      } else {
        userMessages += 1;
        const cleaned = cleanSingleLine(txt, 260);
        if (!firstPrompt) {
          firstPrompt = cleaned;
          firstPromptChars = cleaned.length;
        } else if (followUpPrompts.length < 4 && cleaned) {
          followUpPrompts.push(cleanSingleLine(cleaned, 160));
        }
      }
    } else if (entryType === "PLANNER_RESPONSE") {
      assistantTurns += 1;
      if (entry.status === "ERROR") hasError = true;
      const txt = typeof entry.content === "string" ? entry.content.trim() : "";
      if (txt) latestAssistantSnippet = cleanSingleLine(txt, 220);
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const tName =
            typeof (tc as { name?: unknown }).name === "string"
              ? ((tc as { name: string }).name)
              : typeof (tc as { tool_name?: unknown }).tool_name === "string"
                ? ((tc as { tool_name: string }).tool_name)
                : "tool";
          const isFailed = (tc as { status?: unknown }).status === "ERROR";
          toolCalls += 1;
          if (isFailed) failedToolCalls += 1;
          addToolCount(tools, tName, isFailed);
        }
      }
    }
  }

  return {
    cacheKey,
    agentId: agent.id,
    parsedFrom: "jsonl",
    userMessages,
    autoSteerMessages,
    firstPrompt,
    firstPromptChars,
    followUpPrompts,
    assistantTurns,
    latestAssistantSnippet,
    toolCalls,
    failedToolCalls,
    tools,
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
    cachedTokens: Math.round(cachedTokens),
    costUsd: Number(costUsd.toFixed(4)),
    hasError,
  };
}

async function resolveLocalJsonlPath(
  agent: UnifiedAgentRecord,
  claudeIndex: ReadonlyMap<string, string>,
): Promise<string | null> {
  if (agent.nativeHandle && agent.nativeHandle.endsWith(".jsonl")) {
    try {
      const st = await stat(agent.nativeHandle);
      if (st.isFile()) return agent.nativeHandle;
    } catch {
      // Fall through
    }
  }

  const agyId = agent.pluginConversationId || agent.sessionId;
  if (agyId) {
    const agyTranscript = join(
      homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      agyId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    try {
      const st = await stat(agyTranscript);
      if (st.isFile()) return agyTranscript;
    } catch {
      // Not an Antigravity brain transcript
    }
  }

  if (agent.sessionId && claudeIndex.has(agent.sessionId)) {
    return claudeIndex.get(agent.sessionId)!;
  }
  if (agent.nativeHandle && claudeIndex.has(agent.nativeHandle)) {
    return claudeIndex.get(agent.nativeHandle)!;
  }

  return null;
}

async function extractTimelineFacet(
  paseo: PaseoApi,
  agent: UnifiedAgentRecord,
  cacheKey: string,
): Promise<CachedSessionFacet | null> {
  try {
    const page = await Promise.race([
      paseo.agents.ref(agent.id).timeline.refetch({
        direction: "tail",
        limit: 90,
        projection: "projected",
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (!page) return null;

    let userMessages = 0;
    let autoSteerMessages = 0;
    let firstPrompt = "";
    let firstPromptChars = 0;
    const followUpPrompts: string[] = [];
    let assistantTurns = 0;
    let latestAssistantSnippet = "";
    let toolCalls = 0;
    let failedToolCalls = 0;
    const tools: Record<string, SessionToolCounter> = {};
    let hasError = agent.status === "error";

    for (const entry of page.entries) {
      const item = entry?.item as
        | { type?: string; text?: string; name?: string; status?: string; message?: string }
        | undefined;
      if (!item?.type) continue;
      if (item.type === "user_message" && typeof item.text === "string" && item.text.trim()) {
        const txt = item.text.trim();
        if (isAutoInjectedUserPrompt(txt)) {
          autoSteerMessages += 1;
        } else {
          userMessages += 1;
          const cleaned = cleanSingleLine(txt, 260);
          if (!firstPrompt) {
            firstPrompt = cleaned;
            firstPromptChars = txt.length;
          } else if (followUpPrompts.length < 4 && cleaned) {
            followUpPrompts.push(cleanSingleLine(txt, 160));
          }
        }
      } else if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) {
        assistantTurns += 1;
        latestAssistantSnippet = cleanSingleLine(item.text, 220);
      } else if (item.type === "tool_call") {
        toolCalls += 1;
        const failed = item.status === "failed";
        if (failed) failedToolCalls += 1;
        addToolCount(tools, item.name, failed);
      } else if (item.type === "error") {
        hasError = true;
      }
    }

    return {
      cacheKey,
      agentId: agent.id,
      parsedFrom: "timeline",
      userMessages,
      autoSteerMessages,
      firstPrompt,
      firstPromptChars,
      followUpPrompts,
      assistantTurns,
      latestAssistantSnippet,
      toolCalls,
      failedToolCalls,
      tools,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      hasError,
    };
  } catch {
    return null;
  }
}

function buildMetaOnlyFacet(agent: UnifiedAgentRecord, cacheKey: string): CachedSessionFacet {
  const fallbackPrompt = cleanSingleLine(agent.title, 180);
  return {
    cacheKey,
    agentId: agent.id,
    parsedFrom: "meta_only",
    userMessages: 1,
    autoSteerMessages: 0,
    firstPrompt: fallbackPrompt,
    firstPromptChars: fallbackPrompt.length,
    followUpPrompts: [],
    assistantTurns: 1,
    latestAssistantSnippet: "",
    toolCalls: 0,
    failedToolCalls: 0,
    tools: {},
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    hasError: agent.status === "error",
  };
}

function inferProjectNameForSession(
  cwd: string,
  projects: readonly ProjectOption[],
): string {
  const cleanCwd = cwd.replace(/\/+$/, "");
  if (!cleanCwd) return "Other";

  for (const p of projects) {
    const cleanRoot = p.path.replace(/\/+$/, "");
    if (cleanCwd === cleanRoot || cleanCwd.startsWith(`${cleanRoot}/`)) {
      return p.name;
    }
  }
  // Check worktree paths like ~/.paseo/worktrees/<repo>/<branch>
  const wtMatch = /\/\.paseo\/worktrees\/([^/]+)/.exec(cleanCwd);
  if (wtMatch?.[1]) {
    const slug = wtMatch[1];
    const matched = projects.find(
      (p) => basename(p.path).toLowerCase() === slug.toLowerCase(),
    );
    return matched?.name ?? slug;
  }

  return basename(cleanCwd) || "Other";
}

function formatDateInTimeZone(isoOrMs: string | number, timeZone: string): string {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${day}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function windowDurationDays(window: InsightWindow): number | null {
  if (window === "7d") return 7;
  if (window === "14d") return 14;
  if (window === "30d") return 30;
  return null;
}

function resolveCardForSession(
  agent: UnifiedAgentRecord,
  state: PersistedRadarState,
): { cardId: string; status: string; needsMeTag: NeedsMeTag | null; summary: string | null } | null {
  const explicitCard = agent.labels[RADAR_LABELS.card]
    ? normalizeCardId(agent.labels[RADAR_LABELS.card]!)
    : null;
  if (explicitCard && state.meta[explicitCard]) {
    const m = state.meta[explicitCard]!;
    return {
      cardId: explicitCard,
      status: m.customStatus ?? (agent.archivedAt ? "archived" : "needs_me"),
      needsMeTag: m.needsMeTag ?? null,
      summary: m.prepSummary ?? null,
    };
  }

  for (const [id, m] of Object.entries(state.meta)) {
    if (!m) continue;
    if (m.boundAgentId === agent.id || (agent.workspaceId && m.boundWorkspaceId === agent.workspaceId)) {
      return {
        cardId: id,
        status: m.customStatus ?? (agent.archivedAt ? "archived" : "needs_me"),
        needsMeTag: m.needsMeTag ?? null,
        summary: m.prepSummary ?? null,
      };
    }
  }

  if (agent.workspaceId && state.meta[`ws-${agent.workspaceId}`]) {
    const wsId = `ws-${agent.workspaceId}`;
    const m = state.meta[wsId]!;
    return {
      cardId: wsId,
      status: m.customStatus ?? (agent.archivedAt ? "archived" : "needs_me"),
      needsMeTag: m.needsMeTag ?? null,
      summary: m.prepSummary ?? null,
    };
  }

  return null;
}

interface SessionSampleForLlm {
  title: string;
  project: string;
  model: string;
  userMessages: number;
  autoSteers: number;
  toolCalls: number;
  failedTools: string[];
  firstPrompt: string;
  followUps: string[];
  radarOutcome: string;
  finalSummary: string;
}

function extractJsonObjectFromText(raw: string): unknown {
  const trimmed = raw.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenceMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model output did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildFallbackNarrative(
  metrics: RadarInsightMetrics,
  isZh: boolean,
): RadarInsightNarrative {
  const topProject = metrics.projects[0]?.name ?? (isZh ? "本地工作区" : "local workspaces");
  const topModel = metrics.models[0]?.model ?? "Auto";
  const topFailedTool = [...metrics.topTools].sort((a, b) => b.failures - a.failures)[0];
  const steerRatio =
    metrics.analyzedSessions > 0
      ? Math.round((metrics.multiTurnSteerSessions / metrics.analyzedSessions) * 100)
      : 0;

  if (!isZh) {
    return {
      headline:
        metrics.totalSessions === 0
          ? "No recent agent sessions recorded in this window yet"
          : `Collaborated across ${metrics.totalSessions} sessions (${metrics.toolSuccessRate}% tool reliability) centered on ${topProject}`,
      executiveSummary:
        metrics.totalSessions === 0
          ? "Start tasks from the Radar Pool or open a Paseo workspace session to accumulate interaction and execution metrics."
          : `Across ${metrics.activeDays} active day(s), you sent ${metrics.totalUserMessages} messages (${metrics.avgUserMessagesPerSession} per session) and executed ${metrics.totalToolCalls} tool calls. Radar tracked ${metrics.radarExecution.cardsArchived} archived closures and ${metrics.radarExecution.goalsTotal} Goal auto-steering session(s).`,
      interactionStyle: {
        archetype: steerRatio >= 35 ? "Iterative Course-Corrector" : "Goal-Oriented Delegator",
        traits: [
          `Avg ${metrics.avgUserMessagesPerSession} prompts/session`,
          `Primary model: ${topModel.split("/").pop() || topModel}`,
          `${metrics.shortPromptRatio}% concise initial prompts`,
        ],
        analysis:
          steerRatio >= 35
            ? "You frequently guide agents across multiple follow-up turns within a session, refining scope and verifying edge cases interactively."
            : "You tend to hand off self-contained tasks and let the agent execute to a reviewable checkpoint before stepping in.",
      },
      wins: [
        {
          title: "Consistent Tool & Workspace Execution",
          detail: `Agents completed ${metrics.totalToolCalls} tool invocations with a ${metrics.toolSuccessRate}% success rate, concentrated in ${topProject}.`,
          evidence: `${metrics.radarExecution.cardsArchived} card(s) archived · ${metrics.radarExecution.cardsReadyToArchive} ready to archive`,
        },
      ],
      frictions:
        metrics.failedToolCalls > 0 && topFailedTool && topFailedTool.failures > 0
          ? [
              {
                title: `Tool execution failures around "${topFailedTool.name}"`,
                severity: metrics.toolSuccessRate < 90 ? "high" : "medium",
                detail: `${metrics.failedToolCalls} tool call(s) failed across ${metrics.sessionsWithToolErrors} session(s), most frequently on ${topFailedTool.name} (${topFailedTool.failures} errors).`,
                evidence: `${topFailedTool.name}: ${topFailedTool.failures}/${topFailedTool.calls} failed`,
              },
            ]
          : [],
      recommendations: [
        {
          category: "workflow",
          title: "Use /radar-goal with --verify for multi-step coding tasks",
          rationale:
            "Pairing explicit acceptance commands with Goal mode reduces manual follow-up nudges and catches build/type errors before the session yields.",
          snippet: "/radar-goal Complete implementation and pass checks --verify npm run typecheck",
        },
        {
          category: "agents_md",
          title: "Document verification commands in project AGENTS.md",
          rationale:
            "Adding exact typecheck/test commands in AGENTS.md prevents agents from guessing CLI flags and failing shell tool calls.",
          snippet: "## Verification\n- Always run `npm run typecheck` before marking work ready.",
        },
      ],
    };
  }

  return {
    headline:
      metrics.totalSessions === 0
        ? "当前时间窗口内暂无可分析的协作会话记录"
        : `完成 ${metrics.totalSessions} 场人机协作（工具成功率 ${metrics.toolSuccessRate}%），重心聚焦于 ${topProject}`,
    executiveSummary:
      metrics.totalSessions === 0
        ? "从 Radar 待办池启动跟进或在 Paseo 工作区发起对话后，点击重新生成即可获取针对提问习惯与执行闭环的深度复盘。"
        : `在 ${metrics.activeDays} 个活跃日内共发出 ${metrics.totalUserMessages} 条指令（场均 ${metrics.avgUserMessagesPerSession} 轮），驱动 Agent 执行 ${metrics.totalToolCalls} 次工具调用；看板累计闭环归档 ${metrics.radarExecution.cardsArchived} 项，开启目标自驱 ${metrics.radarExecution.goalsTotal} 次。`,
    interactionStyle: {
      archetype: steerRatio >= 35 ? "多轮渐进纠偏型" : "目标委派把关型",
      traits: [
        `场均 ${metrics.avgUserMessagesPerSession} 条人工指令`,
        `主力模型 ${topModel.split("/").pop() || topModel}`,
        `简短首句占比 ${metrics.shortPromptRatio}%`,
      ],
      analysis:
        steerRatio >= 35
          ? "你倾向于先快速切入问题，再在对话过程中根据 Agent 的阶段反馈连续追问、修正方向与补充约束。"
          : "你倾向于单次交代明确目标后交由 Agent 自主推进，主要在可完结验收或关键方案确认节点介入拍板。",
    },
    wins: [
      {
        title: "高频项目推进与工具链执行稳定",
        detail: `围绕 ${topProject} 等核心仓库完成了 ${metrics.totalToolCalls} 次工具调用，整体工具执行成功率达 ${metrics.toolSuccessRate}%。`,
        evidence: `已归档 ${metrics.radarExecution.cardsArchived} 张卡片 · 待归档 ${metrics.radarExecution.cardsReadyToArchive} 张`,
      },
    ],
    frictions:
      metrics.failedToolCalls > 0 && topFailedTool && topFailedTool.failures > 0
        ? [
            {
              title: `工具调用在「${topFailedTool.name}」上存在重复报错摩擦`,
              severity: metrics.toolSuccessRate < 90 ? "high" : "medium",
              detail: `共有 ${metrics.sessionsWithToolErrors} 场会话出现工具报错（累计失败 ${metrics.failedToolCalls} 次），其中 ${topFailedTool.name} 失败 ${topFailedTool.failures} 次。`,
              evidence: `${topFailedTool.name}：失败 ${topFailedTool.failures} / 调用 ${topFailedTool.calls} 次`,
            },
          ]
        : [],
    recommendations: [
      {
        category: "workflow",
        title: "对长链路编码任务启用 /radar-goal 并绑定 --verify 验收命令",
        rationale:
          "将构建或类型检查固化为 Goal 终检门禁，能显著减少 Agent 提前停下汇报半成品带来的多轮人工催促。",
        snippet: "/radar-goal 完成功能实现并通过全部检查后提交 --verify npm run typecheck",
      },
      {
        category: "agents_md",
        title: "在高频仓库 AGENTS.md 中写明验证命令与禁区约束",
        rationale:
          "提前声明本地环境依赖与标准校验脚本，可减少 Agent 试错命令导致的工具调用失败。",
        snippet: "## 本地验证规范\n- 修改代码后必须执行 `npm run typecheck` 确认零报错后再收尾。",
      },
    ],
  };
}

async function synthesizeInsightNarrative(params: {
  metrics: RadarInsightMetrics;
  samples: readonly SessionSampleForLlm[];
  window: InsightWindow;
  customFocus: string | null;
  isZh: boolean;
  insightModels: readonly string[];
  paseo?: PaseoApi | null;
  onFallback?: (info: { failedModel: string; nextModel: string; error: unknown }) => void;
}): Promise<{ narrative: RadarInsightNarrative; modelUsed: string | null; aiGenerated: boolean }> {
  const { metrics, samples, window, customFocus, isZh, insightModels, paseo, onFallback } = params;
  if (metrics.totalSessions === 0 || insightModels.length === 0) {
    return {
      narrative: buildFallbackNarrative(metrics, isZh),
      modelUsed: null,
      aiGenerated: false,
    };
  }

  const compactMetricsForPrompt = {
    window,
    totalSessions: metrics.totalSessions,
    analyzedSessions: metrics.analyzedSessions,
    activeDays: metrics.activeDays,
    radarLinkedSessions: metrics.radarLinkedSessions,
    standaloneSessions: metrics.standaloneSessions,
    totalUserMessages: metrics.totalUserMessages,
    avgUserMessagesPerSession: metrics.avgUserMessagesPerSession,
    avgFirstPromptChars: metrics.avgFirstPromptChars,
    shortPromptRatioPct: metrics.shortPromptRatio,
    multiTurnSteerSessions: metrics.multiTurnSteerSessions,
    totalAssistantTurns: metrics.totalAssistantTurns,
    totalToolCalls: metrics.totalToolCalls,
    failedToolCalls: metrics.failedToolCalls,
    toolSuccessRatePct: metrics.toolSuccessRate,
    sessionsWithToolErrors: metrics.sessionsWithToolErrors,
    models: metrics.models.slice(0, 8),
    projects: metrics.projects.slice(0, 8),
    topTools: metrics.topTools.slice(0, 10),
    radarExecution: metrics.radarExecution,
  };

  const langInstruction = isZh
    ? "请全部使用自然、专业、犀利且克制的简体中文撰写（代码/命令片段与工具名保留原样）。"
    : "Write all narrative fields in crisp, specific, professional English (keep exact tool names, project names, and CLI snippets as-is).";

  const focusBlock = customFocus
    ? `\n【用户特别关注的复盘重点】\n${customFocus}\n（请在分析摩擦点与改进建议时重点回应上述方向！）\n`
    : "";

  const prompt = [
    "你是 Paseo Radar 的人机协作效能审计专家（设计灵感源自 Claude Code `/insights`）。",
    "请基于下方真实的【定量统计指标】与【代表性会话样本】，深度复盘用户在最近一段时间内与 AI Agent 的互动习惯（Prompt 颗粒度、上下文交接、多轮纠偏、目标委派）以及 Agent 的执行表现（工具调用成功率、报错循环、提前停顿、门禁拦截、各模型表现差异、Radar 看板闭环效率）。",
    langInstruction,
    focusBlock,
    "【核心质量要求】",
    "1. 拒绝空泛套话：每一条高光模式（wins）、摩擦卡点（frictions）与改进建议（recommendations）都必须锚定下方真实的仓库名、工具名、指标数字或具体会话特征，像资深技术搭档做复盘一样言之有物。",
    "2. 双向视角：既指出用户互动方式上的提效空间（如首句指令过短导致反复追问纠偏、未充分利用 `/radar-goal --verify` 或脚本模式 `waiting_external`），也指出 Agent / 模型在执行层暴露的短板（如特定工具高频失败、未提交 git 或未做业务验证就试图收尾、特定模型报错等）。",
    "3. 可直接复制落地：`recommendations` 至少包含 3~4 条，覆盖 `agents_md`（可直接粘贴进项目 `AGENTS.md` / `CLAUDE.md` 的具体规则段落，放在 `snippet` 字段）、`workflow`（提问模板或 `/radar-goal` 用法，放在 `snippet` 字段）和 `radar_config`（模型分工、屏蔽词或等待巡检配置建议）。",
    "",
    "请严格只输出一个合法的 JSON 对象（不要包裹任何多余解释文字），JSON Schema 结构如下：",
    "{",
    '  "headline": "一句话犀利总结近期人机协作画像与核心表现（35字以内 / <= 18 words）",',
    '  "executiveSummary": "2~3 句全局总评：概括吞吐规模、最突出的协作优势与最值得优先解决的 1 个效率卡点",',
    '  "interactionStyle": {',
    '    "archetype": "4~8 字的协作风格定性标签（如：架构委派·节点把关型 / 快速切入·多轮纠偏型）",',
    '    "traits": ["特征短标签1", "特征短标签2", "特征短标签3", "特征短标签4"],',
    '    "analysis": "1 段具体分析（80~160 字）：结合首条 Prompt 长度、场均轮次、多轮纠偏比例、Goal 与看板工具使用情况，客观刻画你与 Agent 的分工模式"',
    "  },",
    '  "wins": [',
    '    { "title": "高光协作模式标题", "detail": "具体做对了什么、带来了什么执行效果", "evidence": "支撑该结论的具体项目/会话/指标证据" }',
    "  ],",
    '  "frictions": [',
    '    { "title": "摩擦卡点或执行短板标题", "severity": "high | medium | low", "detail": "具体问题表现、根因分析与损耗点", "evidence": "具体报错工具、模型、会话或比率证据" }',
    "  ],",
    '  "recommendations": [',
    '    { "category": "agents_md | workflow | radar_config", "title": "具体可落地的改进动作", "rationale": "为什么这能直接消除上述摩擦点", "snippet": "可直接复制粘贴的 AGENTS.md 规则文本、Prompt 模板或 /radar-goal 命令（无代码片段时填 null）" }',
    "  ]",
    "}",
    "",
    "【定量统计指标 JSON】",
    JSON.stringify(compactMetricsForPrompt, null, 2),
    "",
    `【代表性会话样本（共采样 ${samples.length} 场）】`,
    JSON.stringify(samples, null, 2),
  ].join("\n");

  const res = await runOneShotPromptWithFallback({
    modelSpecs: insightModels,
    prompt,
    paseo,
    timeoutMs: 120_000,
    onFallback,
  });

  const rawJson = extractJsonObjectFromText(res.text);
  const validated = RadarInsightNarrativeSchema.parse(rawJson);
  return {
    narrative: validated,
    modelUsed: res.modelUsed,
    aiGenerated: true,
  };
}

export function renderInsightReportMarkdown(report: {
  createdAt: string;
  window: InsightWindow;
  periodStart: string;
  periodEnd: string;
  modelUsed: string | null;
  locale: string;
  metrics: RadarInsightMetrics;
  narrative: RadarInsightNarrative;
}): string {
  const isZh = report.locale.toLowerCase().startsWith("zh");
  const { metrics: m, narrative: n } = report;
  const winLabel =
    report.window === "all"
      ? isZh
        ? "全部历史"
        : "All Time"
      : isZh
        ? `近 ${report.window.replace("d", "")} 天`
        : `Last ${report.window}`;

  const lines: string[] = [];
  lines.push(`# ${isZh ? "Radar 人机协作与执行洞察报告" : "Radar Interaction & Execution Insights"} (${winLabel})`);
  lines.push("");
  lines.push(
    `> **${n.headline}**  `,
  );
  lines.push(
    `> ${isZh ? "生成时间" : "Generated"}: ${report.createdAt.slice(0, 19).replace("T", " ")} · ${
      isZh ? "统计区间" : "Period"
    }: ${report.periodStart.slice(0, 10)} ~ ${report.periodEnd.slice(0, 10)}${
      report.modelUsed ? ` · ${isZh ? "分析模型" : "Model"}: \`${report.modelUsed}\`` : ""
    }`,
  );
  lines.push("");
  lines.push(n.executiveSummary);
  lines.push("");

  lines.push(`## ${isZh ? "核心指标总览" : "At-a-Glance Metrics"}`);
  lines.push("");
  lines.push(
    isZh
      ? `- **协作会话总数**：${m.totalSessions} 场（活跃 ${m.activeDays} 天 · 看板关联 ${m.radarLinkedSessions} / 独立会话 ${m.standaloneSessions}）`
      : `- **Total Sessions**: ${m.totalSessions} (${m.activeDays} active days · ${m.radarLinkedSessions} Radar-linked / ${m.standaloneSessions} standalone)`,
  );
  lines.push(
    isZh
      ? `- **用户指令互动**：共 ${m.totalUserMessages} 条（场均 ${m.avgUserMessagesPerSession} 条 · 首句均值 ${m.avgFirstPromptChars} 字 · 多轮纠偏 ${m.multiTurnSteerSessions} 场）`
      : `- **User Prompts**: ${m.totalUserMessages} total (${m.avgUserMessagesPerSession}/session · avg initial ${m.avgFirstPromptChars} chars · ${m.multiTurnSteerSessions} multi-turn sessions)`,
  );
  lines.push(
    isZh
      ? `- **工具调用表现**：共 ${m.totalToolCalls} 次，成功率 **${m.toolSuccessRate}%**（失败 ${m.failedToolCalls} 次，涉及 ${m.sessionsWithToolErrors} 场会话）`
      : `- **Tool Execution**: ${m.totalToolCalls} calls, **${m.toolSuccessRate}%** success rate (${m.failedToolCalls} failed across ${m.sessionsWithToolErrors} sessions)`,
  );
  lines.push(
    isZh
      ? `- **Radar 闭环与自驱**：已归档 ${m.radarExecution.cardsArchived} 项 · 可完结 ${m.radarExecution.cardsReadyToArchive} 项 · 待确认 ${m.radarExecution.cardsDecision} 项 · 目标模式 ${m.radarExecution.goalsAchieved}/${m.radarExecution.goalsTotal} 达成（场均 ${m.radarExecution.avgGoalTurns} 轮）`
      : `- **Radar Closure & Goal Mode**: ${m.radarExecution.cardsArchived} archived · ${m.radarExecution.cardsReadyToArchive} ready · ${m.radarExecution.cardsDecision} decisions · Goal mode ${m.radarExecution.goalsAchieved}/${m.radarExecution.goalsTotal} achieved (avg ${m.radarExecution.avgGoalTurns} turns)`,
  );
  lines.push("");

  lines.push(`## ${isZh ? "互动风格画像" : "Interaction Style"}：${n.interactionStyle.archetype}`);
  lines.push("");
  if (n.interactionStyle.traits.length > 0) {
    lines.push(n.interactionStyle.traits.map((t) => `\`${t}\``).join(" · "));
    lines.push("");
  }
  lines.push(n.interactionStyle.analysis);
  lines.push("");

  if (n.wins.length > 0) {
    lines.push(`## ${isZh ? "高光协作模式" : "What Worked Well"}`);
    lines.push("");
    for (const w of n.wins) {
      lines.push(`- **${w.title}**：${w.detail}${w.evidence ? ` _(${w.evidence})_` : ""}`);
    }
    lines.push("");
  }

  if (n.frictions.length > 0) {
    lines.push(`## ${isZh ? "摩擦卡点与执行短板" : "Friction Points & Bottlenecks"}`);
    lines.push("");
    for (const f of n.frictions) {
      const sev = f.severity.toUpperCase();
      lines.push(`- **[${sev}] ${f.title}**：${f.detail}${f.evidence ? ` _(${f.evidence})_` : ""}`);
    }
    lines.push("");
  }

  if (n.recommendations.length > 0) {
    lines.push(`## ${isZh ? "可落地改进建议" : "Actionable Recommendations"}`);
    lines.push("");
    for (const rec of n.recommendations) {
      const catLabel =
        rec.category === "agents_md"
          ? "AGENTS.md"
          : rec.category === "radar_config"
            ? "Radar Config"
            : "Workflow";
      lines.push(`### [${catLabel}] ${rec.title}`);
      lines.push("");
      lines.push(rec.rationale);
      if (rec.snippet) {
        lines.push("");
        lines.push("```markdown");
        lines.push(rec.snippet);
        lines.push("```");
      }
      lines.push("");
    }
  }

  if (m.models.length > 0) {
    lines.push(`## ${isZh ? "模型执行对比" : "Model Breakdown"}`);
    lines.push("");
    lines.push(
      isZh
        ? "| 模型 | 会话数 | 用户指令 | 工具调用 | 工具失败 | 可完结/归档 |"
        : "| Model | Sessions | Prompts | Tool Calls | Failed Tools | Closed/Ready |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const mod of m.models.slice(0, 10)) {
      lines.push(
        `| \`${mod.model}\` | ${mod.sessions} | ${mod.userMessages} | ${mod.toolCalls} | ${mod.failedToolCalls} | ${mod.readyToArchiveCount} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderInsightReportHtml(report: RadarInsightReport): string {
  const isZh = report.locale.toLowerCase().startsWith("zh");
  const { metrics: m, narrative: n } = report;
  const winLabel =
    report.window === "all"
      ? isZh
        ? "全部历史"
        : "All Time"
      : isZh
        ? `近 ${report.window.replace("d", "")} 天`
        : `Last ${report.window}`;

  const maxDailyMsgs = Math.max(1, ...m.dailyActivity.map((d) => d.userMessages));
  const dailyBarsHtml = m.dailyActivity
    .map((d) => {
      const pct = Math.max(d.sessions > 0 || d.userMessages > 0 ? 6 : 2, Math.round((d.userMessages / maxDailyMsgs) * 100));
      const shortDate = d.date.slice(5);
      return `<div class="bar-col" title="${escapeHtml(`${d.date}: ${d.sessions} sessions, ${d.userMessages} prompts, ${d.toolCalls} tools`)}">
        <div class="bar-track"><div class="bar-fill" style="height:${pct}%"></div></div>
        <span class="bar-label">${escapeHtml(shortDate)}</span>
      </div>`;
    })
    .join("");

  const traitsHtml = n.interactionStyle.traits
    .map((t) => `<span class="chip">${escapeHtml(t)}</span>`)
    .join("");

  const winsHtml = n.wins
    .map(
      (w) => `<div class="item-card win-card">
        <div class="item-title">${escapeHtml(w.title)}</div>
        <p class="item-detail">${escapeHtml(w.detail)}</p>
        ${w.evidence ? `<div class="item-evidence">${escapeHtml(w.evidence)}</div>` : ""}
      </div>`,
    )
    .join("");

  const frictionsHtml = n.frictions
    .map((f) => {
      const sevClass = f.severity === "high" ? "sev-high" : f.severity === "low" ? "sev-low" : "sev-med";
      const sevLabel =
        isZh
          ? f.severity === "high"
            ? "高摩擦"
            : f.severity === "low"
              ? "低摩擦"
              : "中摩擦"
          : f.severity.toUpperCase();
      return `<div class="item-card friction-card">
        <div class="item-header">
          <span class="sev-badge ${sevClass}">${escapeHtml(sevLabel)}</span>
          <span class="item-title">${escapeHtml(f.title)}</span>
        </div>
        <p class="item-detail">${escapeHtml(f.detail)}</p>
        ${f.evidence ? `<div class="item-evidence">${escapeHtml(f.evidence)}</div>` : ""}
      </div>`;
    })
    .join("");

  const recsHtml = n.recommendations
    .map((r, idx) => {
      const catLabel =
        r.category === "agents_md"
          ? isZh
            ? "AGENTS.md 规范"
            : "AGENTS.md Rule"
          : r.category === "radar_config"
            ? isZh
              ? "Radar 配置优化"
              : "Radar Config"
            : isZh
              ? "协作工作流"
              : "Workflow Habit";
      return `<div class="item-card rec-card">
        <div class="item-header">
          <span class="cat-badge">${escapeHtml(catLabel)}</span>
          <span class="item-title">${escapeHtml(r.title)}</span>
        </div>
        <p class="item-detail">${escapeHtml(r.rationale)}</p>
        ${
          r.snippet
            ? `<div class="snippet-wrap">
                <pre id="snip-${idx}"><code>${escapeHtml(r.snippet)}</code></pre>
                <button class="copy-btn" onclick="copySnippet('snip-${idx}', this)">${isZh ? "复制片段" : "Copy"}</button>
              </div>`
            : ""
        }
      </div>`;
    })
    .join("");

  const modelsRowsHtml = m.models
    .slice(0, 12)
    .map((mod) => {
      const okRate =
        mod.toolCalls > 0
          ? `${Math.round(((mod.toolCalls - mod.failedToolCalls) / mod.toolCalls) * 100)}%`
          : "—";
      return `<tr>
        <td><code>${escapeHtml(mod.model)}</code></td>
        <td class="num">${mod.sessions}</td>
        <td class="num">${mod.userMessages}</td>
        <td class="num">${mod.toolCalls}</td>
        <td class="num">${okRate}</td>
        <td class="num">${mod.readyToArchiveCount}</td>
      </tr>`;
    })
    .join("");

  const projectsRowsHtml = m.projects
    .slice(0, 8)
    .map(
      (p) => `<tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td class="num">${p.sessions}</td>
        <td class="num">${p.userMessages}</td>
        <td class="num">${p.toolCalls}</td>
        <td class="num">${p.archivedCards}</td>
      </tr>`,
    )
    .join("");

  const toolsRowsHtml = m.topTools
    .slice(0, 10)
    .map(
      (t) => `<tr>
        <td><code>${escapeHtml(t.name)}</code></td>
        <td class="num">${t.calls}</td>
        <td class="num ${t.failures > 0 ? "danger-text" : ""}">${t.failures}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="${escapeHtml(report.locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(isZh ? "Paseo Radar · 洞察报告" : "Paseo Radar · Insights Report")} (${escapeHtml(winLabel)})</title>
<style>
  :root {
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface2: #f1f5f9;
    --fg: #0f172a;
    --muted: #64748b;
    --border: #e2e8f0;
    --accent: #2563eb;
    --accent-soft: rgba(37, 99, 235, 0.1);
    --success: #16a34a;
    --success-soft: rgba(22, 163, 74, 0.1);
    --warn: #d97706;
    --warn-soft: rgba(217, 119, 6, 0.12);
    --danger: #dc2626;
    --danger-soft: rgba(220, 38, 38, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f19;
      --surface: #131926;
      --surface2: #1e293b;
      --fg: #f1f5f9;
      --muted: #94a3b8;
      --border: #263244;
      --accent: #3b82f6;
      --accent-soft: rgba(59, 130, 246, 0.16);
      --success: #22c55e;
      --success-soft: rgba(34, 197, 94, 0.15);
      --warn: #f59e0b;
      --warn-soft: rgba(245, 158, 11, 0.16);
      --danger: #ef4444;
      --danger-soft: rgba(239, 68, 68, 0.16);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 64px;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif;
    line-height: 1.6;
  }
  .container { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
  .hero {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .eyebrow { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); }
  .archetype-badge {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12.5px;
  }
  h1 { margin: 0; font-size: 24px; line-height: 1.35; }
  h2 { margin: 0 0 12px; font-size: 17px; }
  .summary-text { margin: 0; color: var(--fg); font-size: 15px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
  }
  .stat-label { font-size: 12.5px; color: var(--muted); }
  .stat-value { font-size: 26px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .chip {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 12px;
    color: var(--fg);
  }
  .bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 140px;
    padding-top: 12px;
  }
  .bar-col { flex: 1; min-width: 14px; display: flex; flex-direction: column; align-items: center; height: 100%; }
  .bar-track { flex: 1; width: 100%; max-width: 24px; background: var(--surface2); border-radius: 5px; display: flex; align-items: flex-end; overflow: hidden; }
  .bar-fill { width: 100%; background: var(--accent); border-radius: 5px 5px 0 0; }
  .bar-label { font-size: 10px; color: var(--muted); margin-top: 6px; transform: rotate(-30deg); white-space: nowrap; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .item-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    background: var(--surface2);
  }
  .win-card { border-left: 4px solid var(--success); }
  .friction-card { border-left: 4px solid var(--warn); }
  .rec-card { border-left: 4px solid var(--accent); }
  .item-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .item-title { font-weight: 600; font-size: 14.5px; }
  .item-detail { margin: 6px 0 0; font-size: 13.5px; color: var(--fg); }
  .item-evidence { margin-top: 8px; font-size: 12px; color: var(--muted); }
  .sev-badge, .cat-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;
  }
  .sev-high { background: var(--danger-soft); color: var(--danger); }
  .sev-med { background: var(--warn-soft); color: var(--warn); }
  .sev-low { background: var(--accent-soft); color: var(--accent); }
  .cat-badge { background: var(--accent-soft); color: var(--accent); }
  .snippet-wrap { position: relative; margin-top: 10px; }
  pre {
    margin: 0;
    padding: 12px 76px 12px 12px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-size: 12.5px;
  }
  .copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--fg);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 11.5px;
    cursor: pointer;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .danger-text { color: var(--danger); font-weight: 600; }
</style>
</head>
<body>
<div class="container">
  <section class="hero">
    <div class="eyebrow">
      <span class="archetype-badge">${escapeHtml(n.interactionStyle.archetype)}</span>
      <span>${escapeHtml(winLabel)} (${escapeHtml(report.periodStart.slice(0, 10))} ~ ${escapeHtml(report.periodEnd.slice(0, 10))})</span>
      ${report.modelUsed ? `<span>· ${escapeHtml(report.modelUsed)}</span>` : ""}
    </div>
    <h1>${escapeHtml(n.headline)}</h1>
    <p class="summary-text">${escapeHtml(n.executiveSummary)}</p>
  </section>

  <section class="stat-grid">
    <div class="stat-card">
      <div class="stat-label">${isZh ? "协作会话数" : "Sessions"}</div>
      <div class="stat-value">${m.totalSessions}</div>
      <div class="stat-sub">${isZh ? `活跃 ${m.activeDays} 天 · 看板关联 ${m.radarLinkedSessions}` : `${m.activeDays} active days · ${m.radarLinkedSessions} Radar-linked`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">${isZh ? "用户指令数" : "User Prompts"}</div>
      <div class="stat-value">${m.totalUserMessages}</div>
      <div class="stat-sub">${isZh ? `场均 ${m.avgUserMessagesPerSession} 轮 · 多轮纠偏 ${m.multiTurnSteerSessions} 场` : `${m.avgUserMessagesPerSession}/session · ${m.multiTurnSteerSessions} multi-turn`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">${isZh ? "工具执行成功率" : "Tool Success Rate"}</div>
      <div class="stat-value">${m.toolSuccessRate}%</div>
      <div class="stat-sub">${isZh ? `共 ${m.totalToolCalls} 次 · 失败 ${m.failedToolCalls} 次` : `${m.totalToolCalls} total · ${m.failedToolCalls} failed`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">${isZh ? "看板闭环与自驱" : "Radar Closures"}</div>
      <div class="stat-value">${m.radarExecution.cardsArchived}</div>
      <div class="stat-sub">${isZh ? `待归档 ${m.radarExecution.cardsReadyToArchive} · Goal 达成 ${m.radarExecution.goalsAchieved}/${m.radarExecution.goalsTotal}` : `${m.radarExecution.cardsReadyToArchive} ready · Goal ${m.radarExecution.goalsAchieved}/${m.radarExecution.goalsTotal}`}</div>
    </div>
  </section>

  ${
    m.dailyActivity.length > 0
      ? `<section class="panel">
          <h2>${isZh ? "每日协作活跃度（用户指令分布）" : "Daily Collaboration Activity"}</h2>
          <div class="bar-chart">${dailyBarsHtml}</div>
        </section>`
      : ""
  }

  <section class="panel">
    <h2>${isZh ? "互动风格深度画像" : "Interaction Style & Collaboration Profile"}</h2>
    <div class="chips">${traitsHtml}</div>
    <p class="item-detail">${escapeHtml(n.interactionStyle.analysis)}</p>
  </section>

  <div class="two-col">
    <section class="panel">
      <h2>${isZh ? "高光协作模式" : "What Worked Well"}</h2>
      <div class="stack">${winsHtml || `<p class="stat-sub">${isZh ? "暂无记录" : "None recorded"}</p>`}</div>
    </section>
    <section class="panel">
      <h2>${isZh ? "摩擦卡点与执行短板" : "Friction Points & Bottlenecks"}</h2>
      <div class="stack">${frictionsHtml || `<p class="stat-sub">${isZh ? "未发现明显卡点" : "No major friction detected"}</p>`}</div>
    </section>
  </div>

  <section class="panel">
    <h2>${isZh ? "可落地改进建议（可直接复制）" : "Actionable Recommendations"}</h2>
    <div class="stack">${recsHtml}</div>
  </section>

  <section class="panel">
    <h2>${isZh ? "模型执行表现对比" : "Model & Provider Performance"}</h2>
    <table>
      <thead>
        <tr>
          <th>${isZh ? "模型" : "Model"}</th>
          <th class="num">${isZh ? "会话" : "Sessions"}</th>
          <th class="num">${isZh ? "指令" : "Prompts"}</th>
          <th class="num">${isZh ? "工具调用" : "Tools"}</th>
          <th class="num">${isZh ? "工具成功率" : "Tool OK"}</th>
          <th class="num">${isZh ? "闭环数" : "Closed"}</th>
        </tr>
      </thead>
      <tbody>${modelsRowsHtml}</tbody>
    </table>
  </section>

  <div class="two-col">
    <section class="panel">
      <h2>${isZh ? "高频协作项目" : "Top Projects"}</h2>
      <table>
        <thead>
          <tr>
            <th>${isZh ? "项目" : "Project"}</th>
            <th class="num">${isZh ? "会话" : "Sessions"}</th>
            <th class="num">${isZh ? "指令" : "Prompts"}</th>
            <th class="num">${isZh ? "工具" : "Tools"}</th>
            <th class="num">${isZh ? "归档卡" : "Archived"}</th>
          </tr>
        </thead>
        <tbody>${projectsRowsHtml}</tbody>
      </table>
    </section>
    <section class="panel">
      <h2>${isZh ? "高频调用工具与失败分布" : "Top Tools & Failures"}</h2>
      <table>
        <thead>
          <tr>
            <th>${isZh ? "工具名" : "Tool"}</th>
            <th class="num">${isZh ? "调用次数" : "Calls"}</th>
            <th class="num">${isZh ? "失败次数" : "Failures"}</th>
          </tr>
        </thead>
        <tbody>${toolsRowsHtml}</tbody>
      </table>
    </section>
  </div>
</div>
<script>
function copySnippet(id, btn) {
  var el = document.getElementById(id);
  if (!el) return;
  var text = el.innerText || el.textContent || "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      var prev = btn.textContent;
      btn.textContent = "✓";
      setTimeout(function() { btn.textContent = prev; }, 1400);
    });
  }
}
</script>
</body>
</html>`;
}

async function writeHtmlReportFiles(report: RadarInsightReport): Promise<{
  htmlPath: string;
  latestHtmlPath: string;
  htmlContent: string;
}> {
  const dir = insightsReportsHtmlDir();
  await mkdir(dir, { recursive: true });
  const dateTag = report.createdAt.slice(0, 10);
  const htmlPath = join(dir, `radar-insights-${dateTag}-${report.window}-${report.id.slice(0, 6)}.html`);
  const latestHtmlPath = join(dir, "latest.html");
  const htmlContent = renderInsightReportHtml({ ...report, htmlPath });
  await Promise.all([
    writeFile(htmlPath, htmlContent, "utf8"),
    writeFile(latestHtmlPath, htmlContent, "utf8"),
  ]);
  return { htmlPath, latestHtmlPath, htmlContent };
}

export interface GenerateInsightsContext {
  paseo: PaseoApi | null | undefined;
  projects: readonly ProjectOption[];
  insightModels: readonly string[];
  timeZone?: string | null;
  onModelFallback?: (info: { failedModel: string; nextModel: string; error: unknown }) => void;
  onModelError?: (info: { failedModel: string; error: unknown }) => void;
}

export class RadarInsightsManager {
  private generatingPromise: Promise<RadarInsightReport> | null = null;
  private status: RadarInsightStatus = {
    generating: false,
    stage: null,
    progressText: null,
    startedAt: null,
    window: null,
    lastError: null,
  };

  getStatus(): RadarInsightStatus {
    return { ...this.status };
  }

  async load(reportId?: string): Promise<{
    status: RadarInsightStatus;
    reports: RadarInsightReportSummary[];
    activeReport: RadarInsightReport | null;
  }> {
    const saved = await readSavedReports();
    const summaries = saved.map(toReportSummary);
    const activeReport = reportId
      ? saved.find((r) => r.id === reportId) ?? saved[0] ?? null
      : saved[0] ?? null;
    return {
      status: this.getStatus(),
      reports: summaries,
      activeReport,
    };
  }

  async deleteReport(reportId: string): Promise<{
    ok: boolean;
    reports: RadarInsightReportSummary[];
    activeReport: RadarInsightReport | null;
  }> {
    let removedPath: string | null = null;
    const remaining = await serializedInsightIo(async () => {
      const saved = await readSavedReports();
      const target = saved.find((r) => r.id === reportId);
      removedPath = target?.htmlPath ?? null;
      const next = saved.filter((r) => r.id !== reportId);
      await atomicWriteJson(savedReportsPath(), next);
      return next;
    });
    if (removedPath) {
      await rm(removedPath, { force: true }).catch(() => {});
    }
    return {
      ok: true,
      reports: remaining.map(toReportSummary),
      activeReport: remaining[0] ?? null,
    };
  }

  async exportHtml(reportId: string): Promise<{
    htmlPath: string;
    latestHtmlPath: string;
    htmlContent: string;
  }> {
    const saved = await readSavedReports();
    const target = saved.find((r) => r.id === reportId) ?? saved[0];
    if (!target) {
      throw new Error("未找到可导出的洞察报告");
    }
    const written = await writeHtmlReportFiles(target);
    if (target.htmlPath !== written.htmlPath) {
      await serializedInsightIo(async () => {
        const current = await readSavedReports();
        const idx = current.findIndex((r) => r.id === target.id);
        if (idx >= 0) {
          current[idx] = { ...current[idx]!, htmlPath: written.htmlPath };
          await atomicWriteJson(savedReportsPath(), current);
        }
      });
    }
    return written;
  }

  async generate(
    input: {
      window: InsightWindow;
      customFocus?: string;
      locale?: string;
      forceRefreshCache?: boolean;
    },
    ctx: GenerateInsightsContext,
  ): Promise<{ report: RadarInsightReport; reports: RadarInsightReportSummary[] }> {
    if (this.generatingPromise) {
      const report = await this.generatingPromise;
      const saved = await readSavedReports();
      return { report, reports: saved.map(toReportSummary) };
    }

    const locale = input.locale?.trim() || "zh-CN";
    const isZh = locale.toLowerCase().startsWith("zh");
    const window = input.window;
    const customFocus = input.customFocus?.trim() || null;

    const task = (async (): Promise<RadarInsightReport> => {
      const startedAt = new Date().toISOString();
      this.status = {
        generating: true,
        stage: "discover",
        progressText: isZh ? "正在扫描本地工作区与历史会话记录…" : "Scanning sessions and Radar board history…",
        startedAt,
        window,
        lastError: null,
      };

      const nowMs = Date.now();
      const days = windowDurationDays(window);
      const cutoffMs = days !== null ? nowMs - days * 86_400_000 : 0;
      const tz = resolveEffectiveTimeZone(ctx.timeZone);

      const [allAgents, radarState, telemetryEvents, claudeIndex, rawSessionCache, existingReports] =
        await Promise.all([
          discoverAllUserAgents(ctx.paseo),
          readRadarState(),
          readTelemetryEvents(),
          buildClaudeTranscriptIndex(),
          input.forceRefreshCache
            ? Promise.resolve({} as Record<string, CachedSessionFacet>)
            : readSessionCache(),
          readSavedReports(),
        ]);

      const windowAgents = allAgents.filter((a) => {
        const ts = Date.parse(a.updatedAt || a.createdAt);
        return !Number.isNaN(ts) && ts >= cutoffMs;
      });

      const periodStartIso =
        days !== null
          ? new Date(cutoffMs).toISOString()
          : windowAgents.length > 0
            ? windowAgents[windowAgents.length - 1]!.createdAt
            : startedAt;
      const periodEndIso = new Date(nowMs).toISOString();

      const targetAgents = windowAgents.slice(0, MAX_DEEP_SESSIONS);
      this.status = {
        ...this.status,
        stage: "extract",
        progressText: isZh
          ? `正在提取 ${targetAgents.length} 场会话的指令与工具执行细节（命中增量缓存加速）…`
          : `Extracting interaction & tool facets across ${targetAgents.length} sessions…`,
      };

      const nextCache: Record<string, CachedSessionFacet> = { ...rawSessionCache };
      let cacheDirty = Boolean(input.forceRefreshCache);
      const facetsByAgentId = new Map<string, CachedSessionFacet>();

      let closedTimelineBudget = MAX_TIMELINE_REFETCH_CLOSED;
      const pendingTimelineAgents: Array<{ agent: UnifiedAgentRecord; cacheKey: string }> = [];

      for (const agent of targetAgents) {
        const jsonlPath = await resolveLocalJsonlPath(agent, claudeIndex);
        if (jsonlPath) {
          try {
            const st = await stat(jsonlPath);
            const cacheKey = `${agent.id}|${st.size}:${Math.trunc(st.mtimeMs)}`;
            const cached = nextCache[agent.id];
            if (cached && cached.cacheKey === cacheKey) {
              facetsByAgentId.set(agent.id, cached);
              continue;
            }
            const { lines } = await readBoundedJsonlLines(jsonlPath);
            const parsed = parsePiOrClaudeJsonlLines(agent, cacheKey, lines);
            nextCache[agent.id] = parsed;
            facetsByAgentId.set(agent.id, parsed);
            cacheDirty = true;
            continue;
          } catch {
            // Fall through to timeline or meta
          }
        }

        const timelineCacheKey = `${agent.id}|${agent.updatedAt}|timeline`;
        const cached = nextCache[agent.id];
        if (cached && cached.cacheKey === timelineCacheKey) {
          facetsByAgentId.set(agent.id, cached);
          continue;
        }

        const isLive = agent.status !== "closed" && !agent.archivedAt;
        if (ctx.paseo && (isLive || closedTimelineBudget > 0)) {
          if (!isLive) closedTimelineBudget -= 1;
          pendingTimelineAgents.push({ agent, cacheKey: timelineCacheKey });
        } else {
          facetsByAgentId.set(agent.id, buildMetaOnlyFacet(agent, timelineCacheKey));
        }
      }

      // Fetch timelines in small concurrent batches of 4
      if (ctx.paseo && pendingTimelineAgents.length > 0) {
        const batchSize = 4;
        for (let i = 0; i < pendingTimelineAgents.length; i += batchSize) {
          const slice = pendingTimelineAgents.slice(i, i + batchSize);
          const results = await Promise.all(
            slice.map(({ agent, cacheKey }) => extractTimelineFacet(ctx.paseo!, agent, cacheKey)),
          );
          results.forEach((facet, idx) => {
            const { agent, cacheKey } = slice[idx]!;
            if (facet) {
              nextCache[agent.id] = facet;
              facetsByAgentId.set(agent.id, facet);
              cacheDirty = true;
            } else {
              facetsByAgentId.set(agent.id, buildMetaOnlyFacet(agent, cacheKey));
            }
          });
        }
      }

      if (cacheDirty) {
        await writeSessionCache(nextCache);
      }

      // Aggregate quantitative metrics
      const activeDaySet = new Set<string>();
      const dailyMap = new Map<string, InsightDailyPoint>();
      const chartDays = days ?? 30;
      for (let d = chartDays - 1; d >= 0; d--) {
        const dayStr = formatDateInTimeZone(nowMs - d * 86_400_000, tz);
        dailyMap.set(dayStr, { date: dayStr, sessions: 0, userMessages: 0, toolCalls: 0 });
      }

      let activeSessions = 0;
      let archivedSessions = 0;
      let radarLinkedSessions = 0;
      let standaloneSessions = 0;
      let totalUserMessages = 0;
      let firstPromptCharsSum = 0;
      let firstPromptCount = 0;
      let shortPromptsCount = 0;
      let multiTurnSteerSessions = 0;
      let totalAssistantTurns = 0;
      let totalToolCalls = 0;
      let failedToolCalls = 0;
      let sessionsWithToolErrors = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCachedTokens = 0;
      let estimatedCostUsd = 0;

      const modelMap = new Map<string, InsightModelStat>();
      const projectMap = new Map<string, InsightProjectStat>();
      const toolMap = new Map<string, InsightToolStat>();
      const samplesPool: Array<{ score: number; sample: SessionSampleForLlm }> = [];

      for (const agent of windowAgents) {
        if (agent.archivedAt) archivedSessions += 1;
        else activeSessions += 1;

        const dayStr = formatDateInTimeZone(agent.updatedAt || agent.createdAt, tz);
        activeDaySet.add(dayStr);

        const cardLink = resolveCardForSession(agent, radarState);
        const isRadarLinked = Boolean(cardLink && !cardLink.cardId.startsWith("ws-"));
        if (isRadarLinked || cardLink) radarLinkedSessions += 1;
        else standaloneSessions += 1;

        const projectName = inferProjectNameForSession(agent.cwd, ctx.projects);
        const facet = facetsByAgentId.get(agent.id);

        const uMsgs = facet ? Math.max(1, facet.userMessages) : 1;
        const tCalls = facet?.toolCalls ?? 0;
        const tFails = facet?.failedToolCalls ?? 0;

        const dailyPt = dailyMap.get(dayStr);
        if (dailyPt) {
          dailyPt.sessions += 1;
          dailyPt.userMessages += uMsgs;
          dailyPt.toolCalls += tCalls;
        }

        totalUserMessages += uMsgs;
        if (facet) {
          if (facet.firstPromptChars > 0) {
            firstPromptCharsSum += facet.firstPromptChars;
            firstPromptCount += 1;
            if (facet.firstPromptChars < 32) shortPromptsCount += 1;
          }
          if (facet.userMessages >= 4) multiTurnSteerSessions += 1;
          totalAssistantTurns += facet.assistantTurns;
          totalToolCalls += tCalls;
          failedToolCalls += tFails;
          if (tFails > 0) sessionsWithToolErrors += 1;
          totalInputTokens += facet.inputTokens;
          totalOutputTokens += facet.outputTokens;
          totalCachedTokens += facet.cachedTokens;
          estimatedCostUsd += facet.costUsd;

          for (const [tName, counter] of Object.entries(facet.tools)) {
            const cur = toolMap.get(tName) ?? { name: tName, calls: 0, failures: 0 };
            cur.calls += counter.calls;
            cur.failures += counter.failures;
            toolMap.set(tName, cur);
          }
        }

        const closedOrReady = Boolean(
          cardLink &&
            (cardLink.status === "archived" ||
              cardLink.status === "done" ||
              cardLink.needsMeTag === "ready_to_archive"),
        );

        const mStat = modelMap.get(agent.model) ?? {
          model: agent.model,
          provider: agent.provider,
          sessions: 0,
          userMessages: 0,
          toolCalls: 0,
          failedToolCalls: 0,
          readyToArchiveCount: 0,
          errorTurns: 0,
        };
        mStat.sessions += 1;
        mStat.userMessages += uMsgs;
        mStat.toolCalls += tCalls;
        mStat.failedToolCalls += tFails;
        if (closedOrReady) mStat.readyToArchiveCount += 1;
        if (facet?.hasError || agent.status === "error") mStat.errorTurns += 1;
        modelMap.set(agent.model, mStat);

        const pStat = projectMap.get(projectName) ?? {
          name: projectName,
          sessions: 0,
          userMessages: 0,
          toolCalls: 0,
          archivedCards: 0,
        };
        pStat.sessions += 1;
        pStat.userMessages += uMsgs;
        pStat.toolCalls += tCalls;
        if (closedOrReady) pStat.archivedCards += 1;
        projectMap.set(projectName, pStat);

        if (facet && facet.parsedFrom !== "meta_only" && facet.firstPrompt) {
          const failedToolNames = Object.entries(facet.tools)
            .filter(([, c]) => c.failures > 0)
            .sort((a, b) => b[1].failures - a[1].failures)
            .slice(0, 4)
            .map(([n, c]) => `${n}(${c.failures}/${c.calls})`);
          // Prioritize rich, informative sessions (high friction OR multi-turn OR cleanly closed Radar tasks)
          const richnessScore =
            tFails * 4 +
            Math.min(facet.userMessages, 8) * 2 +
            (closedOrReady ? 3 : 0) +
            (facet.autoSteerMessages > 0 ? 3 : 0) +
            (tCalls > 5 ? 2 : 0);
          samplesPool.push({
            score: richnessScore,
            sample: {
              title: cleanSingleLine(agent.title, 90),
              project: projectName,
              model: agent.model,
              userMessages: facet.userMessages,
              autoSteers: facet.autoSteerMessages,
              toolCalls: tCalls,
              failedTools: failedToolNames,
              firstPrompt: facet.firstPrompt,
              followUps: facet.followUpPrompts,
              radarOutcome: cardLink
                ? `${cardLink.status}${cardLink.needsMeTag ? ` (${cardLink.needsMeTag})` : ""}`
                : agent.archivedAt
                  ? "archived"
                  : agent.status,
              finalSummary: cleanSingleLine(
                cardLink?.summary || facet.latestAssistantSnippet || "",
                180,
              ),
            },
          });
        }
      }

      // Radar board & telemetry execution metrics within window
      const windowEvents = telemetryEvents.filter((ev) => {
        const ts = Date.parse(ev.at);
        return !Number.isNaN(ts) && ts >= cutoffMs;
      });

      const telemetry = {
        turnsCompleted: 0,
        turnsFailed: 0,
        turnsCanceled: 0,
        permissionsAllowed: 0,
        permissionsDenied: 0,
        gateRejections: 0,
        decisionsApproved: 0,
        decisionsEdited: 0,
        waitsCompleted: 0,
        waitsTimedOut: 0,
      };

      for (const ev of windowEvents) {
        if (ev.type === "turn_outcome") {
          if (ev.outcome === "completed") telemetry.turnsCompleted += 1;
          else if (ev.outcome === "failed") telemetry.turnsFailed += 1;
          else if (ev.outcome === "canceled") telemetry.turnsCanceled += 1;
        } else if (ev.type === "permission_resolved") {
          if (ev.behavior === "allow") telemetry.permissionsAllowed += 1;
          else telemetry.permissionsDenied += 1;
        } else if (ev.type === "gate_rejected") {
          telemetry.gateRejections += 1;
        } else if (ev.type === "decision_replied") {
          if (ev.edited) telemetry.decisionsEdited += 1;
          else telemetry.decisionsApproved += 1;
        } else if (ev.type === "wait_finished") {
          if (ev.result === "matched") telemetry.waitsCompleted += 1;
          else telemetry.waitsTimedOut += 1;
        }
      }

      let cardsActiveOrClosedInWindow = 0;
      let cardsArchived = 0;
      let cardsReadyToArchive = 0;
      let cardsDecision = 0;
      let cardsInput = 0;
      let cardsReview = 0;
      let cardsWaitingExternal = 0;
      let scriptWaits = 0;
      let aiWaits = 0;
      let goalsTotal = 0;
      let goalsAchieved = 0;
      let goalsBlocked = 0;
      let goalsAutoRefined = 0;
      let goalTurnsSum = 0;

      const itemUpdatedById = new Map<string, string>();
      for (const item of [...radarState.rawItems, ...radarState.customItems]) {
        itemUpdatedById.set(item.id, item.updatedAt);
      }

      for (const [cardId, meta] of Object.entries(radarState.meta)) {
        if (!meta) continue;
        const candidateTsStr =
          meta.autoArchivedAt ||
          meta.goal?.updatedAt ||
          meta.decisionProposal?.updatedAt ||
          meta.lastWaitCheckAt ||
          meta.waitStartedAt ||
          itemUpdatedById.get(cardId) ||
          null;
        if (candidateTsStr) {
          const ts = Date.parse(candidateTsStr);
          if (!Number.isNaN(ts) && ts < cutoffMs) continue;
        }

        const hasSessionFootprint = Boolean(
          meta.boundWorkspaceId ||
            meta.boundAgentId ||
            meta.prepSummary ||
            meta.customStatus ||
            meta.needsMeTag ||
            meta.goal ||
            meta.waitMode,
        );
        if (!hasSessionFootprint) continue;

        cardsActiveOrClosedInWindow += 1;
        const st = meta.customStatus;
        if (st === "archived" || st === "done") {
          cardsArchived += 1;
        } else if (st === "waiting_external" || st === "waiting") {
          cardsWaitingExternal += 1;
          if (meta.waitMode === "script") scriptWaits += 1;
          else if (meta.waitMode === "ai") aiWaits += 1;
        } else {
          const tag = meta.needsMeTag;
          if (tag === "ready_to_archive") cardsReadyToArchive += 1;
          else if (tag === "decision") cardsDecision += 1;
          else if (tag === "input") cardsInput += 1;
          else if (tag === "review" || meta.prepSummary) cardsReview += 1;
        }

        if (meta.goal) {
          goalsTotal += 1;
          if (meta.goal.autoRefined) goalsAutoRefined += 1;
          goalTurnsSum += meta.goal.turnCount ?? 0;
          if (meta.goal.stopReason === "achieved" || (!meta.goal.active && st === "archived")) {
            goalsAchieved += 1;
          } else if (meta.goal.stopReason === "blocked") {
            goalsBlocked += 1;
          }
        }
      }

      const radarExecution: InsightRadarExecution = {
        cardsActiveOrClosedInWindow,
        cardsArchived,
        cardsReadyToArchive,
        cardsDecision,
        cardsInput,
        cardsReview,
        cardsWaitingExternal,
        scriptWaits,
        aiWaits,
        goalsTotal,
        goalsAchieved,
        goalsBlocked,
        goalsAutoRefined,
        avgGoalTurns: goalsTotal > 0 ? Number((goalTurnsSum / goalsTotal).toFixed(1)) : 0,
        telemetry,
      };

      const totalSessions = windowAgents.length;
      const analyzedSessions = targetAgents.length;
      const toolSuccessRate =
        totalToolCalls > 0
          ? Number((((totalToolCalls - failedToolCalls) / totalToolCalls) * 100).toFixed(1))
          : 100;

      const metrics: RadarInsightMetrics = {
        totalSessions,
        analyzedSessions,
        activeSessions,
        archivedSessions,
        radarLinkedSessions,
        standaloneSessions,
        activeDays: activeDaySet.size,
        totalUserMessages,
        avgUserMessagesPerSession:
          totalSessions > 0 ? Number((totalUserMessages / totalSessions).toFixed(1)) : 0,
        avgFirstPromptChars:
          firstPromptCount > 0 ? Math.round(firstPromptCharsSum / firstPromptCount) : 0,
        shortPromptRatio:
          firstPromptCount > 0 ? Math.round((shortPromptsCount / firstPromptCount) * 100) : 0,
        multiTurnSteerSessions,
        totalAssistantTurns,
        totalToolCalls,
        failedToolCalls,
        toolSuccessRate,
        sessionsWithToolErrors,
        totalInputTokens,
        totalOutputTokens,
        totalCachedTokens,
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
        dailyActivity: [...dailyMap.values()],
        models: [...modelMap.values()].sort((a, b) => b.sessions - a.sessions || b.toolCalls - a.toolCalls),
        projects: [...projectMap.values()].sort((a, b) => b.sessions - a.sessions || b.toolCalls - a.toolCalls),
        topTools: [...toolMap.values()].sort((a, b) => b.calls - a.calls).slice(0, 15),
        radarExecution,
      };

      // Pick up to 24 diverse representative session samples for LLM qualitative review
      const selectedSamples = samplesPool
        .sort((a, b) => b.score - a.score)
        .slice(0, 24)
        .map((x) => x.sample);

      this.status = {
        ...this.status,
        stage: "synthesize",
        progressText: isZh
          ? `已完成 ${totalSessions} 场会话统计，正在调用分析模型生成协作洞察与建议…`
          : `Synthesizing qualitative insights across ${totalSessions} sessions…`,
      };

      let narrative: RadarInsightNarrative;
      let modelUsed: string | null = null;
      let aiGenerated = false;

      try {
        const syn = await synthesizeInsightNarrative({
          metrics,
          samples: selectedSamples,
          window,
          customFocus,
          isZh,
          insightModels: ctx.insightModels,
          paseo: ctx.paseo,
          onFallback: ctx.onModelFallback,
        });
        narrative = syn.narrative;
        modelUsed = syn.modelUsed;
        aiGenerated = syn.aiGenerated;
      } catch (err) {
        console.warn("[paseo-radar] insight LLM synthesis failed, using data-driven fallback:", err);
        if (err instanceof ModelChainError) {
          ctx.onModelError?.({ failedModel: err.failedModel, error: err.causeError });
        }
        narrative = buildFallbackNarrative(metrics, isZh);
        aiGenerated = false;
      }

      // Compute deltas against the latest previous report of the same window
      const prevSameWindow = existingReports.find((r) => r.window === window) ?? null;
      const deltas: RadarInsightDeltas | null = prevSameWindow
        ? {
            prevReportId: prevSameWindow.id,
            prevCreatedAt: prevSameWindow.createdAt,
            sessionsDelta: metrics.totalSessions - prevSameWindow.metrics.totalSessions,
            userMessagesDelta: metrics.totalUserMessages - prevSameWindow.metrics.totalUserMessages,
            toolSuccessRateDelta: Number(
              (metrics.toolSuccessRate - prevSameWindow.metrics.toolSuccessRate).toFixed(1),
            ),
            avgMessagesPerSessionDelta: Number(
              (
                metrics.avgUserMessagesPerSession -
                prevSameWindow.metrics.avgUserMessagesPerSession
              ).toFixed(1),
            ),
            cardsArchivedDelta:
              metrics.radarExecution.cardsArchived -
              prevSameWindow.metrics.radarExecution.cardsArchived,
          }
        : null;

      const createdAt = new Date().toISOString();
      const id = `ins-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
      const markdown = renderInsightReportMarkdown({
        createdAt,
        window,
        periodStart: periodStartIso,
        periodEnd: periodEndIso,
        modelUsed,
        locale,
        metrics,
        narrative,
      });

      const draftReport: RadarInsightReport = {
        id,
        createdAt,
        window,
        periodStart: periodStartIso,
        periodEnd: periodEndIso,
        customFocus,
        locale,
        modelUsed,
        aiGenerated,
        htmlPath: null,
        metrics,
        deltas,
        narrative,
        markdown,
      };

      const writtenHtml = await writeHtmlReportFiles(draftReport).catch((err) => {
        console.warn("[paseo-radar] failed to write HTML insight report:", err);
        return null;
      });

      const finalReport: RadarInsightReport = {
        ...draftReport,
        htmlPath: writtenHtml?.htmlPath ?? null,
      };

      await serializedInsightIo(async () => {
        const current = await readSavedReports();
        const updated = [finalReport, ...current].slice(0, MAX_SAVED_REPORTS);
        await atomicWriteJson(savedReportsPath(), updated);
      });

      this.status = {
        generating: false,
        stage: null,
        progressText: null,
        startedAt: null,
        window: null,
        lastError: null,
      };

      return finalReport;
    })();

    this.generatingPromise = task;
    try {
      const report = await task;
      const saved = await readSavedReports();
      return { report, reports: saved.map(toReportSummary) };
    } catch (err) {
      const errMsg = formatModelErrorMessage(err);
      this.status = {
        generating: false,
        stage: null,
        progressText: null,
        startedAt: null,
        window: null,
        lastError: errMsg,
      };
      throw err;
    } finally {
      this.generatingPromise = null;
    }
  }
}
