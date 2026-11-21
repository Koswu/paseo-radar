import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { HumanInteractionEvent, HumanInteractionSource } from "../shared/interactions";

function defaultRadarDataDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-radar");
}

export function interactionsLogPath(baseDir: string = defaultRadarDataDir()): string {
  return join(baseDir, "interactions.jsonl");
}

export interface RecordHumanInteractionInput {
  kind: string;
  source: HumanInteractionSource;
  cardId?: string | null;
  cardTitle?: string | null;
  cardStatus?: string | null;
  cardGroup?: string | null;
  cardSource?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  detail?: Record<string, unknown>;
}

export interface CardContextSnapshot {
  cardId: string;
  title: string | null;
  group: string | null;
  source: string | null;
  customStatus: string | null;
  needsMeTag: string | null;
  selectedModel: string | null;
  selectedProjectId: string | null;
  boundWorkspaceId: string | null;
  boundAgentId: string | null;
  dismissedHash: string | null;
  snoozedUntil: string | null;
}

let interactionIoQueue: Promise<unknown> = Promise.resolve();

function serializedInteractionIo<T>(fn: () => Promise<T>): Promise<T> {
  const next = interactionIoQueue.then(fn, fn);
  interactionIoQueue = next.catch(() => {});
  return next;
}

export async function getCardContextSnapshot(rawCardId: string): Promise<CardContextSnapshot | null> {
  try {
    const [{ normalizeCardId }, { readRadarState }] = await Promise.all([
      import("./entity-keys"),
      import("./store"),
    ]);
    const cardId = normalizeCardId(rawCardId);
    const state = await readRadarState();
    const raw =
      state.rawItems.find((x) => normalizeCardId(x.id) === cardId) ??
      state.customItems.find((x) => normalizeCardId(x.id) === cardId) ??
      null;
    const meta = state.meta[cardId] ?? state.meta[rawCardId] ?? null;
    if (!raw && !meta) return null;
    return {
      cardId,
      title: raw?.title ?? null,
      group: raw?.group ?? null,
      source: raw?.source ?? null,
      customStatus: meta?.customStatus ?? null,
      needsMeTag: meta?.needsMeTag ?? null,
      selectedModel: meta?.selectedModel ?? raw?.triageSelectedModel ?? null,
      selectedProjectId: meta?.selectedProjectId ?? raw?.triageProjectId ?? null,
      boundWorkspaceId: meta?.boundWorkspaceId ?? null,
      boundAgentId: meta?.boundAgentId ?? null,
      dismissedHash: meta?.dismissedHash ?? null,
      snoozedUntil: meta?.snoozedUntil ?? null,
    };
  } catch {
    return null;
  }
}

export async function recordHumanInteraction(
  input: RecordHumanInteractionInput,
  options?: { logPath?: string; skipEnrich?: boolean },
): Promise<HumanInteractionEvent | null> {
  try {
    let enriched: CardContextSnapshot | null = null;
    if (input.cardId && !options?.skipEnrich && input.cardTitle === undefined) {
      enriched = await getCardContextSnapshot(input.cardId);
    }

    const normalizedCardId =
      typeof input.cardId === "string"
        ? options?.skipEnrich
          ? input.cardId.trim()
          : (await import("./entity-keys")).normalizeCardId(input.cardId)
        : input.cardId;

    const event: HumanInteractionEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      ...(normalizedCardId !== undefined ? { cardId: normalizedCardId } : {}),
      ...(input.cardTitle !== undefined
        ? { cardTitle: input.cardTitle }
        : enriched?.title
          ? { cardTitle: enriched.title }
          : {}),
      ...(input.cardStatus !== undefined
        ? { cardStatus: input.cardStatus }
        : enriched?.customStatus
          ? { cardStatus: enriched.customStatus }
          : {}),
      ...(input.cardGroup !== undefined
        ? { cardGroup: input.cardGroup }
        : enriched?.group
          ? { cardGroup: enriched.group }
          : {}),
      ...(input.cardSource !== undefined
        ? { cardSource: input.cardSource }
        : enriched?.source
          ? { cardSource: enriched.source }
          : {}),
      ...(input.agentId !== undefined
        ? { agentId: input.agentId }
        : enriched?.boundAgentId
          ? { agentId: enriched.boundAgentId }
          : {}),
      ...(input.workspaceId !== undefined
        ? { workspaceId: input.workspaceId }
        : enriched?.boundWorkspaceId
          ? { workspaceId: enriched.boundWorkspaceId }
          : {}),
      ...(input.projectId !== undefined
        ? { projectId: input.projectId }
        : enriched?.selectedProjectId
          ? { projectId: enriched.selectedProjectId }
          : {}),
      ...(input.detail && Object.keys(input.detail).length > 0 ? { detail: input.detail } : {}),
    };

    const targetPath = options?.logPath ?? interactionsLogPath();
    await serializedInteractionIo(async () => {
      await mkdir(dirname(targetPath), { recursive: true });
      await appendFile(targetPath, `${JSON.stringify(event)}\n`, "utf8");
    });
    return event;
  } catch (err) {
    console.warn("[paseo-radar] failed to record human interaction:", err);
    return null;
  }
}

export async function readHumanInteractions(
  query?: { limit?: number; kind?: string; cardId?: string },
  logPath: string = interactionsLogPath(),
): Promise<{
  logPath: string;
  totalCount: number;
  byKind: Record<string, number>;
  events: HumanInteractionEvent[];
}> {
  const limit = Math.max(1, Math.min(500, query?.limit ?? 100));
  const filterKind = query?.kind?.trim() || null;
  const filterCardId = query?.cardId ? query.cardId.trim() : null;

  let rawText = "";
  try {
    rawText = await readFile(logPath, "utf8");
  } catch {
    return { logPath, totalCount: 0, byKind: {}, events: [] };
  }

  const byKind: Record<string, number> = {};
  const matched: HumanInteractionEvent[] = [];
  let totalCount = 0;

  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: HumanInteractionEvent;
    try {
      parsed = JSON.parse(trimmed) as HumanInteractionEvent;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.kind !== "string" || typeof parsed.at !== "string") continue;

    totalCount += 1;
    byKind[parsed.kind] = (byKind[parsed.kind] ?? 0) + 1;

    if (filterKind && parsed.kind !== filterKind) continue;
    if (filterCardId && parsed.cardId !== filterCardId) continue;
    matched.push(parsed);
  }

  const events = matched.slice(-limit).reverse();
  return { logPath, totalCount, byKind, events };
}

export function diffSettingsChanges(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | null {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const a = prev[key];
    const b = next[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes[key] = { from: a ?? null, to: b ?? null };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
