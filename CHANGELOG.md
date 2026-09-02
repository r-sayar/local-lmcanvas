# Changelog

All notable changes to `local-lmcanvas` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Permission modes and interactive tool approval.** Nodes can run in `default`, `acceptEdits`, `plan`, `bypassPermissions` or `dontAsk`, and a tool call awaiting a decision now renders an inline prompt on its node with allow / allow-always / deny / deny-with-feedback. Always-allow rules persist to settings; Bash rules narrow to the leading command (`Bash(git *)`) rather than approving every future shell call.
- **Session continuity.** A node records the Claude Code session backing it and resumes it on the next turn instead of replaying the transcript as text. Branching a child forks the parent's session, which is what a canvas branch means.
- **Real capability discovery.** Slash commands, models, subagents, MCP server status and skills are read from the CLI itself rather than a hardcoded list plus a disk scan. Argument hints (`/code-review [low|medium|high]`) come through.
- Per-node CLI options: effort, extended thinking, allowed/disallowed tools, additional directories, max turns, max budget, fallback model, named agent, skills, setting sources, file checkpointing.
- Subagent transcripts nested under their `Task` block, live todo state, hook and background-task events, prompt suggestions and compaction boundaries.
- Live-run controls: graceful interrupt, mid-run model and permission-mode switching, context-usage breakdown, backgrounding in-flight work, file rewind.
- `bun run e2e:parity` — a manual end-to-end check of session resume, forking and plan-mode containment against the installed CLI.

### Changed

- Both the Electron and WebSocket hosts now share one `chatRun` module instead of carrying separate copies that had drifted apart.
- `bun run typecheck` covers the main process as well as the renderer; it previously only checked the renderer, which is why main-process type errors went unnoticed.
- Thinking blocks are rendered instead of being streamed into the store and discarded.

### Removed

- `consoleRunner.ts`, which spawned the CLI in `--print` mode and echoed a synthetic ANSI transcript into the terminal panel, and the unused `claude/parser.ts`.

### Fixed

- **Claude ran with no options at all.** The live path dropped model, system prompt, attachments, plan mode and chat-only mode before spawning, and passed no permission mode, so the agent could not reliably edit files and model selection did nothing.
- Model overrides were discarded on the way to disk (`sanitizeNodeSettings` kept only provider/cwd/branch) and were never treated as a change worth persisting, so a chosen model never seeded new nodes.
- The Fast badge was a no-op: `chatOnly` was missing from the check deciding whether a node had any overrides, so the setting was written and immediately dropped.
- Clearing one per-node setting deleted the others.
- The canvas was never written to disk during a response: every streamed token rearmed the debounce timer, so a crash or quit mid-run lost the whole turn.
- Closing a window left its runs generating and its pending permission prompts unanswered, blocking the CLI subprocess indefinitely.
- The embedded terminal always opened in the home directory instead of the canvas folder, and in split view tracked the wrong pane.
- Opening settings showed two stacked modals.
- Selecting a node silently replaced an open browser panel while its toggle still read as active.
- Split view created two terminal-capture nodes from a single byte stream.
- `which claude` ran synchronously on every turn, blocking the main process.
- Long-running command tool rows now expose `Keep running` while the command is still active, so a dev server can be restarted as a detached process before stopping the node.

## [0.1.0] — 2026-05-15

Initial public release.

### Added

- Canvas-based branching conversations powered by `@xyflow/react`.
- Multi-provider support: Claude Code, Codex, and Cursor agent CLIs.
- Local JSON storage under `~/.local-lmcanvas/` (one file per canvas, plus `settings.json`).
- Settings UI for system prompt, CLI binary path, and model selection.
- Keyboard shortcuts for submit (`⌘+Enter`), branch (`⌘+B`), and node deletion.
- Branching from highlighted text inside a response.
- Dark and light themes.
- Minimap for canvas navigation.

### Removed

- PostHog telemetry. The previous integration was placeholder-keyed and never active in distributed builds; it has been removed entirely to align with the "fully local, no cloud" positioning of the project. Any leftover `telemetryUuid` or `telemetryEnabled` fields in an existing `~/.local-lmcanvas/settings.json` are now ignored and harmless — you can leave them in place or delete them.

[Unreleased]: https://github.com/max-lee-dev/local-lmcanvas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/max-lee-dev/local-lmcanvas/releases/tag/v0.1.0
