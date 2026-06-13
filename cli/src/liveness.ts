import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Liveness / task gate.
 *
 * The only proof that a user is genuinely waiting on a Claude Code task is that
 * the task's transcript file is still being written. We watch it by SIZE/MTIME
 * ONLY — the transcript is never opened, never read, never transmitted. Zero
 * code/prompt data ever leaves the machine; we look at fs metadata and nothing
 * else. While the file grows, we emit a heartbeat; the server ejects anyone who
 * stops beating.
 */

/** Locate ~/.claude/projects/<project>/<session>.jsonl for a session id. */
export async function findTranscript(session: string): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${session}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not in this project dir — keep looking
    }
  }
  return null;
}

export interface Liveness {
  stop: () => void;
}

/**
 * Start emitting heartbeats. In hook mode we beat only while the transcript
 * grows. When `alwaysAlive` is set (debug, or manual re-entry from the ended
 * screen — no real task) we beat unconditionally so the session isn't ejected.
 */
export function startLiveness(opts: {
  session: string | undefined;
  debug: boolean;
  /** Beat unconditionally regardless of any task transcript (manual/dev mode). */
  alwaysAlive?: boolean;
  intervalMs: number;
  onBeat: () => void;
}): Liveness {
  let stopped = false;
  let path: string | null = null;
  let lastSize = -1;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (opts.debug || opts.alwaysAlive) {
      opts.onBeat(); // no task to gate on: always considered alive
      return;
    }
    if (!opts.session) return; // no task context → no heartbeat → server ejects
    if (!path) path = await findTranscript(opts.session);
    if (!path) return;
    try {
      const s = await stat(path); // SIZE/MTIME ONLY — contents are never read
      if (s.size > lastSize) {
        lastSize = s.size;
        opts.onBeat();
      }
    } catch {
      path = null; // file moved/rotated — re-locate next tick
    }
  };

  void tick(); // beat promptly so a healthy task isn't held for a full interval
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

