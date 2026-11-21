import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";

import { askCopilotRpc, resetCopilotRpc, stopCopilotRpc, type CopilotSummary } from "../shared/radar";
import { useRadarI18n } from "./i18n";

interface ChatMessage {
  key: string;
  role: "user" | "assistant" | "tool";
  text: string;
  optimistic?: boolean;
}

export function CopilotPane({
  copilot,
  fullWidth = false,
  theme,
  onChanged,
  onOpenAgent,
  onCollapse,
}: {
  copilot: CopilotSummary | null;
  fullWidth?: boolean;
  theme: PluginTheme;
  onChanged: () => void;
  onOpenAgent: ((agentId: string) => void) | null;
  onCollapse: () => void;
}) {
  const paseo = usePaseo();
  const askCopilot = useRpc(askCopilotRpc);
  const resetCopilot = useRpc(resetCopilotRpc);
  const stopCopilot = useRpc(stopCopilotRpc);
  const toast = useToast();
  const { isZh, t } = useRadarI18n();

  const [overrideAgentId, setOverrideAgentId] = useState<string | null>(null);
  const [serverMessages, setServerMessages] = useState<ChatMessage[]>([]);
  const [pendingUserMsgs, setPendingUserMsgs] = useState<Array<{ key: string; text: string }>>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [waitingReply, setWaitingReply] = useState(false);
  const [resetting, setResetting] = useState(false);
  const scrollRef = useRef<any>(null);

  const agentId = overrideAgentId ?? copilot?.id ?? null;

  const quickPrompts = useMemo(
    () => [
      { label: t("copilot.quick1Label"), prompt: t("copilot.quick1Prompt") },
      { label: t("copilot.quick2Label"), prompt: t("copilot.quick2Prompt") },
    ],
    [t],
  );

  useEffect(() => {
    if (copilot?.id && copilot.id === overrideAgentId) {
      setOverrideAgentId(null);
    }
  }, [copilot?.id, overrideAgentId]);

  const isBusy =
    sending ||
    waitingReply ||
    copilot?.status === "running" ||
    copilot?.status === "initializing";

  useEffect(() => {
    if (!agentId) {
      setServerMessages([]);
      return;
    }
    const timeline = paseo.agents.ref(agentId).timeline;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function loadTimeline(): Promise<void> {
      try {
        const page = await timeline.refetch({ direction: "tail", limit: 80, projection: "projected" });
        if (!alive) return;
        const parsed: ChatMessage[] = [];
        const toolPrefix = isZh ? "调用工具：" : "Tools: ";
        for (const entry of page.entries) {
          const item = entry.item as { id?: string; type?: string; text?: string; name?: string };
          if (item.type === "user_message" && typeof item.text === "string") {
            parsed.push({ key: item.id ?? String(parsed.length), role: "user", text: item.text });
          } else if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim() !== "") {
            const prev = parsed[parsed.length - 1];
            if (prev && prev.role === "assistant") {
              prev.text = `${prev.text}${item.text}`;
            } else {
              parsed.push({ key: item.id ?? String(parsed.length), role: "assistant", text: item.text });
            }
          } else if (item.type === "tool_call" && typeof item.name === "string") {
            const prev = parsed[parsed.length - 1];
            const label = `${toolPrefix}${item.name}`;
            if (prev && prev.role === "tool") {
              if (!prev.text.includes(item.name)) prev.text = `${prev.text} · ${item.name}`;
            } else {
              parsed.push({ key: item.id ?? String(parsed.length), role: "tool", text: label });
            }
          }
        }
        setServerMessages(parsed);

        const serverUserTexts = new Set(
          parsed.filter((m) => m.role === "user").map((m) => m.text.trim()),
        );
        setPendingUserMsgs((cur) => {
          const left = cur.filter((p) => !serverUserTexts.has(p.text.trim()));
          return left.length === cur.length ? cur : left;
        });

        const agentSnap = page.agent as { status?: string } | null;
        const lastRow = parsed[parsed.length - 1];
        if (
          (lastRow && lastRow.role !== "user") ||
          (agentSnap && agentSnap.status !== "running" && agentSnap.status !== "initializing" && serverUserTexts.size > 0)
        ) {
          setWaitingReply(false);
        }
      } catch {
        // Ignore transient refetch errors
      }
    }

    function scheduleLoad(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void loadTimeline();
      }, 120);
    }

    void loadTimeline();
    const unsubscribe = timeline.subscribe(scheduleLoad);
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [paseo, agentId, copilot?.updatedAt, isZh]);

  const combinedMessages = useMemo<ChatMessage[]>(() => {
    if (pendingUserMsgs.length === 0) return serverMessages;
    return [
      ...serverMessages,
      ...pendingUserMsgs.map((p) => ({
        key: p.key,
        role: "user" as const,
        text: p.text,
        optimistic: true,
      })),
    ];
  }, [serverMessages, pendingUserMsgs]);

  function sendText(rawText: string): void {
    const text = rawText.trim();
    if (!text || sending) return;

    const optKey = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (rawText === draft) setDraft("");
    setPendingUserMsgs((cur) => [...cur, { key: optKey, text }]);
    setSending(true);
    setWaitingReply(true);

    askCopilot({ text })
      .then((res) => {
        if (res.agentId && res.agentId !== agentId) {
          setOverrideAgentId(res.agentId);
        }
        onChanged();
      })
      .catch((err: unknown) => {
        setPendingUserMsgs((cur) => cur.filter((p) => p.key !== optKey));
        setWaitingReply(false);
        setDraft((cur) => (cur.trim() === "" ? text : cur));
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSending(false));
  }

  function handleReset(): void {
    if (resetting) return;
    setResetting(true);
    setOverrideAgentId(null);
    setServerMessages([]);
    setPendingUserMsgs([]);
    setWaitingReply(false);
    resetCopilot({ onlyIfIdle: false })
      .then(() => {
        toast.show(t("copilot.resetDone"), { variant: "success" });
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResetting(false));
  }

  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      pane: {
        ...(fullWidth ? { flex: 1 } : { width: 340, borderRightWidth: 1, borderRightColor: colors.border }),
        backgroundColor: colors.surface1,
        flexDirection: "column" as const,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      headerTitle: {
        flex: 1,
        color: colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      iconBtn: {
        padding: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface0,
      },
      transcript: {
        flex: 1,
        padding: 12,
      },
      emptyHint: {
        color: colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
      },
      userBubble: {
        alignSelf: "flex-end" as const,
        maxWidth: "88%" as const,
        backgroundColor: colors.surface2,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 7,
        marginBottom: 8,
      },
      userText: {
        color: colors.foreground,
        fontSize: 13,
        lineHeight: 18,
      },
      assistantBubble: {
        alignSelf: "flex-start" as const,
        maxWidth: "96%" as const,
        backgroundColor: colors.surface0,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 8,
      },
      assistantText: {
        color: colors.foreground,
        fontSize: 13,
        lineHeight: 19,
      },
      thinkingRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        alignSelf: "flex-start" as const,
        paddingHorizontal: 8,
        paddingVertical: 5,
        marginBottom: 8,
      },
      thinkingText: {
        color: colors.foregroundMuted,
        fontSize: 12,
      },
      toolLine: {
        color: colors.foregroundMuted,
        fontSize: 11,
        marginBottom: 6,
        paddingHorizontal: 4,
      },
      quickRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingTop: 8,
      },
      quickChip: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface0,
      },
      quickText: {
        color: colors.foregroundMuted,
        fontSize: 11,
      },
      composer: {
        padding: 10,
        gap: 8,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      },
      input: {
        minHeight: 68,
        maxHeight: 120,
        color: colors.foreground,
        fontSize: 13,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: colors.surface0,
        textAlignVertical: "top" as const,
        ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
      },
      sendRow: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
      },
      sendBtn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 7,
        backgroundColor: colors.accent,
        opacity: sending || draft.trim() === "" ? 0.45 : 1,
      },
      sendLabel: {
        color: colors.accentForeground,
        fontSize: 12,
        fontWeight: "600" as const,
      },
    }),
    [colors, draft, fullWidth, sending],
  );

  const lastMsg = combinedMessages[combinedMessages.length - 1];
  const showThinkingIndicator = isBusy && (!lastMsg || lastMsg.role === "user" || lastMsg.role === "tool");

  return (
    <View style={styles.pane}>
      <View style={styles.header}>
        <Icon name="Sparkles" size={14} color={colors.accent} />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {t("copilot.title")}
        </Text>
        {isBusy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop Copilot"
            style={[styles.iconBtn, { borderColor: colors.statusDanger }]}
            onPress={() => {
              setWaitingReply(false);
              void stopCopilot({}).then(() => onChanged());
            }}
          >
            <Icon name="Square" size={12} color={colors.statusDanger} />
          </Pressable>
        ) : null}
        {agentId && onOpenAgent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open full session"
            style={styles.iconBtn}
            onPress={() => onOpenAgent(agentId)}
          >
            <Icon name="ExternalLink" size={13} color={colors.foregroundMuted} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset Copilot"
          disabled={resetting}
          style={styles.iconBtn}
          onPress={handleReset}
        >
          <Icon name="RotateCcw" size={13} color={colors.foregroundMuted} />
        </Pressable>
        {!fullWidth ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Collapse Copilot"
            style={styles.iconBtn}
            onPress={onCollapse}
          >
            <Icon name="PanelLeftClose" size={13} color={colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        onContentSizeChange={() => {
          scrollRef.current?.scrollToEnd?.({ animated: false });
        }}
      >
        {combinedMessages.length === 0 && !showThinkingIndicator ? (
          <Text style={styles.emptyHint}>{t("copilot.emptyHint")}</Text>
        ) : (
          <>
            {combinedMessages.map((msg) => {
              if (msg.role === "user") {
                return (
                  <View key={msg.key} style={[styles.userBubble, msg.optimistic ? { opacity: 0.88 } : null]}>
                    <Text style={styles.userText} selectable>
                      {msg.text}
                    </Text>
                  </View>
                );
              }
              if (msg.role === "tool") {
                return (
                  <Text key={msg.key} style={styles.toolLine} numberOfLines={1}>
                    ⚙ {msg.text}
                  </Text>
                );
              }
              return (
                <View key={msg.key} style={styles.assistantBubble}>
                  <Text style={styles.assistantText} selectable>
                    {msg.text}
                  </Text>
                </View>
              );
            })}
            {showThinkingIndicator ? (
              <View style={styles.thinkingRow}>
                <ActivityIndicator size="small" color={colors.foregroundMuted} />
                <Text style={styles.thinkingText}>{t("copilot.thinking")}</Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <View style={styles.quickRow}>
        {quickPrompts.map((q) => (
          <Pressable
            key={q.label}
            accessibilityRole="button"
            disabled={sending}
            style={styles.quickChip}
            onPress={() => sendText(q.prompt)}
          >
            <Text style={styles.quickText}>{q.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("copilot.placeholder")}
          placeholderTextColor={colors.foregroundMuted}
          multiline
          style={styles.input}
          {...(Platform.OS === "web"
            ? {
                onKeyPress: (e: any) => {
                  const ne = e?.nativeEvent;
                  if (ne?.key === "Enter" && !ne?.shiftKey && !ne?.isComposing) {
                    e.preventDefault?.();
                    sendText(draft);
                  }
                },
              }
            : {})}
        />
        <View style={styles.sendRow}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("copilot.enterHint")}</Text>
          <Pressable
            accessibilityRole="button"
            disabled={sending || draft.trim() === ""}
            style={styles.sendBtn}
            onPress={() => sendText(draft)}
          >
            <Icon name="Send" size={12} color={colors.accentForeground} />
            <Text style={styles.sendLabel}>{t("copilot.send")}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
