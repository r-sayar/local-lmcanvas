import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useCanvasStoreApi } from "./useCanvasStore";
import type {
  CanvasNode,
  ImageBlock,
  NodeId,
  Provider,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ContentBlock,
} from "@shared/types";
import type { Attachment, ChatEvent } from "@shared/ipc";
import { buildMergeContext } from "@shared/history";
import { isUnnamedCanvasName, promptToCanvasName } from "@shared/canvasName";
import { createNextStepsStreamer } from "@/lib/nextStepsParser";
import { parseInlineCommands } from "@/lib/inlineCommands";

export function useNodeChat(nodeId: NodeId) {
  const storeApi = useCanvasStoreApi();
  const [streaming, setStreaming] = useState(false);
  const activeChatIdRef = useRef<string | null>(null);

  const submit = useCallback(
    async (promptText: string, attachments: Attachment[] = []) => {
      const trimmed = promptText.trim();
      if (!trimmed && attachments.length === 0) return;

      const canvasId = storeApi.getState().canvasId;
      if (!canvasId) {
        return;
      }

      setStreaming(true);

      const store = storeApi.getState();
      const nodeBeforeSubmit = store.nodes[nodeId];
      const shouldNameCanvas =
        isUnnamedCanvasName(store.name) &&
        !!trimmed &&
        !!nodeBeforeSubmit &&
        !nodeBeforeSubmit.data.chat.messages.some((m) => m.role === "user");
      const isFirstMergePrompt =
        !!nodeBeforeSubmit &&
        nodeBeforeSubmit.data.chat.parentIds.length > 1 &&
        nodeBeforeSubmit.data.chat.messages.length === 0;
      let mergeContext = "";
      if (isFirstMergePrompt) {
        const parents = nodeBeforeSubmit.data.chat.parentIds
          .map((pid) => store.nodes[pid])
          .filter((n): n is CanvasNode => Boolean(n));
        mergeContext = buildMergeContext(parents);
      }
      const userMsgId = nanoid();
      const userBlocks: ContentBlock[] = [];
      if (trimmed) {
        userBlocks.push({ type: "text", text: trimmed } satisfies TextBlock);
      }
      for (const a of attachments) {
        userBlocks.push({
          type: "image",
          mediaType: a.mediaType,
          base64: a.base64,
        } satisfies ImageBlock);
      }
      store.appendMessage(nodeId, {
        id: userMsgId,
        role: "user",
        blocks: userBlocks,
        createdAt: Date.now(),
        status: "complete",
      });

      if (shouldNameCanvas) {
        const fallbackName = promptToCanvasName(trimmed);
        if (fallbackName) {
          storeApi.getState().setName(fallbackName);
          const notifyCanvasList = () =>
            window.dispatchEvent(new Event("lmc:canvases-changed"));
          void storeApi
            .getState()
            .save()
            .then(notifyCanvasList)
            .catch((err) =>
              console.error("Failed to save prompt-derived canvas name:", err),
            );
          void window.api.canvasName
            .generate({ prompt: trimmed })
            .then((generatedName) => {
              if (!generatedName) return;
              const currentName = storeApi.getState().name;
              if (currentName !== fallbackName && !isUnnamedCanvasName(currentName)) {
                return;
              }
              storeApi.getState().setName(generatedName);
              void storeApi
                .getState()
                .save()
                .then(notifyCanvasList)
                .catch((err) =>
                  console.error("Failed to save generated canvas name:", err),
                );
            })
            .catch((err) =>
              console.error("Failed to generate canvas name:", err),
            );
        }
      }

      const asstMsgId = nanoid();
      const messageProvider: Provider = store.getEffectiveProvider(nodeId);
      store.appendMessage(nodeId, {
        id: asstMsgId,
        role: "assistant",
        provider: messageProvider,
        blocks: [],
        createdAt: Date.now(),
        status: "streaming",
      });

      const fullHistory = storeApi.getState().getHistoryForNode(nodeId);
      const history = fullHistory.slice(0, -2);

      const chatId = nanoid();
      activeChatIdRef.current = chatId;

      // Per-stream parser that strips any trailing `<next-steps>` block from
      // the visible text and persists the parsed items on the assistant
      // message. State lives inside this closure so concurrent chats can't
      // bleed into each other.
      const nextStepsStreamer = createNextStepsStreamer({
        onText: (text) =>
          storeApi.getState().appendTextDelta(nodeId, asstMsgId, text),
        onSuggestions: (suggestions) =>
          storeApi.getState().setSuggestions(nodeId, asstMsgId, suggestions),
      });

      let off: (() => void) | null = null;
      const cleanup = () => {
        // Flush any remaining buffered text (e.g. an unterminated <next-steps>
        // block) so we don't silently swallow it.
        nextStepsStreamer.flush();
        if (off) {
          off();
          off = null;
        }
        setStreaming(false);
        activeChatIdRef.current = null;
        void storeApi.getState().save();
      };

      off = window.api.chat.onEvent((ev: ChatEvent) => {
        if (ev.chatId !== chatId) return;
        const s = storeApi.getState();
        switch (ev.type) {
          case "start":
            return;
          case "text_delta":
            nextStepsStreamer.ingest(ev.text);
            return;
          case "thinking_delta": {
            // Flush held-back text first so any pending characters land
            // before the new non-text block.
            nextStepsStreamer.flush();
            const block: ThinkingBlock = { type: "thinking", text: ev.text };
            s.appendBlock(nodeId, asstMsgId, block);
            return;
          }
          case "tool_use": {
            nextStepsStreamer.flush();
            const block: ToolUseBlock = {
              type: "tool_use",
              id: ev.toolUseId,
              name: ev.name,
              input: ev.input,
            };
            // A subagent's own tool calls belong inside its Task block, not
            // interleaved with the main thread's.
            if (ev.parentToolUseId) {
              s.appendSubagentBlock(nodeId, asstMsgId, ev.parentToolUseId, block);
            } else {
              s.appendBlock(nodeId, asstMsgId, block);
            }
            return;
          }
          case "tool_result":
            s.setToolResult(
              nodeId,
              asstMsgId,
              ev.toolUseId,
              ev.content,
              ev.isError,
              ev.parentToolUseId,
            );
            return;
          case "session":
            s.setNodeSessionId(nodeId, ev.sessionId);
            return;
          case "subagent_delta":
            s.appendSubagentDelta(
              nodeId,
              asstMsgId,
              ev.parentToolUseId,
              ev.kind,
              ev.text,
            );
            return;
          case "subagent_progress":
            s.setSubagentSummary(nodeId, asstMsgId, ev.parentToolUseId, ev.summary);
            return;
          case "todos":
            s.setTodos(nodeId, ev.todos);
            return;
          case "prompt_suggestion":
            s.addSuggestion(nodeId, asstMsgId, {
              label: "Continue",
              prompt: ev.prompt,
            });
            return;
          // Informational only — surfaced in the timeline, not the transcript.
          case "hook":
          case "task_notification":
          case "compact":
            return;
          case "done":
            if (ev.usage) {
              s.setMessageUsage(nodeId, asstMsgId, ev.usage);
            }
            if (ev.isError) {
              s.errorMessage(nodeId, asstMsgId, ev.result ?? "error", {
                code: ev.code,
                provider: ev.provider,
              });
            } else {
              s.finalizeMessage(nodeId, asstMsgId);
            }
            cleanup();
            return;
          case "error":
            s.errorMessage(nodeId, asstMsgId, ev.message, {
              code: ev.code,
              provider: ev.provider,
            });
            cleanup();
            return;
        }
      });

      // Leading `/plan`, `/chat`, `/accept-edits`, `/ask` are interpreted here
      // and stripped from what the model sees. Everything else stays in the
      // prompt so the CLI expands it as a real slash command.
      const inline = parseInlineCommands(trimmed);

      const addedContext =
        storeApi.getState().nodes[nodeId]?.data.chat.addedContext;
      let promptForModel = addedContext
        ? `> ${addedContext.replace(/\n/g, "\n> ")}\n\n${inline.prompt}`
        : inline.prompt;
      if (mergeContext) {
        promptForModel = `${mergeContext}\n\n---\n\n${promptForModel}`;
      }

      const latest = storeApi.getState();
      const nodeSettings = latest.nodes[nodeId]?.data.nodeSettings;
      const resume = resolveResumeTarget(latest, nodeId);

      try {
        await window.api.chat.start({
          chatId,
          nodeId,
          canvasId,
          // Only needed when there is no session to resume; main ignores it
          // otherwise rather than replaying the transcript as text.
          history: resume ? [] : history,
          prompt: promptForModel,
          attachments: attachments.length > 0 ? attachments : undefined,
          nodeSettings,
          permissionMode: inline.permissionMode,
          chatOnly: inline.chatOnly || undefined,
          resumeSessionId: resume?.sessionId,
          forkSession: resume?.fork || undefined,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        storeApi.getState().errorMessage(nodeId, asstMsgId, message);
        cleanup();
      }
    },
    [nodeId, storeApi]
  );

  /**
   * Graceful stop. `interrupt` lets the CLI finish the turn cleanly so the
   * partial answer stays readable and the session can still be resumed; main
   * falls back to killing the process when there is no live session.
   */
  const stop = useCallback(() => {
    const id = activeChatIdRef.current;
    if (id) void window.api.chat.interrupt(id);
  }, []);

  return { submit, stop, streaming };
}

/**
 * Which CLI session this turn should continue.
 *
 * A node that has already run owns a session and simply extends it. A fresh
 * child inherits its parent's session as a *fork*, which is exactly what
 * branching a canvas means: same history up to this point, diverging after.
 */
function resolveResumeTarget(
  state: { nodes: Record<NodeId, CanvasNode> },
  nodeId: NodeId,
): { sessionId: string; fork: boolean } | null {
  const node = state.nodes[nodeId];
  if (!node) return null;

  const own = node.data.chat.sessionId;
  if (own) return { sessionId: own, fork: false };

  // Merge nodes have several parents and no single history to fork from, so
  // they start fresh with the merge context in the prompt.
  const parentIds = node.data.chat.parentIds;
  if (parentIds.length !== 1) return null;

  const parentSession = state.nodes[parentIds[0]]?.data.chat.sessionId;
  return parentSession ? { sessionId: parentSession, fork: true } : null;
}
