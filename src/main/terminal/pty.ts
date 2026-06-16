import * as nodePty from "node-pty";
import type { IDisposable, IPty } from "node-pty";

type PtySession = {
  pty: IPty;
  onDataDisposable: IDisposable;
};

const sessions = new Map<string, PtySession>();

export function createPty(
  id: string,
  claudeBin: string,
  cwd: string,
  onData: (data: string) => void,
): void {
  if (sessions.has(id)) return;

  const ptyProcess = nodePty.spawn(claudeBin, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  });

  const onDataDisposable = ptyProcess.onData(onData);
  sessions.set(id, { pty: ptyProcess, onDataDisposable });

  ptyProcess.onExit(() => {
    sessions.delete(id);
  });
}

export function writePty(id: string, data: string): void {
  sessions.get(id)?.pty.write(data);
}

export function resizePty(id: string, cols: number, rows: number): void {
  sessions.get(id)?.pty.resize(cols, rows);
}

export function killPty(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.onDataDisposable.dispose();
  try {
    session.pty.kill();
  } catch {
    // already dead
  }
  sessions.delete(id);
}

export function hasPty(id: string): boolean {
  return sessions.has(id);
}
