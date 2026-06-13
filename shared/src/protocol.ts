import { z } from "zod";
import { createHash } from "node:crypto";

/** Bump when the wire protocol changes. Clients must send it as a header. */
export const PROTOCOL_VERSION = 1;
export const MAX_MSG_LEN = 500;

/** Default proof-of-work difficulty (leading zero bits of sha256). ~16 bits
 *  solves silently in a few ms; raise to make connect-spam more expensive. */
export const POW_BITS = 16;
// Hard ceiling the CLIENT will ever attempt. A hostile/compromised server could
// otherwise send a huge `bits` to make solvePow loop ~forever and freeze the client.
// 20 bits is ~1s worst case; the real server only ever asks for 16.
export const MAX_POW_BITS = 20;

// ---- client -> server frames (validated on the server) ----
const JoinQueue = z.object({ t: z.literal("join_queue") });
const ChatMsg = z.object({ t: z.literal("msg"), body: z.string().min(1).max(MAX_MSG_LEN) });
const Skip = z.object({ t: z.literal("skip") });
const TaskDone = z.object({ t: z.literal("task_done") });
const Report = z.object({ t: z.literal("report") });
const Heartbeat = z.object({ t: z.literal("heartbeat") });
const PowSolution = z.object({ t: z.literal("pow_solution"), nonce: z.string().min(1).max(64) });

export const ClientFrame = z.discriminatedUnion("t", [
  JoinQueue, ChatMsg, Skip, TaskDone, Report, Heartbeat, PowSolution,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// A server-supplied ad (text + link). Swappable server-side with no client
// release; the client shows a house ad when none is present.
export type Ad = { text: string; url: string };

// ---- server -> client frames (typed; both sides share these shapes) ----
export type ServerFrame =
  | { t: "pow"; prefix: string; bits: number }
  | { t: "queued" }
  | { t: "online"; count: number; ad?: Ad }
  | { t: "matched"; roomId: string; you: string; partner: string; resumeToken?: string; ad?: Ad }
  | { t: "msg"; body: string }
  | { t: "partner_left" }
  | { t: "task_done" }
  | { t: "error"; code: string; msg: string }
  | { t: "banned"; until: number };

// ---- proof-of-work (anti-bot connect gate; no user friction) ----
/** Count leading zero bits across a byte buffer. */
function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24; // byte is 0..255 → clz32 of an 8-bit value
    break;
  }
  return bits;
}

/** True iff sha256(prefix + nonce) has at least `bits` leading zero bits. */
export function verifyPow(prefix: string, nonce: string, bits: number): boolean {
  const digest = createHash("sha256").update(prefix + nonce).digest();
  return leadingZeroBits(digest) >= bits;
}

/** Solve the PoW by brute force. Cheap for small `bits`; runs client-side. */
export function solvePow(prefix: string, bits: number): string {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    if (verifyPow(prefix, nonce, bits)) return nonce;
  }
}

/**
 * Remove ANSI escape sequences and all C0/C1 control characters (including
 * newlines and the bytes that drive terminal cursor/colour control). Used on
 * BOTH sides — server before relay, client before render — so a hostile peer
 * can never inject terminal control into the other terminal.
 */
const ANSI_CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OTHER = /\u001B[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

// Extra passes, built from char codes to avoid brittle backslash escapes.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const BS = String.fromCharCode(0x5c);
// OSC / DCS / SOS / PM / APC strings: ESC + ] P X ^ _ , running until a BEL or ST
// (ESC \) terminator. These can set the window title or (OSC 52) write the user's
// clipboard, so strip the WHOLE run — not just the introducer byte.
const ANSI_STRING = new RegExp(ESC + "(?:]|P|X|^|_)[^]*?(?:" + BEL + "|" + ESC + BS + BS + ")", "g");
// Broader ESC sweep than ANSI_OTHER: any ESC + optional intermediates + a final
// byte, or a lone trailing ESC (the old [@-Z\-_] class missed many forms).
const ANSI_OTHER2 = new RegExp(ESC + "[ -/]*[0-~]?", "g");
// Unicode bidi overrides + zero-width / joiner / BOM: invisible or text-reordering,
// used to spoof how a received message renders. Strip them outright.
const cc = (a: number, b: number): string => String.fromCharCode(a) + "-" + String.fromCharCode(b);
const BIDI_ZW = new RegExp(
  "[" + cc(0x200b, 0x200f) + cc(0x202a, 0x202e) + cc(0x2060, 0x2064) + cc(0x2066, 0x206f) + String.fromCharCode(0xfeff) + "]",
  "g",
);

export function sanitize(input: string): string {
  return input
    .replace(ANSI_STRING, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(ANSI_OTHER2, "")
    .replace(CONTROL, "")
    .replace(BIDI_ZW, "");
}
