import type { McpServerConfig, Options, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type {
  AppSettings,
  McpServerSetting,
  NodeSettings,
  PermissionMode,
  ThinkingSetting,
} from "@shared/types";

/**
 * Turns app + node settings into SDK `Options`.
 *
 * Kept apart from the runner so there is exactly one place where a Claude Code
 * flag becomes a value we send. Previously the live path forwarded none of these
 * — not even `--model` — because the mapping was scattered across two hosts and
 * silently fell out of the call.
 */

/**
 * Built-in agentic tools dropped in chat-only mode. Removing them from the
 * model's context means the SDK doesn't ship their descriptions on every turn —
 * that's the bulk of the per-request token tax.
 */
export const CHAT_ONLY_DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "SlashCommand",
  "ExitPlanMode",
];

export type ResolvedRunSettings = {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  chatOnly: boolean;
  effort?: NodeSettings["effort"];
  thinking?: ThinkingSetting;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  agent?: string;
  skills?: string[] | "all";
  settingSources?: SettingSource[];
  checkpointing: boolean;
  showHookEvents: boolean;
  forwardSubagentText: boolean;
  agentProgressSummaries: boolean;
  mcpServers?: Record<string, McpServerSetting>;
  pluginPaths?: string[];
};

/**
 * Merge app defaults with per-node overrides.
 *
 * `acceptEdits` is the app default rather than the CLI's `default`: on a canvas
 * the agent is expected to actually edit files, and prompting for every write
 * would make the tool unusable. Anything genuinely destructive (Bash, deletes)
 * still routes through `canUseTool`.
 */
export function resolveRunSettings(
  settings: AppSettings,
  node: NodeSettings | undefined,
  cwd: string,
  oneShotPermissionMode?: PermissionMode,
  oneShotChatOnly?: boolean,
): ResolvedRunSettings {
  const permissionMode =
    oneShotPermissionMode ??
    node?.permissionMode ??
    // Back-compat: nodes saved before permission modes existed carry `planMode`.
    (node?.planMode ? "plan" : undefined) ??
    settings.defaultPermissionMode ??
    "acceptEdits";

  return {
    cwd,
    model: node?.model ?? settings.providers?.claude?.model ?? settings.claudeModel ?? undefined,
    permissionMode,
    // Plan mode needs the full agent preset to produce a plan, so chat-only loses.
    chatOnly: (oneShotChatOnly ?? node?.chatOnly ?? false) && permissionMode !== "plan",
    effort: node?.effort ?? settings.defaultEffort,
    thinking: node?.thinking ?? settings.defaultThinking,
    allowedTools: node?.allowedTools,
    disallowedTools: node?.disallowedTools,
    additionalDirectories: node?.additionalDirectories,
    maxTurns: node?.maxTurns ?? settings.maxTurns,
    maxBudgetUsd: node?.maxBudgetUsd ?? settings.maxBudgetUsd,
    fallbackModel: node?.fallbackModel,
    agent: node?.agent,
    skills: node?.skills ?? settings.skills,
    settingSources: (node?.settingSources ?? settings.settingSources) as SettingSource[] | undefined,
    checkpointing: node?.checkpointing ?? settings.checkpointing ?? false,
    showHookEvents: settings.showHookEvents ?? false,
    forwardSubagentText: settings.forwardSubagentText ?? true,
    agentProgressSummaries: settings.agentProgressSummaries ?? true,
    mcpServers: settings.mcpServers,
    pluginPaths: settings.pluginPaths,
  };
}

export type BuildOptionsInput = {
  resolved: ResolvedRunSettings;
  executable?: string;
  abortController: AbortController;
  systemPromptAppend: string;
  /** In-process MCP servers the app itself provides (the ask-user picker). */
  sdkMcpServers: Record<string, McpServerConfig>;
  canUseTool?: Options["canUseTool"];
  resumeSessionId?: string;
  forkSession?: boolean;
};

export function buildClaudeOptions(input: BuildOptionsInput): Options {
  const r = input.resolved;

  // `bypassPermissions` is the one mode the SDK refuses to enter without an
  // explicit opt-in, and it's also the one mode where an approval callback would
  // never fire — so drop the callback there rather than pretending it applies.
  const bypass = r.permissionMode === "bypassPermissions";

  const options: Options = {
    cwd: r.cwd,
    permissionMode: r.permissionMode,
    abortController: input.abortController,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: input.executable,
    mcpServers: { ...toSdkMcpServers(r.mcpServers), ...input.sdkMcpServers },
    // Unset means "load everything", matching the CLI. An explicit [] would
    // silently drop CLAUDE.md, which is never what a canvas user wants.
    settingSources: r.settingSources ?? ["user", "project", "local"],
    forwardSubagentText: r.forwardSubagentText,
    agentProgressSummaries: r.agentProgressSummaries,
    includeHookEvents: r.showHookEvents,
    enableFileCheckpointing: r.checkpointing,
  };

  if (bypass) options.allowDangerouslySkipPermissions = true;
  else if (input.canUseTool) options.canUseTool = input.canUseTool;

  if (r.model) options.model = r.model;
  if (r.fallbackModel) options.fallbackModel = r.fallbackModel;
  if (r.effort) options.effort = r.effort;
  if (r.thinking) options.thinking = r.thinking;
  if (r.maxTurns !== undefined) options.maxTurns = r.maxTurns;
  if (r.maxBudgetUsd !== undefined) options.maxBudgetUsd = r.maxBudgetUsd;
  if (r.agent) options.agent = r.agent;
  if (r.skills) options.skills = r.skills;
  if (r.additionalDirectories?.length) options.additionalDirectories = r.additionalDirectories;
  if (r.pluginPaths?.length) {
    options.plugins = r.pluginPaths.map((path) => ({ type: "local" as const, path }));
  }

  // Chat-only strips the agent preset and the tools it advertises; otherwise use
  // Claude Code's own system prompt so behaviour matches the CLI.
  if (r.chatOnly) {
    if (input.systemPromptAppend) options.systemPrompt = input.systemPromptAppend;
    options.disallowedTools = dedupe([
      ...CHAT_ONLY_DISALLOWED_TOOLS,
      ...(r.disallowedTools ?? []),
    ]);
  } else {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: input.systemPromptAppend,
    };
    // The built-in AskUserQuestion tool renders nothing in this app; the
    // in-process `lmc` MCP server provides the canvas-native picker instead.
    options.disallowedTools = dedupe(["AskUserQuestion", ...(r.disallowedTools ?? [])]);
  }

  if (r.allowedTools?.length) options.allowedTools = r.allowedTools;

  if (input.resumeSessionId) {
    options.resume = input.resumeSessionId;
    if (input.forkSession) options.forkSession = true;
  }

  return options;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function toSdkMcpServers(
  servers: Record<string, McpServerSetting> | undefined,
): Record<string, McpServerConfig> {
  if (!servers) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === "stdio") {
      out[name] = { type: "stdio", command: cfg.command, args: cfg.args, env: cfg.env };
    } else {
      out[name] = { type: cfg.type, url: cfg.url, headers: cfg.headers };
    }
  }
  return out;
}
