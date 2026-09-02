import type { PermissionMode } from "@shared/types";

/**
 * Leading slash commands the app interprets itself.
 *
 * Everything else is passed through untouched so the CLI expands it — that's how
 * `/review`, `/compact` and project commands keep working. Only the modes the
 * CLI cannot infer from a prompt live here.
 */
const CLIENT_COMMANDS: Record<
  string,
  { permissionMode?: PermissionMode; chatOnly?: boolean }
> = {
  plan: { permissionMode: "plan" },
  chat: { chatOnly: true },
  "accept-edits": { permissionMode: "acceptEdits" },
  ask: { permissionMode: "default" },
};

export type InlineCommandResult = {
  /** Prompt with recognised leading commands removed. */
  prompt: string;
  permissionMode?: PermissionMode;
  chatOnly?: boolean;
  /** Names that were consumed, in the order they appeared. */
  matched: string[];
};

/**
 * Strip recognised leading commands and return the flags they imply.
 *
 * Several can stack (`/plan /chat …`), and the last one to set a given flag
 * wins. The original text stays in the user's message bubble for provenance —
 * only what the model sees is rewritten.
 */
export function parseInlineCommands(text: string): InlineCommandResult {
  let rest = text;
  const matched: string[] = [];
  let permissionMode: PermissionMode | undefined;
  let chatOnly: boolean | undefined;

  for (;;) {
    const m = rest.match(/^\/([a-z-]+)(?:\s+|$)/i);
    if (!m) break;
    const name = m[1].toLowerCase();
    const spec = CLIENT_COMMANDS[name];
    if (!spec) break;

    matched.push(name);
    if (spec.permissionMode !== undefined) permissionMode = spec.permissionMode;
    if (spec.chatOnly !== undefined) chatOnly = spec.chatOnly;
    rest = rest.slice(m[0].length);
  }

  return { prompt: rest, permissionMode, chatOnly, matched };
}

export function isClientSideCommand(name: string): boolean {
  return name.toLowerCase() in CLIENT_COMMANDS;
}
