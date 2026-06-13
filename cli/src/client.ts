import { WebSocket, type RawData } from "ws";
import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import {
  ClientFrame,
  PROTOCOL_VERSION,
  POW_BITS,
  MAX_POW_BITS,
  sanitize,
  solvePow,
  MAX_MSG_LEN,
  type ServerFrame,
  type Ad,
} from "../../shared/src/protocol.js";
import { startLiveness, type Liveness } from "./liveness.js";

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Per-MACHINE match key sent to the server. Every connection from this machine
 * sends the SAME opaque key, so two windows / sessions / tasks on one computer can
 * never be matched with each other (no self-chat) — while two different machines
 * still pair. It's a sha256 of host+home (never the raw session id), so the server
 * can't reverse it. Session-on-NAT pairing still works (different machines differ).
 */
function machineKey(): string {
  return createHash("sha256").update(`${hostname()}\n${homedir()}`).digest("hex");
}

/** Resume tokens are always server-generated hex; reject anything else before it
 *  is ever echoed back as a header (defense in depth against a hostile server). */
function safeResumeToken(t: unknown): string | undefined {
  return typeof t === "string" && /^[a-f0-9]{1,64}$/.test(t) ? t : undefined;
}

/** Re-sanitize a server-supplied ad before it ever reaches a terminal or webview.
 *  The URL must be plain http(s) — anything else (javascript:, data:, file:, …) is
 *  dropped so a hostile/compromised server can't smuggle a dangerous link. */
function safeAd(ad: Ad | undefined): Ad | undefined {
  if (!ad || typeof ad.text !== "string") return undefined;
  const text = sanitize(ad.text).slice(0, 120).trim();
  if (!text) return undefined;
  const raw = typeof ad.url === "string" ? sanitize(ad.url).slice(0, 300).trim() : "";
  const url = /^https?:\/\//i.test(raw) ? raw : "";
  return { text, url };
}

export interface ClientOptions {
  /** Manual/dev mode (no real task). Heartbeats unconditionally. */
  debug?: boolean;
  /** Claude Code session id, used to locate the task transcript for liveness. */
  session?: string;
  /** One-time token to resume a room already matched in the background. When
   *  set, we skip PoW + queueing — the server drops us straight into the room. */
  resume?: string;
  /** Manual re-entry (user pressed X on the ended screen): no live task, so we
   *  heartbeat unconditionally. Unlike debug, this is a NORMAL connection — it
   *  sends no debug header (the server rejects debug sockets in production). */
  manual?: boolean;
}

/** Events the TUI reacts to. All text is already sanitized here. */
export type ClientEvent =
  | { t: "queued" }
  | { t: "online"; count: number; ad?: Ad }
  | { t: "matched"; you: string; partner: string; resumeToken?: string; ad?: Ad }
  | { t: "msg"; from: string; body: string }
  | { t: "partner_left" }
  | { t: "task_done" }
  | { t: "error"; msg: string }
  | { t: "banned"; until: number }
  | { t: "closed" };

/**
 * Thin WS client. Treats every inbound field as hostile: re-sanitizes ANSI /
 * control chars client-side (defense in depth — the server already strips, but
 * we never trust the wire). Never writes received content to disk, never
 * executes anything received.
 */
export class Client {
  private readonly ws: WebSocket;
  private partner = "";
  private liveness: Liveness | null = null;

  constructor(
    url: string,
    private readonly onEvent: (e: ClientEvent) => void,
    private readonly opts: ClientOptions = {},
  ) {
    const headers: Record<string, string> = {
      "x-devroulette-version": String(PROTOCOL_VERSION),
    };
    if (opts.debug) headers["x-devroulette-debug"] = "1";
    const resume = safeResumeToken(opts.resume);
    if (resume) headers["x-devroulette-resume"] = resume;
    // Always send the per-machine key so this computer never matches itself,
    // regardless of how many windows/sessions/tasks it has open.
    headers["x-devroulette-session"] = machineKey();
    this.ws = new WebSocket(url, { headers });
    // Do NOT join on open — wait for the proof-of-work challenge first. Start
    // heartbeats immediately so the server's liveness gate sees we're alive.
    this.ws.on("open", () => this.startHeartbeats());
    this.ws.on("message", (data: RawData) => this.onMessage(data.toString()));
    this.ws.on("close", () => {
      this.liveness?.stop();
      this.onEvent({ t: "closed" });
    });
    this.ws.on("error", () => {
      this.liveness?.stop();
      this.onEvent({ t: "closed" });
    });
  }

  private send(frame: ClientFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private startHeartbeats(): void {
    if (this.liveness) return;
    // Beat UNCONDITIONALLY while connected. We used to gate beats on the task
    // transcript growing, but a single long/thinking turn can stall file growth
    // for >25s and get a live user wrongly ejected mid-chat. The Stop hook is the
    // reliable "task ended" signal (it SIGTERMs us → quit/keep-chatting); a truly
    // dead client is still caught by the WebSocket ping/pong.
    this.liveness = startLiveness({
      session: this.opts.session,
      debug: this.opts.debug ?? false,
      alwaysAlive: true,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      onBeat: () => this.send({ t: "heartbeat" }),
    });
  }

  private onMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.t) {
      case "pow": {
        // NEVER trust the server's difficulty: a hostile/compromised server could
        // send a huge `bits` (or a giant prefix) to make solvePow loop ~forever and
        // freeze the client. Reject a malformed prefix and clamp bits to a ceiling.
        if (typeof frame.prefix !== "string" || frame.prefix.length === 0 || frame.prefix.length > 256) break;
        const want = Number(frame.bits);
        const bits = Number.isInteger(want) && want > 0 ? Math.min(want, MAX_POW_BITS) : POW_BITS;
        const nonce = solvePow(frame.prefix, bits);
        this.send({ t: "pow_solution", nonce });
        this.send({ t: "join_queue" });
        break;
      }
      case "queued":
        this.onEvent({ t: "queued" });
        break;
      case "online":
        this.onEvent({ t: "online", count: frame.count, ad: safeAd(frame.ad) });
        break;
      case "matched":
        this.partner = sanitize(frame.partner);
        this.onEvent({
          t: "matched",
          you: sanitize(frame.you),
          partner: this.partner,
          resumeToken: safeResumeToken(frame.resumeToken),
          ad: safeAd(frame.ad),
        });
        break;
      case "msg":
        this.onEvent({ t: "msg", from: this.partner, body: sanitize(frame.body) });
        break;
      case "partner_left":
        this.onEvent({ t: "partner_left" });
        break;
      case "task_done":
        this.onEvent({ t: "task_done" });
        break;
      case "error":
        this.onEvent({ t: "error", msg: sanitize(frame.msg) });
        break;
      case "banned":
        this.onEvent({ t: "banned", until: frame.until });
        break;
    }
  }

  sendMsg(body: string): void {
    const clean = sanitize(body).slice(0, MAX_MSG_LEN);
    if (clean.length > 0) this.send({ t: "msg", body: clean });
  }

  skip(): void {
    this.send({ t: "skip" });
  }

  report(): void {
    this.send({ t: "report" });
  }

  /** Room teardown path — tell the server the task is done, then close. */
  quit(): void {
    this.send({ t: "task_done" });
    this.ws.close();
  }
}
