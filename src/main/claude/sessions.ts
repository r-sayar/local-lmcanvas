import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { ContextUsage } from "@shared/ipc";
import type { PermissionMode } from "@shared/types";

/**
 * Handles on runs that are still in flight.
 *
 * The SDK exposes its interesting controls on the `Query` object rather than as
 * launch flags — interrupt, swap the model, change permission mode, ask what the
 * context window looks like. None of that is reachable unless someone keeps the
 * handle around, so the runner registers here for the lifetime of a turn and the
 * IPC layer looks runs up by `chatId`.
 */

type Entry = {
  query: Query;
  nodeId: string;
  /** Session id from the CLI's `init` message; absent until the run starts. */
  sessionId?: string;
  /** Guards control calls against a query whose process has already exited. */
  closed: boolean;
};

const runs = new Map<string, Entry>();

export function registerRun(chatId: string, nodeId: string, query: Query): void {
  runs.set(chatId, { query, nodeId, closed: false });
}

export function setRunSessionId(chatId: string, sessionId: string): void {
  const entry = runs.get(chatId);
  if (entry) entry.sessionId = sessionId;
}

export function getRunSessionId(chatId: string): string | undefined {
  return runs.get(chatId)?.sessionId;
}

export function unregisterRun(chatId: string): void {
  const entry = runs.get(chatId);
  if (!entry) return;
  entry.closed = true;
  runs.delete(chatId);
}

export function isRunActive(chatId: string): boolean {
  const entry = runs.get(chatId);
  return entry !== undefined && !entry.closed;
}

export function runIdsForNode(nodeId: string): string[] {
  const ids: string[] = [];
  for (const [chatId, entry] of runs) {
    if (entry.nodeId === nodeId) ids.push(chatId);
  }
  return ids;
}

/**
 * Ask the CLI to wind down the current turn.
 *
 * Unlike aborting the controller (which kills the subprocess and loses the
 * partial turn), `interrupt` lets the CLI finish cleanly, so the transcript is
 * coherent and the session can still be resumed afterwards.
 */
export async function interruptRun(chatId: string): Promise<boolean> {
  return control(chatId, async (q) => {
    await q.interrupt();
    return true;
  }, false);
}

export async function setRunPermissionMode(
  chatId: string,
  mode: PermissionMode,
): Promise<void> {
  await control(chatId, async (q) => q.setPermissionMode(mode), undefined);
}

export async function setRunModel(chatId: string, model?: string): Promise<void> {
  await control(chatId, async (q) => q.setModel(model), undefined);
}

export async function backgroundRunTasks(
  chatId: string,
  toolUseId?: string,
): Promise<boolean> {
  return control(chatId, async (q) => q.backgroundTasks(toolUseId), false);
}

export async function getRunContextUsage(chatId: string): Promise<ContextUsage | null> {
  return control(
    chatId,
    async (q) => {
      const usage = await q.getContextUsage();
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        breakdown: usage.categories.map((c) => ({ label: c.name, tokens: c.tokens })),
      } satisfies ContextUsage;
    },
    null,
  );
}

export type RewindResult = { canRewind: boolean; error?: string; filesChanged?: number };

export async function rewindRunFiles(
  chatId: string,
  userMessageId: string,
  dryRun?: boolean,
): Promise<RewindResult> {
  return control<RewindResult>(
    chatId,
    async (q) => {
      const result = await q.rewindFiles(userMessageId, { dryRun });
      return {
        canRewind: result.canRewind,
        error: result.error,
        filesChanged: countChangedFiles(result),
      };
    },
    { canRewind: false, error: "That run has already finished." },
  );
}

function countChangedFiles(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const stats = (result as { fileStats?: unknown }).fileStats;
  if (Array.isArray(stats)) return stats.length;
  if (typeof stats === "object" && stats !== null) {
    const count = (stats as { filesChanged?: unknown }).filesChanged;
    if (typeof count === "number") return count;
  }
  return undefined;
}

/**
 * Run a control request against a live query.
 *
 * Every one of these is a round trip to a subprocess that may have exited a
 * millisecond ago, so a rejection here is expected rather than exceptional —
 * callers get `fallback` instead of an unhandled rejection reaching the UI.
 */
async function control<T>(
  chatId: string,
  fn: (query: Query) => Promise<T>,
  fallback: T,
): Promise<T> {
  const entry = runs.get(chatId);
  if (!entry || entry.closed) return fallback;
  try {
    return await fn(entry.query);
  } catch (err) {
    console.warn(`[lmcanvas] control request failed for chat ${chatId}:`, err);
    return fallback;
  }
}
