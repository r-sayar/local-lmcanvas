/**
 * End-to-end check of the rewritten chat path against the real Claude CLI.
 *
 * The claim under test is the one most likely to be quietly wrong: that a node
 * captures its CLI session id and that the next turn resumes it instead of
 * replaying the transcript as text. If resume silently failed, turn 2 would
 * still "work" — it would just have amnesia — so this asserts on recall.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChatRun } from "@main/chatRun";
import { canvasFilePath, ensureDirs } from "@main/storage/paths";
import type { ChatEvent } from "@shared/ipc";
import type { Canvas } from "@shared/types";

const CANVAS_ID = "zzParityE2E";
const workdir = mkdtempSync(join(tmpdir(), "lmc-e2e-"));

const canvas: Canvas = {
  id: CANVAS_ID,
  name: "parity e2e",
  cwd: workdir,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  nodes: [],
  edges: [],
  provider: "claude",
};

type Turn = {
  text: string;
  sessionId?: string;
  events: string[];
  error?: string;
  usage?: unknown;
};

async function runTurn(
  prompt: string,
  opts: { resumeSessionId?: string; forkSession?: boolean; permissionMode?: "plan" | "acceptEdits" },
): Promise<Turn> {
  const turn: Turn = { text: "", events: [] };
  const chatId = `chat-${Math.random().toString(36).slice(2)}`;

  await startChatRun(
    {
      chatId,
      nodeId: "n1",
      canvasId: CANVAS_ID,
      history: [],
      prompt,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      forkSession: opts.forkSession,
    },
    {
      sessionKey: "e2e",
      sendChatEvent: (ev: ChatEvent) => {
        if (!turn.events.includes(ev.type)) turn.events.push(ev.type);
        if (ev.type === "text_delta") turn.text += ev.text;
        if (ev.type === "session") turn.sessionId = ev.sessionId;
        if (ev.type === "error") turn.error = ev.message;
        if (ev.type === "done") {
          turn.usage = ev.usage;
          if (ev.isError) turn.error = ev.result ?? "done(isError)";
        }
      },
      sendToClient: () => {
        throw new Error("unexpected out-of-band request in this test");
      },
    },
  );

  return turn;
}

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main(): Promise<number> {
  await ensureDirs();
  await writeFile(canvasFilePath(CANVAS_ID), JSON.stringify(canvas, null, 2));

  let allOk = true;
  try {
    console.log("--- turn 1: fresh session ---");
    const t1 = await runTurn(
      "Reply with exactly the single word BANANA. No punctuation, no explanation.",
      { permissionMode: "acceptEdits" },
    );
    console.log("   text:", JSON.stringify(t1.text.trim().slice(0, 120)));
    console.log("   events:", t1.events.join(", "));
    console.log("   sessionId:", t1.sessionId ?? "(none)");
    if (t1.error) console.log("   error:", t1.error);

    allOk = check("turn 1 produced text", t1.text.trim().length > 0) && allOk;
    allOk = check("turn 1 emitted a session id", Boolean(t1.sessionId)) && allOk;
    allOk = check("turn 1 said BANANA", /BANANA/i.test(t1.text)) && allOk;
    allOk = check("turn 1 reported usage", t1.usage !== undefined) && allOk;

    if (!t1.sessionId) {
      console.log("no session id — cannot test resume");
      return 1;
    }

    console.log("--- turn 2: resume the same session (no history re-sent) ---");
    const t2 = await runTurn(
      "What single word did you just say? Reply with only that word.",
      { resumeSessionId: t1.sessionId, permissionMode: "acceptEdits" },
    );
    console.log("   text:", JSON.stringify(t2.text.trim().slice(0, 120)));
    console.log("   sessionId:", t2.sessionId ?? "(none)");
    if (t2.error) console.log("   error:", t2.error);

    allOk =
      check(
        "resumed turn recalls prior context",
        /BANANA/i.test(t2.text),
        "history was NOT re-sent, so recall proves resume worked",
      ) && allOk;

    console.log("--- turn 3: fork the session (canvas branching) ---");
    const t3 = await runTurn(
      "What single word did you say earlier? Reply with only that word.",
      { resumeSessionId: t1.sessionId, forkSession: true, permissionMode: "acceptEdits" },
    );
    console.log("   text:", JSON.stringify(t3.text.trim().slice(0, 120)));
    console.log("   sessionId:", t3.sessionId ?? "(none)");
    if (t3.error) console.log("   error:", t3.error);

    allOk = check("fork recalls parent context", /BANANA/i.test(t3.text)) && allOk;
    allOk =
      check(
        "fork got a NEW session id",
        Boolean(t3.sessionId) && t3.sessionId !== t1.sessionId,
        `${t1.sessionId} -> ${t3.sessionId}`,
      ) && allOk;

    console.log("--- turn 4: plan mode must not mutate ---");
    const t4 = await runTurn(
      "Create a file called proof.txt containing the word HELLO in the current directory.",
      { permissionMode: "plan" },
    );
    const created = existsSync(join(workdir, "proof.txt"));
    console.log("   text:", JSON.stringify(t4.text.trim().slice(0, 160)));
    allOk = check("plan mode did not write the file", !created) && allOk;
  } finally {
    await unlink(canvasFilePath(CANVAS_ID)).catch(() => {});
    rmSync(workdir, { recursive: true, force: true });
    console.log("cleaned up test canvas and workdir");
  }

  console.log(allOk ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  return allOk ? 0 : 1;
}

process.exit(await main());
