/**
 * Consistent pane snapshots for the terminal stream.
 *
 * The web terminal renders two regions:
 *   - history: lines that scrolled off the top of the pane (immutable in tmux,
 *     addressed by absolute index 0..history_size-1, 0 = oldest)
 *   - screen: the visible pane (pane_height rows, redrawn constantly)
 *
 * `snapshotPane` reads `#{history_size}`, the last TAIL history lines and the
 * screen in ONE tmux invocation so the three are mutually consistent. The
 * manager diffs history_size between ticks and forwards only the new history
 * lines (taken from the tail) plus the screen when it changed.
 */
import { execFileSync } from "child_process";

export const HISTORY_TAIL = 64;
const SEP = "@@CLAUDE_MUX_SEP@@";

export interface PaneSnapshot {
  historySize: number;
  alt: boolean;
  cols: number;
  rows: number;
  /** Last min(HISTORY_TAIL, historySize) history lines, oldest first */
  tail: string[];
  /** Visible pane, exactly `rows` lines */
  screen: string[];
}

function run(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 2000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Split capture output into lines, dropping the single trailing newline tmux adds. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function snapshotPane(target: string): PaneSnapshot | null {
  let out: string;
  try {
    out = run([
      "display-message", "-p", "-t", target,
      "#{history_size} #{alternate_on} #{pane_width} #{pane_height}",
      ";",
      "capture-pane", "-p", "-e", "-t", target, "-S", `-${HISTORY_TAIL}`, "-E", "-1",
      ";",
      "display-message", "-p", SEP,
      ";",
      "capture-pane", "-p", "-e", "-t", target,
    ]);
  } catch {
    return null;
  }
  const nl = out.indexOf("\n");
  if (nl === -1) return null;
  const header = out.slice(0, nl).trim().split(/\s+/);
  if (header.length < 4) return null;
  const historySize = Number(header[0]) || 0;
  const alt = header[1] === "1";
  const cols = Number(header[2]) || 0;
  const rows = Number(header[3]) || 0;

  const body = out.slice(nl + 1);
  const sepIdx = body.indexOf(SEP + "\n");
  if (sepIdx === -1) return null;
  const tailRaw = body.slice(0, sepIdx);
  const screenRaw = body.slice(sepIdx + SEP.length + 1);

  let tail = splitLines(tailRaw);
  // When history_size < TAIL, tmux clamps -S and (for 0 history) the range
  // -S -64 -E -1 yields nothing useful. Trust history_size.
  if (historySize === 0) tail = [];
  else if (tail.length > historySize) tail = tail.slice(tail.length - historySize);

  return { historySize, alt, cols, rows, tail, screen: splitLines(screenRaw) };
}

/**
 * Fetch history lines [start, end) by absolute index.
 * tmux addresses history relative to the *current* history_size, which may have
 * moved since the caller last saw it. We read history_size in the same batch and,
 * if it drifted, retry with the fresh value (a few times) so the returned range
 * is exactly the one asked for. If it keeps drifting we return the range the
 * lines actually correspond to, labelled correctly.
 */
export function fetchHistoryRange(
  target: string,
  start: number,
  end: number,
  knownHistorySize: number,
): { start: number; lines: string[]; historySize: number } | null {
  if (end <= start) return { start, lines: [], historySize: knownHistorySize };
  let known = knownHistorySize;
  let last: { start: number; lines: string[]; historySize: number } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const relStart = start - known; // negative
    const relEnd = end - 1 - known; // negative, inclusive
    if (relEnd >= 0) {
      // Range (partly) past the end of history as we know it — cap to history.
      return { start, lines: [], historySize: known };
    }
    let out: string;
    try {
      out = run([
        "display-message", "-p", "-t", target, "#{history_size}",
        ";",
        "capture-pane", "-p", "-e", "-t", target, "-S", String(relStart), "-E", String(relEnd),
      ]);
    } catch {
      return null;
    }
    const nl = out.indexOf("\n");
    if (nl === -1) return null;
    const historySize = Number(out.slice(0, nl).trim()) || 0;
    const lines = splitLines(out.slice(nl + 1));
    const drift = historySize - known;
    if (drift === 0) return { start, lines, historySize };
    // Offsets were interpreted against `historySize`, so lines begin at start+drift.
    last = { start: Math.max(0, start + drift), lines, historySize };
    known = historySize;
  }
  return last;
}
