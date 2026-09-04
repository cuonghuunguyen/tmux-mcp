# tmux-mcp

[![npm](https://img.shields.io/npm/v/mcp-tmux.svg)](https://www.npmjs.com/package/mcp-tmux)
[![license](https://img.shields.io/npm/l/mcp-tmux.svg)](./LICENSE)

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
There are **two families of tools**:

* **Agent-private sessions** (`tmux_run` …) live on a tmux server owned by the MCP process, so
  nothing is left running once the agent exits.
* **The user's own tmux server** (`tmux_ls`, `tmux_pane_exec`, `tmux_new_session` …) — inspect and
  drive the sessions a human can watch with `tmux attach`. They outlive the MCP process and are
  **never** killed by it.

* **Exact exit codes**, not guesses — via an invisible OSC 133 shell marker (private sessions) or a
  chained sentinel line (user panes).
* **Never kills your process on timeout** — it hands control back and lets you keep reading.
* **Idle timeouts, not wall clock** — a long-lived session returns as soon as it goes quiet.
* **Clean output** — ANSI stripped, progress bars folded to their final line, command echo removed.
* **TUI aware** — when `less`/`vim`/`htop` is drawing, you get a screen snapshot instead of a byte stream.
* **No leaks** — an in-tmux watchdog tears the private server down even if the MCP is `SIGKILL`ed.

## Requirements

* `tmux` (developed and tested against 3.2a)
* Node.js ≥ 18
* `bash` available as the session shell

## Install

Published on npm as **[`mcp-tmux`](https://www.npmjs.com/package/mcp-tmux)** (the name `tmux-mcp`
was already taken). No install step is needed — `npx` fetches it on first use:

```bash
npx -y mcp-tmux        # runs the server on stdio
```

Or install it once:

```bash
npm install -g mcp-tmux
mcp-tmux               # the same stdio server
```

## Register with a client

The server speaks MCP over stdio.

**Claude Code:**

```bash
claude mcp add -s user tmux -- npx -y mcp-tmux
claude mcp list     # tmux ✓ Connected
```

**Any client using the standard JSON config** (Claude Desktop, OpenCode, …):

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "mcp-tmux"]
    }
  }
}
```

If several Node versions are installed, use the **absolute path** to a Node ≥ 18 `npx`/`node`
binary rather than the bare command — the client's `PATH` is not always your shell's.

## Develop from source

```bash
git clone https://github.com/cuonghuunguyen/tmux-mcp.git
cd tmux-mcp
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs the end-to-end smoke test over real stdio (~60 s)
```

Point a client at the local build with `node /absolute/path/to/tmux-mcp/dist/index.js`.

## Tools

### Agent-private sessions

A tmux server on its own socket, owned by the MCP process and destroyed when it exits. Addressed by
a session *name*.

| Tool | Purpose |
|---|---|
| `tmux_run` | Type a command line + Enter into a session (auto-created) and return its output. Params: `command`, `session` (default `default`), `cwd` (new sessions only), `timeout` (idle s, default 15), `max_timeout` (s, default 600), `wait_for` (regex). |
| `tmux_send_keys` | Send raw keys or text: `["C-c"]`, `["C-d"]`, `["q"]`, `["yes"]`, arrows, function keys. Params: `session`, `keys[]`, `timeout` (idle, default 5), `max_timeout`, `wait_for`. |
| `tmux_read` | Read output that arrived since the last call (`timeout: 0` = whatever is new right now, `wait_for` to keep waiting), or `screen: true` for the rendered screen. |
| `tmux_list` | One line per session: `web  fg=bash  idle  cwd=/srv/app  created 3m ago  unread=0B`. |
| `tmux_kill` | Kill one session and its log. |

Session names must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` — no `.` or `:`, and a leading `_` is
reserved for internal sessions such as `_watchdog`.

### Your own tmux server

The default socket, or `$TMUX` when the MCP itself runs inside tmux, or whatever
`TMUX_MCP_USER_SOCKET` / `TMUX_MCP_USER_SOCKET_PATH` point at. Addressed by ordinary tmux
*targets*: pane id `%3`, window id `@2`, `session:window.pane`, or a bare session name (which
resolves to its active pane). **Nothing here is ever killed when the MCP exits.**

| Tool | Purpose |
|---|---|
| `tmux_ls` | Tree of sessions → windows → panes, with each pane's id, `fg`, cwd and size. Params: `session?`. |
| `tmux_pane_capture` | What a pane currently shows, plus `lines` of scrollback. Read-only — safe on a pane running a TUI or somebody's editor. |
| `tmux_pane_exec` | Type a command line into an existing pane and return its output, with the exit code when the pane sits at a shell prompt. Params: `target`, `command`, `timeout`, `max_timeout`, `wait_for`. |
| `tmux_pane_send_keys` | Raw keys to a pane: `["C-c"]`, `["C-d"]`, `["y"]`, arrows. Params: `target`, `keys[]`, `timeout` (idle, default 5), `max_timeout`, `wait_for`. |
| `tmux_new_session` | Create a session (starting the user's tmux server if none runs) **and optionally run a command in it, in one call**. Params: `name`, `cwd?`, `window_name?`, `command?`, `timeout?`, `max_timeout?`, `wait_for?`. |
| `tmux_new_window` | Add a window to a session, optionally running a command. Params: `session`, `name?`, `cwd?`, `select?` (default false), `command?`, … |
| `tmux_split_pane` | Split a pane, optionally running a command in the new half. Params: `target`, `direction` (`below`\|`right`), `size?` (5–95 %), `cwd?`, `select?`, `command?`, … |
| `tmux_kill_target` | Kill a pane, window or session. `kind` is inferred from the target (`%3` → pane, `@2` → window, bare name → session). |

Session names here only have to satisfy tmux itself: no `.`, no `:`, not empty.

Input goes to whatever is in the foreground of a session or pane, so give a dev server or an `ssh`
shell its own session name and keep `default` free for ordinary commands.

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

### Example: work inside the user's own tmux

```jsonc
// what does the user have open?
tmux_ls {}
// session work  (2 windows, attached)
//   window @1  work:0 "edit"  (current)
//     pane %0* work:0.0  fg=nvim   cwd=/srv/app  200x50
//   window @3  work:1 "shell"
//     pane %4  work:1.0  fg=bash   cwd=/srv/app  200x50

// give the build its own session the user can attach to
tmux_new_session { name: "build", cwd: "/srv/app", command: "npm run build", timeout: 30 }
// [created session "build" on the user's tmux server — pane %7; attach with: tmux attach -t build]
// …build output…

// run something in the shell pane the user already has open
tmux_pane_exec { target: "%4", command: "git status --short" }

// look at the editor pane without touching it
tmux_pane_capture { target: "%0", lines: 100 }
```

## Wait semantics

`tmux_run` and `tmux_pane_exec` return as soon as one of these happens:

1. **The command finished** — exit code known. Footer `[exit code N]` for non-zero; no footer at
   all for 0.
2. **The shell itself exited** (`exit 3`) — the footer says so. For a private session the next call
   respawns a fresh bash in the same pane, prefixed with `[session "x" restarted a fresh shell]`;
   a pane on the user's server just goes away.
3. **`wait_for` matched** the new output — JS regex syntax, multiline; the echoed command line is
   excluded from matching.
4. **An interactive program is waiting for input** — no new output for `TMUX_MCP_PROMPT_SETTLE_MS`
   (800 ms) *and* the last screen line looks like a prompt (`$ # % > >>> :`, `password…`, `[y/N]`,
   `(END)`).
5. **`timeout` — the idle timeout — elapsed.** *Idle* is defined as: **the pane has produced no new
   output for `timeout` seconds while the process is still running.** Every byte of output — a log
   line, a progress-bar redraw, a prompt — restarts the clock, so it is measured from the *last
   byte*, never from the start of the call. A command that finishes is never "idle": it returns with
   its exit code the moment the prompt is back. Default 15 s, fractions allowed (`0.5`). The process
   is **not** killed; the footer names it and tells you how to keep reading or stop it. This is what
   makes a long-lived session cheap: a `tmux_run` against a session whose dev server is quiet returns
   in `timeout` seconds, not after a wall-clock budget.
6. **`max_timeout` — the hard cap — elapsed** while output was *still flowing* (a build printing a
   line a second never goes idle). Default 600 s, max 3600. Again nothing is killed.

Setting `timeout: 0` (only allowed on `tmux_read` and the two send-keys tools) returns whatever is
already there, immediately; the hard cap is switched off with it.

A non-zero exit code is **not** an MCP error. `isError: true` is reserved for invalid session names,
unknown sessions or targets, invalid `wait_for` regexes, and tmux failures (including "tmux not
installed").

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
| `TMUX_MCP_IDLE_TIMEOUT` | `15` | Default `timeout` (idle seconds) for `tmux_run`, `tmux_pane_exec` and the session-creating tools |
| `TMUX_MCP_MAX_TIMEOUT` | `600` | Default `max_timeout` (hard cap, seconds) |
| `TMUX_MCP_PROMPT_SETTLE_MS` | `800` | Silence required before the interactive-prompt heuristic fires |
| `TMUX_MCP_SIZE` | `200x50` | Pane size; wide panes keep long lines from wrapping |
| `TMUX_MCP_MAX_OUTPUT` | `30000` | Truncation threshold, in characters |
| `TMUX_MCP_TMUX_BIN` | `tmux` | Path to the tmux binary |
| `TMUX_MCP_USER_SOCKET` | — | Socket **name** (`tmux -L …`) of the user's server for the `tmux_ls` family |
| `TMUX_MCP_USER_SOCKET_PATH` | — | Socket **path** (`tmux -S …`) of the user's server; wins over the name |

Without either `TMUX_MCP_USER_SOCKET*`, the user family talks to `$TMUX` when the MCP runs inside
tmux, and to tmux's default socket otherwise.

New sessions default to the MCP process's own working directory, which for a stdio server is the
directory the client was launched from. Pass `cwd` explicitly when you want something else.

## How it works

* **One private tmux server per MCP process**, on its own socket `tmux-mcp-<pid>`. One tmux session
  per agent-facing session name, always addressed by pane id (`%N`) rather than name.
* **Every private pane's raw byte stream** is captured with `pipe-pane -O` into
  `$TMPDIR/tmux-mcp-<pid>/<name>.log`. The server reads that log incrementally from a saved offset,
  so nothing is lost between calls — output that arrives while no tool call is in flight is simply
  waiting the next time you read.
* **Exit codes in private sessions are exact.** A marker is installed in each session's bash:
  `PROMPT_COMMAND` runs `printf "\033]133;D;%s\007" "$?"`, an OSC 133 sequence. tmux renders nothing
  for it, so it never appears on screen, but it *is* in the piped byte stream — which is how "the
  command finished with code N" is detected rather than guessed from prompt shapes.
* **The user's panes are not instrumented.** We do not install a `PROMPT_COMMAND`, pipe a log, or
  change a single option on somebody else's tmux server. Instead, when a pane's foreground process
  is a plain shell (`bash zsh sh dash ash ksh mksh fish`), `tmux_pane_exec` chains an exit-code
  sentinel onto the command line it types:
  `<command>; printf '\n__mcp:%s:<id>\n' "$?"` (`$status` for fish). The sentinel line is stripped
  from the output along with the echoed command line. When something else holds the foreground —
  ssh, a REPL, a container shell — the line is typed as-is and the call returns on `wait_for`, the
  prompt heuristic, the idle timeout or the hard cap, with no exit code to report.
* **Output of a user pane is read with `capture-pane -p -J -S <start>`**, where `start` is derived
  from the `history_size + cursor_y` recorded *before* the keys were sent. That absolute line number
  stays correct as output scrolls off the screen into the history, so a long build is not truncated
  to the last screenful, and `-J` re-joins lines tmux wrapped.
* **Sessions on the user's server are never killed by this MCP.** Shutdown only ever runs
  `kill-server` against the private socket; the only way anything of the user's is destroyed is an
  explicit `tmux_kill_target`.
* **A `_watchdog` tmux session** in the private server runs
  `while kill -0 <mcp pid>; do sleep 1; done; rm -rf <logdir>; tmux kill-server`, tearing the whole
  private server down within ~2 s even if the MCP process dies without running any handler.
* **stdout is reserved for the MCP transport**; all logging goes to stderr.

### Cleanup guarantee

| How the server ends | What happens |
|---|---|
| stdin EOF, `SIGINT`, `SIGTERM`, `SIGHUP`, `process.exit` | Private server: `tmux kill-server`, log dir and socket file removed synchronously. User server: untouched. |
| `SIGKILL`, OOM kill | The in-tmux watchdog removes the log dir and kills the private tmux server within ~2 s. User server: untouched. |

Both paths are covered by the smoke test: after a graceful client close *and* after `kill -9`,
`tmux -L tmux-mcp-<pid> ls` fails and the log dir is gone — while a session created with
`tmux_new_session` is still listed on the user's socket. A stale zero-byte socket file may briefly
remain in `/tmp/tmux-<uid>/`; it holds no process.

## Development

```
src/
  index.ts      MCP server, tool definitions, lifecycle
  sessions.ts   private session map, pane creation, marker install, respawn
  tmux.ts       tmux CLI wrapper, private server bootstrap, watchdog, cleanup
  panes.ts      the user's tmux server: list/capture/exec/create/kill, exit-code sentinel
  wait.ts       the polling loop that decides when to return (private sessions)
  ansi.ts       escape stripping, \r folding, echo removal, truncation
  format.ts     response body + footer, parameterised by tool family
  test/smoke.ts end-to-end test over real stdio
```

`npm test` compiles and then drives a real server with the official MCP client SDK: 74 checks
covering exit codes, cwd/env persistence, REPL prompt detection, `C-c` recovery, `wait_for`, idle
timeouts and the hard cap, TUI snapshots, shell respawn, input validation, session isolation, the
whole user-server family (create → exec → capture → split → kill) and both shutdown paths. One
scenario (`docker run -it alpine`) is skipped automatically when no Docker daemon is reachable.

The user-server scenarios run against a throwaway socket (`TMUX_MCP_USER_SOCKET=tmux-mcp-usr-<pid>`)
and kill it in a `finally`, so running the tests never touches your real tmux.

Notes for anyone extending it:

* `wait_for` is matched against the *cleaned* output with the command echo removed. Without that,
  `wait_for: "READY"` on `(… echo READY; sleep 30)` would match the echoed command line instantly.
* The interactive-prompt heuristic ignores the echoed command line itself, so `(sleep 5; echo x)`
  — whose echo ends in `)` — is not reported as "waiting for input" after 800 ms of silence.
* Appending the sentinel has a useful side effect: the echoed command line then ends in `"$?"`, so
  the prompt heuristic cannot mistake a command ending in `:` or `>` for a prompt.
* `pipe-pane` survives `respawn-pane -k` on tmux 3.2a, but `#{pane_pipe}` is re-checked after every
  respawn and `pipe-pane` re-armed if it ever comes back `0`.
* Freshly created panes are given up to 3 s to print their first prompt before a command is typed
  into them, otherwise the tty echoes the line before the shell is ready to read it.
* Calls on the same private session are serialized by a per-session lock; different sessions run
  concurrently. Calls on the user's panes are not locked — they are the agent's to sequence.

## License

MIT — see [LICENSE](LICENSE).
