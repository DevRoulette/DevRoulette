import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import terminalLink from "terminal-link";
import { execFile } from "node:child_process";
import { Client, type ClientEvent, type ClientOptions } from "./client.js";
import type { Ad } from "../../shared/src/protocol.js";

type Line = { kind: "you" | "them" | "sys"; from?: string; body: string };
type Status = "waiting" | "chatting";

const FOOTER = "/skip   /report   /quit   /insights   /help";
const HOUSE_AD = '"Your Ad Here" — advertise: github.com/DevRoulette/ads';
const HOUSE_AD_URL = "https://devroulette.github.io/ads";
const GITHUB_FOOTER = terminalLink("github.com/DevRoulette", "https://github.com/DevRoulette", { fallback: (t) => t });
const LEGAL_URL = "https://devroulette.github.io/DevRoulette/legal.html";
const MAX_RECONNECTS = 5;

/** Subtle notification — a soft macOS system sound, else the terminal bell.
 *  Fire-and-forget; never blocks or throws. */
function notify(kind: "match" | "message"): void {
  if (process.platform === "darwin") {
    const sound = kind === "match" ? "Glass" : "Tink";
    try {
      execFile("afplay", [`/System/Library/Sounds/${sound}.aiff`], () => {});
    } catch {
      /* ignore */
    }
    return;
  }
  process.stdout.write(String.fromCharCode(7)); // terminal bell
}

/** A clickable ad line: the server ad if present, else the house ad. */
function renderAd(ad: Ad | null): string {
  if (ad?.text && ad.url) return terminalLink(ad.text, ad.url);
  if (ad?.text) return ad.text;
  return terminalLink(HOUSE_AD, HOUSE_AD_URL, { fallback: (t) => t });
}

/**
 * The chat panel. A long Claude task TRIGGERS this window open; after that the
 * chat is NOT tied to the task — you drive it: /skip for a new dev, /quit to close.
 * Partner leaves → auto-matched with someone new. Closed it? Start another task.
 */
export function App(
  { url, debug, session, resume }: { url: string; debug?: boolean; session?: string; resume?: string },
): React.ReactElement {
  const { exit } = useApp();
  const clientRef = useRef<Client | null>(null);
  const [you, setYou] = useState("");
  const [partner, setPartner] = useState("");
  const [online, setOnline] = useState(0);
  const [status, setStatus] = useState<Status>("waiting");
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [ad, setAd] = useState<Ad | null>(null);
  const bannedRef = useRef(false);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectsRef = useRef(0);

  const push = (l: Line): void => setLines((prev) => [...prev.slice(-200), l]);

  const handleEvent = (e: ClientEvent): void => {
    switch (e.t) {
      case "queued":
        reconnectsRef.current = 0;
        setStatus("waiting");
        setPartner("");
        push({ kind: "sys", body: "Looking for a dev who's also around…" });
        break;
      case "online":
        reconnectsRef.current = 0;
        setOnline(e.count);
        if (e.ad) setAd(e.ad);
        break;
      case "matched":
        reconnectsRef.current = 0;
        setYou(e.you);
        setPartner(e.partner);
        if (e.ad) setAd(e.ad);
        setStatus("chatting");
        setLines([
          { kind: "sys", body: `Matched with ${e.partner}. Anonymous, be decent — Chat not logged.` },
          { kind: "sys", body: "⚠ Reminder: avoid clicking links you don't trust." },
        ]);
        notify("match");
        break;
      case "msg":
        push({ kind: "them", from: e.from, body: e.body });
        notify("message");
        break;
      case "partner_left":
      case "task_done":
        // Partner's gone → roll straight into a new match (chatroulette-style).
        setPartner("");
        setStatus("waiting");
        setLines([{ kind: "sys", body: "Partner left — finding you a new dev…" }]);
        clientRef.current?.skip();
        break;
      case "error":
        // Room was torn down server-side (idle / full) → rejoin the pool.
        push({ kind: "sys", body: `· ${e.msg}` });
        setPartner("");
        setStatus("waiting");
        clientRef.current?.skip();
        break;
      case "banned":
        bannedRef.current = true;
        push({ kind: "sys", body: "You've been temporarily blocked (too many messages). /quit to close." });
        break;
      case "closed":
        if (bannedRef.current) {
          push({ kind: "sys", body: "Disconnected. /quit to close." });
          break;
        }
        setPartner("");
        setStatus("waiting");
        if (reconnectsRef.current >= MAX_RECONNECTS) {
          push({ kind: "sys", body: "Can't reach the server. /quit to close, then start a task to retry." });
          break;
        }
        reconnectsRef.current += 1;
        push({ kind: "sys", body: "Connection lost — reconnecting…" });
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(() => connect({ debug, session }), 2500);
        break;
    }
  };

  const connect = (opts: ClientOptions): void => {
    clientRef.current?.quit();
    // manual = task-independent: heartbeat on our own, stay until the user leaves.
    clientRef.current = new Client(url, handleEvent, { manual: true, ...opts });
  };

  useEffect(() => {
    // First connect resumes the room the background watcher matched (no "searching"
    // flash). After that we're a normal manual client.
    connect({ debug, session, resume });
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      clientRef.current?.quit();
    };
  }, [url, debug, session, resume]);

  const submit = (value: string): void => {
    setInput("");
    const v = value.trim();
    if (v.length === 0) return;

    if (v === "/quit") {
      clientRef.current?.quit();
      exit();
      return;
    }
    if (v === "/skip") {
      setStatus("waiting");
      setPartner("");
      setLines([{ kind: "sys", body: "Finding you a new dev…" }]);
      clientRef.current?.skip();
      return;
    }
    if (v === "/report") {
      if (status !== "chatting") {
        push({ kind: "sys", body: "Nothing to report — you're not in a chat." });
        return;
      }
      clientRef.current?.report();
      clientRef.current?.skip();
      setStatus("waiting");
      setPartner("");
      setLines([{ kind: "sys", body: "Reported — finding you a new dev…" }]);
      return;
    }
    if (v === "/insights") {
      const msgs = lines.filter((l) => l.kind !== "sys").length;
      push({ kind: "sys", body: `you=${you || "…"}  partner=${partner || "-"}  online=${online}  messages=${msgs}` });
      return;
    }
    if (v === "/help") {
      for (const body of [
        "DevRoulette — chat with a random dev while your Claude Code task runs.",
        "• A long task (~30s+) opens this window and matches you with someone also around.",
        "• It's NOT tied to your task — chat as long as you like. You're in control.",
        "• /skip new dev   ·   /report flag + skip   ·   /quit close   ·   /insights stats",
        "• Closed it? Start another long task to open it again.",
        `• Anonymous · random · chat not logged · 18+ · ${LEGAL_URL}`,
      ]) {
        push({ kind: "sys", body });
      }
      return;
    }
    if (v.startsWith("/")) {
      push({ kind: "sys", body: "unknown command — /skip /report /quit /insights /help" });
      return;
    }

    push({ kind: "you", from: you || "you", body: v });
    clientRef.current?.sendMsg(v);
  };

  // Render only the most recent lines. Ink redraws the whole frame in place on
  // every update; if that frame ever grows TALLER than the window, Ink can't clear
  // the previous frame and each render stacks a fresh copy (the repeated-header
  // wall). Capping visible lines keeps the frame short so it always clears.
  const termRows = process.stdout.rows || 24;
  const visibleCap = Math.max(5, Math.min(14, termRows - 10));
  const start = Math.max(0, lines.length - visibleCap);
  const visible = lines.slice(start);

  // Calm palette: cyan = app/system, green = you, magenta = partner, white = text.
  const icon = status === "chatting" ? "💬" : "🔎";
  const headline = status === "chatting" ? `you ⇄ ${partner}` : "finding you a dev…";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyanBright">DevRoulette</Text>
          <Text color="cyan">{online > 0 ? `● ${online} online` : ""}</Text>
        </Box>
        <Text color="cyan">{icon}  {headline}</Text>
      </Box>

      <Box flexDirection="column" marginY={1} paddingX={1}>
        {visible.map((l, i) =>
          l.kind === "sys" ? (
            <Text key={start + i} color="cyan">·  {l.body}</Text>
          ) : (
            <Text key={start + i}>
              <Text bold color={l.kind === "you" ? "green" : "magenta"}>{l.kind === "you" ? "you" : l.from ?? "?"}</Text>
              <Text color="white">{`  ${l.body}`}</Text>
            </Text>
          ),
        )}
      </Box>

      <Box paddingX={1}>
        <Text bold color={status === "chatting" ? "green" : "cyan"}>❯ </Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text>{renderAd(ad)}</Text>
        <Text color="cyan">{FOOTER}   ·   {GITHUB_FOOTER}</Text>
      </Box>
    </Box>
  );
}
