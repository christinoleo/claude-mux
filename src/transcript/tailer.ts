/**
 * Byte-offset tailer for Claude Code session JSONL files.
 *
 * Reads the file incrementally from the last seen offset, buffering any
 * trailing partial line (the writer appends whole lines, but a poll can race
 * a write). Written fresh — the previous jsonl-watcher was removed as buggy
 * (see docs/adr/0003).
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Derive the transcript path for a session. `cwd` must be the session's
 * launch cwd as stored in the session JSON — the encoding is lossy, so the
 * mapping only works session -> path, never in reverse.
 */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  return join(projectDirFor(cwd), `${sessionId}.jsonl`);
}

function projectDirFor(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
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
  cwd: string,
  sessionId: string,
  /** Agent ids already tracked; their meta is not re-read. */
  known?: ReadonlySet<string>,
): SubagentFile[] {
  const dir = join(projectDirFor(cwd), sessionId, "subagents");
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
      const parsed: unknown = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), "utf8"));
      if (parsed && typeof parsed === "object") meta = parsed as SubagentMeta;
    } catch {
      // Meta may not be written yet; the transcript still streams.
    }
    files.push({ agentId, path: join(dir, name), meta });
  }
  return files;
}

export type TailResult =
  | { status: "lines"; lines: string[] }
  | { status: "unchanged" }
  | { status: "missing" }
  /** File shrank (rotated/replaced): caller must rebuild from scratch. */
  | { status: "reset" };

export class JsonlTailer {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private lastMtimeMs: number | null = null;

  constructor(private readonly path: string) {}

  /** Last write seen by the most recent read(), or null before the first one. */
  mtimeMs(): number | null {
    return this.lastMtimeMs;
  }

  read(): TailResult {
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

      const chunk = Buffer.alloc(size - this.offset);
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
      return lines.length > 0 ? { status: "lines", lines } : { status: "unchanged" };
    } catch {
      return { status: "missing" };
    } finally {
      closeSync(fd);
    }
  }
}
