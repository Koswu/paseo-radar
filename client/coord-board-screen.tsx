import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  type TextInput as NativeTextInput,
  View,
} from "react-native";

import {
  coordSubcardActionRpc,
  loadRadarCoordDetailRpc,
  readRadarCoordArtifactRpc,
  toggleRadarCoordRpc,
  type ArtifactEntry,
  type CoordBoardDetail,
  type CoordEventKind,
  type SubCard,
} from "../shared/radar";
import { CoordTopologySection } from "./coord-topology";
import { statusLabelForLocale, useRadarI18n } from "./i18n";
import { PillButton, relativeTimeLabel, shortModelName, statusColor } from "./radar-card";
import { setCachedRadarSnapshot } from "./radar-store";

type CoordTab = "board" | "flow" | "trace";
type BoardStatusFilter = "all" | "board" | "pool" | "needs_me" | "running" | "waiting_external" | "done";
type EventCategoryFilter = "all" | "lifecycle" | "wait" | "collab";

interface ArtifactItemView {
  key: string;
  subcardId: string | null;
  entry: ArtifactEntry;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function getUpstreamIds(subcard: SubCard): string[] {
  const ids = new Set<string>(subcard.refCards);
  if (subcard.waitMode === "board" && subcard.waitBoard) {
    for (const target of subcard.waitBoard.targets) {
      ids.add(target.cardId);
    }
  }
  return Array.from(ids);
}

function computeDownstreamMap(subcards: readonly SubCard[]): Map<string, string[]> {
  const downstream = new Map<string, string[]>();
  for (const s of subcards) downstream.set(s.id, []);
  for (const s of subcards) {
    for (const upId of getUpstreamIds(s)) {
      const list = downstream.get(upId);
      if (list && !list.includes(s.id)) list.push(s.id);
    }
  }
  return downstream;
}

function subcardToneColor(subcard: SubCard, theme: PluginTheme): string {
  const { colors } = theme;
  if (subcard.canceled) return colors.foregroundMuted;
  if (subcard.status === "archived") return colors.statusSuccess;
  return statusColor(subcard.status, theme);
}

function subcardWaitText(subcard: SubCard, waitBoardPrefix: string): string | null {
  if (subcard.status !== "waiting_external") return null;
  if (subcard.waitMode === "board" && subcard.waitBoard) {
    const targets = subcard.waitBoard.targets
      .map((t) => `${t.cardId}:${t.status}`)
      .join(subcard.waitBoard.match === "any" ? " | " : " & ");
    const base = `${waitBoardPrefix} (${targets})`;
    return subcard.waitCondition ? `${base} · ${subcard.waitCondition}` : base;
  }
  const parts: string[] = [];
  if (subcard.waitCondition) parts.push(subcard.waitCondition);
  if (subcard.waitCron) parts.push(`[${subcard.waitCron}]`);
  if (subcard.waitCheckNote) parts.push(subcard.waitCheckNote);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function matchesEventCategory(kind: CoordEventKind, category: EventCategoryFilter): boolean {
  if (category === "all") return true;
  if (category === "lifecycle") {
    return (
      kind === "coord.enabled" ||
      kind === "subcard.created" ||
      kind === "subcard.started" ||
      kind === "subcard.canceled" ||
      kind === "subcard.archived"
    );
  }
  if (category === "wait") {
    return (
      kind === "wait.registered" ||
      kind === "wait.checked" ||
      kind === "wait.triggered" ||
      kind === "wait.timeout"
    );
  }
  return (
    kind === "gate.rejected" ||
    kind === "peer.message" ||
    kind === "escalated.coordinator" ||
    kind === "escalated.human"
  );
}

function SubCardActionBar({
  subcard,
  theme,
  busy,
  replyOpen,
  replyDraft,
  confirmCancel,
  onChangeReply,
  onToggleReply,
  onRequestCancel,
  onDismissCancel,
  onAction,
  onOpenAgent,
  onViewTopology,
  onViewTrace,
}: {
  subcard: SubCard;
  theme: PluginTheme;
  busy: boolean;
  replyOpen: boolean;
  replyDraft: string;
  confirmCancel: boolean;
  onChangeReply: (text: string) => void;
  onToggleReply: () => void;
  onRequestCancel: () => void;
  onDismissCancel: () => void;
  onAction: (action: "start" | "reply" | "archive" | "cancel", text?: string) => void;
  onOpenAgent: ((agentId: string) => void) | null;
  onViewTopology?: () => void;
  onViewTrace?: () => void;
}) {
  const { t } = useRadarI18n();
  const { colors } = theme;
  const inputRef = useRef<NativeTextInput | null>(null);
  const latestInbox = subcard.inbox.length > 0 ? subcard.inbox[subcard.inbox.length - 1] : null;

  useEffect(() => {
    if (replyOpen) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [replyOpen]);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {subcard.boundAgentId && onOpenAgent ? (
            <PillButton
              icon="ArrowUpRight"
              label={t("coord.actionOpenSession")}
              tone="primary"
              disabled={busy}
              theme={theme}
              onPress={() => onOpenAgent(subcard.boundAgentId!)}
            />
          ) : null}
          {!subcard.canceled && subcard.status === "pool" ? (
            <PillButton
              icon="Play"
              label={t("coord.actionStart")}
              tone={subcard.boundAgentId ? "default" : "primary"}
              disabled={busy}
              theme={theme}
              onPress={() => onAction("start")}
            />
          ) : null}
          {!subcard.canceled && subcard.status === "needs_me" ? (
            <>
              <PillButton
                icon="MessageSquarePlus"
                label={t("coord.actionReply")}
                tone={replyOpen ? "accent" : "default"}
                disabled={busy}
                theme={theme}
                onPress={onToggleReply}
              />
              <PillButton
                icon="Archive"
                label={t("coord.actionArchive")}
                tone="default"
                disabled={busy}
                theme={theme}
                onPress={() => onAction("archive")}
              />
            </>
          ) : null}
          {!subcard.canceled && subcard.status !== "archived" ? (
            confirmCancel ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Text style={{ color: colors.statusDanger, fontSize: 11.5, fontWeight: "600" }}>
                  {t("coord.confirmCancel")}
                </Text>
                <PillButton
                  icon="X"
                  label={t("coord.confirmCancelBtn")}
                  tone="danger"
                  disabled={busy}
                  theme={theme}
                  onPress={() => onAction("cancel")}
                />
                <PillButton
                  label={t("coord.keepBtn")}
                  tone="subtle"
                  disabled={busy}
                  theme={theme}
                  onPress={onDismissCancel}
                />
              </View>
            ) : (
              <PillButton
                icon="X"
                label={t("coord.actionCancel")}
                tone="subtle"
                disabled={busy}
                theme={theme}
                onPress={onRequestCancel}
              />
            )
          ) : null}
        </View>

        {(onViewTopology || onViewTrace) ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {onViewTopology ? (
              <PillButton
                icon="GitBranch"
                label={t("coord.viewInTopology")}
                tone="subtle"
                theme={theme}
                onPress={onViewTopology}
              />
            ) : null}
            {onViewTrace ? (
              <PillButton
                icon="List"
                label={t("coord.viewInTrace")}
                tone="subtle"
                theme={theme}
                onPress={onViewTrace}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {replyOpen && !subcard.canceled && subcard.status === "needs_me" ? (
        <View style={{ gap: 6 }}>
          {latestInbox ? (
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 7,
                backgroundColor: colors.surface1,
                borderWidth: 1,
                borderColor: colors.border,
                gap: 2,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, fontWeight: "600" }}>
                {latestInbox.from} ({latestInbox.kind})
              </Text>
              <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 17 }} numberOfLines={3}>
                {latestInbox.message}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
            <TextInput
              ref={inputRef}
              value={replyDraft}
              onChangeText={onChangeReply}
              editable={!busy}
              placeholder={t("coord.replyPlaceholder")}
              placeholderTextColor={colors.foregroundMuted}
              multiline
              onKeyPress={
                Platform.OS === "web"
                  ? (e) => {
                      const native = e.nativeEvent as { key?: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };
                      if (native.key === "Escape") {
                        onToggleReply();
                      } else if (native.key === "Enter" && (native.metaKey || native.ctrlKey || !native.shiftKey)) {
                        e.preventDefault?.();
                        if (replyDraft.trim() && !busy) {
                          onAction("reply", replyDraft.trim());
                        }
                      }
                    }
                  : undefined
              }
              style={{
                flex: 1,
                minHeight: 34,
                maxHeight: 88,
                color: colors.foreground,
                fontSize: 12.5,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 7,
                paddingHorizontal: 10,
                paddingVertical: 6,
                backgroundColor: colors.surface1,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
              }}
            />
            <PillButton
              icon="Send"
              label={t("coord.actionSend")}
              tone={replyDraft.trim() ? "primary" : "default"}
              disabled={busy || replyDraft.trim() === ""}
              theme={theme}
              onPress={() => onAction("reply", replyDraft.trim())}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function SubCardDetails({
  subcard,
  downstreamIds,
  theme,
  onSelectSubcard,
  onOpenArtifact,
}: {
  subcard: SubCard;
  downstreamIds: readonly string[];
  theme: PluginTheme;
  onSelectSubcard: (id: string) => void;
  onOpenArtifact: (relativePath: string, subcardId: string | null) => void;
}) {
  const { isZh, t } = useRadarI18n();
  const { colors } = theme;
  const upstreamIds = getUpstreamIds(subcard);
  const waitText = subcardWaitText(subcard, t("coord.waitBoardPrefix"));

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: colors.foreground, fontSize: 12.5, lineHeight: 19 }} selectable>
        {subcard.objective}
      </Text>

      {subcard.decisionProposal ? (
        <View
          style={{
            padding: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.statusWarning,
            backgroundColor: colors.surface1,
            gap: 4,
          }}
        >
          <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "700" }}>
            {t("coord.decisionSection")} · {subcard.decisionProposal.title}
          </Text>
          {subcard.decisionProposal.target ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
              {subcard.decisionProposal.target}
              {subcard.decisionProposal.impact ? ` · ${subcard.decisionProposal.impact}` : ""}
            </Text>
          ) : null}
          {subcard.decisionProposal.draft ? (
            <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 17 }} numberOfLines={4}>
              {subcard.decisionProposal.draft}
            </Text>
          ) : null}
        </View>
      ) : null}

      {subcard.inbox.length > 0 ? (
        <View style={{ gap: 5 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>
            {t("coord.inboxSection", { count: subcard.inbox.length })}
          </Text>
          <View style={{ gap: 4 }}>
            {subcard.inbox.slice(-5).map((msg) => (
              <View
                key={msg.id}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                  gap: 2,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "600" }}>
                    {msg.from} · {msg.kind}
                  </Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
                    {relativeTimeLabel(msg.at, isZh)}
                  </Text>
                </View>
                <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 17 }} selectable>
                  {msg.message}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
          <Text style={{ color: colors.statusSuccess, fontSize: 11.5, fontWeight: "600" }}>
            {t("coord.upstreamLabel")}:
          </Text>
          {upstreamIds.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>—</Text>
          ) : (
            upstreamIds.map((upId) => (
              <Pressable
                key={`up-${upId}`}
                accessibilityRole="button"
                onPress={() => onSelectSubcard(upId)}
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}>{upId}</Text>
              </Pressable>
            ))
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
          <Text style={{ color: colors.statusWarning, fontSize: 11.5, fontWeight: "600" }}>
            {t("coord.downstreamLabel")}:
          </Text>
          {downstreamIds.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>—</Text>
          ) : (
            downstreamIds.map((downId) => (
              <Pressable
                key={`down-${downId}`}
                accessibilityRole="button"
                onPress={() => onSelectSubcard(downId)}
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}>{downId}</Text>
              </Pressable>
            ))
          )}
        </View>
      </View>

      {subcard.requireReview || subcard.verifyCommand || subcard.selectedModel || subcard.gitBranch || subcard.commitSha ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {subcard.requireReview ? (
            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: colors.surface1 }}>
              <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "600" }}>
                {t("coord.requireReviewBadge")}
              </Text>
            </View>
          ) : null}
          {subcard.verifyCommand ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
              {t("coord.verifyCommandLabel")}: {subcard.verifyCommand}
            </Text>
          ) : null}
          {subcard.selectedModel ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
              Model: {shortModelName(subcard.selectedModel)}
            </Text>
          ) : null}
          {subcard.gitBranch || subcard.commitSha ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
              Branch: {subcard.gitBranch ?? "-"}
              {subcard.commitSha ? ` · SHA ${subcard.commitSha.slice(0, 7)}` : ""}
            </Text>
          ) : null}
        </View>
      ) : null}

      {waitText ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>{waitText}</Text>
      ) : null}

      {subcard.closureEvidence ? (
        <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>{subcard.closureEvidence}</Text>
      ) : null}

      {subcard.links.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            {t("coord.linksLabel")}:
          </Text>
          {subcard.links.map((lnk) => (
            <Pressable
              key={lnk.url}
              accessibilityRole="link"
              onPress={() => void openExternalUrl(lnk.url)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Icon name="Link2" size={11} color={colors.accent} />
              <Text style={{ color: colors.accent, fontSize: 11.5, fontWeight: "500" }}>
                {lnk.label ?? lnk.kind}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {subcard.artifacts.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {subcard.artifacts.map((art) => (
            <Pressable
              key={art.relativePath}
              accessibilityRole="button"
              onPress={() => onOpenArtifact(art.relativePath, subcard.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Icon name="FileText" size={11} color={colors.accent} />
              <Text style={{ color: colors.accent, fontSize: 11.5 }}>
                {art.relativePath} ({formatBytes(art.sizeBytes)})
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {subcard.startedAt ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
            {t("coord.startedAtLabel")}: {relativeTimeLabel(subcard.startedAt, isZh)}
          </Text>
        ) : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
          {t("coord.updatedAtLabel")}: {relativeTimeLabel(subcard.updatedAt, isZh)}
        </Text>
        {subcard.finishedAt ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
            {t("coord.finishedAtLabel")}: {relativeTimeLabel(subcard.finishedAt, isZh)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SubCardTile({
  subcard,
  downstreamIds,
  highlighted,
  expanded,
  theme,
  busy,
  replyOpen,
  replyDraft,
  confirmCancel,
  onToggleExpand,
  onChangeReply,
  onToggleReply,
  onRequestCancel,
  onDismissCancel,
  onAction,
  onOpenAgent,
  onOpenArtifact,
  onJumpSubcard,
  onViewTopology,
  onViewTrace,
}: {
  subcard: SubCard;
  downstreamIds: readonly string[];
  highlighted: boolean;
  expanded: boolean;
  theme: PluginTheme;
  busy: boolean;
  replyOpen: boolean;
  replyDraft: string;
  confirmCancel: boolean;
  onToggleExpand: () => void;
  onChangeReply: (text: string) => void;
  onToggleReply: () => void;
  onRequestCancel: () => void;
  onDismissCancel: () => void;
  onAction: (action: "start" | "reply" | "archive" | "cancel", text?: string) => void;
  onOpenAgent: ((agentId: string) => void) | null;
  onOpenArtifact: (relativePath: string, subcardId: string | null) => void;
  onJumpSubcard: (subcardId: string) => void;
  onViewTopology: () => void;
  onViewTrace: () => void;
}) {
  const { isZh, t } = useRadarI18n();
  const { colors } = theme;
  const tone = subcardToneColor(subcard, theme);
  const waitText = subcardWaitText(subcard, t("coord.waitBoardPrefix"));
  const upstream = getUpstreamIds(subcard);
  const isolationLabel =
    subcard.isolation === "worktree" ? t("coord.isolationWorktree") : t("coord.isolationReadonly");
  const latestInbox = subcard.inbox.length > 0 ? subcard.inbox[subcard.inbox.length - 1] : null;

  return (
    <View
      style={{
        borderWidth: highlighted ? 1.5 : 1,
        borderColor: highlighted
          ? colors.accent
          : subcard.status === "needs_me" && !subcard.canceled
            ? colors.statusWarning
            : colors.border,
        borderRadius: 10,
        backgroundColor: colors.surface0,
        padding: 12,
        gap: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onToggleExpand}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 180 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 11.5, fontWeight: "700" }}>
            {subcard.id}
          </Text>
          <Text
            style={{ color: colors.foreground, fontSize: 13.5, fontWeight: "600", flex: 1 }}
            numberOfLines={expanded ? undefined : 1}
          >
            {subcard.title}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: colors.surface1 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, fontWeight: "600" }}>
              {t("coord.waveLabel", { wave: subcard.wave })}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: colors.surface1 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
              {isolationLabel}
              {subcard.gitBranch ? ` · ${subcard.gitBranch}` : ""}
              {subcard.commitSha ? ` (${subcard.commitSha.slice(0, 7)})` : ""}
            </Text>
          </View>
          {subcard.selectedModel ? (
            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: colors.surface1 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
                {shortModelName(subcard.selectedModel)}
              </Text>
            </View>
          ) : null}
          {subcard.artifacts.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={(e) => {
                e.stopPropagation?.();
                if (subcard.artifacts.length === 1) {
                  onOpenArtifact(subcard.artifacts[0]!.relativePath, subcard.id);
                } else {
                  onViewTrace();
                }
              }}
              style={{
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: "600" }}>
                {t("coord.artifactsLabel", { count: subcard.artifacts.length })}
              </Text>
            </Pressable>
          ) : null}
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            size={14}
            color={colors.foregroundMuted}
          />
        </View>
      </Pressable>

      {expanded ? (
        <SubCardDetails
          subcard={subcard}
          downstreamIds={downstreamIds}
          theme={theme}
          onSelectSubcard={onJumpSubcard}
          onOpenArtifact={onOpenArtifact}
        />
      ) : (
        <>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 }} numberOfLines={2}>
            {subcard.objective}
          </Text>

          {!replyOpen && latestInbox && subcard.status === "needs_me" && !subcard.canceled ? (
            <View
              style={{
                paddingHorizontal: 9,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: colors.surface1,
                borderLeftWidth: 2,
                borderLeftColor: colors.statusWarning,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 11.5 }} numberOfLines={2}>
                <Text style={{ fontWeight: "600", color: colors.statusWarning }}>{latestInbox.from}: </Text>
                {latestInbox.message}
              </Text>
            </View>
          ) : null}

          {upstream.length > 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                {t("coord.upstreamLabel")}:
              </Text>
              {upstream.map((upId) => (
                <Pressable
                  key={`tile-up-${upId}`}
                  accessibilityRole="button"
                  onPress={() => onJumpSubcard(upId)}
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 1,
                    borderRadius: 4,
                    backgroundColor: colors.surface1,
                  }}
                >
                  <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "600" }}>{upId}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {waitText ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }} numberOfLines={2}>
              {waitText}
            </Text>
          ) : null}

          {subcard.closureEvidence ? (
            <Text style={{ color: colors.statusSuccess, fontSize: 11.5 }} numberOfLines={2}>
              {subcard.closureEvidence}
            </Text>
          ) : null}
        </>
      )}

      {subcard.canceled ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            {isZh ? "已取消" : "Canceled"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <PillButton icon="GitBranch" label={t("coord.viewInTopology")} tone="subtle" theme={theme} onPress={onViewTopology} />
            <PillButton icon="List" label={t("coord.viewInTrace")} tone="subtle" theme={theme} onPress={onViewTrace} />
          </View>
        </View>
      ) : (
        <SubCardActionBar
          subcard={subcard}
          theme={theme}
          busy={busy}
          replyOpen={replyOpen}
          replyDraft={replyDraft}
          confirmCancel={confirmCancel}
          onChangeReply={onChangeReply}
          onToggleReply={onToggleReply}
          onRequestCancel={onRequestCancel}
          onDismissCancel={onDismissCancel}
          onAction={onAction}
          onOpenAgent={onOpenAgent}
          onViewTopology={onViewTopology}
          onViewTrace={onViewTrace}
        />
      )}
    </View>
  );
}

export function CoordBoardScreen({
  cardId,
  hostId,
  theme,
  compact,
  onBack,
  onOpenAgent,
  onChanged,
}: {
  cardId: string;
  hostId: string;
  theme: PluginTheme;
  compact: boolean;
  onBack: () => void;
  onOpenAgent: ((agentId: string) => void) | null;
  onChanged: () => void;
}) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isZh, t } = useRadarI18n();
  const { colors } = theme;

  const loadDetail = useRpc(loadRadarCoordDetailRpc);
  const runAction = useRpc(coordSubcardActionRpc);
  const readArtifact = useRpc(readRadarCoordArtifactRpc);
  const toggleCoord = useRpc(toggleRadarCoordRpc);

  const [tab, setTab] = useState<CoordTab>("board");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<BoardStatusFilter>("all");
  const [expandedSubcards, setExpandedSubcards] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [highlightedSubcardId, setHighlightedSubcardId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [traceFilterId, setTraceFilterId] = useState<string | "all" | "shared">("all");
  const [eventCategory, setEventCategory] = useState<EventCategoryFilter>("all");
  const [expandedEventIds, setExpandedEventIds] = useState<Record<string, boolean>>({});
  const [busySubcardId, setBusySubcardId] = useState<string | null>(null);
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [confirmExitCoord, setConfirmExitCoord] = useState(false);
  const [togglingOff, setTogglingOff] = useState(false);

  const [artifactModal, setArtifactModal] = useState<{
    open: boolean;
    loading: boolean;
    relativePath: string;
    subcardId: string | null;
    content: string;
    truncated: boolean;
    sizeBytes: number;
  }>({
    open: false,
    loading: false,
    relativePath: "",
    subcardId: null,
    content: "",
    truncated: false,
    sizeBytes: 0,
  });

  useEffect(() => {
    if (Platform.OS !== "web" || !artifactModal.open) return;
    const win = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: { key?: string }) => void) => void;
      removeEventListener?: (type: string, fn: (e: { key?: string }) => void) => void;
    };
    const onKeyDown = (e: { key?: string }) => {
      if (e.key === "Escape") {
        setArtifactModal((prev) => ({ ...prev, open: false }));
      }
    };
    win.addEventListener?.("keydown", onKeyDown);
    return () => win.removeEventListener?.("keydown", onKeyDown);
  }, [artifactModal.open]);

  const detailQueryKey = ["paseo-radar", "coord-detail", hostId, cardId] as const;
  const detailQuery = useQuery<CoordBoardDetail>({
    queryKey: detailQueryKey,
    queryFn: () => loadDetail({ cardId, eventLimit: 200 }),
    refetchInterval: 4000,
  });

  const detail = detailQuery.data ?? null;
  const subcards = detail?.board.subcards ?? [];
  const subcardById = useMemo(() => new Map(subcards.map((s) => [s.id, s])), [subcards]);
  const downstreamMap = useMemo(() => computeDownstreamMap(subcards), [subcards]);

  const effectiveSelectedId =
    selectedNodeId && subcardById.has(selectedNodeId) ? selectedNodeId : (subcards[0]?.id ?? null);
  const selectedSubcard = effectiveSelectedId ? subcardById.get(effectiveSelectedId) ?? null : null;
  const selectedUpstreamSet = useMemo(
    () => new Set(selectedSubcard ? getUpstreamIds(selectedSubcard) : []),
    [selectedSubcard],
  );
  const selectedDownstreamSet = useMemo(
    () => new Set(selectedSubcard ? (downstreamMap.get(selectedSubcard.id) ?? []) : []),
    [downstreamMap, selectedSubcard],
  );

  function invalidateBoth(): void {
    void queryClient.invalidateQueries({ queryKey: detailQueryKey });
    onChanged();
  }

  function handleSubcardAction(
    subcardId: string,
    action: "start" | "reply" | "archive" | "cancel",
    text?: string,
  ): void {
    if (busySubcardId) return;
    setBusySubcardId(subcardId);
    setConfirmCancelId(null);
    runAction({ cardId, subcardId, action, ...(text ? { text } : {}) })
      .then((res) => {
        queryClient.setQueryData(detailQueryKey, res.detail);
        if (action === "reply") {
          setReplyDrafts((prev) => ({ ...prev, [subcardId]: "" }));
          setReplyOpenId(null);
        }
        onChanged();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusySubcardId(null));
  }

  function handleOpenArtifact(relativePath: string, subcardId: string | null = null): void {
    setArtifactModal({
      open: true,
      loading: true,
      relativePath,
      subcardId,
      content: "",
      truncated: false,
      sizeBytes: 0,
    });
    readArtifact({ cardId, relativePath })
      .then((res) => {
        setArtifactModal({
          open: true,
          loading: false,
          relativePath: res.relativePath,
          subcardId,
          content: res.content,
          truncated: res.truncated,
          sizeBytes: res.sizeBytes,
        });
      })
      .catch((err: unknown) => {
        setArtifactModal((prev) => ({ ...prev, open: false, loading: false }));
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }

  function handleExitCoord(): void {
    if (togglingOff) return;
    setTogglingOff(true);
    setConfirmExitCoord(false);
    toggleCoord({ itemId: cardId, enabled: false, steerNow: false })
      .then((res) => {
        setCachedRadarSnapshot(paseo, res.snapshot);
        onChanged();
        onBack();
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setTogglingOff(false));
  }

  function handleJumpToSubcard(targetId: string): void {
    if (!subcardById.has(targetId)) return;
    setStatusFilter("all");
    setSearchQuery("");
    setExpandedSubcards((prev) => ({ ...prev, [targetId]: true }));
    setHighlightedSubcardId(targetId);
    const target = subcardById.get(targetId)!;
    const groupKey = target.canceled || target.status === "archived" ? "done" : target.status;
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: false }));
  }

  function openTopologyForSubcard(subcardId: string): void {
    setSelectedNodeId(subcardId);
    setTab("flow");
  }

  function openTraceForSubcard(subcardId: string): void {
    setTraceFilterId(subcardId);
    setTab("trace");
  }

  const allArtifacts = useMemo<ArtifactItemView[]>(() => {
    if (!detail) return [];
    const out: ArtifactItemView[] = detail.sharedFiles.map((entry) => ({
      key: `shared:${entry.relativePath}`,
      subcardId: null,
      entry,
    }));
    for (const s of detail.board.subcards) {
      for (const entry of s.artifacts) {
        out.push({
          key: `${s.id}:${entry.relativePath}`,
          subcardId: s.id,
          entry,
        });
      }
    }
    return out;
  }, [detail]);

  const filteredArtifacts = useMemo(() => {
    if (traceFilterId === "all") return allArtifacts;
    if (traceFilterId === "shared") return allArtifacts.filter((a) => a.subcardId === null);
    return allArtifacts.filter((a) => a.subcardId === traceFilterId);
  }, [allArtifacts, traceFilterId]);

  const filteredEvents = useMemo(() => {
    const events = detail?.events ? [...detail.events].reverse() : [];
    return events.filter((e) => {
      if (traceFilterId !== "all" && traceFilterId !== "shared") {
        if (e.subcardId !== traceFilterId && e.actor !== traceFilterId) return false;
      }
      return matchesEventCategory(e.kind, eventCategory);
    });
  }, [detail?.events, traceFilterId, eventCategory]);

  const filteredBoardSubcards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return subcards.filter((s) => {
      const groupKey = s.canceled || s.status === "archived" ? "done" : s.status;
      if (statusFilter === "board") {
        if (groupKey !== "needs_me" && groupKey !== "running" && groupKey !== "waiting_external") return false;
      } else if (statusFilter !== "all") {
        if (groupKey !== statusFilter) return false;
      }
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.objective.toLowerCase().includes(q) ||
        (s.gitBranch?.toLowerCase().includes(q) ?? false) ||
        (s.selectedModel?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [subcards, statusFilter, searchQuery]);

  const boardGroups = useMemo(() => {
    const needsCoord = filteredBoardSubcards.filter((s) => !s.canceled && s.status === "needs_me");
    const running = filteredBoardSubcards.filter((s) => !s.canceled && s.status === "running");
    const waiting = filteredBoardSubcards.filter((s) => !s.canceled && s.status === "waiting_external");
    const pool = filteredBoardSubcards.filter((s) => !s.canceled && s.status === "pool");
    const done = filteredBoardSubcards.filter((s) => s.canceled || s.status === "archived");
    return [
      { key: "needs_me", title: t("coord.groupNeedsCoord"), items: needsCoord },
      { key: "running", title: t("coord.groupRunning"), items: running },
      { key: "waiting", title: t("coord.groupWaiting"), items: waiting },
      { key: "pool", title: t("coord.groupPool"), items: pool },
      { key: "done", title: t("coord.groupDone"), items: done },
    ].filter((g) => g.items.length > 0);
  }, [filteredBoardSubcards, t]);

  const statusCounts = useMemo(() => {
    const counts = { needs_me: 0, running: 0, waiting_external: 0, pool: 0, done: 0 };
    for (const s of subcards) {
      if (s.canceled || s.status === "archived") counts.done++;
      else if (s.status === "needs_me") counts.needs_me++;
      else if (s.status === "running") counts.running++;
      else if (s.status === "waiting_external") counts.waiting_external++;
      else if (s.status === "pool") counts.pool++;
    }
    return counts;
  }, [subcards]);

  const hasActiveFilters = searchQuery.trim() !== "" || statusFilter !== "all";
  const allExpanded =
    filteredBoardSubcards.length > 0 && filteredBoardSubcards.every((s) => Boolean(expandedSubcards[s.id]));

  function toggleExpandAll(): void {
    if (allExpanded) {
      setExpandedSubcards({});
    } else {
      const next: Record<string, boolean> = { ...expandedSubcards };
      for (const s of filteredBoardSubcards) next[s.id] = true;
      setExpandedSubcards(next);
    }
  }

  function handleCopyArtifact(): void {
    if (Platform.OS !== "web") return;
    const nav = (globalThis as unknown as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator;
    if (!nav?.clipboard?.writeText) return;
    void nav.clipboard.writeText(artifactModal.content).then(() => {
      toast.show(t("coord.copiedToast"), { variant: "success" });
    });
  }

  const activeBoardCount = statusCounts.needs_me + statusCounts.running + statusCounts.waiting_external;
  const statusFilterChips: Array<{ key: BoardStatusFilter; label: string; count: number; dividerBefore?: boolean }> = [
    { key: "pool", label: t("coord.statusTabPool"), count: statusCounts.pool },
    { key: "needs_me", label: t("coord.statusTabNeedsMe"), count: statusCounts.needs_me },
    { key: "running", label: t("coord.statusTabRunning"), count: statusCounts.running },
    { key: "waiting_external", label: t("coord.statusTabWaiting"), count: statusCounts.waiting_external },
    { key: "board", label: t("coord.statusTabBoard"), count: activeBoardCount, dividerBefore: true },
    { key: "all", label: t("coord.statusTabAll"), count: subcards.length },
    { key: "done", label: t("coord.statusTabDone"), count: statusCounts.done },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      {/* Breadcrumb & Header Controls */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
          gap: 10,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.surface0,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
            <PillButton icon="ArrowLeft" label={t("coord.backToRadar")} theme={theme} onPress={onBack} />
            <Icon name="GitBranch" size={16} color={colors.accent} />
            <Text style={{ color: colors.foreground, fontSize: compact ? 15 : 17, fontWeight: "700", flex: 1 }} numberOfLines={1}>
              {detail?.cardTitle ?? cardId}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {detail?.board.coordinatorAgentId && onOpenAgent ? (
              <PillButton
                icon="ArrowUpRight"
                label={t("coord.openCoordSession")}
                tone="primary"
                theme={theme}
                onPress={() => onOpenAgent(detail.board.coordinatorAgentId!)}
              />
            ) : null}
            <PillButton icon="RefreshCw" label={t("coord.refresh")} theme={theme} onPress={invalidateBoth} />
            {confirmExitCoord ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <PillButton
                  icon="Power"
                  label={t("coord.confirmDisableBtn")}
                  tone="danger"
                  disabled={togglingOff}
                  theme={theme}
                  onPress={handleExitCoord}
                />
                <PillButton
                  label={t("coord.keepBtn")}
                  tone="subtle"
                  disabled={togglingOff}
                  theme={theme}
                  onPress={() => setConfirmExitCoord(false)}
                />
              </View>
            ) : (
              <PillButton
                icon="Power"
                label={t("coord.disableBtn")}
                tone="subtle"
                disabled={togglingOff}
                theme={theme}
                onPress={() => setConfirmExitCoord(true)}
              />
            )}
          </View>
        </View>

        {detail ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 999,
                backgroundColor: colors.surface1,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 11.5, fontWeight: "600" }}>
                {t("coord.badge", { archived: detail.summary.archived, total: detail.summary.total })}
              </Text>
            </View>
            {statusCounts.needs_me > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setTab("board");
                  setStatusFilter((cur) => (cur === "needs_me" ? "all" : "needs_me"));
                }}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: colors.statusWarning,
                  backgroundColor: colors.surface1,
                }}
              >
                <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "600" }}>
                  {t("coord.badgeNeedsCoord")} ({statusCounts.needs_me})
                </Text>
              </Pressable>
            ) : null}
            {statusCounts.running > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setTab("board");
                  setStatusFilter((cur) => (cur === "running" ? "all" : "running"));
                }}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "600" }}>
                  {t("coord.badgeRunning", { count: statusCounts.running })}
                </Text>
              </Pressable>
            ) : null}
            {statusCounts.waiting_external > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setTab("board");
                  setStatusFilter((cur) => (cur === "waiting_external" ? "all" : "waiting_external"));
                }}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                  {t("coord.badgeWaiting", { count: statusCounts.waiting_external })}
                </Text>
              </Pressable>
            ) : null}
            {detail.summary.frontlineText ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12.5, flex: 1, minWidth: 180 }} numberOfLines={2}>
                {detail.summary.frontlineText}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* 3 Switchable Tabs */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {(
            [
              {
                id: "board" as const,
                icon: "LayoutGrid" as const,
                label: subcards.length > 0 ? `${t("coord.tabBoard")} (${subcards.length})` : t("coord.tabBoard"),
              },
              {
                id: "flow" as const,
                icon: "GitBranch" as const,
                label:
                  detail && detail.waves.length > 0
                    ? `${t("coord.tabTopology")} (${detail.waves.length})`
                    : t("coord.tabTopology"),
              },
              {
                id: "trace" as const,
                icon: "List" as const,
                label:
                  detail && (detail.events.length > 0 || allArtifacts.length > 0)
                    ? `${t("coord.tabTrace")} (${detail.events.length}/${allArtifacts.length})`
                    : t("coord.tabTrace"),
              },
            ] as const
          ).map((itemTab) => {
            const active = tab === itemTab.id;
            return (
              <Pressable
                key={itemTab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setTab(itemTab.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 11,
                  paddingVertical: 6,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.surface2 : colors.surface1,
                }}
              >
                <Icon name={itemTab.icon} size={13} color={active ? colors.accent : colors.foregroundMuted} />
                <Text
                  style={{
                    color: active ? colors.foreground : colors.foregroundMuted,
                    fontSize: 12.5,
                    fontWeight: active ? "600" : "500",
                  }}
                >
                  {itemTab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 36 }}>
        <View style={{ width: "100%", maxWidth: tab === "flow" ? undefined : 1120, alignSelf: "center", gap: 14 }}>
          {detailQuery.isLoading && !detail ? (
            <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
              <ActivityIndicator color={colors.accent} />
              <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("coord.loading")}</Text>
            </View>
          ) : !detail ? (
            <View style={{ padding: 32, alignItems: "center" }}>
              <Text style={{ color: colors.statusDanger, fontSize: 13 }}>
                {detailQuery.error instanceof Error ? detailQuery.error.message : "Failed to load board"}
              </Text>
            </View>
          ) : tab === "board" ? (
            subcards.length === 0 ? (
              <View style={{ padding: 32, alignItems: "center" }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("coord.emptyBoard")}</Text>
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                {/* Search & Filter Toolbar */}
                <View style={{ gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <View
                      style={{
                        flex: 1,
                        minWidth: 200,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface1,
                      }}
                    >
                      <Icon name="Search" size={13} color={colors.foregroundMuted} />
                      <TextInput
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t("coord.searchPlaceholder")}
                        placeholderTextColor={colors.foregroundMuted}
                        style={{
                          flex: 1,
                          color: colors.foreground,
                          fontSize: 12.5,
                          paddingVertical: 2,
                          ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
                        }}
                      />
                      {searchQuery ? (
                        <Pressable accessibilityRole="button" onPress={() => setSearchQuery("")}>
                          <Icon name="X" size={13} color={colors.foregroundMuted} />
                        </Pressable>
                      ) : null}
                    </View>
                    <PillButton
                      icon={allExpanded ? "ChevronUp" : "ChevronDown"}
                      label={allExpanded ? t("coord.collapseAll") : t("coord.expandAll")}
                      tone="default"
                      theme={theme}
                      onPress={toggleExpandAll}
                    />
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    {statusFilterChips.map((chip) => {
                      const active = statusFilter === chip.key;
                      const dimmed = chip.count === 0 && !active;
                      return (
                        <View key={chip.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          {chip.dividerBefore ? (
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
                            accessibilityState={{ selected: active }}
                            onPress={() => setStatusFilter(chip.key)}
                            style={{
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 999,
                              borderWidth: 1,
                              borderColor: colors.border,
                              backgroundColor: active ? colors.surface2 : "transparent",
                              opacity: dimmed ? 0.48 : 1,
                            }}
                          >
                            <Text
                              style={{
                                color: active ? colors.foreground : colors.foregroundMuted,
                                fontSize: 12,
                                fontWeight: active ? "600" : "400",
                              }}
                            >
                              {chip.label} ({chip.count})
                            </Text>
                          </Pressable>
                        </View>
                      );
                    })}
                  </View>
                </View>

                {boardGroups.length === 0 ? (
                  <View style={{ padding: 28, alignItems: "center", gap: 8 }}>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
                      {t("coord.noMatchingSubcards")}
                    </Text>
                    {hasActiveFilters ? (
                      <PillButton
                        label={t("coord.clearFilters")}
                        tone="default"
                        theme={theme}
                        onPress={() => {
                          setSearchQuery("");
                          setStatusFilter("all");
                        }}
                      />
                    ) : null}
                  </View>
                ) : (
                  boardGroups.map((group) => {
                    const hasActiveSubcards = subcards.some((s) => !s.canceled && s.status !== "archived");
                    const defaultCollapsed = group.key === "done" && hasActiveSubcards && statusFilter !== "done" && !searchQuery.trim();
                    const isCollapsed = collapsedGroups[group.key] ?? defaultCollapsed;
                    return (
                      <View key={group.key} style={{ gap: 8 }}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            setCollapsedGroups((prev) => ({
                              ...prev,
                              [group.key]: !isCollapsed,
                            }))
                          }
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                            paddingVertical: 2,
                          }}
                        >
                          <Icon
                            name={isCollapsed ? "ChevronDown" : "ChevronUp"}
                            size={14}
                            color={colors.foregroundMuted}
                          />
                          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                            {group.title} ({group.items.length})
                          </Text>
                        </Pressable>
                        {!isCollapsed ? (
                          <View style={{ gap: 8 }}>
                            {group.items.map((sub) => (
                              <SubCardTile
                                key={sub.id}
                                subcard={sub}
                                downstreamIds={downstreamMap.get(sub.id) ?? []}
                                highlighted={highlightedSubcardId === sub.id}
                                expanded={Boolean(expandedSubcards[sub.id])}
                                theme={theme}
                                busy={busySubcardId === sub.id}
                                replyOpen={replyOpenId === sub.id}
                                replyDraft={replyDrafts[sub.id] ?? ""}
                                confirmCancel={confirmCancelId === sub.id}
                                onToggleExpand={() => {
                                  setHighlightedSubcardId(null);
                                  setExpandedSubcards((prev) => ({ ...prev, [sub.id]: !prev[sub.id] }));
                                }}
                                onChangeReply={(text) => setReplyDrafts((prev) => ({ ...prev, [sub.id]: text }))}
                                onToggleReply={() => setReplyOpenId((cur) => (cur === sub.id ? null : sub.id))}
                                onRequestCancel={() => setConfirmCancelId(sub.id)}
                                onDismissCancel={() => setConfirmCancelId(null)}
                                onAction={(act, text) => handleSubcardAction(sub.id, act, text)}
                                onOpenAgent={onOpenAgent}
                                onOpenArtifact={handleOpenArtifact}
                                onJumpSubcard={handleJumpToSubcard}
                                onViewTopology={() => openTopologyForSubcard(sub.id)}
                                onViewTrace={() => openTraceForSubcard(sub.id)}
                              />
                            ))}
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                )}
              </View>
            )
          ) : tab === "flow" ? (
            detail.waves.length === 0 ? (
              <View style={{ padding: 32, alignItems: "center" }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{t("coord.emptyBoard")}</Text>
              </View>
            ) : (
              <CoordTopologySection
                title={detail.cardTitle ?? cardId}
                waves={detail.waves}
                subcards={subcards}
                selectedSubcard={selectedSubcard}
                selectedUpstreamSet={selectedUpstreamSet}
                selectedDownstreamSet={selectedDownstreamSet}
                compact={compact}
                theme={theme}
                onSelectNode={(id) => setSelectedNodeId(id)}
                renderInspector={(subcard) => (
                  <>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <Text style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "700" }}>
                        {subcard.id} · {subcard.title}
                      </Text>
                      <Text style={{ color: subcardToneColor(subcard, theme), fontSize: 12, fontWeight: "600" }}>
                        {subcard.canceled
                          ? isZh
                            ? "已取消"
                            : "Canceled"
                          : statusLabelForLocale(subcard.status, isZh)}
                      </Text>
                    </View>

                    <SubCardDetails
                      subcard={subcard}
                      downstreamIds={downstreamMap.get(subcard.id) ?? []}
                      theme={theme}
                      onSelectSubcard={(id) => setSelectedNodeId(id)}
                      onOpenArtifact={handleOpenArtifact}
                    />

                    {!subcard.canceled ? (
                      <SubCardActionBar
                        subcard={subcard}
                        theme={theme}
                        busy={busySubcardId === subcard.id}
                        replyOpen={replyOpenId === subcard.id}
                        replyDraft={replyDrafts[subcard.id] ?? ""}
                        confirmCancel={confirmCancelId === subcard.id}
                        onChangeReply={(text) =>
                          setReplyDrafts((prev) => ({ ...prev, [subcard.id]: text }))
                        }
                        onToggleReply={() =>
                          setReplyOpenId((cur) => (cur === subcard.id ? null : subcard.id))
                        }
                        onRequestCancel={() => setConfirmCancelId(subcard.id)}
                        onDismissCancel={() => setConfirmCancelId(null)}
                        onAction={(act, text) => handleSubcardAction(subcard.id, act, text)}
                        onOpenAgent={onOpenAgent}
                        onViewTrace={() => openTraceForSubcard(subcard.id)}
                      />
                    ) : (
                      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                        <PillButton
                          icon="List"
                          label={t("coord.viewInTrace")}
                          tone="subtle"
                          theme={theme}
                          onPress={() => openTraceForSubcard(subcard.id)}
                        />
                      </View>
                    )}
                  </>
                )}
              />
            )
          ) : (
            /* Tab: trace */
            <View style={{ gap: 16 }}>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setTraceFilterId("all")}
                    style={{
                      paddingHorizontal: 9,
                      paddingVertical: 4,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: traceFilterId === "all" ? colors.accent : colors.border,
                      backgroundColor: traceFilterId === "all" ? colors.surface2 : colors.surface1,
                    }}
                  >
                    <Text
                      style={{
                        color: traceFilterId === "all" ? colors.foreground : colors.foregroundMuted,
                        fontSize: 11.5,
                        fontWeight: "600",
                      }}
                    >
                      {t("coord.allFilter")}
                    </Text>
                  </Pressable>
                  {detail.sharedFiles.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setTraceFilterId("shared")}
                      style={{
                        paddingHorizontal: 9,
                        paddingVertical: 4,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: traceFilterId === "shared" ? colors.accent : colors.border,
                        backgroundColor: traceFilterId === "shared" ? colors.surface2 : colors.surface1,
                      }}
                    >
                      <Text
                        style={{
                          color: traceFilterId === "shared" ? colors.foreground : colors.foregroundMuted,
                          fontSize: 11.5,
                          fontWeight: traceFilterId === "shared" ? "600" : "500",
                        }}
                      >
                        {t("coord.sharedFilesFilter")} ({detail.sharedFiles.length})
                      </Text>
                    </Pressable>
                  ) : null}
                  {subcards.map((s) => {
                    const active = traceFilterId === s.id;
                    const tone = subcardToneColor(s, theme);
                    return (
                      <Pressable
                        key={`flt-${s.id}`}
                        accessibilityRole="button"
                        onPress={() => setTraceFilterId(s.id)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 5,
                          paddingHorizontal: 9,
                          paddingVertical: 4,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: active ? colors.accent : colors.border,
                          backgroundColor: active ? colors.surface2 : colors.surface1,
                        }}
                      >
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone }} />
                        <Text
                          style={{
                            color: active ? colors.foreground : colors.foregroundMuted,
                            fontSize: 11.5,
                            fontWeight: active ? "600" : "500",
                          }}
                        >
                          {s.id}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {(
                    [
                      { key: "all" as const, label: t("coord.eventFilterAll") },
                      { key: "lifecycle" as const, label: t("coord.eventFilterLifecycle") },
                      { key: "wait" as const, label: t("coord.eventFilterWait") },
                      { key: "collab" as const, label: t("coord.eventFilterCollab") },
                    ] as const
                  ).map((cat) => {
                    const active = eventCategory === cat.key;
                    return (
                      <Pressable
                        key={cat.key}
                        accessibilityRole="button"
                        onPress={() => setEventCategory(cat.key)}
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 6,
                          borderWidth: 1,
                          borderColor: active ? colors.accent : colors.border,
                          backgroundColor: active ? colors.surface2 : colors.surface0,
                        }}
                      >
                        <Text
                          style={{
                            color: active ? colors.foreground : colors.foregroundMuted,
                            fontSize: 11,
                            fontWeight: active ? "600" : "500",
                          }}
                        >
                          {cat.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                  {t("coord.artifactsSection", { count: filteredArtifacts.length })}
                </Text>
                {filteredArtifacts.length === 0 ? (
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12.5 }}>{t("coord.noArtifacts")}</Text>
                ) : (
                  <View style={{ gap: 6 }}>
                    {filteredArtifacts.map((item) => (
                      <Pressable
                        key={item.key}
                        accessibilityRole="button"
                        onPress={() => handleOpenArtifact(item.entry.relativePath, item.subcardId)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: colors.border,
                          backgroundColor: colors.surface0,
                        }}
                      >
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.surface1 }}>
                              <Text style={{ color: colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>
                                {item.subcardId ?? t("coord.sharedBadge")}
                              </Text>
                            </View>
                            <Text style={{ color: colors.accent, fontSize: 12.5, fontWeight: "600" }}>
                              {item.entry.relativePath}
                            </Text>
                          </View>
                          {item.entry.note ? (
                            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }} numberOfLines={1}>
                              {item.entry.note}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                          {formatBytes(item.entry.sizeBytes)} · {relativeTimeLabel(item.entry.updatedAt, isZh)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>

              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                  {t("coord.eventsSection", { count: filteredEvents.length })}
                </Text>
                {filteredEvents.length === 0 ? (
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12.5 }}>{t("coord.noEvents")}</Text>
                ) : (
                  <View style={{ gap: 6 }}>
                    {filteredEvents.map((ev) => {
                      const hasDetail = Boolean(ev.detail && Object.keys(ev.detail).length > 0);
                      const detailOpen = Boolean(expandedEventIds[ev.id]);
                      return (
                        <Pressable
                          key={ev.id}
                          disabled={!hasDetail}
                          onPress={() => {
                            if (!hasDetail) return;
                            setExpandedEventIds((prev) => ({ ...prev, [ev.id]: !prev[ev.id] }));
                          }}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: colors.border,
                            backgroundColor: colors.surface0,
                            gap: 4,
                          }}
                        >
                          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>{ev.kind}</Text>
                              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                                {ev.actor}
                                {ev.subcardId && ev.subcardId !== ev.actor ? ` → ${ev.subcardId}` : ""}
                                {ev.causedBy ? ` (by ${ev.causedBy})` : ""}
                              </Text>
                              {ev.subcardId && traceFilterId !== ev.subcardId ? (
                                <Pressable
                                  accessibilityRole="button"
                                  onPress={(e) => {
                                    e.stopPropagation?.();
                                    setTraceFilterId(ev.subcardId!);
                                  }}
                                  style={{
                                    paddingHorizontal: 5,
                                    paddingVertical: 1,
                                    borderRadius: 4,
                                    backgroundColor: colors.surface1,
                                  }}
                                >
                                  <Text style={{ color: colors.accent, fontSize: 10, fontWeight: "600" }}>
                                    {ev.subcardId}
                                  </Text>
                                </Pressable>
                              ) : null}
                            </View>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                              <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
                                {relativeTimeLabel(ev.at, isZh)}
                              </Text>
                              {hasDetail ? (
                                <Icon
                                  name={detailOpen ? "ChevronUp" : "ChevronDown"}
                                  size={12}
                                  color={colors.foregroundMuted}
                                />
                              ) : null}
                            </View>
                          </View>
                          <Text style={{ color: colors.foreground, fontSize: 12.5, lineHeight: 17 }}>{ev.summary}</Text>
                          {hasDetail && detailOpen ? (
                            <Text
                              selectable
                              style={{
                                color: colors.foregroundMuted,
                                fontSize: 11,
                                lineHeight: 16,
                                padding: 8,
                                borderRadius: 6,
                                backgroundColor: colors.surface1,
                                fontFamily: Platform.OS === "web" ? "monospace" : undefined,
                              }}
                            >
                              {JSON.stringify(ev.detail, null, 2)}
                            </Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      <Modal
        title={artifactModal.relativePath || "Artifact"}
        open={artifactModal.open}
        onOpenChange={(next) => {
          if (!next) setArtifactModal((prev) => ({ ...prev, open: false }));
        }}
      >
        <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 16, gap: 10 }}>
          {artifactModal.loading ? (
            <View style={{ padding: 24, alignItems: "center" }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                  {artifactModal.subcardId ? `${artifactModal.subcardId} · ` : `${t("coord.sharedBadge")} · `}
                  {formatBytes(artifactModal.sizeBytes)}
                  {artifactModal.truncated ? ` · ${t("coord.artifactTruncated")}` : ""}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {Platform.OS === "web" ? (
                    <PillButton
                      icon="Copy"
                      label={t("coord.copyContent")}
                      theme={theme}
                      onPress={handleCopyArtifact}
                    />
                  ) : null}
                  <PillButton
                    label={t("coord.closeModal")}
                    theme={theme}
                    onPress={() => setArtifactModal((prev) => ({ ...prev, open: false }))}
                  />
                </View>
              </View>
              <ScrollView
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 8,
                  backgroundColor: colors.surface1,
                }}
                contentContainerStyle={{ padding: 12 }}
              >
                <Text
                  selectable
                  style={{
                    color: colors.foreground,
                    fontSize: 12,
                    lineHeight: 18,
                    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
                  }}
                >
                  {artifactModal.content}
                </Text>
              </ScrollView>
            </>
          )}
        </Modal.Content>
      </Modal>
    </View>
  );
}
