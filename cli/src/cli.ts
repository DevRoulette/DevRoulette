#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./tui.js";
import { install, uninstall } from "./install.js";

// Default to production; override with DEVROULETTE_URL (e.g. ws://127.0.0.1:8787 for local dev).
const DEFAULT_URL = process.env.DEVROULETTE_URL ?? "wss://devroulette-production.up.railway.app";
const argv = process.argv.slice(2);

function publicHelp(): void {
  // NOTE: the manual/debug entry is intentionally NOT documented here.
  console.log(
    [
      "DevRoulette — chat with a random dev.",
      "",
      "Just start chatting, in any terminal:",
      "",
      "  devroulette start",
      "",
      "Optional — auto-open the chat while a long Claude Code task runs:",
      "",
      "  devroulette init",
      "",
      "In chat: /skip for a new dev, /quit to close.",
      "Anonymous, no accounts, chat not logged. 18+.",
    ].join("\n"),
  );
}

// Public entry is gated on the hook trigger (an active task). The hook launches
// the chat via DEVROULETTE_TRIGGER=hook (or the internal --room flag). Without a
// trigger, the only other way in is the hidden --debug flag (testing only).
const triggeredByHook = process.env.DEVROULETTE_TRIGGER === "hook" || argv.includes("--room");
// Manual/debug entry only works when the operator has set DEVROULETTE_DEV=1
// locally. Without it, --debug is inert (you fall through to the public help).
const debug = argv.includes("--debug") && process.env.DEVROULETTE_DEV === "1";
// Optional standalone entry: `devroulette start` opens the chat right here in the
// current terminal — no Claude Code, no task, no window juggling. The chat already
// runs in manual mode (it heartbeats on its own), so this just renders it directly.
const manualStart = argv[0] === "start";

if (argv[0] === "init") {
  install(argv[1]); // optional server URL, e.g. `devroulette init wss://host`
  process.exit(0);
}
if (argv[0] === "uninstall") {
  uninstall();
  process.exit(0);
}

if (!manualStart && !triggeredByHook && !debug) {
  publicHelp();
  process.exit(0);
}

// Secrets are handed off from the watcher via a 0600 file (never argv/inline env,
// which are world-readable via `ps`). Fall back to env for manual/debug launches.
let session = process.env.DEVROULETTE_SESSION;
let resume = process.env.DEVROULETTE_RESUME || undefined;
let url = DEFAULT_URL;
const handoff = process.env.DEVROULETTE_HANDOFF;
if (handoff) {
  try {
    const data = JSON.parse(readFileSync(handoff, "utf8")) as { session?: string; resumeToken?: string; url?: string };
    if (data.session) session = data.session;
    if (data.resumeToken) resume = data.resumeToken;
    if (data.url) url = data.url;
  } catch {
    /* ignore — fall back to env */
  } finally {
    try {
      rmSync(handoff, { force: true }); // one-time: consume it immediately
    } catch {
      /* ignore */
    }
  }
}
// Only a server-generated hex token is ever valid; ignore anything else.
if (resume && !/^[a-f0-9]{1,64}$/.test(resume)) resume = undefined;

// One chat window per MACHINE. Atomically claim the shared "hub" pid file so the
// hooks know which window to signal. If another live window already holds it, this
// one is a duplicate — exit immediately so we never stack windows.
const dir = join(tmpdir(), "devroulette");
const hubFile = join(dir, "hub.pid");
try {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
} catch {
  /* already exists */
}
let claimedHub = false;
for (let i = 0; i < 2 && !claimedHub; i++) {
  try {
    writeFileSync(hubFile, String(process.pid), { flag: "wx", mode: 0o600 }); // atomic create
    claimedHub = true;
  } catch {
    try {
      const held = Number(readFileSync(hubFile, "utf8"));
      if (held === process.pid) {
        claimedHub = true;
        break;
      }
      process.kill(held, 0); // throws if dead
      break; // a live window already owns the hub → we're a duplicate
    } catch {
      try {
        rmSync(hubFile, { force: true }); // stale holder → clear and retry
      } catch {
        /* ignore */
      }
    }
  }
}
if (!claimedHub) {
  // A DevRoulette window is already open on this machine. For a manual `start`,
  // say so (otherwise the command would seem to do nothing); the hook path exits
  // quietly since it's just avoiding a stacked auto-window.
  if (manualStart) console.log("A DevRoulette chat is already open on this machine — use that window (or close it first).");
  process.exit(0);
}
process.on("exit", () => {
  try {
    if (existsSync(hubFile) && Number(readFileSync(hubFile, "utf8")) === process.pid) {
      rmSync(hubFile, { force: true });
    }
  } catch {
    /* ignore */
  }
});

// Wipe the launched command line + shell startup noise (e.g. .zshrc warnings) the
// terminal leaves on screen, so the chat opens on a clean panel.
process.stdout.write("[2J[3J[H");

render(React.createElement(App, { url, debug, session, resume }));
