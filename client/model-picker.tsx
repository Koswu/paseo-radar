import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, SettingsRow, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { useRadarI18n } from "./i18n";

export interface ModelChoice {
  label: string;
  value: string;
  provider: string;
}

export interface AgentProfileChoice {
  id: string;
  name: string;
  provider: string;
  model?: string;
  fullModel: string;
  notes: string;
  modeId?: string;
  thinkingOptionId?: string;
}

const cachedChoicesByHost = new WeakMap<object, ModelChoice[]>();
const cachedProfilesByHost = new WeakMap<object, AgentProfileChoice[]>();

export function useAgentProfiles(): {
  profiles: AgentProfileChoice[];
  loading: boolean;
  refresh: () => void;
} {
  const paseo = usePaseo();
  const initial = cachedProfilesByHost.get(paseo) ?? null;
  const [profiles, setProfiles] = useState<AgentProfileChoice[]>(initial ?? []);
  const [loading, setLoading] = useState(initial === null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = nonce === 0 ? cachedProfilesByHost.get(paseo) : undefined;
    if (cached) {
      setProfiles(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    paseo.config
      .get()
      .then((res) => {
        const rawList = res.config?.agentProfiles ?? [];
        const out: AgentProfileChoice[] = rawList
          .filter((p) => p && typeof p.id === "string" && typeof p.provider === "string")
          .map((p) => {
            const prov = p.provider.trim();
            const mod = p.model?.trim();
            const fullModel = !mod ? prov : mod.startsWith(`${prov}/`) ? mod : `${prov}/${mod}`;
            return {
              id: p.id,
              name: p.name || p.id,
              provider: prov,
              ...(mod ? { model: mod } : {}),
              fullModel,
              notes: p.notes ?? "",
              ...(p.modeId ? { modeId: p.modeId } : {}),
              ...(p.thinkingOptionId ? { thinkingOptionId: p.thinkingOptionId } : {}),
            };
          });
        cachedProfilesByHost.set(paseo, out);
        if (!cancelled) setProfiles(out);
      })
      .catch((err: unknown) => {
        console.warn("[paseo-radar] could not load agent profiles:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, nonce]);

  return {
    profiles,
    loading,
    refresh: () => setNonce((n) => n + 1),
  };
}

export function useAvailableModels(): { choices: ModelChoice[]; loading: boolean } {
  const paseo = usePaseo();
  const initial = cachedChoicesByHost.get(paseo) ?? null;
  const [choices, setChoices] = useState<ModelChoice[]>(initial ?? []);
  const [loading, setLoading] = useState(initial === null);

  useEffect(() => {
    let cancelled = false;
    const cached = cachedChoicesByHost.get(paseo);
    if (cached) {
      setChoices(cached);
      setLoading(false);
    } else {
      setChoices([]);
      setLoading(true);
    }
    async function load(): Promise<void> {
      const avail = await paseo.providers.listAvailable();
      const providers = avail.providers.filter((p) => p.available).map((p) => p.provider);
      const lists = await Promise.all(
        providers.map(function (prov) {
          return paseo.providers.listModels(prov).catch(() => null);
        }),
      );
      const out: ModelChoice[] = [];
      lists.forEach((res, idx) => {
        const prov = providers[idx];
        if (!res || !prov) return;
        for (const m of res.models ?? []) {
          if (m.isSelectable === false) continue;
          out.push({
            label: m.label || m.id,
            value: `${prov}/${m.id}`,
            provider: prov,
          });
        }
      });
      cachedChoicesByHost.set(paseo, out);
      if (!cancelled) setChoices(out);
    }
    load()
      .catch((err: unknown) => console.warn("[paseo-radar] could not list models:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  return { choices, loading };
}

export function SearchableModelModal({
  title,
  open,
  value,
  choices,
  allowAuto = false,
  resolvedAutoModel,
  theme,
  onClose,
  onSelect,
}: {
  title: string;
  open: boolean;
  value: string;
  choices: readonly ModelChoice[];
  allowAuto?: boolean;
  resolvedAutoModel?: string;
  theme: PluginTheme;
  onClose: () => void;
  onSelect: (nextValue: string) => void;
}) {
  const [query, setQuery] = useState("");
  const { t } = useRadarI18n();
  const { colors } = theme;

  const autoDisplay = resolvedAutoModel
    ? t("picker.autoWithResolved", { model: resolvedAutoModel.split("/").pop() ?? resolvedAutoModel })
    : t("picker.autoLabel");

  const list = useMemo(() => {
    const autoRow: ModelChoice[] = allowAuto
      ? [{ label: autoDisplay, value: "", provider: "auto" }]
      : [];
    const customCurrent: ModelChoice[] =
      value && !choices.some((c) => c.value === value)
        ? [{ label: value, value, provider: t("picker.currentSetting") }]
        : [];
    const base = [...autoRow, ...customCurrent, ...choices];
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) => `${c.label} ${c.value} ${c.provider}`.toLowerCase().includes(q));
  }, [allowAuto, autoDisplay, choices, query, t, value]);

  return (
    <Modal
      title={title}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 16, gap: 10 }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("picker.searchPlaceholder")}
          placeholderTextColor={colors.foregroundMuted}
          autoFocus={Platform.OS === "web"}
          style={{
            color: colors.foreground,
            fontSize: 13,
            paddingHorizontal: 12,
            paddingVertical: 9,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
          }}
        />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {t("picker.countLabel", { count: list.length })}
        </Text>
        <FlatList
          style={{ flex: 1 }}
          data={list}
          keyExtractor={(item) => item.value || "__auto__"}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const selected = item.value === value;
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onSelect(item.value);
                  onClose();
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingVertical: 9,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  backgroundColor: selected ? colors.surface2 : "transparent",
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "400" }}>
                    {item.label}
                  </Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {item.value || resolvedAutoModel || "auto"}
                  </Text>
                </View>
                {selected ? <Icon name="Check" size={14} color={colors.accent} /> : null}
              </Pressable>
            );
          }}
        />
      </Modal.Content>
    </Modal>
  );
}

export function SettingsModelListRow({
  label,
  hint,
  values,
  resolvedValue,
  choices,
  disabled,
  theme,
  onChange,
}: {
  label: string;
  hint: string;
  values: readonly string[];
  resolvedValue?: string;
  choices: readonly ModelChoice[];
  disabled?: boolean;
  theme: PluginTheme;
  onChange: (nextValues: string[]) => void;
}) {
  // modalMode: null | { kind: "add" } | { kind: "edit"; index: number } | { kind: "pickPrimary" }
  const [modalState, setModalState] = useState<
    | { kind: "pickPrimary" }
    | { kind: "add" }
    | { kind: "edit"; index: number }
    | null
  >(null);
  const { t } = useRadarI18n();
  const { colors } = theme;

  const autoDisplay = resolvedValue
    ? t("picker.autoWithResolved", { model: resolvedValue.split("/").pop() ?? resolvedValue })
    : t("picker.autoLabel");

  function displayLabel(spec: string): string {
    const matched = choices.find((c) => c.value === spec);
    return matched ? matched.label : spec;
  }

  function moveItem(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    const tmp = next[index]!;
    next[index] = next[target]!;
    next[target] = tmp;
    onChange(next);
  }

  function removeItem(index: number): void {
    const next = values.filter((_, i) => i !== index);
    onChange(next);
  }

  function handleSelect(nextSpec: string): void {
    if (!modalState) return;
    if (modalState.kind === "pickPrimary") {
      onChange(nextSpec ? [nextSpec] : []);
      return;
    }
    if (modalState.kind === "add") {
      if (!nextSpec || values.includes(nextSpec)) return;
      onChange([...values, nextSpec]);
      return;
    }
    if (modalState.kind === "edit") {
      if (!nextSpec) {
        removeItem(modalState.index);
        return;
      }
      const next = [...values];
      const existingIdx = next.indexOf(nextSpec);
      if (existingIdx !== -1 && existingIdx !== modalState.index) {
        // Avoid duplicates by removing the old occurrence
        next.splice(existingIdx, 1);
        const adjustedIdx = existingIdx < modalState.index ? modalState.index - 1 : modalState.index;
        next[adjustedIdx] = nextSpec;
      } else {
        next[modalState.index] = nextSpec;
      }
      onChange(next);
    }
  }

  return (
    <>
      <SettingsRow label={label} hint={hint}>
        {values.length === 0 ? (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => setModalState({ kind: "pickPrimary" })}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              maxWidth: 280,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: colors.foreground, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
              {autoDisplay}
            </Text>
            <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
          </Pressable>
        ) : (
          <View style={{ gap: 6, minWidth: 240, maxWidth: 340, alignItems: "stretch" }}>
            {values.map((spec, idx) => (
              <View
                key={`${idx}:${spec}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <View
                  style={{
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                    borderRadius: 4,
                    backgroundColor: idx === 0 ? colors.surface2 : colors.surface0,
                  }}
                >
                  <Text
                    style={{
                      color: idx === 0 ? colors.accent : colors.foregroundMuted,
                      fontSize: 10.5,
                      fontWeight: "600",
                    }}
                  >
                    {idx === 0
                      ? t("settings.primaryBadge")
                      : t("settings.fallbackBadge", { index: idx })}
                  </Text>
                </View>

                <Pressable
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={() => setModalState({ kind: "edit", index: idx })}
                  style={{ flex: 1, minWidth: 80 }}
                >
                  <Text
                    style={{ color: colors.foreground, fontSize: 12.5 }}
                    numberOfLines={1}
                  >
                    {displayLabel(spec)}
                  </Text>
                </Pressable>

                <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                  {idx > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={disabled}
                      onPress={() => moveItem(idx, -1)}
                      style={{ padding: 3 }}
                    >
                      <Icon name="ChevronUp" size={13} color={colors.foregroundMuted} />
                    </Pressable>
                  ) : null}
                  {idx < values.length - 1 ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={disabled}
                      onPress={() => moveItem(idx, 1)}
                      style={{ padding: 3 }}
                    >
                      <Icon name="ChevronDown" size={13} color={colors.foregroundMuted} />
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={() => removeItem(idx)}
                    style={{ padding: 3 }}
                  >
                    <Icon name="X" size={13} color={colors.foregroundMuted} />
                  </Pressable>
                </View>
              </View>
            ))}

            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => setModalState({ kind: "add" })}
              style={{
                flexDirection: "row",
                alignItems: "center",
                alignSelf: "flex-start",
                gap: 4,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 7,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: colors.border,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <Icon name="Plus" size={12} color={colors.accent} />
              <Text style={{ color: colors.accent, fontSize: 11.5, fontWeight: "600" }}>
                {t("settings.addFallbackBtn")}
              </Text>
            </Pressable>
          </View>
        )}
      </SettingsRow>

      <SearchableModelModal
        title={label}
        open={modalState !== null}
        value={
          modalState?.kind === "edit"
            ? (values[modalState.index] ?? "")
            : ""
        }
        choices={
          modalState?.kind === "add"
            ? choices.filter((c) => !values.includes(c.value))
            : choices
        }
        allowAuto={modalState?.kind === "pickPrimary" || (modalState?.kind === "edit" && values.length === 1)}
        resolvedAutoModel={resolvedValue}
        theme={theme}
        onClose={() => setModalState(null)}
        onSelect={handleSelect}
      />
    </>
  );
}

export function SettingsModelPickerRow({
  label,
  hint,
  value,
  resolvedValue,
  choices,
  disabled,
  theme,
  onSelect,
}: {
  label: string;
  hint: string;
  value: string;
  resolvedValue?: string;
  choices: readonly ModelChoice[];
  disabled?: boolean;
  theme: PluginTheme;
  onSelect: (nextValue: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useRadarI18n();
  const { colors } = theme;
  const current = value ? choices.find((c) => c.value === value) : undefined;
  const displayText = value
    ? (current ? current.label : value)
    : resolvedValue
      ? t("picker.autoWithResolved", { model: resolvedValue.split("/").pop() ?? resolvedValue })
      : t("picker.autoLabel");

  return (
    <>
      <SettingsRow label={label} hint={hint}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={() => setOpen(true)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            maxWidth: 280,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text style={{ color: colors.foreground, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
            {displayText}
          </Text>
          <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
        </Pressable>
      </SettingsRow>
      <SearchableModelModal
        title={label}
        open={open}
        value={value}
        choices={choices}
        allowAuto
        resolvedAutoModel={resolvedValue}
        theme={theme}
        onClose={() => setOpen(false)}
        onSelect={onSelect}
      />
    </>
  );
}
