import { useCallback, useEffect, useReducer } from "react";
import type {
  AgentInfo,
  ClaudeCapabilities,
  McpServerInfo,
  ModelInfo,
  SlashItem,
} from "@shared/ipc";

/**
 * One capabilities probe per cwd, shared by every consumer.
 *
 * The probe boots a CLI subprocess, so a per-component `capabilities()` call
 * would spawn one per node. Results are cached here, in-flight asks are
 * collapsed, and subscribers re-render when an entry lands.
 */

const cache = new Map<string, ClaudeCapabilities>();
const inFlight = new Map<string, Promise<ClaudeCapabilities>>();
const listeners = new Set<(cwd: string) => void>();

const NO_COMMANDS: SlashItem[] = [];
const NO_MODELS: ModelInfo[] = [];
const NO_AGENTS: AgentInfo[] = [];
const NO_MCP_SERVERS: McpServerInfo[] = [];
const NO_SKILLS: string[] = [];

function emit(cwd: string): void {
  for (const listener of listeners) listener(cwd);
}

export function loadClaudeCapabilities(
  cwd: string | undefined,
  refresh = false,
): Promise<ClaudeCapabilities> {
  const key = cwd ?? "";
  if (!refresh) {
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const settle = (value: ClaudeCapabilities): ClaudeCapabilities => {
    cache.set(key, value);
    inFlight.delete(key);
    emit(key);
    return value;
  };

  const probe = window.api.claude
    .capabilities(key, refresh)
    .then(settle)
    .catch((err: unknown) =>
      settle({
        cwd: key,
        commands: [],
        models: [],
        agents: [],
        mcpServers: [],
        skills: [],
        error: err instanceof Error ? err.message : String(err),
      }),
    );

  inFlight.set(key, probe);
  emit(key);
  return probe;
}

export function invalidateClaudeCapabilities(cwd?: string): void {
  if (cwd === undefined) cache.clear();
  else cache.delete(cwd);
  emit(cwd ?? "");
}

export type ClaudeCapabilitiesState = {
  commands: SlashItem[];
  models: ModelInfo[];
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  skills: string[];
  account: ClaudeCapabilities["account"];
  loading: boolean;
  /** Set when the probe itself failed — consumers fall back to their defaults. */
  error: string | undefined;
  refresh: () => void;
};

type Options = {
  /** Skip the probe until the consumer actually needs it (e.g. a popover opens). */
  enabled?: boolean;
};

export function useClaudeCapabilities(
  cwd: string | undefined,
  { enabled = true }: Options = {},
): ClaudeCapabilitiesState {
  const key = cwd ?? "";
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const listener = (changed: string): void => {
      if (changed === key) rerender();
    };
    listeners.add(listener);
    if (enabled) void loadClaudeCapabilities(key);
    return () => {
      listeners.delete(listener);
    };
  }, [key, enabled]);

  const refresh = useCallback(() => {
    void loadClaudeCapabilities(key, true);
  }, [key]);

  const caps = cache.get(key);
  return {
    commands: caps?.commands ?? NO_COMMANDS,
    models: caps?.models ?? NO_MODELS,
    agents: caps?.agents ?? NO_AGENTS,
    mcpServers: caps?.mcpServers ?? NO_MCP_SERVERS,
    skills: caps?.skills ?? NO_SKILLS,
    account: caps?.account,
    loading: inFlight.has(key),
    error: caps?.error,
    refresh,
  };
}
