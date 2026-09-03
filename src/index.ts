#!/usr/bin/env node
import * as fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_TIMEOUT_S, SOCKET, capturePane, cleanupSync, log, paneInfo, tmux,
} from "./tmux.js";
import { SessionManager, type Session } from "./sessions.js";
import { waitForResult, type WaitResult } from "./wait.js";
import { isTui, postProcess, trimTrailingBlank, truncate } from "./ansi.js";
import { formatResponse } from "./format.js";

let version = "0.0.0";
try {
  version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
} catch { /* ignore */ }

const mgr = new SessionManager();

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function renderBody(
  session: Session,
  res: WaitResult,
  command?: string,
): Promise<{ body: string; tui: boolean }> {
  const rawStr = res.raw.toString("utf8");
  if (isTui(rawStr, res.alternate)) {
    const snap = trimTrailingBlank(await capturePane(session.paneId));
    return { body: truncate(snap), tui: true };
  }
  return { body: postProcess(rawStr, command), tui: false };
}

function compileWaitFor(src?: string): RegExp | Error | undefined {
  if (src === undefined) return undefined;
  try {
    return new RegExp(src, "m");
  } catch (e) {
    return new Error(`invalid wait_for regex ${JSON.stringify(src)}: ${msgOf(e)}`);
  }
}

const KEY_RE =
  /^(C-|M-|S-)*(.|Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|IC|DC|F\d{1,2})$/;

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m ago`;
}

const server = new McpServer(
  { name: "tmux-mcp", version },
  {
    instructions:
      "Persistent tmux-backed shell sessions. Prefer tmux_run for anything the Bash tool cannot " +
      "do: docker exec -it, ssh, REPLs, dev servers, password/y-n prompts. Sessions keep their cwd, " +
      "env and any running program between calls; use separate session names for separate contexts, " +
      "and wait_for / timeout for long-running programs (they are never killed on timeout). All " +
      "sessions are destroyed when this server exits.",
  },
);

server.registerTool(
  "tmux_run",
  {
    title: "Run a command in a tmux session",
    description:
      "Run a command in a persistent tmux-backed bash session and return its output — like Bash, but " +
      "the session keeps state between calls (cwd, env vars, and any interactive program you started). " +
      "Use it for things Bash can't do: `docker exec -it …`, `ssh …`, REPLs (python, psql, node), " +
      "dev servers, `sudo`/password prompts, `apt` y/n questions. Returns when the shell shows its " +
      "prompt again (exit code known), when an interactive program shows a prompt, when `wait_for` " +
      "matches, or after `timeout`. For long-running processes (dev servers, watchers) pass `wait_for` " +
      "or a short `timeout` — the process keeps running; use `tmux_read` for later output and " +
      "`tmux_send_keys [\"C-c\"]` to stop it. Input goes to whatever is in the foreground of that " +
      "session, so start a dev server in its own session name.",
    inputSchema: {
      command: z.string().describe("Shell command line to type into the session, followed by Enter. Multi-line input is allowed."),
      session: z.string().optional().describe('Session name (default "default"). Auto-created as a bash shell if it does not exist. Use separate names for separate contexts, e.g. "web" for a docker exec shell, "dev" for a dev server.'),
      cwd: z.string().optional().describe("Working directory for a NEWLY created session. Ignored if the session already exists."),
      timeout: z.number().int().min(1).max(600).optional().describe("Seconds to wait before returning with the process still running (default 120). The process is NOT killed on timeout."),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the new output matches it, e.g. 'localhost:\\d+' for a dev server or 'Password:' for ssh."),
      quiet_ms: z.number().int().min(100).optional().describe("Optional: also return once no output has arrived for this many milliseconds. Off by default (Bash-like waiting)."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ command, session, cwd, timeout, wait_for, quiet_ms }): Promise<ToolResult> => {
    const name = session ?? "default";
    const bad = mgr.validate(name);
    if (bad) return err(bad);
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const timeoutMs = (timeout ?? DEFAULT_TIMEOUT_S) * 1000;
    try {
      return await mgr.withLock(name, async () => {
        const { session: s, respawned } = await mgr.getOrCreate(name, cwd);
        s.lastCommand = command;
        if (command.length) {
          await tmux(["send-keys", "-t", s.paneId, "-l", "--", command]);
        }
        await tmux(["send-keys", "-t", s.paneId, "Enter"]);
        const res = await waitForResult(s, { timeoutMs, waitFor, quietMs: quiet_ms, command });
        const { body, tui } = await renderBody(s, res, command);
        return ok(formatResponse({
          session: name, status: res.status, exitCode: res.exitCode, fg: res.fg,
          body, tui, waitForSrc: wait_for, quietMs: quiet_ms, timeoutMs, respawned,
        }));
      });
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_send_keys",
  {
    title: "Send raw keys to a tmux session",
    description:
      "Send raw keys to a session: interrupt (C-c), EOF (C-d), answer a prompt, navigate a TUI. " +
      "Use tmux_run for normal command lines.",
    inputSchema: {
      session: z.string(),
      keys: z.array(z.string()).min(1).describe('tmux key names or literal text, sent in order. Key names: "Enter", "C-c", "C-d", "C-z", "Escape", "Tab", "Up", "Down", "Left", "Right", "BSpace", "Space", "PageUp", "F1".."F12". Anything else is sent as literal text (no Enter appended).'),
      timeout: z.number().int().min(0).max(600).optional().describe("Seconds to wait for the session to settle afterwards (default 30). 0 = return immediately."),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the new output matches it."),
      quiet_ms: z.number().int().min(100).optional().describe("Optional: also return once no output has arrived for this many milliseconds."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ session, keys, timeout, wait_for, quiet_ms }): Promise<ToolResult> => {
    const bad = mgr.validate(session);
    if (bad) return err(bad);
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    if (!mgr.get(session)) return err(`unknown session ${JSON.stringify(session)} — start one with tmux_run(session:${JSON.stringify(session)})`);
    const timeoutMs = (timeout ?? 30) * 1000;
    try {
      return await mgr.withLock(session, async () => {
        const { session: s, respawned } = await mgr.getOrCreate(session);
        for (const k of keys) {
          if (KEY_RE.test(k)) await tmux(["send-keys", "-t", s.paneId, k]);
          else await tmux(["send-keys", "-t", s.paneId, "-l", "--", k]);
        }
        const res = await waitForResult(s, { timeoutMs, waitFor, quietMs: quiet_ms });
        const { body, tui } = await renderBody(s, res);
        return ok(formatResponse({
          session, status: res.status, exitCode: res.exitCode, fg: res.fg,
          body, tui, waitForSrc: wait_for, quietMs: quiet_ms, timeoutMs, respawned,
          emptyText: "(no new output)",
        }));
      });
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_read",
  {
    title: "Read new output from a tmux session",
    description:
      "Read output that has arrived in a session since the last call — use it after tmux_run " +
      "returned early (timeout, wait_for, prompt) to keep following a dev server or a long build. " +
      "With screen:true it returns the currently rendered screen instead, which is what you want " +
      "for TUIs and progress bars.",
    inputSchema: {
      session: z.string(),
      wait_for: z.string().optional().describe("Regex; wait until new output matches it (default timeout 60 s when set)."),
      timeout: z.number().int().min(0).max(600).optional().describe("Seconds to wait for new output/wait_for. Default 0 = return whatever is new right now."),
      screen: z.boolean().optional().describe("Return the currently rendered screen (what a human would see) instead of the new-output stream. Use for TUIs/progress bars. Does not consume the stream."),
      quiet_ms: z.number().int().min(100).optional().describe("Optional: return once no output has arrived for this many milliseconds."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ session, wait_for, timeout, screen, quiet_ms }): Promise<ToolResult> => {
    const bad = mgr.validate(session);
    if (bad) return err(bad);
    const s = mgr.get(session);
    if (!s) return err(`unknown session ${JSON.stringify(session)} — start one with tmux_run(session:${JSON.stringify(session)})`);
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    try {
      if (screen) {
        const info = await paneInfo(s.paneId).catch(() => null);
        const snap = trimTrailingBlank(await capturePane(s.paneId));
        return ok(
          (snap.length ? truncate(snap) : "(empty screen)") +
          `\n[screen of session "${session}" — fg: ${info?.fg ?? "?"}]`,
        );
      }
      const timeoutMs = (timeout ?? (wait_for !== undefined ? 60 : 0)) * 1000;
      return await mgr.withLock(session, async () => {
        const res = await waitForResult(s, { timeoutMs, waitFor, quietMs: quiet_ms });
        const { body, tui } = await renderBody(s, res);
        return ok(formatResponse({
          session, status: res.status, exitCode: res.exitCode, fg: res.fg,
          body, tui, waitForSrc: wait_for, quietMs: quiet_ms, timeoutMs,
          emptyText: "(no new output)",
        }));
      });
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_list",
  {
    title: "List tmux sessions",
    description:
      "List the live tmux sessions of this server with their foreground process, state, cwd and " +
      "how much unread output is buffered.",
    annotations: { readOnlyHint: true },
  },
  async (): Promise<ToolResult> => {
    try {
      const sessions = mgr.all();
      if (!sessions.length) return ok("(no sessions — tmux_run creates one)");
      const lines: string[] = [];
      for (const s of sessions) {
        let state = "unknown";
        let fg = "?";
        let cwd = "?";
        try {
          const info = await paneInfo(s.paneId);
          fg = info.fg;
          cwd = info.cwd;
          state = info.dead
            ? `dead(code ${info.deadStatus ?? 0})`
            : info.fg === "bash" && s.idle
              ? "idle"
              : `running(${info.fg})`;
        } catch {
          state = "gone";
        }
        lines.push(
          `${s.name}  fg=${fg}  ${state}  cwd=${cwd}  created ${ago(Date.now() - s.createdAt)}  unread=${mgr.unread(s)}B`,
        );
      }
      return ok(lines.join("\n"));
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_kill",
  {
    title: "Kill a tmux session",
    description:
      "Kill a session and everything running in it. Sessions are also all destroyed automatically " +
      "when this MCP server exits, so this is only needed to free a name or stop a runaway process.",
    inputSchema: { session: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ session }): Promise<ToolResult> => {
    const bad = mgr.validate(session);
    if (bad) return err(bad);
    if (!mgr.get(session)) return err(`unknown session ${JSON.stringify(session)}`);
    try {
      await mgr.kill(session);
      return ok(`[killed session "${session}"]`);
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

// ---- lifecycle ------------------------------------------------------------

let exiting = false;
function shutdown(code: number, why: string): void {
  if (exiting) return;
  exiting = true;
  log(`shutting down (${why})`);
  cleanupSync();
  process.exit(code);
}

process.on("exit", () => cleanupSync());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => shutdown(0, sig));
}
process.on("uncaughtException", (e) => {
  log(`uncaught exception: ${e?.stack ?? String(e)}`);
  shutdown(1, "uncaughtException");
});
process.on("unhandledRejection", (e) => {
  log(`unhandled rejection: ${e instanceof Error ? e.stack : String(e)}`);
});
process.stdin.on("end", () => shutdown(0, "stdin end"));
process.stdin.on("close", () => shutdown(0, "stdin close"));

const transport = new StdioServerTransport();
await server.connect(transport);
log(`tmux-mcp ${version} ready socket=${SOCKET} pid=${process.pid}`);
