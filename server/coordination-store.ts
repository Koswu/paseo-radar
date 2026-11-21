import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  ArtifactEntry,
  CoordBoard,
  CoordEvent,
  SubCard,
} from "../shared/coordination";

const MAX_ARTIFACT_SCAN_FILES = 100;
const DEFAULT_MAX_READ_BYTES = 64 * 1024;

const boardWriteQueues = new Map<string, Promise<unknown>>();

function serializedForBoard<T>(boardDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(boardDir);
  const prev = boardWriteQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => {});
  boardWriteQueues.set(key, settled);
  void settled.finally(() => {
    if (boardWriteQueues.get(key) === settled) {
      boardWriteQueues.delete(key);
    }
  });
  return next;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = resolve(filePath, "..");
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export function boardFilePath(boardDir: string): string {
  return join(boardDir, "board.json");
}

export function eventsFilePath(boardDir: string): string {
  return join(boardDir, "events.jsonl");
}

export function sharedDirPath(boardDir: string): string {
  return join(boardDir, "shared");
}

export function cardsRootDirPath(boardDir: string): string {
  return join(boardDir, "cards");
}

export function sanitizeSubcardDirName(subcardId: string): string {
  const clean = subcardId
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return clean || "subcard";
}

export function subcardOutputDirPath(boardDir: string, subcardId: string): string {
  return join(cardsRootDirPath(boardDir), sanitizeSubcardDirName(subcardId));
}

export async function ensureCoordBoardDirs(boardDir: string): Promise<void> {
  await mkdir(boardDir, { recursive: true });
  await mkdir(sharedDirPath(boardDir), { recursive: true });
  await mkdir(cardsRootDirPath(boardDir), { recursive: true });
}

export async function ensureSubcardOutputDir(
  boardDir: string,
  subcardId: string,
): Promise<string> {
  await ensureCoordBoardDirs(boardDir);
  const dir = subcardOutputDirPath(boardDir, subcardId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeCoordBoardDir(boardDir: string): Promise<void> {
  await rm(boardDir, { recursive: true, force: true }).catch(() => {});
}

function defaultCoordBoard(cardId: string, boardDir: string): CoordBoard {
  const now = new Date().toISOString();
  return {
    cardId,
    enabled: false,
    enabledAt: null,
    coordinatorAgentId: null,
    boardDir,
    subcards: [],
    updatedAt: now,
  };
}

function normalizeSubCard(raw: Partial<SubCard>): SubCard | null {
  if (!raw || typeof raw.id !== "string" || !raw.id.trim()) return null;
  const now = new Date().toISOString();
  return {
    id: raw.id.trim(),
    wave: typeof raw.wave === "number" && Number.isInteger(raw.wave) ? raw.wave : 1,
    title: typeof raw.title === "string" ? raw.title : raw.id.trim(),
    objective: typeof raw.objective === "string" ? raw.objective : "",
    isolation: raw.isolation === "worktree" ? "worktree" : "readonly",
    selectedModel: typeof raw.selectedModel === "string" ? raw.selectedModel : null,
    refCards: Array.isArray(raw.refCards) ? raw.refCards.filter((x): x is string => typeof x === "string") : [],
    requireReview: Boolean(raw.requireReview),
    verifyCommand: typeof raw.verifyCommand === "string" ? raw.verifyCommand : null,
    status:
      raw.status === "pool" ||
      raw.status === "running" ||
      raw.status === "needs_me" ||
      raw.status === "waiting_external" ||
      raw.status === "archived"
        ? raw.status
        : "pool",
    needsMeTag:
      raw.needsMeTag === "ready_to_archive" ||
      raw.needsMeTag === "decision" ||
      raw.needsMeTag === "input" ||
      raw.needsMeTag === "review"
        ? raw.needsMeTag
        : null,
    decisionProposal: raw.decisionProposal ?? null,
    waitMode:
      raw.waitMode === "script" || raw.waitMode === "ai" || raw.waitMode === "board"
        ? raw.waitMode
        : null,
    waitCondition: typeof raw.waitCondition === "string" ? raw.waitCondition : null,
    waitBoard: raw.waitBoard ?? null,
    waitCron: typeof raw.waitCron === "string" ? raw.waitCron : null,
    waitScriptPath: typeof raw.waitScriptPath === "string" ? raw.waitScriptPath : null,
    waitScheduleId: typeof raw.waitScheduleId === "string" ? raw.waitScheduleId : null,
    waitStartedAt: typeof raw.waitStartedAt === "string" ? raw.waitStartedAt : null,
    waitTimeoutAt: typeof raw.waitTimeoutAt === "string" ? raw.waitTimeoutAt : null,
    waitMaxTimeoutLabel: typeof raw.waitMaxTimeoutLabel === "string" ? raw.waitMaxTimeoutLabel : null,
    waitCheckNote: typeof raw.waitCheckNote === "string" ? raw.waitCheckNote : null,
    lastWaitCheckAt: typeof raw.lastWaitCheckAt === "string" ? raw.lastWaitCheckAt : null,
    waitConsecutiveErrors:
      typeof raw.waitConsecutiveErrors === "number" ? raw.waitConsecutiveErrors : null,
    waitNextRetryAt: typeof raw.waitNextRetryAt === "string" ? raw.waitNextRetryAt : null,
    boundWorkspaceId: typeof raw.boundWorkspaceId === "string" ? raw.boundWorkspaceId : null,
    boundAgentId: typeof raw.boundAgentId === "string" ? raw.boundAgentId : null,
    gitBranch: typeof raw.gitBranch === "string" ? raw.gitBranch : null,
    commitSha: typeof raw.commitSha === "string" ? raw.commitSha : null,
    links: Array.isArray(raw.links) ? raw.links : [],
    closureEvidence: typeof raw.closureEvidence === "string" ? raw.closureEvidence : null,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    inbox: Array.isArray(raw.inbox) ? raw.inbox : [],
    p2pRoundsByPeer:
      raw.p2pRoundsByPeer && typeof raw.p2pRoundsByPeer === "object"
        ? raw.p2pRoundsByPeer
        : {},
    canceled: Boolean(raw.canceled),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

export async function readCoordBoard(boardDir: string): Promise<CoordBoard | null> {
  try {
    const raw = JSON.parse(await readFile(boardFilePath(boardDir), "utf8")) as Partial<CoordBoard>;
    if (!raw || typeof raw !== "object" || typeof raw.cardId !== "string") {
      return null;
    }
    const subcards = Array.isArray(raw.subcards)
      ? raw.subcards.map((s) => normalizeSubCard(s)).filter((s): s is SubCard => s !== null)
      : [];
    return {
      cardId: raw.cardId,
      enabled: Boolean(raw.enabled),
      enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : null,
      coordinatorAgentId: typeof raw.coordinatorAgentId === "string" ? raw.coordinatorAgentId : null,
      boardDir: typeof raw.boardDir === "string" ? raw.boardDir : boardDir,
      subcards,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function updateCoordBoard<T>(
  boardDir: string,
  cardId: string,
  mutator: (board: CoordBoard) => T | Promise<T>,
): Promise<T> {
  return serializedForBoard(boardDir, async () => {
    await ensureCoordBoardDirs(boardDir);
    const board = (await readCoordBoard(boardDir)) ?? defaultCoordBoard(cardId, boardDir);
    board.boardDir = boardDir;
    const result = await mutator(board);
    board.updatedAt = new Date().toISOString();
    await atomicWriteJson(boardFilePath(boardDir), board);
    return result;
  });
}

export interface AppendCoordEventInput {
  id?: string;
  at?: string;
  kind: CoordEvent["kind"];
  actor: string;
  subcardId?: string | null;
  causedBy?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
}

export async function appendCoordEvent(
  boardDir: string,
  input: AppendCoordEventInput,
): Promise<CoordEvent> {
  const event: CoordEvent = {
    id: input.id ?? `cev-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    actor: input.actor,
    subcardId: input.subcardId ?? null,
    causedBy: input.causedBy ?? null,
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
  };

  await serializedForBoard(boardDir, async () => {
    await mkdir(boardDir, { recursive: true });
    await appendFile(eventsFilePath(boardDir), `${JSON.stringify(event)}\n`, "utf8");
  });
  return event;
}

export async function readCoordEvents(
  boardDir: string,
  limit = 150,
): Promise<{ events: CoordEvent[]; totalCount: number }> {
  let raw: string;
  try {
    raw = await readFile(eventsFilePath(boardDir), "utf8");
  } catch {
    return { events: [], totalCount: 0 };
  }

  const parsed: CoordEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as CoordEvent;
      if (obj && typeof obj.id === "string" && typeof obj.kind === "string") {
        parsed.push(obj);
      }
    } catch {
      // Skip corrupted partial line
    }
  }

  const clamped = Math.max(1, Math.min(500, limit));
  const slice = parsed.length > clamped ? parsed.slice(parsed.length - clamped) : parsed;
  return { events: slice, totalCount: parsed.length };
}

export async function countCoordEvents(boardDir: string): Promise<number> {
  try {
    const raw = await readFile(eventsFilePath(boardDir), "utf8");
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function scanDirectoryArtifacts(
  boardDir: string,
  subDirRelative: string,
  notesByRelPath?: Readonly<Record<string, string>>,
): Promise<ArtifactEntry[]> {
  const baseAbs = resolve(boardDir);
  const startAbs = resolve(baseAbs, subDirRelative);
  const relStart = relative(baseAbs, startAbs);
  if (!relStart || relStart === ".." || relStart.startsWith(`..${sep}`) || isAbsolute(relStart)) {
    return [];
  }

  try {
    await access(startAbs);
  } catch {
    return [];
  }

  const results: ArtifactEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= MAX_ARTIFACT_SCAN_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_ARTIFACT_SCAN_FILES) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const st = await stat(fullPath).catch(() => null);
        if (!st || !st.isFile()) continue;
        const relPath = relative(baseAbs, fullPath).split(sep).join("/");
        const note = notesByRelPath?.[relPath] ?? notesByRelPath?.[entry.name] ?? null;
        results.push({
          relativePath: relPath,
          absolutePath: fullPath,
          sizeBytes: st.size,
          note: note && note.trim() ? note.trim() : null,
          updatedAt: new Date(st.mtimeMs).toISOString(),
        });
      }
    }
  };

  await walk(startAbs);
  return results;
}

export async function readBoardArtifactContent(
  boardDir: string,
  relativePath: string,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): Promise<{ relativePath: string; content: string; truncated: boolean; sizeBytes: number }> {
  const raw = relativePath.trim();
  if (!raw || raw.includes("\0") || isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error("非法的产物文件路径");
  }

  const base = resolve(boardDir);
  const candidate = resolve(base, raw);
  const lexicalRel = relative(base, candidate);
  if (
    !lexicalRel ||
    lexicalRel === "." ||
    lexicalRel === ".." ||
    lexicalRel.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRel)
  ) {
    throw new Error("产物路径越界，已拒绝读取");
  }

  const [realBase, realTarget] = await Promise.all([
    realpath(base),
    realpath(candidate),
  ]);
  const realRel = relative(realBase, realTarget);
  if (
    !realRel ||
    realRel === "." ||
    realRel === ".." ||
    realRel.startsWith(`..${sep}`) ||
    isAbsolute(realRel)
  ) {
    throw new Error("产物路径越界（符号链接逃逸），已拒绝读取");
  }

  const st = await stat(realTarget);
  if (!st.isFile()) {
    throw new Error("目标路径不是普通文件");
  }

  const bytesToRead = Math.min(st.size, Math.max(1, maxBytes));
  const buf = Buffer.alloc(bytesToRead);
  const fh = await open(realTarget, "r");
  try {
    let offset = 0;
    while (offset < bytesToRead) {
      const { bytesRead } = await fh.read(buf, offset, bytesToRead - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      relativePath: realRel.split(sep).join("/"),
      content: buf.subarray(0, offset).toString("utf8"),
      truncated: st.size > bytesToRead,
      sizeBytes: st.size,
    };
  } finally {
    await fh.close();
  }
}
