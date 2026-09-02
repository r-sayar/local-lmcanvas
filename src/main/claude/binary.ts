import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { existsSync } from "node:fs";

const nodeRequire = createRequire(import.meta.url);

/**
 * Locate the `claude` executable the SDK should spawn.
 *
 * Three installs to cover: the binary unpacked next to `app.asar` in a packaged
 * build, the nested platform package in a dev install, and a top-level hoist
 * from npm/yarn.
 */
function resolveBundledClaude(): string | undefined {
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  const platformPkgShort = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const platformPkg = `@anthropic-ai/${platformPkgShort}`;
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(
      join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
        "node_modules",
        "@anthropic-ai",
        platformPkgShort,
        binName,
      ),
      join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@anthropic-ai",
        platformPkgShort,
        binName,
      ),
    );
  }

  try {
    const sdkEntry = nodeRequire.resolve("@anthropic-ai/claude-agent-sdk");
    candidates.push(
      join(dirname(sdkEntry), "node_modules", "@anthropic-ai", platformPkgShort, binName),
    );
  } catch {
    /* SDK unresolvable — shouldn't happen */
  }

  try {
    const direct = nodeRequire.resolve(`${platformPkg}/package.json`);
    candidates.push(join(dirname(direct), binName));
  } catch {
    /* not hoisted */
  }

  for (let candidate of candidates) {
    const asarSeg = `${sep}app.asar${sep}`;
    if (candidate.includes(asarSeg)) {
      candidate = candidate.replace(asarSeg, `${sep}app.asar.unpacked${sep}`);
    }
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export const CLAUDE_BIN_PATH = resolveBundledClaude();

/**
 * Path to the user's own `claude`, if one is on PATH.
 *
 * Resolved once and memoised. The previous code shelled out to `which claude`
 * synchronously on every single turn, blocking the main process — and the answer
 * cannot change without a restart, since PATH is captured at boot.
 */
let systemClaude: string | null | undefined;

export function resolveSystemClaude(): string | undefined {
  if (systemClaude !== undefined) return systemClaude ?? undefined;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], { encoding: "utf8" }).trim().split("\n")[0];
    systemClaude = out || null;
  } catch {
    systemClaude = null;
  }
  return systemClaude ?? undefined;
}

/** Forget the memoised lookup — used after the user edits the binary path. */
export function clearSystemClaudeCache(): void {
  systemClaude = undefined;
}

/**
 * The executable to hand the SDK, most specific first: an explicit override from
 * settings, then the user's own install, then whatever shipped with the app.
 */
export function resolveClaudeExecutable(configured?: string): string | undefined {
  if (configured && configured !== "claude") return configured;
  return resolveSystemClaude() ?? CLAUDE_BIN_PATH;
}
