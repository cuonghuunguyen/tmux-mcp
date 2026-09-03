import type { WaitStatus } from "./wait.js";

export interface FormatInput {
  session: string;
  status: WaitStatus;
  exitCode?: number;
  fg: string;
  body: string;
  tui?: boolean;
  waitForSrc?: string;
  quietMs?: number;
  timeoutMs?: number;
  respawned?: boolean;
  emptyText?: string;
}

function fgName(fg: string): string {
  return fg && fg.length ? fg : "the session";
}

/** Output first, then at most one bracketed footer line. */
export function footerFor(i: FormatInput): string | null {
  if (i.tui) {
    return `[screen snapshot — full-screen program "${fgName(i.fg)}" is running]`;
  }
  switch (i.status) {
    case "exited":
      return i.exitCode === 0 ? null : `[exit code ${i.exitCode}]`;
    case "shell_exited":
      return `[session "${i.session}": shell exited with code ${i.exitCode ?? 0} — next tmux_run on this session starts a fresh shell]`;
    case "prompt":
      return `[session "${i.session}": "${fgName(i.fg)}" is waiting for input — send the next line with tmux_run(session:"${i.session}") or keys with tmux_send_keys]`;
    case "matched":
      return `[session "${i.session}": matched /${i.waitForSrc ?? ""}/ — process "${fgName(i.fg)}" still running; tmux_read to get more output]`;
    case "quiet":
      return `[session "${i.session}": no output for ${i.quietMs} ms — process "${fgName(i.fg)}" still running]`;
    case "timeout":
      return `[session "${i.session}": timeout after ${Math.round((i.timeoutMs ?? 0) / 1000)} s — process "${fgName(i.fg)}" still running (not killed). Use tmux_read to keep waiting, tmux_send_keys ["C-c"] to stop it, or a different session for other work]`;
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
