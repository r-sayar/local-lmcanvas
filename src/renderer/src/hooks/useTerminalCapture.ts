import { useEffect, useRef } from "react";
import { nanoid } from "nanoid";
import {
  makeBlankNode,
  useCanvasStore,
  useCanvasStoreApi,
} from "@/hooks/useCanvasStore";
import type { NodeId } from "@shared/types";

type CaptureSession = {
  nodeId: NodeId;
  msgId: string;
};

/**
 * Listens for terminal-capture CustomEvents and streams PTY output into a new
 * canvas node. Must be mounted inside a CanvasStoreProvider.
 *
 * Events (dispatched on window by TerminalPanel):
 *   lmc:terminal-capture-start  – create a node and begin streaming
 *   lmc:terminal-chunk          – CustomEvent<string>, append text delta
 *   lmc:terminal-capture-end    – finalize the message
 */
export function useTerminalCapture() {
  const addNode = useCanvasStore((s) => s.addNode);
  const appendMessage = useCanvasStore((s) => s.appendMessage);
  const appendTextDelta = useCanvasStore((s) => s.appendTextDelta);
  const finalizeMessage = useCanvasStore((s) => s.finalizeMessage);
  const storeApi = useCanvasStoreApi();

  const sessionRef = useRef<CaptureSession | null>(null);

  useEffect(() => {
    const onStart = () => {
      const state = storeApi.getState();
      const nodeList = Object.values(state.nodes);
      const maxY = nodeList.reduce((m, n) => Math.max(m, n.position.y), 0);
      const avgX =
        nodeList.length > 0
          ? nodeList.reduce((s, n) => s + n.position.x, 0) / nodeList.length
          : 0;

      const node = makeBlankNode({ x: avgX, y: maxY + 160 });

      const userMsgId = nanoid();
      const asstMsgId = nanoid();

      addNode(node);
      appendMessage(node.id, {
        id: userMsgId,
        role: "user",
        blocks: [{ type: "text", text: "▶ terminal capture" }],
        createdAt: Date.now(),
        status: "complete",
      });
      appendMessage(node.id, {
        id: asstMsgId,
        role: "assistant",
        blocks: [],
        createdAt: Date.now(),
        status: "streaming",
      });

      sessionRef.current = { nodeId: node.id, msgId: asstMsgId };
    };

    const onChunk = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      const sess = sessionRef.current;
      if (!sess || !text) return;
      appendTextDelta(sess.nodeId, sess.msgId, text);
    };

    const onEnd = () => {
      const sess = sessionRef.current;
      if (!sess) return;
      finalizeMessage(sess.nodeId, sess.msgId);
      void storeApi.getState().save();
      sessionRef.current = null;
    };

    window.addEventListener("lmc:terminal-capture-start", onStart);
    window.addEventListener("lmc:terminal-chunk", onChunk);
    window.addEventListener("lmc:terminal-capture-end", onEnd);

    return () => {
      window.removeEventListener("lmc:terminal-capture-start", onStart);
      window.removeEventListener("lmc:terminal-chunk", onChunk);
      window.removeEventListener("lmc:terminal-capture-end", onEnd);
    };
  }, [addNode, appendMessage, appendTextDelta, finalizeMessage, storeApi]);
}
