import { homedir } from "node:os";
import { readCanvas } from "./storage/canvases";
import { readSettings, writeSettings } from "./storage/settings";
import { buildPromptWithHistory } from "./claude/history";
import { runAgent } from "./agents";
import { runClaude } from "./claude/runner";
import { resolveRunSettings } from "./claude/options";
import { setAlwaysAllowedTools } from "./claude/permissions";
import type { RunnerEvent } from "./agents/types";
import type { ChatEvent, ChatStartArgs } from "@shared/ipc";
import type { Provider } from "@shared/types";

/**
 * One implementation of "run a prompt turn", shared by the Electron host and the
 * WebSocket host.
 *
 * Both used to carry their own copy. They drifted: the server passed the model
 * and the Electron path didn't, they built different system prompts, and only
 * one of them was updated when the runner's signature changed — which is how the
 * app shipped with `--model` silently dropped and a main process that no longer
 * compiled. A host now supplies only a transport.
 */

const TERSE_NARRATION_INSTRUCTION =
  "RESPONSE STYLE: Before each batch of tool calls (typically 1–5 parallel calls), write ONE very short action-form label as a single line — 3 to 8 words, MAX 10, gerund form. Examples: 'Reading the canvas store', 'Searching for tool handlers', 'Editing the badge component', 'Building the calculator UI'. Strict rules: (1) State ONLY the next action — never two sentences, never an acknowledgment followed by an action. (2) NEVER start with a reaction or judgment word: no 'Good', 'Great', 'Perfect', 'Nice', 'Cool', 'Awesome', 'Excellent', 'Got it', 'Done', 'OK', 'Okay', 'Alright', 'Hmm'. (3) NEVER describe what just happened or summarize a prior result — no 'X created.', 'X done.', 'X works.' Skip straight to the next action. (4) NEVER use first-person prefixes like 'I'll', 'Let me', 'I'm going to', 'Now I will'. (5) No trailing ellipsis. When you fire a long sequence of tool calls, insert a fresh action-form label every ~5 calls. Save longer prose for your final answer to the user.";

// Asks the model to usually end with a `<next-steps>` block listing 1–3
// follow-up prompts. The renderer strips this block from the visible text and
// renders each item as a clickable button that branches into a new child node.
const NEXT_STEPS_INSTRUCTION = `SUGGESTED NEXT STEPS: Default to ending most substantive responses with 1–3 proactive follow-up actions the user may want next, especially concrete things to build, refine, verify, compare, or explore. End your response with a block in this exact format:

<next-steps>
- Short label :: Full prompt the user could send as the next message
- Short label :: Full prompt the user could send as the next message
</next-steps>

Rules:
- Place the block at the very end of your response, after all other content. Nothing follows it.
- Each item is on its own line, starts with "- ", and uses " :: " (space-colon-colon-space) as the separator.
- Label is ≤6 words, sentence case, no trailing punctuation.
- Prompt is a complete, standalone instruction the user could send verbatim.
- Prefer at least 1 item whenever there is a plausible next build step, experiment, cleanup, verification step, or adjacent feature. It is okay if the suggestion is proactive rather than explicitly requested.
- Use 2–3 items when there are multiple useful directions, such as "build next", "improve UX", and "verify behavior".
- Omit the block only for tiny acknowledgments, direct factual answers with no useful follow-up, blocked/error responses where the next action is already stated in prose, or when every suggestion would be generic busywork.
- Never wrap the block in code fences or markdown. Never reference it in the prose above.`;

const PERSISTENT_PROCESS_INSTRUCTION = `LONG-RUNNING LOCAL PROCESSES: If the user asks you to start a dev server, watcher, preview server, or similar command that should remain available after your response completes, do not rely on a transient agent background job. Start it in a detached/nohup shell with output redirected to a log file, report the PID and log path, and verify the service over HTTP or with an equivalent health check when possible.`;

export type ActiveChat = {
  controller: AbortController;
  nodeId: string;
  sessionKey: string;
};

/** Runs currently in flight, keyed by chatId. Shared across hosts. */
export const activeChats = new Map<string, ActiveChat>();

export function abortChat(chatId: string): void {
  activeChats.get(chatId)?.controller.abort();
  activeChats.delete(chatId);
}

export function abortChatsForNode(nodeId: string): void {
  for (const [chatId, entry] of [...activeChats]) {
    if (entry.nodeId !== nodeId) continue;
    entry.controller.abort();
    activeChats.delete(chatId);
  }
}

export function abortChatsForSession(sessionKey: string): void {
  for (const [chatId, entry] of [...activeChats]) {
    if (entry.sessionKey !== sessionKey) continue;
    entry.controller.abort();
    activeChats.delete(chatId);
  }
}

export type ChatHost = {
  /** Identifies the window or socket that owns this run. */
  sessionKey: string;
  /** Deliver a streaming chat event to that client. */
  sendChatEvent: (ev: ChatEvent) => void;
  /** Deliver an out-of-band request (ask-user, permission) to that client. */
  sendToClient: (msg: object) => void;
};

export async function startChatRun(args: ChatStartArgs, host: ChatHost): Promise<void> {
  const {
    chatId,
    nodeId,
    canvasId,
    history,
    prompt,
    attachments,
    systemPromptOverride,
    nodeSettings,
    permissionMode: inlinePermissionMode,
    chatOnly: inlineChatOnly,
    resumeSessionId,
    forkSession,
  } = args;

  const send = host.sendChatEvent;

  const canvas = await readCanvas(canvasId);
  if (!canvas) {
    send({ chatId, nodeId, type: "error", message: `Canvas not found: ${canvasId}` });
    send({ chatId, nodeId, type: "done", isError: true });
    return;
  }

  const settings = await readSettings();
  setAlwaysAllowedTools(settings.alwaysAllowedTools ?? []);

  const provider: Provider =
    nodeSettings?.provider ?? canvas.provider ?? settings.defaultProvider ?? "claude";
  const providerCfg = settings.providers?.[provider];
  const binPath =
    providerCfg?.binPath ?? (provider === "claude" ? settings.claudeBinPath : undefined);
  const model =
    nodeSettings?.model ??
    providerCfg?.model ??
    (provider === "claude" ? settings.claudeModel : undefined);

  const basePrompt = systemPromptOverride ?? settings.systemPrompt ?? "";
  const withTerse = settings.terseToolNarration
    ? basePrompt
      ? `${basePrompt}\n\n${TERSE_NARRATION_INSTRUCTION}`
      : TERSE_NARRATION_INSTRUCTION
    : basePrompt;
  const builtInPrompt = `${PERSISTENT_PROCESS_INSTRUCTION}\n\n${NEXT_STEPS_INSTRUCTION}`;
  const systemPrompt = withTerse ? `${withTerse}\n\n${builtInPrompt}` : builtInPrompt;

  // Effective cwd: node override → canvas → user home (least-invasive fallback so
  // every provider runner — which require a string cwd — always has one).
  const effectiveCwd = nodeSettings?.cwd ?? canvas.cwd ?? homedir();

  const controller = new AbortController();
  activeChats.set(chatId, { controller, nodeId, sessionKey: host.sessionKey });

  send({ chatId, nodeId, type: "start" });

  const onEvent = (ev: RunnerEvent): void => {
    const translated = toChatEvent(chatId, nodeId, provider, ev);
    if (translated) send(translated);
  };

  try {
    if (provider === "claude") {
      const resolved = resolveRunSettings(
        settings,
        nodeSettings,
        effectiveCwd,
        inlinePermissionMode,
        inlineChatOnly,
      );

      // A resumable session already holds the transcript, so re-sending it as
      // text would duplicate every earlier turn and defeat prompt caching.
      const promptForRun = resumeSessionId
        ? prompt
        : buildPromptWithHistory(history, prompt);

      await runClaude(promptForRun, {
        resolved,
        binPath,
        systemPrompt,
        attachments,
        signal: controller.signal,
        chatId,
        nodeId,
        sessionKey: host.sessionKey,
        resumeSessionId,
        forkSession,
        sendToClient: host.sendToClient,
        persistAlwaysAllowRule,
        onEvent,
      });
    } else {
      await runAgent(provider, buildPromptWithHistory(history, prompt), {
        cwd: effectiveCwd,
        model,
        binPath,
        systemPrompt,
        attachments,
        signal: controller.signal,
        onEvent,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ chatId, nodeId, type: "error", message, provider });
    send({ chatId, nodeId, type: "done", isError: true, provider });
  } finally {
    activeChats.delete(chatId);
  }
}

/**
 * Persist an "always allow" rule the user just approved so the next run starts
 * pre-approved instead of asking again.
 */
async function persistAlwaysAllowRule(rule: string): Promise<void> {
  const settings = await readSettings();
  const existing = settings.alwaysAllowedTools ?? [];
  if (existing.includes(rule)) return;
  const next = [...existing, rule];
  await writeSettings({ ...settings, alwaysAllowedTools: next });
  setAlwaysAllowedTools(next);
}

function toChatEvent(
  chatId: string,
  nodeId: string,
  provider: Provider,
  ev: RunnerEvent,
): ChatEvent | null {
  const base = { chatId, nodeId };
  switch (ev.kind) {
    case "text_delta":
      return { ...base, type: "text_delta", text: ev.text };
    case "thinking_delta":
      return { ...base, type: "thinking_delta", text: ev.text };
    case "tool_use":
      return {
        ...base,
        type: "tool_use",
        toolUseId: ev.toolUseId,
        name: ev.name,
        input: ev.input,
        parentToolUseId: ev.parentToolUseId,
      };
    case "tool_result":
      return {
        ...base,
        type: "tool_result",
        toolUseId: ev.toolUseId,
        content: ev.content,
        isError: ev.isError,
        parentToolUseId: ev.parentToolUseId,
      };
    case "session":
      return { ...base, type: "session", sessionId: ev.sessionId };
    case "subagent_delta":
      return {
        ...base,
        type: "subagent_delta",
        parentToolUseId: ev.parentToolUseId,
        kind: ev.subKind,
        text: ev.text,
      };
    case "subagent_progress":
      return {
        ...base,
        type: "subagent_progress",
        parentToolUseId: ev.parentToolUseId,
        summary: ev.summary,
      };
    case "todos":
      return { ...base, type: "todos", todos: ev.todos };
    case "hook":
      return { ...base, type: "hook", event: ev.event, status: ev.status, detail: ev.detail };
    case "task_notification":
      return {
        ...base,
        type: "task_notification",
        taskId: ev.taskId,
        status: ev.status,
        summary: ev.summary,
      };
    case "prompt_suggestion":
      return { ...base, type: "prompt_suggestion", prompt: ev.prompt };
    case "compact":
      return { ...base, type: "compact", trigger: ev.trigger };
    case "error":
      return { ...base, type: "error", message: ev.message, code: ev.code, provider };
    case "done":
      return {
        ...base,
        type: "done",
        isError: ev.isError,
        result: ev.result,
        code: ev.code,
        usage: ev.usage,
        provider: ev.isError ? provider : undefined,
      };
  }
}
