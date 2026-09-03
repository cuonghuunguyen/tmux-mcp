import { MAX_OUTPUT } from "./tmux.js";

/** Bash OSC 133;D exit-code marker, emitted by our PROMPT_COMMAND before every prompt. */
export const MARKER_RE = /\x1b\]133;D;(\d+)(?:\x07|\x1b\\)/g;

export function stripAnsi(raw: string): string {
  return raw
    // OSC ... BEL | ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    // charset selection / other short escapes
    .replace(/\x1b[()#][0-~]/g, "")
    .replace(/\x1b[=>78MDEHNOZc]/g, "");
}

/** Fold \r overwrites and \b backspaces, then drop leftover control chars. */
export function applyCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      for (const seg of line.split("\r")) {
        out = seg + out.slice(seg.length);
      }
      let res = "";
      for (const ch of out) {
        if (ch === "\x08") res = res.slice(0, -1);
        else res += ch;
      }
      // keep \t, drop other controls
      return res.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    })
    .join("\n");
}

/** Is a full-screen program drawing in this pane? */
export function isTui(raw: string, alternate: boolean): boolean {
  if (alternate) return true;
  if (raw.includes("\x1b[?1049h") || raw.includes("\x1b[?47h")) return true;
  const cup = raw.match(/\x1b\[\d+;\d+H/g);
  return !!cup && cup.length > 20;
}

/** Remove bash's echo of the command we typed (plus PS2 continuation echoes). */
export function stripEcho(text: string, command: string): string {
  const cmdLines = command.split("\n");
  const first = cmdLines[0];
  if (first.trim() === "") return text;
  const lines = text.split("\n");
  if (lines.length === 0) return text;
  if (!lines[0].trimEnd().endsWith(first.trimEnd())) return text;
  lines.shift();
  for (let i = 1; i < cmdLines.length; i++) {
    const c = cmdLines[i].trimEnd();
    if (lines.length === 0) break;
    if (c === "" || lines[0].trimEnd().endsWith(c)) lines.shift();
  }
  return lines.join("\n");
}

export function trimTrailingBlank(text: string): string {
  return text.replace(/[ \t]*(?:\r?\n[ \t]*)*$/, "");
}

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const headLen = Math.min(8000, Math.floor(max / 4));
  const tailLen = max - headLen;
  const dropped = text.length - headLen - tailLen;
  return (
    text.slice(0, headLen) +
    `\n\n… [truncated ${dropped} chars — use tmux_read with screen:true or capture more via wait_for] …\n\n` +
    text.slice(text.length - tailLen)
  );
}

/** Full stream post-processing pipeline: ANSI → \r/\b folding → echo → trim → truncate. */
export function postProcess(raw: string, command?: string): string {
  let t = stripAnsi(raw);
  t = applyCarriageReturns(t);
  if (command !== undefined) t = stripEcho(t, command);
  t = t.replace(/^\n+/, "");
  t = trimTrailingBlank(t);
  return truncate(t);
}
