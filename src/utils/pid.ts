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
