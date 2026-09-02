import { spawn } from "node:child_process";
import { consumeJsonl } from "../agents/jsonlReader";
import { normalizeUsage } from "../agents/usage";
import { isAuthError } from "../agents/types";
import type { RunnerEvent } from "../agents/types";

export type ConsoleRunnerOpts = {
  cwd: string;
  binPath: string;
  model?: string;
  signal?: AbortSignal;
  onEvent: (ev: RunnerEvent) => void;
  /** Called with raw bytes to forward to the terminal panel in the UI. */
  onTerminalData: (data: string) => void;
};

export async function runClaudeViaConsole(
  prompt: string,
  opts: ConsoleRunnerOpts,
): Promise<void> {
  const { cwd, binPath, model, signal, onTerminalData } = opts;

  let doneEmitted = false;
  const seenToolUseIds = new Set<string>();

  const emit = (ev: RunnerEvent): void => {
    if (ev.kind === "error" && !ev.code && isAuthError(ev.message)) {
      opts.onEvent({ ...ev, code: "auth_required" });
      return;
    }
    if (ev.kind === "done" && ev.isError && !ev.code && isAuthError(ev.result ?? "")) {
      opts.onEvent({ ...ev, code: "auth_required" });
      return;
    }
    if (ev.kind === "done") doneEmitted = true;
    opts.onEvent(ev);
  };

  onTerminalData(`\r\n\x1b[36m[canvas]\x1b[0m ${prompt}\r\n\r\n`);

  const args = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages"];
  if (model) args.push("--model", model);
  args.push(prompt);

  // Strip Claude Code session env vars so the spawned claude doesn't think it's
  // running nested inside an existing Claude Code session (which uses a different
  // auth path that requires the parent session to be active).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_CODE") && k !== "CLAUDECODE")
  ) as Record<string, string>;

  const proc = spawn(binPath, args,
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );

  if (signal) {
    const abort = () => { try { proc.kill(); } catch { /* already gone */ } };
    signal.addEventListener("abort", abort, { once: true });
  }

  const jsonlDone = consumeJsonl(proc.stdout!, (ev: unknown) => {
    handleEvent(ev, seenToolUseIds, emit, onTerminalData);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    onTerminalData(chunk.toString("utf8").replace(/\n/g, "\r\n"));
  });

  await Promise.all([
    jsonlDone,
    new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        if (!doneEmitted) {
          emit({
            kind: "done",
            isError: (code ?? 0) !== 0,
            result: (code ?? 0) !== 0 ? `claude exited with code ${String(code)}` : undefined,
          });
        }
        resolve();
      });
      proc.on("error", (err) => {
        emit({ kind: "error", message: err.message });
        resolve();
      });
    }),
  ]);
}

function handleEvent(
  ev: unknown,
  seenToolUseIds: Set<string>,
  emit: (ev: RunnerEvent) => void,
  onTerminalData: (data: string) => void,
): void {
  if (typeof ev !== "object" || ev === null) return;
  const obj = ev as Record<string, unknown>;
  const type = obj.type as string | undefined;

  if (type === "stream_event") {
    const inner = obj.event as Record<string, unknown> | undefined;
    if (!inner) return;
    if (inner.type === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        emit({ kind: "text_delta", text: delta.text });
        onTerminalData(delta.text.replace(/\n/g, "\r\n"));
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        emit({ kind: "thinking_delta", text: delta.thinking });
      }
    }
    return;
  }

  if (type === "assistant") {
    // Full assistant turn — text already arrived as stream_event deltas.
    // Only emit tool_use blocks here.
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;
      const id = b.id as string;
      if (seenToolUseIds.has(id)) continue;
      seenToolUseIds.add(id);
      emit({ kind: "tool_use", toolUseId: id, name: b.name as string, input: b.input });
      onTerminalData(`\x1b[33m[tool: ${String(b.name)}]\x1b[0m\r\n`);
    }
    return;
  }

  if (type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const isError = b.is_error === true;
      const resultContent = toolResultToString(b.content);
      emit({ kind: "tool_result", toolUseId: b.tool_use_id as string, content: resultContent, isError });
      if (isError) {
        onTerminalData(`\x1b[31m[tool error]\x1b[0m ${resultContent.slice(0, 120).replace(/\n/g, "\r\n")}\r\n`);
      }
    }
    return;
  }

  if (type === "result") {
    const isError = obj.is_error === true;
    const result = typeof obj.result === "string" ? obj.result : undefined;
    const usage = normalizeUsage(obj.usage, { totalCostUsd: obj.total_cost_usd });
    emit({ kind: "done", isError, result, usage });
    if (isError && result) {
      onTerminalData(`\r\n\x1b[31m[error]\x1b[0m ${result.replace(/\n/g, "\r\n")}\r\n`);
    }
    return;
  }
}

function toolResultToString(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "object" && c !== null) {
          const b = c as Record<string, unknown>;
          return b.type === "text" && typeof b.text === "string" ? b.text : `[${String(b.type)}]`;
        }
        return String(c);
      })
      .join("\n");
  }
  return String(content);
}
