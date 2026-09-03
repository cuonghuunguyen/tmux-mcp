# tmux-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent **persistent, tmux-backed
shell sessions** — with the same interaction model as a normal `Bash` tool: send a command, get the
output and an exit code back.

It exists for the things a one-shot `Bash` tool cannot do:

```
docker exec -it web sh      # interactive container shells
ssh host                    # and the password prompt that follows
python3 / psql / node       # REPLs that must stay alive between calls
npm run dev                 # dev servers you keep reading from
sudo … / apt install        # password and y/n prompts
```

Sessions keep their working directory, environment and any running program between tool calls.
Every session lives in a **private tmux server owned by the MCP process**, so nothing is left
running once the agent exits.

* **Exact exit codes**, not guesses — via an invisible OSC 133 shell marker.
* **Never kills your process on timeout** — it hands control back and lets you keep reading.
* **Clean output** — ANSI stripped, progress bars folded to their final line, command echo removed.
* **TUI aware** — when `less`/`vim`/`htop` is drawing, you get a screen snapshot instead of a byte stream.
* **No leaks** — an in-tmux watchdog tears everything down even if the server is `SIGKILL`ed.

## Requirements

* `tmux` (developed and tested against 3.2a)
* Node.js ≥ 18
* `bash` available as the session shell

## Install

```bash
git clone https://github.com/cuonghuunguyen/tmux-mcp.git
cd tmux-mcp
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs the end-to-end smoke test over real stdio (~35 s)
```

## Register with a client

The server speaks MCP over stdio. Point your client at `dist/index.js`.

**Claude Code:**

```bash
claude mcp add -s user tmux -- node /absolute/path/to/tmux-mcp/dist/index.js
claude mcp list     # tmux ✓ Connected
```

**Any client using the standard JSON config** (Claude Desktop, OpenCode, …):

```json
{
  "mcpServers": {
    "tmux": {
      "command": "node",
      "args": ["/absolute/path/to/tmux-mcp/dist/index.js"]
    }
  }
}
```

If several Node versions are installed, use the **absolute path** to a Node ≥ 18 binary rather than
bare `node` — the client's `PATH` is not always your shell's.

## Tools

| Tool | Purpose |
|---|---|
| `tmux_run` | Type a command line + Enter into a session (auto-created) and return its output. Params: `command`, `session` (default `default`), `cwd` (new sessions only), `timeout` (s, default 120, max 600), `wait_for` (regex), `quiet_ms`. |
| `tmux_send_keys` | Send raw keys or text: `["C-c"]`, `["C-d"]`, `["q"]`, `["yes"]`, arrows, function keys. Params: `session`, `keys[]`, `timeout` (default 30), `wait_for`, `quiet_ms`. |
| `tmux_read` | Read output that arrived since the last call (`timeout: 0` = whatever is new right now, `wait_for` to keep waiting), or `screen: true` for the rendered screen. |
| `tmux_list` | One line per session: `web  fg=bash  idle  cwd=/srv/app  created 3m ago  unread=0B`. |
| `tmux_kill` | Kill one session and its log. |

Session names must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` — no `.` or `:`, and a leading `_` is
reserved for internal sessions such as `_watchdog`.

Input goes to whatever is in the foreground of a session, so give a dev server or an `ssh` shell its
own session name and keep `default` free for ordinary commands.

### Example: a dev server and a REPL side by side

```jsonc
// start the server, return as soon as it prints its URL — it keeps running
tmux_run { session: "dev", command: "npm run dev", wait_for: "localhost:\\d+" }

// meanwhile, in another session
tmux_run { session: "py", command: "python3" }        // → returns at the >>> prompt
tmux_run { session: "py", command: "1 + 1" }          // → 2

// check what the server has printed since
tmux_read { session: "dev" }

// stop it
tmux_send_keys { session: "dev", keys: ["C-c"] }
```

## Wait semantics

`tmux_run` returns as soon as one of these happens:

1. **The shell prompt is back** — exit code known. Footer `[exit code N]` for non-zero; no footer at
   all for 0.
2. **The shell itself exited** (`exit 3`) — the footer says so, and the next call on that session
   respawns a fresh bash in the same pane, prefixed with `[session "x" restarted a fresh shell]`.
3. **`wait_for` matched** the new output — JS regex syntax, multiline; the echoed command line is
   excluded from matching.
4. **An interactive program is waiting for input** — no new output for `TMUX_MCP_PROMPT_SETTLE_MS`
   (800 ms) *and* the last screen line looks like a prompt (`$ # % > >>> :`, `password…`, `[y/N]`,
   `(END)`).
5. **`quiet_ms`** elapsed with no output — opt-in, off by default.
6. **`timeout`** elapsed — the process is **not** killed. Keep following it with `tmux_read`, stop it
   with `tmux_send_keys ["C-c"]`, or just use a different session for other work.

A non-zero exit code is **not** an MCP error. `isError: true` is reserved for invalid session names,
unknown sessions, invalid `wait_for` regexes, and tmux failures (including "tmux not installed").

### Output processing

ANSI/OSC escapes are stripped, `\r` overwrites and backspaces are folded (so progress bars collapse
to their final line), the command echo is removed, and the result is truncated to
`TMUX_MCP_MAX_OUTPUT` characters (first 8 000 + last 22 000).

If a full-screen program is drawing — alternate screen, e.g. `less`, `vim`, `htop` — the response is
a **screen snapshot** instead of the byte stream, with the footer
`[screen snapshot — full-screen program "less" is running]`.

## Configuration

All optional, read from the environment of the MCP process.

| Var | Default | Meaning |
|---|---|---|
| `TMUX_MCP_DEFAULT_TIMEOUT` | `120` | Default `timeout` for `tmux_run`, in seconds |
| `TMUX_MCP_PROMPT_SETTLE_MS` | `800` | Silence required before the interactive-prompt heuristic fires |
| `TMUX_MCP_SIZE` | `200x50` | Pane size; wide panes keep long lines from wrapping |
| `TMUX_MCP_MAX_OUTPUT` | `30000` | Truncation threshold, in characters |
| `TMUX_MCP_TMUX_BIN` | `tmux` | Path to the tmux binary |

New sessions default to the MCP process's own working directory, which for a stdio server is the
directory the client was launched from. Pass `cwd` explicitly when you want something else.

## How it works

* **One tmux server per MCP process**, on its own socket `tmux-mcp-<pid>` — it never touches the
  user's own tmux sessions. One tmux session per agent-facing session name, always addressed by pane
  id (`%N`) rather than name.
* **Every pane's raw byte stream** is captured with `pipe-pane -O` into
  `$TMPDIR/tmux-mcp-<pid>/<name>.log`. The server reads that log incrementally from a saved offset,
  so nothing is lost between calls — output that arrives while no tool call is in flight is simply
  waiting the next time you read.
* **Exit codes are exact.** A marker is installed in each session's bash:
  `PROMPT_COMMAND` runs `printf "\033]133;D;%s\007" "$?"`, an OSC 133 sequence. tmux renders nothing
  for it, so it never appears on screen, but it *is* in the piped byte stream — which is how "the
  command finished with code N" is detected rather than guessed from prompt shapes.
* **A `_watchdog` tmux session** runs `while kill -0 <mcp pid>; do sleep 1; done; rm -rf <logdir>;
  tmux kill-server`, tearing the whole tmux server down within ~2 s even if the MCP process dies
  without running any handler.
* **stdout is reserved for the MCP transport**; all logging goes to stderr.

### Cleanup guarantee

| How the server ends | What happens |
|---|---|
| stdin EOF, `SIGINT`, `SIGTERM`, `SIGHUP`, `process.exit` | `tmux kill-server`, log dir and socket file removed synchronously |
| `SIGKILL`, OOM kill | The in-tmux watchdog removes the log dir and kills the tmux server within ~2 s |

Both paths are covered by the smoke test: after a graceful client close *and* after `kill -9`,
`tmux -L tmux-mcp-<pid> ls` fails and the log dir is gone. A stale zero-byte socket file may briefly
remain in `/tmp/tmux-<uid>/`; it holds no process.

## Development

```
src/
  index.ts      MCP server, tool definitions, lifecycle
  sessions.ts   session map, pane creation, marker install, respawn
  tmux.ts       tmux CLI wrapper, private server bootstrap, watchdog, cleanup
  wait.ts       the polling loop that decides when to return
  ansi.ts       escape stripping, \r folding, echo removal, truncation
  format.ts     response body + footer
  test/smoke.ts end-to-end test over real stdio
```

`npm test` compiles and then drives a real server with the official MCP client SDK: 44 checks
covering exit codes, cwd/env persistence, REPL prompt detection, `C-c` recovery, `wait_for`,
`quiet_ms`, TUI snapshots, shell respawn, input validation, session isolation and both shutdown
paths. One scenario (`docker run -it alpine`) is skipped automatically when no Docker daemon is
reachable.

Notes for anyone extending it:

* `wait_for` is matched against the *cleaned* output with the command echo removed. Without that,
  `wait_for: "READY"` on `(… echo READY; sleep 30)` would match the echoed command line instantly.
* `pipe-pane` survives `respawn-pane -k` on tmux 3.2a, but `#{pane_pipe}` is re-checked after every
  respawn and `pipe-pane` re-armed if it ever comes back `0`.
* Calls on the same session are serialized by a per-session lock; different sessions run
  concurrently.

## License

MIT — see [LICENSE](LICENSE).
