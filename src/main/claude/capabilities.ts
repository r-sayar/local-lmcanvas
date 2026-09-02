import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCapabilities, McpServerInfo, ModelInfo, SlashItem } from "@shared/ipc";
import { resolveClaudeExecutable } from "./binary";

/**
 * Ask the CLI what it can actually do in a given directory.
 *
 * The app used to guess: it scanned `~/.claude/commands` and `.claude/skills`
 * off disk and hardcoded a three-model list. That misses every built-in command
 * (`/compact`, `/context`, `/review`…), every plugin-provided agent, and any
 * model the account has that the hardcoded list doesn't.
 *
 * Instead, start a query in streaming-input mode without ever sending a prompt.
 * The subprocess boots, answers control requests, and is closed again — no turn
 * is taken, so nothing is billed.
 */

const CACHE_TTL_MS = 60_000;
/** A cold CLI boot on a large repo is slow; below this we'd report spurious failures. */
const PROBE_TIMEOUT_MS = 30_000;

type CacheEntry = { at: number; value: ClaudeCapabilities };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ClaudeCapabilities>>();

export function invalidateCapabilities(cwd?: string): void {
  if (cwd === undefined) cache.clear();
  else cache.delete(cwd);
}

export async function getCapabilities(
  cwd: string,
  binPath: string | undefined,
  refresh = false,
): Promise<ClaudeCapabilities> {
  const key = cwd || "~";

  if (!refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  // Collapse concurrent asks for the same cwd — several nodes opening their
  // pickers at once would otherwise each spawn a CLI.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const probe = probeCapabilities(cwd, binPath)
    .then((value) => {
      // Don't cache failures; a transient auth blip shouldn't stick for a minute.
      if (!value.error) cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, probe);
  return probe;
}

async function probeCapabilities(
  cwd: string,
  binPath: string | undefined,
): Promise<ClaudeCapabilities> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let q: ReturnType<typeof query> | undefined;
  try {
    q = query({
      // Streaming input that never yields keeps the process alive and idle:
      // control requests work, but no turn is ever started.
      prompt: idleInput(controller.signal),
      options: {
        cwd: cwd || undefined,
        abortController: controller,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(binPath),
        settingSources: ["user", "project", "local"],
        // Nothing is generated, so don't let the probe write a session file.
        persistSession: false,
      },
    });

    const [commands, models, agents, mcpServers, init] = await Promise.all([
      q.supportedCommands().catch(() => []),
      q.supportedModels().catch(() => []),
      q.supportedAgents().catch(() => []),
      q.mcpServerStatus().catch(() => []),
      q.initializationResult().catch(() => undefined),
    ]);

    const account = await q.accountInfo().catch(() => undefined);

    return {
      cwd,
      commands: commands.map(toSlashItem),
      models: models.map(toModelInfo),
      agents: agents.map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model,
      })),
      mcpServers: mcpServers.map(toMcpServerInfo),
      skills: readSkills(init),
      account: account
        ? {
            email: readString(account, "email"),
            organization: readString(account, "organization"),
            subscription: readString(account, "subscriptionType") ?? readString(account, "subscription"),
          }
        : undefined,
    };
  } catch (err) {
    return {
      cwd,
      commands: [],
      models: [],
      agents: [],
      mcpServers: [],
      skills: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    try {
      q?.close();
    } catch {
      /* already torn down */
    }
  }
}

/** Never yields; resolves only when the probe is finished with the process. */
async function* idleInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function toSlashItem(cmd: { name: string; description: string; argumentHint?: string }): SlashItem {
  return {
    kind: "command",
    name: cmd.name,
    description: cmd.description,
    source: "cli",
    argumentHint: cmd.argumentHint || undefined,
  };
}

function toModelInfo(m: { value: string; displayName: string; description?: string }): ModelInfo {
  return { id: m.value, displayName: m.displayName, description: m.description };
}

function toMcpServerInfo(s: {
  name: string;
  status: string;
  error?: string;
}): McpServerInfo {
  const status = s.status;
  return {
    name: s.name,
    status:
      status === "connected" ||
      status === "failed" ||
      status === "needs-auth" ||
      status === "pending" ||
      status === "disabled"
        ? status
        : "pending",
    error: s.error,
  };
}

function readSkills(init: unknown): string[] {
  if (typeof init !== "object" || init === null) return [];
  const skills = (init as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((s): s is string => typeof s === "string");
}

function readString(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
