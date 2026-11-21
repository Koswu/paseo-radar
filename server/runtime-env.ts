import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function candidateBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".pi", "agent", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

export function buildExtendedPath(existingPath = process.env.PATH ?? ""): string {
  const parts = existingPath.split(delimiter).map((s) => s.trim()).filter(Boolean);
  const seen = new Set(parts);
  const prefix: string[] = [];
  for (const dir of candidateBinDirs()) {
    if (!seen.has(dir)) {
      seen.add(dir);
      prefix.push(dir);
    }
  }
  return [...prefix, ...parts].join(delimiter);
}

export function buildExtendedEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: buildExtendedPath(process.env.PATH),
    ...extra,
  };
}

async function resolveFirstExecutable(
  envOverride: string | undefined,
  binaryName: string,
  extraCandidates: readonly string[] = [],
): Promise<string> {
  if (envOverride && envOverride.trim()) {
    return envOverride.trim();
  }
  const candidates = [
    ...extraCandidates,
    ...candidateBinDirs().map((dir) => join(dir, binaryName)),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      // Try next candidate
    }
  }
  return binaryName;
}

export function resolveUvBinary(): Promise<string> {
  return resolveFirstExecutable(process.env.UV_BIN, "uv");
}

export function resolvePiBinary(): Promise<string> {
  return resolveFirstExecutable(process.env.PI_CLI, "pi", [
    join(homedir(), ".pi", "agent", "bin", "pi"),
  ]);
}

export function resolvePaseoBinary(): Promise<string> {
  return resolveFirstExecutable(process.env.PASEO_CLI, "paseo");
}
