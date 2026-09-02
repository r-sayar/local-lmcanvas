# local-lmcanvas

A fully local, canvas-based branching AI conversation tool. Desktop Electron app that drives **Claude Code** through the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — no API keys, no cloud, no database.

Each conversation is a tree of message nodes on a canvas. Branch from any node to fork the conversation history, or highlight text in a response to branch from that phrase. Everything persists to `~/.local-lmcanvas/`.

Branching is backed by real session forking: a node resumes its own Claude Code session across turns, and a child forks its parent's, so history is never re-sent as text.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` binary in `$PATH`)
- [Bun](https://bun.sh) 1.1+
- macOS / Linux / Windows

Verify Claude Code works:

```bash
claude -p "say hi" --output-format stream-json --verbose | head
```

## Run

```bash
bun install
bun run dev
```

The Electron window opens automatically. Build a distributable with:

```bash
bun run dist   # .dmg on macOS, .AppImage on Linux, .exe on Windows
```

## Architecture

```
src/
├── main/           Electron main process (Node)
│   ├── index.ts    IPC handler registration, BrowserWindow setup
│   ├── chatRun.ts  one prompt turn, shared by both hosts
│   ├── claude/     Agent SDK runner, options, permissions, sessions
│   └── storage/    reads/writes ~/.local-lmcanvas/
├── preload/        contextBridge: exposes window.api to renderer
├── renderer/       React UI (xyflow canvas, zustand store)
└── shared/         types + graph logic used by both sides
server/             optional Express + WebSocket host for the same logic
```

All renderer → main calls go over IPC (`window.api.canvases.list()`, etc.) — no HTTP.

`src/main/claude/` is where Claude Code capability maps onto the app:

| file | role |
| --- | --- |
| `runner.ts` | runs a turn through the SDK and translates its message stream |
| `options.ts` | the single place a CLI flag becomes a value we send |
| `permissions.ts` | `canUseTool` bridge — routes approvals to the node that asked |
| `sessions.ts` | handles on live runs: interrupt, set model, context usage, rewind |
| `capabilities.ts` | asks the CLI what it supports in a directory |

`server/index.ts` is a second host for the same `src/main` logic, for running the
UI in a browser. Both hosts call `startChatRun`, so neither can drift from the
other.

## Storage

```
~/.local-lmcanvas/
├── canvases/
│   └── <id>.json        one file per canvas
└── settings.json        system prompt, claude binary path, model, defaults
```

Files are human-readable JSON. Conversation history itself lives in Claude
Code's own session store; a canvas records the session id per node.

## Permission modes

Every node runs in one of the CLI's permission modes, defaulting to
`acceptEdits` — a canvas is a place where the agent is expected to edit files,
but anything else still asks.

| mode | behaviour |
| --- | --- |
| `default` | prompts before each tool call |
| `acceptEdits` | file edits go through, other tools prompt |
| `plan` | read-only; the model proposes a plan and cannot mutate |
| `bypassPermissions` | no prompts at all |
| `dontAsk` | never prompts; denies anything not pre-approved |

When a call needs a decision the node shows it inline. Choosing *always allow*
saves a rule to `settings.json`; for Bash it saves the leading command
(`Bash(git *)`) rather than a blanket approval.

Type `/plan`, `/chat`, `/ask` or `/accept-edits` at the start of a prompt to set
the mode for one turn. Every other slash command is passed to the CLI.

## Keyboard shortcuts

| key                    | action                             |
| ---------------------- | ---------------------------------- |
| `⌘+Enter`              | submit prompt in the focused input |
| `⌘+B`                  | branch from the selected node      |
| `Backspace` / `Delete` | delete the selected node           |
| `Ctrl+``               | toggle the terminal panel          |
| double-click empty pane | create a new root node            |

## Verifying a change

```bash
bun run typecheck    # both the main process and the renderer
bun run e2e:parity   # session resume, forking and plan mode, against the real CLI
```

`e2e:parity` spends a few cheap turns and needs an authenticated `claude`.

## Troubleshooting

**"claude binary not found"** — set the full path in Settings (gear icon), e.g. `/Users/you/.local/bin/claude`.

**Blank window** — check the DevTools console (opens automatically in dev). For prod, `bun run dev` once to see errors.

**A model or slash command is missing** — the list comes from the CLI itself and
is cached for a minute per directory. Changing the binary path in Settings
clears it immediately.

## Contributing

PRs welcome — including AI/vibe-coded ones. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, conventions, and how to file issues. AI agents should also read [AGENTS.md](./AGENTS.md).

## Vision

Local-first, canvas-native, bring-your-own-CLI. See [VISION.md](./VISION.md) for the longer take and [CHANGELOG.md](./CHANGELOG.md) for what's shipped.

## Security

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/max-lee-dev/local-lmcanvas/security/advisories/new). See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Max Lee

