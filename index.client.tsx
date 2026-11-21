import {
  useHosts,
  type PluginClientContext,
  type PluginSidebarItemProps,
  type PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import { SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Text, View } from "react-native";

import {
  askCopilotRpc,
  generateRadarInsightsRpc,
  loadRadarRpc,
  parseGoalCommandArgs,
  parseInsightsCommandArgs,
  RADAR_PANEL_ID,
  RADAR_SCREEN_ID,
  scanRadarRpc,
  setRadarGoalRpc,
  toggleRadarCoordRpc,
} from "./shared/radar";
import { radarMessages } from "./client/i18n";
import { shortModelName } from "./client/radar-card";
import { RadarScreen, useRadarSnapshot } from "./client/radar-screen";
import {
  bindRadarScreenOpener,
  bindRadarSettingsOpener,
  findCardForWorkspaceOrAgent,
  getCachedRadarSnapshot,
  setCachedRadarSnapshot,
} from "./client/radar-store";
import { RADAR_SETTINGS_ID, RadarSettingsScreen } from "./client/settings-screen";
import {
  RadarAgentPanel,
  RadarWorkspacePanel,
  registerSessionCardButtons,
} from "./client/session-links";

type CommandRpc = PluginWorkspaceCommandContext["rpc"];

async function sendToRadarCopilot(
  client: PluginClientContext,
  rpc: CommandRpc,
  args: string,
): Promise<void> {
  const text = args.trim();
  if (text === "") throw new Error(client.i18n.t(radarMessages, "nav.slashUsage"));
  await rpc(askCopilotRpc, { text });
}

const notifiedModelAlertStamps = new Map<string, string>();

function RadarSidebarItem({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const hosts = useHosts();
  const multiHost = hosts.length > 1;
  const snap = useRadarSnapshot(8000, host.id);
  const toast = useToast();
  const actionable = snap.data?.counts.attention ?? 0;
  const modelAlerts = snap.data?.modelAlerts ?? [];
  const hasModelAlert = modelAlerts.length > 0;
  const hasErrorAlert = modelAlerts.some((a) => a.severity !== "warning");

  useEffect(() => {
    const hostPrefix = multiHost ? `[${host.label}] ` : "";
    for (const alert of modelAlerts) {
      const dedupeKey = `${host.id}:${alert.key}`;
      if (notifiedModelAlertStamps.get(dedupeKey) === alert.occurredAt) continue;
      notifiedModelAlertStamps.set(dedupeKey, alert.occurredAt);
      if (alert.severity === "warning") {
        const target = alert.fallbackModel ? ` → ${shortModelName(alert.fallbackModel)}` : "";
        toast.show(
          `${hostPrefix}Radar ${alert.role} (${shortModelName(alert.model)}${target}): ${alert.message}`,
          { variant: "warning" },
        );
      } else {
        toast.error(
          `${hostPrefix}Radar ${alert.role} (${shortModelName(alert.model)}): ${alert.message}`,
        );
      }
    }
  }, [host.id, host.label, modelAlerts, multiHost, toast]);

  return (
    <SidebarRow
      icon="Radar"
      active={currentScreen?.screenId === RADAR_SCREEN_ID}
      trailing={
        actionable === 0 && !hasModelAlert ? undefined : (
          <View
            style={{
              minWidth: 18,
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 9,
              alignItems: "center",
              backgroundColor: hasErrorAlert
                ? theme.colors.statusDanger
                : hasModelAlert
                  ? theme.colors.statusWarning
                  : theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: hasModelAlert ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: hasModelAlert ? "700" : "500",
              }}
            >
              {hasModelAlert && actionable === 0 ? "!" : actionable}
            </Text>
          </View>
        )
      }
      onPress={() => openScreen({ screenId: RADAR_SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const scope = client.paseo;

  bindRadarScreenOpener(scope, (target) => {
    const params: Record<string, string> = {};
    if (target?.cardId) params.cardId = target.cardId;
    if (target?.coordCardId) params.coordCardId = target.coordCardId;
    client.openScreen({
      screenId: RADAR_SCREEN_ID,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
  });
  bindRadarSettingsOpener(scope, () => {
    client.openSettings(RADAR_SETTINGS_ID);
  });

  const stopSettings = client.addSettingsScreen({
    id: RADAR_SETTINGS_ID,
    title: radarMessages.message("nav.settingsTitle"),
    icon: "Radar",
    Component: RadarSettingsScreen,
  });

  const stopScreen = client.addScreen({
    id: RADAR_SCREEN_ID,
    title: radarMessages.message("nav.screenTitle"),
    Component: RadarScreen,
  });

  const stopSidebar = client.addSidebarHeaderItem({
    id: RADAR_SCREEN_ID,
    title: radarMessages.message("nav.screenTitle"),
    Component: RadarSidebarItem,
  });

  const stopWsPanel = client.addWorkspacePanel({
    id: RADAR_PANEL_ID,
    title: radarMessages.message("nav.panelTitle"),
    icon: "Radar",
    locations: ["explorer", "workspace"],
    Component: RadarWorkspacePanel,
  });

  const stopAgentPanel = client.addAgentPanel({
    id: `${RADAR_PANEL_ID}-agent`,
    title: radarMessages.message("nav.panelTitle"),
    icon: "Radar",
    locations: ["explorer", "workspace"],
    Component: RadarAgentPanel,
  });

  const stopButtons = registerSessionCardButtons(client);

  const stopCmdOpen = client.addCommandCenterItem({
    id: "open-radar",
    title: radarMessages.message("nav.cmdOpen"),
    icon: "Radar",
    keywords: ["radar", "inbox", "todo", "triage", "待办", "oncall", "雷达"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: RADAR_SCREEN_ID });
    },
  });

  const stopCmdLocate = client.addCommandCenterItem({
    id: "locate-in-radar",
    title: radarMessages.message("nav.cmdLocate"),
    icon: "Crosshair",
    keywords: ["radar", "card", "locate", "定位", "卡片"],
    context: "agent",
    async onSelect({ paseo, rpc, workspace, agent, openScreen }) {
      let snap = getCachedRadarSnapshot(paseo);
      if (!snap) {
        snap = await rpc(loadRadarRpc, {}).catch(() => null);
        if (snap) setCachedRadarSnapshot(paseo, snap);
      }
      const card = findCardForWorkspaceOrAgent(snap, workspace.id, agent.id);
      openScreen({
        screenId: RADAR_SCREEN_ID,
        params: card ? { cardId: card.id } : { cardId: `ws-${workspace.id}` },
      });
    },
  });

  const stopCmdScan = client.addCommandCenterItem({
    id: "scan-radar",
    title: radarMessages.message("nav.cmdScan"),
    icon: "RefreshCw",
    keywords: ["radar", "scan", "sync", "刷新", "扫描"],
    context: "global",
    onSelect({ paseo, rpc, openScreen }) {
      openScreen({ screenId: RADAR_SCREEN_ID });
      void rpc(scanRadarRpc, {}).then((snap) => {
        setCachedRadarSnapshot(paseo, snap);
      });
    },
  });

  const stopCmdSettings = client.addCommandCenterItem({
    id: "radar-settings",
    title: radarMessages.message("nav.cmdSettings"),
    icon: "Settings",
    keywords: ["radar", "settings", "model", "collector", "设置", "模型", "采集器"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(RADAR_SETTINGS_ID);
    },
  });

  const stopCmdInsights = client.addCommandCenterItem({
    id: "radar-insights",
    title: radarMessages.message("nav.cmdInsights"),
    icon: "Sparkles",
    keywords: ["radar", "insight", "insights", "report", "analytics", "洞察", "报告", "复盘", "统计"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: RADAR_SCREEN_ID, params: { tab: "insights" } });
    },
  });

  const stopSlash = client.addSlashCommand({
    name: "radar",
    description: radarMessages.message("nav.slashDesc"),
    argumentHint: "<message>",
    context: "workspace",
    onSubmit({ args, rpc, openScreen }) {
      openScreen({ screenId: RADAR_SCREEN_ID });
      return sendToRadarCopilot(client, rpc, args);
    },
  });

  const stopGoalSlash = client.addSlashCommand({
    name: "radar-goal",
    description: radarMessages.message("nav.slashGoalDesc"),
    argumentHint: "[goal] | off | resume | clear",
    context: "workspace",
    async onSubmit(ctx) {
      const parsed = parseGoalCommandArgs(ctx.args);
      if (parsed.kind === "help") {
        throw new Error(client.i18n.t(radarMessages, "nav.slashGoalUsage"));
      }
      const maybeAgentId = (ctx as { agent?: { id?: string } }).agent?.id;
      const res = await ctx.rpc(setRadarGoalRpc, {
        workspaceId: ctx.workspace.id,
        ...(maybeAgentId ? { agentId: maybeAgentId } : {}),
        action: parsed.kind,
        ...(parsed.kind === "set"
          ? {
              spec: parsed.spec,
              verifyCommand: parsed.verifyCommand,
              maxTurns: parsed.maxTurns,
            }
          : {}),
        steerNow: true,
      });
      setCachedRadarSnapshot(ctx.paseo, res.snapshot);
    },
  });

  const stopInsightsSlash = client.addSlashCommand({
    name: "radar-insights",
    description: radarMessages.message("nav.slashInsightsDesc"),
    argumentHint: "[7d|14d|30d|all] [focus]",
    context: "workspace",
    onSubmit({ args, rpc, openScreen }) {
      const parsed = parseInsightsCommandArgs(args);
      openScreen({ screenId: RADAR_SCREEN_ID, params: { tab: "insights" } });
      void rpc(generateRadarInsightsRpc, {
        window: parsed.window,
        ...(parsed.focus ? { customFocus: parsed.focus } : {}),
      });
    },
  });

  const stopCoordSlash = client.addSlashCommand({
    name: "radar-coord",
    description: radarMessages.message("nav.slashCoordDesc"),
    argumentHint: "[on|off|open|status]",
    context: "workspace",
    async onSubmit(ctx) {
      const arg = ctx.args.trim().toLowerCase();
      const maybeAgentId = (ctx as { agent?: { id?: string } }).agent?.id;
      const resolveCurrentCard = async () => {
        let snap = getCachedRadarSnapshot(ctx.paseo);
        let card = findCardForWorkspaceOrAgent(snap, ctx.workspace.id, maybeAgentId);
        if (!card) {
          snap = await ctx.rpc(loadRadarRpc, {});
          setCachedRadarSnapshot(ctx.paseo, snap);
          card = findCardForWorkspaceOrAgent(snap, ctx.workspace.id, maybeAgentId);
        }
        return card;
      };

      if (arg === "open" || arg === "board") {
        const card = await resolveCurrentCard();
        if (card) {
          ctx.openScreen({ screenId: RADAR_SCREEN_ID, params: { coordCardId: card.id } });
        } else {
          ctx.openScreen({ screenId: RADAR_SCREEN_ID });
        }
        return;
      }

      if (arg === "status") {
        const card = await resolveCurrentCard();
        if (card?.coordination?.enabled) {
          ctx.openScreen({ screenId: RADAR_SCREEN_ID, params: { coordCardId: card.id } });
        } else if (card) {
          ctx.openScreen({ screenId: RADAR_SCREEN_ID, params: { cardId: card.id } });
        } else {
          ctx.openScreen({ screenId: RADAR_SCREEN_ID });
        }
        return;
      }

      if (arg === "off" || arg === "disable") {
        const res = await ctx.rpc(toggleRadarCoordRpc, {
          workspaceId: ctx.workspace.id,
          ...(maybeAgentId ? { agentId: maybeAgentId } : {}),
          enabled: false,
          steerNow: false,
        });
        setCachedRadarSnapshot(ctx.paseo, res.snapshot);
        return;
      }

      if (arg === "" || arg === "on" || arg === "enable") {
        const res = await ctx.rpc(toggleRadarCoordRpc, {
          workspaceId: ctx.workspace.id,
          ...(maybeAgentId ? { agentId: maybeAgentId } : {}),
          enabled: true,
          steerNow: true,
        });
        setCachedRadarSnapshot(ctx.paseo, res.snapshot);
        ctx.openScreen({ screenId: RADAR_SCREEN_ID, params: { coordCardId: res.cardId } });
        return;
      }

      throw new Error(client.i18n.t(radarMessages, "nav.slashCoordUsage"));
    },
  });

  return () => {
    bindRadarScreenOpener(scope, null);
    bindRadarSettingsOpener(scope, null);
    stopSettings();
    stopCmdSettings();
    stopCmdInsights();
    stopButtons();
    stopScreen();
    stopSidebar();
    stopWsPanel();
    stopAgentPanel();
    stopCmdOpen();
    stopCmdLocate();
    stopCmdScan();
    stopSlash();
    stopGoalSlash();
    stopInsightsSlash();
    stopCoordSlash();
  };
}
