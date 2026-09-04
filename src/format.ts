import type { WaitStatus } from "./wait.js";

export interface ToolNames {
  /** Tool that types a command line. */
  run: string;
  /** Tool that sends raw keys. */
  keys: string;
  /** Tool that reads more output. */
  read: string;
}

const DEFAULT_TOOLS: ToolNames = {
  run: "tmux_run",
  keys: "tmux_send_keys",
  read: "tmux_read",
};

export interface FormatInput {
  /** Session name (private sessions) or pane id (user server) — used for the default label/ref. */
  session: string;
  status: WaitStatus;
  exitCode?: number;
  fg: string;
  body: string;
  tui?: boolean;
  waitForSrc?: string;
  /** Idle timeout that was in effect, in ms. */
  idleMs?: number;
  /** Hard cap that was in effect, in ms. */
  maxMs?: number;
  respawned?: boolean;
  emptyText?: string;
  /** Footer prefix; defaults to `session "<name>"`. Pane tools pass `pane %3`. */
  label?: string;
  /** How to address this thing again; defaults to `session:"<name>"`. Pane tools pass `target:"%3"`. */
  ref?: string;
  /** Tool names used in hints; defaults to the tmux_run family. */
  tools?: Partial<ToolNames>;
  /** false when a dead pane is NOT respawned automatically (user server). */
  respawns?: boolean;
}

function fgName(fg: string): string {
  return fg && fg.length ? fg : "the session";
}

/** 2000 → "2", 500 → "0.5", 1500 → "1.5" */
export function secs(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

function labelOf(i: FormatInput): string {
  return i.label ?? `session "${i.session}"`;
}

function refOf(i: FormatInput): string {
  return i.ref ?? `session:${JSON.stringify(i.session)}`;
}

function toolsOf(i: FormatInput): ToolNames {
  return { ...DEFAULT_TOOLS, ...(i.tools ?? {}) };
}

/** Output first, then at most one bracketed footer line. */
export function footerFor(i: FormatInput): string | null {
  const label = labelOf(i);
  const t = toolsOf(i);
  if (i.tui) {
    return `[screen snapshot — full-screen program "${fgName(i.fg)}" is running]`;
  }
  switch (i.status) {
    case "exited":
      return i.exitCode === 0 ? null : `[exit code ${i.exitCode}]`;
    case "shell_exited":
      return i.respawns === false
        ? `[${label}: the process in this pane exited with code ${i.exitCode ?? 0} — the pane is gone]`
        : `[${label}: shell exited with code ${i.exitCode ?? 0} — next ${t.run} on this session starts a fresh shell]`;
    case "prompt":
      return `[${label}: "${fgName(i.fg)}" is waiting for input — send the next line with ${t.run}(${refOf(i)}) or keys with ${t.keys}]`;
    case "matched":
      return `[${label}: matched /${i.waitForSrc ?? ""}/ — process "${fgName(i.fg)}" still running; ${t.read} to get more output]`;
    case "idle":
      return `[${label}: idle — no output for ${secs(i.idleMs ?? 0)} s, process "${fgName(i.fg)}" still running (not killed). Use ${t.read} to keep waiting, ${t.keys} ["C-c"] to stop it]`;
    case "timeout":
      return `[${label}: still running and producing output after ${secs(i.maxMs ?? 0)} s (hard cap, not killed) — ${t.read} for more]`;
    case "immediate":
      return null;
    default:
      return null;
  }
}

export function formatResponse(i: FormatInput): string {
  const parts: string[] = [];
  if (i.respawned) parts.push(`[session "${i.session}" restarted a fresh shell]`);
  const body = i.body.length ? i.body : (i.emptyText ?? "(no output)");
  parts.push(body);
  const footer = footerFor(i);
  if (footer) parts.push(footer);
  return parts.join("\n");
}
