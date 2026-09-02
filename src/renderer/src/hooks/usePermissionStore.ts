import { create } from "zustand";
import type { PermissionRequest } from "@shared/ipc";

type PermissionStoreState = {
  /** Pending approvals per node, oldest first. Only the head is rendered. */
  queueByNode: Record<string, PermissionRequest[]>;
  enqueue: (req: PermissionRequest) => void;
  allow: (id: string, always?: boolean) => void;
  deny: (id: string, message?: string) => void;
  /** Drop everything a finished run was still asking about. Main already answered them. */
  clearForChat: (chatId: string) => void;
  getForNode: (nodeId: string) => PermissionRequest | undefined;
};

export const usePermissionStore = create<PermissionStoreState>((set, get) => ({
  queueByNode: {},

  enqueue: (req) =>
    set((s) => ({
      queueByNode: {
        ...s.queueByNode,
        [req.nodeId]: [...(s.queueByNode[req.nodeId] ?? []), req],
      },
    })),

  allow: (id, always) => {
    if (!dequeue(set, get, id)) return;
    void window.api.permissions.respond(
      always ? { id, behavior: "allow", always: true } : { id, behavior: "allow" },
    );
  },

  deny: (id, message) => {
    if (!dequeue(set, get, id)) return;
    void window.api.permissions.respond({ id, behavior: "deny", message });
  },

  clearForChat: (chatId) =>
    set((s) => {
      const next: Record<string, PermissionRequest[]> = {};
      let changed = false;
      for (const [nodeId, queue] of Object.entries(s.queueByNode)) {
        const remaining = queue.filter((r) => r.chatId !== chatId);
        if (remaining.length !== queue.length) changed = true;
        if (remaining.length > 0) next[nodeId] = remaining;
      }
      return changed ? { queueByNode: next } : {};
    }),

  getForNode: (nodeId) => get().queueByNode[nodeId]?.[0],
}));

type SetState = (
  updater: (s: PermissionStoreState) => Partial<PermissionStoreState>,
) => void;

/** Drops the request from its node's queue. False when it was already answered. */
function dequeue(
  set: SetState,
  get: () => PermissionStoreState,
  id: string,
): boolean {
  const entry = Object.entries(get().queueByNode).find(([, queue]) =>
    queue.some((r) => r.id === id),
  );
  if (!entry) return false;
  const [nodeId, queue] = entry;
  const remaining = queue.filter((r) => r.id !== id);
  set((s) => {
    const next = { ...s.queueByNode };
    if (remaining.length === 0) delete next[nodeId];
    else next[nodeId] = remaining;
    return { queueByNode: next };
  });
  return true;
}

/** Subscribe to tool-approval requests from the main process. Call once at app start. */
export function subscribePermissionRequests(): () => void {
  const offRequests = window.api.permissions.onRequest((req) => {
    usePermissionStore.getState().enqueue(req);
  });
  // A run that ends while a prompt is open has already been answered for us —
  // otherwise the node keeps a dead prompt pinned to it.
  const offEvents = window.api.chat.onEvent((ev) => {
    if (ev.type === "done" || ev.type === "error") {
      usePermissionStore.getState().clearForChat(ev.chatId);
    }
  });
  return () => {
    offRequests();
    offEvents();
  };
}
