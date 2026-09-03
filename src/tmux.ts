import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const pexecFile = promisify(execFile);

function num(v: string | undefined, dflt: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export const TMUX_BIN = process.env.TMUX_MCP_TMUX_BIN || "tmux";
export const SOCKET = `tmux-mcp-${process.pid}`;
export const LOGDIR = path.join(os.tmpdir(), `tmux-mcp-${process.pid}`);
export const SIZE = process.env.TMUX_MCP_SIZE || "200x50";
const sizeMatch = /^(\d+)x(\d+)$/.exec(SIZE);
export const PANE_W = sizeMatch ? sizeMatch[1] : "200";
export const PANE_H = sizeMatch ? sizeMatch[2] : "50";
export const DEFAULT_TIMEOUT_S = num(process.env.TMUX_MCP_DEFAULT_TIMEOUT, 120);
export const PROMPT_SETTLE_MS = num(process.env.TMUX_MCP_PROMPT_SETTLE_MS, 800);
export const MAX_OUTPUT = num(process.env.TMUX_MCP_MAX_OUTPUT, 30000);
export const WATCHDOG_SESSION = "_watchdog";

export function socketPath(): string {
  const tmpdir = process.env.TMUX_TMPDIR || "/tmp";
  return path.join(tmpdir, `tmux-${os.userInfo().uid}`, SOCKET);
}

export function log(msg: string): void {
  // NEVER stdout: stdout belongs to the MCP transport.
  process.stderr.write(`[tmux-mcp] ${msg}\n`);
}

export class TmuxError extends Error {}

function tmuxEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.TMUX;
  delete e.TMUX_PANE;
  return e;
}

export async function tmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await pexecFile(TMUX_BIN, ["-L", SOCKET, ...args], {
      env: tmuxEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      throw new TmuxError(`tmux binary "${TMUX_BIN}" not found — install tmux (apt install tmux)`);
    }
    const se = (err?.stderr ?? "").toString().trim();
    throw new TmuxError(`tmux ${args.join(" ")} failed: ${se || err?.message || String(err)}`);
  }
}

export interface PaneInfo {
  dead: boolean;
  deadStatus: number | null;
  fg: string;
  alternate: boolean;
  piped: boolean;
  cwd: string;
}

const INFO_FORMAT =
  "#{pane_dead},#{pane_dead_status},#{pane_current_command},#{alternate_on},#{pane_pipe},#{pane_current_path}";

export async function paneInfo(paneId: string): Promise<PaneInfo> {
  const out = (await tmux(["display-message", "-p", "-t", paneId, INFO_FORMAT])).replace(/\n$/, "");
  const parts = out.split(",");
  return {
    dead: parts[0] === "1",
    deadStatus: parts[1] === "" || parts[1] === undefined ? null : Number(parts[1]),
    fg: parts[2] ?? "",
    alternate: parts[3] === "1",
    piped: parts[4] === "1",
    cwd: parts.slice(5).join(","),
  };
}

export async function capturePane(paneId: string, lines?: number): Promise<string> {
  const args = ["capture-pane", "-p", "-t", paneId];
  if (lines && lines > 0) args.push("-S", `-${lines}`);
  return await tmux(args);
}

export async function checkTmux(): Promise<void> {
  try {
    await pexecFile(TMUX_BIN, ["-V"], { env: tmuxEnv() });
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      throw new TmuxError(`tmux binary "${TMUX_BIN}" not found — install tmux (apt install tmux)`);
    }
    throw new TmuxError(`tmux is not usable: ${err?.message || String(err)}`);
  }
}

let serverPromise: Promise<void> | null = null;

async function bootstrapServer(): Promise<void> {
  await checkTmux();
  await fs.promises.mkdir(LOGDIR, { recursive: true, mode: 0o700 });
  // Watchdog first: a tmux server with no sessions exits immediately.
  // The rm runs before kill-server because kill-server also kills this pane;
  // it covers the SIGKILL case where cleanupSync() never gets to run.
  const watch =
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; ` +
    `rm -rf '${LOGDIR}'; ` +
    `${TMUX_BIN} -L ${SOCKET} kill-server`;
  await tmux([
    "new-session", "-d", "-s", WATCHDOG_SESSION,
    "-x", PANE_W, "-y", PANE_H,
    watch,
  ]);
  // Global options must be set before real sessions are created.
  await tmux(["set", "-g", "remain-on-exit", "on"]);
  await tmux(["set", "-g", "history-limit", "50000"]);
  await tmux(["set", "-g", "status", "off"]);
  await tmux(["set", "-g", "default-size", `${PANE_W}x${PANE_H}`]);
  log(`socket=${SOCKET} logdir=${LOGDIR}`);
}

export function ensureServer(): Promise<void> {
  if (!serverPromise) {
    serverPromise = bootstrapServer().catch((err) => {
      serverPromise = null; // allow retry on next call
      throw err;
    });
  }
  return serverPromise;
}

export function serverStarted(): boolean {
  return serverPromise !== null;
}

let cleaned = false;

export function cleanupSync(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    execFileSync(TMUX_BIN, ["-L", SOCKET, "kill-server"], { env: tmuxEnv(), stdio: "ignore" });
  } catch {
    /* server may already be gone */
  }
  try {
    fs.rmSync(LOGDIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(socketPath(), { force: true });
  } catch {
    /* ignore */
  }
}
