/**
 * Which commits a session made, read off its log.
 *
 * A commit's own output is no evidence: `git commit -q` prints nothing, and a
 * hash in someone's prose is not a commit. What the log does say for certain
 * is when the session ran a command that writes commits, and how long it took.
 * A commit whose committer time falls inside one of those runs was made by
 * it, and the turn the run belongs to is the place in the conversation that
 * explains the commit.
 */

import { asRecord, readString } from "./json.js";
import { peekTranscriptPath } from "./context-peek.js";
import { JsonlTailer } from "./tailer.js";
import { parseTs, promptText } from "./changes.js";

/** One run of a command that can write commits. */
export interface CommitRun {
  /** The id of the prompt that opened the turn, or null before the first one. */
  turn: string | null;
  from: number;
  /** When its result came back; null while it is still running. */
  to: number | null;
}

/** git's commit-writing verbs, and the release script that commits a version bump. */
const WRITES_COMMITS = /\bgit\b[^|;&\n]*\b(?:commit|merge|cherry-pick|revert|rebase|am)\b|\bnpm version\b/;

/** A clock on another machine, or a second lost to rounding, should not unmake a match. */
const SLACK_MS = 2_000;
/** How long a run with no result yet is believed: an interrupted one never gets its result. */
const OPEN_RUN_MS = 10 * 60_000;

export class CommitRunCollector {
  private runs: CommitRun[] = [];
  private open = new Map<string, CommitRun>();
  private turn: string | null = null;

  feed(line: string): void {
    const isUser = line.includes('"type":"user"');
    const mayCommit = line.includes('"tool_use"') && (line.includes("git ") || line.includes("npm version"));
    if (!isUser && !mayCommit) return;
    if (isUser && this.open.size === 0 && line.includes('"tool_result"')) return;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!record || record.isSidechain === true) return;
    const content = asRecord(record.message)?.content;
    const blocks = Array.isArray(content) ? content.map(asRecord) : [];
    const ts = parseTs(record.timestamp);

    if (record.type === "assistant") {
      for (const block of blocks) {
        if (block?.type !== "tool_use" || block.name !== "Bash") continue;
        const id = readString(block.id);
        const command = readString(asRecord(block.input)?.command);
        if (!id || !command || !WRITES_COMMITS.test(command)) continue;
        const run: CommitRun = { turn: this.turn, from: ts, to: null };
        this.runs.push(run);
        this.open.set(id, run);
      }
      return;
    }
    if (record.type !== "user") return;
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue;
      const run = this.open.get(readString(block.tool_use_id) ?? "");
      if (!run) continue;
      run.to = ts;
      this.open.delete(readString(block.tool_use_id) ?? "");
    }
    if (promptText(record) !== null) this.turn = readString(record.uuid);
  }

  /** The run a commit made at `at` (ms) belongs to, if the session was writing commits then. */
  runAt(at: number): CommitRun | null {
    return (
      this.runs.find((run) => at >= run.from - SLACK_MS && at <= (run.to ?? run.from + OPEN_RUN_MS) + SLACK_MS) ?? null
    );
  }
}

interface Tracked {
  tailer: JsonlTailer;
  collector: CommitRunCollector;
  usedAt: number;
}

/** A log nobody has asked about for this long is dropped. */
const FORGET_MS = 10 * 60_000;
const tracked = new Map<string, Tracked>();

/** The session's commit-writing runs as its log has them now, or null when it has no log yet. */
export function sessionCommitRuns(session: {
  id: string;
  cwd: string;
  transcript_path?: string | null;
}): CommitRunCollector | null {
  const path = peekTranscriptPath(session);
  if (!path) return null;
  const now = Date.now();
  for (const [other, entry] of tracked) if (now - entry.usedAt > FORGET_MS) tracked.delete(other);
  let t = tracked.get(path);
  if (!t) {
    t = { tailer: new JsonlTailer(path), collector: new CommitRunCollector(), usedAt: now };
    tracked.set(path, t);
  }
  t.usedAt = now;
  for (;;) {
    const read = t.tailer.read();
    if (read.status === "reset") {
      t.collector = new CommitRunCollector();
      continue;
    }
    if (read.status === "lines") for (const line of read.lines) t.collector.feed(line);
    return t.collector;
  }
}
