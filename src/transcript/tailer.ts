/**
 * Byte-offset tailer for Claude Code session JSONL files.
 *
 * Reads the file incrementally from the last seen offset, buffering any
 * trailing partial line (the writer appends whole lines, but a poll can race
 * a write). Written fresh — the previous jsonl-watcher was removed as buggy
 * (see docs/adr/0003).
 */
import { closeSync, fstatSync, openSync, readSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Derive the transcript path for a session. `cwd` must be the session's
 * launch cwd as stored in the session JSON — the encoding is lossy, so the
 * mapping only works session -> path, never in reverse.
 */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  const projectDir = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
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

  constructor(private readonly path: string) {}

  read(): TailResult {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return { status: "missing" };
    }
    try {
      const size = fstatSync(fd).size;
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
