/**
 * Core tmux operations against the USER's tmux server (default socket, or
 * whatever $TMUX / TMUX_MCP_USER_SOCKET points at) — as opposed to the private
 * per-process server that backs tmux_run sessions.
 *
 * Nothing here is ever killed on shutdown: those sessions belong to the user.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PANE_H, PANE_W, PROMPT_SETTLE_MS, TMUX_BIN, TmuxError } from "./tmux.js";
import { PROMPT_RE, type WaitStatus } from "./wait.js";
import { isCommandEcho, stripEcho, trimTrailingBlank } from "./ansi.js";

const pexecFile = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const USER_SOCKET = process.env.TMUX_MCP_USER_SOCKET || "";
const USER_SOCKET_PATH = process.env.TMUX_MCP_USER_SOCKET_PATH || "";

export function userServerLabel(): string {
  if (USER_SOCKET_PATH) return USER_SOCKET_PATH;
  if (USER_SOCKET) return `-L ${USER_SOCKET}`;
  if (process.env.TMUX) return process.env.TMUX.split(",")[0];
  return "default socket";
}

function socketArgs(): string[] {
  if (USER_SOCKET_PATH) return ["-S", USER_SOCKET_PATH];
  if (USER_SOCKET) return ["-L", USER_SOCKET];
  return []; // honours $TMUX when we run inside tmux, else the default socket
}

export class NoServerError extends TmuxError {}

/** Run tmux against the user's server. */
export async function userTmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await pexecFile(TMUX_BIN, [...socketArgs(), ...args], {
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      throw new TmuxError(`tmux binary "${TMUX_BIN}" not found — install tmux (apt install tmux)`);
    }
    const se = (err?.stderr ?? "").toString().trim();
    if (/no server running|error connecting to/.test(se)) {
      throw new NoServerError(
        `no tmux server is running on ${userServerLabel()} — tmux_new_session starts one, ` +
        "or use tmux_run for an agent-private session",
      );
    }
    throw new TmuxError(`tmux ${args.join(" ")} failed: ${se || err?.message || String(err)}`);
  }
}

export const KEY_RE =
  /^(C-|M-|S-)*(.|Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|IC|DC|F\d{1,2})$/;

export async function sendKeys(target: string, keys: string[]): Promise<void> {
  for (const k of keys) {
    if (KEY_RE.test(k)) await userTmux(["send-keys", "-t", target, k]);
    else await userTmux(["send-keys", "-t", target, "-l", "--", k]);
  }
}

// ---- listing ---------------------------------------------------------------

interface PaneRow {
  session: string;
  attached: boolean;
  windowId: string;
  windowIndex: string;
  windowName: string;
  windowActive: boolean;
  paneId: string;
  paneIndex: string;
  paneActive: boolean;
  fg: string;
  cwd: string;
  w: string;
  h: string;
  title: string;
}

const SEP = "";
const LIST_FORMAT = [
  "#{session_name}", "#{session_attached}", "#{window_id}", "#{window_index}", "#{window_name}",
  "#{window_active}", "#{pane_id}", "#{pane_index}", "#{pane_active}", "#{pane_current_command}",
  "#{pane_current_path}", "#{pane_width}", "#{pane_height}", "#{pane_title}",
].join(SEP);

export async function listTree(sessionFilter?: string): Promise<string> {
  const args = sessionFilter
    ? ["list-panes", "-s", "-t", `=${sessionFilter}`, "-F", LIST_FORMAT]
    : ["list-panes", "-a", "-F", LIST_FORMAT];
  const out = await userTmux(args);
  const rows: PaneRow[] = out
    .split("\n")
    .filter((l) => l.length)
    .map((l) => {
      const p = l.split(SEP);
      return {
        session: p[0], attached: p[1] !== "0", windowId: p[2], windowIndex: p[3], windowName: p[4],
        windowActive: p[5] === "1", paneId: p[6], paneIndex: p[7], paneActive: p[8] === "1",
        fg: p[9], cwd: p[10], w: p[11], h: p[12], title: p[13] ?? "",
      };
    });
  if (!rows.length) return `(no sessions on ${userServerLabel()})`;

  const lines: string[] = [];
  let curSession = "";
  let curWindow = "";
  for (const r of rows) {
    if (r.session !== curSession) {
      curSession = r.session;
      curWindow = "";
      const n = new Set(rows.filter((x) => x.session === r.session).map((x) => x.windowId)).size;
      lines.push(`session ${r.session}  (${n} window${n === 1 ? "" : "s"}${r.attached ? ", attached" : ""})`);
    }
    if (r.windowId !== curWindow) {
      curWindow = r.windowId;
      lines.push(`  window ${r.windowId}  ${r.session}:${r.windowIndex} "${r.windowName}"${r.windowActive ? "  (current)" : ""}`);
    }
    const title = r.title && r.title !== r.fg && !/^[\w.-]+@[\w.-]+:/.test(r.title) ? `  title="${r.title}"` : "";
    lines.push(
      `    pane ${r.paneId}${r.paneActive ? "*" : " "} ${r.session}:${r.windowIndex}.${r.paneIndex}  fg=${r.fg}  cwd=${r.cwd}  ${r.w}x${r.h}${title}`,
    );
  }
  lines.push(`(tmux server: ${userServerLabel()}; address panes by id, e.g. target:"${rows[0].paneId}")`);
  return lines.join("\n");
}

// ---- pane state ------------------------------------------------------------

export interface UserPaneInfo {
  paneId: string;
  session: string;
  windowIndex: string;
  historySize: number;
  cursorY: number;
  fg: string;
  alternate: boolean;
  dead: boolean;
  deadStatus: number | null;
  cwd: string;
}

const INFO_FORMAT = [
  "#{pane_id}", "#{session_name}", "#{window_index}", "#{history_size}", "#{cursor_y}",
  "#{pane_current_command}", "#{alternate_on}", "#{pane_dead}", "#{pane_dead_status}", "#{pane_current_path}",
].join(SEP);

export async function userPaneInfo(target: string): Promise<UserPaneInfo> {
  const out = (await userTmux(["display-message", "-p", "-t", target, INFO_FORMAT])).replace(/\n$/, "");
  const p = out.split(SEP);
  if (p.length < 10 || !p[0].startsWith("%")) {
    throw new TmuxError(`cannot resolve target ${JSON.stringify(target)} to a pane`);
  }
  return {
    paneId: p[0], session: p[1], windowIndex: p[2],
    historySize: Number(p[3]) || 0, cursorY: Number(p[4]) || 0,
    fg: p[5], alternate: p[6] === "1", dead: p[7] === "1",
    deadStatus: p[8] === "" ? null : Number(p[8]), cwd: p[9],
  };
}

/** Rendered pane, optionally with `lines` lines of scrollback above it. Wrapped lines are joined. */
export async function capture(target: string, lines?: number): Promise<string> {
  const args = ["capture-pane", "-p", "-J", "-t", target];
  if (lines && lines > 0) args.push("-S", `-${lines}`);
  return await userTmux(args);
}

/** Everything from absolute line `base` (see paneBase) to the bottom of the visible pane. */
async function captureFrom(target: string, base: number, info: UserPaneInfo): Promise<string> {
  const start = Math.max(base - info.historySize, -info.historySize);
  return await userTmux(["capture-pane", "-p", "-J", "-t", target, "-S", String(start)]);
}

/** Absolute index of the cursor line: stays valid as output scrolls into history. */
function paneBase(info: UserPaneInfo): number {
  return info.historySize + info.cursorY;
}

// ---- exec / wait -----------------------------------------------------------

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "ash", "ksh", "mksh", "fish"]);

/** Lines our exit-code sentinel produces — never shown to the agent. */
const SENTINEL_LINE_RE = /^__mcp:\d+:[0-9a-z]{4,10}\s*$/;

export interface PaneWaitOpts {
  /** Return once the pane has produced no new output for this long. <= 0 disables. */
  idleMs: number;
  /** Hard cap on the total wait. <= 0 disables. Both <= 0 means "return immediately". */
  maxMs: number;
  waitFor?: RegExp;
  pollMs?: number;
}

export interface PaneRunResult {
  status: WaitStatus;
  exitCode?: number;
  /** Cleaned output (echo and sentinel removed) or, when tui, the screen. */
  body: string;
  tui: boolean;
  fg: string;
  /** True when the command was typed into a plain shell and an exit code could be tracked. */
  tracked: boolean;
  paneId: string;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

/**
 * Wait until a freshly created pane's shell has printed its first prompt, so the
 * command we are about to type is not swallowed or double-echoed by the tty.
 */
export async function waitPaneReady(paneId: string, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let prev: string | null = null;
  let stableSince = Date.now();
  for (;;) {
    const info = await userPaneInfo(paneId).catch(() => null);
    if (info && !info.dead && SHELLS.has(info.fg)) {
      const text = trimTrailingBlank(await capture(paneId).catch(() => ""));
      if (text !== prev) {
        prev = text;
        stableSince = Date.now();
      }
      const last = text.split("\n").pop() ?? "";
      if (text !== "" && PROMPT_RE.test(last) && Date.now() - stableSince >= 120) return;
    }
    if (Date.now() >= deadline) return;
    await sleep(60);
  }
}

/**
 * Type a command line into a pane on the user's server and wait for it, Bash-style.
 * When the pane's foreground process is a plain shell, an exit-code sentinel is chained
 * after the command; otherwise (ssh, a REPL, ...) the line is sent as-is and we rely on
 * wait_for / the prompt heuristic / the idle timeout / the hard cap.
 */
export async function runInPane(target: string, command: string, opts: PaneWaitOpts): Promise<PaneRunResult> {
  const info = await userPaneInfo(target);
  if (info.dead) {
    throw new TmuxError(`pane ${info.paneId} is dead (its process exited with code ${info.deadStatus ?? 0}) — respawn or kill it`);
  }
  const tracked = SHELLS.has(info.fg);
  const id = newId();
  let line = command;
  if (tracked) {
    const status = info.fg === "fish" ? "$status" : '"$?"';
    // `cmd &` already terminates the command; anything else needs a separator.
    const sep = /(?:^|[^&])&\s*$/.test(command.split("\n").pop() ?? "") ? " " : "; ";
    line = `${command}${sep}printf '\\n__mcp:%s:${id}\\n' ${status}`;
  }
  const base = paneBase(info);
  if (line.length) await userTmux(["send-keys", "-t", info.paneId, "-l", "--", line]);
  await userTmux(["send-keys", "-t", info.paneId, "Enter"]);
  return await waitInPane(info.paneId, base, opts, { command, sentinelId: tracked ? id : undefined });
}

/** Absolute line the output of the next command starts at — call before sending keys. */
export async function paneBaseOf(target: string): Promise<{ paneId: string; base: number; info: UserPaneInfo }> {
  const info = await userPaneInfo(target);
  return { paneId: info.paneId, base: paneBase(info), info };
}

export async function waitInPane(
  paneId: string,
  base: number,
  opts: PaneWaitOpts,
  ctx: { command?: string; sentinelId?: string } = {},
): Promise<PaneRunResult> {
  const pollMs = opts.pollMs ?? 150;
  const startedAt = Date.now();
  let lastChangeAt = startedAt;
  let prevText: string | null = null;
  let info: UserPaneInfo | null = null;
  const sentinelRe = ctx.sentinelId ? new RegExp(`^__mcp:(\\d+):${ctx.sentinelId}\\s*$`, "m") : null;

  const clean = (text: string): string => {
    let t = text;
    if (ctx.sentinelId) {
      // echo: the first line carrying the sentinel id that is not itself a sentinel
      // line is the command we typed — drop it and everything before it.
      const lines = t.split("\n");
      const echoIdx = lines.findIndex((l) => l.includes(ctx.sentinelId!) && !SENTINEL_LINE_RE.test(l));
      if (echoIdx >= 0) t = lines.slice(echoIdx + 1).join("\n");
    } else if (ctx.command !== undefined) {
      t = stripEcho(t, ctx.command);
    }
    if (sentinelRe) {
      // the sentinel line and everything after it (the next prompt) are ours, not output
      t = t.replace(new RegExp(`^__mcp:\\d+:${ctx.sentinelId}\\s*$[\\s\\S]*`, "m"), "");
    }
    // stale sentinels from an earlier command in the same pane
    t = t.split("\n").filter((l) => !SENTINEL_LINE_RE.test(l)).join("\n");
    return trimTrailingBlank(t.replace(/^\n+/, ""));
  };

  const result = (status: WaitStatus, text: string, extra: Partial<PaneRunResult> = {}): PaneRunResult => ({
    status,
    body: clean(text),
    tui: false,
    fg: info?.fg ?? "",
    tracked: !!ctx.sentinelId,
    paneId,
    ...extra,
  });

  for (;;) {
    try {
      info = await userPaneInfo(paneId);
    } catch {
      // pane vanished: the shell exited and remain-on-exit is off on the user's server
      return {
        status: "shell_exited",
        body: prevText === null ? "" : clean(prevText),
        tui: false,
        fg: info?.fg ?? "",
        tracked: !!ctx.sentinelId,
        paneId,
      };
    }
    if (info.dead) {
      const text = await captureFrom(paneId, base, info).catch(() => prevText ?? "");
      return result("shell_exited", text, { exitCode: info.deadStatus ?? undefined });
    }
    if (info.alternate) {
      // full-screen program: hand back the screen instead of a stream
      const screen = trimTrailingBlank(await capture(paneId));
      return { status: "prompt", body: screen, tui: true, fg: info.fg, tracked: !!ctx.sentinelId, paneId };
    }

    const text = await captureFrom(paneId, base, info);
    if (text !== prevText) {
      prevText = text;
      lastChangeAt = Date.now();
    }

    if (sentinelRe) {
      const m = sentinelRe.exec(text);
      if (m) return result("exited", text, { exitCode: Number(m[1]) });
    }

    if (opts.waitFor) {
      opts.waitFor.lastIndex = 0;
      if (opts.waitFor.test(clean(text))) return result("matched", text);
    }

    if (opts.idleMs <= 0 && opts.maxMs <= 0) return result("immediate", text);

    const silentFor = Date.now() - lastChangeAt;
    if (silentFor >= PROMPT_SETTLE_MS) {
      const last = trimTrailingBlank(text).split("\n").pop() ?? "";
      if (last.trim() !== "" && PROMPT_RE.test(last) && !isCommandEcho(last, ctx.command)) {
        return result("prompt", text);
      }
    }
    if (opts.idleMs > 0 && silentFor >= opts.idleMs) return result("idle", text);
    if (opts.maxMs > 0 && Date.now() - startedAt >= opts.maxMs) return result("timeout", text);
    await sleep(pollMs);
  }
}

// ---- create / kill ---------------------------------------------------------

export async function newSession(name: string, cwd?: string, windowName?: string): Promise<{ session: string; paneId: string }> {
  const args = ["new-session", "-d", "-P", "-F", `#{session_name}${SEP}#{pane_id}`, "-s", name, "-x", PANE_W, "-y", PANE_H];
  if (cwd) args.push("-c", cwd);
  if (windowName) args.push("-n", windowName);
  const [session, paneId] = (await userTmux(args)).trim().split(SEP);
  return { session, paneId };
}

export async function newWindow(
  session: string, name?: string, cwd?: string, select = false,
): Promise<{ windowId: string; paneId: string; index: string; name: string }> {
  const fmt = [`#{window_id}`, `#{pane_id}`, `#{window_index}`, `#{window_name}`].join(SEP);
  const args = ["new-window", "-P", "-F", fmt, "-t", `${session}:`];
  if (!select) args.push("-d");
  if (name) args.push("-n", name);
  if (cwd) args.push("-c", cwd);
  const [windowId, paneId, index, winName] = (await userTmux(args)).trim().split(SEP);
  return { windowId, paneId, index, name: winName ?? "" };
}

export async function splitPane(
  target: string, direction: "below" | "right", size?: number, cwd?: string, select = false,
): Promise<{ paneId: string }> {
  const args = ["split-window", "-P", "-F", "#{pane_id}", "-t", target, direction === "right" ? "-h" : "-v"];
  if (!select) args.push("-d");
  if (size) args.push("-l", `${size}%`);
  if (cwd) args.push("-c", cwd);
  return { paneId: (await userTmux(args)).trim() };
}

export type TargetKind = "pane" | "window" | "session";

export function inferKind(target: string): TargetKind {
  if (target.startsWith("%")) return "pane";
  if (target.startsWith("@")) return "window";
  if (/:\d*\.\d+$/.test(target) || /\.\d+$/.test(target)) return "pane";
  if (target.includes(":")) return "window";
  return "session";
}

export async function killTarget(target: string, kind: TargetKind): Promise<void> {
  const cmd = kind === "pane" ? "kill-pane" : kind === "window" ? "kill-window" : "kill-session";
  const t = kind === "session" && !target.startsWith("$") ? `=${target}` : target;
  await userTmux([cmd, "-t", t]);
}
