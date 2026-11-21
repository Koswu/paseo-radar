import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  archiveBatchRadarCardsRpc,
  archiveRadarCardRpc,
  askCopilotRpc,
  coordSubcardActionRpc,
  deleteRadarInsightReportRpc,
  dismissModelAlertsRpc,
  dismissRadarItemRpc,
  dismissScanErrorsRpc,
  exportRadarInsightHtmlRpc,
  followBatchRadarItemsRpc,
  followRadarItemRpc,
  generateRadarInsightsRpc,
  isDelegatedSubagentLabels,
  checkProviderHealthRpc,
  loadCollectorConfigRpc,
  loadRadarCoordDetailRpc,
  loadRadarInsightsRpc,
  loadRadarInteractionsRpc,
  loadRadarRpc,
  logRadarInteractionRpc,
  lookupRadarSubcardSessionRpc,
  manageRadarCardLinksRpc,
  RADAR_LABELS,
  readRadarCoordArtifactRpc,
  replyRadarCardRpc,
  requestWaitExternalRpc,
  resetCopilotRpc,
  restoreRadarItemRpc,
  retryModelAlertRpc,
  retryScanErrorRpc,
  saveCollectorConfigRpc,
  scanRadarRpc,
  setRadarGoalRpc,
  snoozeRadarItemRpc,
  stopCopilotRpc,
  testRadarCollectorRpc,
  toggleRadarCollectorRpc,
  toggleRadarCoordRpc,
  updateRadarCardRpc,
} from "./shared/radar";
import { radarModelSettings } from "./shared/settings";
import {
  checkCollectorHealth,
  loadCollectorConfigBundle,
  saveCollectorConfigBundle,
  testCollectorScript,
  toggleCollectorScript,
} from "./server/collectors";
import { RadarEngine } from "./server/engine";
import { recordInsightEvent } from "./server/insights";
import {
  diffSettingsChanges,
  getCardContextSnapshot,
  readHumanInteractions,
  recordHumanInteraction,
} from "./server/interaction-log";
import { isPiProvider, readRadarState, withCoordinatorSystemPrompt, withWorkerSystemPrompt } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const modelSettings = server.registerSettings(radarModelSettings);
  const engine = new RadarEngine(modelSettings);
  const stopEngine = engine.start();
  const copilotTools = engine.copilotTools();
  const waitCheckTools = engine.waitCheckTools();
  const workerTools = engine.workerTools();
  const coordTools = engine.coordinatorTools();
  const subcardTools = engine.subcardTools();

  let prevSettingsValues: Record<string, unknown> | null = null;
  void modelSettings
    .read()
    .then((initial) => {
      if (initial.status === "ready") {
        prevSettingsValues = initial.values as unknown as Record<string, unknown>;
      }
    })
    .catch(() => {});
  const offSettings = modelSettings.subscribe((next) => {
    if (next.status !== "ready") return;
    const nextValues = next.values as unknown as Record<string, unknown>;
    if (prevSettingsValues) {
      const changes = diffSettingsChanges(prevSettingsValues, nextValues);
      if (changes) {
        void recordHumanInteraction({
          kind: "settings.update",
          source: "settings",
          detail: { changes },
        });
      }
    }
    prevSettingsValues = nextValues;
  });

  server.handle(loadRadarRpc, (_input, { paseo }) => engine.loadSnapshot(paseo));

  server.handle(scanRadarRpc, async (_input, { paseo }) => {
    engine.rememberPaseo(paseo);
    await engine.archiveCopilot(paseo, true);
    await engine.scan();
    const snap = await engine.loadSnapshot(paseo);
    void recordHumanInteraction({
      kind: "board.scan",
      source: "rpc",
      detail: {
        deltaCount: snap.lastScanDeltaCount,
        triageTriggered: snap.lastScanTriageTriggered,
        boardTotal: snap.counts.boardTotal,
      },
    });
    return snap;
  });

  server.handle(followRadarItemRpc, async (input, { paseo }) => {
    const res = await engine.followItem(paseo, input);
    void recordHumanInteraction({
      kind: "card.follow",
      source: "rpc",
      cardId: input.itemId,
      workspaceId: res.workspaceId,
      agentId: res.agentId,
      detail: {
        mode: input.mode,
        note: input.note || undefined,
      },
    });
    return res;
  });

  server.handle(followBatchRadarItemsRpc, async ({ itemIds }, { paseo }) => {
    const res = await engine.followBatchBackground(paseo, itemIds);
    void recordHumanInteraction({
      kind: "card.follow_batch",
      source: "rpc",
      detail: {
        itemIds,
        startedCount: res.startedCount,
        failedCount: res.failedCount,
      },
    });
    return res;
  });

  server.handle(replyRadarCardRpc, async (input, { paseo }) => {
    const res = await engine.replyToCardSession(paseo, input);
    void recordHumanInteraction({
      kind: input.decisionApproval ? "card.decision_reply" : "card.reply",
      source: "rpc",
      cardId: input.itemId,
      agentId: res.agentId,
      detail: {
        text: input.text || undefined,
        ...(input.decisionApproval
          ? {
              edited: input.decisionApproval.edited,
              title: input.decisionApproval.title ?? null,
              target: input.decisionApproval.target ?? null,
              draft: input.decisionApproval.draft ?? null,
            }
          : {}),
      },
    });
    return res;
  });

  server.handle(requestWaitExternalRpc, async (input, { paseo }) => {
    const res = await engine.requestWaitExternal(paseo, input);
    void recordHumanInteraction({
      kind: "card.request_wait",
      source: "rpc",
      cardId: input.itemId,
      agentId: res.agentId,
      detail: { note: input.note },
    });
    return res;
  });

  server.handle(updateRadarCardRpc, async (input, { paseo }) => {
    const before = await getCardContextSnapshot(input.itemId);
    await engine.updateCard(paseo, input);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.status !== undefined) {
      changes.status = { from: before?.customStatus ?? null, to: input.status };
    }
    if (input.needsMeTag !== undefined) {
      changes.needsMeTag = { from: before?.needsMeTag ?? null, to: input.needsMeTag };
    }
    if (input.selectedModel !== undefined) {
      changes.selectedModel = { from: before?.selectedModel ?? null, to: input.selectedModel };
    }
    if (input.projectId !== undefined) {
      changes.projectId = { from: before?.selectedProjectId ?? null, to: input.projectId };
    }
    void recordHumanInteraction({
      kind: "card.update",
      source: "rpc",
      cardId: input.itemId,
      cardTitle: before?.title ?? null,
      cardStatus: input.status ?? before?.customStatus ?? null,
      cardGroup: before?.group ?? null,
      cardSource: before?.source ?? null,
      agentId: input.targetAgentId ?? before?.boundAgentId ?? null,
      workspaceId: before?.boundWorkspaceId ?? null,
      projectId: input.projectId ?? before?.selectedProjectId ?? null,
      detail: { changes },
    });
    return {};
  });

  server.handle(setRadarGoalRpc, async (input, { paseo }) => {
    const res = await engine.setCardGoal(paseo, input);
    void recordHumanInteraction({
      kind: "card.goal",
      source: "rpc",
      cardId: res.cardId,
      agentId: res.agentId ?? input.agentId ?? null,
      workspaceId: input.workspaceId ?? null,
      detail: {
        action: input.action,
        spec: input.spec,
        verifyCommand: input.verifyCommand ?? null,
        maxTurns: input.maxTurns,
        steerNow: input.steerNow,
      },
    });
    return res;
  });

  server.handle(manageRadarCardLinksRpc, async ({ itemId, add, removeUrls }, { paseo }) => {
    const res = await engine.manageCardLinks(paseo, {
      cardId: itemId,
      add,
      removeUrls,
    });
    void recordHumanInteraction({
      kind: "card.links",
      source: "rpc",
      cardId: itemId,
      detail: {
        added: add?.length ? add : undefined,
        removedUrls: removeUrls?.length ? removeUrls : undefined,
      },
    });
    return { links: res.links };
  });

  server.handle(archiveRadarCardRpc, async ({ itemId }, { paseo }) => {
    const before = await getCardContextSnapshot(itemId);
    await engine.archiveCardAndSession(paseo, itemId);
    void recordHumanInteraction({
      kind: "card.archive",
      source: "rpc",
      cardId: itemId,
      cardTitle: before?.title ?? null,
      cardStatus: before?.customStatus ?? null,
      cardGroup: before?.group ?? null,
      cardSource: before?.source ?? null,
      agentId: before?.boundAgentId ?? null,
      workspaceId: before?.boundWorkspaceId ?? null,
      projectId: before?.selectedProjectId ?? null,
      detail: {
        previousNeedsMeTag: before?.needsMeTag ?? null,
      },
    });
    return {};
  });

  server.handle(archiveBatchRadarCardsRpc, async ({ itemIds }, { paseo }) => {
    const archivedCount = await engine.archiveBatchCards(paseo, itemIds);
    void recordHumanInteraction({
      kind: "card.archive_batch",
      source: "rpc",
      detail: { itemIds, archivedCount },
    });
    return { archivedCount };
  });

  server.handle(snoozeRadarItemRpc, async ({ itemId, preset }) => {
    const snoozedUntil = await engine.snoozeItem(itemId, preset);
    void recordHumanInteraction({
      kind: "card.snooze",
      source: "rpc",
      cardId: itemId,
      detail: { preset, snoozedUntil },
    });
    return { snoozedUntil };
  });

  server.handle(dismissRadarItemRpc, async ({ itemId }) => {
    await engine.dismissItem(itemId);
    void recordHumanInteraction({
      kind: "card.dismiss",
      source: "rpc",
      cardId: itemId,
    });
    return {};
  });

  server.handle(restoreRadarItemRpc, async ({ itemId }) => {
    const before = await getCardContextSnapshot(itemId);
    await engine.restoreItem(itemId);
    void recordHumanInteraction({
      kind: "card.restore",
      source: "rpc",
      cardId: itemId,
      cardTitle: before?.title ?? null,
      cardStatus: before?.customStatus ?? null,
      cardGroup: before?.group ?? null,
      cardSource: before?.source ?? null,
      detail: {
        wasDismissed: Boolean(before?.dismissedHash),
        wasSnoozed: Boolean(before?.snoozedUntil),
      },
    });
    return {};
  });

  server.handle(askCopilotRpc, async ({ text }, { paseo }) => {
    const agentId = await engine.askCopilot(paseo, text);
    void recordHumanInteraction({
      kind: "copilot.ask",
      source: "rpc",
      agentId,
      detail: { text },
    });
    return { agentId };
  });

  server.handle(resetCopilotRpc, async ({ onlyIfIdle }, { paseo }) => {
    const archived = await engine.archiveCopilot(paseo, onlyIfIdle);
    void recordHumanInteraction({
      kind: "copilot.reset",
      source: "rpc",
      detail: { onlyIfIdle, archived },
    });
    return { archived };
  });

  server.handle(stopCopilotRpc, async () => {
    await engine.stopCopilot();
    void recordHumanInteraction({
      kind: "copilot.stop",
      source: "rpc",
    });
    return {};
  });

  server.handle(dismissModelAlertsRpc, async ({ key }) => {
    engine.dismissModelAlerts(key);
    void recordHumanInteraction({
      kind: "alert.dismiss",
      source: "rpc",
      detail: { key: key ?? "all" },
    });
    return {};
  });

  server.handle(retryModelAlertRpc, async ({ key }, { paseo }) => {
    const res = await engine.retryModelAlert(paseo, key);
    void recordHumanInteraction({
      kind: "alert.retry",
      source: "rpc",
      detail: { key, retried: res.retried, message: res.message },
    });
    return res;
  });

  server.handle(dismissScanErrorsRpc, async (input) => {
    await engine.dismissScanErrors(input);
    void recordHumanInteraction({
      kind: "scan_error.dismiss",
      source: "rpc",
      detail: { error: input.error, filename: input.filename },
    });
    return {};
  });

  server.handle(retryScanErrorRpc, async (input, { paseo }) => {
    const res = await engine.retryScanError(paseo, input);
    void recordHumanInteraction({
      kind: "scan_error.retry",
      source: "rpc",
      detail: {
        error: input.error,
        filename: input.filename,
        ok: res.ok,
      },
    });
    return res;
  });

  server.handle(toggleRadarCollectorRpc, async ({ filename, enabled }) => {
    const res = await toggleCollectorScript(filename, enabled);
    void recordHumanInteraction({
      kind: "collector.toggle",
      source: "rpc",
      detail: { filename, enabled: res.enabled },
    });
    return res;
  });

  server.handle(checkProviderHealthRpc, ({ filename }) => checkCollectorHealth(filename));

  server.handle(testRadarCollectorRpc, async ({ filename }, { paseo }) => {
    const cfg = await engine.getModels(paseo);
    const res = await testCollectorScript(filename, cfg.timezone);
    await engine.syncCollectorTestResult(filename, res);
    const out = {
      ok: res.ok,
      filename,
      durationMs: Math.round(res.durationMs),
      itemCount: res.itemCount,
      warnings: res.warnings,
      error: res.error ?? null,
    };
    void recordHumanInteraction({
      kind: "collector.test",
      source: "rpc",
      detail: {
        filename,
        ok: out.ok,
        durationMs: out.durationMs,
        itemCount: out.itemCount,
        error: out.error,
      },
    });
    return out;
  });

  server.handle(loadCollectorConfigRpc, async () => loadCollectorConfigBundle());

  server.handle(saveCollectorConfigRpc, async (input) => {
    const res = await saveCollectorConfigBundle(input);
    void recordHumanInteraction({
      kind: "collector.config_save",
      source: "rpc",
      detail: {
        ok: res.ok,
        mutedKeywordsCount: input.mutedKeywords?.length ?? null,
        mutedChannelsCount: input.mutedChannels?.length ?? null,
      },
    });
    return res;
  });

  server.handle(loadRadarInsightsRpc, ({ reportId }, { paseo }) =>
    engine.loadInsights(paseo, reportId),
  );

  server.handle(generateRadarInsightsRpc, async (input, { paseo }) => {
    const res = await engine.generateInsights(paseo, input);
    void recordHumanInteraction({
      kind: "insights.generate",
      source: "rpc",
      detail: {
        window: input.window,
        forceRefreshCache: input.forceRefreshCache ?? false,
      },
    });
    return res;
  });

  server.handle(exportRadarInsightHtmlRpc, async ({ reportId }) => {
    const res = await engine.exportInsightHtml(reportId);
    void recordHumanInteraction({
      kind: "insights.export_html",
      source: "rpc",
      detail: { reportId },
    });
    return res;
  });

  server.handle(deleteRadarInsightReportRpc, async ({ reportId }) => {
    const res = await engine.deleteInsightReport(reportId);
    void recordHumanInteraction({
      kind: "insights.delete",
      source: "rpc",
      detail: { reportId, ok: res.ok },
    });
    return res;
  });

  server.handle(logRadarInteractionRpc, async (input) => {
    const saved = await recordHumanInteraction({
      kind: input.kind,
      source: "ui",
      cardId: input.cardId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      detail: input.detail,
    });
    return { ok: saved !== null };
  });

  server.handle(loadRadarInteractionsRpc, async (input) =>
    readHumanInteractions({
      limit: input.limit,
      kind: input.kind,
      cardId: input.cardId,
    }),
  );

  server.handle(toggleRadarCoordRpc, async (input, { paseo }) => {
    const res = await engine.toggleCoordinationByTarget(paseo, input);
    void recordHumanInteraction({
      kind: "card.coord_toggle",
      source: "rpc",
      cardId: res.cardId,
      agentId: input.agentId ?? null,
      workspaceId: input.workspaceId ?? null,
      detail: { enabled: res.enabled },
    });
    return res;
  });

  server.handle(loadRadarCoordDetailRpc, async ({ cardId, eventLimit }, { paseo }) =>
    engine.getCoordBoardDetail(paseo, cardId, eventLimit),
  );

  server.handle(readRadarCoordArtifactRpc, async ({ cardId, relativePath }, { paseo }) =>
    engine.readCoordArtifact(paseo, cardId, relativePath),
  );

  server.handle(coordSubcardActionRpc, async (input, { paseo }) => {
    const res = await engine.handleCoordSubcardAction(paseo, input);
    void recordHumanInteraction({
      kind: "card.coord_subcard_action",
      source: "rpc",
      cardId: input.cardId,
      detail: { subcardId: input.subcardId, action: input.action },
    });
    return res;
  });

  server.handle(lookupRadarSubcardSessionRpc, async ({ agentId }, { paseo }) =>
    engine.lookupSubcardSession(paseo, agentId),
  );

  const offCreate = server.addHook("agent.create.before", async ({ request }) => {
    if (request.config.internal) return request;
    if (request.env?.PASEO_RADAR_ROLE === "subcard") return request;
    if (request.config.cwd.includes("/.paseo/plugin-data/")) return request;
    const cfg = await engine.getRawSettings();
    if (!cfg.trackLocalWorkspaces) return request;
    const isCoordPrompt = request.config.systemPrompt?.includes("# Radar 协调模式");
    const isPi = isPiProvider(request.config.provider);
    const nextPrompt = isCoordPrompt
      ? withCoordinatorSystemPrompt(request.config.systemPrompt, cfg.timezone, undefined, isPi)
      : withWorkerSystemPrompt(request.config.systemPrompt, cfg.timezone, isPi);
    if (nextPrompt === request.config.systemPrompt) return request;
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt: nextPrompt,
      },
    };
  });

  const offOpen = server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose !== "interactive") return request;
    // Subcard agents carry RADAR_LABELS.subcard; check BEFORE isDelegatedSubagentLabels!
    if (request.labels[RADAR_LABELS.subcard]) {
      request.tools.push(...subcardTools);
      return request;
    }
    if (isDelegatedSubagentLabels(request.labels)) return request;
    const role = request.labels[RADAR_LABELS.role];
    if (role === RADAR_LABELS.oneshotRole || request.cwd.includes("/.paseo/plugin-data/paseo-radar/oneshot")) {
      return request;
    }
    if (role === RADAR_LABELS.copilotRole) {
      request.tools.push(...copilotTools);
      return request;
    }
    if (request.cwd.includes("/.paseo/plugin-data/paseo-radar/")) {
      request.tools.push(...waitCheckTools);
      return request;
    }

    const [cfg, state] = await Promise.all([engine.getRawSettings(), readRadarState()]);
    const cardLabel = request.labels[RADAR_LABELS.card];
    const matchedMeta =
      (cardLabel ? state.meta[cardLabel] : undefined) ??
      (request.workspaceId ? state.meta[`ws-${request.workspaceId}`] : undefined) ??
      Object.values(state.meta).find(
        (m) =>
          (request.workspaceId && m?.boundWorkspaceId === request.workspaceId) ||
          m?.boundAgentId === request.agentId,
      );
    const cardAlreadyCoord =
      Boolean(matchedMeta?.coordinationEnabled) || request.labels[RADAR_LABELS.coordMode] === "1";

    if (cfg.trackLocalWorkspaces || Boolean(cardLabel) || Boolean(matchedMeta)) {
      request.tools.push(...workerTools);
      if (cfg.coordinationBetaEnabled || cardAlreadyCoord) {
        request.tools.push(...coordTools);
      }
      return request;
    }

    return request;
  });

  const offTurnBefore = server.addHook("agent.turn.before", async ({ agent }) => {
    await engine.onAgentTurnBefore(agent);
  });

  const offTurnAfter = server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    await engine.onAgentTurnAfter(paseo, agent.id, outcome, agent.parentAgentId);
  });

  const offAgentArchive = server.addHook("agent.archive.after", async ({ agent, archivedAt }, { paseo }) => {
    await engine.onAgentArchived(paseo, agent, archivedAt);
  });

  const offWsArchive = server.addHook("workspace.archive.after", async ({ workspace }) => {
    await engine.onWorkspaceArchived(workspace.id, workspace.archivedAt ?? new Date().toISOString());
  });

  const offPermAfter = server.addHook("agent.permission.after", async ({ agent, resolution }) => {
    if (agent.cwd?.includes("/.paseo/plugin-data/")) return;
    void recordInsightEvent({
      type: "permission_resolved",
      at: new Date().toISOString(),
      behavior: resolution.behavior,
    });
    void recordHumanInteraction({
      kind: "permission.resolve",
      source: "hook",
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      detail: {
        behavior: resolution.behavior,
      },
    });
  });

  return () => {
    stopEngine();
    offSettings();
    offCreate();
    offOpen();
    offTurnBefore();
    offTurnAfter();
    offAgentArchive();
    offWsArchive();
    offPermAfter();
  };
}
