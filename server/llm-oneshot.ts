import {
  spawnProcess,
  terminateProcess,
  type PluginHandlerContext,
} from "@getpaseo/plugin/server";

import {
  RADAR_LABELS,
  type AssignableModelChoice,
  type ResolvedModels,
} from "../shared/radar";
import { normalizeModelList, type RadarModelSettings } from "../shared/settings";
import { buildExtendedEnv, resolvePiBinary } from "./runtime-env";
import { ensureRadarHome, oneshotDir } from "./store";

type PaseoApi = PluginHandlerContext["paseo"];

interface DiscoveredModel {
  spec: string;
  label: string;
}

let cachedDiscovered: { atMs: number; models: DiscoveredModel[] } | null = null;
const DISCOVERY_TTL_MS = 60_000;

export interface DiscoveredAgentProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  notes?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

let cachedProfiles: { atMs: number; profiles: DiscoveredAgentProfile[] } | null = null;
const PROFILE_TTL_MS = 30_000;

export function profileToFullModel(profile: Pick<DiscoveredAgentProfile, "provider" | "model">): string {
  const prov = profile.provider.trim();
  const mod = profile.model?.trim();
  if (!mod) return prov;
  return mod.startsWith(`${prov}/`) ? mod : `${prov}/${mod}`;
}

export async function discoverAgentProfiles(
  paseo: PaseoApi | null | undefined,
): Promise<DiscoveredAgentProfile[]> {
  if (!paseo) return cachedProfiles?.profiles ?? [];
  const now = Date.now();
  if (cachedProfiles && now - cachedProfiles.atMs < PROFILE_TTL_MS) {
    return cachedProfiles.profiles;
  }
  try {
    const res = await paseo.config.get();
    const rawProfiles = res.config?.agentProfiles ?? [];
    const out: DiscoveredAgentProfile[] = rawProfiles
      .filter((p) => p && typeof p.id === "string" && typeof p.provider === "string")
      .map((p) => ({
        id: p.id,
        name: p.name || p.id,
        provider: p.provider,
        ...(p.model ? { model: p.model } : {}),
        ...(p.notes ? { notes: p.notes } : {}),
        ...(p.modeId ? { modeId: p.modeId } : {}),
        ...(p.thinkingOptionId ? { thinkingOptionId: p.thinkingOptionId } : {}),
        ...(p.featureValues ? { featureValues: p.featureValues } : {}),
      }));
    cachedProfiles = { atMs: now, profiles: out };
    return out;
  } catch {
    return cachedProfiles?.profiles ?? [];
  }
}

const FAST_HINT_RE = /\b(flash|mini|haiku|fast|nano|lite|instant|turbo)\b/i;
const STRONG_HINT_RE = /\b(opus|sonnet|gpt-5|gpt-6|o3|o4|pro|argon|deepseek-r1|claude-4)\b/i;

export async function discoverSelectableModels(
  paseo: PaseoApi | null | undefined,
): Promise<DiscoveredModel[]> {
  if (!paseo) return cachedDiscovered?.models ?? [];
  const now = Date.now();
  if (cachedDiscovered && now - cachedDiscovered.atMs < DISCOVERY_TTL_MS && cachedDiscovered.models.length > 0) {
    return cachedDiscovered.models;
  }

  try {
    const avail = await paseo.providers.listAvailable();
    const providers = avail.providers.filter((p) => p.available).map((p) => p.provider);
    const results = await Promise.all(
      providers.map((prov) => paseo.providers.listModels(prov).catch(() => null)),
    );
    const out: DiscoveredModel[] = [];
    results.forEach((res, idx) => {
      const prov = providers[idx];
      if (!res || !prov) return;
      for (const m of res.models ?? []) {
        if (m.isSelectable === false) continue;
        out.push({
          spec: `${prov}/${m.id}`,
          label: `${m.label || m.id} ${m.id}`,
        });
      }
    });
    cachedDiscovered = { atMs: now, models: out };
    return out;
  } catch {
    return cachedDiscovered?.models ?? [];
  }
}

function pickAutoModel(models: readonly DiscoveredModel[], kind: "fast" | "strong"): string {
  if (models.length === 0) return "";
  if (kind === "fast") {
    const fast = models.find((m) => FAST_HINT_RE.test(m.spec) || FAST_HINT_RE.test(m.label));
    return fast?.spec ?? models[0]!.spec;
  }
  const strong = models.find(
    (m) =>
      (STRONG_HINT_RE.test(m.spec) || STRONG_HINT_RE.test(m.label)) &&
      !FAST_HINT_RE.test(m.spec),
  );
  if (strong) return strong.spec;
  const nonFast = models.find((m) => !FAST_HINT_RE.test(m.spec));
  return nonFast?.spec ?? models[0]!.spec;
}

export async function resolveEffectiveModels(
  raw: RadarModelSettings,
  paseo?: PaseoApi | null,
): Promise<Omit<RadarModelSettings, "copilotModel" | "triageModel" | "waitEvalModel" | "summaryModel" | "insightModel"> & { resolved: ResolvedModels } & ResolvedModels> {
  const configuredEntries = raw.assignableModels.filter((entry) => entry.model.trim() !== "");
  const useProfilesDefault = configuredEntries.length === 0;
  const needsProfileLookup =
    useProfilesDefault ||
    configuredEntries.some((entry) => Boolean(entry.profileId));

  const profiles = needsProfileLookup ? await discoverAgentProfiles(paseo) : [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const assignableModels: AssignableModelChoice[] = useProfilesDefault
    ? profiles.map((p) => ({
        id: p.id,
        name: p.name,
        model: profileToFullModel(p),
        description: p.notes ?? "",
        profileId: p.id,
        modeId: p.modeId ?? null,
        thinkingOptionId: p.thinkingOptionId ?? null,
        featureValues: p.featureValues ?? null,
      }))
    : configuredEntries.map((entry) => {
        const linked = entry.profileId ? profileById.get(entry.profileId) : undefined;
        return {
          id: entry.id,
          name: entry.name.trim() || entry.model.split("/").pop() || entry.model,
          model: entry.model.trim(),
          description: entry.description.trim(),
          profileId: entry.profileId ?? null,
          modeId: linked?.modeId ?? null,
          thinkingOptionId: linked?.thinkingOptionId ?? null,
          featureValues: linked?.featureValues ?? null,
        };
      });

  const copilotConfigured = normalizeModelList(raw.copilotModel);
  const triageConfigured = normalizeModelList(raw.triageModel);
  const waitEvalConfigured = normalizeModelList(raw.waitEvalModel);
  const summaryConfigured = normalizeModelList(raw.summaryModel);
  const insightConfigured = normalizeModelList(raw.insightModel);

  const firstAssignable = assignableModels[0]?.model ?? "";
  const needsDiscovery =
    copilotConfigured.length === 0 ||
    triageConfigured.length === 0 ||
    !firstAssignable ||
    waitEvalConfigured.length === 0 ||
    summaryConfigured.length === 0 ||
    insightConfigured.length === 0;

  const discovered = needsDiscovery ? await discoverSelectableModels(paseo) : [];
  const autoFast = pickAutoModel(discovered, "fast");
  const autoStrong = pickAutoModel(discovered, "strong");
  const autoFallback = autoFast || autoStrong;
  const autoStrongFallback = autoStrong || firstAssignable || autoFallback;
  const defaultWorkerModel = firstAssignable || autoStrong || autoFast;

  const copilotModels = copilotConfigured.length > 0 ? copilotConfigured : (autoFallback ? [autoFallback] : []);
  const triageModels = triageConfigured.length > 0 ? triageConfigured : (autoFallback ? [autoFallback] : []);
  const waitEvalModels = waitEvalConfigured.length > 0 ? waitEvalConfigured : (autoFallback ? [autoFallback] : []);
  const summaryModels = summaryConfigured.length > 0 ? summaryConfigured : (autoFallback ? [autoFallback] : []);
  const insightModels =
    insightConfigured.length > 0
      ? insightConfigured
      : copilotConfigured.length > 0
        ? copilotConfigured
        : autoStrongFallback
          ? [autoStrongFallback]
          : [];

  const resolved: ResolvedModels = {
    copilotModel: copilotModels[0] ?? "",
    triageModel: triageModels[0] ?? "",
    waitEvalModel: waitEvalModels[0] ?? "",
    summaryModel: summaryModels[0] ?? "",
    insightModel: insightModels[0] ?? "",
    copilotModels,
    triageModels,
    waitEvalModels,
    summaryModels,
    insightModels,
    defaultWorkerModel,
    assignableModels,
  };

  return {
    ...raw,
    ...resolved,
    resolved,
  };
}

function parsePiSpec(fullModel: string): { provider: string; model: string } | null {
  const trimmed = fullModel.trim();
  if (!trimmed.startsWith("pi/")) return null;
  const rest = trimmed.slice(3);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return {
    provider: rest.slice(0, slash),
    model: rest.slice(slash + 1),
  };
}

async function runViaPiCli(
  provider: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const piCmd = await resolvePiBinary();
  return new Promise<string>((resolve, reject) => {
    const child = spawnProcess(
      piCmd,
      [
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        "off",
        "--no-session",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "-p",
        prompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: buildExtendedEnv() },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      void terminateProcess(child);
      reject(new Error(`model timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (code === 0 && trimmed) {
        resolve(trimmed);
      } else {
        reject(new Error(stderr.trim() || `pi exited with code ${String(code)}`));
      }
    });
  });
}

async function runViaPaseoSdk(
  paseo: PaseoApi,
  modelSpec: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  await ensureRadarHome();
  const dir = oneshotDir();
  const ws = await paseo.workspaces.open(dir);
  const agent = await ws.agents.create({
    config: {
      provider: modelSpec,
      // Antigravity encodes effort in the model ID and rejects a separate option.
      ...(modelSpec.split("/")[0] === "antigravity" ? {} : { thinkingOptionId: "low" }),
      systemPrompt:
        "You are a stateless classification and summarization helper. Follow the user prompt format strictly and output plain text or JSON only. Do not invoke any tools.",
    },
    title: "[Radar OneShot]",
    labels: {
      [RADAR_LABELS.role]: RADAR_LABELS.oneshotRole,
    },
  });

  try {
    const runStartedAt = Date.now();
    await agent.run(prompt, { timeoutMs });
    const page = await paseo.agents.ref(agent.id).timeline.refetch({
      direction: "tail",
      limit: 20,
      projection: "projected",
    });
    const parts: string[] = [];
    for (let i = page.entries.length - 1; i >= 0; i--) {
      const entry = page.entries[i];
      if (!entry) break;
      const item = entry.item as { type?: string; text?: string };
      if (item.type === "assistant_message" && typeof item.text === "string") {
        parts.unshift(item.text);
        continue;
      }
      if (item.type === "plugin" || item.type === "notification") continue;
      if (parts.length > 0) break;
    }
    const reply = parts.join("").trim();
    if (!reply) {
      if (Date.now() - runStartedAt >= timeoutMs - 500) {
        throw new Error(`Model timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new Error("Model returned an empty response");
    }
    return reply;
  } finally {
    await agent.archive().catch(() => {});
  }
}

export async function runOneShotPrompt(params: {
  modelSpec: string;
  prompt: string;
  paseo?: PaseoApi | null;
  timeoutMs?: number;
}): Promise<string> {
  const spec = params.modelSpec.trim();
  if (!spec) {
    throw new Error("No available model configured on this host");
  }
  const timeoutMs = params.timeoutMs ?? 90_000;
  const piParsed = parsePiSpec(spec);

  if (piParsed) {
    try {
      return await runViaPiCli(piParsed.provider, piParsed.model, params.prompt, timeoutMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" && params.paseo) {
        return runViaPaseoSdk(params.paseo, spec, params.prompt, timeoutMs);
      }
      throw err;
    }
  }

  if (!params.paseo) {
    throw new Error(`Paseo session handle not ready to invoke non-pi model "${spec}"`);
  }
  return runViaPaseoSdk(params.paseo, spec, params.prompt, timeoutMs);
}

export class ModelChainError extends Error {
  readonly failedModel: string;
  readonly causeError: unknown;
  constructor(failedModel: string, causeError: unknown) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = "ModelChainError";
    this.failedModel = failedModel;
    this.causeError = causeError;
  }
}

export async function runOneShotPromptWithFallback(params: {
  modelSpecs: readonly string[];
  prompt: string;
  paseo?: PaseoApi | null;
  timeoutMs?: number;
  onFallback?: (info: { failedModel: string; nextModel: string; error: unknown }) => void;
}): Promise<{ text: string; modelUsed: string; isPrimary: boolean }> {
  const specs = normalizeModelList(params.modelSpecs);
  if (specs.length === 0) {
    throw new Error("No available model configured on this host");
  }
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    try {
      const text = await runOneShotPrompt({
        modelSpec: spec,
        prompt: params.prompt,
        paseo: params.paseo,
        timeoutMs: params.timeoutMs,
      });
      return { text, modelUsed: spec, isPrimary: i === 0 };
    } catch (err) {
      if (i + 1 < specs.length) {
        const nextModel = specs[i + 1]!;
        console.warn(`[paseo-radar] model (${spec}) failed, falling back to (${nextModel}):`, err);
        params.onFallback?.({ failedModel: spec, nextModel, error: err });
        continue;
      }
      throw new ModelChainError(spec, err);
    }
  }
  throw new Error("No available model configured on this host");
}
