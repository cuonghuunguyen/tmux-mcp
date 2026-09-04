#!/usr/bin/env node
import * as fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  IDLE_TIMEOUT_S, MAX_TIMEOUT_S, SOCKET, capturePane, cleanupSync, log, paneInfo, tmux,
} from "./tmux.js";
import { SessionManager, type Session } from "./sessions.js";
import { waitForResult, type WaitResult } from "./wait.js";
import { isTui, postProcess, trimTrailingBlank, truncate } from "./ansi.js";
import { formatResponse, type ToolNames } from "./format.js";
import {
  KEY_RE, NoServerError, capture, inferKind, killTarget, listTree, newSession, newWindow,
  paneBaseOf, runInPane, sendKeys, splitPane, userPaneInfo, userServerLabel, waitInPane,
  waitPaneReady, type PaneRunResult, type PaneWaitOpts, type TargetKind,
} from "./panes.js";

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

/**
 * `timeout` is an IDLE timeout (seconds without new output); `max_timeout` is the
 * hard cap on the whole call. An explicit idle timeout of 0 means "return with
 * whatever is there right now", so the cap is switched off as well.
 */
function waitWindow(timeout: number | undefined, maxTimeout: number | undefined, dfltIdleS: number) {
  const idleMs = Math.round((timeout ?? dfltIdleS) * 1000);
  const maxMs = idleMs <= 0 ? 0 : Math.round((maxTimeout ?? MAX_TIMEOUT_S) * 1000);
  return { idleMs, maxMs };
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

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m ago`;
}

// ---- user-server helpers ---------------------------------------------------

const PANE_TOOLS: ToolNames = {
  run: "tmux_pane_exec",
  keys: "tmux_pane_send_keys",
  read: "tmux_pane_capture",
};

/** Render a runInPane/waitInPane result the same way tmux_run renders its own. */
function paneResponse(
  res: PaneRunResult,
  o: { idleMs: number; maxMs: number; waitForSrc?: string; emptyText?: string },
): string {
  return formatResponse({
    session: res.paneId,
    label: `pane ${res.paneId}`,
    ref: `target:${JSON.stringify(res.paneId)}`,
    tools: PANE_TOOLS,
    respawns: false,
    status: res.status,
    exitCode: res.exitCode,
    fg: res.fg,
    body: truncate(res.body),
    tui: res.tui,
    waitForSrc: o.waitForSrc,
    idleMs: o.idleMs,
    maxMs: o.maxMs,
    emptyText: o.emptyText,
  });
}

/** Run `command` in a pane we just created, if one was given. */
async function maybeRun(
  paneId: string,
  command: string | undefined,
  opts: PaneWaitOpts,
  waitForSrc?: string,
): Promise<string> {
  if (command === undefined || command === "") return "";
  await waitPaneReady(paneId);
  const res = await runInPane(paneId, command, opts);
  return "\n" + paneResponse(res, { idleMs: opts.idleMs, maxMs: opts.maxMs, waitForSrc });
}

/** One definition of "idle", reused by every tool. */
const IDLE_DEF =
  "IDLE timeout, in seconds. Idle = the pane has produced NO new output for this long while the " +
  "command is still running; every byte of output (including progress-bar redraws) restarts the clock, " +
  "so a chatty build never trips it and a quiet dev server trips it right after its banner. It is NOT " +
  "a total time limit (see max_timeout), and a command that finishes returns immediately with its exit " +
  "code regardless. The process is NEVER killed on idle.";
const timeoutParam = (dflt: number) =>
  z.number().min(0.1).max(3600).optional().describe(`${IDLE_DEF} Default ${dflt}; fractions allowed (0.5).`);
const maxTimeoutParam = z.number().min(0.5).max(3600).optional().describe(
  `Hard cap on the whole call, in seconds (default ${MAX_TIMEOUT_S}). Reached only while output keeps flowing; the process is not killed.`,
);
const targetParam = z.string().describe(
  'tmux target on your own server: pane id "%3", window id "@2", "session:window.pane", or a bare session name (its active pane). Get ids from tmux_ls.',
);

// ---- server ----------------------------------------------------------------

const server = new McpServer(
  { name: "tmux-mcp", version },
  {
    instructions:
      "Two families of tools. (1) Agent-private sessions — tmux_run / tmux_send_keys / tmux_read / " +
      "tmux_list / tmux_kill — live on a tmux server owned by this process and are destroyed when it " +
      "exits; use them as a stateful Bash for anything the Bash tool cannot do: docker exec -it, ssh, " +
      "REPLs, dev servers, password/y-n prompts. (2) The user's own tmux server — tmux_ls, " +
      "tmux_pane_capture, tmux_pane_exec, tmux_pane_send_keys, tmux_new_session, tmux_new_window, " +
      "tmux_split_pane, tmux_kill_target — inspect and drive the sessions the user can watch with " +
      "`tmux attach`; they outlive this server and are never killed by it. `timeout` is an IDLE timeout: " +
      "seconds with no new output while the process is still running, the clock restarting on every byte; " +
      "`max_timeout` is the hard cap on the whole call. Nothing is ever killed on either.",
  },
);

// ---- private sessions ------------------------------------------------------

server.registerTool(
  "tmux_run",
  {
    title: "Run a command in an agent-private tmux session",
    description:
      "Run a command in a persistent tmux-backed bash session and return its output — like Bash, but " +
      "the session keeps state between calls (cwd, env vars, and any interactive program you started). " +
      "Use it for things Bash can't do: `docker exec -it …`, `ssh …`, REPLs (python, psql, node), " +
      "dev servers, `sudo`/password prompts, `apt` y/n questions. Returns when the shell shows its " +
      "prompt again (exit code known), when an interactive program shows a prompt, when `wait_for` " +
      "matches, after `timeout` seconds of silence, or at the `max_timeout` hard cap. The process is " +
      "never killed: use `tmux_read` for later output and `tmux_send_keys [\"C-c\"]` to stop it. Input " +
      "goes to whatever is in the foreground of that session, so start a dev server in its own session " +
      "name. These sessions are private to this MCP process — to work in the user's own tmux, use " +
      "tmux_new_session / tmux_pane_exec.",
    inputSchema: {
      command: z.string().describe("Shell command line to type into the session, followed by Enter. Multi-line input is allowed."),
      session: z.string().optional().describe('Session name (default "default"). Auto-created as a bash shell if it does not exist. Use separate names for separate contexts, e.g. "web" for a docker exec shell, "dev" for a dev server.'),
      cwd: z.string().optional().describe("Working directory for a NEWLY created session. Ignored if the session already exists."),
      timeout: timeoutParam(IDLE_TIMEOUT_S),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the new output matches it, e.g. 'localhost:\\d+' for a dev server or 'Password:' for ssh."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ command, session, cwd, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    const name = session ?? "default";
    const bad = mgr.validate(name);
    if (bad) return err(bad);
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, IDLE_TIMEOUT_S);
    try {
      return await mgr.withLock(name, async () => {
        const { session: s, respawned } = await mgr.getOrCreate(name, cwd);
        s.lastCommand = command;
        if (command.length) {
          await tmux(["send-keys", "-t", s.paneId, "-l", "--", command]);
        }
        await tmux(["send-keys", "-t", s.paneId, "Enter"]);
        const res = await waitForResult(s, { idleMs, maxMs, waitFor, command });
        const { body, tui } = await renderBody(s, res, command);
        return ok(formatResponse({
          session: name, status: res.status, exitCode: res.exitCode, fg: res.fg,
          body, tui, waitForSrc: wait_for, idleMs, maxMs, respawned,
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
    title: "Send raw keys to an agent-private tmux session",
    description:
      "Send raw keys to a session created by tmux_run: interrupt (C-c), EOF (C-d), answer a prompt, " +
      "navigate a TUI. Use tmux_run for normal command lines, tmux_pane_send_keys for panes on the " +
      "user's own tmux server.",
    inputSchema: {
      session: z.string(),
      keys: z.array(z.string()).min(1).describe('tmux key names or literal text, sent in order. Key names: "Enter", "C-c", "C-d", "C-z", "Escape", "Tab", "Up", "Down", "Left", "Right", "BSpace", "Space", "PageUp", "F1".."F12". Anything else is sent as literal text (no Enter appended).'),
      timeout: z.number().min(0).max(3600).optional().describe(`${IDLE_DEF} Default 5. 0 = return immediately with whatever is there.`),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the new output matches it."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ session, keys, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    const bad = mgr.validate(session);
    if (bad) return err(bad);
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    if (!mgr.get(session)) return err(`unknown session ${JSON.stringify(session)} — start one with tmux_run(session:${JSON.stringify(session)})`);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, 5);
    try {
      return await mgr.withLock(session, async () => {
        const { session: s, respawned } = await mgr.getOrCreate(session);
        for (const k of keys) {
          if (KEY_RE.test(k)) await tmux(["send-keys", "-t", s.paneId, k]);
          else await tmux(["send-keys", "-t", s.paneId, "-l", "--", k]);
        }
        const res = await waitForResult(s, { idleMs, maxMs, waitFor });
        const { body, tui } = await renderBody(s, res);
        return ok(formatResponse({
          session, status: res.status, exitCode: res.exitCode, fg: res.fg,
          body, tui, waitForSrc: wait_for, idleMs, maxMs, respawned,
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
    title: "Read new output from an agent-private tmux session",
    description:
      "Read output that has arrived in a session since the last call — use it after tmux_run " +
      "returned early (idle timeout, hard cap, wait_for, prompt) to keep following a dev server or a " +
      "long build. With screen:true it returns the currently rendered screen instead, which is what " +
      "you want for TUIs and progress bars.",
    inputSchema: {
      session: z.string(),
      wait_for: z.string().optional().describe("Regex; wait until new output matches it (default timeout 60 s when set)."),
      timeout: z.number().min(0).max(3600).optional().describe(`${IDLE_DEF} Default 0 = return whatever is new right now (60 when wait_for is set).`),
      screen: z.boolean().optional().describe("Return the currently rendered screen (what a human would see) instead of the new-output stream. Use for TUIs/progress bars. Does not consume the stream."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ session, wait_for, timeout, screen, max_timeout }): Promise<ToolResult> => {
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
      const { idleMs, maxMs } = waitWindow(timeout, max_timeout, wait_for !== undefined ? 60 : 0);
      return await mgr.withLock(session, async () => {
        const res = await waitForResult(s, { idleMs, maxMs, waitFor });
        const { body, tui } = await renderBody(s, res);
        return ok(formatResponse({
          session, status: res.status, exitCode: res.exitCode, fg: res.fg,
          body, tui, waitForSrc: wait_for, idleMs, maxMs,
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
    title: "List agent-private tmux sessions",
    description:
      "List the agent-private sessions created by tmux_run, with their foreground process, state, cwd " +
      "and how much unread output is buffered. For your own tmux server use tmux_ls / tmux_kill_target.",
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
    title: "Kill an agent-private tmux session",
    description:
      "Kill an agent-private session created by tmux_run and everything running in it. These sessions " +
      "are also all destroyed automatically when this MCP server exits, so this is only needed to free " +
      "a name or stop a runaway process. For your own tmux server use tmux_kill_target.",
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

// ---- the user's own tmux server --------------------------------------------

server.registerTool(
  "tmux_ls",
  {
    title: "List the user's tmux sessions, windows and panes",
    description:
      "Show the tree of sessions → windows → panes on the USER's own tmux server (the one they can " +
      "`tmux attach` to), with each pane's id, foreground process, cwd and size. Pane ids (%N) from " +
      "here are the targets for tmux_pane_exec, tmux_pane_capture, tmux_pane_send_keys, " +
      "tmux_split_pane and tmux_kill_target. These sessions are never touched when this server exits.",
    inputSchema: {
      session: z.string().optional().describe("Only show this session."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ session }): Promise<ToolResult> => {
    try {
      return ok(await listTree(session));
    } catch (e) {
      if (e instanceof NoServerError) {
        return ok(
          `(no tmux server running on ${userServerLabel()} — tmux_new_session starts one; ` +
          "tmux_run gives you an agent-private session instead)",
        );
      }
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_pane_capture",
  {
    title: "Capture a pane on the user's tmux server",
    description:
      "Return what a pane on the user's tmux server currently shows, optionally with scrollback. " +
      "Read-only: it does not send anything to the pane, so it is safe on a pane running a TUI, a " +
      "dev server or somebody's editor.",
    inputSchema: {
      target: targetParam,
      lines: z.number().int().min(1).max(100000).optional().describe("Also include this many lines of scrollback above the visible screen."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ target, lines }): Promise<ToolResult> => {
    try {
      const info = await userPaneInfo(target);
      const text = trimTrailingBlank(await capture(info.paneId, lines));
      return ok(
        (text.length ? truncate(text) : "(empty pane)") +
        `\n[pane ${info.paneId} in ${info.session}:${info.windowIndex} — fg: ${info.fg}, ` +
        `${info.historySize} lines of scrollback]`,
      );
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_pane_exec",
  {
    title: "Run a command in a pane on the user's tmux server",
    description:
      "Type a command line into an existing pane on the USER's tmux server and return its output. " +
      "When the pane sits at a plain shell prompt the exit code is reported exactly; when something " +
      "else has the foreground (ssh, a REPL, a container shell) the line is typed as-is and the call " +
      "returns on `wait_for`, an interactive prompt, the idle timeout or the hard cap. The process is " +
      "never killed — keep reading with tmux_pane_capture, stop it with tmux_pane_send_keys [\"C-c\"]. " +
      "Whatever you run here is visible to the user in their own terminal.",
    inputSchema: {
      target: targetParam,
      command: z.string().describe("Shell command line to type into the pane, followed by Enter."),
      timeout: timeoutParam(IDLE_TIMEOUT_S),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the new output matches it."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ target, command, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, IDLE_TIMEOUT_S);
    try {
      const res = await runInPane(target, command, { idleMs, maxMs, waitFor });
      return ok(paneResponse(res, { idleMs, maxMs, waitForSrc: wait_for }));
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_pane_send_keys",
  {
    title: "Send raw keys to a pane on the user's tmux server",
    description:
      "Send raw keys to a pane on the USER's tmux server: interrupt (C-c), EOF (C-d), answer a y/n or " +
      "password prompt, drive a TUI. Use tmux_pane_exec for normal command lines.",
    inputSchema: {
      target: targetParam,
      keys: z.array(z.string()).min(1).describe('tmux key names or literal text, sent in order. Key names: "Enter", "C-c", "C-d", "C-z", "Escape", "Tab", "Up", "Down", "Left", "Right", "BSpace", "Space", "PageUp", "F1".."F12". Anything else is sent as literal text (no Enter appended).'),
      timeout: z.number().min(0).max(3600).optional().describe(`${IDLE_DEF} Default 5. 0 = return immediately with whatever is there.`),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the new output matches it."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ target, keys, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, 5);
    try {
      const { paneId, base } = await paneBaseOf(target);
      await sendKeys(paneId, keys);
      const res = await waitInPane(paneId, base, { idleMs, maxMs, waitFor });
      return ok(paneResponse(res, { idleMs, maxMs, waitForSrc: wait_for, emptyText: "(no new output)" }));
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_new_session",
  {
    title: "Create a session on the user's tmux server",
    description:
      "Create a new session on the USER's own tmux server (starting that server if it is not running " +
      "yet) and optionally run a command in it — one call. The session outlives this MCP server and " +
      "the user can watch it with `tmux attach -t <name>`, which makes it the right place for work " +
      "the user should see. For throwaway work that must not survive, use tmux_run instead.",
    inputSchema: {
      name: z.string().describe("Session name. Must not be empty and must not contain '.' or ':'."),
      cwd: z.string().optional().describe("Working directory for the session's first pane."),
      window_name: z.string().optional().describe("Name for the first window."),
      command: z.string().optional().describe("Command line to run in the new session's pane once its shell is ready."),
      timeout: timeoutParam(IDLE_TIMEOUT_S),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the command's output matches it."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ name, cwd, window_name, command, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    if (!name.length) return err("session name must not be empty");
    if (name.includes(".") || name.includes(":")) {
      return err(`invalid session name ${JSON.stringify(name)} — tmux does not allow '.' or ':' in session names`);
    }
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, IDLE_TIMEOUT_S);
    try {
      const { session, paneId } = await newSession(name, cwd, window_name);
      const head =
        `[created session "${session}" on the user's tmux server — pane ${paneId}; ` +
        `attach with: tmux attach -t ${session}]`;
      return ok(head + await maybeRun(paneId, command, { idleMs, maxMs, waitFor }, wait_for));
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_new_window",
  {
    title: "Create a window in a session on the user's tmux server",
    description:
      "Add a window to an existing session on the USER's tmux server and optionally run a command in " +
      "it. Created in the background unless select is true.",
    inputSchema: {
      session: z.string().describe("Session to add the window to."),
      name: z.string().optional().describe("Window name."),
      cwd: z.string().optional().describe("Working directory for the new window's pane."),
      select: z.boolean().optional().describe("Make it the session's current window (default false — the user's view is left alone)."),
      command: z.string().optional().describe("Command line to run in the new pane once its shell is ready."),
      timeout: timeoutParam(IDLE_TIMEOUT_S),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the command's output matches it."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ session, name, cwd, select, command, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, IDLE_TIMEOUT_S);
    try {
      const w = await newWindow(session, name, cwd, select ?? false);
      const head = `[created window ${w.windowId} (${session}:${w.index} "${w.name}") — pane ${w.paneId}]`;
      return ok(head + await maybeRun(w.paneId, command, { idleMs, maxMs, waitFor }, wait_for));
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_split_pane",
  {
    title: "Split a pane on the user's tmux server",
    description:
      "Split an existing pane on the USER's tmux server and optionally run a command in the new half " +
      "— useful for putting a dev server next to a shell the user is watching.",
    inputSchema: {
      target: targetParam,
      direction: z.enum(["below", "right"]).optional().describe('Where the new pane goes (default "below").'),
      size: z.number().int().min(5).max(95).optional().describe("Size of the new pane as a percentage of the old one."),
      cwd: z.string().optional().describe("Working directory for the new pane."),
      select: z.boolean().optional().describe("Make the new pane active (default false)."),
      command: z.string().optional().describe("Command line to run in the new pane once its shell is ready."),
      timeout: timeoutParam(IDLE_TIMEOUT_S),
      wait_for: z.string().optional().describe("Regex (JS syntax, multiline). Return as soon as the command's output matches it."),
      max_timeout: maxTimeoutParam,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ target, direction, size, cwd, select, command, timeout, wait_for, max_timeout }): Promise<ToolResult> => {
    const waitFor = compileWaitFor(wait_for);
    if (waitFor instanceof Error) return err(waitFor.message);
    const { idleMs, maxMs } = waitWindow(timeout, max_timeout, IDLE_TIMEOUT_S);
    const dir = direction ?? "below";
    try {
      const old = await userPaneInfo(target);
      const { paneId } = await splitPane(old.paneId, dir, size, cwd, select ?? false);
      const head = `[split pane ${old.paneId} → new pane ${paneId} (${dir})]`;
      return ok(head + await maybeRun(paneId, command, { idleMs, maxMs, waitFor }, wait_for));
    } catch (e) {
      return err(msgOf(e));
    }
  },
);

server.registerTool(
  "tmux_kill_target",
  {
    title: "Kill a pane, window or session on the user's tmux server",
    description:
      "Kill a pane, window or session on the USER's own tmux server. The kind is inferred from the " +
      "target ('%3' → pane, '@2' → window, a bare name → session) unless you say otherwise. This is " +
      "the only way anything on the user's server is destroyed — server shutdown never touches it.",
    inputSchema: {
      target: targetParam,
      kind: z.enum(["pane", "window", "session"]).optional().describe("Override what to kill; inferred from the target by default."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ target, kind }): Promise<ToolResult> => {
    const k: TargetKind = kind ?? inferKind(target);
    try {
      await killTarget(target, k);
      return ok(`[killed ${k} ${target}]`);
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
