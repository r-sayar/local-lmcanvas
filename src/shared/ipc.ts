import type {
  AppSettings,
  Canvas,
  CanvasSummary,
  ErrorCode,
  ImageMediaType,
  Message,
  NodeSettings,
  PermissionMode,
  Provider,
  TodoItem,
  UsageSummary,
} from "./types";

export type AskUserOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserOption[];
};

export type AskUserRequest = {
  /** Correlates this request with the response. */
  id: string;
  /** The node that initiated the chat which triggered this question. */
  nodeId: string;
  questions: AskUserQuestion[];
};

/** Per-question answers. Single-select → string; multi-select → string[]. */
export type AskUserAnswers = Record<string, string | string[]>;

export type AskUserResponsePayload =
  | { id: string; cancelled: false; answers: AskUserAnswers; notes?: Record<string, string> }
  | { id: string; cancelled: true };


export type Attachment = {
  mediaType: ImageMediaType;
  base64: string;
};

export type FileEntry = {
  path: string;
  type: "file" | "dir";
};

export type SlashItemKind = "command" | "skill";
export type SlashItemSource =
  | "user"
  | "project"
  | "plugin"
  | "builtin"
  | "cli";

export type SlashItem = {
  kind: SlashItemKind;
  /** Name without the leading slash. Namespaced commands use `ns:name`. */
  name: string;
  /** One-line description from frontmatter (skills) or first paragraph (commands). */
  description: string;
  source: SlashItemSource;
  /** Argument hint shown after the name, e.g. `<path>`. From the CLI registry. */
  argumentHint?: string;
  /** True when the app handles this locally instead of forwarding it to the CLI. */
  clientSide?: boolean;
};

/** A model the CLI reports as available. */
export type ModelInfo = {
  id: string;
  displayName: string;
  description?: string;
};

/** A subagent the CLI has discovered (project, user, or plugin scope). */
export type AgentInfo = {
  name: string;
  description: string;
  source?: string;
  model?: string;
  tools?: string[];
};

export type McpServerState = "connected" | "failed" | "needs-auth" | "pending" | "disabled";

export type McpServerInfo = {
  name: string;
  status: McpServerState;
  /** Tool names the server exposes, when connected. */
  tools?: string[];
  error?: string;
};

/** Everything the CLI can tell us about a working directory, in one round trip. */
export type ClaudeCapabilities = {
  cwd: string;
  commands: SlashItem[];
  models: ModelInfo[];
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  /** Skill names discovered for this cwd. */
  skills: string[];
  /** Account email / subscription, when the CLI reports it. */
  account?: { email?: string; organization?: string; subscription?: string };
  /** Populated instead of the above when the probe failed. */
  error?: string;
};

export type ContextUsageEntry = {
  label: string;
  tokens: number;
};

export type ContextUsage = {
  totalTokens: number;
  maxTokens?: number;
  breakdown: ContextUsageEntry[];
};

/** A tool call awaiting the user's decision, surfaced by the runner's `canUseTool`. */
export type PermissionRequest = {
  id: string;
  /** Node whose chat triggered the call, so the prompt renders inline. */
  nodeId: string;
  chatId: string;
  toolName: string;
  input: unknown;
  /** Human-readable one-liner, e.g. the bash command or the file path. */
  summary?: string;
  /** Rule the app would persist if the user picks "always allow", e.g. `Bash(git *)`. */
  alwaysAllowRule?: string;
};

export type PermissionDecision =
  | { id: string; behavior: "allow"; /** Persist `alwaysAllowRule` into settings. */ always?: boolean }
  | { id: string; behavior: "deny"; message?: string };

export type ChatStartArgs = {
  chatId: string;
  /** The node initiating the chat — surfaced to the askUser flow so prompts render inline. */
  nodeId: string;
  canvasId: string;
  /**
   * Transcript fallback. Only sent to the model when there is no resumable
   * session (non-Claude providers, or the very first turn after an upgrade).
   */
  history: Message[];
  prompt: string;
  attachments?: Attachment[];
  systemPromptOverride?: string;
  /** Per-node overrides for provider / cwd. Resolved against canvas defaults in main. */
  nodeSettings?: NodeSettings;
  /** One-shot permission mode for this turn (e.g. from an inline `/plan`). */
  permissionMode?: PermissionMode;
  /** One-shot chat-only flag (from inline `/chat`). ORed with nodeSettings.chatOnly. */
  chatOnly?: boolean;
  /**
   * Claude session to continue. When absent the runner starts a fresh session.
   * When `forkSession` is set the session is branched rather than extended.
   */
  resumeSessionId?: string;
  /** Fork `resumeSessionId` into a new session — how canvas branching maps onto the CLI. */
  forkSession?: boolean;
};

/**
 * Every event carries the node it belongs to, not just the chat.
 *
 * Global listeners (the permission queue, the timeline) receive events without
 * any way back to a node otherwise, so the UI could not tell which node a live
 * run belonged to — which is what stopped a mid-run permission-mode or model
 * change from reaching the right session.
 */
type ChatEventBase = { chatId: string; nodeId: string };

export type ChatEvent = ChatEventBase & (
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: unknown;
      /** Set when the call came from a subagent rather than the main thread. */
      parentToolUseId?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      parentToolUseId?: string;
    }
  | { type: "thinking_delta"; text: string }
  /** The CLI session backing this node, emitted once per run from the `init` message. */
  | { type: "session"; sessionId: string }
  /** Text or thinking produced inside a subagent, keyed by its parent `Task` call. */
  | {
      type: "subagent_delta";
      parentToolUseId: string;
      kind: "text" | "thinking";
      text: string;
    }
  /** Periodic present-tense status for a running subagent. */
  | {
      type: "subagent_progress";
      parentToolUseId: string;
      summary: string;
    }
  /** Latest TodoWrite state, lifted out of the tool block so the UI can pin it. */
  | { type: "todos"; todos: TodoItem[] }
  /** A hook fired. Only emitted when `showHookEvents` is on. */
  | {
      type: "hook";
      event: string;
      status: "started" | "completed" | "failed";
      detail?: string;
    }
  /** A backgrounded Bash command or subagent changed state. */
  | {
      type: "task_notification";
      taskId: string;
      status: string;
      summary?: string;
    }
  /** Model-predicted next prompt, delivered after the result. */
  | { type: "prompt_suggestion"; prompt: string }
  /** Context compaction happened mid-run. */
  | { type: "compact"; trigger: string }
  | {
      type: "done";
      isError?: boolean;
      result?: string;
      code?: ErrorCode;
      provider?: Provider;
      usage?: UsageSummary;
    }
  | {
      type: "error";
      message: string;
      code?: ErrorCode;
      provider?: Provider;
    });

export type CanvasCreateArgs = {
  name?: string;
  cwd?: string;
  provider?: Provider;
};

export type GroupSummaryCandidateIpc = {
  nodeId: string;
  prompt: string;
};

export type GeneratedGroupSummaryIpc = {
  title: string;
  nodeIds: string[];
  metadata?: {
    confidence?: number;
    promptVersion?: string;
    generationModel?: string;
  };
};

export type GenerateGroupSummaryRequest = {
  candidates: GroupSummaryCandidateIpc[];
  existingGroupTitles?: string[];
};

export type GenerateCanvasNameRequest = {
  prompt: string;
};

export type PersistentProcessStartArgs = {
  command: string;
  cwd?: string;
};

export type PersistentProcessStartResult = {
  id: string;
  pid: number;
  logPath: string;
};

export type PersistentProcessStopResult = {
  stopped: boolean;
  message?: string;
};

export type ProviderAuthStatus = {
  provider: Provider;
  installed: boolean;
  authenticated: boolean;
  binPath: string | null;
  /** Optional message — e.g. version string when ok, or error explanation when not. */
  detail?: string;
};

export type TerminalCreateArgs = {
  id: string;
  cwd: string;
};

export type LmcApi = {
  canvases: {
    list(): Promise<CanvasSummary[]>;
    create(args: CanvasCreateArgs): Promise<Canvas>;
    read(id: string): Promise<Canvas | null>;
    write(canvas: Canvas): Promise<void>;
    delete(id: string): Promise<void>;
  };
  settings: {
    read(): Promise<AppSettings>;
    write(s: AppSettings): Promise<AppSettings>;
  };
  chat: {
    start(args: ChatStartArgs): Promise<void>;
    /** Hard-abort: kills the underlying CLI process. */
    cancel(chatId: string): Promise<void>;
    /**
     * Graceful stop — asks the CLI to wind down the current turn so the partial
     * transcript stays usable and the session stays resumable. Falls back to
     * `cancel` when the run has no live session.
     */
    interrupt(chatId: string): Promise<void>;
    /** Cancel any in-progress chats associated with the given node. */
    cancelForNode(nodeId: string): Promise<void>;
    /** Change the permission mode of a run already in flight. */
    setPermissionMode(chatId: string, mode: PermissionMode): Promise<void>;
    /** Change the model of a run already in flight. */
    setModel(chatId: string, model?: string): Promise<void>;
    /** Push in-flight foreground work (Bash, subagents) to the background. */
    backgroundTasks(chatId: string, toolUseId?: string): Promise<boolean>;
    /** Token breakdown for a live run, or null when it has already finished. */
    contextUsage(chatId: string): Promise<ContextUsage | null>;
    onEvent(handler: (ev: ChatEvent) => void): () => void;
  };
  permissions: {
    /** Subscribe to tool-approval requests. Returns an unsubscribe function. */
    onRequest(handler: (req: PermissionRequest) => void): () => void;
    /** Answer a pending request. */
    respond(decision: PermissionDecision): Promise<void>;
  };
  claude: {
    /**
     * Ask the CLI what it supports in this directory: slash commands, models,
     * subagents, MCP servers, skills. Cached per cwd; pass `refresh` to re-probe.
     */
    capabilities(cwd: string, refresh?: boolean): Promise<ClaudeCapabilities>;
    /** Restore files to their state at the given user message. Needs checkpointing on. */
    rewind(
      chatId: string,
      userMessageId: string,
      dryRun?: boolean,
    ): Promise<{ canRewind: boolean; error?: string; filesChanged?: number }>;
  };
  dialog: {
    pickFolder(defaultPath?: string): Promise<string | null>;
  };
  shell: {
    openPath(path: string): Promise<void>;
  };
  processes: {
    /** Start a long-running shell command detached from the agent turn. */
    start(args: PersistentProcessStartArgs): Promise<PersistentProcessStartResult>;
    /** Stop an app-started detached process while it is still tracked in this session. */
    stop(id: string): Promise<PersistentProcessStopResult>;
  };
  files: {
    list(cwd: string): Promise<FileEntry[]>;
  };
  slash: {
    /** List slash commands + skills available from `~/.claude` and the canvas cwd. */
    list(cwd: string): Promise<SlashItem[]>;
  };
  providers: {
    /** Probe a provider's CLI install + auth state. */
    authStatus(provider: Provider): Promise<ProviderAuthStatus>;
    /** Open a shell session to run `<bin> login` for the given provider, in the user's terminal. */
    openLoginTerminal(provider: Provider): Promise<void>;
  };
  askUser: {
    /** Subscribe to incoming ask-user requests from the agent. Returns an unsubscribe function. */
    onRequest(handler: (req: AskUserRequest) => void): () => void;
    /** Send the user's answers (or cancellation) back to the agent. */
    respond(payload: AskUserResponsePayload): Promise<void>;
  };
  window: {
    /** Open a new app window. If `canvasId` is provided, the new window opens directly on that canvas. */
    openCanvas(canvasId?: string): Promise<void>;
  };
  groupSummary: {
    /** Generate LLM-backed titles for ordered candidate prompts. Returns [] on failure so the caller can fall back to the heuristic clusterer. */
    generate(args: GenerateGroupSummaryRequest): Promise<GeneratedGroupSummaryIpc[]>;
  };
  canvasName: {
    /** Generate an LLM-backed canvas name from the first prompt. Returns null on failure so the caller keeps its prompt-derived fallback. */
    generate(args: GenerateCanvasNameRequest): Promise<string | null>;
  };
  terminal: {
    /** Create (or attach to existing) a PTY running `claude` in the given cwd. */
    create(args: TerminalCreateArgs): Promise<void>;
    /** Send raw input bytes to the PTY. */
    input(id: string, data: string): void;
    /** Notify the PTY of a terminal resize. */
    resize(id: string, cols: number, rows: number): void;
    /** Kill the PTY session. */
    kill(id: string): Promise<void>;
    /** Subscribe to data coming back from the PTY. Returns an unsubscribe fn. */
    onData(handler: (id: string, data: string) => void): () => void;
  };
};

declare global {
  interface Window {
    api: LmcApi;
  }
}
