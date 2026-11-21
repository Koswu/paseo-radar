import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";

import {
  deleteRadarInsightReportRpc,
  exportRadarInsightHtmlRpc,
  generateRadarInsightsRpc,
  loadRadarInsightsRpc,
  logRadarInteractionRpc,
  type InsightDailyPoint,
  type InsightRecommendationCategory,
  type InsightWindow,
  type RadarInsightReport,
} from "../shared/radar";
import { useRadarI18n } from "./i18n";
import { PillButton, shortModelName } from "./radar-card";
import { shortenHomePath } from "./radar-screen";

export function radarInsightsQueryKey(hostId: string, reportId: string | null) {
  return ["paseo-radar", "insights", hostId, reportId ?? "latest"] as const;
}

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function formatShortTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function DeltaPill({
  delta,
  suffix = "",
  inverseGood = false,
  theme,
}: {
  delta: number | undefined | null;
  suffix?: string;
  inverseGood?: boolean;
  theme: PluginTheme;
}) {
  if (delta === undefined || delta === null || delta === 0) return null;
  const { colors } = theme;
  const positive = delta > 0;
  const isGood = inverseGood ? !positive : positive;
  const text = `${positive ? "+" : ""}${delta}${suffix}`;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 999,
        backgroundColor: colors.surface2,
        borderWidth: 1,
        borderColor: isGood ? colors.statusSuccess : colors.statusWarning,
      }}
    >
      <Text
        style={{
          fontSize: 10.5,
          fontWeight: "600",
          color: isGood ? colors.statusSuccess : colors.statusWarning,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

export function InsightsPane({
  hostId,
  compact,
  resolvedInsightModel,
  theme,
}: {
  hostId: string;
  compact: boolean;
  resolvedInsightModel?: string;
  theme: PluginTheme;
}) {
  const { colors } = theme;
  const { locale, isZh, t } = useRadarI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const loadInsights = useRpc(loadRadarInsightsRpc);
  const generateInsights = useRpc(generateRadarInsightsRpc);
  const exportHtml = useRpc(exportRadarInsightHtmlRpc);
  const deleteReport = useRpc(deleteRadarInsightReportRpc);
  const logInteraction = useRpc(logRadarInteractionRpc);

  const [windowChoice, setWindowChoice] = useState<InsightWindow>("30d");
  const [focusText, setFocusText] = useState("");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [localGenerating, setLocalGenerating] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<InsightDailyPoint | null>(null);

  const query = useQuery({
    queryKey: radarInsightsQueryKey(hostId, selectedReportId),
    queryFn: () => loadInsights(selectedReportId ? { reportId: selectedReportId } : {}),
    refetchInterval: (q) => (q.state.data?.status.generating || localGenerating ? 1500 : 12_000),
  });

  useEffect(() => {
    setSelectedReportId(null);
    setSelectedDay(null);
  }, [hostId]);

  const status = query.data?.status;
  const reports = query.data?.reports ?? [];
  const report: RadarInsightReport | null = query.data?.activeReport ?? null;
  const isGenerating = localGenerating || status?.generating === true;

  useEffect(() => {
    setSelectedDay(null);
  }, [report?.id]);

  function windowLabel(w: InsightWindow): string {
    switch (w) {
      case "7d":
        return t("insights.win7d");
      case "14d":
        return t("insights.win14d");
      case "30d":
        return t("insights.win30d");
      case "all":
        return t("insights.winAll");
    }
  }

  function categoryLabel(cat: InsightRecommendationCategory): string {
    switch (cat) {
      case "agents_md":
        return t("insights.catAgentsMd");
      case "radar_config":
        return t("insights.catRadarConfig");
      case "workflow":
        return t("insights.catWorkflow");
    }
  }

  function handleGenerate(): void {
    if (isGenerating) return;
    setLocalGenerating(true);
    const earlyTimer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["paseo-radar", "insights", hostId] });
    }, 350);

    generateInsights({
      window: windowChoice,
      ...(focusText.trim() ? { customFocus: focusText.trim() } : {}),
      locale,
      forceRefreshCache: false,
    })
      .then((res) => {
        setSelectedReportId(res.report.id);
        queryClient.setQueryData(radarInsightsQueryKey(hostId, res.report.id), {
          status: {
            generating: false,
            stage: null,
            progressText: null,
            startedAt: null,
            window: null,
            lastError: null,
          },
          reports: res.reports,
          activeReport: res.report,
        });
        void queryClient.invalidateQueries({ queryKey: ["paseo-radar", "insights", hostId] });
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        clearTimeout(earlyTimer);
        setLocalGenerating(false);
      });
  }

  function handleCopyMarkdown(): void {
    if (!report) return;
    copyText(report.markdown)
      .then(() => toast.show(t("insights.copiedMdToast"), { variant: "success" }))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  }

  function handleExportHtml(): void {
    if (!report || exportingHtml) return;
    setExportingHtml(true);
    exportHtml({ reportId: report.id })
      .then(async (res) => {
        const displayPath = shortenHomePath(res.htmlPath);
        await copyText(res.htmlPath).catch(() => {});

        // In standard web browsers (non-Electron), also trigger a direct .html download
        if (Platform.OS === "web" && typeof globalThis !== "undefined") {
          const g = globalThis as {
            navigator?: { userAgent?: string };
            document?: {
              createElement?: (tag: string) => {
                href: string;
                download: string;
                click: () => void;
              };
            };
            Blob?: new (parts: string[], opts?: { type?: string }) => unknown;
            URL?: { createObjectURL?: (b: unknown) => string; revokeObjectURL?: (u: string) => void };
          };
          const isElectron = Boolean(g.navigator?.userAgent?.includes("Electron"));
          if (!isElectron && g.Blob && g.URL?.createObjectURL && g.document?.createElement) {
            try {
              const blob = new g.Blob([res.htmlContent], { type: "text/html;charset=utf-8" });
              const blobUrl = g.URL.createObjectURL(blob);
              const a = g.document.createElement("a");
              a.href = blobUrl;
              a.download = `radar-insights-${report.window}-${report.createdAt.slice(0, 10)}.html`;
              a.click();
              setTimeout(() => g.URL?.revokeObjectURL?.(blobUrl), 2000);
            } catch {
              // Clipboard path already copied
            }
          }
        }

        toast.show(t("insights.exportedHtmlToast", { path: displayPath }), { variant: "success" });
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setExportingHtml(false));
  }

  function handleDeleteReport(id: string): void {
    if (deletingId) return;
    setDeletingId(id);
    deleteReport({ reportId: id })
      .then((res) => {
        const nextId = res.activeReport?.id ?? null;
        setSelectedReportId(nextId);
        void queryClient.invalidateQueries({ queryKey: ["paseo-radar", "insights", hostId] });
        toast.show(t("insights.deleteReportToast"), { variant: "success" });
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setDeletingId(null));
  }

  function handleCopySnippet(snippet: string): void {
    copyText(snippet)
      .then(() => {
        void logInteraction({ kind: "ui.copy_suggestion", detail: { chars: snippet.length } }).catch(() => {});
        toast.show(t("insights.copiedSnippetToast"), { variant: "success" });
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  }

  const maxDailyPrompts = useMemo(() => {
    if (!report) return 1;
    return Math.max(1, ...report.metrics.dailyActivity.map((d) => d.userMessages));
  }, [report]);

  const maxModelSessions = useMemo(() => {
    if (!report || report.metrics.models.length === 0) return 1;
    return Math.max(1, ...report.metrics.models.map((m) => m.sessions));
  }, [report]);

  const windows: readonly InsightWindow[] = ["7d", "14d", "30d", "all"];

  return (
    <View style={{ gap: 16 }}>
      {/* Top Controls Card */}
      <View
        style={{
          padding: 14,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface1,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 220, gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon name="Sparkles" size={16} color={colors.accent} />
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
                {t("insights.title")}
              </Text>
              {resolvedInsightModel ? (
                <View
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 6,
                    backgroundColor: colors.surface2,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {shortModelName(resolvedInsightModel)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
              {t("insights.subtitle")}
            </Text>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {report ? (
              <>
                <PillButton
                  icon="Copy"
                  label={t("insights.copyMdBtn")}
                  theme={theme}
                  onPress={handleCopyMarkdown}
                />
                <PillButton
                  icon="FileCode"
                  label={t("insights.exportHtmlBtn")}
                  disabled={exportingHtml}
                  theme={theme}
                  onPress={handleExportHtml}
                />
              </>
            ) : null}
            <PillButton
              icon="Sparkles"
              label={
                isGenerating
                  ? t("insights.generatingBtn")
                  : report
                    ? t("insights.regenerateBtn")
                    : t("insights.generateBtn")
              }
              tone="primary"
              disabled={isGenerating}
              theme={theme}
              onPress={handleGenerate}
            />
          </View>
        </View>

        {/* Window Selector + Custom Focus Input */}
        <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {windows.map((w) => {
              const active = windowChoice === w;
              return (
                <Pressable
                  key={w}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  disabled={isGenerating}
                  onPress={() => setWindowChoice(w)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 7,
                    borderWidth: 1,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.surface2 : colors.surface0,
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.foreground : colors.foregroundMuted,
                      fontSize: 12,
                      fontWeight: active ? "600" : "400",
                    }}
                  >
                    {windowLabel(w)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            value={focusText}
            onChangeText={setFocusText}
            editable={!isGenerating}
            placeholder={t("insights.focusPlaceholder")}
            placeholderTextColor={colors.foregroundMuted}
            onSubmitEditing={handleGenerate}
            style={{
              flex: 1,
              minHeight: 32,
              color: colors.foreground,
              fontSize: 12.5,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface0,
              ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
            }}
          />
        </View>

        {/* Live Progress Banner */}
        {isGenerating ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.accent,
              backgroundColor: colors.surface0,
            }}
          >
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={{ flex: 1, color: colors.foreground, fontSize: 12.5 }}>
              {status?.progressText ||
                (isZh
                  ? "正在扫描会话历史并提炼协作洞察（约需 15~45 秒）…"
                  : "Analyzing sessions and synthesizing insights (15–45s)…")}
            </Text>
          </View>
        ) : status?.lastError ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.statusDanger,
              backgroundColor: colors.surface0,
            }}
          >
            <Icon name="AlertTriangle" size={14} color={colors.statusDanger} />
            <Text style={{ flex: 1, color: colors.statusDanger, fontSize: 12 }}>
              {status.lastError}
            </Text>
          </View>
        ) : null}

        {/* Saved Report History Bar */}
        {reports.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5, fontWeight: "600" }}>
              {t("insights.historyLabel")}:
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              {reports.map((r) => {
                const isSelected = report?.id === r.id;
                return (
                  <View
                    key={r.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      borderRadius: 7,
                      borderWidth: 1,
                      borderColor: isSelected ? colors.accent : colors.border,
                      backgroundColor: isSelected ? colors.surface2 : colors.surface0,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setSelectedReportId(r.id)}
                      style={{
                        paddingHorizontal: 9,
                        paddingVertical: 4,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <Text
                        style={{
                          color: isSelected ? colors.foreground : colors.foregroundMuted,
                          fontSize: 11.5,
                          fontWeight: isSelected ? "600" : "400",
                        }}
                      >
                        {`${formatShortTimestamp(r.createdAt)} · ${windowLabel(r.window)} (${r.totalSessions})`}
                      </Text>
                    </Pressable>
                    {isSelected ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={deletingId === r.id}
                        onPress={() => handleDeleteReport(r.id)}
                        style={{ paddingRight: 7, paddingLeft: 2, paddingVertical: 4 }}
                      >
                        <Icon name="Trash2" size={12} color={colors.foregroundMuted} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>

      {/* Empty State */}
      {!report ? (
        <View
          style={{
            paddingVertical: 48,
            paddingHorizontal: 24,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            alignItems: "center",
            gap: 12,
          }}
        >
          <Icon name="BarChart3" size={32} color={colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700", textAlign: "center" }}>
            {t("insights.emptyTitle")}
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 13,
              lineHeight: 20,
              textAlign: "center",
              maxWidth: 560,
            }}
          >
            {t("insights.emptyDesc")}
          </Text>
          <View style={{ marginTop: 4 }}>
            <PillButton
              icon="Sparkles"
              label={isGenerating ? t("insights.generatingBtn") : t("insights.generateBtn")}
              tone="primary"
              disabled={isGenerating}
              theme={theme}
              onPress={handleGenerate}
            />
          </View>
        </View>
      ) : (
        <View style={{ gap: 16 }}>
          {/* 1. Executive Narrative & Archetype Banner */}
          <View
            style={{
              padding: 18,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <View
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 3,
                  borderRadius: 999,
                  backgroundColor: colors.surface2,
                  borderWidth: 1,
                  borderColor: colors.accent,
                }}
              >
                <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700" }}>
                  {report.narrative.interactionStyle.archetype}
                </Text>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {`${windowLabel(report.window)} · ${report.periodStart.slice(0, 10)} ~ ${report.periodEnd.slice(0, 10)}`}
              </Text>
              {report.modelUsed ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                  {`· ${shortModelName(report.modelUsed)}`}
                </Text>
              ) : null}
              {report.customFocus ? (
                <Text style={{ color: colors.accent, fontSize: 12 }} numberOfLines={1}>
                  {`· ${isZh ? "聚焦" : "Focus"}: ${report.customFocus}`}
                </Text>
              ) : null}
            </View>

            <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "700", lineHeight: 25 }}>
              {report.narrative.headline}
            </Text>
            <Text style={{ color: colors.foreground, fontSize: 13.5, lineHeight: 21 }}>
              {report.narrative.executiveSummary}
            </Text>

            {report.narrative.interactionStyle.traits.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                {report.narrative.interactionStyle.traits.map((tr, i) => (
                  <View
                    key={`${tr}-${i}`}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 6,
                      backgroundColor: colors.surface2,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ color: colors.foreground, fontSize: 11.5 }}>{tr}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <View
              style={{
                marginTop: 2,
                paddingTop: 10,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                gap: 4,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 11.5, fontWeight: "600" }}>
                {t("insights.secStyle")}
              </Text>
              <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}>
                {report.narrative.interactionStyle.analysis}
              </Text>
            </View>
          </View>

          {/* 2. At-a-Glance Metrics Grid */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            {[
              {
                label: t("insights.statSessions"),
                value: String(report.metrics.totalSessions),
                delta: report.deltas?.sessionsDelta,
                deltaSuffix: "",
                sub: t("insights.statSessionsSub", {
                  days: report.metrics.activeDays,
                  linked: report.metrics.radarLinkedSessions,
                }),
              },
              {
                label: t("insights.statPrompts"),
                value: formatCompactNumber(report.metrics.totalUserMessages),
                delta: report.deltas?.userMessagesDelta,
                deltaSuffix: "",
                sub: t("insights.statPromptsSub", {
                  avg: report.metrics.avgUserMessagesPerSession,
                  steer: report.metrics.multiTurnSteerSessions,
                }),
              },
              {
                label: t("insights.statTools"),
                value: `${report.metrics.toolSuccessRate}%`,
                delta: report.deltas?.toolSuccessRateDelta,
                deltaSuffix: "%",
                sub: t("insights.statToolsSub", {
                  total: formatCompactNumber(report.metrics.totalToolCalls),
                  failed: report.metrics.failedToolCalls,
                }),
              },
              {
                label: t("insights.statClosures"),
                value: String(report.metrics.radarExecution.cardsArchived),
                delta: report.deltas?.cardsArchivedDelta,
                deltaSuffix: "",
                sub: t("insights.statClosuresSub", {
                  ready: report.metrics.radarExecution.cardsReadyToArchive,
                  decision: report.metrics.radarExecution.cardsDecision,
                }),
              },
              {
                label: t("insights.statGoals"),
                value: `${report.metrics.radarExecution.goalsAchieved}/${report.metrics.radarExecution.goalsTotal}`,
                delta: null,
                deltaSuffix: "",
                sub: t("insights.statGoalsSub", {
                  achieved: report.metrics.radarExecution.goalsAchieved,
                  total: report.metrics.radarExecution.goalsTotal,
                  avg: report.metrics.radarExecution.avgGoalTurns,
                }),
              },
              {
                label: t("insights.statPromptClarity"),
                value: `${report.metrics.avgFirstPromptChars}`,
                delta: null,
                deltaSuffix: "",
                sub: t("insights.statPromptClaritySub", {
                  short: report.metrics.shortPromptRatio,
                }),
              },
            ].map((card) => (
              <View
                key={card.label}
                style={{
                  flexGrow: 1,
                  flexBasis: compact ? "46%" : 155,
                  padding: 13,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
                    {card.label}
                  </Text>
                  <DeltaPill delta={card.delta} suffix={card.deltaSuffix} theme={theme} />
                </View>
                <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "700" }}>
                  {card.value}
                </Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }} numberOfLines={1}>
                  {card.sub}
                </Text>
              </View>
            ))}
          </View>

          {/* Token & Cost Footprint Note (when available) */}
          {report.metrics.totalInputTokens > 0 || report.metrics.totalOutputTokens > 0 ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Icon name="Cpu" size={14} color={colors.foregroundMuted} />
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {isZh
                  ? `已统计会话 Token 用量：输入 ${formatCompactNumber(report.metrics.totalInputTokens)} · 缓存命中 ${formatCompactNumber(report.metrics.totalCachedTokens)} · 输出 ${formatCompactNumber(report.metrics.totalOutputTokens)}${
                      report.metrics.estimatedCostUsd > 0
                        ? ` · 估算开销 $${report.metrics.estimatedCostUsd.toFixed(2)}`
                        : ""
                    }`
                  : `Recorded Token Footprint: In ${formatCompactNumber(report.metrics.totalInputTokens)} · Cached ${formatCompactNumber(report.metrics.totalCachedTokens)} · Out ${formatCompactNumber(report.metrics.totalOutputTokens)}${
                      report.metrics.estimatedCostUsd > 0
                        ? ` · Est. $${report.metrics.estimatedCostUsd.toFixed(2)}`
                        : ""
                    }`}
              </Text>
            </View>
          ) : null}

          {/* 3. Daily Activity Bar Chart & Radar Workflow Funnel */}
          <View style={{ flexDirection: compact ? "column" : "row", gap: 12 }}>
            {/* Daily Bar Chart */}
            <View
              style={{
                flex: 1,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                  {t("insights.secActivity")}
                </Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                  {selectedDay
                    ? isZh
                      ? `${selectedDay.date}：${selectedDay.sessions} 场 · ${selectedDay.userMessages} 条指令 · ${selectedDay.toolCalls} 次工具`
                      : `${selectedDay.date}: ${selectedDay.sessions} sess · ${selectedDay.userMessages} prompts · ${selectedDay.toolCalls} tools`
                    : isZh
                      ? "点击柱条查看单日明细"
                      : "Tap bar for daily detail"}
                </Text>
              </View>

              <View style={{ height: 116, flexDirection: "row", alignItems: "flex-end", gap: 4, paddingTop: 6 }}>
                {report.metrics.dailyActivity.map((pt) => {
                  const pct =
                    pt.userMessages > 0
                      ? Math.max(10, Math.round((pt.userMessages / maxDailyPrompts) * 100))
                      : pt.sessions > 0
                        ? 8
                        : 3;
                  const isSel = selectedDay?.date === pt.date;
                  return (
                    <Pressable
                      key={pt.date}
                      accessibilityRole="button"
                      onPress={() => setSelectedDay(isSel ? null : pt)}
                      style={{ flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" }}
                    >
                      <View
                        style={{
                          width: "100%",
                          maxWidth: 22,
                          height: `${pct}%`,
                          borderRadius: 4,
                          backgroundColor: isSel
                            ? colors.statusSuccess
                            : pt.userMessages > 0 || pt.sessions > 0
                              ? colors.accent
                              : colors.surface2,
                        }}
                      />
                    </Pressable>
                  );
                })}
              </View>

              {report.metrics.dailyActivity.length > 0 ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {report.metrics.dailyActivity[0]!.date.slice(5)}
                  </Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {report.metrics.dailyActivity[Math.floor(report.metrics.dailyActivity.length / 2)]!.date.slice(5)}
                  </Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {report.metrics.dailyActivity[report.metrics.dailyActivity.length - 1]!.date.slice(5)}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Radar Workflow & Closure Funnel */}
            <View
              style={{
                flex: 1,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 10,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                {t("insights.secRadarFunnel")}
              </Text>

              {(() => {
                const rx = report.metrics.radarExecution;
                const funnelItems = [
                  { label: isZh ? "已归档闭环" : "Archived", count: rx.cardsArchived, color: colors.statusSuccess },
                  { label: isZh ? "可完结待归档" : "Ready", count: rx.cardsReadyToArchive, color: colors.accent },
                  { label: isZh ? "待确认授权" : "Decision", count: rx.cardsDecision, color: colors.statusWarning },
                  { label: isZh ? "待补充信息" : "Input", count: rx.cardsInput, color: colors.statusDanger },
                  { label: isZh ? "待查阅同步" : "Review", count: rx.cardsReview, color: colors.foregroundMuted },
                  {
                    label: isZh
                      ? `等待外部 (${rx.scriptWaits}脚本/${rx.aiWaits}AI)`
                      : `Waiting (${rx.scriptWaits}s/${rx.aiWaits}ai)`,
                    count: rx.cardsWaitingExternal,
                    color: colors.accent,
                  },
                ];
                const sum = Math.max(1, funnelItems.reduce((acc, x) => acc + x.count, 0));

                return (
                  <View style={{ gap: 10 }}>
                    <View
                      style={{
                        height: 10,
                        borderRadius: 999,
                        overflow: "hidden",
                        flexDirection: "row",
                        backgroundColor: colors.surface2,
                      }}
                    >
                      {funnelItems
                        .filter((f) => f.count > 0)
                        .map((f) => (
                          <View
                            key={f.label}
                            style={{
                              flex: f.count / sum,
                              backgroundColor: f.color,
                            }}
                          />
                        ))}
                    </View>

                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {funnelItems.map((f) => (
                        <View
                          key={f.label}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 5,
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 6,
                            backgroundColor: colors.surface0,
                            borderWidth: 1,
                            borderColor: colors.border,
                          }}
                        >
                          <View
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: 3.5,
                              backgroundColor: f.color,
                            }}
                          />
                          <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                            {f.label}
                          </Text>
                          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700" }}>
                            {f.count}
                          </Text>
                        </View>
                      ))}
                    </View>

                    {/* Real-time Telemetry Signals */}
                    {rx.telemetry.gateRejections > 0 ||
                    rx.telemetry.decisionsApproved + rx.telemetry.decisionsEdited > 0 ||
                    rx.telemetry.permissionsAllowed + rx.telemetry.permissionsDenied > 0 ||
                    rx.telemetry.turnsFailed > 0 ? (
                      <View
                        style={{
                          paddingTop: 8,
                          borderTopWidth: 1,
                          borderTopColor: colors.border,
                          flexDirection: "row",
                          flexWrap: "wrap",
                          gap: 10,
                        }}
                      >
                        {rx.telemetry.gateRejections > 0 ? (
                          <Text style={{ color: colors.statusWarning, fontSize: 11.5 }}>
                            {isZh
                              ? `闭环门禁拦截：${rx.telemetry.gateRejections} 次（漏提交/未实测）`
                              : `Closure gate blocks: ${rx.telemetry.gateRejections}`}
                          </Text>
                        ) : null}
                        {rx.telemetry.decisionsApproved + rx.telemetry.decisionsEdited > 0 ? (
                          <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                            {isZh
                              ? `外发草稿：直接确认 ${rx.telemetry.decisionsApproved} / 修改后确认 ${rx.telemetry.decisionsEdited}`
                              : `Drafts: ${rx.telemetry.decisionsApproved} approved / ${rx.telemetry.decisionsEdited} edited`}
                          </Text>
                        ) : null}
                        {rx.telemetry.permissionsAllowed + rx.telemetry.permissionsDenied > 0 ? (
                          <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                            {isZh
                              ? `权限审批：放行 ${rx.telemetry.permissionsAllowed} / 拒绝 ${rx.telemetry.permissionsDenied}`
                              : `Permissions: ${rx.telemetry.permissionsAllowed} allowed / ${rx.telemetry.permissionsDenied} denied`}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })()}
            </View>
          </View>

          {/* 4. Wins & Frictions Side-by-Side */}
          <View style={{ flexDirection: compact ? "column" : "row", gap: 12 }}>
            {/* Success Patterns */}
            <View
              style={{
                flex: 1,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <Icon name="CheckCircle2" size={16} color={colors.statusSuccess} />
                <Text style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "700" }}>
                  {t("insights.secWins")}
                </Text>
              </View>

              {report.narrative.wins.map((w, idx) => (
                <View
                  key={`${w.title}-${idx}`}
                  style={{
                    padding: 12,
                    borderRadius: 9,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderLeftWidth: 3,
                    borderLeftColor: colors.statusSuccess,
                    backgroundColor: colors.surface0,
                    gap: 5,
                  }}
                >
                  <Text style={{ color: colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
                    {w.title}
                  </Text>
                  <Text style={{ color: colors.foreground, fontSize: 12.5, lineHeight: 19 }}>
                    {w.detail}
                  </Text>
                  {w.evidence ? (
                    <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                      {w.evidence}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>

            {/* Friction Points */}
            <View
              style={{
                flex: 1,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <Icon name="AlertTriangle" size={16} color={colors.statusWarning} />
                <Text style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "700" }}>
                  {t("insights.secFrictions")}
                </Text>
              </View>

              {report.narrative.frictions.length === 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12.5 }}>
                  {isZh ? "当前窗口未检测到显著重复报错或协作卡点。" : "No major recurring friction detected in this window."}
                </Text>
              ) : (
                report.narrative.frictions.map((f, idx) => {
                  const sevColor =
                    f.severity === "high"
                      ? colors.statusDanger
                      : f.severity === "low"
                        ? colors.accent
                        : colors.statusWarning;
                  const sevLabel =
                    f.severity === "high"
                      ? t("insights.sevHigh")
                      : f.severity === "low"
                        ? t("insights.sevLow")
                        : t("insights.sevMed");
                  return (
                    <View
                      key={`${f.title}-${idx}`}
                      style={{
                        padding: 12,
                        borderRadius: 9,
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderLeftWidth: 3,
                        borderLeftColor: sevColor,
                        backgroundColor: colors.surface0,
                        gap: 5,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                        <View
                          style={{
                            paddingHorizontal: 6,
                            paddingVertical: 1,
                            borderRadius: 5,
                            borderWidth: 1,
                            borderColor: sevColor,
                            backgroundColor: colors.surface1,
                          }}
                        >
                          <Text style={{ color: sevColor, fontSize: 10.5, fontWeight: "700" }}>
                            {sevLabel}
                          </Text>
                        </View>
                        <Text style={{ flex: 1, color: colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
                          {f.title}
                        </Text>
                      </View>
                      <Text style={{ color: colors.foreground, fontSize: 12.5, lineHeight: 19 }}>
                        {f.detail}
                      </Text>
                      {f.evidence ? (
                        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                          {f.evidence}
                        </Text>
                      ) : null}
                    </View>
                  );
                })
              )}
            </View>
          </View>

          {/* 5. Actionable Recommendations (with Copyable Snippets) */}
          {report.narrative.recommendations.length > 0 ? (
            <View
              style={{
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 12,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <Icon name="Zap" size={16} color={colors.accent} />
                <Text style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "700" }}>
                  {t("insights.secRecs")}
                </Text>
              </View>

              {report.narrative.recommendations.map((rec, idx) => (
                <View
                  key={`${rec.title}-${idx}`}
                  style={{
                    padding: 13,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surface0,
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                      <View
                        style={{
                          paddingHorizontal: 7,
                          paddingVertical: 2,
                          borderRadius: 5,
                          backgroundColor: colors.surface2,
                          borderWidth: 1,
                          borderColor: colors.accent,
                        }}
                      >
                        <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "600" }}>
                          {categoryLabel(rec.category)}
                        </Text>
                      </View>
                      <Text style={{ flex: 1, color: colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
                        {rec.title}
                      </Text>
                    </View>

                    {rec.snippet ? (
                      <PillButton
                        icon="Copy"
                        label={t("insights.copySnippetBtn")}
                        tone="subtle"
                        theme={theme}
                        onPress={() => handleCopySnippet(rec.snippet!)}
                      />
                    ) : null}
                  </View>

                  <Text style={{ color: colors.foreground, fontSize: 12.5, lineHeight: 19 }}>
                    {rec.rationale}
                  </Text>

                  {rec.snippet ? (
                    <View
                      style={{
                        padding: 10,
                        borderRadius: 7,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface1,
                      }}
                    >
                      <Text
                        selectable
                        style={{
                          color: colors.foreground,
                          fontSize: 12,
                          lineHeight: 18,
                          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                        }}
                      >
                        {rec.snippet}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {/* 6. Model Performance Leaderboard */}
          {report.metrics.models.length > 0 ? (
            <View
              style={{
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 10,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "700" }}>
                {t("insights.secModels")}
              </Text>

              {report.metrics.models.slice(0, 10).map((mod) => {
                const okRate =
                  mod.toolCalls > 0
                    ? Math.round(((mod.toolCalls - mod.failedToolCalls) / mod.toolCalls) * 100)
                    : 100;
                const barPct = Math.max(6, Math.round((mod.sessions / maxModelSessions) * 100));
                return (
                  <View
                    key={mod.model}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.surface0,
                      gap: 6,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
                          {shortModelName(mod.model)}
                        </Text>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                          ({mod.provider})
                        </Text>
                      </View>

                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
                          {isZh ? `${mod.sessions} 场会话` : `${mod.sessions} sess`}
                        </Text>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                          {isZh ? `${mod.userMessages} 指令` : `${mod.userMessages} prompts`}
                        </Text>
                        <Text
                          style={{
                            color: okRate < 90 ? colors.statusWarning : colors.foregroundMuted,
                            fontSize: 12,
                          }}
                        >
                          {mod.toolCalls > 0
                            ? isZh
                              ? `工具 ${mod.toolCalls} (${okRate}% 成功)`
                              : `${mod.toolCalls} tools (${okRate}% ok)`
                            : isZh
                              ? "0 工具"
                              : "0 tools"}
                        </Text>
                        {mod.readyToArchiveCount > 0 ? (
                          <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>
                            {isZh ? `闭环 ${mod.readyToArchiveCount}` : `${mod.readyToArchiveCount} closed`}
                          </Text>
                        ) : null}
                        {mod.errorTurns > 0 ? (
                          <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
                            {isZh ? `异常 ${mod.errorTurns}` : `${mod.errorTurns} err`}
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    <View
                      style={{
                        height: 5,
                        borderRadius: 999,
                        backgroundColor: colors.surface2,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          width: `${barPct}%`,
                          height: "100%",
                          borderRadius: 999,
                          backgroundColor: colors.accent,
                        }}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* 7. Top Projects & Top Tools */}
          <View style={{ flexDirection: compact ? "column" : "row", gap: 12 }}>
            <View
              style={{
                flex: 1,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 8,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                {t("insights.secProjects")}
              </Text>
              {report.metrics.projects.slice(0, 8).map((p) => (
                <View
                  key={p.name}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingVertical: 6,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                    gap: 8,
                  }}
                >
                  <Text style={{ flex: 1, color: colors.foreground, fontSize: 12.5, fontWeight: "600" }} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                    {isZh
                      ? `${p.sessions} 场 · ${p.userMessages} 指令 · 闭环 ${p.archivedCards}`
                      : `${p.sessions} sess · ${p.userMessages} prompts · ${p.archivedCards} closed`}
                  </Text>
                </View>
              ))}
            </View>

            <View
              style={{
                flex: 1,
                padding: 16,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                gap: 8,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                {t("insights.secTools")}
              </Text>
              {report.metrics.topTools.slice(0, 8).map((tool) => (
                <View
                  key={tool.name}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingVertical: 6,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                    gap: 8,
                  }}
                >
                  <Text
                    style={{
                      flex: 1,
                      color: colors.foreground,
                      fontSize: 12,
                      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                    }}
                    numberOfLines={1}
                  >
                    {tool.name}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                      {isZh ? `${tool.calls} 次` : `${tool.calls} calls`}
                    </Text>
                    {tool.failures > 0 ? (
                      <Text style={{ color: colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
                        {isZh ? `失败 ${tool.failures}` : `${tool.failures} err`}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
