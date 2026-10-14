import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** One row of the process table: who started it and the words it was started with. */
export type ProcessRow = { pid: number; ppid: number; args: string };

/** The whole process table from `ps`, or null when it cannot be read. */
export async function readProcessTable(): Promise<ProcessRow[] | null> {
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,args="], {
      encoding: "utf-8",
      timeout: 2_000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return rows;
}

/** The rows that descend from `root`, at any depth. */
export function descendants(rows: ProcessRow[], root: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const out: ProcessRow[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}
