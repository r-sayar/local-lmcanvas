import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getShellPath } from "../src/main/shellPath";
import {
  listCanvases,
  createCanvas,
  readCanvas,
  writeCanvas,
  deleteCanvas,
} from "../src/main/storage/canvases";
import { readSettings, writeSettings } from "../src/main/storage/settings";
import { buildPromptWithHistory } from "../src/main/claude/history";
import { runAgent } from "../src/main/agents";
import { generateGroupSummaries } from "../src/main/groupSummary/generate";
import { generateCanvasName } from "../src/main/canvasName/generate";
import { getProviderAuthStatus, openLoginTerminal } from "../src/main/auth/providerAuth";
import { listFiles } from "../src/main/files";
import { listSlashItems } from "../src/main/slashItems";
import { startPersistentProcess, stopPersistentProcess } from "../src/main/processes";
import { completeRequest, cancelAllForSession } from "../src/main/claude/askUserBridge";
import { createPty, writePty, resizePty, killPty } from "../src/main/terminal/pty";
import type {
  ChatStartArgs,
  CanvasCreateArgs,
  AskUserResponsePayload,
  TerminalCreateArgs,
  GenerateGroupSummaryRequest,
  GenerateCanvasNameRequest,
  PersistentProcessStartArgs,
} from "../src/shared/ipc";
import type { Canvas, Provider } from "../src/shared/types";
import { execSync } from "node:child_process";

const PORT = Number(process.env.PORT ?? 3001);

// ── Resolve system claude bin ────────────────────────────────────────────────

function resolveSystemClaude(): string | undefined {
  const cmd = process.platform === "win32" ? "where claude" : "which claude";
  try {
    return execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

// ── Session map: sessionId → WebSocket ──────────────────────────────────────

const sessions = new Map<string, WebSocket>();

function sendToSession(sessionId: string, msg: object): void {
  const ws = sessions.get(sessionId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Active chats: chatId → AbortController ───────────────────────────────────

type ActiveChat = { controller: AbortController; nodeId: string; sessionId: string };
const activeChats = new Map<string, ActiveChat>();

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve built frontend in production
app.use(express.static(join(import.meta.dirname, "../dist")));

// ── Canvases ─────────────────────────────────────────────────────────────────

app.get("/api/canvases", async (_req, res) => {
  res.json(await listCanvases());
});

app.post("/api/canvases", async (req, res) => {
  const canvas = await createCanvas(req.body as CanvasCreateArgs);
  res.json(canvas);
});

app.get("/api/canvases/:id", async (req, res) => {
  const canvas = await readCanvas(req.params.id);
  res.json(canvas);
});

app.put("/api/canvases/:id", async (req, res) => {
  await writeCanvas(req.body as Canvas);
  res.json({ ok: true });
});

app.delete("/api/canvases/:id", async (req, res) => {
  await deleteCanvas(req.params.id);
  res.json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────

app.get("/api/settings", async (_req, res) => {
  res.json(await readSettings());
});

app.put("/api/settings", async (req, res) => {
  const s = await writeSettings(req.body);
  res.json(s);
});

// ── Files & Slash ─────────────────────────────────────────────────────────────

app.get("/api/files", async (req, res) => {
  const cwd = String(req.query.cwd ?? homedir());
  res.json(await listFiles(cwd));
});

app.get("/api/slash", async (req, res) => {
  const cwd = String(req.query.cwd ?? homedir());
  res.json(await listSlashItems(cwd));
});

// ── Providers ─────────────────────────────────────────────────────────────────

app.get("/api/providers/:provider/auth", async (req, res) => {
  const provider = req.params.provider as Provider;
  const settings = await readSettings();
  const binPath =
    settings.providers?.[provider]?.binPath ??
    (provider === "claude" ? settings.claudeBinPath : undefined);
  res.json(await getProviderAuthStatus(provider, binPath));
});

app.post("/api/providers/:provider/login", async (req, res) => {
  const provider = req.params.provider as Provider;
  const settings = await readSettings();
  const binPath =
    settings.providers?.[provider]?.binPath ??
    (provider === "claude" ? settings.claudeBinPath : undefined);
  await openLoginTerminal(provider, binPath);
  res.json({ ok: true });
});

// ── Processes ─────────────────────────────────────────────────────────────────

app.post("/api/processes", async (req, res) => {
  const result = await startPersistentProcess(req.body as PersistentProcessStartArgs);
  res.json(result);
});

app.delete("/api/processes/:id", (req, res) => {
  res.json(stopPersistentProcess(req.params.id));
});

// ── Group summary / canvas name ───────────────────────────────────────────────

app.post("/api/group-summary", async (req, res) => {
  const args = req.body as GenerateGroupSummaryRequest;
  const settings = await readSettings();
  const model = settings.providers?.claude?.model ?? settings.claudeModel ?? undefined;
  try {
    res.json(await generateGroupSummaries({ ...args, model }));
  } catch {
    res.json([]);
  }
});

app.post("/api/canvas-name", async (req, res) => {
  const args = req.body as GenerateCanvasNameRequest;
  const settings = await readSettings();
  const model = settings.providers?.claude?.model ?? settings.claudeModel ?? undefined;
  try {
    res.json(await generateCanvasName({ ...args, model }));
  } catch {
    res.json(null);
  }
});

// ── Shell / dialog ────────────────────────────────────────────────────────────

app.post("/api/shell/open-path", async (req, res) => {
  const { path } = req.body as { path: string };
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [path], { detached: true, stdio: "ignore" }).unref();
  res.json({ ok: true });
});

// Folder picker can't be native in a browser — return null and let UI handle it
app.post("/api/dialog/pick-folder", (_req, res) => {
  res.json(null);
});

// ── Catch-all: serve frontend in production ────────────────────────────────────

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    res.sendFile(join(import.meta.dirname, "../dist/index.html"), (err) => {
      if (err) next(); // dist not built yet (dev mode)
    });
  } else {
    next();
  }
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  const sessionId = randomUUID();
  sessions.set(sessionId, ws);

  ws.on("message", (raw) => {
    let msg: { type: string; data: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleWsMessage(sessionId, ws, msg.type, msg.data).catch((err) => {
      console.error("[ws] unhandled error:", err);
    });
  });

  ws.on("close", () => {
    sessions.delete(sessionId);
    cancelAllForSession(sessionId);
    // Cancel all chats from this session
    for (const [chatId, entry] of activeChats) {
      if (entry.sessionId !== sessionId) continue;
      entry.controller.abort();
      activeChats.delete(chatId);
    }
  });

  // Send sessionId so client knows it's connected
  ws.send(JSON.stringify({ type: "session:ready", data: { sessionId } }));
});

async function handleWsMessage(
  sessionId: string,
  ws: WebSocket,
  type: string,
  data: unknown,
): Promise<void> {
  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  switch (type) {
    case "chat:start": {
      const args = data as ChatStartArgs;
      const { chatId, nodeId, canvasId } = args;

      const canvas = await readCanvas(canvasId);
      const settings = await readSettings();

      const provider: Provider =
        args.nodeSettings?.provider ??
        canvas?.provider ??
        settings.defaultProvider ??
        "claude";

      const effectiveCwd =
        args.nodeSettings?.cwd ?? canvas?.cwd ?? homedir();

      const providerCfg = settings.providers?.[provider];
      const configuredBin =
        providerCfg?.binPath ??
        (provider === "claude" ? settings.claudeBinPath : undefined);
      const binPath = configuredBin || resolveSystemClaude() || undefined;

      const model = providerCfg?.model ?? settings.claudeModel ?? undefined;

      const TERSE =
        "RESPONSE STYLE: Before each batch of tool calls, write ONE very short action-form label as a single line — 3 to 8 words, gerund form. Examples: 'Reading the canvas store', 'Searching for tool handlers'. NEVER start with a reaction word like 'Good', 'Great', 'Perfect'. NEVER use first-person prefixes like 'I'll', 'Let me'.";

      const systemParts = [settings.systemPrompt, settings.terseToolNarration ? TERSE : ""]
        .filter(Boolean);
      const systemPrompt = args.systemPromptOverride ?? systemParts.join("\n\n");

      const controller = new AbortController();
      activeChats.set(chatId, { controller, nodeId, sessionId });

      const combinedPrompt = buildPromptWithHistory(args.history, args.prompt, args.attachments);

      send({ type: "chat:event", data: { chatId, type: "start" } });

      try {
        await runAgent(provider, combinedPrompt, {
          cwd: effectiveCwd,
          model,
          binPath,
          systemPrompt,
          attachments: args.attachments,
          signal: controller.signal,
          planMode: args.planMode || args.nodeSettings?.planMode,
          sessionId,
          nodeId,
          sendToClient: (msg) => send({ type: "chat:event", data: msg }),
          onEvent: (ev) => {
            const chatEvent = (() => {
              switch (ev.kind) {
                case "text_delta": return { chatId, type: "text_delta", text: ev.text };
                case "thinking_delta": return { chatId, type: "thinking_delta", text: ev.text };
                case "tool_use": return { chatId, type: "tool_use", toolUseId: ev.toolUseId, name: ev.name, input: ev.input };
                case "tool_result": return { chatId, type: "tool_result", toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError };
                case "done": return { chatId, type: "done", isError: ev.isError, result: ev.result, code: ev.code, provider, usage: ev.usage };
                case "error": return { chatId, type: "error", message: ev.message, code: ev.code, provider };
                default: return null;
              }
            })();
            if (chatEvent) send({ type: "chat:event", data: chatEvent });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "chat:event", data: { chatId, type: "error", message, provider } });
        send({ type: "chat:event", data: { chatId, type: "done", isError: true, provider } });
      } finally {
        activeChats.delete(chatId);
      }
      break;
    }

    case "chat:cancel": {
      const { chatId } = data as { chatId: string };
      activeChats.get(chatId)?.controller.abort();
      activeChats.delete(chatId);
      cancelAllForSession(sessionId);
      break;
    }

    case "chat:cancelForNode": {
      const { nodeId } = data as { nodeId: string };
      for (const [chatId, entry] of activeChats) {
        if (entry.nodeId !== nodeId || entry.sessionId !== sessionId) continue;
        entry.controller.abort();
        activeChats.delete(chatId);
      }
      break;
    }

    case "askUser:respond": {
      completeRequest(data as AskUserResponsePayload);
      break;
    }

    case "terminal:create": {
      const { id, cwd } = data as TerminalCreateArgs;
      const settings = await readSettings();
      const configuredBin = settings.providers?.claude?.binPath ?? settings.claudeBinPath;
      const claudeBin = configuredBin || resolveSystemClaude() || "claude";
      createPty(id, claudeBin, cwd || homedir(), (chunk) => {
        send({ type: "terminal:data", data: { id, data: chunk } });
      });
      break;
    }

    case "terminal:input": {
      const { id, data: inputData } = data as { id: string; data: string };
      writePty(id, inputData);
      break;
    }

    case "terminal:resize": {
      const { id, cols, rows } = data as { id: string; cols: number; rows: number };
      resizePty(id, cols, rows);
      break;
    }

    case "terminal:kill": {
      const { id } = data as { id: string };
      killPty(id);
      break;
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  try {
    process.env.PATH = await getShellPath();
  } catch {
    // best-effort
  }

  httpServer.listen(PORT, () => {
    console.log(`[lmcanvas] server → http://localhost:${PORT}`);
  });
}

void boot();
