import type {
  PluginAgentPanelProps,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import {
  loadRadarRpc,
  lookupRadarSubcardSessionRpc,
  type CardStatus,
} from "../shared/radar";
import { needsMeTagMetaForLocale, statusLabelForLocale, useRadarI18n } from "./i18n";
import { PillButton, RadarCardView, shortModelName, statusColor } from "./radar-card";
import { RADAR_QUERY_KEY, useRadarSnapshot } from "./radar-screen";
import {
  findCardForWorkspaceOrAgent,
  findSubcardSessionInSnapshot,
  getCachedRadarSnapshot,
  getLastSnapshotUpdatedMs,
  openRadarSettings,
  openRadarToCard,
  openRadarToCoordBoard,
  setCachedRadarSnapshot,
  subscribeRadarSnapshot,
} from "./radar-store";

const BG_HOST_POLL_MS = 12_000;
const BG_HOST_FRESH_THRESHOLD_MS = 10_500;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function SubcardSessionBody({
  hostId,
  agentId,
  fallbackParentCardId,
  fallbackParentTitle,
  fallbackSubcardId,
  fallbackSubcardTitle,
  fallbackStatus,
  theme,
  onOpenAgent,
  onClosePopover,
}: {
  hostId: string;
  agentId: string;
  fallbackParentCardId: string;
  fallbackParentTitle: string;
  fallbackSubcardId: string;
  fallbackSubcardTitle: string;
  fallbackStatus: CardStatus;
  theme: PluginButtonContentProps["theme"];
  onOpenAgent: ((id: string) => void) | null;
  onClosePopover?: () => void;
}) {
  const paseo = usePaseo();
  const { isZh, t } = useRadarI18n();
  const { colors } = theme;
  const lookupSubcard = useRpc(lookupRadarSubcardSessionRpc);
  const detailQuery = useQuery({
    queryKey: ["paseo-radar", "subcard-session", hostId, agentId],
    queryFn: () => lookupSubcard({ agentId }),
    refetchInterval: 5000,
  });

  const info = detailQuery.data;
  const parentCardId = info?.parentCardId ?? fallbackParentCardId;
  const parentCardTitle = info?.parentCardTitle ?? fallbackParentTitle;
  const subcardId = info?.subcardId ?? fallbackSubcardId;
  const subcardTitle = info?.subcardTitle ?? fallbackSubcardTitle;
  const status = info?.status ?? fallbackStatus;
  const coordinatorAgentId = info?.coordinatorAgentId ?? null;
  const upstreamSet = new Set(info?.upstreamIds ?? []);
  const downstreamSet = new Set(info?.downstreamIds ?? []);
  const siblings = info?.siblings ?? [];
  const upstreamArtifacts = info?.upstreamArtifacts ?? [];
  const tone = statusColor(status, theme);

  return (
    <View
      style={{
        padding: 12,
        gap: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <Icon name="GitBranch" size={14} color={colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: 13.5, fontWeight: "700", flex: 1 }} numberOfLines={1}>
            {subcardId} · {subcardTitle}
          </Text>
        </View>
        <View
          style={{
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: tone,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ color: tone, fontSize: 11, fontWeight: "600" }}>
            {statusLabelForLocale(status, isZh)}
          </Text>
        </View>
      </View>

      <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }} numberOfLines={1}>
        {t("coord.parentCardLabel")}: {parentCardTitle}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <PillButton
          icon="LayoutGrid"
          label={t("coord.openBoardBtn")}
          tone="primary"
          theme={theme}
          onPress={() => {
            onClosePopover?.();
            openRadarToCoordBoard(paseo, parentCardId);
          }}
        />
        {onOpenAgent && coordinatorAgentId ? (
          <PillButton
            icon="ArrowLeft"
            label={t("coord.backToCoordinator")}
            theme={theme}
            onPress={() => {
              onClosePopover?.();
              onOpenAgent(coordinatorAgentId);
            }}
          />
        ) : null}
      </View>

      {siblings.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {t("coord.siblingNodes")}
          </Text>
          {siblings.map((sib) => {
            const relation = upstreamSet.has(sib.id)
              ? t("coord.upstreamLabel")
              : downstreamSet.has(sib.id)
                ? t("coord.downstreamLabel")
                : null;
            const canJump = Boolean(onOpenAgent && sib.agentId && sib.agentId !== agentId);
            const sibTone = statusColor(sib.status, theme);
            return (
              <Pressable
                key={sib.id}
                disabled={!canJump}
                onPress={() => {
                  if (canJump && sib.agentId) {
                    onClosePopover?.();
                    onOpenAgent!(sib.agentId);
                  }
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
                    {sib.id} · {sib.title}
                  </Text>
                  <Text style={{ color: sibTone, fontSize: 10.5 }}>
                    {statusLabelForLocale(sib.status, isZh)}
                    {relation ? ` · ${relation}` : ""}
                  </Text>
                </View>
                {canJump ? <Icon name="ArrowUpRight" size={12} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {upstreamArtifacts.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {t("coord.artifactsLabel", { count: upstreamArtifacts.length })}
          </Text>
          {upstreamArtifacts.map((art) => (
            <View
              key={`${art.subcardId}:${art.relativePath}`}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: colors.surface1,
                gap: 2,
              }}
            >
              <Text style={{ color: colors.accent, fontSize: 11.5 }} numberOfLines={1}>
                [{art.subcardId}] {art.relativePath} ({formatBytes(art.sizeBytes)})
              </Text>
              {art.note ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                  {art.note}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function LinkedCardBody({
  hostId,
  workspaceId,
  agentId,
  theme,
  onOpenAgent,
  onClosePopover,
}: {
  hostId: string;
  workspaceId: string;
  agentId?: string | null;
  theme: PluginButtonContentProps["theme"];
  onOpenAgent: ((id: string) => void) | null;
  onClosePopover?: () => void;
}) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const snapQuery = useRadarSnapshot(5000, hostId);
  const { isZh } = useRadarI18n();
  const snap = snapQuery.data ?? null;
  const matchedSubcard = findSubcardSessionInSnapshot(snap, workspaceId, agentId);
  const card = matchedSubcard ? null : findCardForWorkspaceOrAgent(snap, workspaceId, agentId);
  const lookupSubcardRpc = useRpc(lookupRadarSubcardSessionRpc);
  const fallbackLookupQuery = useQuery({
    queryKey: ["paseo-radar", "subcard-session-fallback", hostId, agentId ?? ""],
    enabled: !matchedSubcard && !card && Boolean(agentId),
    queryFn: () => lookupSubcardRpc({ agentId: agentId! }),
    refetchInterval: 8000,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: RADAR_QUERY_KEY });
  }, [queryClient]);

  if (matchedSubcard) {
    return (
      <SubcardSessionBody
        hostId={hostId}
        agentId={matchedSubcard.agentId}
        fallbackParentCardId={matchedSubcard.parentCard.id}
        fallbackParentTitle={matchedSubcard.parentCard.title}
        fallbackSubcardId={matchedSubcard.subcardId}
        fallbackSubcardTitle={matchedSubcard.title}
        fallbackStatus={matchedSubcard.status}
        theme={theme}
        onOpenAgent={onOpenAgent}
        onClosePopover={onClosePopover}
      />
    );
  }

  const fb = fallbackLookupQuery.data;
  if (!card && fb?.found && agentId && fb.parentCardId && fb.subcardId) {
    return (
      <SubcardSessionBody
        hostId={hostId}
        agentId={agentId}
        fallbackParentCardId={fb.parentCardId}
        fallbackParentTitle={fb.parentCardTitle ?? fb.parentCardId}
        fallbackSubcardId={fb.subcardId}
        fallbackSubcardTitle={fb.subcardTitle ?? fb.subcardId}
        fallbackStatus={fb.status ?? "running"}
        theme={theme}
        onOpenAgent={onOpenAgent}
        onClosePopover={onClosePopover}
      />
    );
  }

  if (!card) {
    return (
      <View style={{ padding: 14, gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          {isZh
            ? "当前工作区尚未关联到 Radar 卡片（系统内部会话或未开启本地会话自动纳管）。"
            : "This workspace is not linked to a Radar card."}
        </Text>
      </View>
    );
  }

  const topAlert = snap?.modelAlerts?.[0] ?? null;
  const topAlertColor =
    topAlert?.severity === "warning" ? theme.colors.statusWarning : theme.colors.statusDanger;
  const topAlertTarget = topAlert?.fallbackModel
    ? ` → ${shortModelName(topAlert.fallbackModel)}`
    : "";

  return (
    <View style={{ gap: 8 }}>
      {topAlert ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open model settings"
          onPress={() => {
            onClosePopover?.();
            openRadarSettings(paseo);
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 9,
            paddingVertical: 6,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: topAlertColor,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Icon name="AlertTriangle" size={13} color={topAlertColor} />
          <Text
            style={{ flex: 1, color: topAlertColor, fontSize: 11, lineHeight: 15 }}
            numberOfLines={2}
          >
            {`${topAlert.role} (${shortModelName(topAlert.model)}${topAlertTarget}): ${topAlert.message}`}
          </Text>
          <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
            {isZh ? "设置" : "Settings"}
          </Text>
        </Pressable>
      ) : null}

      <RadarCardView
        item={card}
        projects={snap?.projects ?? []}
        currentAgentId={agentId}
        compactMode
        coordinationBetaEnabled={Boolean(snap?.coordinationBetaEnabled)}
        theme={theme}
        onChanged={refresh}
        onOpenAgent={onOpenAgent}
        onLocateInRadar={() => {
          onClosePopover?.();
          openRadarToCard(paseo, card.id);
        }}
        onOpenCoordBoard={(id) => {
          onClosePopover?.();
          openRadarToCoordBoard(paseo, id);
        }}
      />
    </View>
  );
}

export function RadarPopoverContent(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : null;
  return (
    <View style={{ width: 420, maxWidth: "100%" }}>
      <LinkedCardBody
        hostId={props.host.id}
        workspaceId={props.workspaceId}
        agentId={agentId}
        theme={props.theme}
        onOpenAgent={null}
        onClosePopover={props.close}
      />
    </View>
  );
}

export function RadarWorkspacePanel({ workspaceId, host, theme, navigation }: PluginWorkspacePanelProps) {
  const openAgent =
    navigation === undefined ? null : (id: string) => navigation.openAgent({ agentId: id });
  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <LinkedCardBody hostId={host.id} workspaceId={workspaceId} theme={theme} onOpenAgent={openAgent} />
    </ScrollView>
  );
}

export function RadarAgentPanel({ workspaceId, params, host, theme, navigation }: PluginAgentPanelProps) {
  const openAgent =
    navigation === undefined ? null : (id: string) => navigation.openAgent({ agentId: id });
  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <LinkedCardBody
        hostId={host.id}
        workspaceId={workspaceId}
        agentId={params.agentId}
        theme={theme}
        onOpenAgent={openAgent}
      />
    </ScrollView>
  );
}

export function registerSessionCardButtons(client: PluginClientContext): () => void {
  const scope = client.paseo;
  const pills = new Map<string, { workspaceId: string; label: string; reg: PluginButtonRegistration }>();
  const headers = new Map<string, { label: string; reg: PluginButtonRegistration }>();
  let disposed = false;
  let pollingInFlight = false;

  function syncButtons(): void {
    if (disposed) return;
    const snap = getCachedRadarSnapshot(scope);
    if (!snap) return;

    const isZh = client.i18n.locale.toLowerCase().startsWith("zh");
    const activeAgentIds = new Set<string>();
    const activeWorkspaceIds = new Set<string>();

    const subcardByAgentId = new Map<
      string,
      {
        parentCardId: string;
        subcardId: string;
        title: string;
        status: CardStatus;
        workspaceId: string;
        agentId: string;
      }
    >();
    const subcardByDedicatedWsId = new Map<
      string,
      {
        parentCardId: string;
        subcardId: string;
        title: string;
        status: CardStatus;
        workspaceId: string;
        agentId: string;
      }
    >();

    for (const card of snap.items) {
      const subs = card.coordination?.activeSubcardSessions ?? [];
      for (const sub of subs) {
        const entry = {
          parentCardId: card.id,
          subcardId: sub.subcardId,
          title: sub.title,
          status: sub.status,
          workspaceId: sub.workspaceId,
          agentId: sub.agentId,
        };
        subcardByAgentId.set(sub.agentId, entry);
        if (sub.workspaceId !== card.workspace?.workspaceId) {
          subcardByDedicatedWsId.set(sub.workspaceId, entry);
        }
      }
    }

    for (const card of snap.items) {
      if (!card.workspace) continue;
      const wsId = card.workspace.workspaceId;
      const hasDraft =
        card.status === "needs_me" &&
        card.needsMeTag === "decision" &&
        Boolean(card.decisionProposal?.draft && card.decisionProposal.draft.trim() !== "");
      const statusText = hasDraft
        ? isZh
          ? "待审草稿"
          : "Draft Ready"
        : card.status === "needs_me" && card.needsMeTag
          ? needsMeTagMetaForLocale(card.needsMeTag, isZh).label
          : statusLabelForLocale(card.status, isZh);
      const goalPrefix = card.goal?.active
        ? isZh
          ? `目标 ${card.goal.turnCount}/${card.goal.maxTurns} · `
          : `Goal ${card.goal.turnCount}/${card.goal.maxTurns} · `
        : card.goal?.stopReason === "achieved"
          ? isZh
            ? "目标达成 · "
            : "Goal Met · "
          : card.goal?.stopReason === "max_turns"
            ? isZh
              ? "目标暂停 · "
              : "Goal Paused · "
            : "";
      const coord = card.coordination;
      const pillLabel = coord?.enabled
        ? isZh
          ? `Radar · 协调 ${coord.archived}/${coord.total} · ${statusText}`
          : `Radar · Coord ${coord.archived}/${coord.total} · ${statusText}`
        : `Radar · ${goalPrefix}${statusText}`;
      const headerTitle = coord?.enabled
        ? isZh
          ? `Radar 协调卡片 (${coord.archived}/${coord.total} · ${statusText})`
          : `Radar Coord (${coord.archived}/${coord.total} · ${statusText})`
        : isZh
          ? `Radar 卡片 (${goalPrefix}${statusText})`
          : `Radar Card (${goalPrefix}${statusText})`;

      activeWorkspaceIds.add(wsId);
      const existingHeader = headers.get(wsId);
      if (!existingHeader) {
        const reg = client.addHeaderButton({
          id: "radar-ws-card",
          workspaceId: wsId,
          button: {
            title: headerTitle,
            icon: "Radar",
            behavior: { kind: "popover", Content: RadarPopoverContent },
          },
        });
        headers.set(wsId, { label: pillLabel, reg });
      } else if (existingHeader.label !== pillLabel) {
        existingHeader.reg.update({ title: headerTitle });
        existingHeader.label = pillLabel;
      }

      for (const agentId of card.workspace.agentIds) {
        if (subcardByAgentId.has(agentId)) continue;
        activeAgentIds.add(agentId);
        const existingPill = pills.get(agentId);
        if (existingPill && existingPill.workspaceId !== wsId) {
          existingPill.reg.remove();
          pills.delete(agentId);
        }
        const cur = pills.get(agentId);
        if (!cur) {
          const reg = client.addComposerPill({
            id: "radar-agent-card",
            workspaceId: wsId,
            agentId,
            button: {
              title: isZh ? "查看或操作关联的 Radar 卡片" : "View or update linked Radar card",
              label: pillLabel,
              icon: "Radar",
              behavior: { kind: "popover", Content: RadarPopoverContent },
            },
          });
          pills.set(agentId, { workspaceId: wsId, label: pillLabel, reg });
        } else if (cur.label !== pillLabel) {
          cur.reg.update({ label: pillLabel });
          cur.label = pillLabel;
        }
      }
    }

    for (const sub of subcardByDedicatedWsId.values()) {
      const subHeaderTitle = isZh
        ? `Radar 子卡 ${sub.subcardId}: ${sub.title}`
        : `Radar Subcard ${sub.subcardId}: ${sub.title}`;
      const subHeaderLabel = `sub:${sub.subcardId}:${sub.status}`;
      activeWorkspaceIds.add(sub.workspaceId);
      const existingHeader = headers.get(sub.workspaceId);
      if (!existingHeader) {
        const reg = client.addHeaderButton({
          id: "radar-ws-card",
          workspaceId: sub.workspaceId,
          button: {
            title: subHeaderTitle,
            icon: "GitBranch",
            behavior: { kind: "popover", Content: RadarPopoverContent },
          },
        });
        headers.set(sub.workspaceId, { label: subHeaderLabel, reg });
      } else if (existingHeader.label !== subHeaderLabel) {
        existingHeader.reg.update({ title: subHeaderTitle });
        existingHeader.label = subHeaderLabel;
      }
    }

    for (const sub of subcardByAgentId.values()) {
      const subPillLabel = isZh ? `Radar · 子卡 ${sub.subcardId}` : `Radar · Sub ${sub.subcardId}`;
      activeAgentIds.add(sub.agentId);
      const existingPill = pills.get(sub.agentId);
      if (existingPill && existingPill.workspaceId !== sub.workspaceId) {
        existingPill.reg.remove();
        pills.delete(sub.agentId);
      }
      const cur = pills.get(sub.agentId);
      if (!cur) {
        const reg = client.addComposerPill({
          id: "radar-agent-card",
          workspaceId: sub.workspaceId,
          agentId: sub.agentId,
          button: {
            title: isZh
              ? `子卡 ${sub.subcardId} (${statusLabelForLocale(sub.status, true)})`
              : `Subcard ${sub.subcardId} (${statusLabelForLocale(sub.status, false)})`,
            label: subPillLabel,
            icon: "GitBranch",
            behavior: { kind: "popover", Content: RadarPopoverContent },
          },
        });
        pills.set(sub.agentId, { workspaceId: sub.workspaceId, label: subPillLabel, reg });
      } else if (cur.label !== subPillLabel) {
        cur.reg.update({ label: subPillLabel });
        cur.label = subPillLabel;
      }
    }

    for (const [agentId, entry] of pills) {
      if (!activeAgentIds.has(agentId)) {
        entry.reg.remove();
        pills.delete(agentId);
      }
    }
    for (const [wsId, entry] of headers) {
      if (!activeWorkspaceIds.has(wsId)) {
        entry.reg.remove();
        headers.delete(wsId);
      }
    }
  }

  function pollIfIdle(): void {
    if (disposed || pollingInFlight) return;
    if (Date.now() - getLastSnapshotUpdatedMs(scope) < BG_HOST_FRESH_THRESHOLD_MS) return;
    pollingInFlight = true;
    client
      .rpc(loadRadarRpc, {})
      .then((snap) => {
        if (!disposed) {
          setCachedRadarSnapshot(scope, snap);
        }
      })
      .catch(() => {
        // Ignore transient offline errors; retry on next cadence
      })
      .finally(() => {
        pollingInFlight = false;
      });
  }

  const unsub = subscribeRadarSnapshot(scope, syncButtons);
  syncButtons();
  pollIfIdle();
  const pollTimer = setInterval(pollIfIdle, BG_HOST_POLL_MS);

  return () => {
    disposed = true;
    clearInterval(pollTimer);
    unsub();
    pills.forEach((e) => e.reg.remove());
    pills.clear();
    headers.forEach((e) => e.reg.remove());
    headers.clear();
  };
}
