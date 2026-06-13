import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { solvePow, POW_BITS } from "../shared/src/protocol.js";

// start the server on an isolated port BEFORE importing it (it listens on import)
const PORT = 8911;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
// all tests share IP 127.0.0.1; lift the per-IP join cap so cumulative joins
// across the suite don't trip the (production-default 5/min) rate limit.
process.env.MAX_JOINS_PER_MIN = "1000";
// short liveness windows so the eject test runs fast; clients heartbeat to stay.
process.env.LIVENESS_GRACE_MS = "400";
process.env.LIVENESS_TIMEOUT_MS = "500";
process.env.LIVENESS_CHECK_MS = "100";
const URL = `ws://127.0.0.1:${PORT}`;
const HDR = { headers: { "x-devroulette-version": "1" } };
const DEBUG_HDR = { headers: { "x-devroulette-version": "1", "x-devroulette-debug": "1" } };

let closeServer: () => Promise<void>;

interface Frame {
  t: string;
  you?: string;
  partner?: string;
  body?: string;
  count?: number;
  prefix?: string;
  bits?: number;
  code?: string;
  resumeToken?: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function opened(ws: WebSocket): Promise<void> {
  return new Promise((r) => ws.once("open", () => r()));
}
function send(ws: WebSocket, t: string, extra: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ t, ...extra }));
}

/** A small async inbox so tests can await specific frame types in order. */
function bus(ws: WebSocket): { waitFor: (t: string, tries?: number) => Promise<Frame>; next: () => Promise<Frame | null> } {
  const queue: Frame[] = [];
  const wakers: ((f: Frame) => void)[] = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString()) as Frame;
    const w = wakers.shift();
    if (w) w(f);
    else queue.push(f);
  });
  const next = (): Promise<Frame | null> =>
    new Promise((res) => {
      const f = queue.shift();
      if (f) res(f);
      else wakers.push(res);
    });
  const waitFor = async (t: string, tries = 25): Promise<Frame> => {
    for (let i = 0; i < tries; i++) {
      const f = await next();
      if (f && f.t === t) return f;
    }
    throw new Error(`never received frame "${t}"`);
  };
  return { waitFor, next };
}

/**
 * Real-client handshake: wait for the PoW challenge, solve it, join the queue,
 * and start a heartbeat ticker (mimics the liveness gate while a task runs).
 * Returns a stop() that silences the heartbeat (so we can test ejection).
 */
async function join(ws: WebSocket, b: ReturnType<typeof bus>): Promise<() => void> {
  const pow = await b.waitFor("pow");
  send(ws, "pow_solution", { nonce: solvePow(pow.prefix!, pow.bits ?? POW_BITS) });
  send(ws, "join_queue");
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) send(ws, "heartbeat");
  }, 100);
  return () => clearInterval(hb);
}

before(async () => {
  const mod = (await import("../server/src/index.js")) as { close: () => Promise<void> };
  closeServer = mod.close;
  await wait(200);
});

after(async () => {
  await closeServer();
});

test("matchmaking pairs two waiting users with handles", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba);
  const sb = await join(b, bb);
  const [ma, mb] = await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  assert.ok(ma.you && ma.partner, "handles assigned");
  assert.equal(mb.partner, ma.you, "partner handles mirror");
  sa();
  sb();
  a.close();
  b.close();
  await wait(150);
});

test("rate limiting: max 3 concurrent sockets per IP", async () => {
  const s = [new WebSocket(URL, HDR), new WebSocket(URL, HDR), new WebSocket(URL, HDR)];
  await Promise.all(s.map(opened));
  const fourth = new WebSocket(URL, HDR);
  const code = await new Promise<number>((res) => fourth.on("close", (c) => res(c)));
  assert.equal(code, 4002, "4th socket from same IP rejected");
  for (const ws of s) ws.close();
  await wait(200);
});

test("ANSI / control chars are stripped before relay", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba);
  const sb = await join(b, bb);
  await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  send(a, "msg", { body: "hi\u001b[31m\u0007\u0008 there" });
  const got = await bb.waitFor("msg");
  assert.equal(got.body, "hi there", "escape + control bytes removed");
  sa();
  sb();
  a.close();
  b.close();
  await wait(150);
});

test("oversized message is rejected (never relayed)", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba);
  const sb = await join(b, bb);
  await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  send(a, "msg", { body: "x".repeat(600) }); // > 500 char schema limit
  const got = await Promise.race([bb.next(), wait(400).then(() => null)]);
  assert.equal(got, null, "partner received nothing");
  sa();
  sb();
  a.close();
  b.close();
  await wait(150);
});

test("room tears down on disconnect (partner notified)", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba);
  const sb = await join(b, bb);
  await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  sa();
  a.close();
  const left = await bb.waitFor("partner_left");
  assert.equal(left.t, "partner_left");
  sb();
  b.close();
  await wait(150);
});

test("proof-of-work: join is refused until the challenge is solved", async () => {
  const a = new WebSocket(URL, HDR);
  const ba = bus(a);
  await opened(a);
  await ba.waitFor("pow"); // receive the challenge but DON'T solve it
  send(a, "join_queue"); // attempt to skip the gate
  const err = await ba.waitFor("error");
  assert.equal(err.code, "pow_required", "queue join blocked without PoW");
  a.close();
  await wait(150);
});

test("debug-mode connections are rejected in production", async () => {
  // server has DEVROULETTE_ALLOW_DEBUG unset → debug header must be refused
  const ws = new WebSocket(URL, DEBUG_HDR);
  const code = await new Promise<number>((res) => ws.on("close", (c) => res(c)));
  assert.equal(code, 4004, "debug connection closed with 4004");
  await wait(150);
});

test("resume handoff: a chat window resumes the background-matched room", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba);
  const sb = await join(b, bb);
  const [ma, mb] = await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  assert.ok(ma.resumeToken && mb.resumeToken, "resume tokens issued on match");

  // A's window opens and resumes A's seat using the one-time token
  const aw = new WebSocket(URL, {
    headers: { "x-devroulette-version": "1", "x-devroulette-resume": ma.resumeToken! },
  });
  const baw = bus(aw);
  await opened(aw);
  const resumed = await baw.waitFor("matched");
  assert.equal(resumed.you, ma.you, "resumed window keeps the same handle");

  // the old background socket is closed by the server after the swap
  const code = await new Promise<number>((res) => a.on("close", (c) => res(c)));
  assert.equal(code, 4007, "background socket closed (resumed)");
  sa();

  // a message from the resumed window reaches the (still-bg) partner — no drop
  const saw = setInterval(() => {
    if (aw.readyState === WebSocket.OPEN) send(aw, "heartbeat");
  }, 100);
  send(aw, "msg", { body: "resumed hello" });
  const got = await bb.waitFor("msg");
  assert.equal(got.body, "resumed hello", "partner still connected through handoff");

  clearInterval(saw);
  sb();
  aw.close();
  b.close();
  await wait(150);
});

test("liveness: a connection that stops heartbeating is ejected", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba); // a keeps beating
  const sb = await join(b, bb);
  await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  sb(); // b goes silent — no more heartbeats
  const left = await ba.waitFor("partner_left", 60);
  assert.equal(left.t, "partner_left", "silent partner ejected, room torn down");
  sa();
  a.close();
  b.close();
  await wait(150);
});

test("queue-eclipse guard: one match-key may hold only a single queue slot", async () => {
  const sess = (s: string) => ({ headers: { "x-devroulette-version": "1", "x-devroulette-session": s } });
  const a = new WebSocket(URL, sess("dup"));
  const b = new WebSocket(URL, sess("dup")); // same session id as a → must not double-queue
  const c = new WebSocket(URL, sess("other"));
  const ba = bus(a);
  const bb = bus(b);
  const bc = bus(c);
  await opened(a);
  await opened(b);
  await opened(c);
  const sa = await join(a, ba);
  await ba.waitFor("queued");
  const sb = await join(b, bb); // shares "dup" → server no-ops the join (no queue slot)
  const sc = await join(c, bc); // different session → matches the queued "dup" socket (a)
  const ma = await ba.waitFor("matched");
  assert.ok(ma.partner, "the first dup socket matched the different-session peer");
  const bMatched = await Promise.race([bb.waitFor("matched", 8).catch(() => null), wait(500).then(() => null)]);
  assert.equal(bMatched, null, "the second same-match-key socket is never queued or matched");
  sa();
  sb();
  sc();
  a.close();
  b.close();
  c.close();
  await wait(150);
});

test("report removes the reporter's room but never bans the partner", async () => {
  const a = new WebSocket(URL, HDR);
  const b = new WebSocket(URL, HDR);
  const ba = bus(a);
  const bb = bus(b);
  await opened(a);
  await opened(b);
  const sa = await join(a, ba);
  const sb = await join(b, bb);
  await Promise.all([ba.waitFor("matched"), bb.waitFor("matched")]);
  send(a, "report");
  const left = await bb.waitFor("partner_left");
  assert.equal(left.t, "partner_left", "partner is removed from the room");
  const banned = await Promise.race([bb.waitFor("banned", 6).catch(() => null), wait(400).then(() => null)]);
  assert.equal(banned, null, "a single anonymous report must not ban the partner");
  sa();
  sb();
  a.close();
  b.close();
  await wait(150);
});
