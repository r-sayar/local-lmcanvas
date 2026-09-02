import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionRequest } from "@shared/ipc";
import { RequestBridge } from "./pendingRequests";

/**
 * Interactive tool approval — the piece the canvas was missing entirely.
 *
 * Before this, every Claude run was pinned to `bypassPermissions`, so the agent
 * could edit or delete anything with no confirmation. Now the runner installs
 * `canUseTool`, which routes each request to the node that started the chat and
 * blocks until the user answers.
 */

const bridge = new RequestBridge<PermissionDecision>();

function cancelled(id: string): PermissionDecision {
  return { id, behavior: "deny", message: "Cancelled before the user answered." };
}

/** Rules the user has chosen to auto-approve, e.g. `Read` or `Bash(git *)`. */
let alwaysAllowed: string[] = [];

export function setAlwaysAllowedTools(rules: string[]): void {
  alwaysAllowed = rules;
}

export function getAlwaysAllowedTools(): string[] {
  return alwaysAllowed;
}

/** Called when the user ticks "always allow", so the next run starts pre-approved. */
export type PersistRule = (rule: string) => void | Promise<void>;

export type PermissionBridgeOpts = {
  chatId: string;
  nodeId: string;
  /** Correlates pending requests with the window/socket that owns them. */
  sessionKey: string;
  send: (msg: object) => void;
  signal: AbortSignal;
  persistRule: PersistRule;
};

export function buildCanUseTool(opts: PermissionBridgeOpts): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const rule = matchingRule(toolName, input);
    if (rule) return { behavior: "allow" };

    const id = randomUUID();
    const request: PermissionRequest = {
      id,
      nodeId: opts.nodeId,
      chatId: opts.chatId,
      toolName,
      input,
      summary: summarize(toolName, input),
      alwaysAllowRule: suggestRule(toolName, input),
    };

    const decision = await bridge.request(
      id,
      opts.sessionKey,
      { type: "permission:request", data: request },
      opts.send,
      cancelled(id),
      // Fold the run's abort signal together with the SDK's per-request one so a
      // stopped chat doesn't leave a modal hanging on the node forever.
      anySignal([opts.signal, options.signal]),
    );

    if (decision.behavior === "deny") {
      return { behavior: "deny", message: decision.message ?? "Denied by the user." };
    }

    if (decision.always) {
      const persisted = request.alwaysAllowRule ?? toolName;
      if (!alwaysAllowed.includes(persisted)) {
        alwaysAllowed = [...alwaysAllowed, persisted];
        await opts.persistRule(persisted);
      }
      // Hand the SDK's own suggestions back so the CLI stops re-asking for the
      // rest of this session, not just the next identical call.
      const updatedPermissions = options.suggestions as PermissionUpdate[] | undefined;
      return updatedPermissions?.length
        ? { behavior: "allow", updatedPermissions }
        : { behavior: "allow" };
    }

    return { behavior: "allow" };
  };
}

export function respondToPermission(decision: PermissionDecision): void {
  bridge.complete(decision.id, decision);
}

export function cancelPermissionsForSession(sessionKey: string): void {
  bridge.cancelSession(sessionKey);
}

/**
 * The rule that pre-approves this call, if any.
 *
 * Exported so the matching can be checked directly: the live allow-list is
 * reloaded from settings at the start of every run, so exercising this through
 * a real turn would mean writing to the user's settings file.
 */
export function matchingRule(
  toolName: string,
  input: Record<string, unknown>,
  rules: string[] = alwaysAllowed,
): string | undefined {
  for (const rule of rules) {
    const open = rule.indexOf("(");
    if (open === -1) {
      if (rule === toolName) return rule;
      continue;
    }
    if (!rule.endsWith(")")) continue;
    if (rule.slice(0, open) !== toolName) continue;
    const pattern = rule.slice(open + 1, -1);
    const subject = primaryInput(toolName, input);
    if (subject !== undefined && globMatch(pattern, subject)) return rule;
  }
  return undefined;
}

/** `git *` → matches `git status`. Only `*` is special, matching any run of characters. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/** The field that best identifies what a tool is about to act on. */
function primaryInput(toolName: string, input: Record<string, unknown>): string | undefined {
  const pick = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  switch (toolName) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return pick("file_path");
    case "Glob":
    case "Grep":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query");
    default:
      return undefined;
  }
}

/**
 * The rule offered behind "always allow". For Bash we narrow to the first token
 * so approving `git status` doesn't silently approve `rm -rf`.
 */
export function suggestRule(toolName: string, input: Record<string, unknown>): string {
  if (toolName !== "Bash") return toolName;
  const command = primaryInput(toolName, input);
  if (!command) return toolName;
  const head = command.trim().split(/\s+/)[0];
  if (!head || head.includes("/")) return toolName;
  return `Bash(${head} *)`;
}

function summarize(toolName: string, input: Record<string, unknown>): string | undefined {
  const primary = primaryInput(toolName, input);
  if (primary) return primary.length > 300 ? `${primary.slice(0, 300)}…` : primary;
  const firstString = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  if (!firstString) return undefined;
  return firstString.length > 300 ? `${firstString.slice(0, 300)}…` : firstString;
}

/**
 * Node 20 has no `AbortSignal.any`, and the SDK gives us a second signal per
 * request, so combine them by hand.
 */
function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  const already = live.find((s) => s.aborted);
  if (already) return already;

  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
    for (const s of live) s.removeEventListener("abort", onAbort);
  };
  for (const s of live) s.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
