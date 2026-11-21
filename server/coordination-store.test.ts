import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCoordEvent,
  countCoordEvents,
  ensureCoordBoardDirs,
  ensureSubcardOutputDir,
  readBoardArtifactContent,
  readCoordBoard,
  readCoordEvents,
  scanDirectoryArtifacts,
  updateCoordBoard,
} from "./coordination-store.ts";

test("coordination-store serializes atomic board writes and reads JSONL events", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-store-"));
  const boardDir = join(root, "card-1");
  try {
    await ensureCoordBoardDirs(boardDir);

    await Promise.all([
      updateCoordBoard(boardDir, "card-1", (b) => {
        b.enabled = true;
        b.subcards.push({
          id: "S1",
          wave: 1,
          title: "Scout",
          objective: "Read logs",
          isolation: "readonly",
          selectedModel: null,
          refCards: [],
          requireReview: false,
          verifyCommand: null,
          status: "pool",
          needsMeTag: null,
          decisionProposal: null,
          waitMode: null,
          waitCondition: null,
          waitBoard: null,
          waitCron: null,
          waitScriptPath: null,
          waitScheduleId: null,
          waitStartedAt: null,
          waitTimeoutAt: null,
          waitMaxTimeoutLabel: null,
          waitCheckNote: null,
          lastWaitCheckAt: null,
          waitConsecutiveErrors: null,
          waitNextRetryAt: null,
          boundWorkspaceId: null,
          boundAgentId: null,
          gitBranch: null,
          commitSha: null,
          links: [],
          closureEvidence: null,
          artifacts: [],
          inbox: [],
          p2pRoundsByPeer: {},
          canceled: false,
          createdAt: "2026-11-19T10:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-11-19T10:00:00.000Z",
        });
      }),
      updateCoordBoard(boardDir, "card-1", (b) => {
        b.coordinatorAgentId = "ag-coord";
      }),
    ]);

    const board = await readCoordBoard(boardDir);
    assert.ok(board);
    assert.equal(board.enabled, true);
    assert.equal(board.coordinatorAgentId, "ag-coord");
    assert.equal(board.subcards.length, 1);

    await appendCoordEvent(boardDir, { kind: "coord.enabled", actor: "human", summary: "Enabled" });
    await appendCoordEvent(boardDir, { kind: "subcard.created", actor: "coordinator", subcardId: "S1", summary: "Created S1" });
    await appendCoordEvent(boardDir, { kind: "subcard.started", actor: "engine", subcardId: "S1", summary: "Started S1" });

    assert.equal(await countCoordEvents(boardDir), 3);
    const recent = await readCoordEvents(boardDir, 2);
    assert.equal(recent.totalCount, 3);
    assert.equal(recent.events.length, 2);
    assert.equal(recent.events[0]!.kind, "subcard.created");
    assert.equal(recent.events[1]!.kind, "subcard.started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanDirectoryArtifacts and readBoardArtifactContent enforce safety and truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-coord-art-"));
  const boardDir = join(root, "board");
  const outsideFile = join(root, "outside-secret.txt");
  try {
    await ensureCoordBoardDirs(boardDir);
    const outDir = await ensureSubcardOutputDir(boardDir, "S1");
    await writeFile(outsideFile, "top-secret", "utf8");
    await writeFile(join(outDir, "findings.md"), "0123456789abcdefghijEXTRA", "utf8");
    await writeFile(join(outDir, ".hidden"), "ignore", "utf8");
    await mkdir(join(outDir, "nested"), { recursive: true });
    await writeFile(join(outDir, "nested", "data.json"), "{\"ok\":true}", "utf8");
    await symlink(outsideFile, join(outDir, "escape-link.txt"));

    const scanned = await scanDirectoryArtifacts(boardDir, "cards/S1", {
      "cards/S1/findings.md": "Root cause doc",
    });
    assert.equal(scanned.length, 2);
    assert.equal(scanned[0]!.relativePath, "cards/S1/findings.md");
    assert.equal(scanned[0]!.note, "Root cause doc");
    assert.equal(scanned[1]!.relativePath, "cards/S1/nested/data.json");

    const truncated = await readBoardArtifactContent(boardDir, "cards/S1/findings.md", 10);
    assert.equal(truncated.content, "0123456789");
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.sizeBytes, 25);

    await assert.rejects(() => readBoardArtifactContent(boardDir, "../outside-secret.txt"));
    await assert.rejects(() => readBoardArtifactContent(boardDir, "cards/S1/escape-link.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
