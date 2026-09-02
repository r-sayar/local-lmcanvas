import { readFile } from "node:fs/promises";
import type { AppSettings, NodeSettings, Provider } from "@shared/types";
import { PROVIDERS, NODE_SETTINGS_KEYS, hasNodeSettings } from "@shared/types";
import { SETTINGS_FILE, atomicWriteFile, ensureDirs } from "./paths";

const MAX_RECENTS = 8;

const DEFAULTS: AppSettings = {
  systemPrompt: "",
  claudeModel: "claude-fable-5",
  claudeBinPath: "claude",
  defaultProvider: "claude",
  providers: {
    claude: { binPath: "claude" },
    codex: { binPath: "codex" },
    cursor: { binPath: "cursor-agent" },
  },
  onboardingCompleted: false,
  terseToolNarration: false,
  recentFolders: [],
  recentBranches: [],
  // Matches the CLI's own default set. Explicitly listed so a future SDK change
  // to the implicit default can't silently drop CLAUDE.md discovery.
  settingSources: ["user", "project", "local"],
  // Edits are the point of a canvas session; genuinely destructive calls still
  // route through the approval prompt.
  defaultPermissionMode: "acceptEdits",
  forwardSubagentText: true,
  agentProgressSummaries: true,
  showHookEvents: false,
  checkpointing: false,
  alwaysAllowedTools: [],
  // A guard against one pathological result, not a space optimization.
  // Measured over 56 real canvases (8.1 MB, 1882 tool results): results are
  // 45.7% of bytes on disk but the largest is 19,627 chars, so this cap
  // truncates nothing today. Reclaiming real space would need ~2000, which
  // truncates 58% of all results and loses content on reload — a bad trade for
  // 15% of 8 MB. Lower it only if a canvas actually becomes unwieldy.
  maxStoredToolResultChars: 20_000,
};

function sanitizeRecents(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_RECENTS) break;
  }
  return out;
}

/**
 * Keep every declared override, dropping only unknown keys and empty strings.
 *
 * This used to hand-check `provider | cwd | branch` and silently discard
 * everything else, so a model override — the most common one — never survived a
 * round trip and never seeded a new node.
 */
function sanitizeNodeSettings(raw: unknown): NodeSettings | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: NodeSettings = {};

  for (const key of NODE_SETTINGS_KEYS) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (key === "provider" && !(PROVIDERS as readonly string[]).includes(value as string)) continue;
    Object.assign(out, { [key]: value as NodeSettings[typeof key] });
  }

  return hasNodeSettings(out) ? out : undefined;
}

function mergeWithDefaults(s: Partial<AppSettings>): AppSettings {
  const providers = {
    ...DEFAULTS.providers,
    ...(s.providers ?? {}),
  };
  const lastNodeSettings = sanitizeNodeSettings(s.lastNodeSettings);
  return {
    ...DEFAULTS,
    ...s,
    providers,
    recentFolders: sanitizeRecents(s.recentFolders),
    recentBranches: sanitizeRecents(s.recentBranches),
    ...(lastNodeSettings ? { lastNodeSettings } : { lastNodeSettings: undefined }),
  };
}

export async function readSettings(): Promise<AppSettings> {
  await ensureDirs();
  try {
    const raw = await readFile(SETTINGS_FILE, "utf-8");
    return mergeWithDefaults(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return mergeWithDefaults({});
  }
}

export async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  await ensureDirs();
  const merged = mergeWithDefaults(settings);
  await atomicWriteFile(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
