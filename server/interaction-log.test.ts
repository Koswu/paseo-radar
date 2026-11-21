import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  diffSettingsChanges,
  interactionsLogPath,
  readHumanInteractions,
  recordHumanInteraction,
} from "./interaction-log.ts";

test("recordHumanInteraction appends JSONL and readHumanInteractions queries/filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-radar-interactions-"));
  const logPath = interactionsLogPath(dir);
  try {
    await Promise.all([
      recordHumanInteraction(
        {
          kind: "card.follow",
          source: "rpc",
          cardId: "gh:org/repo#1",
          cardTitle: "Fix bug",
          detail: { mode: "background" },
        },
        { logPath, skipEnrich: true },
      ),
      recordHumanInteraction(
        {
          kind: "card.update",
          source: "rpc",
          cardId: "gh:org/repo#1",
          cardTitle: "Fix bug",
          detail: { changes: { status: { from: "pool", to: "needs_me" } } },
        },
        { logPath, skipEnrich: true },
      ),
      recordHumanInteraction(
        {
          kind: "copilot.ask",
          source: "rpc",
          detail: { text: "Summarize today" },
        },
        { logPath, skipEnrich: true },
      ),
    ]);

    // Inject a malformed line to verify resilient parsing
    await appendFile(logPath, "{not-valid-json\n", "utf8");

    const all = await readHumanInteractions({ limit: 10 }, logPath);
    assert.equal(all.logPath, logPath);
    assert.equal(all.totalCount, 3);
    assert.equal(all.events.length, 3);
    assert.equal(all.byKind["card.follow"], 1);
    assert.equal(all.byKind["card.update"], 1);
    assert.equal(all.byKind["copilot.ask"], 1);

    const byCard = await readHumanInteractions({ limit: 10, cardId: "gh:org/repo#1" }, logPath);
    assert.equal(byCard.totalCount, 3);
    assert.equal(byCard.events.length, 2);

    const byKind = await readHumanInteractions({ limit: 1, kind: "copilot.ask" }, logPath);
    assert.equal(byKind.events.length, 1);
    assert.equal(byKind.events[0]?.kind, "copilot.ask");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffSettingsChanges detects modified fields and returns null when equal", () => {
  const base = { autoScanEnabled: true, timezone: "UTC", copilotModel: ["a"] };
  assert.equal(diffSettingsChanges(base, { ...base }), null);

  const diff = diffSettingsChanges(base, {
    autoScanEnabled: false,
    timezone: "UTC",
    copilotModel: ["a", "b"],
  });
  assert.deepEqual(diff, {
    autoScanEnabled: { from: true, to: false },
    copilotModel: { from: ["a"], to: ["a", "b"] },
  });
});
