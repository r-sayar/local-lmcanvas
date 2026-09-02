import { randomUUID } from "node:crypto";
import type { AskUserQuestion, AskUserResponsePayload } from "@shared/ipc";
import { RequestBridge } from "./pendingRequests";

/**
 * Bridges the in-process `ask_user_question` MCP tool to whichever client owns
 * the session, and waits for the answer.
 *
 * Routing is by opaque `sessionKey` rather than an Electron `WebContents`, so the
 * same bridge serves the Electron host and the WebSocket host. Keeping it typed
 * to `WebContents` is what left the two hosts calling incompatible signatures.
 */

const bridge = new RequestBridge<AskUserResponsePayload>();

export function requestAnswer(
  questions: AskUserQuestion[],
  sessionKey: string,
  nodeId: string,
  send: (msg: object) => void,
  signal?: AbortSignal,
): Promise<AskUserResponsePayload> {
  const id = randomUUID();
  return bridge.request(
    id,
    sessionKey,
    { type: "askUser:request", data: { id, nodeId, questions } },
    send,
    { id, cancelled: true },
    signal,
  );
}

export function completeRequest(payload: AskUserResponsePayload): void {
  bridge.complete(payload.id, payload);
}

/** Cancel every in-flight question for a window/socket that has gone away. */
export function cancelAllForSession(sessionKey: string): void {
  bridge.cancelSession(sessionKey);
}
