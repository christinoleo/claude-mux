import { execFileSync } from "child_process";
import { readdirSync, readFileSync } from "fs";

/** One row of the process table: who started it and the words it was started with. */
export type ProcessRow = { pid: number; ppid: number; args: string };

/**
 * The processes below `root`, or null when the table cannot be read at all.
 * Linux lists each process's children under `/proc`, so only that branch is
 * walked; elsewhere (macOS) the whole table comes from `ps`, which is no less
 * a table and is filtered by `descendants()` all the same.
 */
export function readProcessTree(root: number): ProcessRow[] | null {
  return readProcChildren(root) ?? readPsTable();
}

function readProcChildren(root: number): ProcessRow[] | null {
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${root}/task`);
  } catch {
    return null;
  }
  const rows: ProcessRow[] = [];
  const queue: [number, string[]][] = [[root, tasks]];
  while (queue.length > 0) {
    const [ppid, threads] = queue.shift()!;
    for (const tid of threads) {
      let children: string;
      try {
        children = readFileSync(`/proc/${ppid}/task/${tid}/children`, "utf-8");
      } catch {
        // Gone between the listing and the read, or a kernel without the file.
        continue;
      }
      for (const word of children.split(/\s+/)) {
        const pid = Number(word);
        if (!word || !Number.isInteger(pid)) continue;
        try {
          const args = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ").trim();
          rows.push({ pid, ppid, args });
          queue.push([pid, readdirSync(`/proc/${pid}/task`)]);
        } catch {
          /* exited while being read */
        }
      }
    }
  }
  return rows;
}

function readPsTable(): ProcessRow[] | null {
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
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
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
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
