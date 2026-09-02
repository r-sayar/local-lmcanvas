# AGENTS.md

Guide for AI coding agents (Claude Code, Cursor, Codex, etc.) working in this repo.

## Project

`local-lmcanvas` is a fully-local, canvas-based branching AI conversation tool. Electron 33 + React 19 + TypeScript 5.6 (strict). Supports multiple CLI-backed providers (Claude, Codex, Cursor) with per-provider model selection; collects no telemetry.

## Build & verify

```bash
bun install
bun run dev          # launches the Electron app
bun run typecheck    # REQUIRED before claiming work complete (main + renderer)
bun run build        # production build
bun run e2e:parity   # optional: session resume / forking / plan mode vs the real CLI
```

There is no lint script and no test suite. `e2e:parity` is a manual smoke check,
not CI: it needs an authenticated `claude` and spends tokens.

## Project layout

- `src/main/` — Electron main process (Node), IPC handlers, file I/O. Touch for: spawning the LLM CLI, persisting canvases, settings.
- `src/preload/` — `contextBridge`. Touch for: adding new IPC channels exposed to the renderer.
- `src/renderer/` — React UI, xyflow canvas. Touch for: UI changes.
- `src/shared/` — types and graph helpers used by both sides. Touch for: changing the data model or message-history reconstruction.

## Hot files

- `src/main/index.ts` — IPC handler registration and `BrowserWindow` setup.
- `src/main/chatRun.ts` — one prompt turn. **Both hosts call this.** Put shared
  run logic here, never in a host, or the two will drift apart again.
- `src/main/claude/options.ts` — the single place a Claude Code flag becomes a
  value we send. Add new CLI options here, not inline in the runner.
- `src/shared/history.ts` — graph traversal / message-history reconstruction.
- `src/renderer/src/hooks/useCanvasStore.ts` — Zustand store.
- `src/renderer/src/components/Canvas/CustomNode.tsx` — node UI.

## Gotchas

- `NodeSettings` has a companion `NODE_SETTINGS_KEYS` / `hasNodeSettings()` in
  `src/shared/types.ts`. Use them. Hand-written field lists are what made model
  overrides silently vanish and the Fast badge do nothing.
- History is not re-sent when a node has a session to resume. If you change
  `ChatStartArgs.history` handling, re-run `bun run e2e:parity` — a broken
  resume still looks like it works, it just quietly forgets.
- Claude runs through `runClaude`, not `runAgent`. `runAgent` is for the plain
  subprocess providers (codex, cursor) and deliberately cannot express sessions
  or permissions.

## Conventions

- TypeScript strict. No `any` unless a third-party type forces it.
- No `@ts-ignore` / `@ts-expect-error`.
- Minimal comments — names should carry the meaning.
- No backwards-compat shims for code you delete.
- IPC channels: typed in `src/shared/ipc.ts`, registered in `src/main/index.ts`, exposed in `src/preload/index.ts`. Keep all three in sync.

## Before you finish

1. Run `bun run typecheck`.
2. Run `bun run dev` and click through what you changed.
3. Summarize what you did.
