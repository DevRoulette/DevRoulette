import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client, type ClientEvent } from "./client.js";

// Shapes we will splice into a shell command must be strictly validated first.
const RESUME_RE = /^[a-f0-9]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;

// Invoked by Claude Code hooks:
//   hook-runner start   (UserPromptSubmit) — stdin has the hook JSON
//   hook-runner stop    (Stop)             — stdin has the hook JSON
//   hook-runner watch <session>            — internal detached 30s watcher
// All JSON is parsed here in Node — never interpolated into a shell command.

const STATE = join(tmpdir(), "devroulette");
const WAIT_MS = Number(process.env.DEVROULETTE_WAIT_MS ?? 30_000);
// Default to production; the installed hooks bake an explicit URL, and
// DEVROULETTE_URL overrides (e.g. ws://127.0.0.1:8787 for local dev).
const WS_URL = process.env.DEVROULETTE_URL ?? "wss://devroulette-production.up.railway.app";

/** Create the per-user state dir owner-only. Refuse to use it only if it's been
 *  pre-planted/hijacked (symlink, wrong owner, or writable by others — the actual
 *  planting risk). A dir an older version left merely group/other-READABLE (0755)
 *  is fine to reuse — we just tighten it back to 0700. */
function ensureState(): boolean {
  try {
    mkdirSync(STATE, { recursive: true, mode: 0o700 });
  } catch {
    /* may already exist — validated below */
  }
  try {
    let st = lstatSync(STATE);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (uid !== -1 && st.uid !== uid) return false;
    // Self-heal loose perms we own (e.g. a 0755 dir from an older release) back to
    // owner-only, then re-stat.
    if ((st.mode & 0o077) !== 0) {
      try {
        chmodSync(STATE, 0o700);
        st = lstatSync(STATE);
      } catch {
        /* couldn't tighten — fall through to the write check */
      }
    }
    if ((st.mode & 0o022) !== 0) return false; // others can WRITE → untrusted
    return true;
  } catch {
    return false;
  }
}

/** True only if `file` is a regular file we own and no one else can write. */
function trustedFile(file: string): boolean {
  try {
    const st = lstatSync(file);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    return st.isFile() && !st.isSymbolicLink() && (uid === -1 || st.uid === uid) && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}
const watchFile = (s: string): string => join(STATE, `${s}.watch`);
const selfPath = (): string => fileURLToPath(import.meta.url);

// ONE chat window per machine (the "hub"). A long task just TRIGGERS it open; the
// chat is NOT tied to the task after that — the user drives it (skip / quit). So
// the hooks only open the window; they never close or re-tie it to a task.
const HUB_FILE = join(STATE, "hub.pid");

interface HookInput {
  session_id?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function sessionFromStdin(): Promise<string | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return (JSON.parse(raw) as HookInput).session_id ?? null;
  } catch {
    return null;
  }
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function osaQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Running under WSL? (Linux kernel that reports Microsoft, or the WSL env var.) */
function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Is a launcher binary on PATH? Best-effort (which/where); never throws. */
function commandExists(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** execFile that never lets a missing launcher crash the hook (logs + moves on). */
function launch(label: string, file: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const cb = (err: Error | null): void => {
    if (err) console.error(`devroulette: couldn't open chat window via ${label} (${err.message})`);
  };
  if (env) execFile(file, args, { env }, cb);
  else execFile(file, args, cb);
}

/** Try a split-pane command; on any error (binary missing, remote control off, no
 *  scripting permission) fall back to opening a window so the chat still appears. */
function splitOrFallback(label: string, file: string, args: string[], fallback: () => void): void {
  try {
    execFile(file, args, (err: Error | null) => {
      if (err) {
        console.error(`devroulette: ${label} split unavailable (${err.message}); opening a window instead`);
        fallback();
      }
    });
  } catch {
    fallback();
  }
}

/**
 * Open the chat TUI in a NEW terminal window, cross-platform. The fallback when the
 * terminal has no split API. Secrets travel in the 0600 handoff file — never on
 * argv/inline env. The non-secret trigger + handoff path go via the spawned
 * process's env on Windows, and inline in bash on macOS / Linux / WSL.
 */
function openWindow(inner: string, cli: string, childEnv: NodeJS.ProcessEnv): void {
  if (process.platform === "darwin") {
    launch("Terminal.app", "osascript", ["-e", `tell application "Terminal" to do script ${osaQuote(inner)}`]);
    return;
  }
  if (isWSL()) {
    if (commandExists("wt.exe")) launch("wt.exe", "wt.exe", ["new-tab", "wsl.exe", "-e", "bash", "-lc", inner]);
    else launch("cmd.exe", "cmd.exe", ["/c", "start", "", "wsl.exe", "-e", "bash", "-lc", inner]);
    return;
  }
  if (process.platform === "win32") {
    if (commandExists("wt.exe")) launch("wt.exe", "wt.exe", [process.execPath, cli, "--room"], childEnv);
    else launch("cmd.exe", "cmd.exe", ["/c", "start", "", process.execPath, cli, "--room"], childEnv);
    return;
  }
  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (process.env.TERMINAL) candidates.push({ cmd: process.env.TERMINAL, args: ["-e", "bash", "-lc", inner] });
  candidates.push({ cmd: "gnome-terminal", args: ["--", "bash", "-lc", inner] });
  candidates.push({ cmd: "konsole", args: ["-e", "bash", "-lc", inner] });
  candidates.push({ cmd: "xfce4-terminal", args: ["-x", "bash", "-lc", inner] });
  candidates.push({ cmd: "xterm", args: ["-e", "bash", "-lc", inner] });
  candidates.push({ cmd: "x-terminal-emulator", args: ["-e", "bash", "-lc", inner] });
  const term = candidates.find((c) => commandExists(c.cmd));
  if (!term) {
    console.error("devroulette: no terminal emulator found (set $TERMINAL); skipping chat window.");
    return;
  }
  launch(term.cmd, term.cmd, term.args);
}

/**
 * Open the chat next to Claude. Prefers a SPLIT PANE in the current window so
 * nothing pops out — tmux, iTerm2, Kitty, WezTerm. Falls back to a plain new window
 * when the terminal has no split API (Apple Terminal, plain cmd, bare Linux
 * terminals) — no resizing/tiling, just a window.
 * Detection reads the hook's inherited terminal env (TMUX / KITTY_WINDOW_ID / …).
 */
function openChat(session: string, resumeToken: string): void {
  if (!SESSION_RE.test(session) || !RESUME_RE.test(resumeToken)) return;
  const cli = join(dirname(selfPath()), "cli.js");
  const handoff = join(STATE, `${randomBytes(12).toString("hex")}.handoff`);
  writeFileSync(handoff, JSON.stringify({ session, resumeToken, url: WS_URL }), { mode: 0o600 });

  const childEnv: NodeJS.ProcessEnv = { ...process.env, DEVROULETTE_TRIGGER: "hook", DEVROULETTE_HANDOFF: handoff };
  const inner =
    `DEVROULETTE_TRIGGER=hook DEVROULETTE_HANDOFF=${shSingleQuote(handoff)} ` +
    `${shSingleQuote(process.execPath)} ${shSingleQuote(cli)} --room`;
  const fallback = (): void => openWindow(inner, cli, childEnv);

  // tmux — split beside Claude's pane (uses $TMUX_PANE from our inherited env).
  if (process.env.TMUX) {
    return splitOrFallback("tmux", "tmux", ["split-window", "-h", inner], fallback);
  }
  // Kitty — needs `allow_remote_control`; fails → window fallback.
  if (process.env.KITTY_WINDOW_ID) {
    return splitOrFallback("kitty", "kitten", ["@", "launch", "--location=vsplit", "--cwd=current", "bash", "-lc", inner], fallback);
  }
  // WezTerm — split the current pane to the right.
  if (process.env.WEZTERM_PANE) {
    return splitOrFallback("wezterm", "wezterm", ["cli", "split-pane", "--right", "--", "bash", "-lc", inner], fallback);
  }
  // iTerm2 — split the current session, then run the command in the new pane.
  if (process.env.TERM_PROGRAM === "iTerm.app") {
    const osa =
      `tell application "iTerm2"\n` +
      `  tell current session of current window to set newSession to (split vertically with default profile)\n` +
      `  tell newSession to write text ${osaQuote(inner)}\n` +
      `end tell`;
    return splitOrFallback("iTerm2", "osascript", ["-e", osa], fallback);
  }
  // No split-capable terminal → a window.
  fallback();
}

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

/** Remove a state file if the process it points to is already dead, so a killed
 *  watcher/window can't permanently lock out future tasks for this session. */
function clearIfStale(file: string): void {
  if (!existsSync(file)) return;
  if (!trustedFile(file)) return; // not a file we own — never act on it
  const pid = Number(readFileSync(file, "utf8"));
  if (!pidAlive(pid)) rmSync(file, { force: true });
}

function cmdStart(session: string): void {
  if (!ensureState()) return; // untrusted/unusable state dir — do nothing this run
  // drop dead watcher/hub state first (a killed process leaves its file behind)
  clearIfStale(watchFile(session));
  clearIfStale(HUB_FILE);
  // One pending watcher per task-wait. (If the hub window is already open, the
  // watcher will just exit — see cmdWatch — since a task only OPENS the window.)
  if (existsSync(watchFile(session))) return;
  const child = spawn(process.execPath, [selfPath(), "watch", session], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DEVROULETTE_URL: WS_URL },
  });
  writeFileSync(watchFile(session), String(child.pid ?? 0), { mode: 0o600 });
  child.unref();
}

/**
 * After the long-task threshold, join the queue HEADLESSLY in the background —
 * no window. We only pop a terminal at the moment the server reports a match.
 * If the task finishes first, we leave the queue silently and the user never
 * saw anything. This is what keeps the app from ever feeling "empty/dead".
 */
function cmdWatch(session: string): void {
  setTimeout(() => {
    if (!existsSync(watchFile(session))) {
      process.exit(0); // task already finished — Stop cancelled us before we queued
    }
    // If the machine's hub window is already open, leave it alone — a task only
    // OPENS the window; it never disturbs an open one. The user drives it.
    if (existsSync(HUB_FILE) && trustedFile(HUB_FILE)) {
      const cpid = Number(readFileSync(HUB_FILE, "utf8"));
      if (cpid > 0 && pidAlive(cpid)) {
        rmSync(watchFile(session), { force: true });
        process.exit(0);
      }
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      rmSync(watchFile(session), { force: true });
      process.exit(0);
    };
    const client = new Client(
      WS_URL,
      (e: ClientEvent) => {
        if (e.t === "matched" && e.resumeToken) {
          // hand the live room to a freshly-opened window, then let the server
          // close this background socket (→ "closed" → finish()).
          openChat(session, e.resumeToken);
        } else if (e.t === "closed" || e.t === "banned") {
          finish();
        }
      },
      { session },
    );
    // Stop hook signals us (SIGTERM) when the task ends: leave the queue quietly.
    process.once("SIGTERM", () => {
      client.quit();
      finish();
    });
  }, WAIT_MS);
}

function killFrom(file: string): void {
  if (!existsSync(file)) return;
  if (!trustedFile(file)) return; // someone else's planted file — never SIGTERM its PID
  const pid = Number(readFileSync(file, "utf8"));
  rmSync(file, { force: true });
  if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function cmdStop(session: string): void {
  // A task ending only matters BEFORE a window opens: cancel a still-pending watcher
  // so a task that finished under 30s doesn't pop a window. Once the window is open
  // it's task-independent — we never touch it here; the user closes it with /quit.
  killFrom(watchFile(session));
}

async function main(): Promise<void> {
  const [, , cmd, sessionArg] = process.argv;
  if (cmd === "watch") {
    if (sessionArg) cmdWatch(sessionArg);
    return; // keep process alive for the timer
  }
  const session = sessionArg ?? (await sessionFromStdin());
  if (!session) {
    process.exit(0);
  }
  if (cmd === "start") cmdStart(session);
  else if (cmd === "stop") cmdStop(session);
  process.exit(0);
}

void main();
