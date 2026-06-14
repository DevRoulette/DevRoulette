import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  ClientFrame,
  PROTOCOL_VERSION,
  POW_BITS,
  sanitize,
  verifyPow,
  MAX_MSG_LEN,
  type ServerFrame,
  type Ad,
} from "../../shared/src/protocol.js";

// ---- config / limits (all non-negotiable per spec) ----
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1"; // bind localhost; Caddy terminates TLS
const MAX_PAYLOAD = 16 * 1024; // reject oversized frames at the protocol level
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP ?? 3);
const MAX_JOINS_PER_MIN = Number(process.env.MAX_JOINS_PER_MIN ?? 5);
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS ?? 5000); // global connection ceiling
const MAX_MSGS_PER_ROOM = 200;
const MSG_RATE_MS = 1000; // max 1 msg/sec per socket
const SKIP_MIN_MS = 500; // min interval between skips per socket (anti-churn)
const POW_DEADLINE_MS = Number(process.env.POW_DEADLINE_MS ?? 10_000); // solve PoW or get dropped
const BAN_MS = 15 * 60 * 1000;
const VIOLATION_LIMIT = 5;
const HEARTBEAT_MS = 15_000; // dead sockets killed within ~2 beats (<=30s)
const IDLE_ROOM_MS = 10 * 60 * 1000;

// ---- liveness / anti-bot gating (addendum) ----
// Production rejects debug-mode connections unless explicitly allowed.
const ALLOW_DEBUG = process.env.DEVROULETTE_ALLOW_DEBUG === "1";
// Clients heartbeat every ~10s while their Claude task transcript is growing.
// Miss 2 in a row (no beat for >LIVENESS_TIMEOUT_MS) and we eject: no live task,
// no staying. A grace window covers the initial connect + PoW handshake.
const LIVENESS_TIMEOUT_MS = Number(process.env.LIVENESS_TIMEOUT_MS ?? 25_000);
const LIVENESS_GRACE_MS = Number(process.env.LIVENESS_GRACE_MS ?? 20_000);
const LIVENESS_CHECK_MS = Number(process.env.LIVENESS_CHECK_MS ?? 5_000);

// ---- anonymous dev-joke handles (server-assigned; no user-chosen names) ----
const ADJECTIVES = [
  "Segfault", "Regex", "NullPointer", "Async", "Recursive", "Quantum", "Verbose",
  "Idempotent", "Stale", "Heisen", "Dangling", "Bikeshed", "Rubber", "Cursed",
  "Flaky", "Eventual", "Lazy", "Greedy", "Borrow", "Yak",
];
const NOUNS = [
  "Panda", "Wizard", "Ninja", "Goblin", "Llama", "Raptor", "Walrus", "Gremlin",
  "Yeti", "Otter", "Badger", "Hamster", "Phoenix", "Kraken", "Sloth", "Mongoose",
  "Narwhal", "Penguin", "Cobra", "Moth",
];

function randomHandle(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

interface ConnMeta {
  id: string;
  ip: string;
  // Stable per-origin key used to avoid matching a machine with ITSELF (a
  // churning chat window, a leftover watcher). Set from the client's Claude
  // session id; absent → a random uuid so the socket never blocks a match.
  // Keyed on session (not IP) so two different machines behind the same NAT
  // can still match each other.
  matchKey: string;
  handle: string;
  alive: boolean;
  roomId: string | null;
  queued: boolean;
  lastMsgAt: number;
  // anti-bot proof-of-work: join_queue is refused until solved
  powPrefix: string;
  powOk: boolean;
  // anti-churn: timestamp of the last skip/report re-queue
  lastSkipAt: number;
  // PoW handshake deadline: a non-solver is dropped when this fires
  powTimer: ReturnType<typeof setTimeout> | null;
  // liveness: last heartbeat (task transcript still growing); set at connect
  connectedAt: number;
  lastHeartbeatAt: number;
  debug: boolean;
}
interface IpMeta {
  sockets: number;
  joinTimes: number[];
  violations: number;
  bannedUntil: number;
}
interface Room {
  id: string;
  members: WebSocket[];
  msgCount: number;
  lastActivity: number;
  tokens: string[]; // outstanding one-time resume tokens for this room
}

const conns = new Map<WebSocket, ConnMeta>();
const ips = new Map<string, IpMeta>();
const rooms = new Map<string, Room>();
const queue: WebSocket[] = [];
// One-time tokens that let a background (headless) queue socket hand its live
// room off to a freshly-opened chat window without re-queuing or dropping the
// partner. token -> the room + the socket currently holding that seat.
const resumeTokens = new Map<string, { roomId: string; ws: WebSocket }>();

// Abuse-report tally, keyed by the REPORTED ip. Tracks raw report count AND the
// number of DISTINCT reporter IPs — the latter is what matters, since one person
// spam-reporting can't inflate it. In-memory only: NO chat content is ever stored;
// this is anti-abuse metadata that resets on restart. The operator reviews it in
// the admin dashboard and blocks bad IPs by hand (reports never auto-ban).
interface ReportRec {
  count: number;
  first: number;
  last: number;
  reporters: Set<string>;
}
const reports = new Map<string, ReportRec>();
const MAX_REPORT_IPS = 5000;

// ---- usage stats: per-UTC-day buckets, PERSISTED to a volume so they survive
// restarts/redeploys (otherwise every deploy reset them to 0). No chat content —
// just counts of connections / convos / messages + distinct match-keys (≈ people).
const serverStart = Date.now();
const DAY_MS = 86_400_000;
const MAX_DAYS = 120;
const MAX_MACHINES_PER_DAY = 20_000;
const MAX_ALL_MACHINES = 100_000;

interface DayBucket { conns: number; convos: number; msgs: number; machines: Set<string> }
const byDay = new Map<string, DayBucket>();
const allTime = { conns: 0, convos: 0, msgs: 0 };
const allMachines = new Set<string>();

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function bucket(d: string): DayBucket {
  let b = byDay.get(d);
  if (!b) {
    b = { conns: 0, convos: 0, msgs: 0, machines: new Set() };
    byDay.set(d, b);
    if (byDay.size > MAX_DAYS) byDay.delete([...byDay.keys()].sort()[0]);
  }
  return b;
}
function recordConn(matchKey: string): void {
  const b = bucket(dayKey(Date.now()));
  b.conns += 1;
  allTime.conns += 1;
  if (b.machines.size < MAX_MACHINES_PER_DAY) b.machines.add(matchKey);
  if (allMachines.size < MAX_ALL_MACHINES) allMachines.add(matchKey);
  statsDirty = true;
}
function recordMatch(): void { bucket(dayKey(Date.now())).convos += 1; allTime.convos += 1; statsDirty = true; }
function recordMsg(): void { bucket(dayKey(Date.now())).msgs += 1; allTime.msgs += 1; statsDirty = true; }

// sum a counter field over the last n calendar days (today inclusive)
function sumDays(field: "conns" | "convos" | "msgs", n: number): number {
  const cutoff = dayKey(Date.now() - (n - 1) * DAY_MS);
  let s = 0;
  for (const [d, b] of byDay) if (d >= cutoff) s += b[field];
  return s;
}
// distinct people over the last n days (union of the per-day match-key sets)
function peopleDays(n: number): number {
  const cutoff = dayKey(Date.now() - (n - 1) * DAY_MS);
  const u = new Set<string>();
  for (const [d, b] of byDay) if (d >= cutoff) for (const m of b.machines) u.add(m);
  return u.size;
}

// ---- persistence (Railway volume; default mount /data) ----
const STATS_DIR = process.env.STATS_DIR || "/data";
const STATS_FILE = `${STATS_DIR}/stats.json`;
let persistOn = false;
let statsDirty = false;
function loadStats(): void {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    writeFileSync(`${STATS_DIR}/.probe`, "ok"); // writability probe
    persistOn = true;
    if (existsSync(STATS_FILE)) {
      const j = JSON.parse(readFileSync(STATS_FILE, "utf8")) as {
        allTime?: { conns?: number; convos?: number; msgs?: number };
        allMachines?: string[];
        byDay?: Record<string, { conns?: number; convos?: number; msgs?: number; machines?: string[] }>;
      };
      if (j.allTime) { allTime.conns = j.allTime.conns ?? 0; allTime.convos = j.allTime.convos ?? 0; allTime.msgs = j.allTime.msgs ?? 0; }
      for (const m of j.allMachines ?? []) allMachines.add(m);
      for (const [d, b] of Object.entries(j.byDay ?? {})) {
        byDay.set(d, { conns: b.conns ?? 0, convos: b.convos ?? 0, msgs: b.msgs ?? 0, machines: new Set(b.machines ?? []) });
      }
    }
  } catch {
    persistOn = false; // no volume (e.g. local dev) → in-memory only
  }
}
function saveStats(): void {
  if (!persistOn) return;
  try {
    const byDayObj: Record<string, { conns: number; convos: number; msgs: number; machines: string[] }> = {};
    for (const [d, b] of byDay) byDayObj[d] = { conns: b.conns, convos: b.convos, msgs: b.msgs, machines: [...b.machines] };
    writeFileSync(STATS_FILE, JSON.stringify({ allTime, allMachines: [...allMachines], byDay: byDayObj }));
    statsDirty = false;
  } catch { /* ignore a transient write error; next tick retries */ }
}
loadStats();

// npm download counts — the real "is it being used" signal (survives restarts).
// Cached 1h; every call is wrapped so a slow/down npm never blocks the dashboard.
let npmCache: { at: number; day: number | null; week: number | null; month: number | null } = {
  at: 0, day: null, week: null, month: null,
};
async function npmDownloads(): Promise<{ day: number | null; week: number | null; month: number | null }> {
  if (npmCache.at && Date.now() - npmCache.at < 3_600_000) return npmCache;
  const pull = async (range: string): Promise<number | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`https://api.npmjs.org/downloads/point/${range}/devroulette-cli`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const j = (await r.json()) as { downloads?: number };
      return typeof j.downloads === "number" ? j.downloads : null;
    } catch {
      return null;
    }
  };
  const [day, week, month] = await Promise.all([pull("last-day"), pull("last-week"), pull("last-month")]);
  npmCache = { at: Date.now(), day, week, month };
  return npmCache;
}

// Number of trusted reverse-proxy hops in front of us. Default 0 = trust NOTHING,
// use the direct socket peer and ignore X-Forwarded-For entirely (safe when bound
// to localhost or exposed directly). Operators behind a proxy MUST set this to the
// real hop count (e.g. Caddy-only = 1; Railway-edge + Caddy = 2) so per-IP limits
// key on the true client IP and not a spoofable header. Getting it wrong only
// over-attributes clients to one IP — it never trusts the client-supplied leftmost.
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);

// ---- operator moderation (admin dashboard + IP blocklist) ----
// A secret key gates the admin dashboard. UNSET → the dashboard is fully disabled
// (returns 404), so it can never be reached without an explicit opt-in.
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
// Permanent, operator-controlled IP blocklist from the BLOCKLIST env (comma or
// whitespace separated). These survive restarts. The admin dashboard can also add
// RUNTIME blocks (instant, but lost on restart — persist by adding the IP to
// BLOCKLIST and redeploying).
const envBlocks = new Set(
  (process.env.BLOCKLIST ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
);
const runtimeBlocks = new Set<string>();

function ipOf(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "unknown";
  const xff = req.headers["x-forwarded-for"];
  if (TRUSTED_PROXY_HOPS <= 0 || typeof xff !== "string" || xff.length === 0) return direct;
  // X-Forwarded-For is appended left→right as the request crosses proxies, so the
  // RIGHTMOST entries are the ones our own infra added and can be trusted; the
  // leftmost is client-supplied and trivially spoofable. Count back from the right
  // by the number of trusted hops — never trust the leftmost value.
  const parts = xff.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return direct;
  return parts[Math.max(0, parts.length - TRUSTED_PROXY_HOPS)];
}

function ipMeta(ip: string): IpMeta {
  let m = ips.get(ip);
  if (!m) {
    m = { sockets: 0, joinTimes: [], violations: 0, bannedUntil: 0 };
    ips.set(ip, m);
  }
  return m;
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

// Optional server-swappable ad shown in the client (no client release needed —
// set AD_TEXT / AD_URL in the environment and restart). Sanitised before relay so
// a stray control char in the config can't reach a terminal. Empty → house ad.
function currentAd(): Ad | undefined {
  const text = sanitize(process.env.AD_TEXT ?? "").slice(0, 120).trim();
  if (!text) return undefined;
  const url = sanitize(process.env.AD_URL ?? "").slice(0, 300).trim();
  return { text, url };
}

/** Count a violation; once over the limit, temp-ban the IP and drop its sockets. */
function recordViolation(ip: string): void {
  const m = ipMeta(ip);
  m.violations += 1;
  if (m.violations >= VIOLATION_LIMIT && m.bannedUntil <= Date.now()) {
    m.bannedUntil = Date.now() + BAN_MS;
    // Reset the counter when the ban is issued so a fresh VIOLATION_LIMIT is
    // required for the next one — otherwise the counter only ever grows and a
    // once-banned IP becomes permanently re-bannable by a single violation.
    m.violations = 0;
    for (const [ws, meta] of conns) {
      if (meta.ip === ip) {
        send(ws, { t: "banned", until: m.bannedUntil });
        ws.close(4003, "banned");
      }
    }
  }
}

/** True if another currently-queued socket already holds this matchKey. Used to
 *  cap each session/match-key to ONE queued socket — without it, an attacker who
 *  reuses one session id across many sockets parks an unmatchable cluster that
 *  eclipses the pool and captures every real joiner. */
function matchKeyAlreadyQueued(matchKey: string, except: WebSocket): boolean {
  for (const ws of queue) {
    if (ws === except) continue;
    const m = conns.get(ws);
    if (m && m.matchKey === matchKey) return true;
  }
  return false;
}

function leaveQueue(ws: WebSocket): void {
  const i = queue.indexOf(ws);
  if (i !== -1) queue.splice(i, 1);
  const meta = conns.get(ws);
  if (meta) meta.queued = false;
}

function destroyRoom(roomId: string, except: WebSocket | null, reason: ServerFrame): void {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  for (const tok of room.tokens) resumeTokens.delete(tok);
  for (const ws of room.members) {
    const meta = conns.get(ws);
    if (meta) meta.roomId = null;
    if (ws !== except) send(ws, reason);
  }
}

function partnerOf(ws: WebSocket): WebSocket | null {
  const meta = conns.get(ws);
  if (!meta?.roomId) return null;
  const room = rooms.get(meta.roomId);
  if (!room) return null;
  return room.members.find((m) => m !== ws) ?? null;
}

function tryMatch(): void {
  // Drop dead/closed sockets so the random pool below is all live entries.
  for (let k = queue.length - 1; k >= 0; k--) {
    const m = conns.get(queue[k]);
    if (!m || queue[k].readyState !== WebSocket.OPEN) queue.splice(k, 1);
  }
  // Roulette pairing: pick a RANDOM queued dev and a RANDOM eligible partner,
  // not FIFO head + first neighbour (which made the same pairs stick). Never pair
  // two sockets with the same matchKey — that's a machine matching itself (a
  // churning chat window, a leftover watcher) and is the source of window floods.
  // Keying on session (not IP) lets two machines on the same NAT still match.
  const pool = [...queue]; // working set for this pass; survivors stay queued
  while (pool.length >= 2) {
    const ai = Math.floor(Math.random() * pool.length);
    const a = pool[ai];
    const ma = conns.get(a)!;
    const eligible: number[] = [];
    for (let k = 0; k < pool.length; k++) {
      if (k === ai) continue;
      if (conns.get(pool[k])!.matchKey !== ma.matchKey) eligible.push(k);
    }
    if (eligible.length === 0) {
      pool.splice(ai, 1); // a has no different-session partner this pass — set aside
      continue;
    }
    const bi = eligible[Math.floor(Math.random() * eligible.length)];
    const b = pool[bi];
    const mb = conns.get(b)!;
    // remove the matched pair from both the working pool and the real queue
    pool.splice(Math.max(ai, bi), 1);
    pool.splice(Math.min(ai, bi), 1);
    leaveQueue(a);
    leaveQueue(b);
    ma.queued = false;
    mb.queued = false;
    if (ma.handle === mb.handle) mb.handle = randomHandle();
    const id = randomUUID();
    // one-time resume token per seat: lets each side's background socket hand
    // the live room to its chat window the moment it opens.
    const tokenA = randomBytes(24).toString("hex");
    const tokenB = randomBytes(24).toString("hex");
    rooms.set(id, { id, members: [a, b], msgCount: 0, lastActivity: Date.now(), tokens: [tokenA, tokenB] });
    resumeTokens.set(tokenA, { roomId: id, ws: a });
    resumeTokens.set(tokenB, { roomId: id, ws: b });
    ma.roomId = id;
    mb.roomId = id;
    const ad = currentAd();
    send(a, { t: "matched", roomId: id, you: ma.handle, partner: mb.handle, resumeToken: tokenA, ad });
    send(b, { t: "matched", roomId: id, you: mb.handle, partner: ma.handle, resumeToken: tokenB, ad });
    recordMatch();
    console.log(`[match] ${ma.handle} ⇄ ${mb.handle} (room ${id})`);
  }
}

/**
 * Resume an existing room from a new (chat-window) socket, swapping out the
 * background socket that currently holds the seat. No re-queue, no partner_left:
 * the partner never notices the handoff.
 */
function tryResume(ws: WebSocket, meta: ConnMeta, token: string): boolean {
  const info = resumeTokens.get(token);
  if (!info) return false;
  resumeTokens.delete(token);
  const room = rooms.get(info.roomId);
  if (!room) return false;
  room.tokens = room.tokens.filter((t) => t !== token);
  const oldWs = info.ws;
  const idx = room.members.indexOf(oldWs);
  if (idx === -1) return false; // seat already vacated — can't resume
  room.members[idx] = ws;
  const oldMeta = conns.get(oldWs);
  meta.handle = oldMeta?.handle ?? meta.handle;
  meta.roomId = room.id;
  meta.powOk = true; // token possession is the gate; PoW already passed in bg
  meta.queued = false;
  // detach the old socket WITHOUT tearing down the room, then close it
  if (oldMeta) oldMeta.roomId = null;
  if (oldWs !== ws) {
    try {
      oldWs.close(4007, "resumed");
    } catch {
      /* already gone */
    }
  }
  const partner = room.members.find((m) => m !== ws) ?? null;
  const pm = partner ? conns.get(partner) : null;
  send(ws, { t: "matched", roomId: room.id, you: meta.handle, partner: pm?.handle ?? "?", ad: currentAd() });
  room.lastActivity = Date.now();
  return true;
}

function onFrame(ws: WebSocket, meta: ConnMeta, frame: ClientFrame): void {
  switch (frame.t) {
    case "pow_solution": {
      if (meta.powOk) return;
      if (verifyPow(meta.powPrefix, frame.nonce, POW_BITS)) {
        meta.powOk = true;
        if (meta.powTimer) {
          clearTimeout(meta.powTimer);
          meta.powTimer = null;
        }
      } else {
        recordViolation(meta.ip);
      }
      return;
    }
    case "heartbeat": {
      // task transcript still growing → still alive. Refresh the liveness clock.
      meta.lastHeartbeatAt = Date.now();
      return;
    }
    case "join_queue": {
      if (!meta.powOk) {
        send(ws, { t: "error", code: "pow_required", msg: "proof-of-work not solved" });
        return;
      }
      if (meta.roomId || meta.queued) return;
      // One queued socket per session/match-key: blocks the queue-eclipse attack
      // where many sockets share one session id to capture every real user.
      if (matchKeyAlreadyQueued(meta.matchKey, ws)) return;
      const m = ipMeta(meta.ip);
      const now = Date.now();
      m.joinTimes = m.joinTimes.filter((t) => now - t < 60_000);
      if (m.joinTimes.length >= MAX_JOINS_PER_MIN) {
        recordViolation(meta.ip);
        return;
      }
      m.joinTimes.push(now);
      meta.queued = true;
      queue.push(ws);
      send(ws, { t: "queued" });
      console.log(`[queue] joined (queue size=${queue.length})`);
      tryMatch();
      return;
    }
    case "msg": {
      const room = meta.roomId ? rooms.get(meta.roomId) : undefined;
      if (!room) return;
      const now = Date.now();
      if (now - meta.lastMsgAt < MSG_RATE_MS) {
        recordViolation(meta.ip);
        return;
      }
      meta.lastMsgAt = now;
      if (room.msgCount >= MAX_MSGS_PER_ROOM) {
        destroyRoom(room.id, null, { t: "error", code: "room_full", msg: "message limit reached" });
        return;
      }
      const body = sanitize(frame.body).slice(0, MAX_MSG_LEN);
      if (body.length === 0) return;
      room.msgCount += 1;
      room.lastActivity = now;
      recordMsg();
      const partner = partnerOf(ws);
      if (partner) send(partner, { t: "msg", body });
      return;
    }
    case "skip": {
      if (!meta.powOk) return; // never solved PoW → cannot queue via skip
      const now = Date.now();
      if (now - meta.lastSkipAt < SKIP_MIN_MS) return; // anti-churn throttle
      meta.lastSkipAt = now;
      if (meta.roomId) destroyRoom(meta.roomId, ws, { t: "partner_left" });
      if (!meta.queued && !matchKeyAlreadyQueued(meta.matchKey, ws)) {
        meta.queued = true;
        queue.push(ws);
        send(ws, { t: "queued" });
        tryMatch();
      }
      return;
    }
    case "task_done": {
      if (meta.roomId) destroyRoom(meta.roomId, ws, { t: "task_done" });
      leaveQueue(ws);
      return;
    }
    case "report": {
      // Log the report against the partner's IP, then get the reporter out of the
      // room. Deliberately NO automatic ban: anonymous, IP-spoofable reports must
      // never drive bans by themselves (that was a one-click way to ban any user).
      // The tally is for the OPERATOR to review and block by hand.
      const reported = partnerOf(ws);
      if (reported) {
        const pm = conns.get(reported);
        if (pm) recordReport(pm.ip, meta.ip);
      }
      if (meta.roomId) destroyRoom(meta.roomId, ws, { t: "partner_left" });
      return;
    }
  }
}

function isBlocked(ip: string): boolean {
  return envBlocks.has(ip) || runtimeBlocks.has(ip);
}

/** Add a runtime block and immediately drop any live sockets from that IP. Runtime
 *  blocks are instant but reset on restart — persist by adding the IP to BLOCKLIST
 *  and redeploying. */
function blockIp(ip: string): void {
  if (!ip) return;
  runtimeBlocks.add(ip);
  const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
  for (const [ws, meta] of conns) {
    if (meta.ip === ip) {
      send(ws, { t: "banned", until: farFuture });
      ws.close(4003, "blocked");
    }
  }
  console.log(`[block] runtime block added (total runtime blocks=${runtimeBlocks.size})`);
}

function unblockIp(ip: string): void {
  if (runtimeBlocks.delete(ip)) console.log(`[unblock] runtime block removed`);
}

/** Record an abuse report against the reported IP (distinct reporters tracked). */
function recordReport(reportedIp: string, reporterIp: string): void {
  let r = reports.get(reportedIp);
  if (!r) {
    if (reports.size >= MAX_REPORT_IPS) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of reports) if (v.last < oldestAt) { oldestAt = v.last; oldest = k; }
      if (oldest) reports.delete(oldest);
    }
    r = { count: 0, first: Date.now(), last: 0, reporters: new Set<string>() };
    reports.set(reportedIp, r);
  }
  r.count += 1;
  r.last = Date.now();
  r.reporters.add(reporterIp);
  console.log(`[report] logged (reports=${r.count}, distinct reporters=${r.reporters.size})`);
}

function esc(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  try { return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC"; } catch { return "—"; }
}

/** The operator's moderation dashboard (HTML): reported IPs sorted by distinct
 *  reporters, one-click block/unblock, and the active blocklist. */
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Distinct people currently connected (by match-key) — someone with several
 *  windows open counts ONCE. The honest "online" number, used for both the
 *  dashboard and the client's "● N online" so they always agree. */
function onlineCount(): number {
  const s = new Set<string>();
  for (const m of conns.values()) s.add(m.matchKey);
  return s.size;
}

/** Live usage numbers — used by both the dashboard render and the JSON poll
 *  endpoint so they stay consistent. */
function liveStats(npm: { day: number | null; week: number | null; month: number | null }) {
  const tb = byDay.get(dayKey(Date.now()));
  return {
    // live (exact, right now)
    online: onlineCount(),
    ongoing: rooms.size,
    waiting: queue.length,
    // connections
    connToday: tb?.conns ?? 0, conn7: sumDays("conns", 7), conn30: sumDays("conns", 30), connAll: allTime.conns,
    // convos started
    convoToday: tb?.convos ?? 0, convo7: sumDays("convos", 7), convo30: sumDays("convos", 30), convoAll: allTime.convos,
    // distinct people (match-keys)
    pplToday: tb?.machines.size ?? 0, ppl7: peopleDays(7), ppl30: peopleDays(30), pplAll: allMachines.size,
    // messages
    msgToday: tb?.msgs ?? 0, msg7: sumDays("msgs", 7), msg30: sumDays("msgs", 30), msgAll: allTime.msgs,
    npmDay: npm.day, npmWeek: npm.week, npmMonth: npm.month,
    uptimeMs: Date.now() - serverStart,
    persisted: persistOn,
  };
}

function reportsDashboardHtml(npm: { day: number | null; week: number | null; month: number | null }): string {
  const s = liveStats(npm);
  const npmCell = (n: number | null): string => (n === null ? "n/a" : String(n));
  const card = (id: string, value: string, label: string): string =>
    `<div class="card"><div class="cv" id="${id}">${esc(value)}</div><div class="cl">${label}</div></div>`;
  const liveStrip =
    `<div class="grid3">` +
    card("s-online", String(s.online), "online now") +
    card("s-ongoing", String(s.ongoing), "ongoing convos") +
    card("s-waiting", String(s.waiting), "waiting") +
    `</div>`;
  const r = (m: string, today: number, d7: number, d30: number, all: number): string =>
    `<tr><td class="metric">${m}</td><td class="num" id="s-${m}T">${today}</td><td class="num" id="s-${m}7">${d7}</td>` +
    `<td class="num" id="s-${m}30">${d30}</td><td class="num" id="s-${m}A">${all}</td></tr>`;
  const statsTable =
    `<table class="stbl"><tr><th>metric</th><th>today</th><th>7&#8209;day</th><th>30&#8209;day</th><th>all&#8209;time</th></tr>` +
    r("connected", s.connToday, s.conn7, s.conn30, s.connAll) +
    r("convos", s.convoToday, s.convo7, s.convo30, s.convoAll) +
    r("people", s.pplToday, s.ppl7, s.ppl30, s.pplAll) +
    r("messages", s.msgToday, s.msg7, s.msg30, s.msgAll) +
    `</table>`;
  const statsPanel = liveStrip + statsTable +
    `<p class="sub" style="max-width:880px"><span class="live">● live</span> · refreshes every 5s · uptime ${fmtDur(s.uptimeMs)} · ` +
    `npm installs (d/w/m): <b id="s-npm">${npmCell(s.npmDay)} / ${npmCell(s.npmWeek)} / ${npmCell(s.npmMonth)}</b> · ` +
    `${s.persisted ? "persisted ✓ survives restarts" : "<b style='color:#ff7b72'>in-memory — add a volume to persist</b>"}</p>`;

  const rows = [...reports.entries()].sort(
    (a, b) => b[1].reporters.size - a[1].reporters.size || b[1].count - a[1].count,
  );
  const body = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No reports yet.</td></tr>`
    : rows.map(([ip, r]) => {
        const blocked = isBlocked(ip);
        const env = envBlocks.has(ip);
        const hot = r.reporters.size >= 3 ? " hot" : "";
        const action = env
          ? `<span class="muted">env blocklist</span>`
          : blocked
            ? `<a class="btn unblock" href="/admin/unblock?ip=${encodeURIComponent(ip)}">unblock</a>`
            : `<a class="btn block" href="/admin/block?ip=${encodeURIComponent(ip)}">block</a>`;
        return `<tr class="${hot}"><td class="ip">${esc(ip)}${blocked ? ' <span class="tag">blocked</span>' : ""}</td><td class="num">${r.reporters.size}</td><td class="num">${r.count}</td><td>${fmtTime(r.first)}</td><td>${fmtTime(r.last)}</td><td>${action}</td></tr>`;
      }).join("");
  const envList = [...envBlocks].map(esc).join(", ") || "—";
  const rtList = [...runtimeBlocks].map((ip) =>
    `${esc(ip)} <a class="btn unblock" href="/admin/unblock?ip=${encodeURIComponent(ip)}">unblock</a>`,
  ).join(" · ") || "—";
  return `<!doctype html><html><head><meta charset="utf-8"><title>DevRoulette · reports</title>
<style>
  body{margin:0;background:#0f1419;color:#e6edf3;font:15px/1.5 -apple-system,Segoe UI,sans-serif;padding:28px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#aebccb;margin:0 0 20px}
  table{border-collapse:collapse;width:100%;max-width:880px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #243140}
  th{color:#aebccb;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
  td.num{font-variant-numeric:tabular-nums}
  td.ip{font-family:ui-monospace,monospace}
  tr.hot td.num{color:#ff7b72;font-weight:700}
  .tag{background:#ff7b72;color:#0f1419;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700}
  .btn{display:inline-block;padding:3px 10px;border-radius:5px;text-decoration:none;font-size:13px}
  .block{background:#ff7b72;color:#0f1419}
  .unblock{background:#2d3742;color:#e6edf3}
  .muted{color:#aebccb}
  .empty{color:#aebccb;text-align:center;padding:24px}
  .panel{margin-top:24px;max-width:880px;background:#161b22;border:1px solid #243140;border-radius:8px;padding:14px 18px}
  .panel b{color:#e6edf3}
  code{background:#243140;padding:1px 6px;border-radius:4px;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;max-width:880px;margin:0 0 8px}
  .card{background:#161b22;border:1px solid #243140;border-radius:8px;padding:12px 14px}
  .cv{font-size:23px;font-weight:700;color:#7ee787;font-variant-numeric:tabular-nums;word-break:break-word}
  .cl{font-size:12px;color:#aebccb;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
  .ch{font-size:11px;color:#6e7d8d;margin-top:2px}
  h2{font-size:16px;margin:28px 0 6px}
  .live{color:#7ee787;font-weight:700}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:880px;margin:0 0 16px}
  .stbl{border-collapse:collapse;width:100%;max-width:880px;margin:0 0 8px}
  .stbl th{color:#aebccb;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;text-align:right;padding:7px 16px;border-bottom:1px solid #243140}
  .stbl th:first-child{text-align:left}
  .stbl td{padding:9px 16px;border-bottom:1px solid #1b2530;text-align:right;font-variant-numeric:tabular-nums;font-size:16px}
  .stbl td.metric{text-align:left;color:#e6edf3}
  .stbl td.num{color:#7ee787;font-weight:700}
</style></head><body>
  <h1>DevRoulette — dashboard</h1>
  <button id="sndbtn" style="background:#161b22;color:#e6edf3;border:1px solid #243140;border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer;margin:0 0 14px">🔔 connect alerts: off — click to enable</button>
  ${statsPanel}
  <h2>Abuse reports</h2>
  <p class="sub">Sorted by distinct reporters. Counts reset when the server restarts.</p>
  <table>
    <tr><th>reported IP</th><th>distinct reporters</th><th>total reports</th><th>first</th><th>last</th><th></th></tr>
    ${body}
  </table>
  <div class="panel">
    <p><b>Permanent blocklist</b> (BLOCKLIST env): ${envList}</p>
    <p><b>Runtime blocks</b> (lost on restart): ${rtList}</p>
    <p class="muted">A <code>block</code> here is instant but temporary. To block <b>permanently</b>, add the IP to the <code>BLOCKLIST</code> env on Railway (comma-separated) and redeploy.</p>
  </div>
<script>
  // Live-refresh the stat cards every 5s (no full reload, no flicker). The fetch
  // carries the same Basic-Auth credentials the browser already cached for /admin/*.
  (function () {
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = String(v); };
    // Operator alert: a distinct rising chime (Web Audio — NOT a system/app sound)
    // every time a new connection lands. Browsers need one click to allow audio.
    var soundOn = false, lastConn = ${s.connAll}, audio = null;
    function ding() {
      try {
        if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
        var t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
        o.connect(g); g.connect(audio.destination); o.type = 'sine';
        o.frequency.setValueAtTime(660, t);
        o.frequency.exponentialRampToValueAtTime(990, t + 0.14);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
        o.start(t); o.stop(t + 0.34);
      } catch (e) { /* audio not available */ }
    }
    var btn = document.getElementById('sndbtn');
    if (btn) btn.addEventListener('click', function () {
      soundOn = !soundOn;
      btn.textContent = soundOn ? '🔔 connect alerts: ON' : '🔔 connect alerts: off — click to enable';
      btn.style.borderColor = soundOn ? '#7ee787' : '#243140';
      if (soundOn) { try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) {} ding(); }
    });
    async function tick() {
      try {
        var r = await fetch('/admin/stats', { cache: 'no-store' });
        if (!r.ok) return;
        var s = await r.json();
        if (soundOn && s.connAll > lastConn) ding();
        lastConn = s.connAll;
        set('s-online', s.online); set('s-ongoing', s.ongoing); set('s-waiting', s.waiting);
        set('s-connectedT', s.connToday); set('s-connected7', s.conn7); set('s-connected30', s.conn30); set('s-connectedA', s.connAll);
        set('s-convosT', s.convoToday); set('s-convos7', s.convo7); set('s-convos30', s.convo30); set('s-convosA', s.convoAll);
        set('s-peopleT', s.pplToday); set('s-people7', s.ppl7); set('s-people30', s.ppl30); set('s-peopleA', s.pplAll);
        set('s-messagesT', s.msgToday); set('s-messages7', s.msg7); set('s-messages30', s.msg30); set('s-messagesA', s.msgAll);
        var c = function (n) { return (n === null || n === undefined) ? 'n/a' : n; };
        set('s-npm', c(s.npmDay) + ' / ' + c(s.npmWeek) + ' / ' + c(s.npmMonth));
      } catch (e) { /* ignore a hiccup; try again next tick */ }
    }
    setInterval(tick, 5000);
  })();
</script>
</body></html>`;
}

/** Constant-time HTTP Basic Auth against ADMIN_KEY. The key travels in the
 *  Authorization header (NOT the URL), so it never lands in request-path logs or
 *  browser history. Any username is accepted; the password must equal ADMIN_KEY. */
function adminAuthed(req: IncomingMessage): boolean {
  if (!ADMIN_KEY) return false;
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Basic ")) return false;
  let pass = "";
  try {
    const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    pass = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return false;
  }
  const a = Buffer.from(pass);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleAdmin(req: IncomingMessage, path: string, url: URL, res: ServerResponse): Promise<void> {
  // Dashboard is OFF unless an ADMIN_KEY is configured — never reachable by default.
  if (!ADMIN_KEY) { res.writeHead(404); res.end("not found"); return; }
  if (!adminAuthed(req)) {
    res.writeHead(401, {
      "content-type": "text/plain",
      "WWW-Authenticate": 'Basic realm="DevRoulette admin", charset="UTF-8"',
    });
    res.end("unauthorized");
    return;
  }
  if (path === "/admin/stats") {
    const npm = await npmDownloads();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(liveStats(npm)));
    return;
  }
  if (path === "/admin/reports") {
    const npm = await npmDownloads();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(reportsDashboardHtml(npm));
    return;
  }
  if (path === "/admin/block" || path === "/admin/unblock") {
    const ip = (url.searchParams.get("ip") ?? "").trim();
    if (path === "/admin/block") blockIp(ip); else unblockIp(ip);
    res.writeHead(302, { location: "/admin/reports" }); // key stays in the auth header, never the URL
    res.end();
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/admin/")) {
    void handleAdmin(req, url.pathname, url, res).catch(() => {
      try { res.writeHead(500); res.end("error"); } catch { /* already sent */ }
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("devroulette ok");
}

const httpServer = createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  if (req.headers["x-devroulette-version"] !== String(PROTOCOL_VERSION)) {
    ws.close(4001, "bad protocol version");
    return;
  }
  // Debug-mode connections (manual queue join, no real task) are rejected in
  // production unless the operator explicitly opts in.
  const debug = req.headers["x-devroulette-debug"] === "1";
  if (debug && !ALLOW_DEBUG) {
    ws.close(4004, "debug mode disabled");
    return;
  }
  // Global connection ceiling: caps total memory/CPU regardless of per-IP limits
  // (which a spoofed X-Forwarded-For could otherwise dilute).
  if (conns.size >= MAX_TOTAL_SOCKETS) {
    ws.close(4009, "server at capacity");
    return;
  }
  const ip = ipOf(req);
  // Permanent operator blocklist: refuse before anything else.
  if (isBlocked(ip)) {
    send(ws, { t: "banned", until: Date.now() + 365 * 24 * 60 * 60 * 1000 });
    ws.close(4003, "blocked");
    return;
  }
  const m = ipMeta(ip);
  const now = Date.now();
  if (m.bannedUntil > now) {
    send(ws, { t: "banned", until: m.bannedUntil });
    ws.close(4003, "banned");
    return;
  }
  if (m.sockets >= MAX_SOCKETS_PER_IP) {
    ws.close(4002, "too many connections");
    return;
  }
  m.sockets += 1;
  console.log(`[conn] connected (sockets for this ip=${m.sockets}, debug=${debug})`);

  // Self-match guard key: an opaque per-session token the client sends (now a
  // sha256 hex, not the raw Claude session id), else a per-connection random id
  // (never collides → never blocks a legitimate match). Validate the shape so a
  // malformed/oversized header can't be used as a match key.
  const sessHdr = req.headers["x-devroulette-session"];
  const matchKey =
    typeof sessHdr === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(sessHdr) ? sessHdr : randomUUID();
  recordConn(matchKey);

  const powPrefix = randomBytes(16).toString("hex");
  const meta: ConnMeta = {
    id: randomUUID(),
    ip,
    matchKey,
    handle: randomHandle(),
    alive: true,
    roomId: null,
    queued: false,
    lastMsgAt: 0,
    powPrefix,
    powOk: false,
    lastSkipAt: 0,
    powTimer: null,
    connectedAt: now,
    lastHeartbeatAt: now,
    debug,
  };
  conns.set(ws, meta);

  ws.on("pong", () => {
    meta.alive = true;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      recordViolation(ip);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      recordViolation(ip);
      return;
    }
    const res = ClientFrame.safeParse(parsed);
    if (!res.success) {
      recordViolation(ip);
      return;
    }
    onFrame(ws, meta, res.data);
  });

  const cleanup = (): void => {
    if (meta.powTimer) {
      clearTimeout(meta.powTimer);
      meta.powTimer = null;
    }
    conns.delete(ws);
    const im = ips.get(ip);
    if (im) {
      im.sockets = Math.max(0, im.sockets - 1);
      // Prune fully-idle IP records so the map can't grow without bound (an
      // attacker minting new X-Forwarded-For values would otherwise leak memory).
      if (im.sockets <= 0 && im.bannedUntil <= Date.now() && im.violations === 0 && im.joinTimes.length === 0) {
        ips.delete(ip);
      }
    }
    leaveQueue(ws);
    if (meta.roomId) destroyRoom(meta.roomId, ws, { t: "partner_left" });
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  // A chat window resuming a background-matched room presents a one-time token;
  // everyone else gets the proof-of-work challenge before they may join.
  const resumeHdr = req.headers["x-devroulette-resume"];
  if (typeof resumeHdr === "string" && resumeHdr.length > 0) {
    if (!tryResume(ws, meta, resumeHdr)) ws.close(4006, "resume failed");
  } else {
    // Arm a PoW deadline: a socket that completes the WS upgrade but never solves
    // the challenge is dropped fast, instead of squatting until the liveness sweep.
    meta.powTimer = setTimeout(() => {
      if (!meta.powOk && ws.readyState === WebSocket.OPEN) ws.close(4008, "pow timeout");
    }, POW_DEADLINE_MS);
    meta.powTimer.unref?.();
    send(ws, { t: "pow", prefix: powPrefix, bits: POW_BITS });
  }
});

const heartbeat = setInterval(() => {
  for (const [ws, meta] of conns) {
    if (!meta.alive) {
      ws.terminate();
      continue;
    }
    meta.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

const idleSweep = setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.lastActivity > IDLE_ROOM_MS) {
      destroyRoom(room.id, null, { t: "error", code: "idle", msg: "room closed (idle)" });
    }
  }
  // Sweep stale IP records (expired bans, no live sockets) so the map stays bounded.
  for (const [ip, m] of ips) {
    if (m.sockets <= 0 && m.bannedUntil <= now && m.violations === 0) {
      m.joinTimes = m.joinTimes.filter((t) => now - t < 60_000);
      if (m.joinTimes.length === 0) ips.delete(ip);
    }
  }
}, 60_000);

const onlineBroadcast = setInterval(() => {
  const frame: ServerFrame = { t: "online", count: onlineCount(), ad: currentAd() };
  for (const ws of conns.keys()) send(ws, frame);
}, 10_000);

// Liveness: a connection whose Claude task transcript has stopped growing stops
// sending heartbeats. After a short grace window, eject it from queue + room and
// close the socket. No live task = no entry, no staying.
const livenessSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, meta] of conns) {
    if (now - meta.connectedAt < LIVENESS_GRACE_MS) continue;
    if (now - meta.lastHeartbeatAt > LIVENESS_TIMEOUT_MS) {
      leaveQueue(ws);
      if (meta.roomId) destroyRoom(meta.roomId, ws, { t: "partner_left" });
      ws.close(4005, "task ended");
    }
  }
}, LIVENESS_CHECK_MS);

// Flush stats to the volume periodically, and once more on shutdown — Railway
// sends SIGTERM on every redeploy, so saving here is what makes the numbers
// survive deploys instead of resetting to 0.
const statsSave = setInterval(() => { if (statsDirty) saveStats(); }, 20_000);

heartbeat.unref();
idleSweep.unref();
onlineBroadcast.unref();
livenessSweep.unref();
statsSave.unref();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { saveStats(); process.exit(0); });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`devroulette server listening on ws://${HOST}:${PORT}`);
  console.log(persistOn ? `stats persisted → ${STATS_FILE}` : `stats NOT persisted (no writable ${STATS_DIR}); add a Railway volume`);
  if (ADMIN_KEY) console.log(`admin dashboard enabled at /admin/reports (Basic Auth: any username, password = ADMIN_KEY)`);
});

/** Graceful shutdown — used by integration tests. */
export function close(): Promise<void> {
  clearInterval(heartbeat);
  clearInterval(idleSweep);
  clearInterval(onlineBroadcast);
  clearInterval(livenessSweep);
  clearInterval(statsSave);
  saveStats();
  for (const ws of conns.keys()) ws.terminate();
  return new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
}

export { wss };
