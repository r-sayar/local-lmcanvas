import { contextBridge, ipcRenderer } from "electron";
import type {
  AskUserRequest,
  AskUserResponsePayload,
  ChatEvent,
  ChatStartArgs,
  GenerateCanvasNameRequest,
  GenerateGroupSummaryRequest,
  LmcApi,
  CanvasCreateArgs,
  PersistentProcessStartArgs,
  TerminalCreateArgs,
} from "@shared/ipc";
import type { AppSettings, Canvas, Provider } from "@shared/types";

const api: LmcApi = {
  canvases: {
    list: () => ipcRenderer.invoke("canvases:list"),
    create: (args: CanvasCreateArgs) => ipcRenderer.invoke("canvases:create", args),
    read: (id) => ipcRenderer.invoke("canvases:read", id),
    write: (canvas: Canvas) => ipcRenderer.invoke("canvases:write", canvas),
    delete: (id) => ipcRenderer.invoke("canvases:delete", id),
  },
  settings: {
    read: () => ipcRenderer.invoke("settings:read"),
    write: (s: AppSettings) => ipcRenderer.invoke("settings:write", s),
  },
  chat: {
    start: (args: ChatStartArgs) => ipcRenderer.invoke("chat:start", args),
    cancel: (chatId) => ipcRenderer.invoke("chat:cancel", chatId),
    cancelForNode: (nodeId) => ipcRenderer.invoke("chat:cancelForNode", nodeId),
    onEvent: (handler: (ev: ChatEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, ev: ChatEvent) => handler(ev);
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.off("chat:event", listener);
    },
  },
  dialog: {
    pickFolder: (defaultPath?: string) =>
      ipcRenderer.invoke("dialog:pickFolder", defaultPath),
  },
  shell: {
    openPath: (path: string) => ipcRenderer.invoke("shell:openPath", path),
  },
  processes: {
    start: (args: PersistentProcessStartArgs) =>
      ipcRenderer.invoke("processes:start", args),
    stop: (id: string) => ipcRenderer.invoke("processes:stop", id),
  },
  files: {
    list: (cwd: string) => ipcRenderer.invoke("files:list", cwd),
  },
  slash: {
    list: (cwd: string) => ipcRenderer.invoke("slash:list", cwd),
  },
  providers: {
    authStatus: (provider: Provider) =>
      ipcRenderer.invoke("providers:authStatus", provider),
    openLoginTerminal: (provider: Provider) =>
      ipcRenderer.invoke("providers:openLogin", provider),
  },
  askUser: {
    onRequest: (handler: (req: AskUserRequest) => void) => {
      const listener = (_: Electron.IpcRendererEvent, req: AskUserRequest) =>
        handler(req);
      ipcRenderer.on("askUser:request", listener);
      return () => ipcRenderer.off("askUser:request", listener);
    },
    respond: (payload: AskUserResponsePayload) =>
      ipcRenderer.invoke("askUser:respond", payload),
  },
  window: {
    openCanvas: (canvasId?: string) =>
      ipcRenderer.invoke("window:openCanvas", canvasId),
  },
  groupSummary: {
    generate: (args: GenerateGroupSummaryRequest) =>
      ipcRenderer.invoke("groupSummary:generate", args),
  },
  canvasName: {
    generate: (args: GenerateCanvasNameRequest) =>
      ipcRenderer.invoke("canvasName:generate", args),
  },
};

api.terminal = {
  create: (args: TerminalCreateArgs) => ipcRenderer.invoke("terminal:create", args),
  input: (id: string, data: string) => ipcRenderer.send("terminal:input", id, data),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", id, cols, rows),
  kill: (id: string) => ipcRenderer.invoke("terminal:kill", id),
  onData: (handler: (id: string, data: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, data: string) =>
      handler(id, data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.off("terminal:data", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);
