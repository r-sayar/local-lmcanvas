/**
 * Stream demo — text input layout + interactive PTY backend
 * run: node demo.mjs
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { execSync } from "node:child_process";
import stripAnsi from "strip-ansi";

function findClaude() {
  try { return execSync("which claude", { encoding: "utf8" }).trim(); }
  catch { return "claude"; }
}

// Filter out Claude's TUI chrome — box-drawing borders, prompt glyph, status bar.
function isChrome(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[─-▟⠀-⣿╭╮╰╯❯►▶⏵⏶◆]/.test(t)) return true;
  const flat = t.replace(/\s/g, "").toLowerCase();
  if (/bypasspermission|higho?effort|lowo?effort|foragents|shifttab/.test(flat)) return true;
  return false;
}

function clean(raw) {
  return stripAnsi(raw)
    .replace(/\r/g, "")
    .split("\n")
    .filter(l => !isChrome(l))
    .join("\n");
}

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>stream demo</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Menlo", "Monaco", monospace;
      background: #0d0d0d;
      color: #d4d4d4;
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 24px;
      gap: 12px;
    }
    h2 { margin: 0; font-size: 13px; color: #888; font-weight: normal; letter-spacing: .06em; }
    #out {
      flex: 1;
      overflow-y: auto;
      border: 1px solid #222;
      border-radius: 6px;
      padding: 14px 16px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.6;
      background: #0a0a0a;
    }
    .you    { color: #60a5fa; }
    .claude { color: #d4d4d4; }
    .row { display: flex; gap: 8px; }
    input {
      flex: 1; padding: 9px 12px; font-size: 12px; font-family: inherit;
      background: #1a1a1a; color: #d4d4d4; border: 1px solid #333; border-radius: 6px; outline: none;
    }
    input:focus { border-color: #555; }
    button {
      padding: 9px 16px; font-size: 12px; font-family: inherit;
      background: #2a2a2a; color: #d4d4d4; border: 1px solid #444; border-radius: 6px; cursor: pointer;
    }
    button:hover { background: #333; }
    button:disabled { opacity: .4; cursor: default; }
    #status { font-size: 11px; color: #444; }
  </style>
</head>
<body>
  <h2>console → canvas stream demo</h2>
  <div id="out"></div>
  <div class="row">
    <input id="p" type="text" placeholder="enter a prompt…" autofocus>
    <button id="btn" onclick="send()" disabled>Send</button>
  </div>
  <div id="status">connecting…</div>

  <script>
    const out = document.getElementById("out");
    const input = document.getElementById("p");
    const btn = document.getElementById("btn");
    const status = document.getElementById("status");
    let claudeEl = null;

    const ws = new WebSocket("ws://" + location.host + "/ws");

    ws.onopen = () => { status.textContent = "starting…"; };

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);

      if (msg.type === "chunk") {
        if (!claudeEl) {
          claudeEl = document.createElement("span");
          claudeEl.className = "claude";
          out.appendChild(claudeEl);
        }
        claudeEl.textContent += msg.text;
        out.scrollTop = out.scrollHeight;
      }

      if (msg.type === "ready") {
        btn.disabled = false;
        status.textContent = "ready";
        claudeEl = null;
      }
    };

    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

    function send() {
      const text = input.value.trim();
      if (!text || btn.disabled) return;
      input.value = "";
      btn.disabled = true;
      claudeEl = null;

      const you = document.createElement("span");
      you.className = "you";
      you.textContent = (out.textContent ? "\\n" : "") + "> " + text + "\\n\\n";
      out.appendChild(you);

      ws.send(JSON.stringify({ type: "input", text }));
      status.textContent = "streaming…";
    }
  </script>
</body>
</html>`;

// ── HTTP ──────────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const proc = pty.spawn(findClaude(), [], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  });

  // States: "startup" → suppress all output until the REPL is ready
  //         "waiting" → REPL is idle, forwarding nothing
  //         "streaming" → forwarding output to browser
  let state = "startup";
  let quietTimer = null;
  let textBuf = "";

  function scheduleQuiet(ms) {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (state === "startup") {
        state = "waiting";
        send({ type: "ready" });
      } else if (state === "streaming") {
        if (textBuf) { send({ type: "chunk", text: textBuf }); textBuf = ""; }
        state = "waiting";
        send({ type: "ready" });
      }
    }, ms);
  }

  proc.onData((raw) => {
    const text = clean(raw);

    if (state === "startup") {
      // Suppress all startup noise; declare ready after 1.5s of quiet
      scheduleQuiet(3000);
      return;
    }

    if (state === "waiting") return; // idle, nothing to forward

    // state === "streaming": buffer and flush in 16ms batches
    textBuf += text;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (textBuf) { send({ type: "chunk", text: textBuf }); textBuf = ""; }
      // After 900ms of quiet post-response, Claude is back at its prompt
      quietTimer = setTimeout(() => {
        state = "waiting";
        send({ type: "ready" });
      }, 900);
    }, 16);
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "input") return;
    state = "streaming";
    textBuf = "";
    proc.write(msg.text + "\r");
  });

  ws.on("close", () => { try { proc.kill(); } catch { /* gone */ } });

  // Kick off the startup quiet timer
  scheduleQuiet(3000);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

httpServer.listen(3333, () => console.log("open  http://localhost:3333"));
