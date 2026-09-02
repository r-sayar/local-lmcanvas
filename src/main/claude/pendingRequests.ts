/**
 * Transport-agnostic request/response correlation.
 *
 * The main process sometimes has to stop mid-run and ask the renderer a
 * question — "may this tool run?", "pick one of these options". Both flows need
 * the same thing: hand a payload to whichever client owns this session, park a
 * promise, and settle it when the answer comes back (or when the session dies,
 * the run aborts, or the window closes).
 *
 * Deliberately knows nothing about Electron or WebSockets: callers supply a
 * `send` function and a `sessionKey`, so the same code serves `ipcMain`,
 * `webContents`, and `ws` without a second implementation drifting out of sync.
 */

type Pending<T> = {
  sessionKey: string;
  resolve: (value: T) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** Value delivered when the request is cancelled rather than answered. */
  cancelledValue: T;
};

export class RequestBridge<T> {
  private readonly pending = new Map<string, Pending<T>>();

  /**
   * Park a request and return a promise for its answer.
   *
   * Resolves (never rejects) with `cancelledValue` when the request is aborted
   * or its session goes away — the caller is normally inside a tool callback,
   * where a rejection would surface as an opaque crash rather than a clean
   * "the user declined".
   */
  request(
    id: string,
    sessionKey: string,
    payload: object,
    send: (msg: object) => void,
    cancelledValue: T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(cancelledValue);

    return new Promise<T>((resolve) => {
      const entry: Pending<T> = { sessionKey, resolve, signal, cancelledValue };

      if (signal) {
        const onAbort = (): void => {
          this.cleanup(id);
          resolve(cancelledValue);
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, entry);

      try {
        send(payload);
      } catch {
        // Client vanished between the liveness check and the send.
        this.cleanup(id);
        resolve(cancelledValue);
      }
    });
  }

  /** Settle a parked request. No-op when the id is unknown or already settled. */
  complete(id: string, value: T): void {
    const entry = this.cleanup(id);
    entry?.resolve(value);
  }

  /** Cancel every request belonging to a session — window closed, socket dropped. */
  cancelSession(sessionKey: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.sessionKey !== sessionKey) continue;
      this.cleanup(id);
      entry.resolve(entry.cancelledValue);
    }
  }

  /** Cancel a single request by id, e.g. when its chat is stopped. */
  cancel(id: string): void {
    const entry = this.cleanup(id);
    entry?.resolve(entry.cancelledValue);
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  private cleanup(id: string): Pending<T> | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    return entry;
  }
}
