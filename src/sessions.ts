import * as fs from "node:fs";
import * as path from "node:path";
import {
  LOGDIR, PANE_H, PANE_W, ensureServer, paneInfo, tmux, log,
} from "./tmux.js";
import { MARKER_RE } from "./ansi.js";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface Session {
  name: string;
  paneId: string;
  logPath: string;
  offset: number;
  createdAt: number;
  lastCommand?: string;
  idle: boolean; // last wait ended at a shell prompt marker
  dead: boolean;
}

const MARKER_INSTALL =
  ' __tmux_mcp_mark(){ printf "\\033]133;D;%s\\007" "$?"; };' +
  ' PROMPT_COMMAND="__tmux_mcp_mark${PROMPT_COMMAND:+;$PROMPT_COMMAND}"';

function sqQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function hasMarker(p: string, from: number): boolean {
  const size = fileSize(p);
  if (size <= from) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.allocUnsafe(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const s = buf.subarray(0, n).toString("latin1");
    MARKER_RE.lastIndex = 0;
    return MARKER_RE.test(s);
  } catch {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SessionManager {
  private sessions = new Map<string, Session>();
  private locks = new Map<string, Promise<unknown>>();

  validate(name: string): string | null {
    if (!NAME_RE.test(name)) {
      return `invalid session name ${JSON.stringify(name)} — use 1-64 chars of [A-Za-z0-9_-], starting with a letter or digit (names starting with "_" are reserved)`;
    }
    return null;
  }

  get(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  names(): string[] {
    return [...this.sessions.keys()];
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(name, run.then(() => undefined, () => undefined));
    return run;
  }

  /** Type the marker installer into the pane and wait until the first marker lands. */
  private async installMarker(session: Session): Promise<void> {
    const before = fileSize(session.logPath);
    await tmux(["send-keys", "-t", session.paneId, "-l", "--", MARKER_INSTALL]);
    await tmux(["send-keys", "-t", session.paneId, "Enter"]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(50);
      if (hasMarker(session.logPath, before)) {
        // let the prompt that follows the marker land, then skip past everything
        await sleep(120);
        session.offset = fileSize(session.logPath);
        session.idle = true;
        return;
      }
    }
    log(`warning: no exit-code marker within 5s for session "${session.name}" — falling back to prompt heuristics`);
    session.offset = fileSize(session.logPath);
  }

  private async startPipe(session: Session): Promise<void> {
    await tmux([
      "pipe-pane", "-t", session.paneId, "-O",
      `cat >> ${sqQuote(session.logPath)}`,
    ]);
  }

  private async create(name: string, cwd?: string): Promise<Session> {
    await ensureServer();
    const logPath = path.join(LOGDIR, `${name}.log`);
    await fs.promises.writeFile(logPath, "", { mode: 0o600 }).catch(() => undefined);
    const paneId = (
      await tmux([
        "new-session", "-d", "-P", "-F", "#{pane_id}",
        "-s", name, "-x", PANE_W, "-y", PANE_H,
        "-c", cwd && cwd.length ? cwd : process.cwd(),
        "bash",
      ])
    ).trim();
    const session: Session = {
      name,
      paneId,
      logPath,
      offset: 0,
      createdAt: Date.now(),
      idle: false,
      dead: false,
    };
    await this.startPipe(session);
    await this.installMarker(session);
    this.sessions.set(name, session);
    return session;
  }

  /**
   * Returns the live session, creating it or respawning a dead shell as needed.
   * `respawned` is true when a fresh shell was started in an existing pane.
   */
  async getOrCreate(name: string, cwd?: string): Promise<{ session: Session; respawned: boolean }> {
    const existing = this.sessions.get(name);
    if (!existing) return { session: await this.create(name, cwd), respawned: false };

    let info;
    try {
      info = await paneInfo(existing.paneId);
    } catch {
      // pane/session vanished (e.g. killed from outside) — recreate from scratch
      this.sessions.delete(name);
      return { session: await this.create(name, cwd), respawned: true };
    }
    if (!info.dead) {
      existing.dead = false;
      return { session: existing, respawned: false };
    }
    await tmux([
      "respawn-pane", "-k", "-t", existing.paneId,
      "-c", info.cwd || process.cwd(), "bash",
    ]);
    existing.dead = false;
    // pipe-pane survives respawn-pane -k on tmux 3.2a, but verify rather than assume.
    const after = await paneInfo(existing.paneId);
    if (!after.piped) {
      log(`pipe-pane did not survive respawn-pane for "${name}" — re-arming`);
      await this.startPipe(existing);
    }
    await this.installMarker(existing);
    return { session: existing, respawned: true };
  }

  async kill(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    this.sessions.delete(name);
    this.locks.delete(name);
    try {
      await tmux(["kill-session", "-t", `=${name}`]);
    } catch (err) {
      log(`kill-session ${name}: ${(err as Error).message}`);
    }
    await fs.promises.rm(session.logPath, { force: true }).catch(() => undefined);
  }

  unread(session: Session): number {
    return Math.max(0, fileSize(session.logPath) - session.offset);
  }
}
