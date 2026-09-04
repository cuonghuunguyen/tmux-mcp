/**
 * End-to-end smoke test. Talks to the real server over stdio with the
 * official SDK client. Prints PASS/FAIL per scenario, exits non-zero on failure.
 *
 * The user-server family (tmux_ls / tmux_pane_* / tmux_new_* / tmux_kill_target)
 * is exercised against a throwaway socket passed via TMUX_MCP_USER_SOCKET, so the
 * developer's own tmux server is never touched.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCarriageReturns, isTui, stripAnsi, stripEcho, truncate } from "../ansi.js";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const projectRoot = path.dirname(path.dirname(path.dirname(serverPath)));

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(name: string, why: string): void {
  console.log(`SKIP ${name} — ${why}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (s: string) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + "…" : s);

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  return { ...e, ...extra };
}

interface Instance {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  socket: string;
  logdir: string;
  stderr: string[];
}

async function startInstance(env: Record<string, string> = {}): Promise<Instance> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: cleanEnv(env),
    cwd: projectRoot,
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  const pid = transport.pid!;
  return {
    client, transport, pid, stderr,
    socket: `tmux-mcp-${pid}`,
    logdir: path.join(os.tmpdir(), `tmux-mcp-${pid}`),
  };
}

async function call(
  inst: Instance,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 120000,
): Promise<{ text: string; isError: boolean }> {
  const r: any = await inst.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const text = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
  return { text, isError: r.isError === true };
}

function serverAlive(socket: string): boolean {
  try {
    execFileSync("tmux", ["-L", socket, "ls"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listSessions(socket: string): string {
  try {
    return execFileSync("tmux", ["-L", socket, "ls"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function killServer(socket: string): void {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    /* nothing running */
  }
}

const ALL_TOOLS = [
  "tmux_kill", "tmux_kill_target", "tmux_list", "tmux_ls", "tmux_new_session",
  "tmux_new_window", "tmux_pane_capture", "tmux_pane_exec", "tmux_pane_send_keys",
  "tmux_read", "tmux_run", "tmux_send_keys", "tmux_split_pane",
];

// ---------------------------------------------------------------- unit checks
function unitChecks(): void {
  check("unit stripAnsi", stripAnsi("\x1b[?2004l\x1b]133;D;0\x07hi\x1b[0m") === "hi");
  check("unit applyCarriageReturns", applyCarriageReturns("abcdef\rXY\nq\r") === "XYcdef\nq",
    q(applyCarriageReturns("abcdef\rXY\nq\r")));
  check("unit stripEcho", stripEcho("prompt$ echo hi\nhi", "echo hi") === "hi");
  check("unit stripEcho multiline", stripEcho("$ for x in 1; do\n> echo $x\n> done\n1", "for x in 1; do\necho $x\ndone") === "1",
    q(stripEcho("$ for x in 1; do\n> echo $x\n> done\n1", "for x in 1; do\necho $x\ndone")));
  check("unit isTui", isTui("\x1b[?1049hstuff", false) && !isTui("plain", false) && isTui("plain", true));
  check("unit truncate", truncate("x".repeat(100), 40).includes("truncated 60 chars"));
}

// ---------------------------------------------------------------- scenarios
async function scenarios(userSocket: string): Promise<void> {
  const inst = await startInstance({ TMUX_MCP_USER_SOCKET: userSocket });
  console.log(`# server pid=${inst.pid} socket=${inst.socket} user-socket=${userSocket}`);

  const tools = await inst.client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("00 all tools registered", JSON.stringify(names) === JSON.stringify(ALL_TOOLS), names.join(","));

  // 1
  let r = await call(inst, "tmux_run", { command: "echo hello" });
  check("01 echo hello", r.text === "hello", q(r.text));

  // 2
  r = await call(inst, "tmux_run", { command: "false" });
  check("02a false → [exit code 1]", r.text.includes("[exit code 1]") && !r.isError, q(r.text));
  r = await call(inst, "tmux_run", { command: "true" });
  check("02b true → no footer", !r.text.includes("exit code"), q(r.text));

  // 3
  await call(inst, "tmux_run", { command: "cd /tmp" });
  r = await call(inst, "tmux_run", { command: "pwd" });
  check("03a cwd persists", r.text === "/tmp", q(r.text));
  await call(inst, "tmux_run", { command: "export FOO=bar" });
  r = await call(inst, "tmux_run", { command: "echo $FOO" });
  check("03b env persists", r.text === "bar", q(r.text));

  // 4
  r = await call(inst, "tmux_run", { command: "echo -n no-newline" });
  check("04 no trailing newline", r.text === "no-newline", q(r.text));

  // 5
  r = await call(inst, "tmux_run", { command: "for i in 1 2 3; do\necho $i\ndone" });
  check("05 multi-line command", r.text === "1\n2\n3", q(r.text));

  // 5b — the echo of a command ending in ")" must not look like an interactive prompt
  r = await call(inst, "tmux_run", { command: "(sleep 1.5; echo paren)", timeout: 10 });
  check("05b echo ending in ) is not a prompt", r.text === "paren", q(r.text));

  // 6
  r = await call(inst, "tmux_run", { command: "ls /nonexistent" });
  check("06 stderr + exit code 2", r.text.includes("No such file") && r.text.includes("[exit code 2]"), q(r.text));

  // 7
  const t7 = Date.now();
  r = await call(inst, "tmux_run", { command: "python3 -q", session: "py", timeout: 15 });
  const dt7 = Date.now() - t7;
  check("07a python3 REPL prompt detected", /python3/.test(r.text) && /waiting for input/.test(r.text) && dt7 < 5000,
    `${dt7}ms ${q(r.text)}`);
  r = await call(inst, "tmux_run", { command: "1+1", session: "py", timeout: 15 });
  check("07b python evaluates", r.text.split("\n")[0].trim() === "2", q(r.text));
  r = await call(inst, "tmux_send_keys", { session: "py", keys: ["C-d"], timeout: 15 });
  check("07c C-d returns to shell", !r.text.includes("exit code 1") && !r.isError, q(r.text));
  r = await call(inst, "tmux_run", { command: "echo shellok", session: "py" });
  check("07d shell healthy after REPL", r.text === "shellok", q(r.text));

  // 8 — idle timeout: sleep 30 is silent, so 2 s of silence ends the call
  const t8 = Date.now();
  r = await call(inst, "tmux_run", { command: "sleep 30", session: "slow", timeout: 2 });
  const dt8 = Date.now() - t8;
  check("08a idle footer, not killed", /no output for 2 s/.test(r.text) && dt8 < 6000, `${dt8}ms ${q(r.text)}`);
  const t8b = Date.now();
  r = await call(inst, "tmux_send_keys", { session: "slow", keys: ["C-c"], timeout: 15 });
  check("08b C-c returns promptly", Date.now() - t8b < 5000, `${Date.now() - t8b}ms ${q(r.text)}`);
  r = await call(inst, "tmux_run", { command: "echo done", session: "slow" });
  check("08c shell healthy after C-c", r.text === "done", q(r.text));

  // 9
  r = await call(inst, "tmux_run", {
    command: '(for i in $(seq 1 5); do echo "log $i"; sleep 0.3; done; echo READY; sleep 30)',
    session: "dev",
    wait_for: "READY",
    timeout: 20,
  });
  check("09a wait_for matched", r.text.includes("log 1") && r.text.includes("READY") && /matched/.test(r.text), q(r.text));
  r = await call(inst, "tmux_read", { session: "dev", timeout: 0 });
  check("09b tmux_read timeout 0", r.text.includes("(no new output)"), q(r.text));
  await call(inst, "tmux_send_keys", { session: "dev", keys: ["C-c"], timeout: 15 });

  // 10 — fractional idle timeout, then the hard cap
  const t10 = Date.now();
  r = await call(inst, "tmux_run", { command: "(echo a; sleep 5)", session: "quiet", timeout: 0.5 });
  const dt10 = Date.now() - t10;
  check("10a fractional idle timeout",
    dt10 < 2500 && r.text.includes("a") && /no output for 0\.5 s/.test(r.text), `${dt10}ms ${q(r.text)}`);
  await call(inst, "tmux_send_keys", { session: "quiet", keys: ["C-c"], timeout: 15 });

  const t10b = Date.now();
  r = await call(inst, "tmux_run", {
    command: "while true; do echo tick; sleep 0.2; done",
    session: "cap", timeout: 5, max_timeout: 2,
  });
  const dt10b = Date.now() - t10b;
  check("10b hard cap while output flows",
    dt10b < 5000 && /hard cap/.test(r.text) && /after 2 s/.test(r.text) && r.text.includes("tick"),
    `${dt10b}ms ${q(r.text)}`);
  await call(inst, "tmux_send_keys", { session: "cap", keys: ["C-c"], timeout: 15 });

  // 11
  r = await call(inst, "tmux_run", { command: "less /etc/hostname", session: "tui", timeout: 15 });
  check("11a less → screen snapshot", r.text.includes("(END)") && /full-screen/.test(r.text), q(r.text));
  await call(inst, "tmux_send_keys", { session: "tui", keys: ["q"], timeout: 15 });
  r = await call(inst, "tmux_run", { command: "echo afterless", session: "tui" });
  check("11b q leaves less", r.text === "afterless", q(r.text));

  // 12
  r = await call(inst, "tmux_run", { command: "exit 3", session: "bye", timeout: 15 });
  check("12a shell exited code 3", /shell exited with code 3/.test(r.text), q(r.text));
  r = await call(inst, "tmux_run", { command: "echo back", session: "bye", timeout: 15 });
  check("12b respawn note + output", r.text.includes("back") && /restarted a fresh shell/.test(r.text), q(r.text));

  // 13
  r = await call(inst, "tmux_run", { command: "echo x", session: "_bad" });
  check("13a invalid name _bad", r.isError, q(r.text));
  r = await call(inst, "tmux_run", { command: "echo x", session: "a:b" });
  check("13b invalid name a:b", r.isError, q(r.text));
  r = await call(inst, "tmux_read", { session: "nosuchsession" });
  check("13c unknown session read", r.isError, q(r.text));
  r = await call(inst, "tmux_run", { command: "echo x", session: "default", wait_for: "([" });
  check("13d invalid wait_for regex", r.isError, q(r.text));

  // 14
  r = await call(inst, "tmux_list");
  check("14a list shows sessions, hides _watchdog",
    /^default\s/m.test(r.text) && r.text.includes("py") && !r.text.includes("_watchdog"), q(r.text));
  r = await call(inst, "tmux_kill", { session: "py" });
  check("14b kill session", r.text.includes('[killed session "py"]'), q(r.text));
  r = await call(inst, "tmux_list");
  check("14c killed session gone", !/^py\s/m.test(r.text), q(r.text));

  // 15
  const t15 = Date.now();
  const [ra, rb] = await Promise.all([
    call(inst, "tmux_run", { command: "sleep 1; echo a", session: "para", timeout: 20 }),
    call(inst, "tmux_run", { command: "sleep 1; echo b", session: "parb", timeout: 20 }),
  ]);
  const dt15 = Date.now() - t15;
  check("15a parallel sessions run concurrently",
    ra.text === "a" && rb.text === "b" && dt15 < 4000, `${dt15}ms ${q(ra.text)} ${q(rb.text)}`);
  const [rs1, rs2] = await Promise.all([
    call(inst, "tmux_run", { command: "sleep 0.5; echo one", session: "ser", timeout: 20 }),
    call(inst, "tmux_run", { command: "echo two", session: "ser", timeout: 20 }),
  ]);
  check("15b same session serializes", rs1.text === "one" && rs2.text === "two", `${q(rs1.text)} ${q(rs2.text)}`);

  // ---- 20: the user's own tmux server -------------------------------------

  // 20a
  r = await call(inst, "tmux_ls");
  check("20a tmux_ls with no server", !r.isError && /no tmux server/.test(r.text), q(r.text));

  // 20b
  r = await call(inst, "tmux_new_session", { name: "usr1", cwd: "/tmp", command: "echo created; pwd" });
  check("20b new session runs its command",
    r.text.includes('created session "usr1"') && /pane %\d+/.test(r.text) &&
    r.text.includes("created") && r.text.includes("/tmp") && !r.isError, q(r.text));

  // 20c
  r = await call(inst, "tmux_ls");
  check("20c tmux_ls tree", /session usr1/.test(r.text) && /pane %\d+.*fg=bash/.test(r.text), q(r.text));

  // 20d
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "false" });
  check("20d1 false → [exit code 1]", r.text.includes("[exit code 1]") && !r.isError, q(r.text));
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "true" });
  check("20d2 true → no footer", !r.text.includes("exit code"), q(r.text));
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "echo -n abc" });
  check("20d3 exact output", r.text === "abc", q(r.text));

  // 20e — a long-lived REPL in the user's pane
  const t20e = Date.now();
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "python3 -q", timeout: 10 });
  const dt20e = Date.now() - t20e;
  check("20e1 python REPL prompt", /waiting for input/.test(r.text) && dt20e < 5000, `${dt20e}ms ${q(r.text)}`);
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "1+1", timeout: 10 });
  check("20e2 untracked REPL evaluates",
    r.text.split("\n")[0].trim() === "2" && /python3/.test(r.text), q(r.text));
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "import time; time.sleep(1.5); print(7)", timeout: 10 });
  check("20e2b untracked echo ending in ) is not a prompt",
    r.text.split("\n")[0].trim() === "7", q(r.text));
  r = await call(inst, "tmux_pane_send_keys", { target: "usr1", keys: ["C-d"], timeout: 5 });
  check("20e3 C-d leaves the REPL", !r.isError, q(r.text));
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "echo back" });
  check("20e4 tracked again after the REPL", r.text === "back", q(r.text));

  // 20f
  const t20f = Date.now();
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "sleep 30", timeout: 1 });
  const dt20f = Date.now() - t20f;
  check("20f1 idle timeout in a user pane",
    /no output for 1 s/.test(r.text) && dt20f < 4000, `${dt20f}ms ${q(r.text)}`);
  await call(inst, "tmux_pane_send_keys", { target: "usr1", keys: ["C-c"], timeout: 5 });
  r = await call(inst, "tmux_pane_exec", { target: "usr1", command: "echo ok" });
  check("20f2 pane healthy after C-c", r.text === "ok", q(r.text));

  // 20g
  r = await call(inst, "tmux_pane_exec", {
    target: "usr1", command: "(echo a; sleep 0.5; echo READY; sleep 20)", wait_for: "READY", timeout: 10,
  });
  check("20g wait_for in a user pane",
    r.text.includes("READY") && /matched/.test(r.text), q(r.text));
  await call(inst, "tmux_pane_send_keys", { target: "usr1", keys: ["C-c"], timeout: 5 });

  // 20h
  r = await call(inst, "tmux_pane_capture", { target: "usr1", lines: 200 });
  check("20h pane capture with scrollback",
    r.text.includes("back") && r.text.includes("ok") && /scrollback\]$/.test(r.text.trim()), q(r.text));

  // 20i
  r = await call(inst, "tmux_new_window", { session: "usr1", name: "w2", command: "echo inwin" });
  check("20i1 new window runs its command",
    /created window @\d+/.test(r.text) && r.text.includes('"w2"') && r.text.includes("inwin"), q(r.text));
  const winId = /created window (@\d+)/.exec(r.text)?.[1] ?? "";
  const winPane = /pane (%\d+)/.exec(r.text)?.[1] ?? "";
  r = await call(inst, "tmux_split_pane", { target: winPane, direction: "right", size: 40 });
  check("20i2 split pane", /new pane %\d+/.test(r.text) && !r.isError, q(r.text));
  const splitId = /new pane (%\d+)/.exec(r.text)?.[1] ?? "";
  r = await call(inst, "tmux_ls", { session: "usr1" });
  check("20i3 two windows", (r.text.match(/^ {2}window /gm) ?? []).length === 2, q(r.text));

  // 20j
  r = await call(inst, "tmux_kill_target", { target: splitId });
  check("20j1 kill pane (kind inferred)", r.text === `[killed pane ${splitId}]`, q(r.text));
  r = await call(inst, "tmux_kill_target", { target: winId });
  check("20j2 kill window (kind inferred)", r.text === `[killed window ${winId}]`, q(r.text));
  r = await call(inst, "tmux_ls", { session: "usr1" });
  check("20j3 one window left", (r.text.match(/^ {2}window /gm) ?? []).length === 1, q(r.text));
  r = await call(inst, "tmux_kill_target", { target: "usr1" });
  check("20j4 kill session", r.text === "[killed session usr1]", q(r.text));
  r = await call(inst, "tmux_ls");
  check("20j5 last session gone", !r.isError && /no tmux server|\(no sessions/.test(r.text), q(r.text));

  // 20k — created before the graceful shutdown, must survive it
  r = await call(inst, "tmux_new_session", { name: "usr2", cwd: "/tmp" });
  check("20k1 usr2 created", r.text.includes('created session "usr2"') && !r.isError, q(r.text));

  // 20l — input validation on the user family
  r = await call(inst, "tmux_new_session", { name: "a.b" });
  check("20l1 session name with '.'", r.isError, q(r.text));
  r = await call(inst, "tmux_new_session", { name: "a:b" });
  check("20l2 session name with ':'", r.isError, q(r.text));
  r = await call(inst, "tmux_pane_exec", { target: "%99999", command: "echo x" });
  check("20l3 unknown target is a clean error",
    r.isError && /tmux|pane/.test(r.text) && !/undefined|Cannot read/.test(r.text), q(r.text));

  // 18 (optional, before shutdown scenarios)
  let dockerOk = false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20000 });
    dockerOk = true;
  } catch { /* no daemon */ }
  if (!dockerOk) {
    skip("18 docker run -it alpine", "docker daemon unreachable");
  } else {
    r = await call(inst, "tmux_run", { command: "docker run --rm -it alpine sh", session: "dock", timeout: 90 }, 120000);
    check("18a docker prompt detected", /waiting for input/.test(r.text), q(r.text));
    r = await call(inst, "tmux_run", { command: "echo hi", session: "dock", timeout: 20 });
    check("18b command inside container", r.text.split("\n")[0].trim() === "hi", q(r.text));
    r = await call(inst, "tmux_run", { command: "exit", session: "dock", timeout: 30 });
    check("18c exit returns to bash", !r.isError, q(r.text));
  }

  // 17 (hard kill) — separate instance
  const inst2 = await startInstance({ TMUX_MCP_USER_SOCKET: userSocket });
  await call(inst2, "tmux_run", { command: "echo hi", session: "hard" });
  check("17a second instance server up", serverAlive(inst2.socket));
  process.kill(inst2.pid, "SIGKILL");
  await sleep(3000);
  check("17b watchdog killed tmux after SIGKILL", !serverAlive(inst2.socket));
  check("17c watchdog removed logdir after SIGKILL", !fs.existsSync(inst2.logdir), inst2.logdir);

  // 16 (graceful) — must be last for inst
  check("16a server up before close", serverAlive(inst.socket));
  await inst.client.close();
  await sleep(800);
  check("16b tmux server gone after close", !serverAlive(inst.socket));
  check("16c logdir removed", !fs.existsSync(inst.logdir), inst.logdir);

  // 20k2 — the user's sessions are never cleaned up with the private server
  const surviving = listSessions(userSocket);
  check("20k2 user server survives shutdown", /^usr2:/m.test(surviving), q(surviving));
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  unitChecks();
  const userSocket = `tmux-mcp-usr-${process.pid}`;
  try {
    await scenarios(userSocket);
  } finally {
    killServer(userSocket);
  }
}

main()
  .catch((e) => {
    failed++;
    console.log(`FAIL harness — ${e?.stack ?? String(e)}`);
  })
  .then(() => {
    console.log(`\n# ${passed} passed, ${failed} failed`);
    if (failed) console.log(`# failing: ${failures.join(", ")}`);
    process.exit(failed ? 1 : 0);
  });
