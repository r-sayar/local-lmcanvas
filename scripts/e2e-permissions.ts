/**
 * Verifies the interactive permission bridge end to end.
 *
 * `canUseTool` is the headline feature and the one with the most ways to fail
 * silently: if the callback is never installed the agent just runs unprompted
 * (looks fine, is wrong), and if a decision never gets back the CLI hangs.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChatRun } from "@main/chatRun";
import {
  respondToPermission,
  setAlwaysAllowedTools,
  matchingRule,
  suggestRule,
} from "@main/claude/permissions";
import { canvasFilePath, ensureDirs } from "@main/storage/paths";
import type { ChatEvent, PermissionRequest } from "@shared/ipc";
import type { Canvas, PermissionMode } from "@shared/types";

const CANVAS_ID = "zzPermE2E";

type Outcome = {
  requests: PermissionRequest[];
  text: string;
  error?: string;
};

async function run(
  prompt: string,
  workdir: string,
  permissionMode: PermissionMode,
  decide: (req: PermissionRequest) => { behavior: "allow" | "deny"; message?: string },
): Promise<Outcome> {
  const out: Outcome = { requests: [], text: "" };

  await startChatRun(
    {
      chatId: `c-${Math.random().toString(36).slice(2)}`,
      nodeId: "n1",
      canvasId: CANVAS_ID,
      history: [],
      prompt,
      permissionMode,
    },
    {
      sessionKey: "perm-e2e",
      sendChatEvent: (ev: ChatEvent) => {
        if (ev.type === "text_delta") out.text += ev.text;
        if (ev.type === "error") out.error = ev.message;
        if (ev.type === "done" && ev.isError) out.error = ev.result ?? "done(isError)";
      },
      sendToClient: (msg: object) => {
        const env = msg as { type?: string; data?: PermissionRequest };
        if (env.type !== "permission:request" || !env.data) return;
        const req = env.data;
        out.requests.push(req);
        // Answer asynchronously, exactly as the renderer would.
        const decision = decide(req);
        setTimeout(() => {
          respondToPermission(
            decision.behavior === "allow"
              ? { id: req.id, behavior: "allow" }
              : { id: req.id, behavior: "deny", message: decision.message },
          );
        }, 10);
      },
    },
  );

  return out;
}

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main(): Promise<number> {
  const workdir = mkdtempSync(join(tmpdir(), "lmc-perm-"));
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: "perm e2e",
    cwd: workdir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: [],
    edges: [],
    provider: "claude",
  };

  await ensureDirs();
  await writeFile(canvasFilePath(CANVAS_ID), JSON.stringify(canvas, null, 2));
  setAlwaysAllowedTools([]);

  let ok = true;
  try {
    console.log("--- deny: the write must not happen ---");
    const denied = await run(
      "Use the Write tool to create a file named denied.txt containing DENIED. Do not use Bash.",
      workdir,
      "default",
      () => ({ behavior: "deny", message: "The user declined this write." }),
    );
    console.log("   requests:", denied.requests.map((r) => `${r.toolName}(${r.summary ?? ""})`).join(", ") || "(none)");
    ok = check("a permission request was raised", denied.requests.length > 0) && ok;
    ok = check("denied write did not touch the disk", !existsSync(join(workdir, "denied.txt"))) && ok;
    const rule = denied.requests[0]?.alwaysAllowRule;
    console.log("   alwaysAllowRule offered:", rule);

    console.log("--- allow: the write must happen ---");
    const allowed = await run(
      "Use the Write tool to create a file named allowed.txt containing ALLOWED. Do not use Bash.",
      workdir,
      "default",
      () => ({ behavior: "allow" }),
    );
    const p = join(workdir, "allowed.txt");
    console.log("   requests:", allowed.requests.map((r) => r.toolName).join(", ") || "(none)");
    ok = check("approved write landed", existsSync(p), existsSync(p) ? readFileSync(p, "utf8").trim() : "missing") && ok;

    console.log("--- bypassPermissions: no prompt at all ---");
    const bypass = await run(
      "Use the Write tool to create a file named bypass.txt containing BYPASS. Do not use Bash.",
      workdir,
      "bypassPermissions",
      () => ({ behavior: "deny" }),
    );
    ok = check("bypass raised no permission request", bypass.requests.length === 0) && ok;
    ok = check("bypass wrote the file", existsSync(join(workdir, "bypass.txt"))) && ok;

    console.log("--- acceptEdits: edits pass without prompting ---");
    const accept = await run(
      "Use the Write tool to create a file named accepted.txt containing OK. Do not use Bash.",
      workdir,
      "acceptEdits",
      () => ({ behavior: "deny" }),
    );
    ok =
      check(
        "acceptEdits wrote without prompting",
        existsSync(join(workdir, "accepted.txt")) && accept.requests.length === 0,
        `requests=${accept.requests.length}`,
      ) && ok;

    // Rule matching is checked directly rather than through a turn: the live
    // allow-list is reloaded from settings at the start of every run, so an
    // end-to-end version would have to write to the user's settings file.
    console.log("--- always-allow rule matching ---");
    const cases: [string, Record<string, unknown>, string[], boolean][] = [
      ["Bash", { command: "git --version" }, ["Bash(git *)"], true],
      ["Bash", { command: "git status --short" }, ["Bash(git *)"], true],
      ["Bash", { command: "rm -rf /" }, ["Bash(git *)"], false],
      ["Bash", { command: "gitfoo" }, ["Bash(git *)"], false],
      ["Read", { file_path: "/tmp/a.txt" }, ["Read"], true],
      ["Write", { file_path: "/tmp/a.txt" }, ["Read"], false],
      ["Bash", { command: "anything" }, ["Bash"], true],
      ["Bash", { command: "ls" }, ["Bash(*)"], true],
      ["Read", { file_path: "/etc/passwd" }, ["Read(/tmp/*)"], false],
      ["Read", { file_path: "/tmp/x" }, ["Read(/tmp/*)"], true],
      // A malformed rule must never widen access.
      ["Bash", { command: "git status" }, ["Bash(git *"], false],
    ];
    for (const [tool, input, rules, expected] of cases) {
      const got = matchingRule(tool, input, rules) !== undefined;
      ok =
        check(
          `${rules[0]} vs ${tool}(${Object.values(input)[0]})`,
          got === expected,
          got === expected ? "" : `expected ${expected}, got ${got}`,
        ) && ok;
    }

    console.log("--- suggested rule narrows Bash to its command ---");
    ok = check(
      "git status -> Bash(git *)",
      suggestRule("Bash", { command: "git status" }) === "Bash(git *)",
    ) && ok;
    ok = check(
      "absolute path command falls back to bare Bash",
      suggestRule("Bash", { command: "/usr/bin/rm -rf x" }) === "Bash",
    ) && ok;
    ok = check(
      "non-Bash tools suggest the bare tool name",
      suggestRule("Write", { file_path: "/tmp/a" }) === "Write",
    ) && ok;
  } finally {
    setAlwaysAllowedTools([]);
    await unlink(canvasFilePath(CANVAS_ID)).catch(() => {});
    rmSync(workdir, { recursive: true, force: true });
    console.log("cleaned up");
  }

  console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  return ok ? 0 : 1;
}

process.exit(await main());
