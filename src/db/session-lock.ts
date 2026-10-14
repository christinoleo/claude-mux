import { openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync, renameSync } from "fs";
import { randomBytes } from "crypto";

/**
 * Every writer of a session JSON — the hook's processes and the server alike —
 * reads the file, changes it and writes it back. Two of them at once and the
 * later write drops what the earlier one did: a background agent's PostToolUse
 * lands within milliseconds of its SubagentStart, and the agent vanished. The
 * lock is a `<id>.json.lock` beside the file, made with exclusive create.
 */

/** A holder this old crashed or hung; its lock is broken. Nothing holds it for more than a few ms. */
const STALE_MS = 3_000;
/** How long a writer waits before going ahead without the lock, so a hook never stalls Claude Code. */
const WAIT_MS = 1_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

/** Take the lock, or answer null when it stayed held past `WAIT_MS`. */
function acquire(lockPath: string): string | null {
  const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + WAIT_MS;
  let backoff = 2;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch (e) {
      if (code(e) !== "EEXIST") throw e;
    }
    breakIfStale(lockPath);
    if (Date.now() >= deadline) return null;
    sleep(backoff);
    backoff = Math.min(backoff * 2, 50);
  }
}

/**
 * Move a stale lock aside before removing it: of two writers that both find it
 * stale, only one rename succeeds, so the other cannot delete the lock the
 * first then takes.
 */
function breakIfStale(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < STALE_MS) return;
    const aside = `${lockPath}.${process.pid}.stale`;
    renameSync(lockPath, aside);
    unlinkSync(aside);
  } catch {
    // Released or broken by someone else meanwhile.
  }
}

/** Remove the lock only while it is still ours: one broken as stale may now be another writer's. */
function release(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/**
 * Run `fn` holding the session file's lock. Keep `fn` to the read, the change
 * and the write: nothing slow, since every other writer of the session waits.
 * When the lock cannot be had in time, `fn` runs anyway and `onTimeout` is told.
 */
export function withSessionLock<T>(sessionPath: string, fn: () => T, onTimeout?: () => void): T {
  const lockPath = `${sessionPath}.lock`;
  let token: string | null = null;
  try {
    token = acquire(lockPath);
    if (token === null) onTimeout?.();
  } catch {
    // The directory is missing or unwritable; the write that follows will say so.
  }
  try {
    return fn();
  } finally {
    if (token !== null) release(lockPath, token);
  }
}
