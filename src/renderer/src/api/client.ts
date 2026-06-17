import type { LmcApi } from "@shared/ipc";
import type { AppSettings, Canvas, Provider } from "@shared/types";

const API = "/api";

// ── WebSocket ─────────────────────────────────────────────────────────────────

type WsHandler = (data: unknown) => void;
const wsHandlers = new Map<string, Set<WsHandler>>();
let ws: WebSocket | null = null;
let wsReady = false;
const wsQueue: string[] = [];

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function wsOn(type: string, handler: WsHandler): () => void {
  if (!wsHandlers.has(type)) wsHandlers.set(type, new Set());
  wsHandlers.get(type)!.add(handler);
  return () => wsHandlers.get(type)?.delete(handler);
}

function wsSend(msg: object): void {
  const raw = JSON.stringify(msg);
  if (wsReady && ws?.readyState === WebSocket.OPEN) {
    ws.send(raw);
  } else {
    wsQueue.push(raw);
  }
}

function connectWs(): void {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    wsReady = true;
    for (const msg of wsQueue.splice(0)) ws!.send(msg);
  };

  ws.onmessage = (ev) => {
    let msg: { type: string; data: unknown };
    try { msg = JSON.parse(ev.data); } catch { return; }
    wsHandlers.get(msg.type)?.forEach((h) => h(msg.data));
  };

  ws.onclose = () => {
    wsReady = false;
    // Reconnect after a delay
    setTimeout(connectWs, 2000);
  };

  ws.onerror = () => ws?.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return r.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "DELETE" });
  return r.json() as Promise<T>;
}

// ── API implementation ────────────────────────────────────────────────────────

export function initApi(): void {
  connectWs();

  const api: LmcApi = {
    canvases: {
      list: () => get("/canvases"),
      create: (args) => post("/canvases", args),
      read: (id) => get(`/canvases/${id}`),
      write: (canvas: Canvas) => put(`/canvases/${canvas.id}`, canvas),
      delete: (id) => del(`/canvases/${id}`),
    },

    settings: {
      read: () => get<AppSettings>("/settings"),
      write: (s: AppSettings) => put<AppSettings>("/settings", s),
    },

    chat: {
      start: (args) => {
        wsSend({ type: "chat:start", data: args });
        return Promise.resolve();
      },
      cancel: (chatId) => {
        wsSend({ type: "chat:cancel", data: { chatId } });
        return Promise.resolve();
      },
      cancelForNode: (nodeId) => {
        wsSend({ type: "chat:cancelForNode", data: { nodeId } });
        return Promise.resolve();
      },
      onEvent: (handler) => wsOn("chat:event", handler as WsHandler),
    },

    dialog: {
      // No native folder picker in browser — show a prompt fallback
      pickFolder: async (defaultPath) => {
        const result = window.prompt("Enter folder path:", defaultPath ?? "");
        return result ?? null;
      },
    },

    shell: {
      openPath: (path) => post("/shell/open-path", { path }),
    },

    processes: {
      start: (args) => post("/processes", args),
      stop: (id) => del(`/processes/${id}`),
    },

    files: {
      list: (cwd) => get(`/files?cwd=${encodeURIComponent(cwd)}`),
    },

    slash: {
      list: (cwd) => get(`/slash?cwd=${encodeURIComponent(cwd)}`),
    },

    providers: {
      authStatus: (provider: Provider) => get(`/providers/${provider}/auth`),
      openLoginTerminal: (provider: Provider) => post(`/providers/${provider}/login`),
    },

    askUser: {
      onRequest: (handler) => wsOn("askUser:request", handler as WsHandler),
      respond: (payload) => {
        wsSend({ type: "askUser:respond", data: payload });
        return Promise.resolve();
      },
    },

    window: {
      openCanvas: async (canvasId) => {
        if (canvasId) {
          window.open(`/#/canvas/${canvasId}`, "_blank");
        }
      },
    },

    groupSummary: {
      generate: (args) => post("/group-summary", args),
    },

    canvasName: {
      generate: (args) => post("/canvas-name", args),
    },

    terminal: {
      create: (args) => {
        wsSend({ type: "terminal:create", data: args });
        return Promise.resolve();
      },
      input: (id, data) => wsSend({ type: "terminal:input", data: { id, data } }),
      resize: (id, cols, rows) => wsSend({ type: "terminal:resize", data: { id, cols, rows } }),
      kill: (id) => {
        wsSend({ type: "terminal:kill", data: { id } });
        return Promise.resolve();
      },
      onData: (handler) => wsOn("terminal:data", (d) => {
        const { id, data } = d as { id: string; data: string };
        handler(id, data);
      }),
    },
  };

  (window as unknown as { api: LmcApi }).api = api;
}
