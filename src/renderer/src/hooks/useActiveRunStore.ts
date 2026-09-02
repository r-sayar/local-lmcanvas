import { create } from "zustand";

/**
 * Which chat is currently running on which node.
 *
 * The SDK's interesting controls — interrupt, change model, change permission
 * mode, read context usage — are addressed by `chatId`, but every control in the
 * UI lives on a node. `useNodeChat` owns the id but is per-node and private, so
 * badges and panels rendered elsewhere had no way to reach the live run. This
 * store is filled straight from the chat event stream, which now carries the
 * node on every event.
 */

type ActiveRunState = {
  chatIdByNode: Record<string, string>;
  getChatId: (nodeId: string) => string | undefined;
  isRunning: (nodeId: string) => boolean;
};

export const useActiveRunStore = create<ActiveRunState>((set, get) => ({
  chatIdByNode: {},
  getChatId: (nodeId) => get().chatIdByNode[nodeId],
  isRunning: (nodeId) => get().chatIdByNode[nodeId] !== undefined,
}));

function begin(nodeId: string, chatId: string): void {
  useActiveRunStore.setState((s) =>
    s.chatIdByNode[nodeId] === chatId
      ? s
      : { chatIdByNode: { ...s.chatIdByNode, [nodeId]: chatId } },
  );
}

function end(nodeId: string, chatId: string): void {
  useActiveRunStore.setState((s) => {
    // A newer run may already have claimed the node; don't clear that one.
    if (s.chatIdByNode[nodeId] !== chatId) return s;
    const next = { ...s.chatIdByNode };
    delete next[nodeId];
    return { chatIdByNode: next };
  });
}

/** Track live runs off the chat event stream. Call once at app start. */
export function subscribeActiveRuns(): () => void {
  return window.api.chat.onEvent((ev) => {
    if (ev.type === "start") begin(ev.nodeId, ev.chatId);
    else if (ev.type === "done" || ev.type === "error") end(ev.nodeId, ev.chatId);
  });
}
