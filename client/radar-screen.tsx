import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useHosts, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  type TextInput as NativeTextInput,
  View,
} from "react-native";

import {
  archiveBatchRadarCardsRpc,
  archiveRadarCardRpc,
  checkProviderHealthRpc,
  dismissModelAlertsRpc,
  dismissScanErrorsRpc,
  followBatchRadarItemsRpc,
  loadRadarRpc,
  logRadarInteractionRpc,
  resetCopilotRpc,
  retryModelAlertRpc,
  retryScanErrorRpc,
  scanRadarRpc,
  testRadarCollectorRpc,
  toggleRadarCollectorRpc,
  type NeedsMeTag,
  type RadarCollectorStatus,
  type RadarItem,
} from "../shared/radar";
import { filterRadarItems } from "../shared/radar-search";
import { CopilotPane } from "./copilot-pane";
import { CoordBoardScreen } from "./coord-board-screen";
import { useRadarI18n, needsMeTagMetaForLocale } from "./i18n";
import { InsightsPane } from "./insights-pane";
import { PillButton, RadarCardView, relativeTimeLabel, shortModelName } from "./radar-card";
import { getCachedRadarSnapshot, openRadarSettings, setCachedRadarSnapshot } from "./radar-store";

export const RADAR_QUERY_KEY = ["paseo-radar", "snapshot"] as const;

export function radarHostQueryKey(hostId?: string) {
  return hostId ? (["paseo-radar", "snapshot", hostId] as const) : RADAR_QUERY_KEY;
}

interface PersistedRadarViewState {
  tab: ViewTab;
  needsMeFilter: "all" | NeedsMeTag;
  copilotOpen: boolean;
}

const cachedViewStateByHost = new Map<string, PersistedRadarViewState>();

const VIEW_TAB_SET: ReadonlySet<string> = new Set<ViewTab>([
  "pool",
  "needs_me",
  "running",
  "waiting_external",
  "board",
  "archived",
  "hidden",
  "insights",
]);

const NEEDS_ME_FILTER_SET: ReadonlySet<string> = new Set<"all" | NeedsMeTag>([
  "all",
  "ready_to_archive",
  "decision",
  "input",
  "review",
]);

function isValidViewTab(val: string | undefined): val is ViewTab {
  return typeof val === "string" && VIEW_TAB_SET.has(val);
}

function isValidNeedsMeFilter(val: string | undefined): val is "all" | NeedsMeTag {
  return typeof val === "string" && NEEDS_ME_FILTER_SET.has(val);
}

export function shortenHomePath(raw: string): string {
  return raw.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}

function formatCollectorDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

export function CollectorStatusRow({
  collector,
  theme,
  onChanged,
}: {
  collector: RadarCollectorStatus;
  theme: PluginTheme;
  onChanged?: () => void;
}) {
  const { colors } = theme;
  const { isZh, t } = useRadarI18n();
  const toggleCollector = useRpc(toggleRadarCollectorRpc);
  const checkHealth = useRpc(checkProviderHealthRpc);
  const testCollector = useRpc(testRadarCollectorRpc);
  const retryScanError = useRpc(retryScanErrorRpc);
  const dismissScanErrors = useRpc(dismissScanErrorsRpc);
  const toast = useToast();
  const [toggling, setToggling] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [testing, setTesting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const hasError = Boolean(collector.error);
  const hasWarn = !hasError && collector.warnings.length > 0;

  let dotColor = colors.foregroundMuted;
  if (!collector.enabled) dotColor = colors.foregroundMuted;
  else if (hasError) dotColor = colors.statusDanger;
  else if (hasWarn) dotColor = colors.statusWarning;
  else if (collector.lastRunAt) dotColor = colors.statusSuccess;

  let badgeLabel: string | null = null;
  let badgeColor: string = colors.foregroundMuted;
  if (collector.running) {
    badgeLabel = isZh ? "运行中" : "Running";
    badgeColor = colors.accent;
  } else if (!collector.enabled) {
    badgeLabel =
      collector.disabledReason === "config"
        ? isZh
          ? "配置已关"
          : "Disabled"
        : isZh
          ? "已停用"
          : "Skipped";
    badgeColor = colors.foregroundMuted;
  } else if (hasError) {
    badgeLabel = isZh ? "失败" : "Failed";
    badgeColor = colors.statusDanger;
  } else if (hasWarn) {
    badgeLabel = isZh ? "告警" : "Warning";
    badgeColor = colors.statusWarning;
  }

  const hasNormalStats =
    !collector.running && collector.enabled && !hasError && Boolean(collector.lastRunAt);
  const protocolBadge = collector.protocol === "legacy" ? "Legacy"
    : collector.lifecycle === "daemon" ? "Daemon"
    : collector.protocol === "jsonrpc" ? "RPC" : null;
  const delta = collector.deltaCount;
  const dur = formatCollectorDuration(collector.durationMs);

  let fallbackRightMeta = isZh ? "待运行" : "Pending";
  if (collector.running) {
    fallbackRightMeta = collector.lastRunAt
      ? isZh
        ? `正在执行 · 上次 ${collector.itemCount ?? 0} 条`
        : `Running · prev ${collector.itemCount ?? 0}`
      : isZh
        ? "正在执行…"
        : "Running…";
  } else if (!collector.enabled) {
    fallbackRightMeta = isZh ? "跳过执行" : "Inactive";
  } else if (hasError) {
    fallbackRightMeta = relativeTimeLabel(collector.lastRunAt, isZh);
  }

  function handleToggle(): void {
    if (toggling) return;
    setToggling(true);
    const nextEnabled = !collector.enabled;
    toggleCollector({ filename: collector.filename, enabled: nextEnabled })
      .then((res) => {
        toast.show(
          isZh
            ? `${res.filename} 已${res.enabled ? "启用" : "停用"}`
            : `${res.filename} ${res.enabled ? "enabled" : "disabled"}`,
          { variant: "success" },
        );
        onChanged?.();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setToggling(false));
  }

  async function handleCheckHealth(): Promise<void> {
    if (checkingHealth || !collector.capabilities?.health) return;
    setCheckingHealth(true);
    try {
      const res = await checkHealth({ filename: collector.filename });
      const summary = t(res.ok ? "settings.healthPassed" : "settings.healthFailed", {
        name: res.filename,
        duration: formatCollectorDuration(res.durationMs),
      });
      const detail = [summary, res.identity, res.message].filter(Boolean).join(" · ");
      if (res.ok) toast.show(detail, { variant: "success" });
      else toast.error(detail);
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingHealth(false);
    }
  }

  function handleTest(): void {
    if (testing || retrying) return;
    setTesting(true);
    testCollector({ filename: collector.filename })
      .then((res) => {
        if (res.ok) {
          toast.show(
            isZh
              ? `${res.filename} 校验通过：${res.itemCount} 条（${formatCollectorDuration(res.durationMs)}）`
              : `${res.filename} OK: ${res.itemCount} items (${formatCollectorDuration(res.durationMs)})`,
            { variant: "success" },
          );
        } else {
          toast.error(`${res.filename}: ${res.error || "failed"}`);
        }
        onChanged?.();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setTesting(false));
  }

  function handleRetry(): void {
    if (retrying || testing) return;
    setRetrying(true);
    retryScanError({ filename: collector.filename })
      .then((res) => {
        if (res.ok) {
          toast.show(
            isZh ? `${collector.filename} 重试成功` : `${collector.filename} retry succeeded`,
            { variant: "success" },
          );
        } else {
          toast.error(`${collector.filename}: ${res.message || collector.error || "failed"}`);
        }
        onChanged?.();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setRetrying(false));
  }

  function handleDismissError(): void {
    if (dismissing) return;
    setDismissing(true);
    dismissScanErrors({ filename: collector.filename })
      .then(() => {
        onChanged?.();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setDismissing(false));
  }

  return (
    <View
      style={{
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: hasError && collector.enabled ? colors.statusDanger : colors.border,
        backgroundColor: colors.surface0,
        opacity: collector.enabled ? 1 : 0.75,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {collector.running ? (
          <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : (
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              marginHorizontal: 3,
              backgroundColor: dotColor,
            }}
          />
        )}

        <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }} selectable>
          {collector.displayName || collector.filename}
        </Text>
        {protocolBadge ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, backgroundColor: colors.surface2, paddingHorizontal: 5, borderRadius: 4 }}>
            {protocolBadge}
          </Text>
        ) : null}

        {badgeLabel ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: badgeColor,
            }}
          >
            <Text style={{ color: badgeColor, fontSize: 10.5, fontWeight: "600" }}>{badgeLabel}</Text>
          </View>
        ) : null}

        {collector.description ? (
          <Text
            style={{ flex: 1, minWidth: 120, color: colors.foregroundMuted, fontSize: 12 }}
            numberOfLines={1}
          >
            {collector.description}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        {hasNormalStats ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
            {isZh ? `${collector.itemCount ?? 0} 条` : `${collector.itemCount ?? 0} items`}
            {delta !== null ? (
              <>
                {" · "}
                <Text
                  style={{
                    color: delta > 0 ? colors.accent : colors.foregroundMuted,
                    fontWeight: delta > 0 ? "600" : "400",
                  }}
                >
                  {isZh ? `变动 ${delta}` : `Δ${delta}`}
                </Text>
              </>
            ) : null}
            {`${dur ? ` · ${dur}` : ""} · ${relativeTimeLabel(collector.lastRunAt, isZh)}`}
          </Text>
        ) : (
          <Text
            style={{
              color: collector.running ? colors.accent : colors.foregroundMuted,
              fontSize: 11.5,
            }}
          >
            {fallbackRightMeta}
          </Text>
        )}

        {onChanged ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", flexShrink: 1, gap: 5 }}>
            {collector.capabilities?.health ? (
              <PillButton
                theme={theme}
                label={t(checkingHealth ? "settings.healthChecking" : "settings.healthCheck")}
                disabled={!collector.enabled || collector.running || checkingHealth || retrying || testing || toggling}
                onPress={handleCheckHealth}
              />
            ) : null}
            {(hasError || hasWarn) && collector.enabled ? (
              <Pressable
                accessibilityRole="button"
                disabled={checkingHealth || retrying || testing || collector.running}
                onPress={handleRetry}
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: colors.accent,
                  backgroundColor: colors.surface2,
                  opacity: retrying ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "600" }}>
                  {retrying ? t("board.retryingBtn") : t("board.retryBtn")}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={checkingHealth || testing || retrying || collector.running}
              onPress={handleTest}
              style={{
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
                opacity: testing ? 0.5 : 1,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                {testing ? t("settings.testingBtn") : t("settings.testBtn")}
              </Text>
            </Pressable>
            {(hasError || hasWarn) && collector.enabled ? (
              <Pressable
                accessibilityRole="button"
                disabled={dismissing || collector.running}
                onPress={handleDismissError}
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                  opacity: dismissing ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {t("board.dismissBtn")}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={checkingHealth || toggling || collector.running}
              onPress={handleToggle}
              style={{
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: collector.enabled ? colors.border : colors.accent,
                backgroundColor: collector.enabled ? colors.surface1 : colors.surface2,
                opacity: toggling ? 0.5 : 1,
              }}
            >
              <Text
                style={{
                  color: collector.enabled ? colors.foregroundMuted : colors.accent,
                  fontSize: 11,
                  fontWeight: collector.enabled ? "400" : "600",
                }}
              >
                {collector.enabled ? t("settings.disableBtn") : t("settings.enableBtn")}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {collector.error && collector.enabled ? (
        <Text style={{ color: colors.statusDanger, fontSize: 11.5, paddingLeft: 22 }} selectable>
          {collector.error}
        </Text>
      ) : collector.warnings.length > 0 && collector.enabled ? (
        <Text style={{ color: colors.statusWarning, fontSize: 11.5, paddingLeft: 22 }} selectable>
          {collector.warnings.join("；")}
        </Text>
      ) : null}
    </View>
  );
}

export function useRadarSnapshot(pollMs = 5000, hostId?: string) {
  const paseo = usePaseo();
  const load = useRpc(loadRadarRpc);
  const initial = getCachedRadarSnapshot(paseo);
  return useQuery({
    queryKey: radarHostQueryKey(hostId),
    queryFn: function () {
      return load({}).then((snap) => {
        setCachedRadarSnapshot(paseo, snap);
        return snap;
      });
    },
    refetchInterval: function (query) {
      return query.state.data?.scanning ? Math.min(pollMs, 1200) : pollMs;
    },
    ...(initial === null ? {} : { placeholderData: initial }),
  });
}

type ViewTab =
  | "pool"
  | "needs_me"
  | "running"
  | "waiting_external"
  | "board"
  | "archived"
  | "hidden"
  | "insights";

type WebKeyboardEventLike = {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
};

type WebElementLike = {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
};

type BrowserWindowLike = {
  location?: {
    pathname: string;
    search: string;
    hash: string;
  };
  history?: {
    state: unknown;
    pushState(data: unknown, unused: string, url?: string): void;
    replaceState(data: unknown, unused: string, url?: string): void;
  };
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  document?: {
    activeElement?: WebElementLike | null;
  };
  addEventListener?: (type: string, listener: (event: WebKeyboardEventLike) => void) => void;
  removeEventListener?: (type: string, listener: (event: WebKeyboardEventLike) => void) => void;
};

const VIEW_STATE_STORAGE_PREFIX = "paseo-radar:view-state:v1:";

function loadRadarViewState(hostId: string): PersistedRadarViewState {
  const mem = cachedViewStateByHost.get(hostId);
  if (mem) return mem;

  const fallback: PersistedRadarViewState = {
    tab: "pool",
    needsMeFilter: "all",
    copilotOpen: true,
  };
  const win = globalThis as unknown as BrowserWindowLike;
  try {
    const raw = win.localStorage?.getItem(`${VIEW_STATE_STORAGE_PREFIX}${hostId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedRadarViewState>;
      const loaded: PersistedRadarViewState = {
        tab: isValidViewTab(parsed.tab) ? parsed.tab : fallback.tab,
        needsMeFilter: isValidNeedsMeFilter(parsed.needsMeFilter)
          ? parsed.needsMeFilter
          : fallback.needsMeFilter,
        copilotOpen: typeof parsed.copilotOpen === "boolean" ? parsed.copilotOpen : fallback.copilotOpen,
      };
      cachedViewStateByHost.set(hostId, loaded);
      return loaded;
    }
  } catch {
    // Ignore storage read errors
  }
  cachedViewStateByHost.set(hostId, fallback);
  return fallback;
}

function saveRadarViewState(hostId: string, patch: Partial<PersistedRadarViewState>): PersistedRadarViewState {
  const prev = loadRadarViewState(hostId);
  const next: PersistedRadarViewState = { ...prev, ...patch };
  cachedViewStateByHost.set(hostId, next);
  const win = globalThis as unknown as BrowserWindowLike;
  try {
    win.localStorage?.setItem(`${VIEW_STATE_STORAGE_PREFIX}${hostId}`, JSON.stringify(next));
  } catch {
    // Ignore storage write errors
  }
  return next;
}

function buildRadarScreenUrl(
  pathname: string,
  search: string,
  hash: string,
  state: {
    tab: ViewTab;
    needsMeFilter: "all" | NeedsMeTag;
    cardId?: string | null;
    coordCardId?: string | null;
  },
): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const entries = new Map<string, string>();
  if (raw) {
    for (const part of raw.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      try {
        const k = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
        const v = eq >= 0 ? decodeURIComponent(part.slice(eq + 1)) : "";
        entries.set(k, v);
      } catch {
        // Ignore malformed query segment
      }
    }
  }
  entries.set("param.tab", state.tab);
  entries.set("param.filter", state.needsMeFilter);
  entries.delete("param.view");
  if (state.cardId) {
    entries.set("param.cardId", state.cardId);
  } else {
    entries.delete("param.cardId");
  }
  if (state.coordCardId) {
    entries.set("param.coordCardId", state.coordCardId);
  } else {
    entries.delete("param.coordCardId");
  }
  const qs = Array.from(entries.entries())
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `${pathname}?${qs}${hash}` : `${pathname}${hash}`;
}

function syncCurrentRadarUrl(
  platform: PluginScreenProps["layout"]["platform"],
  state: {
    tab: ViewTab;
    needsMeFilter: "all" | NeedsMeTag;
    cardId?: string | null;
    coordCardId?: string | null;
  },
): void {
  const win = globalThis as unknown as BrowserWindowLike;
  const loc = win.location;
  const hist = win.history;
  if (
    platform !== "web" ||
    !loc ||
    !hist ||
    typeof hist.replaceState !== "function" ||
    !loc.pathname.includes("/plugin/")
  ) {
    return;
  }
  const currentUrl = `${loc.pathname}${loc.search}${loc.hash}`;
  const nextUrl = buildRadarScreenUrl(loc.pathname, loc.search, loc.hash, state);
  if (nextUrl !== currentUrl) {
    hist.replaceState(hist.state, "", nextUrl);
  }
}

let pendingBackHistoryTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingBackHistoryTimer(): void {
  if (pendingBackHistoryTimer !== null) {
    clearTimeout(pendingBackHistoryTimer);
    pendingBackHistoryTimer = null;
  }
}

function openAgentWithRadarBackHistory(
  open: (agentId: string) => void,
  agentId: string,
  platform: PluginScreenProps["layout"]["platform"],
  viewState: { tab: ViewTab; needsMeFilter: "all" | NeedsMeTag },
): void {
  const win = globalThis as unknown as BrowserWindowLike;
  const loc = win.location;
  const hist = win.history;
  if (
    platform !== "web" ||
    !loc ||
    !hist ||
    typeof hist.pushState !== "function" ||
    typeof hist.replaceState !== "function"
  ) {
    open(agentId);
    return;
  }

  const radarPathname = loc.pathname;
  const radarUrl = buildRadarScreenUrl(loc.pathname, loc.search, loc.hash, {
    tab: viewState.tab,
    needsMeFilter: viewState.needsMeFilter,
    cardId: null,
  });
  clearPendingBackHistoryTimer();
  open(agentId);

  const startedAt = Date.now();
  const waitForLeaveRadar = (): void => {
    if (loc.pathname !== radarPathname) {
      pendingBackHistoryTimer = setTimeout(() => {
        pendingBackHistoryTimer = null;
        if (loc.pathname === radarPathname) return;
        const currentUrl = `${loc.pathname}${loc.search}${loc.hash}`;
        if (currentUrl === radarUrl) return;
        const currentState = hist.state;
        hist.replaceState({ paseoRadarReturn: true }, "", radarUrl);
        hist.pushState(currentState, "", currentUrl);
      }, 120);
      return;
    }
    if (Date.now() - startedAt >= 1000) {
      pendingBackHistoryTimer = null;
      return;
    }
    pendingBackHistoryTimer = setTimeout(waitForLeaveRadar, 25);
  };

  pendingBackHistoryTimer = setTimeout(waitForLeaveRadar, 25);
}

export function RadarScreen({ params, theme, host, layout, navigation }: PluginScreenProps) {
  const compact = layout.compact;
  const paseo = usePaseo();
  const hosts = useHosts();
  const multiHost = hosts.length > 1;
  const queryClient = useQueryClient();
  const scanNow = useRpc(scanRadarRpc);
  const archiveIdleCopilot = useRpc(resetCopilotRpc);
  const followBatch = useRpc(followBatchRadarItemsRpc);
  const archiveCard = useRpc(archiveRadarCardRpc);
  const archiveBatch = useRpc(archiveBatchRadarCardsRpc);
  const dismissAlert = useRpc(dismissModelAlertsRpc);
  const retryAlert = useRpc(retryModelAlertRpc);
  const dismissScanErrors = useRpc(dismissScanErrorsRpc);
  const retryScanError = useRpc(retryScanErrorRpc);
  const logInteraction = useRpc(logRadarInteractionRpc);
  const toast = useToast();
  const { isZh, t } = useRadarI18n();

  const radar = useRadarSnapshot(5000, host.id);
  const data = radar.data ?? null;

  const rawFocusedCardId = params.cardId ?? null;
  const paramCoordCardId = params.coordCardId ?? null;
  const paramTab = isValidViewTab(params.tab) ? params.tab : undefined;
  const paramFilter = isValidNeedsMeFilter(params.filter) ? params.filter : undefined;

  const [coordCardId, setCoordCardId] = useState<string | null>(paramCoordCardId);
  const [tab, setTabState] = useState<ViewTab>(() => paramTab ?? loadRadarViewState(host.id).tab);
  const [needsMeFilter, setNeedsMeFilterState] = useState<"all" | NeedsMeTag>(
    () => paramFilter ?? loadRadarViewState(host.id).needsMeFilter,
  );
  const [copilotOpen, setCopilotOpen] = useState<boolean>(
    () => loadRadarViewState(host.id).copilotOpen,
  );
  const lastBoardTabRef = useRef<Exclude<ViewTab, "insights">>(tab !== "insights" ? tab : "pool");
  if (tab !== "insights") {
    lastBoardTabRef.current = tab;
  }

  const [dismissedFocusCardId, setDismissedFocusCardId] = useState<string | null>(null);
  const focusedCardId =
    rawFocusedCardId && rawFocusedCardId !== dismissedFocusCardId ? rawFocusedCardId : null;
  const autoFocusedCardIdRef = useRef<string | null>(null);
  const viewStateRef = useRef<{ tab: ViewTab; needsMeFilter: "all" | NeedsMeTag }>({
    tab,
    needsMeFilter,
  });
  viewStateRef.current = { tab, needsMeFilter };

  const [compactCopilotModalOpen, setCompactCopilotModalOpen] = useState(false);
  const [collectorsOpen, setCollectorsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchAllTabs, setSearchAllTabs] = useState(false);
  const searchInputRef = useRef<NativeTextInput | null>(null);
  const hasSearchQuery = searchQuery.trim().length > 0;
  const effectiveSearchAll = hasSearchQuery && searchAllTabs;
  const [manualScanning, setManualScanning] = useState(false);
  const [batchStarting, setBatchStarting] = useState(false);
  const [batchArchiving, setBatchArchiving] = useState(false);
  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryingAlertKey, setRetryingAlertKey] = useState<string | null>(null);
  const [retryingScanErr, setRetryingScanErr] = useState<string | null>(null);
  const [activeCardId, setActiveCardId] = useState<string | null>(focusedCardId);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [replySignalTarget, setReplySignalTarget] = useState<{ cardId: string; seq: number } | null>(null);
  const [pendingArchiveMap, setPendingArchiveMap] = useState<ReadonlyMap<string, string>>(() => new Map());
  const pendingArchiveIds = useMemo(() => new Set(pendingArchiveMap.keys()), [pendingArchiveMap]);
  const timersRef = useRef<
    Map<string, { timer: ReturnType<typeof setTimeout>; title: string; flush: () => Promise<unknown> }>
  >(new Map());
  const prevHostIdRef = useRef<string>(host.id);
  const archiveCardRef = useRef(archiveCard);
  archiveCardRef.current = archiveCard;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const openSettings = useCallback(() => {
    openRadarSettings(paseo);
  }, [paseo]);

  useEffect(() => {
    if (prevHostIdRef.current !== host.id) {
      prevHostIdRef.current = host.id;
      const remaining = Array.from(timersRef.current.values());
      timersRef.current.clear();
      for (const entry of remaining) {
        clearTimeout(entry.timer);
        void entry.flush().catch(() => {});
      }
      setPendingArchiveMap(new Map());
    }
    const saved = loadRadarViewState(host.id);
    const nextTab = paramTab ?? saved.tab;
    const nextFilter = paramFilter ?? saved.needsMeFilter;
    if (nextTab !== "insights") {
      lastBoardTabRef.current = nextTab;
    }
    setTabState(nextTab);
    setNeedsMeFilterState(nextFilter);
    setCopilotOpen(saved.copilotOpen);
    saveRadarViewState(host.id, { tab: nextTab, needsMeFilter: nextFilter });
    setBatchSelectMode(false);
    setSelectedCardIds(new Set());
    setCollectorsOpen(false);
    setCompactCopilotModalOpen(false);
    setCoordCardId(paramCoordCardId);
  }, [host.id, paramTab, paramFilter, paramCoordCardId]);

  const selectCoordCard = useCallback(
    (nextCardId: string | null): void => {
      setCoordCardId(nextCardId);
      syncCurrentRadarUrl(layout.platform, {
        ...viewStateRef.current,
        cardId: null,
        coordCardId: nextCardId,
      });
    },
    [layout.platform],
  );

  const selectTab = useCallback(
    (next: ViewTab): void => {
      if (rawFocusedCardId) setDismissedFocusCardId(rawFocusedCardId);
      if (next !== "insights") {
        lastBoardTabRef.current = next;
      }
      if (next !== "needs_me") {
        setBatchSelectMode(false);
        setSelectedCardIds(new Set());
      }
      const prevTab = viewStateRef.current.tab;
      const nextState = { ...viewStateRef.current, tab: next };
      viewStateRef.current = nextState;
      saveRadarViewState(host.id, { tab: next });
      setTabState(next);
      syncCurrentRadarUrl(layout.platform, { ...nextState, cardId: null });
      if (prevTab !== next) {
        void logInteraction({ kind: "ui.tab_change", detail: { from: prevTab, to: next } }).catch(() => {});
      }
    },
    [host.id, layout.platform, logInteraction, rawFocusedCardId],
  );

  function selectNeedsMeFilter(next: "all" | NeedsMeTag): void {
    if (rawFocusedCardId) setDismissedFocusCardId(rawFocusedCardId);
    const nextState = { ...viewStateRef.current, needsMeFilter: next };
    viewStateRef.current = nextState;
    saveRadarViewState(host.id, { needsMeFilter: next });
    setNeedsMeFilterState(next);
    syncCurrentRadarUrl(layout.platform, { ...nextState, cardId: null });
  }

  useEffect(() => {
    if (!rawFocusedCardId) {
      autoFocusedCardIdRef.current = null;
      setDismissedFocusCardId(null);
      return;
    }
    if (paramTab !== undefined) {
      autoFocusedCardIdRef.current = rawFocusedCardId;
      return;
    }
    if (
      autoFocusedCardIdRef.current === rawFocusedCardId ||
      dismissedFocusCardId === rawFocusedCardId
    ) {
      return;
    }
    if (!data) return;
    autoFocusedCardIdRef.current = rawFocusedCardId;
    const target = data.items.find((i) => i.id === rawFocusedCardId);
    if (!target) return;
    let targetTab: ViewTab;
    if (target.visibility !== "active") targetTab = "hidden";
    else if (target.status === "archived") targetTab = "archived";
    else if (target.status === "pool") targetTab = "pool";
    else if (target.status === "needs_me") targetTab = "needs_me";
    else if (target.status === "running") targetTab = "running";
    else if (target.status === "waiting_external") targetTab = "waiting_external";
    else targetTab = "board";

    let nextFilter = viewStateRef.current.needsMeFilter;
    if (targetTab === "needs_me") {
      const itemTag = target.needsMeTag ?? "review";
      if (nextFilter !== "all" && nextFilter !== itemTag) {
        nextFilter = "all";
      }
    }
    lastBoardTabRef.current = targetTab;
    const nextState = {
      tab: targetTab,
      needsMeFilter: nextFilter,
    };
    viewStateRef.current = nextState;
    saveRadarViewState(host.id, { tab: targetTab, needsMeFilter: nextFilter });
    setTabState(targetTab);
    setNeedsMeFilterState(nextFilter);
    syncCurrentRadarUrl(layout.platform, {
      ...nextState,
      cardId: rawFocusedCardId,
    });
  }, [rawFocusedCardId, dismissedFocusCardId, paramTab, data, host.id, layout.platform]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: RADAR_QUERY_KEY });
  }, [queryClient]);

  useEffect(() => {
    return () => {
      clearPendingBackHistoryTimer();
      const remaining = Array.from(timersRef.current.entries());
      timersRef.current.clear();
      for (const [itemId, entry] of remaining) {
        clearTimeout(entry.timer);
        void archiveCardRef.current({ itemId }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    archiveIdleCopilot({ onlyIfIdle: true })
      .then((res) => {
        if (res.archived) refresh();
      })
      .catch(() => {});
  }, [host.id]);

  function toggleCopilot(next: boolean): void {
    saveRadarViewState(host.id, { copilotOpen: next });
    setCopilotOpen(next);
  }

  function handleBatchFollowAll(targetItems: readonly RadarItem[]): void {
    if (batchStarting || targetItems.length === 0) return;
    setBatchStarting(true);
    const ids = targetItems.map((i) => i.id);
    followBatch({ itemIds: ids })
      .then((res) => {
        toast.show(
          res.failedCount > 0
            ? isZh
              ? `已启动 ${res.startedCount} 项后台跟进（${res.failedCount} 项失败）`
              : `Started ${res.startedCount} items (${res.failedCount} failed)`
            : isZh
              ? `已将全部 ${res.startedCount} 项投入后台跟进`
              : `Started background follow-up for ${res.startedCount} items`,
          { variant: "success" },
        );
        refresh();
        if (res.startedCount > 0) selectTab("running");
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBatchStarting(false));
  }

  const cancelPendingArchives = useCallback((cardIds: readonly string[]): void => {
    if (cardIds.length === 0) return;
    for (const cardId of cardIds) {
      const entry = timersRef.current.get(cardId);
      if (entry) {
        clearTimeout(entry.timer);
        timersRef.current.delete(cardId);
      }
    }
    setPendingArchiveMap((prev) => {
      let next: Map<string, string> | null = null;
      for (const cardId of cardIds) {
        if (prev.has(cardId)) {
          if (!next) next = new Map(prev);
          next.delete(cardId);
        }
      }
      return next ?? prev;
    });
  }, []);

  const cancelUndoableArchive = useCallback(
    (cardId: string): void => {
      cancelPendingArchives([cardId]);
    },
    [cancelPendingArchives],
  );

  function handleBatchArchiveReady(targetItems: readonly RadarItem[]): void {
    if (batchArchiving || targetItems.length === 0) return;
    setBatchArchiving(true);
    const ids = targetItems.map((i) => i.id);
    cancelPendingArchives(ids);
    archiveBatch({ itemIds: ids })
      .then((res) => {
        toast.show(
          isZh ? `已归档 ${res.archivedCount} 项可完结卡片` : `Archived ${res.archivedCount} ready cards`,
          { variant: "success" },
        );
        refresh();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBatchArchiving(false));
  }

  function handleBatchArchiveSelected(itemIds: readonly string[]): void {
    if (batchArchiving || itemIds.length === 0) return;
    setBatchArchiving(true);
    const ids = [...itemIds];
    cancelPendingArchives(ids);
    archiveBatch({ itemIds: ids })
      .then((res) => {
        toast.show(
          isZh
            ? `已归档 ${res.archivedCount} 项已选卡片`
            : `Archived ${res.archivedCount} selected cards`,
          { variant: "success" },
        );
        setSelectedCardIds(new Set());
        setBatchSelectMode(false);
        refresh();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBatchArchiving(false));
  }

  function toggleCardSelect(cardId: string): void {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }

  function handleScan(): void {
    if (manualScanning || data?.scanning) return;
    setManualScanning(true);
    const earlyPoll = setTimeout(() => {
      refresh();
    }, 250);
    scanNow({})
      .then((snap) => {
        setCachedRadarSnapshot(paseo, snap);
        queryClient.setQueryData(radarHostQueryKey(host.id), snap);
        toast.show(
          isZh
            ? `扫描完成：待办池 ${snap.counts.pool} 项，待我处理 ${snap.counts.needsMe} 项`
            : `Scan complete: ${snap.counts.pool} in Pool, ${snap.counts.needsMe} in Needs Me`,
          { variant: "success" },
        );
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        clearTimeout(earlyPoll);
        setManualScanning(false);
      });
  }

  const openAgent = useMemo(
    () =>
      navigation === undefined
        ? null
        : (agentId: string) => {
            const currentView = viewStateRef.current;
            saveRadarViewState(host.id, currentView);
            void logInteraction({ kind: "ui.open_session", agentId, detail: { tab: currentView.tab } }).catch(() => {});
            openAgentWithRadarBackHistory(
              (id) => navigation.openAgent({ agentId: id }),
              agentId,
              layout.platform,
              currentView,
            );
          },
    [host.id, layout.platform, logInteraction, navigation],
  );

  const filteredItems = useMemo(
    () => filterRadarItems(data?.items ?? [], searchQuery),
    [data?.items, searchQuery],
  );

  const sections = useMemo(() => {
    const all = filteredItems;
    const activeVis = all.filter((i) => i.visibility === "active");
    const openVis = activeVis.filter((i) => i.status !== "archived");

    const poolAll = openVis.filter((i) => i.status === "pool");
    const poolUrgent = poolAll.filter((i) => i.group === "urgent");
    const poolActionable = poolAll.filter(
      (i) => i.group !== "urgent" && !i.badge.includes("100%"),
    );
    const poolLowPriority = poolAll.filter(
      (i) => i.group !== "urgent" && i.badge.includes("100%"),
    );

    const needsMe = openVis.filter((i) => i.status === "needs_me");
    const needsMeReady = needsMe.filter((i) => i.needsMeTag === "ready_to_archive");
    const needsMeDecision = needsMe.filter((i) => i.needsMeTag === "decision");
    const needsMeInput = needsMe.filter((i) => i.needsMeTag === "input");
    const needsMeReview = needsMe.filter((i) => i.needsMeTag === "review" || i.needsMeTag === null);
    const running = openVis.filter((i) => i.status === "running");
    const waitingExternal = openVis.filter((i) => i.status === "waiting_external");
    const archived = activeVis.filter((i) => i.status === "archived");
    const hidden = all.filter((i) => i.visibility !== "active");

    return {
      poolAll,
      poolUrgent,
      poolActionable,
      poolLowPriority,
      needsMe,
      needsMeReady,
      needsMeDecision,
      needsMeInput,
      needsMeReview,
      running,
      waitingExternal,
      archived,
      hidden,
    };
  }, [filteredItems]);

  const { colors } = theme;
  const counts = data?.counts;
  const isScanning = manualScanning || data?.scanning === true;
  const collectors = data?.collectors ?? [];
  const enabledCollectors = useMemo(() => collectors.filter((c) => c.enabled), [collectors]);
  const runningCollectors = useMemo(() => collectors.filter((c) => c.running), [collectors]);
  const collectorStatusSummary = useMemo(() => {
    const total = enabledCollectors.length;
    const hasErr = enabledCollectors.some((c) => Boolean(c.error));
    const hasWarn = !hasErr && enabledCollectors.some((c) => c.warnings.length > 0);
    if (runningCollectors.length > 0) {
      const done = Math.max(0, total - runningCollectors.length);
      return {
        spinning: true,
        dotColor: colors.accent,
        borderColor: colors.accent,
        label: t("board.colSpinning", { done, total: Math.max(total, runningCollectors.length) }),
      };
    }
    if (isScanning && total > 0) {
      return {
        spinning: true,
        dotColor: colors.accent,
        borderColor: colors.accent,
        label: t("board.colTriage", { total }),
      };
    }
    if (total > 0) {
      return {
        spinning: false,
        dotColor: hasErr ? colors.statusDanger : hasWarn ? colors.statusWarning : colors.statusSuccess,
        borderColor: hasErr ? colors.statusDanger : colors.border,
        label: t("board.colSummary", { total }),
      };
    }
    return {
      spinning: false,
      dotColor: colors.foregroundMuted,
      borderColor: colors.border,
      label: t("board.colSummary", { total: 0 }),
    };
  }, [colors, enabledCollectors, isScanning, runningCollectors, t]);

  const readyMeta = useMemo(() => needsMeTagMetaForLocale("ready_to_archive", isZh), [isZh]);
  const decisionMeta = useMemo(() => needsMeTagMetaForLocale("decision", isZh), [isZh]);
  const inputMeta = useMemo(() => needsMeTagMetaForLocale("input", isZh), [isZh]);
  const reviewMeta = useMemo(() => needsMeTagMetaForLocale("review", isZh), [isZh]);

  const currentBoardSections = useMemo<Array<{ key: string; title?: string; icon?: string; items: readonly RadarItem[] }>>(() => {
    if (tab === "insights") return [];
    let list: Array<{ key: string; title?: string; icon?: string; items: readonly RadarItem[] }>;
    if (effectiveSearchAll) {
      list = [
        { key: "pool", title: isZh ? "待办池" : "Pool", icon: "Inbox", items: sections.poolAll },
        { key: "needs_me", title: isZh ? "待我处理" : "Needs Me", icon: "UserCheck", items: sections.needsMe },
        { key: "running", title: isZh ? "AI 处理中" : "Running", icon: "Cpu", items: sections.running },
        {
          key: "waiting_external",
          title: isZh ? "等待外部" : "Waiting",
          icon: "PauseCircle",
          items: sections.waitingExternal,
        },
        { key: "archived", title: isZh ? "已归档" : "Archived", icon: "Archive", items: sections.archived },
        { key: "hidden", title: isZh ? "已忽略" : "Hidden", icon: "EyeOff", items: sections.hidden },
      ];
      return list.filter((sec) => sec.items.length > 0);
    }
    if (tab === "pool") {
      list = [
        { key: "urgent", title: t("board.secUrgentTitle"), icon: "Flame", items: sections.poolUrgent },
        { key: "actionable", title: t("board.secActionableTitle"), icon: "Zap", items: sections.poolActionable },
        { key: "closing", title: t("board.secClosingProjTitle"), icon: "FolderCheck", items: sections.poolLowPriority },
      ];
    } else if (tab === "board") {
      list = [
        { key: "ready", title: readyMeta.label, icon: readyMeta.icon, items: sections.needsMeReady },
        { key: "decision", title: decisionMeta.label, icon: decisionMeta.icon, items: sections.needsMeDecision },
        { key: "input", title: inputMeta.label, icon: inputMeta.icon, items: sections.needsMeInput },
        { key: "review", title: reviewMeta.label, icon: reviewMeta.icon, items: sections.needsMeReview },
        { key: "running", title: isZh ? "AI 处理中" : "Running", icon: "Cpu", items: sections.running },
        {
          key: "waiting_external",
          title: isZh ? "等待外部" : "Waiting",
          icon: "PauseCircle",
          items: sections.waitingExternal,
        },
      ];
    } else if (tab === "needs_me") {
      if (needsMeFilter === "all") {
        list = [
          { key: "ready", title: readyMeta.label, icon: readyMeta.icon, items: sections.needsMeReady },
          { key: "decision", title: decisionMeta.label, icon: decisionMeta.icon, items: sections.needsMeDecision },
          { key: "input", title: inputMeta.label, icon: inputMeta.icon, items: sections.needsMeInput },
          { key: "review", title: reviewMeta.label, icon: reviewMeta.icon, items: sections.needsMeReview },
        ];
      } else {
        const filteredMap: Record<NeedsMeTag, readonly RadarItem[]> = {
          ready_to_archive: sections.needsMeReady,
          decision: sections.needsMeDecision,
          input: sections.needsMeInput,
          review: sections.needsMeReview,
        };
        const fm = needsMeTagMetaForLocale(needsMeFilter, isZh);
        list = [{ key: needsMeFilter, title: fm.label, icon: fm.icon, items: filteredMap[needsMeFilter] }];
      }
    } else if (tab === "running") {
      list = [{ key: "running", items: sections.running }];
    } else if (tab === "waiting_external") {
      list = [{ key: "waiting_external", items: sections.waitingExternal }];
    } else if (tab === "archived") {
      list = [{ key: "archived", items: sections.archived }];
    } else {
      list = [{ key: "hidden", items: sections.hidden }];
    }
    return list.filter((sec) => sec.items.length > 0);
  }, [
    decisionMeta.icon,
    decisionMeta.label,
    effectiveSearchAll,
    inputMeta.icon,
    inputMeta.label,
    isZh,
    needsMeFilter,
    readyMeta.icon,
    readyMeta.label,
    reviewMeta.icon,
    reviewMeta.label,
    sections,
    t,
    tab,
  ]);

  const visibleFlatItems = useMemo(
    () => currentBoardSections.flatMap((sec) => sec.items),
    [currentBoardSections],
  );
  const visibleFlatItemsRef = useRef<readonly RadarItem[]>(visibleFlatItems);
  visibleFlatItemsRef.current = visibleFlatItems;
  const activeCardIdRef = useRef<string | null>(activeCardId);
  activeCardIdRef.current = activeCardId;
  const openAgentRef = useRef<((agentId: string) => void) | null>(openAgent);
  openAgentRef.current = openAgent;
  const lastAppliedFocusRef = useRef<string | null>(null);
  const cardNodeRefs = useRef<Map<string, unknown>>(new Map());

  const scrollCardIntoView = useCallback((cardId: string) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame;
    const run = () => {
      const node = cardNodeRefs.current.get(cardId) as
        | { scrollIntoView?: (options?: { block?: string; behavior?: string }) => void }
        | undefined;
      if (node && typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    if (typeof raf === "function") raf(run);
    else run();
  }, []);

  useEffect(() => {
    if (focusedCardId && lastAppliedFocusRef.current !== focusedCardId) {
      lastAppliedFocusRef.current = focusedCardId;
      setActiveCardId(focusedCardId);
    } else if (!focusedCardId) {
      lastAppliedFocusRef.current = null;
    }
  }, [focusedCardId]);

  useEffect(() => {
    if (visibleFlatItems.length === 0) {
      if (activeCardId !== null) setActiveCardId(null);
      return;
    }
    if (activeCardId && visibleFlatItems.some((item) => item.id === activeCardId)) {
      return;
    }
    const fallback =
      (focusedCardId && visibleFlatItems.some((item) => item.id === focusedCardId)
        ? focusedCardId
        : null) ??
      visibleFlatItems.find((item) => !pendingArchiveIds.has(item.id))?.id ??
      visibleFlatItems[0]?.id ??
      null;
    setActiveCardId(fallback);
  }, [activeCardId, focusedCardId, pendingArchiveIds, visibleFlatItems]);

  useEffect(() => {
    setExpandedCardId((cur) => (cur === activeCardId ? cur : null));
  }, [activeCardId]);

  const handleActivateCard = useCallback((cardId: string) => {
    setActiveCardId(cardId);
    setExpandedCardId((cur) => (cur === cardId ? cur : null));
  }, []);

  const handleToggleCardExpand = useCallback((cardId: string) => {
    setActiveCardId(cardId);
    setExpandedCardId((cur) => (cur === cardId ? null : cardId));
  }, []);

  useEffect(() => {
    if (batchSelectMode && (tab !== "needs_me" || sections.needsMe.length <= 1)) {
      setBatchSelectMode(false);
      setSelectedCardIds(new Set());
    }
  }, [batchSelectMode, sections.needsMe.length, tab]);

  const effectiveSelectedIdsList = useMemo(() => {
    if (selectedCardIds.size === 0) return [];
    const activeNeedsMeIds = new Set(sections.needsMe.map((i) => i.id));
    return Array.from(selectedCardIds).filter(
      (id) => activeNeedsMeIds.has(id) && !pendingArchiveIds.has(id),
    );
  }, [pendingArchiveIds, sections.needsMe, selectedCardIds]);

  const selectableReviewItems = useMemo(
    () => sections.needsMeReview.filter((item) => !pendingArchiveIds.has(item.id)),
    [pendingArchiveIds, sections.needsMeReview],
  );

  const effectiveSelectedIdsSet = useMemo(
    () => new Set(effectiveSelectedIdsList),
    [effectiveSelectedIdsList],
  );

  const requestUndoableArchive = useCallback(
    (item: RadarItem, advanceNext = false): void => {
      if (item.status === "archived" || item.visibility !== "active") return;
      if (timersRef.current.has(item.id)) return;

      if (advanceNext || activeCardIdRef.current === item.id) {
        const items = visibleFlatItemsRef.current;
        const idx = items.findIndex((c) => c.id === item.id);
        let nextId: string | null = null;
        if (idx >= 0) {
          for (let i = idx + 1; i < items.length; i += 1) {
            const candidate = items[i];
            if (candidate && candidate.id !== item.id && !timersRef.current.has(candidate.id)) {
              nextId = candidate.id;
              break;
            }
          }
          if (!nextId) {
            for (let i = idx - 1; i >= 0; i -= 1) {
              const candidate = items[i];
              if (candidate && candidate.id !== item.id && !timersRef.current.has(candidate.id)) {
                nextId = candidate.id;
                break;
              }
            }
          }
        }
        setActiveCardId(nextId);
      }

      const execArchive = archiveCardRef.current;
      const timer = setTimeout(() => {
        const entry = timersRef.current.get(item.id);
        if (!entry) return;
        timersRef.current.delete(item.id);
        execArchive({ itemId: item.id })
          .then(() => queryClient.invalidateQueries({ queryKey: RADAR_QUERY_KEY }))
          .catch((err: unknown) => {
            toastRef.current.error(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            setPendingArchiveMap((prev) => {
              if (!prev.has(item.id)) return prev;
              const next = new Map(prev);
              next.delete(item.id);
              return next;
            });
          });
      }, 3500);

      timersRef.current.set(item.id, {
        timer,
        title: item.title,
        flush: () => execArchive({ itemId: item.id }),
      });
      setPendingArchiveMap((prev) => {
        const next = new Map(prev);
        next.set(item.id, item.title);
        return next;
      });
    },
    [queryClient],
  );

  useEffect(() => {
    if (layout.platform !== "web" || tab === "insights") return;
    const win = globalThis as unknown as BrowserWindowLike;
    if (typeof win.addEventListener !== "function" || typeof win.removeEventListener !== "function") {
      return;
    }

    const onKeyDown = (e: WebKeyboardEventLike): void => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (compactCopilotModalOpen) return;

      const activeEl = win.document?.activeElement;
      if (activeEl) {
        const tag = (activeEl.tagName ?? "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || activeEl.isContentEditable) {
          return;
        }
      }

      const key = e.key ?? "";
      const lower = key.toLowerCase();

      if (key === "/") {
        e.preventDefault?.();
        searchInputRef.current?.focus();
        return;
      }

      const items = visibleFlatItemsRef.current;
      if (items.length === 0) return;

      const currentId = activeCardIdRef.current;
      const currentIdx = currentId ? items.findIndex((c) => c.id === currentId) : -1;

      if (lower === "j" || key === "ArrowDown") {
        e.preventDefault?.();
        const nextIdx = currentIdx < 0 ? 0 : Math.min(items.length - 1, currentIdx + 1);
        const nextItem = items[nextIdx];
        if (nextItem) {
          setActiveCardId(nextItem.id);
          scrollCardIntoView(nextItem.id);
        }
        return;
      }

      if (lower === "k" || key === "ArrowUp") {
        e.preventDefault?.();
        const prevIdx = currentIdx < 0 ? 0 : Math.max(0, currentIdx - 1);
        const prevItem = items[prevIdx];
        if (prevItem) {
          setActiveCardId(prevItem.id);
          scrollCardIntoView(prevItem.id);
        }
        return;
      }

      const activeCard = (currentIdx >= 0 ? items[currentIdx] : items[0]) ?? null;
      if (!activeCard) return;

      if (key === "Enter") {
        if (activeEl) {
          const tag = (activeEl.tagName ?? "").toUpperCase();
          const role = activeEl.getAttribute?.("role");
          if (tag === "BUTTON" || tag === "A" || role === "button" || role === "tab") {
            return;
          }
        }
        const primaryAgentId = activeCard.workspace?.primaryAgentId ?? null;
        if (primaryAgentId && openAgentRef.current) {
          e.preventDefault?.();
          openAgentRef.current(primaryAgentId);
        }
        return;
      }

      if (lower === "r") {
        if (
          activeCard.workspace?.primaryAgentId &&
          activeCard.status !== "archived" &&
          activeCard.visibility === "active"
        ) {
          e.preventDefault?.();
          setReplySignalTarget((prev) => ({ cardId: activeCard.id, seq: (prev?.seq ?? 0) + 1 }));
        }
        return;
      }

      if (lower === "e") {
        if (activeCard.status !== "archived" && activeCard.visibility === "active") {
          e.preventDefault?.();
          requestUndoableArchive(activeCard, true);
        }
      }
    };

    win.addEventListener("keydown", onKeyDown);
    return () => {
      win.removeEventListener?.("keydown", onKeyDown);
    };
  }, [compactCopilotModalOpen, layout.platform, requestUndoableArchive, tab]);

  const hideRedundantStatusPill = tab !== "insights";

  const boardMatchCount =
    sections.needsMe.length + sections.running.length + sections.waitingExternal.length;

  const tabs: Array<{ id: Exclude<ViewTab, "insights">; label: string; count: number }> = [
    {
      id: "pool",
      label: t("tabs.pool", { count: hasSearchQuery ? sections.poolAll.length : counts?.pool ?? 0 }),
      count: hasSearchQuery ? sections.poolAll.length : counts?.pool ?? 0,
    },
    {
      id: "needs_me",
      label: t("tabs.needs_me", { count: hasSearchQuery ? sections.needsMe.length : counts?.needsMe ?? 0 }),
      count: hasSearchQuery ? sections.needsMe.length : counts?.needsMe ?? 0,
    },
    {
      id: "running",
      label: t("tabs.running", { count: hasSearchQuery ? sections.running.length : counts?.running ?? 0 }),
      count: hasSearchQuery ? sections.running.length : counts?.running ?? 0,
    },
    {
      id: "waiting_external",
      label: t("tabs.waiting_external", {
        count: hasSearchQuery ? sections.waitingExternal.length : counts?.waitingExternal ?? 0,
      }),
      count: hasSearchQuery ? sections.waitingExternal.length : counts?.waitingExternal ?? 0,
    },
    {
      id: "board",
      label: t("tabs.board", { count: hasSearchQuery ? boardMatchCount : counts?.boardTotal ?? 0 }),
      count: hasSearchQuery ? boardMatchCount : counts?.boardTotal ?? 0,
    },
    {
      id: "archived",
      label: t("tabs.archived", { count: hasSearchQuery ? sections.archived.length : counts?.archived ?? 0 }),
      count: hasSearchQuery ? sections.archived.length : counts?.archived ?? 0,
    },
    {
      id: "hidden",
      label: t("tabs.hidden", { count: hasSearchQuery ? sections.hidden.length : counts?.hidden ?? 0 }),
      count: hasSearchQuery ? sections.hidden.length : counts?.hidden ?? 0,
    },
  ];

  function handleSelectAllReview(): void {
    if (needsMeFilter !== "all" && needsMeFilter !== "review") {
      selectNeedsMeFilter("review");
    }
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      for (const item of selectableReviewItems) {
        next.add(item.id);
      }
      return next;
    });
  }

  function renderNeedsMeToolbar() {
    const tagFilters: Array<{ id: "all" | NeedsMeTag; label: string; count: number }> = [
      { id: "all", label: t("board.allFilter"), count: sections.needsMe.length },
      { id: "ready_to_archive", label: readyMeta.label, count: sections.needsMeReady.length },
      { id: "decision", label: decisionMeta.label, count: sections.needsMeDecision.length },
      { id: "input", label: inputMeta.label, count: sections.needsMeInput.length },
      { id: "review", label: reviewMeta.label, count: sections.needsMeReview.length },
    ];

    return (
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        {tagFilters.map((f) => {
          const active = needsMeFilter === f.id;
          const dimmed = f.id !== "all" && f.count === 0 && !active;
          return (
            <Pressable
              key={f.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => selectNeedsMeFilter(f.id)}
              style={{
                paddingHorizontal: 9,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                borderColor:
                  f.id === "ready_to_archive" && f.count > 0 && active
                    ? colors.statusSuccess
                    : colors.border,
                backgroundColor: active ? colors.surface2 : colors.surface1,
                opacity: dimmed ? 0.48 : 1,
              }}
            >
              <Text
                style={{
                  color:
                    f.id === "ready_to_archive" && f.count > 0
                      ? colors.statusSuccess
                      : active
                        ? colors.foreground
                        : colors.foregroundMuted,
                  fontSize: 12,
                  fontWeight: active ? "600" : "400",
                }}
              >
                {f.label} ({f.count})
              </Text>
            </Pressable>
          );
        })}

        <View style={{ flex: 1 }} />

        {sections.needsMe.length > 1 ? (
          batchSelectMode ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              {selectableReviewItems.length > 0 ? (
                <PillButton
                  icon="CheckSquare"
                  label={t("board.batchSelectReview", { count: selectableReviewItems.length })}
                  tone="default"
                  disabled={batchArchiving}
                  theme={theme}
                  onPress={handleSelectAllReview}
                />
              ) : null}
              <PillButton
                icon="Archive"
                label={
                  batchArchiving
                    ? t("board.batchArchiving", { count: effectiveSelectedIdsList.length })
                    : t("board.batchArchiveSelected", { count: effectiveSelectedIdsList.length })
                }
                tone={effectiveSelectedIdsList.length > 0 ? "primary" : "default"}
                disabled={batchArchiving || effectiveSelectedIdsList.length === 0}
                theme={theme}
                onPress={() => handleBatchArchiveSelected(effectiveSelectedIdsList)}
              />
              <PillButton
                icon="X"
                label={t("board.batchCancel")}
                tone="subtle"
                disabled={batchArchiving}
                theme={theme}
                onPress={() => {
                  setBatchSelectMode(false);
                  setSelectedCardIds(new Set());
                }}
              />
            </View>
          ) : (
            <PillButton
              icon="CheckSquare"
              label={t("board.batchSelect")}
              tone="subtle"
              theme={theme}
              onPress={() => {
                setSelectedCardIds(new Set());
                setBatchSelectMode(true);
              }}
            />
          )
        ) : null}

        {!batchSelectMode && sections.needsMeReady.length > 0 ? (
          <PillButton
            icon="Archive"
            label={
              batchArchiving
                ? t("board.batchArchiving", { count: sections.needsMeReady.length })
                : t("board.batchArchiveReady", { count: sections.needsMeReady.length })
            }
            tone="primary"
            disabled={batchArchiving}
            theme={theme}
            onPress={() => handleBatchArchiveReady(sections.needsMeReady)}
          />
        ) : null}
      </View>
    );
  }

  function renderSection(title: string, subtitle: string, icon: string, list: readonly RadarItem[]) {
    if (list.length === 0) return null;
    return (
      <View key={title} style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={icon} size={15} color={colors.foregroundMuted} />
            <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
              {title} ({list.length})
            </Text>
          </View>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{subtitle}</Text>
        </View>
        <View style={{ gap: 10 }}>
          {list.map((item) => (
            <View
              key={item.id}
              ref={(node: unknown) => {
                if (node) cardNodeRefs.current.set(item.id, node);
                else cardNodeRefs.current.delete(item.id);
              }}
            >
              <RadarCardView
                item={item}
                projects={data?.projects ?? []}
                highlighted={item.id === focusedCardId}
                hideRedundantStatusPill={hideRedundantStatusPill}
                keyboardFocused={item.id === activeCardId}
                expanded={item.id === expandedCardId}
                onToggleExpand={() => handleToggleCardExpand(item.id)}
                onActivate={() => handleActivateCard(item.id)}
                replyExpandSignal={replySignalTarget?.cardId === item.id ? replySignalTarget.seq : 0}
                selectable={tab === "needs_me" && batchSelectMode}
                selected={effectiveSelectedIdsSet.has(item.id)}
                onToggleSelect={() => toggleCardSelect(item.id)}
                pendingArchive={pendingArchiveIds.has(item.id)}
                onRequestArchive={
                  item.status !== "archived" && item.visibility === "active"
                    ? () => requestUndoableArchive(item, true)
                    : undefined
                }
                onCancelPendingArchive={() => cancelUndoableArchive(item.id)}
                theme={theme}
                onChanged={refresh}
                onOpenAgent={openAgent}
                coordinationBetaEnabled={Boolean(data?.coordinationBetaEnabled)}
                onOpenCoordBoard={selectCoordCard}
              />
            </View>
          ))}
        </View>
      </View>
    );
  }

  const archivedBanner =
    tab === "archived" ? (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
          backgroundColor: colors.surface1,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Icon name="Info" size={14} color={colors.foregroundMuted} />
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {t("board.archivedNotice")}
        </Text>
      </View>
    ) : null;

  function renderEmptyStateForTab() {
    if (hasSearchQuery) {
      const q = searchQuery.trim();
      const otherNonZeroTabs = tabs.filter(
        (tabItem) => tabItem.id !== tab && tabItem.id !== "board" && tabItem.count > 0,
      );
      return (
        <View style={{ padding: 32, alignItems: "center", gap: 10 }}>
          <Icon name="Search" size={24} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
            {effectiveSearchAll || filteredItems.length === 0
              ? t("board.searchEmptyAll", { query: q })
              : t("board.searchEmptyTab", { query: q })}
          </Text>
          {!effectiveSearchAll && filteredItems.length > 0 && otherNonZeroTabs.length > 0 ? (
            <View style={{ alignItems: "center", gap: 6, marginTop: 4 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {t("board.searchFoundInOtherTabs")}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
                {otherNonZeroTabs.map((tabItem) => (
                  <PillButton
                    key={tabItem.id}
                    label={tabItem.label}
                    tone="default"
                    theme={theme}
                    onPress={() => {
                      setSearchAllTabs(false);
                      selectTab(tabItem.id);
                    }}
                  />
                ))}
                <PillButton
                  icon="Layers"
                  label={t("board.searchAllTabs", { count: filteredItems.length })}
                  tone="accent"
                  theme={theme}
                  onPress={() => setSearchAllTabs(true)}
                />
              </View>
            </View>
          ) : null}
          <PillButton
            icon="X"
            label={t("board.searchClear")}
            tone="subtle"
            theme={theme}
            onPress={() => {
              setSearchQuery("");
              setSearchAllTabs(false);
            }}
          />
        </View>
      );
    }
    if (tab === "pool") {
      return (
        <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
          <Icon name="CheckCircle2" size={24} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("board.emptyPool")}</Text>
        </View>
      );
    }
    if (tab === "board") {
      return (
        <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
          <Icon name="CheckCircle2" size={24} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("board.emptyBoard")}</Text>
        </View>
      );
    }
    if (tab === "needs_me") {
      if (sections.needsMe.length === 0) {
        return (
          <View style={{ padding: 32, alignItems: "center", gap: 6 }}>
            <Icon name="CheckCircle2" size={24} color={colors.foregroundMuted} />
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("board.emptyNeedsMe")}</Text>
          </View>
        );
      }
      return (
        <View style={{ padding: 28, alignItems: "center", gap: 6 }}>
          <Icon name="CheckCircle2" size={22} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
            {t("board.emptyTagFilter", {
              tag: needsMeTagMetaForLocale(needsMeFilter === "all" ? "review" : needsMeFilter, isZh).label,
            })}
          </Text>
        </View>
      );
    }
    return (
      <View style={{ padding: 32, alignItems: "center", gap: 6 }}>
        <Icon name="CheckCircle2" size={24} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("board.emptyCategory")}</Text>
      </View>
    );
  }

  function renderTabBody() {
    if (tab === "insights") {
      return (
        <InsightsPane
          hostId={host.id}
          compact={compact}
          resolvedInsightModel={data?.resolvedModels?.insightModel}
          theme={theme}
        />
      );
    }

    if (data === null && radar.isLoading) {
      return (
        <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
          <ActivityIndicator color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("board.loading")}</Text>
        </View>
      );
    }

    if (effectiveSearchAll) {
      if (filteredItems.length === 0) {
        return renderEmptyStateForTab();
      }
      return (
        <>
          {renderSection(isZh ? "待办池" : "Pool", "", "Inbox", sections.poolAll)}
          {renderSection(isZh ? "待我处理" : "Needs Me", "", "UserCheck", sections.needsMe)}
          {renderSection(isZh ? "AI 处理中" : "Running", "", "Cpu", sections.running)}
          {renderSection(isZh ? "等待外部" : "Waiting", "", "PauseCircle", sections.waitingExternal)}
          {renderSection(isZh ? "已归档" : "Archived", "", "Archive", sections.archived)}
          {renderSection(isZh ? "已忽略" : "Hidden", "", "EyeOff", sections.hidden)}
        </>
      );
    }

    if (tab === "pool") {
      if (sections.poolAll.length === 0) {
        return renderEmptyStateForTab();
      }
      return (
        <>
          {renderSection(
            t("board.secUrgentTitle"),
            t("board.secUrgentSub"),
            "Flame",
            sections.poolUrgent,
          )}
          {renderSection(
            t("board.secActionableTitle"),
            t("board.secActionableSub"),
            "Zap",
            sections.poolActionable,
          )}
          {renderSection(
            t("board.secClosingProjTitle"),
            t("board.secClosingProjSub"),
            "FolderCheck",
            sections.poolLowPriority,
          )}
        </>
      );
    }

    if (tab === "board") {
      const boardEmpty =
        sections.needsMe.length === 0 &&
        sections.running.length === 0 &&
        sections.waitingExternal.length === 0;
      if (boardEmpty) {
        return renderEmptyStateForTab();
      }
      return (
        <>
          {renderSection(readyMeta.label, readyMeta.subtitle, readyMeta.icon, sections.needsMeReady)}
          {renderSection(decisionMeta.label, decisionMeta.subtitle, decisionMeta.icon, sections.needsMeDecision)}
          {renderSection(inputMeta.label, inputMeta.subtitle, inputMeta.icon, sections.needsMeInput)}
          {renderSection(reviewMeta.label, reviewMeta.subtitle, reviewMeta.icon, sections.needsMeReview)}
          {renderSection(isZh ? "AI 处理中" : "Running", t("board.secRunningSub"), "Cpu", sections.running)}
          {renderSection(
            isZh ? "等待外部" : "Waiting",
            t("board.secWaitingSub"),
            "PauseCircle",
            sections.waitingExternal,
          )}
        </>
      );
    }

    if (tab === "needs_me") {
      if (sections.needsMe.length === 0) {
        return renderEmptyStateForTab();
      }

      const filteredMap: Record<NeedsMeTag, readonly RadarItem[]> = {
        ready_to_archive: sections.needsMeReady,
        decision: sections.needsMeDecision,
        input: sections.needsMeInput,
        review: sections.needsMeReview,
      };

      return (
        <View style={{ gap: 16 }}>
          {renderNeedsMeToolbar()}

          {needsMeFilter === "all" ? (
            <View style={{ gap: 18 }}>
              {renderSection(readyMeta.label, readyMeta.subtitle, readyMeta.icon, sections.needsMeReady)}
              {renderSection(decisionMeta.label, decisionMeta.subtitle, decisionMeta.icon, sections.needsMeDecision)}
              {renderSection(inputMeta.label, inputMeta.subtitle, inputMeta.icon, sections.needsMeInput)}
              {renderSection(reviewMeta.label, reviewMeta.subtitle, reviewMeta.icon, sections.needsMeReview)}
            </View>
          ) : filteredMap[needsMeFilter].length === 0 ? (
            renderEmptyStateForTab()
          ) : (
            <View style={{ gap: 10 }}>
              {(() => {
                const fm = needsMeTagMetaForLocale(needsMeFilter, isZh);
                return renderSection(fm.label, fm.subtitle, fm.icon, filteredMap[needsMeFilter]);
              })()}
            </View>
          )}
        </View>
      );
    }

    const listMap: Record<Exclude<ViewTab, "pool" | "board" | "needs_me" | "insights">, readonly RadarItem[]> = {
      running: sections.running,
      waiting_external: sections.waitingExternal,
      archived: sections.archived,
      hidden: sections.hidden,
    };
    const list = listMap[tab];

    if (list.length === 0) {
      return (
        <View style={{ gap: 10 }}>
          {archivedBanner}
          {renderEmptyStateForTab()}
        </View>
      );
    }
    return (
      <View style={{ gap: 10 }}>
        {archivedBanner}
        {list.map((item) => (
          <View
            key={item.id}
            ref={(node: unknown) => {
              if (node) cardNodeRefs.current.set(item.id, node);
              else cardNodeRefs.current.delete(item.id);
            }}
          >
            <RadarCardView
              item={item}
              projects={data?.projects ?? []}
              highlighted={item.id === focusedCardId}
              hideRedundantStatusPill={hideRedundantStatusPill}
              keyboardFocused={item.id === activeCardId}
              expanded={item.id === expandedCardId}
              onToggleExpand={() => handleToggleCardExpand(item.id)}
              onActivate={() => handleActivateCard(item.id)}
              replyExpandSignal={replySignalTarget?.cardId === item.id ? replySignalTarget.seq : 0}
              pendingArchive={pendingArchiveIds.has(item.id)}
              onRequestArchive={
                item.status !== "archived" && item.visibility === "active"
                  ? () => requestUndoableArchive(item, true)
                  : undefined
              }
              onCancelPendingArchive={() => cancelUndoableArchive(item.id)}
              theme={theme}
              onChanged={refresh}
              onOpenAgent={openAgent}
              coordinationBetaEnabled={Boolean(data?.coordinationBetaEnabled)}
              onOpenCoordBoard={selectCoordCard}
            />
          </View>
        ))}
      </View>
    );
  }

  if (coordCardId) {
    return (
      <CoordBoardScreen
        cardId={coordCardId}
        hostId={host.id}
        theme={theme}
        compact={compact}
        onBack={() => selectCoordCard(null)}
        onOpenAgent={openAgent}
        onChanged={refresh}
      />
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}>
      {!compact && copilotOpen ? (
        <CopilotPane
          key={host.id}
          copilot={data?.copilot ?? null}
          theme={theme}
          onChanged={refresh}
          onOpenAgent={openAgent}
          onCollapse={() => toggleCopilot(false)}
        />
      ) : null}

      {compact ? (
        <Modal
          title={t("copilot.modalTitle")}
          open={compactCopilotModalOpen}
          onOpenChange={(next) => setCompactCopilotModalOpen(next)}
        >
          <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1 }}>
            <CopilotPane
              key={`${host.id}-compact`}
              copilot={data?.copilot ?? null}
              fullWidth
              theme={theme}
              onChanged={refresh}
              onOpenAgent={(id) => {
                setCompactCopilotModalOpen(false);
                openAgent?.(id);
              }}
              onCollapse={() => setCompactCopilotModalOpen(false)}
            />
          </Modal.Content>
        </Modal>
      ) : null}

      <View style={{ flex: 1, minWidth: 0 }}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 10,
            gap: 10,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {compact ? (
              <PillButton
                icon="Sparkles"
                label={t("board.openCopilot")}
                theme={theme}
                onPress={() => setCompactCopilotModalOpen(true)}
              />
            ) : !copilotOpen ? (
              <PillButton
                icon="PanelLeftOpen"
                label={t("board.openCopilot")}
                theme={theme}
                onPress={() => toggleCopilot(true)}
              />
            ) : null}
            <Icon name="Radar" size={18} color={colors.accent} />
            <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "700" }}>{t("board.title")}</Text>
            {multiHost ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Icon name="Server" size={11} color={colors.accent} />
                <Text style={{ color: colors.foreground, fontSize: 11.5, fontWeight: "600" }} numberOfLines={1}>
                  {host.label}
                </Text>
              </View>
            ) : null}
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              {t("board.lastScan", { time: relativeTimeLabel(data?.lastScanAt ?? null, isZh) })}
              {data?.autoScanEnabled === false ? t("board.autoScanOff") : ""}
            </Text>
            {data !== null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: collectorsOpen }}
                onPress={() => setCollectorsOpen((v) => !v)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: collectorsOpen ? colors.accent : collectorStatusSummary.borderColor,
                  backgroundColor: collectorsOpen ? colors.surface2 : colors.surface1,
                }}
              >
                {collectorStatusSummary.spinning ? (
                  <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
                    <ActivityIndicator size="small" color={colors.accent} />
                  </View>
                ) : (
                  <View
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 3.5,
                      backgroundColor: collectorStatusSummary.dotColor,
                    }}
                  />
                )}
                <Text
                  style={{
                    color: collectorsOpen ? colors.foreground : colors.foregroundMuted,
                    fontSize: 12,
                    fontWeight: collectorsOpen ? "600" : "400",
                  }}
                >
                  {collectorStatusSummary.label}
                </Text>
                <Icon
                  name={collectorsOpen ? "ChevronUp" : "ChevronDown"}
                  size={12}
                  color={colors.foregroundMuted}
                />
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            {tab === "pool" && sections.poolAll.length > 0 ? (
              <PillButton
                icon="Play"
                label={
                  batchStarting
                    ? t("board.batchStarting", { count: sections.poolAll.length })
                    : t("board.batchFollowAll", { count: sections.poolAll.length })
                }
                tone="primary"
                disabled={batchStarting}
                theme={theme}
                onPress={() => handleBatchFollowAll(sections.poolAll)}
              />
            ) : null}
            <PillButton
              icon="RefreshCw"
              label={isScanning ? t("board.scanning") : t("board.scanNow")}
              tone={tab === "pool" && sections.poolAll.length > 0 ? "default" : "accent"}
              disabled={isScanning}
              theme={theme}
              onPress={handleScan}
            />
            <PillButton
              icon="Sparkles"
              label={t("board.insights")}
              tone={tab === "insights" ? "primary" : "default"}
              theme={theme}
              onPress={() => selectTab(tab === "insights" ? lastBoardTabRef.current : "insights")}
            />
            <PillButton
              icon="Settings"
              label={t("board.settings")}
              tone="subtle"
              theme={theme}
              onPress={openSettings}
            />
          </View>

          {collectorsOpen ? (
            <View
              style={{
                gap: 8,
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
                  {t("board.collectorsHeader", {
                    enabled: enabledCollectors.length,
                    totalPart:
                      collectors.length > enabledCollectors.length
                        ? isZh
                          ? ` / 共 ${collectors.length}`
                          : `/${collectors.length}`
                        : "",
                    mode:
                      data?.autoScanEnabled === false
                        ? t("board.autoScanDisabled")
                        : t("board.autoScanEvery15m"),
                  })}
                </Text>
                {data?.lastScanDeltaCount !== null && data?.lastScanDeltaCount !== undefined ? (
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                    {data.lastScanDeltaCount > 0
                      ? t("board.deltaTriggered", {
                          count: data.lastScanDeltaCount,
                          triage: data.lastScanTriageTriggered ? t("board.deltaTriggeredSuffix") : "",
                        })
                      : t("board.deltaZero")}
                  </Text>
                ) : null}
                <View style={{ flex: 1 }} />
                {data?.collectorsDir ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      copyText(data.collectorsDir)
                        .then(() => toast.show(t("board.copiedDir"), { variant: "success" }))
                        .catch(() => {});
                    }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      paddingHorizontal: 7,
                      paddingVertical: 3,
                      borderRadius: 5,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.surface0,
                    }}
                  >
                    <Icon name="Copy" size={11} color={colors.foregroundMuted} />
                    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                      {shortenHomePath(data.collectorsDir)}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              {collectors.length === 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{t("board.noCollectors")}</Text>
              ) : (
                <View style={{ gap: 6 }}>
                  {collectors.map((c) => (
                    <CollectorStatusRow key={c.filename} collector={c} theme={theme} onChanged={refresh} />
                  ))}
                </View>
              )}
            </View>
          ) : null}

          {tab !== "insights" ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: hasSearchQuery ? colors.accent : colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Icon
                name="Search"
                size={14}
                color={hasSearchQuery ? colors.accent : colors.foregroundMuted}
              />
              <TextInput
                ref={searchInputRef}
                value={searchQuery}
                onChangeText={(text) => {
                  setSearchQuery(text);
                  if (!text.trim()) setSearchAllTabs(false);
                }}
                onKeyPress={(e) => {
                  const key = (e.nativeEvent as { key?: string } | undefined)?.key;
                  if (key === "Escape") {
                    e.preventDefault?.();
                    if (searchQuery.length > 0) {
                      setSearchQuery("");
                      setSearchAllTabs(false);
                    } else {
                      searchInputRef.current?.blur?.();
                    }
                  }
                }}
                placeholder={t("board.searchPlaceholder")}
                placeholderTextColor={colors.foregroundMuted}
                returnKeyType="search"
                style={{
                  flex: 1,
                  minWidth: 140,
                  color: colors.foreground,
                  fontSize: 12.5,
                  paddingVertical: 2,
                  ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
                }}
              />
              {hasSearchQuery ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                    {t("board.searchMatchCount", { count: filteredItems.length })}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: effectiveSearchAll }}
                    onPress={() => setSearchAllTabs((v) => !v)}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: effectiveSearchAll ? colors.accent : colors.border,
                      backgroundColor: effectiveSearchAll ? colors.surface2 : colors.surface0,
                    }}
                  >
                    <Text
                      style={{
                        color: effectiveSearchAll ? colors.accent : colors.foregroundMuted,
                        fontSize: 11.5,
                        fontWeight: effectiveSearchAll ? "600" : "400",
                      }}
                    >
                      {t("board.searchAllTabs", { count: filteredItems.length })}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("board.searchClear")}
                    onPress={() => {
                      setSearchQuery("");
                      setSearchAllTabs(false);
                    }}
                    style={{
                      padding: 3,
                      borderRadius: 5,
                    }}
                  >
                    <Icon name="X" size={13} color={colors.foregroundMuted} />
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {tabs.map((tabItem) => {
              const selected = !effectiveSearchAll && tab === tabItem.id;
              const dimmed =
                (hasSearchQuery || tabItem.id === "archived" || tabItem.id === "hidden") &&
                tabItem.count === 0 &&
                !selected;
              return (
                <View
                  key={tabItem.id}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                >
                  {tabItem.id === "board" ? (
                    <View
                      style={{
                        width: 1,
                        height: 16,
                        backgroundColor: colors.border,
                        marginHorizontal: 2,
                      }}
                    />
                  ) : null}
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      if (searchAllTabs) setSearchAllTabs(false);
                      selectTab(tabItem.id);
                    }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: selected ? colors.surface2 : "transparent",
                      opacity: dimmed ? 0.48 : 1,
                    }}
                  >
                    <Text
                      style={{
                        color: selected ? colors.foreground : colors.foregroundMuted,
                        fontSize: 12,
                        fontWeight: selected ? "600" : "400",
                      }}
                    >
                      {tabItem.label}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
            {layout.platform === "web" && !compact && tab !== "insights" ? (
              <>
                <View style={{ flex: 1 }} />
                <Text style={{ color: colors.foregroundMuted, fontSize: 11, opacity: 0.72 }}>
                  {t("board.kbdHint")}
                </Text>
              </>
            ) : null}
          </View>

          {data?.modelAlerts && data.modelAlerts.length > 0 ? (
            <View style={{ gap: 6 }}>
              {data.modelAlerts.map((alert) => {
                const isWarning = alert.severity === "warning";
                const toneColor = isWarning ? colors.statusWarning : colors.statusDanger;
                return (
                  <View
                    key={alert.key}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: toneColor,
                      backgroundColor: colors.surface1,
                    }}
                  >
                    <Icon name="AlertTriangle" size={14} color={toneColor} />
                    <Text style={{ flex: 1, minWidth: 180, color: colors.foreground, fontSize: 12, lineHeight: 17 }}>
                      <Text style={{ color: toneColor, fontWeight: "600" }}>
                        {isWarning && alert.fallbackModel
                          ? t("board.modelFallbackTitle", {
                              role: alert.role,
                              model: shortModelName(alert.model),
                              fallback: shortModelName(alert.fallbackModel),
                            })
                          : t("board.modelAlertTitle", {
                              role: alert.role,
                              model: shortModelName(alert.model),
                            })}
                        {alert.count > 1 ? ` ×${alert.count}` : ""}
                      </Text>
                      {alert.cardTitle ? ` · ${alert.cardTitle}` : ""}
                      {`（${relativeTimeLabel(alert.occurredAt, isZh)}）：${alert.message}`}
                    </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {alert.retryable !== false ? (
                      <PillButton
                        icon="RefreshCw"
                        label={
                          retryingAlertKey === alert.key
                            ? t("board.retryingBtn")
                            : t("board.retryBtn")
                        }
                        tone="accent"
                        disabled={retryingAlertKey === alert.key}
                        theme={theme}
                        onPress={() => {
                          if (retryingAlertKey === alert.key) return;
                          setRetryingAlertKey(alert.key);
                          retryAlert({ key: alert.key })
                            .then((res) => {
                              if (res.retried) {
                                toast.show(t("board.retryTriggered"), { variant: "success" });
                              } else {
                                toast.error(res.message || "Retry unavailable");
                              }
                              refresh();
                            })
                            .catch((err: unknown) =>
                              toast.error(err instanceof Error ? err.message : String(err)),
                            )
                            .finally(() => setRetryingAlertKey(null));
                        }}
                      />
                    ) : null}
                    <PillButton
                      icon="Settings"
                      label={t("board.modelSettingsBtn")}
                      tone={isWarning ? "subtle" : "danger"}
                      theme={theme}
                      onPress={openSettings}
                    />
                    <PillButton
                      label={t("board.dismissBtn")}
                      tone="subtle"
                      theme={theme}
                      onPress={() => {
                        void dismissAlert({ key: alert.key }).then(refresh);
                      }}
                    />
                  </View>
                </View>
                );
              })}
            </View>
          ) : null}

          {data?.scanErrors && data.scanErrors.length > 0 ? (
            <View style={{ gap: 6 }}>
              {data.scanErrors.map((errText, idx) => (
                <View
                  key={`${errText}-${idx}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: colors.statusDanger,
                    backgroundColor: colors.surface1,
                  }}
                >
                  <Icon name="AlertTriangle" size={14} color={colors.statusDanger} />
                  <Text
                    style={{
                      flex: 1,
                      minWidth: 180,
                      color: colors.foreground,
                      fontSize: 12,
                      lineHeight: 17,
                    }}
                  >
                    <Text style={{ color: colors.statusDanger, fontWeight: "600" }}>
                      {t("board.scanErrorsPrefix")}
                    </Text>
                    {errText}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <PillButton
                      icon="RefreshCw"
                      label={
                        retryingScanErr === errText ? t("board.retryingBtn") : t("board.retryBtn")
                      }
                      tone="accent"
                      disabled={retryingScanErr === errText}
                      theme={theme}
                      onPress={() => {
                        if (retryingScanErr === errText) return;
                        setRetryingScanErr(errText);
                        retryScanError({ error: errText })
                          .then((res) => {
                            if (res.ok) {
                              toast.show(t("board.retryTriggered"), { variant: "success" });
                            } else {
                              toast.error(res.message || errText);
                            }
                            refresh();
                          })
                          .catch((err: unknown) =>
                            toast.error(err instanceof Error ? err.message : String(err)),
                          )
                          .finally(() => setRetryingScanErr(null));
                      }}
                    />
                    <PillButton
                      label={t("board.dismissBtn")}
                      tone="subtle"
                      theme={theme}
                      onPress={() => {
                        void dismissScanErrors({ error: errText })
                          .then(refresh)
                          .catch((err: unknown) =>
                            toast.error(err instanceof Error ? err.message : String(err)),
                          );
                      }}
                    />
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 36 }}>
          <View
            style={
              tab === "insights"
                ? { gap: 18 }
                : { width: "100%", maxWidth: 1120, alignSelf: "center", gap: 18 }
            }
          >
            {renderTabBody()}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}
