import { setTimeout as delay } from "timers/promises";

/**
 * Check if a process with the given PID is still alive.
 *
 * EPERM means the process exists but belongs to another user, so it counts as
 * alive: callers use this to decide whether to reap a session file or take over
 * a lock, and treating a running process as gone is the costlier mistake.
 */
export function isPidAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process but checks if it exists
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ask a process to exit and wait for it, forcing it only when it will not go.
 * SIGTERM lets a terminal program restore the screen; SIGKILL would leave the
 * pane in raw mode. Resolves true once the process is gone.
 */
export async function terminate(pid: number, graceMs = 5000): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }
  if (await waitForExit(pid, graceMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  return waitForExit(pid, 1000);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(100);
  }
  return !isPidAlive(pid);
}
