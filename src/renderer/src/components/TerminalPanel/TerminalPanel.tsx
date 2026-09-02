import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { X, TerminalSquare, Circle } from "lucide-react";
import { useTerminalStore } from "@/hooks/useTerminalStore";

// Strip ANSI escape codes so raw terminal bytes become plain text.
// Written with explicit escapes: the equivalent literal ESC, CSI and BEL bytes
// are invisible in an editor and do not survive a copy-paste, which makes the
// pattern look broken when it isn't.
const ANSI_RE =
  /[\x1b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|[\x1b\u009b][()][A-Z0-9]|\x1b[A-Z\\]|\x07|\r/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

type Props = {
  canvasId: string;
  cwd?: string;
};

export function TerminalPanel({ canvasId, cwd }: Props) {
  const open = useTerminalStore((s) => s.open);
  const height = useTerminalStore((s) => s.height);
  const capturing = useTerminalStore((s) => s.capturing);
  const setOpen = useTerminalStore((s) => s.setOpen);
  const setHeight = useTerminalStore((s) => s.setHeight);
  const toggleCapture = useTerminalStore((s) => s.toggleCapture);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = `terminal:${canvasId}`;
  const dragStartY = useRef<number | null>(null);
  const dragStartH = useRef<number>(height);

  const fit = useCallback(() => {
    if (!fitRef.current || !termRef.current) return;
    try {
      fitRef.current.fit();
      const { cols, rows } = termRef.current;
      window.api.terminal.resize(sessionId, cols, rows);
    } catch {
      // ignore resize errors
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      theme: {
        background: "#0d0d0d",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
      cursorBlink: true,
      scrollback: 1000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
      fitAddon.fit();
    }

    void window.api.terminal.create({ id: sessionId, cwd: cwd ?? "" });

    const unsubData = window.api.terminal.onData((id, data) => {
      if (id !== sessionId) return;
      term.write(data);
      if (useTerminalStore.getState().capturing) {
        const text = stripAnsi(data);
        if (text) {
          window.dispatchEvent(new CustomEvent("lmc:terminal-chunk", { detail: text }));
        }
      }
    });

    term.onData((data) => {
      window.api.terminal.input(sessionId, data);
    });

    const ro = new ResizeObserver(() => fit());
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unsubData();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [open, sessionId, cwd, fit]);

  // drag-to-resize the panel height
  const onDragStart = (e: React.MouseEvent) => {
    dragStartY.current = e.clientY;
    dragStartH.current = height;

    const onMove = (ev: MouseEvent) => {
      if (dragStartY.current === null) return;
      const delta = dragStartY.current - ev.clientY;
      setHeight(Math.max(120, Math.min(800, dragStartH.current + delta)));
    };
    const onUp = () => {
      dragStartY.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      fit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    if (capturing) {
      window.dispatchEvent(new CustomEvent("lmc:terminal-capture-start"));
    } else {
      window.dispatchEvent(new CustomEvent("lmc:terminal-capture-end"));
    }
  }, [capturing]);

  if (!open) return null;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-40 flex flex-col border-t border-border bg-[#0d0d0d]"
      style={{ height }}
    >
      {/* drag handle */}
      <div
        className="h-1 w-full cursor-ns-resize hover:bg-primary/30 flex-shrink-0"
        onMouseDown={onDragStart}
      />

      {/* header */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border/50 flex-shrink-0">
        <TerminalSquare size={13} className="text-foreground/50" />
        <span className="text-xs text-foreground/60 font-mono select-none">claude</span>
        <div className="flex-1" />
        <button
          onClick={toggleCapture}
          className={`mr-1 cursor-pointer transition-colors ${capturing ? "text-red-400 hover:text-red-300" : "text-foreground/40 hover:text-foreground"}`}
          title={capturing ? "stop streaming to canvas" : "stream output to canvas"}
        >
          <Circle size={11} className={capturing ? "fill-red-400" : ""} />
        </button>
        <button
          onClick={() => setOpen(false)}
          className="text-foreground/40 hover:text-foreground cursor-pointer"
          title="close terminal"
        >
          <X size={13} />
        </button>
      </div>

      {/* terminal viewport */}
      <div ref={containerRef} className="flex-1 overflow-hidden p-1" />
    </div>
  );
}
