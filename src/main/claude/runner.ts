import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BetaContentBlock,
  BetaRawContentBlockDeltaEvent,
  BetaTextDelta,
  BetaThinkingDelta,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { Attachment } from "@shared/ipc";
import type { ErrorCode, TodoItem } from "@shared/types";
import { buildAskUserServer } from "./askUserMcp";
import { buildCanUseTool, type PersistRule } from "./permissions";
import { buildClaudeOptions, type ResolvedRunSettings } from "./options";
import { resolveClaudeExecutable } from "./binary";
import { registerRun, setRunSessionId, unregisterRun } from "./sessions";
import { isAuthError, type RunnerEvent } from "../agents/types";
import { normalizeUsage } from "../agents/usage";

export { CLAUDE_BIN_PATH } from "./binary";

const ASK_USER_SYSTEM_NOTE = `\n\nWhen you need to ask the local user a structured multiple-choice question, use the \`mcp__lmc__ask_user_question\` tool. It renders an interactive picker inside the local-lmcanvas app. Do NOT use the built-in AskUserQuestion tool — it is disabled in this environment.`;

export type { RunnerEvent };

export type RunClaudeOpts = {
  resolved: ResolvedRunSettings;
  binPath?: string;
  systemPrompt?: string;
  attachments?: Attachment[];
  signal?: AbortSignal;
  chatId: string;
  nodeId: string;
  /** Identifies the window/socket that owns this run, for routing prompts back. */
  sessionKey: string;
  /** Session to continue; absent starts a fresh one. */
  resumeSessionId?: string;
  /** Fork rather than extend `resumeSessionId` — canvas branching. */
  forkSession?: boolean;
  sendToClient: (msg: object) => void;
  persistAlwaysAllowRule: PersistRule;
  onEvent: (ev: RunnerEvent) => void;
};

export async function runClaude(prompt: string, opts: RunClaudeOpts): Promise<void> {
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const seenToolUseIds = new Set<string>();
  let doneEmitted = false;

  const emit = (ev: RunnerEvent): void => {
    if (ev.kind === "done") doneEmitted = true;
    if (ev.kind === "error" && !ev.code && isAuthError(ev.message)) {
      opts.onEvent({ ...ev, code: "auth_required" });
      return;
    }
    if (ev.kind === "done" && ev.isError && !ev.code && isAuthError(ev.result ?? "")) {
      opts.onEvent({ ...ev, code: "auth_required" });
      return;
    }
    opts.onEvent(ev);
  };

  const attachments = opts.attachments ?? [];
  // The plain-string path keeps behaviour identical for text-only turns; images
  // require streaming input because a string prompt has nowhere to put them.
  const promptInput: string | AsyncIterable<SDKUserMessage> =
    attachments.length > 0 ? buildStreamingPrompt(prompt, attachments) : prompt;

  const { resolved } = opts;
  const askUserServer = resolved.chatOnly
    ? undefined
    : buildAskUserServer(opts.sessionKey, opts.nodeId, opts.sendToClient, controller.signal);

  const systemPromptAppend = resolved.chatOnly
    ? (opts.systemPrompt ?? "")
    : `${opts.systemPrompt ?? ""}${ASK_USER_SYSTEM_NOTE}`;

  const canUseTool = buildCanUseTool({
    chatId: opts.chatId,
    nodeId: opts.nodeId,
    sessionKey: opts.sessionKey,
    send: opts.sendToClient,
    signal: controller.signal,
    persistRule: opts.persistAlwaysAllowRule,
  });

  const options = buildClaudeOptions({
    resolved,
    executable: resolveClaudeExecutable(opts.binPath),
    abortController: controller,
    systemPromptAppend,
    sdkMcpServers: askUserServer ? { lmc: askUserServer } : {},
    canUseTool,
    resumeSessionId: opts.resumeSessionId,
    forkSession: opts.forkSession,
  });

  let q: ReturnType<typeof query> | undefined;
  try {
    q = query({ prompt: promptInput, options });
    registerRun(opts.chatId, opts.nodeId, q);

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      handleMessage(msg, opts.chatId, seenToolUseIds, emit);
      // Keep iterating past `result` only when a prompt suggestion may still
      // arrive; otherwise stop so the subprocess is torn down promptly.
      if (msg.type === "result") break;
    }
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      emit({ kind: "done", isError: false, code: "interrupted" });
    } else {
      emit({ kind: "error", message: errorMessage(err) });
    }
  } finally {
    unregisterRun(opts.chatId);
    try {
      q?.close();
    } catch {
      /* already torn down */
    }
    if (!doneEmitted) emit({ kind: "done", isError: false });
  }
}

function handleMessage(
  msg: SDKMessage,
  chatId: string,
  seenToolUseIds: Set<string>,
  emit: (ev: RunnerEvent) => void,
): void {
  switch (msg.type) {
    case "stream_event":
      handleStreamEvent(msg, emit);
      return;
    case "assistant":
      handleAssistant(msg, seenToolUseIds, emit);
      return;
    case "user":
      handleUser(msg, emit);
      return;
    case "system":
      handleSystem(msg, chatId, emit);
      return;
    case "result":
      handleResult(msg, emit);
      return;
    default:
      handleAuxiliary(msg, emit);
      return;
  }
}

/**
 * Deltas that belong to the main thread only.
 *
 * Subagent output arrives with `parent_tool_use_id` set; forwarding it into the
 * same text stream would interleave a subagent's prose into the parent's answer,
 * so it is routed separately.
 */
function handleStreamEvent(
  msg: SDKPartialAssistantMessage,
  emit: (ev: RunnerEvent) => void,
): void {
  const event = msg.event;
  if (event.type !== "content_block_delta") return;
  const delta = (event as BetaRawContentBlockDeltaEvent).delta;
  const parentToolUseId = msg.parent_tool_use_id ?? undefined;

  if (delta.type === "text_delta") {
    const text = (delta as BetaTextDelta).text;
    if (parentToolUseId) {
      emit({ kind: "subagent_delta", parentToolUseId, subKind: "text", text });
    } else {
      emit({ kind: "text_delta", text });
    }
    return;
  }

  if (delta.type === "thinking_delta") {
    const text = (delta as BetaThinkingDelta).thinking;
    if (parentToolUseId) {
      emit({ kind: "subagent_delta", parentToolUseId, subKind: "thinking", text });
    } else {
      emit({ kind: "thinking_delta", text });
    }
  }
}

function handleAssistant(
  msg: SDKAssistantMessage,
  seenToolUseIds: Set<string>,
  emit: (ev: RunnerEvent) => void,
): void {
  const content = msg.message.content as BetaContentBlock[];
  const parentToolUseId = msg.parent_tool_use_id ?? undefined;

  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const tu = block as BetaToolUseBlock;
    if (seenToolUseIds.has(tu.id)) continue;
    seenToolUseIds.add(tu.id);

    emit({
      kind: "tool_use",
      toolUseId: tu.id,
      name: tu.name,
      input: tu.input,
      parentToolUseId,
    });

    // Lift the todo list out of the tool call so the UI can pin it instead of
    // making the user expand the last TodoWrite block to see current state.
    if (tu.name === "TodoWrite") {
      const todos = extractTodos(tu.input);
      if (todos) emit({ kind: "todos", todos });
    }
  }
}

function handleUser(msg: SDKUserMessage, emit: (ev: RunnerEvent) => void): void {
  const content = msg.message.content;
  if (typeof content === "string") return;
  const parentToolUseId = msg.parent_tool_use_id ?? undefined;

  for (const block of content as ContentBlockParam[]) {
    if (block.type !== "tool_result") continue;
    const tr = block as ToolResultBlockParam;
    emit({
      kind: "tool_result",
      toolUseId: tr.tool_use_id,
      content: toolResultContentToString(tr.content),
      isError: tr.is_error === true,
      parentToolUseId,
    });
  }
}

/**
 * `system` covers session init, hook lifecycle, task notifications and compaction.
 * All of it was previously discarded, which is why the app had no idea what
 * session it was in and could not resume one.
 */
function handleSystem(
  msg: Extract<SDKMessage, { type: "system" }>,
  chatId: string,
  emit: (ev: RunnerEvent) => void,
): void {
  const m = msg as unknown as Record<string, unknown>;
  const subtype = m.subtype as string | undefined;

  if (subtype === "init") {
    const sessionId = m.session_id as string | undefined;
    if (sessionId) {
      setRunSessionId(chatId, sessionId);
      emit({ kind: "session", sessionId });
    }
    return;
  }

  if (subtype === "task_progress") {
    const parentToolUseId = m.tool_use_id as string | undefined;
    const summary = (m.summary as string | undefined) ?? (m.description as string | undefined);
    if (parentToolUseId && summary) {
      emit({ kind: "subagent_progress", parentToolUseId, summary });
    }
    return;
  }

  if (subtype === "task_notification") {
    emit({
      kind: "task_notification",
      taskId: String(m.task_id ?? ""),
      status: String(m.status ?? ""),
      summary: typeof m.summary === "string" ? m.summary : undefined,
    });
    return;
  }

  if (subtype === "compact_boundary") {
    const meta = m.compact_metadata as { trigger?: string } | undefined;
    emit({ kind: "compact", trigger: meta?.trigger ?? "auto" });
    return;
  }

  if (subtype === "hook_started" || subtype === "hook_response" || subtype === "hook_progress") {
    const status =
      subtype === "hook_started"
        ? "started"
        : m.error !== undefined
          ? "failed"
          : "completed";
    emit({
      kind: "hook",
      event: String(m.hook_event_name ?? m.event ?? "hook"),
      status,
      detail: typeof m.error === "string" ? m.error : undefined,
    });
  }
}

/** Message types outside the core switch — currently prompt suggestions. */
function handleAuxiliary(msg: SDKMessage, emit: (ev: RunnerEvent) => void): void {
  const m = msg as unknown as Record<string, unknown>;
  if (m.type === "prompt_suggestion" && typeof m.prompt === "string") {
    emit({ kind: "prompt_suggestion", prompt: m.prompt });
  }
}

function handleResult(msg: SDKResultMessage, emit: (ev: RunnerEvent) => void): void {
  const usage = normalizeUsage((msg as { usage?: unknown }).usage, {
    totalCostUsd: (msg as { total_cost_usd?: unknown }).total_cost_usd,
  });

  if (msg.subtype === "success") {
    emit({ kind: "done", isError: msg.is_error, result: msg.result, usage });
    return;
  }

  const errText = msg.errors && msg.errors.length ? msg.errors.join("\n") : msg.subtype;
  emit({ kind: "done", isError: true, result: errText, usage, code: resultErrorCode(msg.subtype) });
}

function resultErrorCode(subtype: string): ErrorCode | undefined {
  if (subtype === "error_max_turns") return "max_turns";
  if (subtype === "error_max_budget_usd") return "max_budget";
  return undefined;
}

function extractTodos(input: unknown): TodoItem[] | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return undefined;

  const todos: TodoItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.content !== "string") continue;
    const status = t.status;
    todos.push({
      content: t.content,
      status:
        status === "in_progress" || status === "completed" || status === "pending"
          ? status
          : "pending",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
    });
  }
  return todos.length > 0 ? todos : undefined;
}

function toolResultContentToString(content: ToolResultBlockParam["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "text") {
      parts.push(c.text);
    } else {
      // images / docs / search results aren't meaningful to render as plain text;
      // surface a placeholder so the UI knows something was there
      parts.push(`[${c.type}]`);
    }
  }
  return parts.join("\n");
}

async function* buildStreamingPrompt(
  text: string,
  attachments: Attachment[],
): AsyncIterable<SDKUserMessage> {
  const content: ContentBlockParam[] = [];
  if (text.length > 0) {
    const tb: TextBlockParam = { type: "text", text };
    content.push(tb);
  }
  for (const a of attachments) {
    const ib: ImageBlockParam = {
      type: "image",
      source: { type: "base64", media_type: a.mediaType, data: a.base64 },
    };
    content.push(ib);
  }
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return `Claude Code executable not found. Install Claude Code so the SDK can spawn it. (${err.message})`;
    }
    return err.message;
  }
  return String(err);
}
