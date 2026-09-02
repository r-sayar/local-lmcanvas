import type { Provider } from "@shared/types";
import { runCodex } from "./codex";
import { runCursor } from "./cursor";
import type { RunAgentOpts, RunnerEvent } from "./types";

export type { RunAgentOpts, RunnerEvent };
export type AgentRunner = (prompt: string, opts: RunAgentOpts) => Promise<void>;

/**
 * Providers driven by a plain "prompt in, JSONL out" subprocess.
 *
 * Claude is deliberately not here: it runs through `runClaude`, which needs
 * session ids, permission callbacks and resolved run settings that these two
 * have no concept of. Folding it back in is what let the Claude path silently
 * drop model, plan mode and attachments — the shared signature could express
 * them, but nothing checked that they were passed.
 */
export type SubprocessProvider = Exclude<Provider, "claude">;

export async function runAgent(
  provider: SubprocessProvider,
  prompt: string,
  opts: RunAgentOpts
): Promise<void> {
  switch (provider) {
    case "codex":
      return runCodex(prompt, opts);
    case "cursor":
      return runCursor(prompt, opts);
  }
}
