import { basename } from "path";

/** Tmux disallows `:` and `.` in session names. Sanitize cwd basename to a tmux-safe slug. */
export function projectSlug(cwd: string, fallback: string): string {
  return basename(cwd).replace(/[^A-Za-z0-9_-]/g, "_") || fallback;
}
