/**
 * Dialogs the screen readers could not read.
 *
 * When the hooks say a session waits on a person and none of the readers
 * (`readPromptOptions()`, `readLoginScreen()`, `readRewindScreen()`) finds
 * anything on its screen, the dashboard has no card to draw and falls back to
 * the terminal. That is a reader that needs fixing, so the screen that beat it
 * is kept: one file per dialog in `~/.claude-mux/failed-reads/`, written once
 * the read has failed for `FAIL_AFTER_MS` (a dialog the hook announced a beat
 * before it was drawn is not a failure), and the newest `KEEP` kept.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";

const FAILED_READS_DIR = join(CLAUDE_MUX_DIR, "failed-reads");

/** A little longer than the Transcript waits before it draws the terminal instead. */
export const FAIL_AFTER_MS = 2000;
const KEEP = 100;
/** The foot of the pane, where every dialog Claude Code draws sits. */
const SCREEN_LINES = 60;

export interface FailedRead {
  at: string;
  session_id: string;
  tmux_target: string | null;
  state: string;
  current_action: string | null;
  claude_version: string | null;
  /** A hook is holding the dialog, so a card was drawn from it all the same. */
  held: boolean;
  /** The pane's foot as the readers saw it. */
  screen: string;
  /** The same lines with colour, which some readers depend on. */
  ansi: string;
}

export interface ReadObservation {
  session_id: string;
  tmux_target: string | null;
  state: string;
  current_action: string | null;
  /** Read only when a record is written, since it costs a file read. */
  claudeVersion: () => string | null;
  held: boolean;
  /** The hooks say a dialog is open and no reader found one. */
  failing: boolean;
  stripped: string;
  raw: string;
}


export class FailedReads {
  /** Per session: when the current failure began, and whether it was written. */
  private open = new Map<string, { since: number; written: boolean }>();

  constructor(
    private dir = FAILED_READS_DIR,
    private now: () => number = Date.now,
  ) {}

  /** Called on every poll for every session with a screen. Returns the record when one was written. */
  observe(o: ReadObservation): FailedRead | null {
    if (!o.failing) {
      this.open.delete(o.session_id);
      return null;
    }
    const now = this.now();
    const episode = this.open.get(o.session_id) ?? { since: now, written: false };
    this.open.set(o.session_id, episode);
    if (episode.written || now - episode.since < FAIL_AFTER_MS) return null;
    episode.written = true;
    const record: FailedRead = {
      at: new Date(now).toISOString(),
      session_id: o.session_id,
      tmux_target: o.tmux_target,
      state: o.state,
      current_action: o.current_action,
      claude_version: o.claudeVersion(),
      held: o.held,
      ...foot(o.stripped, o.raw),
    };
    try {
      this.write(record, now);
    } catch (err) {
      console.warn(`[failed-reads] could not record: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    console.log(`[failed-reads] no reader found the ${o.state} dialog in ${o.tmux_target ?? o.session_id}`);
    return record;
  }

  /** Starts the wait again for a session whose screen could not be read this tick. */
  forget(sessionId: string): void {
    this.open.delete(sessionId);
  }

  /** Sessions gone from the poll take their episode with them. */
  forgetExcept(live: Set<string>): void {
    for (const id of this.open.keys()) if (!live.has(id)) this.open.delete(id);
  }

  private write(record: FailedRead, now: number): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${now}-${record.session_id}.json`), JSON.stringify(record, null, 2) + "\n");
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) unlinkSync(join(this.dir, f));
  }
}

/**
 * The pane's foot, the same rows in both copies. Trimming the coloured copy on
 * its own would keep blank rows that still carry an escape code, and shift it.
 */
function foot(stripped: string, raw: string): { screen: string; ansi: string } {
  const lines = stripped.split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  const start = Math.max(0, end - SCREEN_LINES);
  return {
    screen: lines.slice(start, end).join("\n"),
    ansi: raw.split("\n").slice(start, end).join("\n"),
  };
}
