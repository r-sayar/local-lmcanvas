import { randomUUID } from "node:crypto";
import type { AskUserQuestion, AskUserResponsePayload } from "../../shared/ipc";

type Pending = {
  resolve: (response: AskUserResponsePayload) => void;
  reject: (err: unknown) => void;
  sessionId: string;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

const pending = new Map<string, Pending>();

export function requestAnswer(
  questions: AskUserQuestion[],
  sessionId: string,
  nodeId: string,
  send: (msg: object) => void,
  signal?: AbortSignal,
): Promise<AskUserResponsePayload> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));

  const id = randomUUID();
  return new Promise<AskUserResponsePayload>((resolve, reject) => {
    const entry: Pending = { resolve, reject, sessionId, signal };

    if (signal) {
      const onAbort = () => {
        cleanup(id);
        reject(new Error("Aborted"));
      };
      entry.abortHandler = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }

    pending.set(id, entry);
    send({ type: "askUser:request", data: { id, nodeId, questions } });
  });
}

function cleanup(id: string): Pending | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  if (entry.signal && entry.abortHandler) {
    entry.signal.removeEventListener("abort", entry.abortHandler);
  }
  return entry;
}

export function completeRequest(payload: AskUserResponsePayload): void {
  const entry = cleanup(payload.id);
  if (!entry) return;
  entry.resolve(payload);
}

export function cancelAllForSession(sessionId: string): void {
  for (const [id, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    cleanup(id);
    entry.resolve({ id, cancelled: true });
  }
}
