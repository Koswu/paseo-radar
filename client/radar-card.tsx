import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, type PluginIcon, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  buildHeaderLinkGroups,
  resolveFallbackExternalUrl,
  shortUrlPreview,
  shouldShowStaticSourceBadge,
} from "../shared/radar-links";
import {
  cleanCardSubtitleText,
  cleanDecisionProposalFields,
  dedupeSummaryWithTitle,
  stripMachineIdsForDisplay,
} from "../shared/radar-text";
import { radarModelSettings } from "../shared/settings";
import { needsMeTagMetaForLocale, statusLabelForLocale, useRadarI18n } from "./i18n";
import { SearchableModelModal, useAvailableModels } from "./model-picker";
import { openRadarToCoordBoard, setCachedRadarSnapshot } from "./radar-store";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  type TextInput as NativeTextInput,
  View,
} from "react-native";

import {
  archiveRadarCardRpc,
  DEFAULT_GOAL_MAX_TURNS,
  manageRadarCardLinksRpc,
  MAX_GOAL_MAX_TURNS,
  requestWaitExternalRpc,
  dismissRadarItemRpc,
  followRadarItemRpc,
  replyRadarCardRpc,
  restoreRadarItemRpc,
  setRadarGoalRpc,
  snoozeRadarItemRpc,
  toggleRadarCoordRpc,
  updateRadarCardRpc,
  type CardStatus,
  type NeedsMeTag,
  type ProjectOption,
  type RadarItem,
  type RadarLinkKind,
  type SnoozePreset,
} from "../shared/radar";

const GITLAB_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z"/></svg>';

const SLACK_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 15a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2h2zm1 0a2 2 0 0 1 2-2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2a2 2 0 0 1-2-2zm2-8a2 2 0 0 1-2-2a2 2 0 0 1 2-2a2 2 0 0 1 2 2v2zm0 1a2 2 0 0 1 2 2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2a2 2 0 0 1 2-2zm8 2a2 2 0 0 1 2-2a2 2 0 0 1 2 2a2 2 0 0 1-2 2h-2zm-1 0a2 2 0 0 1-2 2a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2a2 2 0 0 1 2 2zm-2 8a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2v-2zm0-1a2 2 0 0 1-2-2a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2a2 2 0 0 1-2 2z"/></svg>';

const LINEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/></svg>';

function sourceOrLinkIcon(kind: string): PluginIcon {
  switch (kind.trim().toLowerCase()) {
    case "gitlab":
      return { svg: GITLAB_SVG };
    case "github":
      return "GitPullRequest";
    case "linear":
      return { svg: LINEAR_SVG };
    case "jira":
      return "CheckSquare";
    case "slack":
      return { svg: SLACK_SVG };
    case "dingtalk":
    case "chat":
      return "MessageCircle";
    case "gmail":
    case "email":
      return "Mail";
    case "incident":
    case "alert":
      return "AlertTriangle";
    case "document":
    case "doc":
      return "FileText";
    case "sentry":
      return "AlertCircle";
    case "workspace":
      return "Terminal";
    default:
      return "Link2";
  }
}

export function VectorIcon({
  icon,
  size,
  color,
}: {
  icon: PluginIcon;
  size: number;
  color: string;
}) {
  return typeof icon === "string" ? (
    <Icon name={icon} size={size} color={color} />
  ) : (
    <Icon icon={icon} size={size} color={color} />
  );
}

function webTooltipProps(tooltip?: string): object {
  return Platform.OS === "web" && tooltip ? ({ title: tooltip } as object) : {};
}

function bindWebTitleRef(tooltip?: string) {
  if (Platform.OS !== "web" || !tooltip) return undefined;
  return (node: unknown) => {
    if (node && typeof (node as { setAttribute?: unknown }).setAttribute === "function") {
      (node as { setAttribute: (k: string, v: string) => void }).setAttribute("title", tooltip);
    }
  };
}

export function shortRelativeTimeLabel(iso: string | null): string {
  if (!iso) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (Number.isNaN(diffSec)) return "";
  if (diffSec < 60) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function shortCronCadence(cron: string | null): string | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hr, dom, mon] = parts as [string, string, string, string, string];
  if (dom === "*" && mon === "*") {
    const stepMin = min.match(/^\*\/(\d+)$/);
    if (stepMin) return `${stepMin[1]}m`;
    if (min === "0" && hr === "*") return "1h";
    const stepHr = hr.match(/^\*\/(\d+)$/) ?? hr.match(/^\d+-\d+\/(\d+)$/);
    if (min === "0" && stepHr) return `${stepHr[1]}h`;
  }
  return null;
}

export function shortModelName(fullModel: string): string {
  const trimmed = fullModel.trim();
  if (!trimmed) return "Auto";
  const tail = trimmed.split("/").pop() ?? trimmed;
  return tail.length > 22 ? `${tail.slice(0, 20)}…` : tail;
}

export function relativeTimeLabel(iso: string | null, isZh = true): string {
  if (!iso) return isZh ? "尚未扫描" : "Never";
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (Number.isNaN(diffSec)) return "";
  if (diffSec < 60) return isZh ? "刚刚" : "just now";
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return isZh ? `${mins} 分钟前` : `${mins}m ago`;
  }
  if (diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    return isZh ? `${hrs} 小时前` : `${hrs}h ago`;
  }
  const days = Math.floor(diffSec / 86400);
  return isZh ? `${days} 天前` : `${days}d ago`;
}

function remainingTimeoutLabel(iso: string | null, isZh = true): string {
  if (!iso) return "";
  const diffSec = Math.floor((Date.parse(iso) - Date.now()) / 1000);
  if (Number.isNaN(diffSec)) return "";
  if (diffSec <= 0) return isZh ? "即将超时" : "timing out soon";
  if (diffSec < 3600) {
    const mins = Math.max(1, Math.ceil(diffSec / 60));
    return isZh ? `${mins} 分钟后超时` : `timeout in ${mins}m`;
  }
  if (diffSec < 86400) {
    const hrs = diffSec / 3600;
    const str =
      Math.abs(hrs - Math.round(hrs)) < 0.08 || hrs >= 10
        ? String(Math.round(hrs))
        : hrs.toFixed(1).replace(/\.0$/, "");
    return isZh ? `${str} 小时后超时` : `timeout in ${str}h`;
  }
  const days = diffSec / 86400;
  const dayStr =
    Math.abs(days - Math.round(days)) < 0.08
      ? String(Math.round(days))
      : days.toFixed(1).replace(/\.0$/, "");
  return isZh ? `${dayStr} 天后超时` : `timeout in ${dayStr}d`;
}

function formatCronHuman(cron: string | null, isZh = true): string {
  if (!cron) return "";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `cron ${cron}`;
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  if (dom === "*" && mon === "*") {
    const stepMin = min.match(/^\*\/(\d+)$/);
    if (stepMin && hr === "*" && dow === "*") {
      return isZh ? `每 ${stepMin[1]} 分钟` : `every ${stepMin[1]}m`;
    }
    if (stepMin && /^\d+-\d+$/.test(hr) && dow === "*") {
      return isZh ? `${hr.replace("-", "–")} 点每 ${stepMin[1]} 分钟` : `every ${stepMin[1]}m (${hr}h)`;
    }
    if (min === "0" && hr === "*" && dow === "*") {
      return isZh ? "每小时" : "hourly";
    }
    const stepHr = hr.match(/^\*\/(\d+)$/);
    if (min === "0" && stepHr && dow === "*") {
      return isZh ? `每 ${stepHr[1]} 小时` : `every ${stepHr[1]}h`;
    }
    const rangeStepHr = hr.match(/^(\d+-\d+)\/(\d+)$/);
    if (min === "0" && rangeStepHr && dow === "*") {
      return isZh
        ? `${rangeStepHr[1]!.replace("-", "–")} 点每 ${rangeStepHr[2]} 小时`
        : `every ${rangeStepHr[2]}h (${rangeStepHr[1]}h)`;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
      const hh = hr.padStart(2, "0");
      const mm = min.padStart(2, "0");
      if (dow === "*") return isZh ? `每天 ${hh}:${mm}` : `daily ${hh}:${mm}`;
      if (dow === "1-5") return isZh ? `工作日 ${hh}:${mm}` : `weekdays ${hh}:${mm}`;
    }
  }
  return `cron ${cron}`;
}

function isBoilerplateWaitNote(note: string | null): boolean {
  if (!note) return true;
  const t = note.trim();
  if (!t) return true;
  return (
    t.startsWith("脚本模式监听中") ||
    t.startsWith("AI 模式监听中") ||
    t.startsWith("已绑定独立评估模型") ||
    t.startsWith("已绑定定时任务") ||
    t.startsWith("已交由 AI 配置定时检查任务")
  );
}

export function cleanCardSubtitle(
  badge: string,
  title: string,
  summary: string,
  projectName?: string | null,
  source?: string,
  hasPrepSummary = false,
  archetype?: RadarItem["archetype"],
): string {
  return cleanCardSubtitleText(badge, title, summary, projectName, source, hasPrepSummary, archetype);
}

function compactOneLine(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function archivedReasonText(source: string, badge: string, isZh = true): string {
  if (!isZh) {
    return `Archived · ${source || badge} source item remains active`;
  }
  switch (source) {
    case "linear":
      return "已归档 · Linear 单据/项目仍活跃（未关单）";
    case "gitlab":
      return "已归档 · GitLab MR 仍活跃（未合入）";
    case "github":
      return "已归档 · GitHub PR/Issue 仍活跃（未关闭）";
    case "slack":
      return "已归档 · Slack 消息仍在回溯窗口内未完结";
    case "custom":
      return "已归档 · 手动添加的自定义事项";
    default:
      return `已归档 · 外部采集源（${source || badge}）仍返回此项`;
  }
}

export interface OneSentenceProgress {
  prefix: string | null;
  prefixIcon?: PluginIcon;
  tone: "success" | "warning" | "accent" | "danger" | "muted";
  text: string;
}

export function progressPrefixColor(
  tone: OneSentenceProgress["tone"],
  theme: PluginTheme,
): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "accent":
      return theme.colors.accent;
    case "danger":
      return theme.colors.statusDanger;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

/**
 * Distills a RadarItem's current state into a single one-sentence progress line
 * so collapsed cards never stack multiple status/goal/summary boxes.
 */
export function buildOneSentenceProgress(item: RadarItem, isZh: boolean): OneSentenceProgress {
  const ws = item.workspace;
  const prep = dedupeSummaryWithTitle(compactOneLine(ws?.prepSummary), item.title);
  const sub = compactOneLine(
    cleanCardSubtitle(item.badge, item.title, item.summary, item.projectName, item.source, Boolean(prep), item.archetype),
  );

  if (item.visibility === "snoozed") {
    const until = item.snoozedUntil ? new Date(item.snoozedUntil).toLocaleString() : "";
    return {
      prefix: null,
      tone: "muted",
      text: until ? (isZh ? `暂缓至 ${until}` : `Snoozed until ${until}`) : sub || (isZh ? "已暂缓" : "Snoozed"),
    };
  }

  if (item.visibility === "dismissed") {
    return {
      prefix: null,
      tone: "muted",
      text: sub || (isZh ? "已手动忽略" : "Dismissed"),
    };
  }

  if (item.status === "archived") {
    const reason = archivedReasonText(item.source, item.badge, isZh).replace(
      /^(?:已归档|Archived)\s*·\s*/i,
      "",
    );
    return {
      prefix: null,
      tone: "muted",
      text: prep || reason,
    };
  }

  if (item.status === "running") {
    const coord = item.coordination;
    if (coord?.enabled && coord.frontlineText) {
      return {
        prefix: null,
        tone: coord.needsCoordinator > 0 ? "warning" : "accent",
        text: coord.frontlineText,
      };
    }
    const prefix = item.goal?.active ? `${item.goal.turnCount}/${item.goal.maxTurns}` : null;
    const prefixIcon = item.goal?.active ? ("Crosshair" as const) : undefined;
    const text =
      prep ||
      compactOneLine(item.goal?.lastEvalNote) ||
      compactOneLine(item.goal?.spec) ||
      sub ||
      (isZh ? "会话正在后台执行任务…" : "Session is actively running…");
    return { prefix, prefixIcon, tone: "accent", text };
  }

  if (item.status === "waiting_external") {
    const coord = item.coordination;
    const prefixIcon =
      item.waitMode === "board"
        ? "GitBranch"
        : item.waitMode
          ? item.waitMode === "ai"
            ? "Sparkles"
            : item.waitMode === "provider"
              ? "Plug"
              : "Terminal"
          : undefined;
    const prefix =
      item.waitMode === "board"
        ? isZh
          ? "看板"
          : "Board"
        : shortCronCadence(item.waitCron);
    if (coord?.enabled && coord.frontlineText) {
      return {
        prefix,
        prefixIcon,
        tone: coord.needsCoordinator > 0 ? "warning" : "muted",
        text: coord.frontlineText,
      };
    }
    const cond =
      compactOneLine(item.waitCondition) ||
      (isZh ? "等待外部完结条件达成后自动唤醒" : "Waiting for external completion");
    const waitNote = isBoilerplateWaitNote(item.waitCheckNote)
      ? ""
      : compactOneLine(item.waitCheckNote);
    const timeout = item.waitTimeoutAt ? remainingTimeoutLabel(item.waitTimeoutAt, isZh) : "";
    const suffix = waitNote ? ` · ${waitNote}` : timeout ? `（${timeout}）` : "";
    return {
      prefix,
      prefixIcon,
      tone: "muted",
      text: `${cond}${suffix}`,
    };
  }

  if (item.status === "needs_me") {
    const coord = item.coordination;
    if (coord?.enabled && coord.frontlineText && !prep) {
      return {
        prefix: null,
        tone: coord.needsCoordinator > 0 ? "warning" : "muted",
        text: coord.frontlineText,
      };
    }
    const proposalTarget = stripMachineIdsForDisplay(item.decisionProposal?.target);
    const proposalHint = item.decisionProposal?.title
      ? compactOneLine(
          `${item.decisionProposal.title}${proposalTarget ? `（${proposalTarget}）` : ""}`,
        )
      : "";
    const text =
      prep ||
      proposalHint ||
      (ws?.summarizing
        ? isZh
          ? "正在提炼最新回复进度…"
          : "Summarizing latest reply…"
        : "") ||
      sub ||
      (isZh ? "本轮已完成，待确认下一步" : "Turn finished; awaiting your next step");
    const maxTurnsPaused = item.goal && !item.goal.active && item.goal.stopReason === "max_turns";
    return {
      prefix: maxTurnsPaused ? `${item.goal!.turnCount}/${item.goal!.maxTurns}` : null,
      prefixIcon: maxTurnsPaused ? "Crosshair" : undefined,
      tone: maxTurnsPaused ? "warning" : "muted",
      text,
    };
  }

  // Pool (not started yet)
  return {
    prefix: null,
    tone: "muted",
    text: sub || item.projectName || item.badge || (isZh ? "待启动跟进" : "Ready to start"),
  };
}

export function needsMeTagColor(tag: NeedsMeTag, theme: PluginTheme): string {
  switch (tag) {
    case "ready_to_archive":
      return theme.colors.statusSuccess;
    case "decision":
      return theme.colors.statusWarning;
    case "input":
      return theme.colors.accent;
    case "review":
      return theme.colors.foregroundMuted;
  }
}

export function statusColor(status: CardStatus, theme: PluginTheme): string {
  switch (status) {
    case "running":
      return theme.colors.accent;
    case "needs_me":
      return theme.colors.statusWarning;
    case "waiting_external":
      return theme.colors.foregroundMuted;
    case "pool":
      return theme.colors.foregroundMuted;
    case "archived":
      return theme.colors.foregroundMuted;
  }
}

export function PillButton({
  icon,
  label,
  tooltip,
  tone = "default",
  disabled = false,
  theme,
  onPress,
}: {
  icon?: PluginIcon;
  label: string;
  tooltip?: string;
  tone?: "default" | "primary" | "accent" | "danger" | "subtle";
  disabled?: boolean;
  theme: PluginTheme;
  onPress: () => void;
}) {
  const { colors } = theme;
  const fg =
    tone === "primary"
      ? colors.accentForeground
      : tone === "danger"
        ? colors.statusDanger
        : tone === "subtle"
          ? colors.foregroundMuted
          : colors.foreground;
  const bg =
    tone === "primary"
      ? colors.accent
      : tone === "accent"
        ? colors.surface2
        : tone === "subtle"
          ? "transparent"
          : colors.surface1;
  const border =
    tone === "primary" ? colors.accent : tone === "danger" ? colors.statusDanger : colors.border;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tooltip ?? label}
      disabled={disabled}
      onPress={onPress}
      {...webTooltipProps(tooltip)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 7,
        borderWidth: tone === "subtle" ? 0 : 1,
        borderColor: border,
        backgroundColor: bg,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? <VectorIcon icon={icon} size={13} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 12, fontWeight: tone === "accent" || tone === "primary" ? "600" : "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function IconPillButton({
  icon,
  label,
  tooltip,
  tipAlign = "left",
  tone = "default",
  disabled = false,
  theme,
  onPress,
}: {
  icon: PluginIcon;
  label: string;
  tooltip?: string;
  tipAlign?: "left" | "right";
  tone?: "default" | "primary" | "accent" | "danger" | "subtle";
  disabled?: boolean;
  theme: PluginTheme;
  onPress: () => void;
}) {
  const { colors } = theme;
  const [hovered, setHovered] = useState(false);
  const tipText = tooltip ?? label;
  const fg =
    tone === "primary"
      ? colors.accentForeground
      : tone === "danger"
        ? colors.statusDanger
        : tone === "accent"
          ? colors.accent
          : colors.foregroundMuted;
  const bg =
    tone === "primary"
      ? colors.accent
      : tone === "accent"
        ? colors.surface2
        : tone === "subtle"
          ? "transparent"
          : colors.surface1;
  const border =
    tone === "primary" || tone === "accent"
      ? colors.accent
      : tone === "danger"
        ? colors.statusDanger
        : colors.border;

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        ref={bindWebTitleRef(tipText)}
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        {...webTooltipProps(tipText)}
        style={{
          width: tone === "subtle" ? 26 : 28,
          height: tone === "subtle" ? 26 : 28,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 7,
          borderWidth: tone === "subtle" ? 0 : 1,
          borderColor: border,
          backgroundColor: bg,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <VectorIcon icon={icon} size={tone === "subtle" ? 14 : 13} color={fg} />
      </Pressable>
      {hovered && tipText ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: "100%",
            ...(tipAlign === "right" ? { right: 0 } : { left: 0 }),
            marginBottom: 4,
            zIndex: 50,
            paddingHorizontal: 7,
            paddingVertical: 3,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface2,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              color: colors.foreground,
              fontSize: 11,
              fontWeight: "500",
              ...(Platform.OS === "web" ? ({ whiteSpace: "nowrap" } as object) : {}),
            }}
          >
            {tipText}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export interface CardActionDescriptor {
  key: string;
  icon?: PluginIcon;
  label: string;
  tooltip?: string;
  tone?: "default" | "primary" | "accent" | "danger" | "subtle";
  disabled?: boolean;
  onPress: () => void;
}

export function RadarCardView({
  item,
  projects,
  currentAgentId = null,
  highlighted = false,
  compactMode = false,
  hideRedundantStatusPill = false,
  keyboardFocused = false,
  expanded,
  onToggleExpand,
  onActivate,
  replyExpandSignal = 0,
  selectable = false,
  selected = false,
  onToggleSelect,
  pendingArchive = false,
  onRequestArchive,
  onCancelPendingArchive,
  theme,
  onChanged,
  onOpenAgent,
  onLocateInRadar,
  coordinationBetaEnabled = false,
  onOpenCoordBoard = null,
}: {
  item: RadarItem;
  projects: readonly ProjectOption[];
  currentAgentId?: string | null;
  highlighted?: boolean;
  compactMode?: boolean;
  hideRedundantStatusPill?: boolean;
  keyboardFocused?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onActivate?: () => void;
  replyExpandSignal?: number;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  pendingArchive?: boolean;
  onRequestArchive?: () => void;
  onCancelPendingArchive?: () => void;
  theme: PluginTheme;
  onChanged: () => void;
  onOpenAgent: ((agentId: string) => void) | null;
  onLocateInRadar?: (() => void) | null;
  coordinationBetaEnabled?: boolean;
  onOpenCoordBoard?: ((cardId: string) => void) | null;
}) {
  const paseo = usePaseo();
  const follow = useRpc(followRadarItemRpc);
  const updateCard = useRpc(updateRadarCardRpc);
  const setGoalRpc = useRpc(setRadarGoalRpc);
  const toggleCoord = useRpc(toggleRadarCoordRpc);
  const manageLinks = useRpc(manageRadarCardLinksRpc);
  const archiveCard = useRpc(archiveRadarCardRpc);
  const replyCard = useRpc(replyRadarCardRpc);
  const requestWait = useRpc(requestWaitExternalRpc);
  const snooze = useRpc(snoozeRadarItemRpc);
  const dismiss = useRpc(dismissRadarItemRpc);
  const restore = useRpc(restoreRadarItemRpc);
  const toast = useToast();
  const { isZh, t } = useRadarI18n();

  const [busy, setBusy] = useState(false);
  const [internalMoreOpen, setInternalMoreOpen] = useState(false);
  const moreOpen = expanded !== undefined ? expanded : internalMoreOpen;
  const modelSettings = useSettings(radarModelSettings);
  const { choices: allModels } = useAvailableModels();
  const [picker, setPicker] = useState<
    | "model"
    | "project"
    | "snooze"
    | "confirm_archive"
    | "set_wait"
    | "tag"
    | "links"
    | "link_select"
    | "goal"
    | "reply"
    | "note"
    | null
  >(null);
  const [linkSelectKind, setLinkSelectKind] = useState<RadarLinkKind | null>(null);
  const [hoveredHeaderTip, setHoveredHeaderTip] = useState<string | null>(null);
  const [modelModalTarget, setModelModalTarget] = useState<{
    open: boolean;
    agentId?: string;
    currentModel: string;
  }>({
    open: false,
    currentModel: item.selectedModel,
  });
  const [note, setNote] = useState("");
  const [quickReply, setQuickReply] = useState("");
  const [replyTargetId, setReplyTargetId] = useState<string | undefined>(undefined);
  const [replying, setReplying] = useState(false);
  const [waitDraft, setWaitDraft] = useState(item.waitCondition ?? "");
  const replyInputRef = useRef<NativeTextInput | null>(null);
  const prevReplySignalRef = useRef(replyExpandSignal);
  const prevMoreOpenRef = useRef(moreOpen);
  const prevFocusedRef = useRef(keyboardFocused);
  const [linkUrlDraft, setLinkUrlDraft] = useState("");
  const [linkLabelDraft, setLinkLabelDraft] = useState("");
  const [goalSpecDraft, setGoalSpecDraft] = useState(item.goal?.spec ?? "");
  const [goalVerifyDraft, setGoalVerifyDraft] = useState(item.goal?.verifyCommand ?? "");
  const [goalMaxTurnsDraft, setGoalMaxTurnsDraft] = useState(
    String(item.goal?.maxTurns ?? DEFAULT_GOAL_MAX_TURNS),
  );

  const { colors } = theme;
  const ws = item.workspace;
  const sessions = ws?.sessions ?? [];
  const multiSession = sessions.length > 1;
  const hasConversation = ws !== null && ws.primaryAgentId !== null;
  const isReadyToArchive = item.status === "needs_me" && item.needsMeTag === "ready_to_archive";
  const decisionProposal =
    item.visibility === "active" && item.status === "needs_me" && item.needsMeTag === "decision"
      ? item.decisionProposal
      : null;
  const displayProposal = decisionProposal
    ? cleanDecisionProposalFields(decisionProposal.target, decisionProposal.impact)
    : { target: null, impact: null };
  const hasDecisionDraft = Boolean(decisionProposal?.draft && decisionProposal.draft.trim() !== "");
  const proposalSig = decisionProposal
    ? `${decisionProposal.updatedAt ?? ""}:${decisionProposal.draft ?? ""}`
    : "";
  const [syncedProposalSig, setSyncedProposalSig] = useState(proposalSig);
  const [editedDraft, setEditedDraft] = useState(decisionProposal?.draft ?? "");
  const [draftRejectNote, setDraftRejectNote] = useState("");
  const [draftModalOpen, setDraftModalOpen] = useState(false);

  if (syncedProposalSig !== proposalSig) {
    setSyncedProposalSig(proposalSig);
    setEditedDraft(decisionProposal?.draft ?? "");
    setDraftRejectNote("");
    if (!proposalSig) {
      setDraftModalOpen(false);
    }
  }
  const isDraftEdited = hasDecisionDraft && editedDraft !== (decisionProposal?.draft ?? "");
  const validCurrentAgentId =
    currentAgentId && sessions.some((s) => s.id === currentAgentId) ? currentAgentId : undefined;
  const validExplicitReplyId =
    replyTargetId && sessions.some((s) => s.id === replyTargetId) ? replyTargetId : undefined;
  const validProposalAgentId =
    decisionProposal?.agentId && sessions.some((s) => s.id === decisionProposal.agentId)
      ? decisionProposal.agentId
      : undefined;
  const validGoalAgentId =
    item.goal?.agentId && sessions.some((s) => s.id === item.goal!.agentId)
      ? item.goal.agentId
      : undefined;
  const defaultTargetAgentId =
    validExplicitReplyId ?? validCurrentAgentId ?? ws?.primaryAgentId ?? undefined;
  const effectiveLinks = item.links ?? [];
  const primaryExternalUrl = effectiveLinks[0]?.url ?? item.url ?? null;
  const primaryExternalLabel =
    effectiveLinks[0]?.label || (isZh ? "打开原链接" : "Open Link");
  const fallbackExternalUrl = resolveFallbackExternalUrl(item.url, effectiveLinks);
  const fallbackExternalLabel = isZh ? "打开原链接" : "Open Link";
  const canEditLinks = item.visibility === "active" && item.status !== "archived";

  function focusReplyInput(): void {
    if (Platform.OS === "web") {
      requestAnimationFrame(() => {
        replyInputRef.current?.focus();
      });
    } else {
      setTimeout(() => {
        replyInputRef.current?.focus();
      }, 20);
    }
  }

  useEffect(() => {
    if (
      replyExpandSignal > 0 &&
      replyExpandSignal !== prevReplySignalRef.current &&
      item.status === "needs_me" &&
      hasConversation
    ) {
      setLinkSelectKind(null);
      setPicker("reply");
      focusReplyInput();
    }
    prevReplySignalRef.current = replyExpandSignal;
  }, [replyExpandSignal, item.status, hasConversation]);

  useEffect(() => {
    if (prevMoreOpenRef.current && !moreOpen && picker === "model") {
      setPicker(null);
    }
    prevMoreOpenRef.current = moreOpen;
  }, [moreOpen, picker]);

  useEffect(() => {
    if (prevFocusedRef.current && !keyboardFocused) {
      setPicker(null);
      setLinkSelectKind(null);
      setDraftModalOpen(false);
    }
    prevFocusedRef.current = keyboardFocused;
  }, [keyboardFocused]);

  function toggleMore(): void {
    if (onToggleExpand) {
      onToggleExpand();
    } else {
      setInternalMoreOpen((prev) => !prev);
    }
  }

  function togglePicker(
    target: "model" | "project" | "snooze" | "confirm_archive" | "set_wait" | "tag" | "links" | "goal" | "reply" | "note",
  ): void {
    const opening = picker !== target;
    if (opening && target === "goal") {
      setGoalSpecDraft(item.goal?.spec ?? "");
      setGoalVerifyDraft(item.goal?.verifyCommand ?? "");
      setGoalMaxTurnsDraft(String(item.goal?.maxTurns ?? DEFAULT_GOAL_MAX_TURNS));
    }
    if (opening && target === "set_wait") {
      setWaitDraft(item.waitCondition ?? "");
    }
    if (opening && target === "reply") {
      focusReplyInput();
    }
    setLinkSelectKind(null);
    setPicker((cur) => (cur === target ? null : target));
  }

  function toggleLinkSelectKind(kind: RadarLinkKind): void {
    if (picker === "link_select" && linkSelectKind === kind) {
      setPicker(null);
      setLinkSelectKind(null);
      return;
    }
    setLinkSelectKind(kind);
    setPicker("link_select");
  }

  function handleGoalAction(
    action: "set" | "stop" | "resume" | "clear",
    steerNow = true,
  ): void {
    if (busy) return;
    const parsedMax = Number(goalMaxTurnsDraft.trim());
    const maxTurns =
      Number.isInteger(parsedMax) && parsedMax >= 1
        ? Math.min(MAX_GOAL_MAX_TURNS, parsedMax)
        : DEFAULT_GOAL_MAX_TURNS;
    const goalTargetAgentId =
      action === "resume"
        ? (validExplicitReplyId ?? validGoalAgentId ?? validCurrentAgentId ?? ws?.primaryAgentId ?? undefined)
        : (validExplicitReplyId ?? validCurrentAgentId ?? validGoalAgentId ?? ws?.primaryAgentId ?? undefined);

    setBusy(true);
    setGoalRpc({
      itemId: item.id,
      ...(ws?.workspaceId ? { workspaceId: ws.workspaceId } : {}),
      ...(goalTargetAgentId ? { agentId: goalTargetAgentId } : {}),
      action,
      ...(action === "set"
        ? {
            spec: goalSpecDraft.trim(),
            verifyCommand: goalVerifyDraft.trim() || null,
            maxTurns,
          }
        : action === "resume"
          ? { maxTurns }
          : {}),
      steerNow,
    })
      .then((res) => {
        setCachedRadarSnapshot(paseo, res.snapshot);
        setPicker(null);
        const msg =
          action === "stop"
            ? isZh
              ? "已暂停目标模式"
              : "Goal mode paused"
            : action === "clear"
              ? isZh
                ? "已清除目标标识"
                : "Goal cleared"
              : res.goal?.autoRefined
                ? steerNow
                  ? isZh
                    ? "AI 已完善目标并开启推进"
                    : "AI refined goal & started"
                  : isZh
                    ? "AI 已生成并保存目标"
                    : "AI generated & saved goal"
                : steerNow
                  ? isZh
                    ? "已开启目标模式并推进会话"
                    : "Goal mode active; steering session"
                  : isZh
                    ? "已保存卡片目标"
                    : "Saved card goal";
        toast.show(msg, { variant: action === "stop" || action === "clear" ? "info" : "success" });
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleFollow(mode: "background" | "immediate"): void {
    if (busy) return;
    setBusy(true);
    follow({ itemId: item.id, mode, note })
      .then((res) => {
        setNote("");
        setPicker(null);
        onChanged();
        if (mode === "immediate" && onOpenAgent) {
          onOpenAgent(res.agentId);
        } else {
          toast.show(
            isZh
              ? "已启动后台跟进，完成后将转入「待我处理」"
              : "Background follow-up started; will move to Needs Me when done",
            { variant: "success" },
          );
        }
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleUpdate(patch: {
    targetAgentId?: string;
    selectedModel?: string;
    projectId?: string;
    status?: CardStatus;
    needsMeTag?: NeedsMeTag | null;
  }): void {
    if (busy) return;
    const resolvedTarget =
      patch.targetAgentId ??
      (patch.needsMeTag !== undefined ? defaultTargetAgentId : undefined);
    setBusy(true);
    updateCard({
      itemId: item.id,
      ...(resolvedTarget ? { targetAgentId: resolvedTarget } : {}),
      ...patch,
    })
      .then(() => {
        setPicker(null);
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleToggleCoord(enabled: boolean): void {
    if (busy) return;
    setBusy(true);
    toggleCoord({ itemId: item.id, enabled, steerNow: enabled })
      .then((res) => {
        setCachedRadarSnapshot(paseo, res.snapshot);
        setPicker(null);
        onChanged();
        if (enabled) {
          toast.show(isZh ? "已开启协调模式 (Beta)" : "Coordination Mode enabled", {
            variant: "success",
          });
          onOpenCoordBoard?.(item.id);
        } else {
          toast.show(isZh ? "已退出协调模式" : "Coordination Mode exited", { variant: "success" });
        }
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleAddLink(): void {
    const url = linkUrlDraft.trim();
    if (!url || busy) return;
    const label = linkLabelDraft.trim();
    setBusy(true);
    manageLinks({
      itemId: item.id,
      add: [{ url, ...(label ? { label } : {}) }],
    })
      .then(() => {
        setLinkUrlDraft("");
        setLinkLabelDraft("");
        toast.show(isZh ? "已挂载关联链接" : "Attached link", { variant: "success" });
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleRemoveLink(url: string, label: string): void {
    if (busy) return;
    setBusy(true);
    manageLinks({
      itemId: item.id,
      removeUrls: [url],
    })
      .then(() => {
        toast.show(
          isZh ? `已解除关联「${label}」` : `Detached "${label}"`,
          { variant: "info" },
        );
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleQuickReply(defaultMessage?: string): void {
    const text = defaultMessage ?? quickReply.trim();
    if (!text || replying || busy) return;
    const chosenAgentId = defaultTargetAgentId;
    setReplying(true);
    if (!defaultMessage) setQuickReply("");
    replyCard({
      itemId: item.id,
      ...(chosenAgentId ? { agentId: chosenAgentId } : {}),
      text,
    })
      .then(() => {
        setPicker(null);
        toast.show(
          isZh ? "已发送回复，会话已在后台继续处理" : "Reply sent; session continuing in background",
          { variant: "success" },
        );
        onChanged();
      })
      .catch((err: unknown) => {
        if (!defaultMessage) setQuickReply((cur) => (cur === "" ? text : cur));
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setReplying(false));
  }

  function handleConfirmDecision(): void {
    if (replying || busy) return;
    if (hasDecisionDraft && editedDraft.trim() === "") {
      toast.error(
        isZh
          ? "确认草稿不能为空；若不执行请在回复框说明调整意见"
          : "Draft cannot be empty; enter feedback to revise instead",
      );
      return;
    }
    const chosenAgentId =
      validExplicitReplyId ??
      validProposalAgentId ??
      validCurrentAgentId ??
      ws?.primaryAgentId ??
      undefined;
    const extraNote = quickReply.trim();
    setReplying(true);
    if (extraNote) setQuickReply("");
    replyCard({
      itemId: item.id,
      ...(chosenAgentId ? { agentId: chosenAgentId } : {}),
      text: extraNote,
      decisionApproval: {
        edited: isDraftEdited,
        title: decisionProposal?.title ?? null,
        target: decisionProposal?.target ?? null,
        draft: hasDecisionDraft ? editedDraft : null,
      },
    })
      .then(() => {
        setDraftModalOpen(false);
        setPicker(null);
        toast.show(
          hasDecisionDraft
            ? isDraftEdited
              ? isZh
                ? "已按修改后的终稿发送执行"
                : "Approved edited draft & running"
              : isZh
                ? "已确认草稿并发送执行"
                : "Approved draft & running"
            : isZh
              ? "已确认授权，会话正在后台执行"
              : "Approved; session running in background",
          { variant: "success" },
        );
        onChanged();
      })
      .catch((err: unknown) => {
        if (extraNote) setQuickReply((cur) => (cur === "" ? extraNote : cur));
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setReplying(false));
  }

  function handleRejectDecision(): void {
    const noteText = draftRejectNote.trim();
    if (!noteText || replying || busy) return;
    const chosenAgentId =
      validExplicitReplyId ??
      validProposalAgentId ??
      validCurrentAgentId ??
      ws?.primaryAgentId ??
      undefined;
    setReplying(true);
    setDraftRejectNote("");
    replyCard({
      itemId: item.id,
      ...(chosenAgentId ? { agentId: chosenAgentId } : {}),
      text: isZh
        ? `取消本次草稿执行，请按以下修改意见调整：\n${noteText}`
        : `Cancel executing this draft and revise with the following feedback:\n${noteText}`,
    })
      .then(() => {
        setDraftModalOpen(false);
        setPicker(null);
        toast.show(
          isZh ? "已取消执行并将修改意见发给会话" : "Cancelled draft & sent feedback to session",
          { variant: "info" },
        );
        onChanged();
      })
      .catch((err: unknown) => {
        setDraftRejectNote((cur) => (cur === "" ? noteText : cur));
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setReplying(false));
  }

  function handleSubmitWaitExternal(): void {
    const noteText = waitDraft.trim();
    if (!noteText || busy) return;
    setBusy(true);
    requestWait({
      itemId: item.id,
      ...(defaultTargetAgentId ? { agentId: defaultTargetAgentId } : {}),
      note: noteText,
    })
      .then(() => {
        setPicker(null);
        toast.show(
          isZh
            ? "已提交至会话核验完结条件；条件明确可检时转入「等待外部」，否则将提示补充信息"
            : "Submitted to session to verify wait condition",
          { variant: "info" },
        );
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleArchive(): void {
    if (busy) return;
    setBusy(true);
    archiveCard({ itemId: item.id })
      .then(() => {
        setPicker(null);
        toast.show(isZh ? "已同步归档工作区对话与卡片" : "Archived card & workspace", {
          variant: "success",
        });
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function triggerArchiveAction(): void {
    if (isReadyToArchive) {
      if (onRequestArchive) onRequestArchive();
      else handleArchive();
      return;
    }
    if (onRequestArchive) {
      onRequestArchive();
    } else {
      togglePicker("confirm_archive");
    }
  }

  function handleSnooze(preset: SnoozePreset): void {
    if (busy) return;
    setBusy(true);
    snooze({ itemId: item.id, preset })
      .then(() => {
        setPicker(null);
        toast.show(isZh ? "已暂缓并隐藏卡片" : "Snoozed item", { variant: "info" });
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleDismiss(): void {
    if (busy) return;
    setBusy(true);
    dismiss({ itemId: item.id })
      .then(() => {
        toast.show(isZh ? "已忽略该事项" : "Dismissed item", { variant: "default" });
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleRestore(): void {
    if (busy) return;
    setBusy(true);
    restore({ itemId: item.id })
      .then(() => {
        toast.show(isZh ? "已恢复" : "Restored", { variant: "success" });
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  if (pendingArchive) {
    return (
      <View
        style={{
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: keyboardFocused ? colors.accent : colors.border,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: colors.surface0,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Icon name="Archive" size={13} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12 }}>
          {isZh ? `已加入归档队列：${item.title}` : `Archiving: ${item.title}`}
        </Text>
        <PillButton
          icon="RotateCcw"
          label={isZh ? "撤销" : "Undo"}
          tone="default"
          theme={theme}
          onPress={() => onCancelPendingArchive?.()}
        />
      </View>
    );
  }

  const progress = buildOneSentenceProgress(item, isZh);
  const isAlertBadge = item.source === "incident" || item.source === "alert";
  const isWorkspaceBadge = item.source === "workspace";
  const subtitle = cleanCardSubtitle(
    item.badge,
    item.title,
    item.summary,
    item.projectName,
    item.source,
    Boolean(ws?.prepSummary),
    item.archetype,
  );

  // Build ordered action list: [0] Primary Action (labeled), [1..maxInlineSecondary] Icon Actions, [..] Overflow in "More"
  const orderedActions: CardActionDescriptor[] = [];
  let maxInlineSecondary = 1;

  if (item.visibility !== "active" || item.status === "archived") {
    orderedActions.push({
      key: "restore",
      icon: "RotateCcw",
      label: isZh ? "恢复" : "Restore",
      tone: "primary",
      disabled: busy,
      onPress: handleRestore,
    });
    if (primaryExternalUrl) {
      orderedActions.push({
        key: "open_ext",
        icon: "ExternalLink",
        label: primaryExternalLabel,
        tone: "default",
        onPress: () => {
          void openExternalUrl(primaryExternalUrl);
        },
      });
    }
  } else if (!hasConversation) {
    // Pool card: Primary = Follow in BG, Icon Actions = Open Session / Snooze / Dismiss
    maxInlineSecondary = compactMode ? 2 : 3;
    orderedActions.push({
      key: "follow_bg",
      icon: "Play",
      label: isZh ? "后台跟进" : "Follow in BG",
      tone: "primary",
      disabled: busy,
      onPress: () => handleFollow("background"),
    });
    orderedActions.push({
      key: "follow_open",
      icon: "ArrowUpRight",
      label: isZh ? "开会话处理" : "Open Session",
      tone: "default",
      disabled: busy,
      onPress: () => handleFollow("immediate"),
    });
    orderedActions.push({
      key: "snooze",
      icon: "Clock",
      label: isZh ? "暂缓" : "Snooze",
      tone: picker === "snooze" ? "accent" : "default",
      disabled: busy,
      onPress: () => togglePicker("snooze"),
    });
    orderedActions.push({
      key: "dismiss",
      icon: "Trash2",
      label: isZh ? "忽略" : "Dismiss",
      tone: "subtle",
      disabled: busy,
      onPress: handleDismiss,
    });
    orderedActions.push({
      key: "note",
      icon: "MessageSquarePlus",
      label: picker === "note" ? (isZh ? "收起说明" : "Hide Note") : isZh ? "补充说明" : "Add Note",
      tone: picker === "note" ? "accent" : "default",
      disabled: busy,
      onPress: () => togglePicker("note"),
    });
    orderedActions.push({
      key: "goal",
      icon: "Crosshair",
      label: item.goal ? (isZh ? "编辑目标" : "Edit Goal") : isZh ? "目标模式" : "Set Goal",
      tone: picker === "goal" ? "accent" : "default",
      disabled: busy,
      onPress: () => togglePicker("goal"),
    });
    if (fallbackExternalUrl) {
      orderedActions.push({
        key: "open_ext",
        icon: "ExternalLink",
        label: fallbackExternalLabel,
        tone: "default",
        onPress: () => {
          void openExternalUrl(fallbackExternalUrl);
        },
      });
    }
  } else {
    // Active card WITH conversation
    const openSessionAction: CardActionDescriptor | null =
      onOpenAgent && defaultTargetAgentId
        ? {
            key: "open_session",
            icon: "ArrowUpRight",
            label: isZh ? "进入会话" : "Open Session",
            disabled: busy,
            onPress: () => onOpenAgent(defaultTargetAgentId),
          }
        : null;

    const replyAction: CardActionDescriptor = {
      key: "reply",
      icon: "MessageSquarePlus",
      label:
        picker === "reply"
          ? isZh
            ? "收起回复"
            : "Hide Reply"
          : item.needsMeTag === "input"
            ? isZh
              ? "补充回复"
              : "Reply"
            : item.needsMeTag === "decision"
              ? isZh
                ? "取消并给出修改意见"
                : "Cancel & give feedback"
              : isZh
                ? "快捷回复"
                : "Reply",
      tone: picker === "reply" ? "accent" : "default",
      disabled: busy,
      onPress: () => togglePicker("reply"),
    };

    const waitAction: CardActionDescriptor | null =
      item.status === "running"
        ? null
        : item.status === "waiting_external"
          ? {
              key: "wake_needs_me",
              icon: "UserCheck",
              label: isZh ? "切回待我处理" : "Back to Needs Me",
              disabled: busy,
              onPress: () => handleUpdate({ status: "needs_me" }),
            }
          : {
              key: "set_wait",
              icon: "PauseCircle",
              label: isZh ? "转为等待外部" : "Wait External",
              tone: picker === "set_wait" ? "accent" : "default",
              disabled: busy,
              onPress: () => togglePicker("set_wait"),
            };

    const goalAction: CardActionDescriptor =
      item.status === "running" && item.goal?.active
        ? {
            key: "pause_goal",
            icon: "PauseCircle",
            label: isZh ? "暂停目标" : "Pause Goal",
            disabled: busy,
            onPress: () => handleGoalAction("stop", false),
          }
        : {
            key: "goal",
            icon: "Crosshair",
            label: item.goal ? (isZh ? "管理目标" : "Goal") : isZh ? "目标模式" : "Set Goal",
            tone: picker === "goal" ? "accent" : "default",
            disabled: busy,
            onPress: () => togglePicker("goal"),
          };

    const locateAction: CardActionDescriptor | null = onLocateInRadar
      ? {
          key: "locate",
          icon: "ArrowUpRight",
          label: isZh ? "在 Radar 中定位" : "Locate in Radar",
          onPress: onLocateInRadar,
        }
      : null;

    const archiveAction: CardActionDescriptor = {
      key: "archive",
      icon: "Archive",
      label: isZh ? "归档" : "Archive",
      disabled: busy,
      onPress: triggerArchiveAction,
    };

    const pushedKeys = new Set<string>();
    const pushUnique = (act: CardActionDescriptor | null, overrideTone?: CardActionDescriptor["tone"]) => {
      if (!act || pushedKeys.has(act.key)) return;
      pushedKeys.add(act.key);
      orderedActions.push(overrideTone ? { ...act, tone: overrideTone } : act);
    };

    if (isReadyToArchive) {
      maxInlineSecondary = 3;
      pushUnique(archiveAction, "primary");
      pushUnique(openSessionAction, "default");
      pushUnique(replyAction);
      pushUnique(waitAction);
      pushUnique(goalAction);
      pushUnique(locateAction);
    } else if (item.status === "needs_me" && item.needsMeTag === "decision") {
      maxInlineSecondary = 3;
      const approveAction: CardActionDescriptor = {
        key: "approve_decision",
        icon: "Check",
        label: replying
          ? isZh
            ? "发送中…"
            : "Sending…"
          : hasDecisionDraft
            ? isDraftEdited
              ? isZh
                ? "按修改稿执行"
                : "Run Edited Draft"
              : isZh
                ? "直接确认执行"
                : "Approve & Run"
            : isZh
              ? "授权执行"
              : "Approve & Run",
        disabled: busy || replying || (hasDecisionDraft && editedDraft.trim() === ""),
        onPress: handleConfirmDecision,
      };
      if (hasDecisionDraft) {
        pushUnique(
          {
            key: "review_draft",
            icon: "Eye",
            label: isZh ? "审阅草稿" : "Review Draft",
            disabled: replying,
            onPress: () => setDraftModalOpen(true),
          },
          "primary",
        );
        pushUnique(replyAction);
        pushUnique(openSessionAction, "default");
        pushUnique(waitAction);
        pushUnique(approveAction);
      } else {
        pushUnique(approveAction, "primary");
        pushUnique(replyAction);
        pushUnique(openSessionAction, "default");
        pushUnique(waitAction);
      }
      pushUnique(goalAction);
      pushUnique(locateAction);
      pushUnique(archiveAction);
    } else if (item.status === "needs_me" && item.needsMeTag === "input") {
      maxInlineSecondary = 2;
      pushUnique(replyAction, "primary");
      pushUnique(openSessionAction, "default");
      pushUnique(waitAction);
      pushUnique(locateAction);
      pushUnique(goalAction);
      pushUnique(archiveAction);
    } else if (item.status === "waiting_external") {
      maxInlineSecondary = 1;
      pushUnique(openSessionAction, "primary");
      pushUnique(waitAction, orderedActions.length === 0 ? "primary" : "default");
      pushUnique(locateAction);
      pushUnique(goalAction);
      pushUnique(archiveAction);
    } else if (item.status === "running") {
      maxInlineSecondary = 1;
      pushUnique(openSessionAction, "primary");
      pushUnique(goalAction, orderedActions.length === 0 ? "primary" : "default");
      pushUnique(locateAction);
      pushUnique(archiveAction);
    } else {
      // needs_me: review or untagged
      maxInlineSecondary = 3;
      pushUnique(openSessionAction, "primary");
      pushUnique(replyAction, orderedActions.length === 0 ? "primary" : "default");
      pushUnique(archiveAction);
      pushUnique(waitAction);
      pushUnique(goalAction);
      pushUnique(locateAction);
    }

    if (fallbackExternalUrl) {
      pushUnique({
        key: "open_ext",
        icon: "ExternalLink",
        label: fallbackExternalLabel,
        onPress: () => {
          void openExternalUrl(fallbackExternalUrl);
        },
      });
    }
  }

  if (item.visibility === "active" && item.status !== "archived") {
    if (item.coordination?.enabled) {
      orderedActions.push({
        key: "open_coord",
        icon: "GitBranch",
        label: t("coord.openBoardBtn"),
        tone: "default",
        disabled: busy,
        onPress: () => {
          if (onOpenCoordBoard) onOpenCoordBoard(item.id);
          else openRadarToCoordBoard(paseo, item.id);
        },
      });
    } else if (coordinationBetaEnabled && item.workspace) {
      orderedActions.push({
        key: "enable_coord",
        icon: "GitBranch",
        label: t("coord.enableBtn"),
        tone: "default",
        disabled: busy,
        onPress: () => handleToggleCoord(true),
      });
    }
  }

  const primaryAction = orderedActions[0] ?? null;
  const inlineSecondaryActions = orderedActions.slice(1, 1 + maxInlineSecondary);
  const overflowActions = orderedActions.slice(1 + maxInlineSecondary);
  const hasMoreContent =
    overflowActions.length > 0 ||
    (item.visibility === "active" && item.status !== "archived") ||
    effectiveLinks.length > 0;

  const headerLinkGroups = buildHeaderLinkGroups(
    item.source,
    item.url,
    effectiveLinks,
    fallbackExternalLabel,
  );
  const showStaticSourceBadge = shouldShowStaticSourceBadge(item.source, headerLinkGroups);
  const selectedLinkGroup =
    picker === "link_select" && linkSelectKind
      ? headerLinkGroups.find((g) => g.kind === linkSelectKind) ?? null
      : null;

  const totalPendingPermissions =
    sessions.reduce((sum, s) => sum + s.pendingPermissions, 0) || (ws?.pendingPermissions ?? 0);
  const firstPendingSessionId =
    sessions.find((s) => s.pendingPermissions > 0)?.id ?? ws?.primaryAgentId ?? null;
  const shortTime = shortRelativeTimeLabel(item.updatedAt);

  return (
    <View
      {...(Platform.OS === "web" && onActivate
        ? ({ onMouseDown: () => onActivate() } as object)
        : {})}
      onTouchStart={Platform.OS !== "web" && onActivate ? () => onActivate() : undefined}
      style={{
        borderWidth: 1,
        borderColor: keyboardFocused ? colors.accent : colors.border,
        borderRadius: 10,
        backgroundColor: highlighted ? colors.surface1 : colors.surface0,
        padding: compactMode ? 10 : 12,
        gap: 7,
      }}
    >
      {/* 1. Card Title + Leading Semantic Icon + Right-Aligned Icon Metadata */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, zIndex: 20 }}>
        {selectable ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={isZh ? `选择 ${item.title}` : `Select ${item.title}`}
            onPress={() => onToggleSelect?.()}
            style={{
              width: 16,
              height: 16,
              borderWidth: 1,
              borderColor: selected ? colors.accent : colors.border,
              backgroundColor: selected ? colors.accent : colors.surface1,
              borderRadius: 4,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {selected ? <Icon name="Check" size={11} color={colors.accentForeground} /> : null}
          </Pressable>
        ) : null}

        {item.status === "running" && !hideRedundantStatusPill ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : item.status === "needs_me" && item.visibility === "active" && item.needsMeTag ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isZh
                ? `细分标签：${needsMeTagMetaForLocale(item.needsMeTag, true).label}（点击切换）`
                : `Tag: ${needsMeTagMetaForLocale(item.needsMeTag, false).label} (click to change)`
            }
            disabled={busy}
            onPress={() => togglePicker("tag")}
            {...webTooltipProps(
              isZh
                ? `${needsMeTagMetaForLocale(item.needsMeTag, true).label} · 点击切换`
                : `${needsMeTagMetaForLocale(item.needsMeTag, false).label} · Click to change`,
            )}
            style={{
              padding: 2,
              borderRadius: 4,
              backgroundColor: picker === "tag" ? colors.surface2 : "transparent",
            }}
          >
            <Icon
              name={needsMeTagMetaForLocale(item.needsMeTag, isZh).icon}
              size={13}
              color={needsMeTagColor(item.needsMeTag, theme)}
            />
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isZh ? "展开或收起卡片详情" : "Toggle card details"}
          onPress={toggleMore}
          style={{ flex: 1 }}
        >
          <Text
            numberOfLines={moreOpen ? undefined : 1}
            style={{
              color: colors.foreground,
              fontSize: 14,
              fontWeight: "600",
              lineHeight: 20,
            }}
          >
            {item.title}
          </Text>
        </Pressable>

        {/* Top-Right Compact Icon Metadata Strip */}
        <View style={{ position: "relative", flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {item.coordination?.enabled ? (() => {
            const coord = item.coordination;
            const dotColor =
              coord.needsCoordinator > 0
                ? colors.statusWarning
                : coord.running > 0
                  ? colors.accent
                  : coord.total > 0 && coord.archived === coord.total
                    ? colors.statusSuccess
                    : colors.foregroundMuted;
            const coordTip =
              coord.frontlineText ||
              t("coord.badge", { archived: coord.archived, total: coord.total });
            return (
              <Pressable
                ref={bindWebTitleRef(coordTip)}
                accessibilityRole="button"
                accessibilityLabel={t("coord.openBoardBtn")}
                onPress={() => {
                  if (onOpenCoordBoard) onOpenCoordBoard(item.id);
                  else openRadarToCoordBoard(paseo, item.id);
                }}
                onHoverIn={() => setHoveredHeaderTip(coordTip)}
                onHoverOut={() => setHoveredHeaderTip((cur) => (cur === coordTip ? null : cur))}
                {...webTooltipProps(coordTip)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: coord.needsCoordinator > 0 ? colors.statusWarning : colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: dotColor,
                  }}
                />
                <Icon name="GitBranch" size={11} color={dotColor} />
                <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}>
                  {t("coord.badge", { archived: coord.archived, total: coord.total })}
                </Text>
              </Pressable>
            );
          })() : null}

          {showStaticSourceBadge ? (
            <Pressable
              ref={bindWebTitleRef(item.badge)}
              onHoverIn={() => setHoveredHeaderTip(item.badge)}
              onHoverOut={() => setHoveredHeaderTip((cur) => (cur === item.badge ? null : cur))}
              {...webTooltipProps(item.badge)}
              style={{ padding: 2 }}
            >
              <VectorIcon
                icon={sourceOrLinkIcon(item.source)}
                size={12}
                color={isAlertBadge ? colors.statusDanger : colors.foregroundMuted}
              />
            </Pressable>
          ) : null}

          {headerLinkGroups.map((group) => {
            const baseColor = group.kind === "incident" || group.kind === "alert" ? colors.statusDanger : colors.foregroundMuted;
            const isDirectSingle = !group.isUnknown && group.links.length === 1;

            if (isDirectSingle) {
              const onlyLink = group.links[0]!;
              const tip = onlyLink.label.trim() || shortUrlPreview(onlyLink.url);
              return (
                <Pressable
                  key={`hdr:${group.kind}`}
                  ref={bindWebTitleRef(tip)}
                  accessibilityRole="link"
                  accessibilityLabel={tip}
                  onPress={() => {
                    void openExternalUrl(onlyLink.url);
                  }}
                  onHoverIn={() => setHoveredHeaderTip(tip)}
                  onHoverOut={() => setHoveredHeaderTip((cur) => (cur === tip ? null : cur))}
                  {...webTooltipProps(tip)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 2, padding: 2 }}
                >
                  <VectorIcon
                    icon={sourceOrLinkIcon(group.kind)}
                    size={12}
                    color={baseColor}
                  />
                  <Icon name="ArrowUpRight" size={9} color={baseColor} />
                </Pressable>
              );
            }

            const isSelectedGroup = picker === "link_select" && linkSelectKind === group.kind;
            const groupColor = isSelectedGroup ? colors.accent : baseColor;
            const tooltip = group.isUnknown
              ? isZh
                ? `${group.links.length} 个关联链接（点击展开选择）`
                : `${group.links.length} link(s) (click to choose)`
              : isZh
                ? `${group.links.length} 个 ${group.kind} 链接（点击展开选择）`
                : `${group.links.length} ${group.kind} links (click to choose)`;

            return (
              <Pressable
                key={`hdr:${group.kind}`}
                ref={bindWebTitleRef(tooltip)}
                accessibilityRole="button"
                accessibilityLabel={tooltip}
                onPress={() => toggleLinkSelectKind(group.kind)}
                onHoverIn={() => setHoveredHeaderTip(tooltip)}
                onHoverOut={() => setHoveredHeaderTip((cur) => (cur === tooltip ? null : cur))}
                {...webTooltipProps(tooltip)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 2,
                  paddingHorizontal: 3,
                  paddingVertical: 1,
                  borderRadius: 4,
                  backgroundColor: isSelectedGroup ? colors.surface2 : "transparent",
                }}
              >
                <VectorIcon
                  icon={sourceOrLinkIcon(group.kind)}
                  size={12}
                  color={groupColor}
                />
                <Text style={{ color: groupColor, fontSize: 11, fontWeight: "600" }}>
                  {group.links.length}
                </Text>
              </Pressable>
            );
          })}

          {totalPendingPermissions > 0 ? (() => {
            const permTip = isZh
              ? `${totalPendingPermissions} 个待授权审批（点击前往处理）`
              : `${totalPendingPermissions} pending permission(s) (click to open)`;
            return (
              <Pressable
                ref={bindWebTitleRef(permTip)}
                accessibilityRole="button"
                accessibilityLabel={permTip}
                onPress={() => {
                  if (onOpenAgent && firstPendingSessionId) {
                    onOpenAgent(firstPendingSessionId);
                  } else if (hasMoreContent) {
                    toggleMore();
                  }
                }}
                onHoverIn={() => setHoveredHeaderTip(permTip)}
                onHoverOut={() => setHoveredHeaderTip((cur) => (cur === permTip ? null : cur))}
                {...webTooltipProps(permTip)}
                style={{ flexDirection: "row", alignItems: "center", gap: 2, padding: 2 }}
              >
                <Icon name="AlertTriangle" size={12} color={colors.statusWarning} />
                <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "600" }}>
                  {totalPendingPermissions}
                </Text>
              </Pressable>
            );
          })() : multiSession ? (() => {
            const sessTip = isZh
              ? `${sessions.length} 个关联会话（点击展开列表）`
              : `${sessions.length} linked sessions`;
            return (
              <Pressable
                ref={bindWebTitleRef(sessTip)}
                accessibilityRole="button"
                accessibilityLabel={sessTip}
                onPress={() => {
                  if (hasMoreContent) toggleMore();
                }}
                onHoverIn={() => setHoveredHeaderTip(sessTip)}
                onHoverOut={() => setHoveredHeaderTip((cur) => (cur === sessTip ? null : cur))}
                {...webTooltipProps(sessTip)}
                style={{ flexDirection: "row", alignItems: "center", gap: 2, padding: 2 }}
              >
                <Icon name="Layers" size={12} color={colors.foregroundMuted} />
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{sessions.length}</Text>
              </Pressable>
            );
          })() : null}

          {shortTime ? (() => {
            const timeTip = relativeTimeLabel(item.updatedAt, isZh);
            return (
              <Pressable
                ref={bindWebTitleRef(timeTip)}
                onHoverIn={() => setHoveredHeaderTip(timeTip)}
                onHoverOut={() => setHoveredHeaderTip((cur) => (cur === timeTip ? null : cur))}
                {...webTooltipProps(timeTip)}
              >
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{shortTime}</Text>
              </Pressable>
            );
          })() : null}

          {hoveredHeaderTip ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                zIndex: 50,
                maxWidth: 260,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface2,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: colors.foreground,
                  fontSize: 11,
                  fontWeight: "500",
                  ...(Platform.OS === "web" ? ({ whiteSpace: "nowrap" } as object) : {}),
                }}
              >
                {hoveredHeaderTip}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* 2. One-Sentence Progress Summary */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {progress.prefixIcon ? (
          <Pressable
            accessibilityRole="button"
            disabled={!item.goal || item.visibility !== "active" || item.status === "archived"}
            onPress={() => {
              if (item.goal && item.visibility === "active" && item.status !== "archived") {
                togglePicker("goal");
              }
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}
          >
            <VectorIcon
              icon={progress.prefixIcon}
              size={12}
              color={progressPrefixColor(progress.tone, theme)}
            />
            {progress.prefix ? (
              <Text
                style={{
                  color: progressPrefixColor(progress.tone, theme),
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {progress.prefix}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isZh ? "展开或收起进度详情" : "Toggle full progress details"}
          onPress={toggleMore}
          style={{ flex: 1 }}
        >
          <Text
            numberOfLines={moreOpen ? undefined : compactMode ? 2 : 1}
            style={{ color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 }}
          >
            {progress.prefixIcon && (progress.prefix || progress.text) ? "· " : null}
            {!progress.prefixIcon && progress.prefix ? (
              <Text style={{ color: progressPrefixColor(progress.tone, theme), fontWeight: "600" }}>
                {progress.text ? `${progress.prefix} · ` : progress.prefix}
              </Text>
            ) : null}
            {progress.text}
          </Text>
        </Pressable>
      </View>

      {/* On-demand inline editors (only visible when user triggers them) */}
      {picker === "note" && !hasConversation ? (
        <TextInput
          value={note}
          onChangeText={setNote}
          editable={!busy}
          autoFocus={Platform.OS === "web"}
          placeholder={
            isZh
              ? "输入补充背景或具体指示（Enter 后台跟进，Shift+Enter 换行）…"
              : "Optional context or instructions (Enter to follow in BG, Shift+Enter for newline)…"
          }
          placeholderTextColor={colors.foregroundMuted}
          multiline
          style={{
            minHeight: 54,
            color: colors.foreground,
            fontSize: 13,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 7,
            backgroundColor: colors.surface1,
            textAlignVertical: "top",
            ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
          }}
          {...(Platform.OS === "web"
            ? {
                onKeyPress: (e: any) => {
                  const ne = e?.nativeEvent;
                  if (
                    ne?.key === "Enter" &&
                    !ne?.shiftKey &&
                    !ne?.isComposing &&
                    ne?.keyCode !== 229
                  ) {
                    e.preventDefault?.();
                    handleFollow("background");
                  }
                },
              }
            : {})}
        />
      ) : null}

      {item.visibility === "active" &&
      item.status === "needs_me" &&
      hasConversation &&
      picker === "reply" ? (
        <View style={{ gap: 6 }}>
          {multiSession ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                {isZh ? "回复给：" : "Reply to:"}
              </Text>
              {sessions.map((s) => {
                const effectiveSelectedId = decisionProposal
                  ? (validExplicitReplyId ?? validProposalAgentId ?? validCurrentAgentId ?? ws?.primaryAgentId)
                  : defaultTargetAgentId;
                const activeTarget = effectiveSelectedId === s.id;
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="button"
                    onPress={() => setReplyTargetId(s.id)}
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 5,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: activeTarget ? colors.surface2 : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        color: activeTarget ? colors.foreground : colors.foregroundMuted,
                        fontSize: 11,
                        fontWeight: activeTarget ? "600" : "400",
                      }}
                      numberOfLines={1}
                    >
                      {s.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {item.needsMeTag === "decision" && !hasDecisionDraft ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <PillButton
                icon="Check"
                label={isZh ? "按推荐方案执行" : "Proceed as recommended"}
                tone="default"
                disabled={replying || busy}
                theme={theme}
                onPress={() =>
                  handleQuickReply(
                    isZh ? "同意当前推荐方案，请直接执行。" : "Proceed with the recommended approach.",
                  )
                }
              />
              <PillButton
                icon="Check"
                label={isZh ? "确认并提交代码" : "Confirm & commit"}
                tone="default"
                disabled={replying || busy}
                theme={theme}
                onPress={() =>
                  handleQuickReply(
                    isZh
                      ? "确认当前方案与改动，请完成验证并提交 git commit。"
                      : "Confirmed; please verify and git commit.",
                  )
                }
              />
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
            <TextInput
              ref={replyInputRef}
              value={quickReply}
              onChangeText={setQuickReply}
              editable={!replying}
              autoFocus={Platform.OS === "web" && picker === "reply"}
              placeholder={
                hasDecisionDraft
                  ? isZh
                    ? "输入打回修改意见并发送（或作为确认时的补充说明）…"
                    : "Enter revision feedback and send, or add a note before approving…"
                  : isZh
                    ? "输入回复内容（Enter 发送）…"
                    : "Write a reply (Enter to send)…"
              }
              placeholderTextColor={colors.foregroundMuted}
              multiline
              style={{
                flex: 1,
                minHeight: 34,
                maxHeight: 96,
                color: colors.foreground,
                fontSize: 13,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 6,
                backgroundColor: colors.surface1,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
              }}
              {...(Platform.OS === "web"
                ? {
                    onKeyPress: (e: any) => {
                      const ne = e?.nativeEvent;
                      if (ne?.key === "Enter" && !ne?.shiftKey && !ne?.isComposing) {
                        e.preventDefault?.();
                        handleQuickReply();
                      }
                    },
                  }
                : {})}
            />
            <PillButton
              icon="Send"
              label={replying ? (isZh ? "发送中…" : "Sending…") : isZh ? "发送" : "Send"}
              tone={quickReply.trim() !== "" ? "primary" : "default"}
              disabled={replying || busy || quickReply.trim() === ""}
              theme={theme}
              onPress={() => handleQuickReply()}
            />
          </View>
        </View>
      ) : null}

      {picker === "goal" && item.visibility === "active" && item.status !== "archived" ? (
        <View
          style={{
            gap: 7,
            padding: 9,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.accent,
            backgroundColor: colors.surface1,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="Crosshair" size={12} color={colors.accent} />
              <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {isZh ? "目标模式（自动评估达标并续推）" : "Goal Mode (Auto-evaluate & steer)"}
              </Text>
            </View>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
              {isZh ? "也可在对话输入 /radar-goal" : "Or type /radar-goal in chat"}
            </Text>
          </View>

          <TextInput
            value={goalSpecDraft}
            onChangeText={setGoalSpecDraft}
            placeholder={
              isZh
                ? "可选：描述期望达成的结果或约束；留空时 AI 将结合上下文自动完善目标…"
                : "Optional: describe target outcome or constraints; leave blank for AI to infer…"
            }
            placeholderTextColor={colors.foregroundMuted}
            multiline
            style={{
              minHeight: 54,
              color: colors.foreground,
              fontSize: 12,
              lineHeight: 18,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 6,
              backgroundColor: colors.surface0,
              textAlignVertical: "top",
              ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
            }}
          />

          <View
            style={{
              flexDirection: compactMode ? "column" : "row",
              alignItems: compactMode ? "stretch" : "center",
              gap: 6,
            }}
          >
            <TextInput
              value={goalVerifyDraft}
              onChangeText={setGoalVerifyDraft}
              placeholder={
                isZh
                  ? "可选验收命令（exit 0 放行，如 npm run typecheck）"
                  : "Optional verify command (exit 0 passes)"
              }
              placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                ...(compactMode ? {} : { flex: 1 }),
                color: colors.foreground,
                fontSize: 12,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 6,
                paddingHorizontal: 8,
                paddingVertical: 5,
                backgroundColor: colors.surface0,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
              }}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                {isZh ? "轮数上限" : "Max turns"}
              </Text>
              <TextInput
                value={goalMaxTurnsDraft}
                onChangeText={setGoalMaxTurnsDraft}
                keyboardType="numeric"
                style={{
                  width: 52,
                  color: colors.foreground,
                  fontSize: 12,
                  textAlign: "center",
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 5,
                  backgroundColor: colors.surface0,
                  ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
                }}
              />
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <PillButton
              icon="Play"
              label={
                item.status === "running"
                  ? goalSpecDraft.trim() === ""
                    ? isZh
                      ? "AI 生成并更新目标"
                      : "AI Generate & Steer"
                    : isZh
                      ? "保存并更新目标"
                      : "Save & Steer"
                  : goalSpecDraft.trim() === ""
                    ? isZh
                      ? "AI 定目标并推进"
                      : "AI Auto-Goal & Start"
                    : isZh
                      ? "开启并推进"
                      : "Start Goal"
              }
              tone="primary"
              disabled={busy}
              theme={theme}
              onPress={() => handleGoalAction("set", true)}
            />
            {item.status === "pool" || item.status === "running" ? (
              <PillButton
                icon="Check"
                label={
                  goalSpecDraft.trim() === ""
                    ? isZh
                      ? "AI 生成并保存"
                      : "AI Generate & Save"
                    : isZh
                      ? "仅保存目标"
                      : "Save Only"
                }
                tone="default"
                disabled={busy}
                theme={theme}
                onPress={() => handleGoalAction("set", false)}
              />
            ) : null}
            {item.goal?.active ? (
              <PillButton
                icon="PauseCircle"
                label={isZh ? "暂停目标" : "Pause Goal"}
                tone="default"
                disabled={busy}
                theme={theme}
                onPress={() => handleGoalAction("stop", false)}
              />
            ) : null}
            {item.goal ? (
              <PillButton
                icon="Trash2"
                label={isZh ? "清除" : "Clear"}
                tone="subtle"
                disabled={busy}
                theme={theme}
                onPress={() => handleGoalAction("clear", false)}
              />
            ) : null}
            <PillButton
              icon="X"
              label={isZh ? "收起" : "Close"}
              tone="subtle"
              disabled={busy}
              theme={theme}
              onPress={() => setPicker(null)}
            />
          </View>
        </View>
      ) : null}

      {picker === "set_wait" && item.visibility === "active" && item.status === "needs_me" ? (
        <View
          style={{
            gap: 6,
            padding: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            {isZh
              ? "由当前会话核验完结条件可检后，自动配置脚本监听或 AI 巡检；达标或超时后自动唤醒原会话"
              : "Verified by session before starting script/AI watch; wakes session on match or timeout"}
          </Text>
          {multiSession ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                {isZh ? "核验会话：" : "Session:"}
              </Text>
              {sessions.map((s) => {
                const activeTarget = defaultTargetAgentId === s.id;
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="button"
                    onPress={() => setReplyTargetId(s.id)}
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 5,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: activeTarget ? colors.surface2 : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        color: activeTarget ? colors.foreground : colors.foregroundMuted,
                        fontSize: 11,
                        fontWeight: activeTarget ? "600" : "400",
                      }}
                      numberOfLines={1}
                    >
                      {s.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <TextInput
            value={waitDraft}
            onChangeText={setWaitDraft}
            placeholder={
              isZh
                ? "填写外部等待条件与最大等待时长（如：MR !18224 合并且 CI 通过，最长 24h）…"
                : "External completion condition & max timeout…"
            }
            placeholderTextColor={colors.foregroundMuted}
            multiline
            style={{
              minHeight: 50,
              color: colors.foreground,
              fontSize: 12,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 6,
              backgroundColor: colors.surface0,
              textAlignVertical: "top",
              ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
            }}
          />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <PillButton
              icon="Clock"
              label={isZh ? "提交等待条件" : "Submit Wait"}
              tone="primary"
              disabled={busy || waitDraft.trim() === ""}
              theme={theme}
              onPress={handleSubmitWaitExternal}
            />
            <PillButton
              icon="X"
              label={isZh ? "取消" : "Cancel"}
              tone="subtle"
              theme={theme}
              onPress={() => setPicker(null)}
            />
          </View>
        </View>
      ) : null}

      {picker === "snooze" ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            {isZh ? "暂缓至：" : "Snooze until:"}
          </Text>
          <PillButton
            icon="Clock"
            label={isZh ? "4 小时" : "4h"}
            theme={theme}
            disabled={busy}
            onPress={() => handleSnooze("4h")}
          />
          <PillButton
            icon="Clock"
            label={isZh ? "明天上午" : "Tomorrow AM"}
            theme={theme}
            disabled={busy}
            onPress={() => handleSnooze("tomorrow")}
          />
          <PillButton
            icon="Clock"
            label={isZh ? "下周一" : "Next Mon"}
            theme={theme}
            disabled={busy}
            onPress={() => handleSnooze("next_monday")}
          />
          <PillButton
            icon="X"
            label={isZh ? "取消" : "Cancel"}
            tone="subtle"
            theme={theme}
            disabled={busy}
            onPress={() => setPicker(null)}
          />
        </View>
      ) : null}

      {picker === "confirm_archive" ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12 }}>
            {isZh ? "同步归档该工作区对话与卡片？" : "Archive linked workspace session & card?"}
          </Text>
          <PillButton
            icon="Archive"
            label={isZh ? "确认归档" : "Confirm Archive"}
            tone="danger"
            disabled={busy}
            theme={theme}
            onPress={handleArchive}
          />
          <PillButton
            icon="X"
            label={isZh ? "取消" : "Cancel"}
            tone="subtle"
            disabled={busy}
            theme={theme}
            onPress={() => setPicker(null)}
          />
        </View>
      ) : null}

      {picker === "tag" && item.status === "needs_me" ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderRadius: 8,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, alignSelf: "center" }}>
            {isZh ? "细分标签：" : "Tag:"}
          </Text>
          {(["ready_to_archive", "decision", "input", "review"] as const).map((t) => {
            const meta = needsMeTagMetaForLocale(t, isZh);
            return (
              <PillButton
                key={t}
                icon={meta.icon}
                label={meta.label}
                tone={item.needsMeTag === t ? "accent" : "default"}
                disabled={busy}
                theme={theme}
                onPress={() => handleUpdate({ needsMeTag: t })}
              />
            );
          })}
        </View>
      ) : null}

      {selectedLinkGroup ? (
        <View
          style={{
            gap: 5,
            padding: 8,
            borderRadius: 8,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          {selectedLinkGroup.links.map((lnk) => (
            <Pressable
              key={`${lnk.label}:${lnk.url}`}
              accessibilityRole="link"
              accessibilityLabel={lnk.label}
              onPress={() => {
                void openExternalUrl(lnk.url);
                setPicker(null);
                setLinkSelectKind(null);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingVertical: 5,
                paddingHorizontal: 8,
                borderRadius: 6,
                backgroundColor: colors.surface0,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <VectorIcon icon={sourceOrLinkIcon(lnk.kind)} size={12} color={colors.foregroundMuted} />
              <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "500" }}>
                {lnk.label}
              </Text>
              <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                {shortUrlPreview(lnk.url)}
              </Text>
              <Icon name="ArrowUpRight" size={12} color={colors.foregroundMuted} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {picker === "links" ? (
        <View
          style={{
            gap: 8,
            padding: 9,
            borderRadius: 8,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            {canEditLinks
              ? isZh
                ? "关联链接（移除仅解除本卡片关联，不影响外部单据或文档）"
                : "Linked URLs (removing only detaches from this card)"
              : isZh
                ? "关联链接"
                : "Linked URLs"}
          </Text>

          {effectiveLinks.length > 0 ? (
            <View style={{ gap: 5 }}>
              {effectiveLinks.map((lnk) => (
                <View
                  key={`${lnk.label}:${lnk.url}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingVertical: 4,
                    paddingHorizontal: 8,
                    borderRadius: 6,
                    backgroundColor: colors.surface0,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={lnk.label}
                    onPress={() => {
                      void openExternalUrl(lnk.url);
                    }}
                    style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 5 }}
                  >
                    <VectorIcon icon={sourceOrLinkIcon(lnk.kind)} size={11} color={colors.foregroundMuted} />
                    <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "500" }}>
                      {lnk.label}
                    </Text>
                    <Icon name="ArrowUpRight" size={11} color={colors.foregroundMuted} />
                    <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                      {shortUrlPreview(lnk.url)}
                    </Text>
                  </Pressable>
                  {canEditLinks ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={isZh ? `移除关联链接 ${lnk.label}` : `Remove ${lnk.label}`}
                      disabled={busy}
                      onPress={() => handleRemoveLink(lnk.url, lnk.label)}
                      style={{ paddingHorizontal: 4, paddingVertical: 2, opacity: busy ? 0.5 : 1 }}
                    >
                      <Icon name="X" size={12} color={colors.foregroundMuted} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {canEditLinks ? (
            <View
              style={{
                flexDirection: compactMode ? "column" : "row",
                alignItems: compactMode ? "stretch" : "center",
                gap: 6,
              }}
            >
              <TextInput
                value={linkUrlDraft}
                onChangeText={setLinkUrlDraft}
                placeholder={isZh ? "粘贴完整链接 (https://…)" : "Paste full URL (https://…)"}
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  ...(compactMode ? {} : { flex: 2 }),
                  color: colors.foreground,
                  fontSize: 12,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  backgroundColor: colors.surface0,
                  ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
                }}
              />
              <TextInput
                value={linkLabelDraft}
                onChangeText={setLinkLabelDraft}
                placeholder={isZh ? "显示名（可选）" : "Label (optional)"}
                placeholderTextColor={colors.foregroundMuted}
                style={{
                  ...(compactMode ? {} : { flex: 1 }),
                  color: colors.foreground,
                  fontSize: 12,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  backgroundColor: colors.surface0,
                  ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
                }}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <PillButton
                  icon="Plus"
                  label={isZh ? "添加" : "Add"}
                  tone="primary"
                  disabled={busy || linkUrlDraft.trim() === ""}
                  theme={theme}
                  onPress={handleAddLink}
                />
                <PillButton
                  icon="X"
                  label={isZh ? "收起" : "Close"}
                  tone="subtle"
                  disabled={busy}
                  theme={theme}
                  onPress={() => setPicker(null)}
                />
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <PillButton
                icon="X"
                label={isZh ? "收起" : "Close"}
                tone="subtle"
                theme={theme}
                onPress={() => setPicker(null)}
              />
            </View>
          )}
        </View>
      ) : null}

      {picker === "project" && ws === null ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderRadius: 8,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, alignSelf: "center" }}>
            {isZh ? "归属项目：" : "Project:"}
          </Text>
          {projects.map((p) => (
            <PillButton
              key={p.projectId}
              icon={p.kind === "git" ? "GitBranch" : "Folder"}
              label={p.name}
              tone={item.projectId === p.projectId ? "accent" : "default"}
              disabled={busy}
              theme={theme}
              onPress={() => handleUpdate({ projectId: p.projectId })}
            />
          ))}
        </View>
      ) : null}

      {/* 3. Action Bar: 1 Primary Labeled Action + Compact Icon Actions + Project & More */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, zIndex: 15 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          {primaryAction ? (
            <PillButton
              icon={primaryAction.icon}
              label={primaryAction.label}
              tooltip={primaryAction.tooltip ?? primaryAction.label}
              tone={primaryAction.tone ?? "primary"}
              disabled={primaryAction.disabled}
              theme={theme}
              onPress={primaryAction.onPress}
            />
          ) : null}

          {inlineSecondaryActions.map((act) => (
            <IconPillButton
              key={act.key}
              icon={act.icon ?? "Circle"}
              label={act.label}
              tooltip={act.tooltip ?? act.label}
              tone={act.tone ?? "default"}
              disabled={act.disabled}
              theme={theme}
              onPress={act.onPress}
            />
          ))}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!compactMode && item.projectName ? (
            ws === null && item.visibility === "active" && item.status !== "archived" ? (
              <Pressable
                ref={bindWebTitleRef(isZh ? `${item.projectName} · 点击切换项目` : `${item.projectName} · Change project`)}
                accessibilityRole="button"
                accessibilityLabel={isZh ? `切换归属项目（当前：${item.projectName}）` : `Change project (${item.projectName})`}
                disabled={busy}
                onPress={() => togglePicker("project")}
                style={{ paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: picker === "project" ? colors.accent : colors.foregroundMuted,
                    fontSize: 11,
                    maxWidth: 120,
                  }}
                >
                  {item.projectName}
                </Text>
              </Pressable>
            ) : (
              <Text
                numberOfLines={1}
                {...webTooltipProps(item.projectName)}
                style={{ color: colors.foregroundMuted, fontSize: 11, maxWidth: 120 }}
              >
                {item.projectName}
              </Text>
            )
          ) : null}

          {hasMoreContent ? (
            <IconPillButton
              icon={moreOpen ? "ChevronUp" : "MoreHorizontal"}
              label={moreOpen ? (isZh ? "收起" : "Less") : isZh ? "更多" : "More"}
              tooltip={moreOpen ? (isZh ? "收起详情与设置" : "Collapse details") : isZh ? "更多操作与设置" : "More actions & settings"}
              tipAlign="right"
              tone={moreOpen ? "accent" : "subtle"}
              theme={theme}
              onPress={toggleMore}
            />
          ) : null}
        </View>
      </View>

      {/* 4. Expanded Secondary Actions & Metadata ("更多" Drawer) */}
      {moreOpen && hasMoreContent ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 8,
            gap: 8,
          }}
        >
          {/* Remaining Secondary Actions */}
          {overflowActions.length > 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              {overflowActions.map((act) => (
                <PillButton
                  key={act.key}
                  icon={act.icon}
                  label={act.label}
                  tone={act.tone ?? "default"}
                  disabled={act.disabled}
                  theme={theme}
                  onPress={act.onPress}
                />
              ))}
            </View>
          ) : null}

          {/* Secondary Metadata Pills & External Links */}
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <View
              style={{
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 5,
                borderWidth: isWorkspaceBadge ? 0 : 1,
                ...(isWorkspaceBadge
                  ? {}
                  : { borderColor: isAlertBadge ? colors.statusDanger : colors.border }),
                backgroundColor: isWorkspaceBadge ? colors.surface2 : colors.surface1,
              }}
            >
              <Text
                style={{
                  color: isAlertBadge
                    ? colors.statusDanger
                    : isWorkspaceBadge
                      ? colors.foregroundMuted
                      : colors.foreground,
                  fontSize: 11,
                  fontWeight: "500",
                }}
              >
                {item.badge}
              </Text>
            </View>

            {/* Sub-tag switcher for needs_me */}
            {item.status === "needs_me" && item.visibility === "active" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isZh ? "切换处理细分标签" : "Change action tag"}
                disabled={busy}
                onPress={() => togglePicker("tag")}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: picker === "tag" ? colors.accent : colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                {item.needsMeTag ? (
                  <>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: needsMeTagColor(item.needsMeTag, theme),
                      }}
                    />
                    <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "500" }}>
                      {needsMeTagMetaForLocale(item.needsMeTag, isZh).label}
                    </Text>
                  </>
                ) : (
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {isZh ? "标注中…" : "Tagging…"}
                  </Text>
                )}
                <Icon name="ChevronDown" size={10} color={colors.foregroundMuted} />
              </Pressable>
            ) : null}

            {/* Project selector (shown here only when not already visible on the action bar) */}
            {item.visibility === "active" &&
            item.status !== "archived" &&
            (compactMode || !item.projectName) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isZh ? "选择归属项目" : "Select project"}
                disabled={busy || ws !== null}
                onPress={() => togglePicker("project")}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: picker === "project" ? colors.accent : colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Icon name="FolderGit2" size={11} color={colors.foregroundMuted} />
                <Text style={{ color: colors.foreground, fontSize: 11 }} numberOfLines={1}>
                  {item.projectName ?? (isZh ? "选择项目" : "Select Project")}
                </Text>
                {ws === null ? <Icon name="ChevronDown" size={11} color={colors.foregroundMuted} /> : null}
              </Pressable>
            ) : null}

            {/* Model selector */}
            {!multiSession && item.visibility === "active" && item.status !== "archived" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isZh ? "切换模型" : "Switch model"}
                disabled={busy}
                onPress={() => togglePicker("model")}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: picker === "model" ? colors.accent : colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Icon name="Cpu" size={11} color={colors.foregroundMuted} />
                <Text style={{ color: colors.foreground, fontSize: 11 }}>
                  {shortModelName(item.selectedModel)}
                </Text>
                <Icon name="ChevronDown" size={11} color={colors.foregroundMuted} />
              </Pressable>
            ) : null}

            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
              {relativeTimeLabel(item.updatedAt, isZh)}
            </Text>

            {/* Link manager */}
            {canEditLinks ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isZh ? "管理关联链接" : "Manage linked URLs"}
                disabled={busy}
                onPress={() => togglePicker("links")}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 6,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: picker === "links" ? colors.accent : colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Icon
                  name="Link2"
                  size={11}
                  color={picker === "links" ? colors.accent : colors.foregroundMuted}
                />
              </Pressable>
            ) : null}
          </View>

          {/* Pickers triggered from Metadata row */}
          {picker === "model" ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 6,
                padding: 8,
                borderRadius: 8,
                backgroundColor: colors.surface1,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 11, alignSelf: "center" }}>
                {isZh ? "常用模型：" : "Models:"}
              </Text>
              {(() => {
                const cfg = modelSettings.status === "ready" ? modelSettings.values : null;
                const assignable = cfg?.assignableModels ?? [];
                const assignableByModel = new Map(assignable.map((m) => [m.model, m]));
                const quickIds = [
                  ...new Set(
                    [item.selectedModel, ...assignable.map((m) => m.model)].filter(Boolean),
                  ),
                ].slice(0, 6);
                return quickIds.map((id) => {
                  const customEntry = assignableByModel.get(id);
                  const matched = allModels.find((c) => c.value === id);
                  const label = customEntry?.name?.trim() || (matched ? matched.label : shortModelName(id));
                  return (
                    <PillButton
                      key={id}
                      label={label}
                      tone={item.selectedModel === id ? "accent" : "default"}
                      disabled={busy}
                      theme={theme}
                      onPress={() => handleUpdate({ selectedModel: id })}
                    />
                  );
                });
              })()}
              <PillButton
                icon="Search"
                label={isZh ? "搜索全部模型…" : "Search all models…"}
                tone="subtle"
                disabled={busy}
                theme={theme}
                onPress={() => {
                  setPicker(null);
                  setModelModalTarget({ open: true, currentModel: item.selectedModel });
                }}
              />
            </View>
          ) : null}

          {/* Supplemental Details (only rendered when non-redundant) */}
          {ws?.prepSummary && subtitle ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }} selectable>
              {isZh ? `外部状态：${subtitle}` : `Source: ${subtitle}`}
            </Text>
          ) : null}

          {item.goal && picker !== "goal" ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: item.goal.active ? colors.accent : colors.border,
                backgroundColor: colors.surface1,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                gap: 4,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Icon
                  name={
                    item.goal.active
                      ? "Crosshair"
                      : item.goal.stopReason === "achieved"
                        ? "CheckCircle2"
                        : "PauseCircle"
                  }
                  size={12}
                  color={item.goal.active ? colors.accent : colors.foregroundMuted}
                />
                <Text style={{ flex: 1, color: colors.foreground, fontSize: 12, lineHeight: 17 }} selectable>
                  {isZh
                    ? `目标 (${item.goal.turnCount}/${item.goal.maxTurns})：${item.goal.spec}`
                    : `Goal (${item.goal.turnCount}/${item.goal.maxTurns}): ${item.goal.spec}`}
                </Text>
                {(item.goal.stopReason === "max_turns" || item.goal.stopReason === "manual") &&
                !item.goal.active ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => handleGoalAction("resume", true)}
                    style={{ paddingHorizontal: 5, paddingVertical: 2 }}
                  >
                    <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}>
                      {isZh ? "继续推进" : "Resume"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {item.goal.verifyCommand ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={1} selectable>
                  {isZh ? `验收命令：${item.goal.verifyCommand}` : `Verify: ${item.goal.verifyCommand}`}
                </Text>
              ) : null}
            </View>
          ) : null}

          {item.status === "waiting_external" && (item.waitCron || ws?.prepSummary) ? (
            <View style={{ gap: 4 }}>
              {item.waitCron ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                  {item.waitMode === "provider"
                    ? t("board.providerWait")
                    : item.waitMode === "ai" ? (isZh ? "AI 巡检" : "AI Check") : (isZh ? "脚本监听" : "Script Watch")}
                  {` · ${formatCronHuman(item.waitCron, isZh)}`}
                </Text>
              ) : null}
              {ws?.prepSummary ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }} selectable>
                  {isZh
                    ? `会话背景：${dedupeSummaryWithTitle(ws.prepSummary, item.title)}`
                    : `Session context: ${dedupeSummaryWithTitle(ws.prepSummary, item.title)}`}
                </Text>
              ) : null}
            </View>
          ) : null}

          {decisionProposal && (displayProposal.target || displayProposal.impact) ? (
            <View style={{ gap: 2 }}>
              {displayProposal.target ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }} selectable>
                  {isZh ? `目标：${displayProposal.target}` : `Target: ${displayProposal.target}`}
                </Text>
              ) : null}
              {displayProposal.impact ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }} selectable>
                  {isZh ? `影响：${displayProposal.impact}` : `Impact: ${displayProposal.impact}`}
                </Text>
              ) : null}
            </View>
          ) : null}

          {multiSession ? (
            <View style={{ gap: 5 }}>
              {sessions.map((sess) => {
                const sessRunning = sess.status === "running" || sess.status === "initializing";
                return (
                  <View
                    key={sess.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingVertical: 4,
                      paddingHorizontal: 6,
                      borderRadius: 6,
                      backgroundColor: colors.surface1,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    {sessRunning ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor:
                            sess.pendingPermissions > 0 ? colors.statusWarning : colors.foregroundMuted,
                        }}
                      />
                    )}
                    <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }} numberOfLines={1}>
                      {sess.title}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() =>
                        setModelModalTarget({ open: true, agentId: sess.id, currentModel: sess.model })
                      }
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 3,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 5,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface0,
                      }}
                    >
                      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                        {shortModelName(sess.model)}
                      </Text>
                      <Icon name="ChevronDown" size={10} color={colors.foregroundMuted} />
                    </Pressable>
                    {onOpenAgent ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => onOpenAgent(sess.id)}
                        style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 4 }}
                      >
                        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "500" }}>
                          {isZh ? "进入" : "Open"}
                        </Text>
                        <Icon name="ArrowUpRight" size={11} color={colors.foregroundMuted} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}

      <SearchableModelModal
        title={isZh ? "切换会话模型" : "Switch Session Model"}
        open={modelModalTarget.open}
        value={modelModalTarget.currentModel}
        choices={allModels}
        theme={theme}
        onClose={() => setModelModalTarget((prev) => ({ ...prev, open: false }))}
        onSelect={(val) =>
          handleUpdate({
            ...(modelModalTarget.agentId ? { targetAgentId: modelModalTarget.agentId } : {}),
            selectedModel: val,
          })
        }
      />

      <Modal
        title={
          decisionProposal?.title ||
          (isZh ? "审阅并编辑待确认草稿" : "Review & Edit Decision Draft")
        }
        open={draftModalOpen && hasDecisionDraft}
        onOpenChange={(next) => {
          if (!next) setDraftModalOpen(false);
        }}
      >
        <Modal.Content
          scrollable={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ flex: 1, padding: 16, gap: 10 }}
        >
          {displayProposal.target ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }} selectable>
              {isZh ? `目标：${displayProposal.target}` : `Target: ${displayProposal.target}`}
            </Text>
          ) : null}
          {displayProposal.impact ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }} selectable>
              {isZh ? `影响：${displayProposal.impact}` : `Impact: ${displayProposal.impact}`}
            </Text>
          ) : null}
          <TextInput
            value={editedDraft}
            onChangeText={setEditedDraft}
            editable={!replying}
            multiline
            autoFocus={Platform.OS === "web"}
            style={{
              flex: 1,
              minHeight: 280,
              color: colors.foreground,
              fontSize: 13,
              lineHeight: 20,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
              backgroundColor: colors.surface1,
              textAlignVertical: "top",
              ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
            }}
            {...(Platform.OS === "web"
              ? {
                  onKeyPress: (e: any) => {
                    const ne = e?.nativeEvent;
                    if (ne?.key === "Enter" && (ne?.metaKey || ne?.ctrlKey) && !ne?.isComposing) {
                      e.preventDefault?.();
                      handleConfirmDecision();
                    }
                  },
                }
              : {})}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <TextInput
              value={draftRejectNote}
              onChangeText={setDraftRejectNote}
              editable={!replying}
              placeholder={
                isZh
                  ? "若取消执行，在此输入修改意见并打回（Enter 发送）…"
                  : "To cancel, enter revision feedback here (Enter to send)…"
              }
              placeholderTextColor={colors.foregroundMuted}
              style={{
                flex: 1,
                height: 32,
                color: colors.foreground,
                fontSize: 12,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 7,
                paddingHorizontal: 10,
                backgroundColor: colors.surface1,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
              }}
              {...(Platform.OS === "web"
                ? {
                    onKeyPress: (e: any) => {
                      const ne = e?.nativeEvent;
                      if (ne?.key === "Enter" && !ne?.shiftKey && !ne?.isComposing && ne?.keyCode !== 229) {
                        e.preventDefault?.();
                        handleRejectDecision();
                      }
                    },
                  }
                : {})}
            />
            <PillButton
              icon="RotateCcw"
              label={isZh ? "打回修改" : "Request Changes"}
              tone="default"
              disabled={replying || busy || draftRejectNote.trim() === ""}
              theme={theme}
              onPress={handleRejectDecision}
            />
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {isDraftEdited ? (
                <PillButton
                  icon="RotateCcw"
                  label={isZh ? "还原原稿" : "Restore Draft"}
                  tone="subtle"
                  disabled={replying}
                  theme={theme}
                  onPress={() => setEditedDraft(decisionProposal?.draft ?? "")}
                />
              ) : (
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {isZh
                    ? "可直接改字，Ctrl/Cmd + Enter 确认执行"
                    : "Editable; Ctrl/Cmd + Enter to approve & run"}
                </Text>
              )}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <PillButton
                icon="X"
                label={isZh ? "关闭" : "Close"}
                tone="default"
                disabled={replying}
                theme={theme}
                onPress={() => setDraftModalOpen(false)}
              />
              <PillButton
                icon="Check"
                label={
                  replying
                    ? isZh
                      ? "发送中…"
                      : "Sending…"
                    : isDraftEdited
                      ? isZh
                        ? "按修改稿执行"
                        : "Run Edited Draft"
                      : isZh
                        ? "确认草稿并执行"
                        : "Approve & Run"
                }
                tone="primary"
                disabled={replying || busy || editedDraft.trim() === ""}
                theme={theme}
                onPress={handleConfirmDecision}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
