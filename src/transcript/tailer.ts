/**
 * Byte-offset tailer for Claude Code session JSONL files.
 *
 * Reads the file incrementally from the last seen offset, buffering any
 * trailing partial line (the writer appends whole lines, but a poll can race
 * a write). Written fresh — the previous jsonl-watcher was removed as buggy
 * (see docs/adr/0003).
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

/** See resolveTranscriptPath: right only until the session changes directory. */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  return join(projectDirFor(cwd), `${sessionId}.jsonl`);
}

// Read at call time, not at module load: the tests point HOME at a temp dir.
function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

function projectDirFor(cwd: string): string {
  return join(projectsRoot(), cwd.replace(/\//g, "-"));
}

/**
 * Locate a session's JSONL. Claude Code names the project directory after the
 * directory it was *launched* in, so a session that changes directory stops
 * matching its own `cwd` and the path has to come from somewhere else. In
 * order of trust:
 *
 * 1. `transcript_path` as reported by the hooks — always right when present.
 * 2. The path derived from `cwd` — right only when the session never `cd`ed.
 * 3. A scan of ~/.claude/projects for `<sessionId>.jsonl` — the fallback for
 *    sessions last written by a hook that did not record the path yet. It
 *    stats one path per project directory, which measures well under a
 *    millisecond; a caller repeating it should still back off (see
 *    RESOLVE_TICKS), since a session with no file yet never resolves.
 *
 * Returns null when no file exists at any of them; callers should retry, since
 * a session that has not answered its first prompt has no transcript yet.
 */
export function resolveTranscriptPath(
  session: { cwd: string; transcript_path?: string | null },
  sessionId: string
): string | null {
  const recorded = session.transcript_path;
  if (recorded && existsSync(recorded)) return recorded;

  const derived = transcriptPathFor(session.cwd, sessionId);
  if (existsSync(derived)) return derived;

  return findTranscriptById(sessionId);
}

/** Scan every project directory for `<sessionId>.jsonl`. */
function findTranscriptById(sessionId: string): string | null {
  const root = projectsRoot();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface SubagentFile {
  agentId: string;
  path: string;
  meta: SubagentMeta;
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  /** The parent transcript's Task tool_use id — how a subagent finds its card. */
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
}

/**
 * List the subagent transcripts a session has spawned. They live in a sibling
 * directory named after the session, one `agent-<id>.jsonl` per subagent with
 * a `.meta.json` beside it linking back to the Task tool call.
 */
export function listSubagents(
  /** The session's own transcript path; the subagents sit beside it. */
  transcriptPath: string,
  /** Agent ids already tracked; their meta is not re-read. */
  known?: ReadonlySet<string>
): SubagentFile[] {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: SubagentFile[] = [];
  for (const name of names) {
    const agentId = name.match(/^agent-(.+)\.jsonl$/)?.[1];
    if (!agentId) continue;
    if (known?.has(agentId)) continue;
    let meta: SubagentMeta = {};
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(dir, `agent-${agentId}.meta.json`), "utf8")
      );
      if (parsed && typeof parsed === "object") meta = parsed as SubagentMeta;
    } catch {
      // Meta may not be written yet; the transcript still streams.
    }
    files.push({ agentId, path: join(dir, name), meta });
  }
  return files;
}

export type TailResult =
  /** `more` is set when a byte limit stopped the read short of the file's end. */
  | { status: "lines"; lines: string[]; more?: boolean }
  | { status: "unchanged" }
  | { status: "missing" }
  /** File shrank (rotated/replaced): caller must rebuild from scratch. */
  | { status: "reset" };

export class JsonlTailer {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private lastMtimeMs: number | null = null;

  constructor(readonly path: string) {}

  /** Last write seen by the most recent read(), or null before the first one. */
  mtimeMs(): number | null {
    return this.lastMtimeMs;
  }

  /**
   * Read what was appended since the last call. With `limitBytes`, read at
   * most that much and say whether more remains, so a caller catching up on
   * a large file can take it in slices and yield between them.
   */
  read(limitBytes?: number): TailResult {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return { status: "missing" };
    }
    try {
      const stat = fstatSync(fd);
      this.lastMtimeMs = stat.mtimeMs;
      const size = stat.size;
      if (size < this.offset) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        return { status: "reset" };
      }
      if (size === this.offset) return { status: "unchanged" };

      const want = size - this.offset;
      const chunk = Buffer.alloc(limitBytes ? Math.min(want, limitBytes) : want);
      let read = 0;
      while (read < chunk.length) {
        const n = readSync(fd, chunk, read, chunk.length - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      this.offset += read;

      // Split on newlines at the byte level so a partially-written multibyte
      // character at the chunk boundary never corrupts a decoded line.
      const buffer = Buffer.concat([this.partial, chunk.subarray(0, read)]);
      const lines: string[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x0a) {
          lines.push(buffer.subarray(start, i).toString("utf8"));
          start = i + 1;
        }
      }
      this.partial = buffer.subarray(start);
      const more = this.offset < size;
      if (lines.length === 0) return more ? { status: "lines", lines: [], more } : { status: "unchanged" };
      return more ? { status: "lines", lines, more } : { status: "lines", lines };
    } catch {
      return { status: "missing" };
    } finally {
      closeSync(fd);
    }
  }
}
