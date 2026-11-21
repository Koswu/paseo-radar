import { useHosts, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, FlatList, Icon, Modal, ScrollView, SettingsAction, SettingsGroup, SettingsRow, SettingsSection, SettingsSwitch, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import {
  loadCollectorConfigRpc,
  loadRadarInteractionsRpc,
  saveCollectorConfigRpc,
} from "../shared/radar";
import {
  radarModelSettings,
  type AssignableModelEntry,
  type RadarModelSettings,
} from "../shared/settings";
import { useRadarI18n } from "./i18n";
import {
  SearchableModelModal,
  SettingsModelListRow,
  useAgentProfiles,
  useAvailableModels,
  type AgentProfileChoice,
} from "./model-picker";
import { PillButton } from "./radar-card";
import {
  CollectorStatusRow,
  RADAR_QUERY_KEY,
  shortenHomePath,
  useRadarSnapshot,
} from "./radar-screen";

export const RADAR_SETTINGS_ID = "radar-settings";

export function RadarSettingsScreen({ theme, host, layout }: PluginSurfaceProps) {
  const hosts = useHosts();
  const multiHost = hosts.length > 1;
  const settings = useSettings(radarModelSettings);
  const snap = useRadarSnapshot(5000, host.id);
  const { choices } = useAvailableModels();
  const { profiles } = useAgentProfiles();
  const loadConfig = useRpc(loadCollectorConfigRpc);
  const saveConfig = useRpc(saveCollectorConfigRpc);
  const loadInteractions = useRpc(loadRadarInteractionsRpc);
  const queryClient = useQueryClient();
  const interactionsQuery = useQuery({
    queryKey: ["paseo-radar", "interactions", host.id],
    queryFn: () => loadInteractions({ limit: 20 }),
    staleTime: 10_000,
  });
  const toast = useToast();
  const { isZh, t } = useRadarI18n();

  const collectors = snap.data?.collectors ?? [];
  const collectorsDir = snap.data?.collectorsDir ?? "";
  const effectiveTimezone = snap.data?.effectiveTimezone ?? "UTC";
  const resolvedModels = snap.data?.resolvedModels;
  const enabledCount = collectors.filter((c) => c.enabled).length;

  const values: RadarModelSettings =
    settings.status === "ready" ? settings.values : radarModelSettings.schema.parse({});

  const [tzInput, setTzInput] = useState(values.timezone);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configJsonDraft, setConfigJsonDraft] = useState("");
  const [mutedKwDraft, setMutedKwDraft] = useState("");
  const [configPathLabel, setConfigPathLabel] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [entryNameDraft, setEntryNameDraft] = useState("");
  const [entryModelDraft, setEntryModelDraft] = useState("");
  const [entryDescDraft, setEntryDescDraft] = useState("");
  const [entryProfileIdDraft, setEntryProfileIdDraft] = useState<string | null>(null);
  const [entryModelPickerOpen, setEntryModelPickerOpen] = useState(false);
  const [profileImportModalOpen, setProfileImportModalOpen] = useState(false);

  useEffect(() => {
    setTzInput(values.timezone);
  }, [values.timezone, host.id]);

  const refreshSnapshot = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: RADAR_QUERY_KEY });
  }, [queryClient]);

  function updateField(patch: Partial<RadarModelSettings>, label: string): void {
    if (settings.status !== "ready") return;
    settings
      .save({ ...settings.values, ...patch }, settings.revision)
      .then((ok) => {
        if (ok) {
          refreshSnapshot();
          toast.show(isZh ? `已更新${label}` : `Updated ${label}`, { variant: "success" });
        } else if (settings.saveError) {
          toast.error(settings.saveError);
        }
      });
  }

  function handleOpenConfigModal(): void {
    loadConfig({})
      .then((res) => {
        setConfigPathLabel(res.configPath);
        setConfigJsonDraft(res.configJson);
        setMutedKwDraft(res.mutedKeywords.join(", "));
        setConfigModalOpen(true);
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  }

  function handleSaveConfigModal(): void {
    if (savingConfig) return;
    setSavingConfig(true);
    const kws = mutedKwDraft
      .split(/[\n,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    saveConfig({ configJson: configJsonDraft, mutedKeywords: kws })
      .then(() => {
        setConfigModalOpen(false);
        refreshSnapshot();
        toast.show(t("settings.savedConfigToast"), { variant: "success" });
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingConfig(false));
  }

  function openAddModelModal(): void {
    setEditingEntryId(null);
    setEntryNameDraft("");
    setEntryModelDraft(choices[0]?.value ?? "");
    setEntryDescDraft("");
    setEntryProfileIdDraft(null);
    setEntryModalOpen(true);
  }

  function openEditModelModal(entry: AssignableModelEntry): void {
    setEditingEntryId(entry.id);
    setEntryNameDraft(entry.name);
    setEntryModelDraft(entry.model);
    setEntryDescDraft(entry.description);
    setEntryProfileIdDraft(entry.profileId ?? null);
    setEntryModalOpen(true);
  }

  function handleSaveModelEntry(): void {
    const cleanModel = entryModelDraft.trim();
    if (!cleanModel) {
      toast.error(isZh ? "请选择模型" : "Please select a model");
      return;
    }
    const matchedChoice = choices.find((c) => c.value === cleanModel);
    const cleanName = entryNameDraft.trim() || matchedChoice?.label || cleanModel.split("/").pop() || cleanModel;
    const cleanDesc = entryDescDraft.trim();
    const nextList = [...values.assignableModels];
    if (editingEntryId) {
      const idx = nextList.findIndex((m) => m.id === editingEntryId);
      const updated: AssignableModelEntry = {
        id: editingEntryId,
        name: cleanName,
        model: cleanModel,
        description: cleanDesc,
        profileId: entryProfileIdDraft,
      };
      if (idx >= 0) nextList[idx] = updated;
      else nextList.push(updated);
    } else {
      nextList.push({
        id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: cleanName,
        model: cleanModel,
        description: cleanDesc,
        profileId: entryProfileIdDraft,
      });
    }
    setEntryModalOpen(false);
    updateField({ assignableModels: nextList }, isZh ? "可分配模型列表" : "assignable models");
  }

  function handleDeleteModelEntry(id: string): void {
    const nextList = values.assignableModels.filter((m) => m.id !== id);
    updateField({ assignableModels: nextList }, isZh ? "可分配模型列表" : "assignable models");
  }

  function handleImportProfiles(selected: readonly AgentProfileChoice[]): void {
    if (selected.length === 0) return;
    const nextList = [...values.assignableModels];
    for (const p of selected) {
      const idx = nextList.findIndex((m) => m.profileId === p.id);
      const entry: AssignableModelEntry = {
        id: idx >= 0 ? nextList[idx]!.id : `prof-${p.id}`,
        name: p.name,
        model: p.fullModel,
        description: p.notes,
        profileId: p.id,
      };
      if (idx >= 0) nextList[idx] = entry;
      else nextList.push(entry);
    }
    setProfileImportModalOpen(false);
    updateField({ assignableModels: nextList }, isZh ? "可分配模型列表" : "assignable models");
  }

  const { colors } = theme;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 16 }}
    >
      {multiHost ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Icon name="Server" size={14} color={colors.accent} />
          <Text style={{ flex: 1, color: colors.foreground, fontSize: 12.5, lineHeight: 18 }}>
            <Text style={{ fontWeight: "600" }}>{t("settings.currentHost", { host: host.label })}</Text>
            <Text style={{ color: colors.foregroundMuted }}>{t("settings.hostIsolationHint")}</Text>
          </Text>
        </View>
      ) : null}

      <SettingsGroup title={t("settings.collectorsGroup")}>
        <SettingsSection
          title={t("settings.collectorsSection", { enabled: enabledCount, total: collectors.length })}
          info={
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              {t("settings.collectorsInfo")}
            </Text>
          }
        >
          <SettingsSwitch
            label={t("settings.autoScanLabel")}
            hint={t("settings.autoScanHint")}
            value={values.autoScanEnabled}
            disabled={settings.saving}
            onValueChange={(next) =>
              updateField({ autoScanEnabled: next }, isZh ? "自动扫描开关" : "auto-scan")
            }
          />
          <SettingsAction
            label={t("settings.editConfigLabel")}
            hint={t("settings.editConfigHint")}
            actionLabel={t("settings.editConfigBtn")}
            onPress={handleOpenConfigModal}
          />
          <View style={{ padding: 10, gap: 6 }}>
            {collectors.length === 0 ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{t("board.noCollectors")}</Text>
            ) : (
              collectors.map((c) => (
                <CollectorStatusRow
                  key={c.filename}
                  collector={c}
                  theme={theme}
                  onChanged={refreshSnapshot}
                />
              ))
            )}
          </View>
          {collectorsDir ? (
            <SettingsAction
              label={t("settings.collectorsDirLabel")}
              hint={shortenHomePath(collectorsDir)}
              actionLabel={t("settings.copyPathBtn")}
              onPress={() => {
                copyText(collectorsDir)
                  .then(() => toast.show(t("board.copiedDir"), { variant: "success" }))
                  .catch(() => {});
              }}
            />
          ) : null}
        </SettingsSection>
      </SettingsGroup>

      <SettingsGroup title={t("settings.workspaceGroup")}>
        <SettingsSection title={t("settings.workspaceSection")}>
          <SettingsSwitch
            label={t("settings.trackLocalLabel")}
            hint={t("settings.trackLocalHint")}
            value={values.trackLocalWorkspaces}
            disabled={settings.saving}
            onValueChange={(next) =>
              updateField({ trackLocalWorkspaces: next }, isZh ? "本地会话纳管" : "workspace tracking")
            }
          />
          <SettingsSwitch
            label={t("settings.coordBetaLabel")}
            hint={t("settings.coordBetaHint")}
            value={values.coordinationBetaEnabled}
            disabled={settings.saving}
            onValueChange={(next) =>
              updateField(
                { coordinationBetaEnabled: next },
                isZh ? "协调模式 (Beta)" : "Coordination Mode (Beta)",
              )
            }
          />
          <SettingsRow
            label={t("settings.timezoneLabel")}
            hint={t("settings.timezoneHint", { effective: effectiveTimezone })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <TextInput
                value={tzInput}
                onChangeText={setTzInput}
                placeholder={t("settings.timezonePlaceholder", { effective: effectiveTimezone })}
                placeholderTextColor={colors.foregroundMuted}
                style={{
                  minWidth: 165,
                  color: colors.foreground,
                  fontSize: 12.5,
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                  ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
                }}
              />
              {tzInput.trim() !== values.timezone.trim() ? (
                <PillButton
                  label={t("settings.timezoneSave")}
                  tone="primary"
                  disabled={settings.saving}
                  theme={theme}
                  onPress={() => updateField({ timezone: tzInput.trim() }, isZh ? "时区设置" : "timezone")}
                />
              ) : null}
            </View>
          </SettingsRow>
        </SettingsSection>
      </SettingsGroup>

      <SettingsGroup title={t("settings.modelsGroup")}>
        <SettingsSection
          title={t("settings.assignableSection")}
          info={
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              {t("settings.assignableInfo")}
            </Text>
          }
        >
          <View style={{ padding: 10, gap: 8 }}>
            {values.assignableModels.length === 0 ? (
              profiles.length === 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                  {t("settings.assignableEmptyHint")}
                </Text>
              ) : (
                <>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                    {t("settings.assignableDefaultProfilesHint", { count: profiles.length })}
                  </Text>
                  {profiles.map((p) => (
                    <View
                      key={p.id}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface1,
                        gap: 3,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
                          {p.name}
                        </Text>
                        <View
                          style={{
                            paddingHorizontal: 6,
                            paddingVertical: 1,
                            borderRadius: 5,
                            backgroundColor: colors.surface2,
                          }}
                        >
                          <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: "600" }}>
                            {t("settings.profileBadge")}
                          </Text>
                        </View>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                          {p.fullModel}
                        </Text>
                      </View>
                      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                        {p.notes || t("settings.noDescription")}
                      </Text>
                    </View>
                  ))}
                </>
              )
            ) : (
              values.assignableModels.map((entry) => (
                <View
                  key={entry.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surface1,
                  }}
                >
                  <View style={{ flex: 1, gap: 3 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        {entry.name || entry.model}
                      </Text>
                      {entry.profileId ? (
                        <View
                          style={{
                            paddingHorizontal: 6,
                            paddingVertical: 1,
                            borderRadius: 5,
                            backgroundColor: colors.surface2,
                          }}
                        >
                          <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: "600" }}>
                            {t("settings.profileBadge")}
                          </Text>
                        </View>
                      ) : null}
                      <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                        {entry.model}
                      </Text>
                    </View>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                      {entry.description || t("settings.noDescription")}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <PillButton
                      icon="Pencil"
                      label={t("settings.editModelBtn")}
                      disabled={settings.saving}
                      theme={theme}
                      onPress={() => openEditModelModal(entry)}
                    />
                    <PillButton
                      icon="Trash2"
                      label={t("settings.deleteModelBtn")}
                      disabled={settings.saving}
                      theme={theme}
                      onPress={() => handleDeleteModelEntry(entry.id)}
                    />
                  </View>
                </View>
              ))
            )}

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
              <PillButton
                icon="Plus"
                label={t("settings.addModelBtn")}
                tone="primary"
                disabled={settings.saving}
                theme={theme}
                onPress={openAddModelModal}
              />
              {profiles.length > 0 ? (
                <PillButton
                  icon="Layers"
                  label={t("settings.importProfileBtn")}
                  disabled={settings.saving}
                  theme={theme}
                  onPress={() => setProfileImportModalOpen(true)}
                />
              ) : null}
            </View>
          </View>
        </SettingsSection>

        <SettingsSection
          title={t("settings.modelsSection")}
          info={
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              {t("settings.modelsInfo")}
            </Text>
          }
        >
          <SettingsModelListRow
            label={t("settings.roleCopilot")}
            hint={t("settings.roleCopilotHint")}
            values={values.copilotModel}
            resolvedValue={resolvedModels?.copilotModel}
            choices={choices}
            disabled={settings.saving}
            theme={theme}
            onChange={(v) => updateField({ copilotModel: v }, t("settings.roleCopilot"))}
          />
          <SettingsModelListRow
            label={t("settings.roleTriage")}
            hint={t("settings.roleTriageHint")}
            values={values.triageModel}
            resolvedValue={resolvedModels?.triageModel}
            choices={choices}
            disabled={settings.saving}
            theme={theme}
            onChange={(v) => updateField({ triageModel: v }, t("settings.roleTriage"))}
          />
          <SettingsModelListRow
            label={t("settings.roleWaitEval")}
            hint={t("settings.roleWaitEvalHint")}
            values={values.waitEvalModel}
            resolvedValue={resolvedModels?.waitEvalModel}
            choices={choices}
            disabled={settings.saving}
            theme={theme}
            onChange={(v) => updateField({ waitEvalModel: v }, t("settings.roleWaitEval"))}
          />
          <SettingsModelListRow
            label={t("settings.roleSummary")}
            hint={t("settings.roleSummaryHint")}
            values={values.summaryModel}
            resolvedValue={resolvedModels?.summaryModel}
            choices={choices}
            disabled={settings.saving}
            theme={theme}
            onChange={(v) => updateField({ summaryModel: v }, t("settings.roleSummary"))}
          />
          <SettingsModelListRow
            label={t("settings.roleInsight")}
            hint={t("settings.roleInsightHint")}
            values={values.insightModel}
            resolvedValue={resolvedModels?.insightModel}
            choices={choices}
            disabled={settings.saving}
            theme={theme}
            onChange={(v) => updateField({ insightModel: v }, t("settings.roleInsight"))}
          />
        </SettingsSection>

        <SettingsSection title={t("settings.resetSection")}>
          <SettingsAction
            label={t("settings.resetLabel")}
            hint={t("settings.resetHint")}
            actionLabel={t("settings.resetBtn")}
            disabled={settings.saving}
            onPress={() => {
              settings.reset().then((ok) => {
                if (ok) {
                  refreshSnapshot();
                  toast.show(t("settings.resetToast"), { variant: "success" });
                }
              });
            }}
          />
        </SettingsSection>

        <SettingsSection title={isZh ? "交互历史日志" : "Interaction History"}>
          <SettingsRow
            label={isZh ? "日志文件" : "Log file"}
            hint={
              interactionsQuery.data?.logPath
                ? shortenHomePath(interactionsQuery.data.logPath)
                : "~/.paseo/plugin-data/paseo-radar/interactions.jsonl"
            }
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <PillButton
                icon="Copy"
                label={isZh ? "复制路径" : "Copy path"}
                theme={theme}
                onPress={() => {
                  const p = interactionsQuery.data?.logPath;
                  if (!p) return;
                  copyText(p)
                    .then(() =>
                      toast.show(isZh ? "已复制日志路径" : "Copied log path", { variant: "success" }),
                    )
                    .catch(() => {});
                }}
              />
              <PillButton
                icon="RefreshCw"
                label={isZh ? "刷新" : "Refresh"}
                theme={theme}
                onPress={() => void interactionsQuery.refetch()}
              />
            </View>
          </SettingsRow>
          <SettingsRow
            label={isZh ? "累计记录数" : "Total recorded"}
            hint={
              interactionsQuery.data
                ? Object.entries(interactionsQuery.data.byKind)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
                    .map(([k, count]) => `${k}: ${count}`)
                    .join(" · ") || (isZh ? "暂无交互记录" : "No interactions yet")
                : isZh
                  ? "加载中…"
                  : "Loading…"
            }
          >
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
              {interactionsQuery.data ? String(interactionsQuery.data.totalCount) : "—"}
            </Text>
          </SettingsRow>
          {(interactionsQuery.data?.events ?? []).slice(0, 10).map((ev) => (
            <View
              key={ev.id}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                gap: 2,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
                  {ev.kind}
                  {ev.cardTitle ? ` · ${ev.cardTitle}` : ev.cardId ? ` · ${ev.cardId}` : ""}
                </Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {ev.at.slice(0, 19).replace("T", " ")}
                </Text>
              </View>
              {ev.detail && Object.keys(ev.detail).length > 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={2}>
                  {JSON.stringify(ev.detail)}
                </Text>
              ) : null}
            </View>
          ))}
        </SettingsSection>
      </SettingsGroup>

      <Modal
        title={t("settings.configModalTitle")}
        open={configModalOpen}
        onOpenChange={(next) => {
          if (!next) setConfigModalOpen(false);
        }}
      >
        <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 16, gap: 10 }}>
          <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
            {configPathLabel ? shortenHomePath(configPathLabel) : t("settings.configJsonLabel")}
          </Text>
          <TextInput
            value={configJsonDraft}
            onChangeText={setConfigJsonDraft}
            editable={!savingConfig}
            multiline
            style={{
              flex: 1,
              minHeight: 220,
              color: colors.foreground,
              fontSize: 12.5,
              lineHeight: 18,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              backgroundColor: colors.surface1,
              textAlignVertical: "top",
              ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
            }}
          />
          <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
            {t("settings.mutedKeywordsLabel")}
          </Text>
          <TextInput
            value={mutedKwDraft}
            onChangeText={setMutedKwDraft}
            editable={!savingConfig}
            placeholder={t("settings.mutedKeywordsPlaceholder")}
            placeholderTextColor={colors.foregroundMuted}
            style={{
              color: colors.foreground,
              fontSize: 12.5,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              backgroundColor: colors.surface1,
              ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <PillButton
              icon="X"
              label={t("settings.cancelBtn")}
              disabled={savingConfig}
              theme={theme}
              onPress={() => setConfigModalOpen(false)}
            />
            <PillButton
              icon="Check"
              label={savingConfig ? t("settings.savingBtn") : t("settings.saveBtn")}
              tone="primary"
              disabled={savingConfig}
              theme={theme}
              onPress={handleSaveConfigModal}
            />
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title={editingEntryId ? t("settings.modelModalEditTitle") : t("settings.modelModalAddTitle")}
        open={entryModalOpen}
        onOpenChange={(next) => {
          if (!next) setEntryModalOpen(false);
        }}
      >
        <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 16, gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
              {t("settings.modelFieldLabel")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEntryModelPickerOpen(true)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 9,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 13, flex: 1 }} numberOfLines={1}>
                {entryModelDraft
                  ? choices.find((c) => c.value === entryModelDraft)?.label || entryModelDraft
                  : t("settings.modelFieldPickBtn")}
              </Text>
              <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
            </Pressable>
            {entryModelDraft ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{entryModelDraft}</Text>
            ) : null}
          </View>

          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
              {t("settings.nameFieldLabel")}
            </Text>
            <TextInput
              value={entryNameDraft}
              onChangeText={setEntryNameDraft}
              placeholder={t("settings.nameFieldPlaceholder")}
              placeholderTextColor={colors.foregroundMuted}
              style={{
                color: colors.foreground,
                fontSize: 13,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                backgroundColor: colors.surface1,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
              }}
            />
          </View>

          <View style={{ gap: 6, flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
              {t("settings.descFieldLabel")}
            </Text>
            <TextInput
              value={entryDescDraft}
              onChangeText={setEntryDescDraft}
              placeholder={t("settings.descFieldPlaceholder")}
              placeholderTextColor={colors.foregroundMuted}
              multiline
              style={{
                flex: 1,
                minHeight: 90,
                color: colors.foreground,
                fontSize: 12.5,
                lineHeight: 18,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                backgroundColor: colors.surface1,
                textAlignVertical: "top",
                ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {}),
              }}
            />
          </View>

          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <PillButton
              icon="X"
              label={t("settings.cancelBtn")}
              theme={theme}
              onPress={() => setEntryModalOpen(false)}
            />
            <PillButton
              icon="Check"
              label={t("settings.saveBtn")}
              tone="primary"
              theme={theme}
              onPress={handleSaveModelEntry}
            />
          </View>
        </Modal.Content>
      </Modal>

      <SearchableModelModal
        title={t("settings.modelFieldLabel")}
        open={entryModelPickerOpen}
        value={entryModelDraft}
        choices={choices}
        theme={theme}
        onClose={() => setEntryModelPickerOpen(false)}
        onSelect={(nextModel) => {
          setEntryModelDraft(nextModel);
          if (!entryNameDraft.trim()) {
            const matched = choices.find((c) => c.value === nextModel);
            setEntryNameDraft(matched?.label || nextModel.split("/").pop() || nextModel);
          }
        }}
      />

      <Modal
        title={t("settings.profileImportTitle")}
        open={profileImportModalOpen}
        onOpenChange={(next) => {
          if (!next) setProfileImportModalOpen(false);
        }}
      >
        <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 16, gap: 10 }}>
          {profiles.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12.5 }}>
              {t("settings.profileImportEmpty")}
            </Text>
          ) : (
            <>
              <FlatList
                style={{ flex: 1 }}
                data={profiles}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => handleImportProfiles([item])}
                    style={{
                      paddingVertical: 10,
                      paddingHorizontal: 10,
                      borderRadius: 8,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                      gap: 3,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        {item.name}
                      </Text>
                      <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
                        {item.fullModel}
                      </Text>
                    </View>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                      {item.notes || t("settings.noDescription")}
                    </Text>
                  </Pressable>
                )}
              />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                <PillButton
                  icon="X"
                  label={t("settings.cancelBtn")}
                  theme={theme}
                  onPress={() => setProfileImportModalOpen(false)}
                />
                <PillButton
                  icon="Layers"
                  label={t("settings.profileImportAllBtn")}
                  tone="primary"
                  theme={theme}
                  onPress={() => handleImportProfiles(profiles)}
                />
              </View>
            </>
          )}
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}
