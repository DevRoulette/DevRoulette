import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SETTINGS = join(homedir(), ".claude", "settings.json");
// Default matchmaking server baked into hooks when no URL is given, so a bare
// `devroulette init` points at production (not the user's own localhost).
const DEFAULT_URL = "wss://devroulette-production.up.railway.app";
// Unique marker spliced into our own hook commands so we can recognise them
// without false-matching a user hook that merely mentions "hook-runner.js".
const SENTINEL = "DEVROULETTE_HOOK=1";

interface HookCmd {
  type: string;
  command: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

function runnerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "hook-runner.js");
}

function quote(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isOurs(entry: HookEntry): boolean {
  // Match our sentinel, or (for migrating older installs) the ABSOLUTE path to our
  // own hook-runner.js — never a bare "hook-runner.js" substring, which would also
  // catch a user's unrelated hook of the same filename.
  const ours = runnerPath();
  return entry.hooks?.some(
    (h) => typeof h.command === "string" && (h.command.includes(SENTINEL) || h.command.includes(ours)),
  );
}

// ANSI (16-colour, universally supported). Lime green = brand, white = text.
const C = {
  L: "\x1b[92m", W: "\x1b[97m", D: "\x1b[2m", B: "\x1b[1m", R: "\x1b[0m",
};
const bar = `${C.L}▌${C.R}`;

function printWelcome(): void {
  console.log([
    ``,
    `${bar}  ${C.B}${C.L}Dev${C.W}Roulette${C.R}   ${C.D}— chatroulette for Claude Code${C.R}`,
    `${bar}`,
    `${bar}  ${C.L}✓${C.R} installed for this machine.`,
    `${bar}`,
    `${bar}  Start a long Claude Code task ${C.D}→${C.R} a chat opens automatically.`,
    `${bar}  In chat:  ${C.L}/skip${C.R} new dev   ${C.D}·${C.R}   ${C.L}/quit${C.R} close   ${C.D}(it's yours — chat as long as you like)${C.R}`,
    `${bar}  No task? Open one anytime:  ${C.B}${C.L}devroulette start${C.R}`,
    `${bar}`,
    `${bar}  ${C.D}anonymous · no accounts · chat not logged · 18+${C.R}`,
    `${bar}  ${C.D}github.com/DevRoulette/DevRoulette${C.R}`,
    ``,
  ].join("\n"));
}

export function install(url?: string): void {
  // `||` (not `??`) so an empty url arg / empty DEVROULETTE_URL still falls through
  // to the production default instead of baking an empty (→ localhost) URL.
  const server = url || process.env.DEVROULETTE_URL || DEFAULT_URL;
  const dir = dirname(SETTINGS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: Settings = {};
  if (existsSync(SETTINGS)) {
    let raw: string;
    try {
      raw = readFileSync(SETTINGS, "utf8");
      settings = JSON.parse(raw) as Settings;
    } catch {
      console.error("~/.claude/settings.json is not valid JSON — aborting, nothing changed.");
      process.exit(1);
    }
    // ALWAYS back up before touching an existing file
    const backup = `${SETTINGS}.devroulette-backup-${Date.now()}`;
    copyFileSync(SETTINGS, backup);
    console.log(`backed up existing settings → ${backup}`);
  }

  settings.hooks ??= {};
  const node = process.execPath;
  const runner = runnerPath();
  // bake the server URL into the hook command so there's no per-shell env fiddling
  const urlEnv = server ? `DEVROULETTE_URL=${shSingleQuote(server)} ` : "";
  // Bake the terminal preference too. Claude Code may NOT pass the shell's env to
  // hooks, so iTerm auto-detect (TERM_PROGRAM/ITERM_SESSION_ID) can come up empty
  // and fall back to Terminal.app. `DEVROULETTE_TERMINAL=iterm devroulette init`
  // forces iTerm reliably (baked inline → always reaches the hook); `terminal` forces
  // the default Terminal.app.
  const term = (process.env.DEVROULETTE_TERMINAL || "").toLowerCase();
  const termVal = term === "iterm" || term === "iterm2" ? "iterm" : term === "terminal" || term === "apple" ? "terminal" : "";
  const termEnv = termVal ? `DEVROULETTE_TERMINAL=${shSingleQuote(termVal)} ` : "";
  const wanted: Record<string, string> = {
    UserPromptSubmit: `${SENTINEL} ${urlEnv}${termEnv}${quote(node)} ${quote(runner)} start`,
    Stop: `${SENTINEL} ${urlEnv}${termEnv}${quote(node)} ${quote(runner)} stop`,
  };
  if (server) console.log(`server URL baked into hooks → ${server}`);
  if (termVal) console.log(`terminal preference baked into hooks → ${termVal}`);

  for (const [event, command] of Object.entries(wanted)) {
    const list = (settings.hooks[event] ??= []);
    // drop any previous devroulette entry so re-running init updates the URL,
    // but never touch hooks the user added themselves
    const had = list.some(isOurs);
    settings.hooks[event] = list.filter((e) => !isOurs(e));
    settings.hooks[event].push({ matcher: "", hooks: [{ type: "command", command, timeout: 5 }] });
    console.log(`${event}: devroulette hook ${had ? "updated" : "added"}`);
  }

  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  printWelcome();
}

export function uninstall(): void {
  if (!existsSync(SETTINGS)) {
    console.log("no settings file — nothing to remove");
    return;
  }
  let settings: Settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as Settings;
  } catch {
    console.error("~/.claude/settings.json is not valid JSON — aborting.");
    process.exit(1);
  }
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter((e) => !isOurs(e));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log("DevRoulette hooks removed.");
}
