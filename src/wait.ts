import * as fs from "node:fs";
import { PROMPT_SETTLE_MS, capturePane, paneInfo } from "./tmux.js";
import type { PaneInfo } from "./tmux.js";
import { MARKER_RE, applyCarriageReturns, isCommandEcho, stripAnsi, stripEcho } from "./ansi.js";
import type { Session } from "./sessions.js";

export type WaitStatus =
  | "exited"        // shell printed its prompt again; exit code known
  | "shell_exited"  // the pane's shell itself died
  | "matched"       // wait_for regex matched
  | "idle"          // no new output for idleMs; the process is still running
  | "prompt"        // an interactive program is waiting for input
  | "timeout"       // the hard cap elapsed while output was still flowing
  | "immediate";    // timeout: 0 — whatever was new right now

export interface WaitOpts {
  /** Return once no new output has arrived for this long. <= 0 disables. */
  idleMs: number;
  /** Hard cap on the total wait. <= 0 disables. Both <= 0 means "return immediately". */
  maxMs: number;
  waitFor?: RegExp;
  pollMs?: number;
  /** The command we typed, so its echo is not matched by wait_for. */
  command?: string;
}

export interface WaitResult {
  status: WaitStatus;
  exitCode?: number;
  raw: Buffer;
  fg: string;
  alternate: boolean;
}

/** Last non-empty line of a rendered pane; tmux trims trailing spaces. */
export const PROMPT_RE =
  /(?:[$#%>»❯]|\]|\)|\?|:)\s*$|password[^\n]*$|\[[yY]\/[nN]\]$|\(y(?:es)?\/no?\)$/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readFrom(fd: number, from: number): Buffer {
  const size = fs.fstatSync(fd).size;
  if (size <= from) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(size - from);
  const n = fs.readSync(fd, buf, 0, buf.length, from);
  return buf.subarray(0, n);
}

function lastMarker(latin: string): { index: number; code: number } | null {
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last: { index: number; code: number } | null = null;
  while ((m = MARKER_RE.exec(latin)) !== null) {
    last = { index: m.index, code: Number(m[1]) };
  }
  return last;
}

async function lastPaneLine(paneId: string): Promise<string> {
  const screen = await capturePane(paneId);
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

/**
 * Polling loop. Reads the pipe-pane log from session.offset forward and
 * decides when to hand control back to the agent. Never kills anything.
 */
export async function waitForResult(session: Session, opts: WaitOpts): Promise<WaitResult> {
  const pollMs = opts.pollMs ?? 100;
  const startedAt = Date.now();
  let lastDataAt = startedAt;
  let raw: Buffer = Buffer.alloc(0);
  let info: PaneInfo | null = null;
  let fd: number;
  try {
    fd = fs.openSync(session.logPath, "r");
  } catch {
    // no log yet: nothing can have been written
    const i = await paneInfo(session.paneId).catch(() => null);
    return { status: "immediate", raw, fg: i?.fg ?? "", alternate: i?.alternate ?? false };
  }

  const read = (): number => {
    const chunk = readFrom(fd, session.offset);
    if (chunk.length) {
      raw = raw.length ? Buffer.concat([raw, chunk]) : chunk;
      session.offset += chunk.length;
      lastDataAt = Date.now();
    }
    return chunk.length;
  };

  const finishMarker = async (): Promise<WaitResult> => {
    // one more read to swallow the prompt written right after the marker
    await sleep(pollMs);
    read();
    const mk = lastMarker(raw.toString("latin1"))!;
    const out = raw.subarray(0, mk.index);
    session.offset = fs.fstatSync(fd).size; // discard everything after the marker
    session.idle = true;
    return {
      status: "exited",
      exitCode: mk.code,
      raw: out,
      fg: info?.fg ?? "bash",
      alternate: false,
    };
  };

  try {
    if (opts.idleMs <= 0 && opts.maxMs <= 0) {
      read();
      info = await paneInfo(session.paneId).catch(() => null);
      const mk = lastMarker(raw.toString("latin1"));
      if (mk) return await finishMarker();
      return {
        status: "immediate",
        raw,
        fg: info?.fg ?? "",
        alternate: info?.alternate ?? false,
      };
    }

    let tick = 0;
    for (;;) {
      read();
      tick++;

      // 2. exit-code marker (primary signal)
      if (lastMarker(raw.toString("latin1"))) return await finishMarker();

      // 3. pane state (every other tick to halve exec cost)
      if (tick === 1 || tick % 2 === 0 || info === null) {
        try {
          info = await paneInfo(session.paneId);
        } catch {
          info = null;
        }
        if (info?.dead) {
          read();
          session.dead = true;
          session.idle = false;
          return {
            status: "shell_exited",
            exitCode: info.deadStatus ?? undefined,
            raw,
            fg: info.fg,
            alternate: false,
          };
        }
      }

      // 4. wait_for
      if (opts.waitFor && raw.length) {
        opts.waitFor.lastIndex = 0;
        // Test against cleaned output with the command echo removed, otherwise a
        // pattern that also occurs in the command line matches instantly.
        let cleaned = applyCarriageReturns(stripAnsi(raw.toString("utf8")));
        if (opts.command !== undefined) cleaned = stripEcho(cleaned, opts.command);
        if (opts.waitFor.test(cleaned)) {
          session.idle = false;
          return {
            status: "matched",
            raw,
            fg: info?.fg ?? "",
            alternate: info?.alternate ?? false,
          };
        }
      }

      const silentFor = Date.now() - lastDataAt;

      // 5. interactive prompt heuristic
      if (silentFor >= PROMPT_SETTLE_MS) {
        const line = await lastPaneLine(session.paneId);
        if (PROMPT_RE.test(line) && !isCommandEcho(line, opts.command)) {
          session.idle = false;
          return {
            status: "prompt",
            raw,
            fg: info?.fg ?? "",
            alternate: info?.alternate ?? false,
          };
        }
      }

      // 6. idle timeout — the process keeps running on purpose
      if (opts.idleMs > 0 && silentFor >= opts.idleMs) {
        session.idle = false;
        return {
          status: "idle",
          raw,
          fg: info?.fg ?? "",
          alternate: info?.alternate ?? false,
        };
      }

      // 7. hard cap — output is still flowing, but we have waited long enough
      if (opts.maxMs > 0 && Date.now() - startedAt >= opts.maxMs) {
        session.idle = false;
        return {
          status: "timeout",
          raw,
          fg: info?.fg ?? "",
          alternate: info?.alternate ?? false,
        };
      }

      await sleep(pollMs);
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
