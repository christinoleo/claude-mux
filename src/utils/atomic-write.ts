/**
 * Write a file so a crash mid-write cannot leave a truncated one behind.
 *
 * Every durable JSON file in claude-mux is read back and parsed on the next
 * start, so a half-written file is not a lost write but a corrupt one. The
 * temp-then-rename is what makes the replacement atomic on a POSIX filesystem.
 */
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, contents, "utf-8");
  renameSync(temp, path);
}
