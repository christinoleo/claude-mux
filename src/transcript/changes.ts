/**
 * What a session changed, read off its own log.
 *
 * Every Edit, Write, MultiEdit and NotebookEdit result carries a sidecar
 * (`toolUseResult`) with the file it touched and the patch it applied, as
 * git-style hunks in `structuredPatch`. A Write that created the file says
 * `type: "create"` and leaves the patch empty, so its whole `content` is the
 * addition. Nothing here reads the disk: the log is the record, which is what
 * lets this source cover files outside any repo — and what makes it blind to
 * changes made through Bash.
 *
 * The collector groups changes by turn — a prompt the user typed (or a slash
 * command they ran) up to the next one — keyed by that prompt line's uuid, the
 * same id the transcript gives the prompt's entry.
 */

import { asRecord, readString } from "./json.js";
import { peekTranscriptPath } from "./context-peek.js";
import { JsonlTailer } from "./tailer.js";
import { interruptNote, parseSlashCommand, readStructuredPatch, type PatchHunk } from "./parser.js";

export type FileChangeKind = "added" | "modified" | "deleted";

/** One tool call's change to one file. */
export interface FileChange {
  file: string;
  kind: FileChangeKind;
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
}

/** A file's change as counted, without its hunks — what a list draws. */
export type FileChangeCount = Omit<FileChange, "hunks">;

export interface TurnChanges {
  /** The prompt line's uuid, or null for changes logged before any prompt. */
  id: string | null;
  ts: number;
  /** The prompt, cut to a line, so a list can say which turn this was. */
  prompt: string;
  files: FileChangeCount[];
}

export interface ChangesSummary {
  files: number;
  additions: number;
  deletions: number;
}

/** Totals over a list of counted files. */
export function summarize(files: { additions: number; deletions: number }[]): ChangesSummary {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** Edit and MultiEdit name the file `filePath`; NotebookEdit names it `notebook_path`. */
function sidecarFile(sc: Record<string, unknown>): string | null {
  return readString(sc.filePath) ?? readString(sc.notebook_path);
}

function countLines(hunks: PatchHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { additions, deletions };
}

/** A new file's content as the one hunk that adds it. */
function creationHunk(content: string): PatchHunk[] {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  return [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((line) => `+${line}`) }];
}

/**
 * The change a tool result's sidecar records, or null when the sidecar is not
 * a file edit. A Write counts as adding the file when it says it created it,
 * or when it carries content but no `originalFile` to have changed.
 */
export function fileChangeFromSidecar(sidecar: unknown): FileChange | null {
  const sc = asRecord(sidecar);
  if (!sc || !("structuredPatch" in sc)) return null;
  const file = sidecarFile(sc);
  if (!file) return null;
  const content = readString(sc.content);
  const created =
    sc.type === "create" || (sc.type === undefined && content !== null && !("originalFile" in sc));
  let hunks = readStructuredPatch(sc.structuredPatch);
  if (created && hunks.length === 0 && content !== null) hunks = creationHunk(content);
  return { file, kind: created ? "added" : "modified", ...countLines(hunks), hunks };
}

/** Prompts the harness wrote rather than a person: notifications, reminders, a local command's lines. */
const HARNESS_PROMPT = /^<(task-notification|system-reminder|local-command-)/;

/** The text that opens a turn, or null when the line is not a prompt. */
function promptText(record: Record<string, unknown>): string | null {
  if (record.isMeta === true || record.isCompactSummary === true) return null;
  const kind = asRecord(record.origin)?.kind;
  if (kind !== undefined && kind !== "human") return null;
  const content = asRecord(record.message)?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const rec = asRecord(block);
      if (rec?.type === "tool_result") return null;
      const part = rec?.type === "text" ? readString(rec.text) : null;
      if (part) parts.push(part);
    }
    text = parts.join("\n");
  } else return null;
  text = text.trim();
  if (!text || HARNESS_PROMPT.test(text) || interruptNote(text)) return null;
  const command = parseSlashCommand(text);
  if (command) text = command.args ? `${command.name} ${command.args}` : command.name;
  const firstLine = text.split("\n", 1)[0];
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function parseTs(value: unknown): number {
  const ts = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

interface Turn {
  id: string | null;
  ts: number;
  prompt: string;
  /** Per file, every change in order. */
  changes: Map<string, FileChange[]>;
}

/** Fold several changes to one file into a single count. */
function count(file: string, changes: FileChange[]): FileChangeCount {
  return {
    file,
    // Created at some point in the run means new to whoever reads the run.
    kind: changes[0].kind,
    additions: changes.reduce((n, c) => n + c.additions, 0),
    deletions: changes.reduce((n, c) => n + c.deletions, 0),
  };
}

/** Fold several changes to one file into a single change, hunks and all. */
function merge(file: string, changes: FileChange[]): FileChange {
  return { ...count(file, changes), hunks: changes.flatMap((c) => c.hunks) };
}

/**
 * Feed a session's JSONL lines in file order; read the changes out per turn
 * or per session. Lines that cannot carry a change or open a turn are passed
 * over before parsing, so catching up on a long log costs little more than
 * reading it.
 */
export class ChangesCollector {
  private turns: Turn[] = [];
  /** tool_use ids already counted, so a line written twice is counted once. */
  private seen = new Set<string>();

  feed(line: string): void {
    // A tool result without a patch can neither change a file nor open a turn.
    const carriesChange = line.includes('"structuredPatch"');
    if (!carriesChange && (!line.includes('"type":"user"') || line.includes('"tool_result"'))) return;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!record || record.type !== "user" || record.isSidechain === true) return;

    if (carriesChange) {
      const change = fileChangeFromSidecar(record.toolUseResult);
      if (!change) return;
      const content = asRecord(record.message)?.content;
      const result = Array.isArray(content)
        ? content.map(asRecord).find((block) => block?.type === "tool_result")
        : undefined;
      const toolUseId = readString(result?.tool_use_id);
      if (toolUseId) {
        if (this.seen.has(toolUseId)) return;
        this.seen.add(toolUseId);
      }
      let turn = this.turns[this.turns.length - 1];
      if (!turn) {
        turn = { id: null, ts: parseTs(record.timestamp), prompt: "", changes: new Map() };
        this.turns.push(turn);
      }
      const list = turn.changes.get(change.file);
      if (list) list.push(change);
      else turn.changes.set(change.file, [change]);
      return;
    }

    const prompt = promptText(record);
    if (prompt === null) return;
    this.turns.push({
      id: readString(record.uuid),
      ts: parseTs(record.timestamp),
      prompt,
      changes: new Map(),
    });
  }

  /** The turns that changed something, oldest first. */
  byTurn(): TurnChanges[] {
    return this.turns
      .filter((turn) => turn.changes.size > 0)
      .map((turn) => ({
        id: turn.id,
        ts: turn.ts,
        prompt: turn.prompt,
        files: [...turn.changes].map(([file, list]) => count(file, list)),
      }));
  }

  /** Every change to each file over every turn, in the order first touched. */
  private perFile(): Map<string, FileChange[]> {
    const all = new Map<string, FileChange[]>();
    for (const turn of this.turns) {
      for (const [file, list] of turn.changes) {
        const prior = all.get(file);
        if (prior) prior.push(...list);
        else all.set(file, [...list]);
      }
    }
    return all;
  }

  /** Each file the session changed, folded over every turn, in the order first touched. */
  files(): FileChange[] {
    return [...this.perFile()].map(([file, list]) => merge(file, list));
  }

  /** As `files()`, counted without folding any hunks. */
  counts(): FileChangeCount[] {
    return [...this.perFile()].map(([file, list]) => count(file, list));
  }

  /** One file's change: over the whole session, or within the turn `turnId` names. */
  file(file: string, turnId?: string | null): FileChange | null {
    const list =
      turnId === undefined
        ? this.perFile().get(file)
        : this.turns.find((turn) => turn.id === turnId)?.changes.get(file);
    return list ? merge(file, list) : null;
  }

  summary(): ChangesSummary {
    return summarize(this.counts());
  }
}

// ---------------------------------------------------------------------------
// One collector per transcript, caught up from where it last read.
// ---------------------------------------------------------------------------

interface Tracked {
  tailer: JsonlTailer;
  collector: ChangesCollector;
  usedAt: number;
}

/** A log nobody has asked about for this long is dropped, hunks and all. */
const FORGET_MS = 10 * 60_000;

const tracked = new Map<string, Tracked>();

/** Forget everything — for tests. */
export function resetChangesCache(): void {
  tracked.clear();
}

/**
 * The session's changes as its log has them now, or null when it has no log
 * yet. The first call reads the whole file; later ones read only what was
 * appended since.
 */
export function sessionChanges(session: {
  id: string;
  cwd: string;
  transcript_path?: string | null;
}): ChangesCollector | null {
  const path = peekTranscriptPath(session);
  if (!path) return null;
  const now = Date.now();
  for (const [other, entry] of tracked) if (now - entry.usedAt > FORGET_MS) tracked.delete(other);
  let t = tracked.get(path);
  if (!t) {
    t = { tailer: new JsonlTailer(path), collector: new ChangesCollector(), usedAt: now };
    tracked.set(path, t);
  }
  t.usedAt = now;
  for (;;) {
    const read = t.tailer.read();
    if (read.status === "reset") {
      t.collector = new ChangesCollector();
      continue;
    }
    if (read.status === "lines") for (const line of read.lines) t.collector.feed(line);
    return t.collector;
  }
}
