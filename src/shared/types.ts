export type NodeId = string;

export type MessageStatus = "streaming" | "complete" | "error";

export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  result?: { content: string; isError: boolean };
};

export type ThinkingBlock = { type: "thinking"; text: string };

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  content: string;
  status: TodoStatus;
  activeForm?: string;
};

/**
 * A subagent turn nested under a `Task` tool call. Populated when the runner
 * forwards subagent text (`forwardSubagentText`), so the UI can render the
 * nested transcript instead of an opaque spinner.
 */
export type SubagentBlock = {
  type: "subagent";
  /** The `Task` tool_use id this transcript belongs to. */
  parentToolUseId: string;
  /** Short present-tense status line, when progress summaries are enabled. */
  summary?: string;
  blocks: (TextBlock | ThinkingBlock | ToolUseBlock)[];
};

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ImageBlock = {
  type: "image";
  mediaType: ImageMediaType;
  base64: string;
};

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | ImageBlock
  | SubagentBlock;

export type ErrorCode = "auth_required" | "max_turns" | "max_budget" | "interrupted";

export type UsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
};

/** A model-proposed follow-up action. Rendered as a button under the assistant message;
 *  clicking creates a child node prefilled with `prompt` and auto-submits it. */
export type Suggestion = { label: string; prompt: string };

export type Message = {
  id: string;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  createdAt: number;
  /** Provider that generated this assistant message. */
  provider?: Provider;
  /** Per-message token/cost usage, when reported by the provider CLI. */
  usage?: UsageSummary;
  status?: MessageStatus;
  error?: string;
  /** Machine-readable error category — drives in-UI affordances like "Re-authenticate". */
  errorCode?: ErrorCode;
  /** Which provider produced the error (so the UI can guide re-auth). */
  errorProvider?: Provider;
  /** Parsed from a trailing `<next-steps>` block in the model's response. */
  suggestions?: Suggestion[];
};

export type ChatData = {
  messages: Message[];
  parentIds: NodeId[];
  childIds: NodeId[];
  addedContext?: string;
  /**
   * Claude Code session this node's conversation lives in. Set from the SDK's
   * `init` message on the first turn and reused via `resume` on later turns, so
   * the transcript is never re-sent as text. Branching a child forks it.
   */
  sessionId?: string;
  /** When true, the node auto-deletes 10s after its assistant message completes,
   *  unless hovered (hover resets the countdown). Set when the user creates a
   *  follow-up via the Timer half of the selection split-button. */
  isTemporary?: boolean;
};

export type CanvasNodeType = "custom" | "stickyNote";

/** Mirrors the CLI's `--permission-mode`. */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
] as const;

/** Mirrors the CLI's `--effort`. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Mirrors the SDK's `ThinkingConfig`. `budgetTokens` only applies to `enabled`. */
export type ThinkingSetting =
  | { type: "adaptive" }
  | { type: "disabled" }
  | { type: "enabled"; budgetTokens: number };

/** Mirrors the CLI's `--setting-sources`. */
export type SettingSource = "user" | "project" | "local";

export const SETTING_SOURCES: readonly SettingSource[] = ["user", "project", "local"] as const;

/**
 * Per-node overrides. Everything here maps onto a Claude Code CLI flag or an
 * Agent SDK `Options` field; non-Claude providers ignore the Claude-only ones.
 */
export type NodeSettings = {
  provider?: Provider;
  /** Model override for this node. For Claude: e.g. "claude-sonnet-4-6". */
  model?: string;
  cwd?: string;
  /** Free-text branch label set by the user. No git detection. */
  branch?: string;
  /** @deprecated superseded by `permissionMode: "plan"`. Read for back-compat, never written. */
  planMode?: boolean;
  /** When true, skip the claude_code preset and disable agent tools — fast pure-chat path. Claude-only. */
  chatOnly?: boolean;

  /** `--permission-mode`. Unset → the app default (`acceptEdits`). Claude-only. */
  permissionMode?: PermissionMode;
  /** `--effort`. Claude-only. */
  effort?: EffortLevel;
  /** Extended-thinking control. Claude-only. */
  thinking?: ThinkingSetting;
  /** `--allowedTools`. Rules like `Bash(git *)` are supported verbatim. Claude-only. */
  allowedTools?: string[];
  /** `--disallowedTools`. Claude-only. */
  disallowedTools?: string[];
  /** `--add-dir`. Absolute paths the agent may touch beyond cwd. Claude-only. */
  additionalDirectories?: string[];
  /** `--max-turns`. Claude-only. */
  maxTurns?: number;
  /** `--max-budget-usd`. Claude-only. */
  maxBudgetUsd?: number;
  /** `--fallback-model`. Claude-only. */
  fallbackModel?: string;
  /** `--agent` — run the main thread as a named subagent. Claude-only. */
  agent?: string;
  /** Skills to enable. `"all"` or an explicit list. Claude-only. */
  skills?: string[] | "all";
  /** `--setting-sources`. Unset → user+project+local. Claude-only. */
  settingSources?: SettingSource[];
  /** Enable file checkpointing so a turn can be rewound. Claude-only. */
  checkpointing?: boolean;
};

/** Every key of NodeSettings — the single source of truth for merge/clear/inherit logic. */
export const NODE_SETTINGS_KEYS = [
  "provider",
  "model",
  "cwd",
  "branch",
  "planMode",
  "chatOnly",
  "permissionMode",
  "effort",
  "thinking",
  "allowedTools",
  "disallowedTools",
  "additionalDirectories",
  "maxTurns",
  "maxBudgetUsd",
  "fallbackModel",
  "agent",
  "skills",
  "settingSources",
  "checkpointing",
] as const satisfies readonly (keyof NodeSettings)[];

/** True when at least one override is actually set. */
export function hasNodeSettings(s: NodeSettings | undefined): boolean {
  if (!s) return false;
  return NODE_SETTINGS_KEYS.some((k) => s[k] !== undefined);
}

export type CanvasNode = {
  id: NodeId;
  type: CanvasNodeType;
  position: { x: number; y: number };
  data: {
    title?: string;
    chat: ChatData;
    stickyText?: string;
    /** User-resized node width in flow units. Falls back to NODE_WIDTH. */
    width?: number;
    /** Per-node overrides for provider / cwd / branch. Falls back to canvas defaults. */
    nodeSettings?: NodeSettings;
  };
};

export type CanvasEdge = {
  id: string;
  source: NodeId;
  target: NodeId;
  sourceHandle?: string;
  targetHandle?: string;
  /**
   * Pixel offset along the parent's local Y axis where the edge should attach,
   * captured at child-creation time so the connector emerges near the point
   * the user was looking at (cursor on right-click, or selection on branch).
   * Undefined → use default handle-based routing.
   */
  sourceYOffset?: number;
};

export type Provider = "claude" | "codex" | "cursor";

export const PROVIDERS: readonly Provider[] = ["claude", "codex", "cursor"] as const;

export type ProviderConfig = {
  /** Override the default binary name. */
  binPath?: string;
  /** Optional model override for this provider. */
  model?: string;
};

export type Canvas = {
  id: string;
  name: string;
  /** Default working directory inherited by nodes that don't override it. */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Which provider this canvas uses. Falls back to AppSettings.defaultProvider. */
  provider?: Provider;
};

export type CanvasSummary = {
  id: string;
  name: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  provider?: Provider;
};

export type AppSettings = {
  systemPrompt?: string;
  /** @deprecated kept for back-compat; mirrors providers.claude.model */
  claudeModel?: string;
  /** @deprecated kept for back-compat; mirrors providers.claude.binPath */
  claudeBinPath?: string;
  defaultProvider?: Provider;
  providers?: Partial<Record<Provider, ProviderConfig>>;
  onboardingCompleted?: boolean;
  terseToolNarration?: boolean;
  /** MRU folder paths picked anywhere in the app, newest first. Capped. */
  recentFolders?: string[];
  /** MRU branch labels typed anywhere in the app, newest first. Capped. */
  recentBranches?: string[];
  /** Last node-level overrides applied anywhere; used to seed new orphan nodes. */
  lastNodeSettings?: NodeSettings;

  /** App-wide default permission mode for new nodes. Defaults to `acceptEdits`. */
  defaultPermissionMode?: PermissionMode;
  /** App-wide default effort level. Unset → the CLI's own default. */
  defaultEffort?: EffortLevel;
  /** App-wide default thinking configuration. */
  defaultThinking?: ThinkingSetting;
  /** Which on-disk setting layers to load. Unset → user + project + local. */
  settingSources?: SettingSource[];
  /** Enable skills. `"all"`, an explicit list, or unset for the CLI default. */
  skills?: string[] | "all";
  /** Extra MCP servers, merged with whatever the CLI already loads from settings. */
  mcpServers?: Record<string, McpServerSetting>;
  /** Local plugin directories loaded for every session. */
  pluginPaths?: string[];
  /** Emit hook lifecycle events into the timeline. */
  showHookEvents?: boolean;
  /** Forward subagent text/thinking so Task blocks render a nested transcript. */
  forwardSubagentText?: boolean;
  /** Ask the model for periodic subagent progress summaries. */
  agentProgressSummaries?: boolean;
  /** Enable file checkpointing so turns can be rewound. */
  checkpointing?: boolean;
  /** Cap on turns per run. Unset → uncapped. */
  maxTurns?: number;
  /** Cap on spend per run, USD. Unset → uncapped. */
  maxBudgetUsd?: number;
  /** Persist per-tool "always allow" decisions across sessions. */
  alwaysAllowedTools?: string[];
  /**
   * Truncate persisted tool results to this many characters. Full text stays in
   * the live session; only the on-disk copy is capped. Defaults to 20000.
   */
  maxStoredToolResultChars?: number;
};

/** A user-configured MCP server. Mirrors the SDK's `McpServerConfig` subset we support. */
export type McpServerSetting =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };
