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
import {
  startChatRun,
  abortChat,
  abortChatsForNode,
  abortChatsForSession,
} from "../src/main/chatRun";
import { generateGroupSummaries } from "../src/main/groupSummary/generate";
import { generateCanvasName } from "../src/main/canvasName/generate";
import { getProviderAuthStatus, openLoginTerminal } from "../src/main/auth/providerAuth";
import { listFiles } from "../src/main/files";
import { listSlashItems, mergeSlashItems } from "../src/main/slashItems";
import { getCapabilities } from "../src/main/claude/capabilities";
import { respondToPermission, cancelPermissionsForSession } from "../src/main/claude/permissions";
import {
  interruptRun,
  setRunPermissionMode,
  setRunModel,
  backgroundRunTasks,
  getRunContextUsage,
  rewindRunFiles,
  runIdsForNode,
} from "../src/main/claude/sessions";
import { resolveClaudeExecutable } from "../src/main/claude/binary";
import { startPersistentProcess, stopPersistentProcess } from "../src/main/processes";
import { completeRequest, cancelAllForSession } from "../src/main/claude/askUserBridge";
import { createPty, writePty, resizePty, killPty } from "../src/main/terminal/pty";
import type {
  ChatStartArgs,
  CanvasCreateArgs,
  AskUserResponsePayload,
  PermissionDecision,
  TerminalCreateArgs,
  GenerateGroupSummaryRequest,
  GenerateCanvasNameRequest,
  PersistentProcessStartArgs,
} from "../src/shared/ipc";
import type { Canvas, PermissionMode, Provider } from "../src/shared/types";

const PORT = Number(process.env.PORT ?? 3001);

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

// ── Claude capabilities & live-run control ───────────────────────────────────

app.post("/api/claude/capabilities", async (req, res) => {
  const { cwd, refresh } = req.body as { cwd?: string; refresh?: boolean };
  const settings = await readSettings();
  const binPath = settings.providers?.claude?.binPath ?? settings.claudeBinPath;
  const caps = await getCapabilities(cwd ?? "", binPath, refresh === true);
  const onDisk = await listSlashItems(cwd ?? "");
  res.json({ ...caps, commands: mergeSlashItems(caps.commands, onDisk) });
});

app.post("/api/claude/rewind", async (req, res) => {
  const { chatId, userMessageId, dryRun } = req.body as {
    chatId: string;
    userMessageId: string;
    dryRun?: boolean;
  };
  res.json(await rewindRunFiles(chatId, userMessageId, dryRun));
});

app.post("/api/chat/context-usage", async (req, res) => {
  const { chatId } = req.body as { chatId: string };
  res.json(await getRunContextUsage(chatId));
});

app.post("/api/chat/background-tasks", async (req, res) => {
  const { chatId, toolUseId } = req.body as { chatId: string; toolUseId?: string };
  res.json(await backgroundRunTasks(chatId, toolUseId));
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
      await startChatRun(args, {
        sessionKey: sessionId,
        sendChatEvent: (ev) => send({ type: "chat:event", data: ev }),
        // Ask-user and permission requests already carry their own envelope
        // type, so they can go straight down the same socket.
        sendToClient: (msg) => send(msg),
      });
      break;
    }


    case "chat:cancel": {
      const { chatId } = data as { chatId: string };
      abortChat(chatId);
      cancelAllForSession(sessionId);
      cancelPermissionsForSession(sessionId);
      break;
    }

    case "chat:interrupt": {
      const { chatId } = data as { chatId: string };
      const interrupted = await interruptRun(chatId);
      if (!interrupted) abortChat(chatId);
      break;
    }

    case "chat:cancelForNode": {
      const { nodeId } = data as { nodeId: string };
      abortChatsForNode(nodeId);
      for (const chatId of runIdsForNode(nodeId)) abortChat(chatId);
      break;
    }

    case "chat:setPermissionMode": {
      const { chatId, mode } = data as { chatId: string; mode: PermissionMode };
      await setRunPermissionMode(chatId, mode);
      break;
    }

    case "chat:setModel": {
      const { chatId, model } = data as { chatId: string; model?: string };
      await setRunModel(chatId, model);
      break;
    }

    case "askUser:respond": {
      completeRequest(data as AskUserResponsePayload);
      break;
    }

    case "permission:respond": {
      respondToPermission(data as PermissionDecision);
      break;
    }

    case "terminal:create": {
      const { id, cwd } = data as TerminalCreateArgs;
      const settings = await readSettings();
      const configuredBin = settings.providers?.claude?.binPath ?? settings.claudeBinPath;
      const claudeBin = resolveClaudeExecutable(configuredBin) ?? "claude";
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
  // Strip Claude Code session vars so spawned claude processes use normal OAuth
  // auth instead of trying to authenticate against the parent session.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE") {
      delete process.env[key];
    }
  }
  console.log("[lmcanvas] CLAUDECODE after strip:", process.env.CLAUDECODE ?? "undefined");

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
