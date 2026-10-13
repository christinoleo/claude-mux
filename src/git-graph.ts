/**
 * Lanes for a commit graph.
 *
 * Commits arrive newest first, each naming its parents. A lane is a column a
 * line of history runs down; a commit sits in the lane that was waiting for
 * it, its first parent carries that lane on, and any other parent opens a lane
 * of its own (or joins the one already waiting for it). Lanes never shift
 * sideways, so a branch is a straight line from its tip to where it forks.
 */

export interface GraphInput {
  hash: string;
  parents: string[];
}

export interface GraphRow {
  /** The column the commit's dot sits in. */
  lane: number;
  /** Lanes with a line arriving from above that end at this commit. */
  into: number[];
  /** Lanes with a line that passes this row without touching the commit. */
  through: number[];
  /** Lanes a line leaves this commit toward, one per parent that is listed further down. */
  out: number[];
}

export interface Graph {
  rows: GraphRow[];
  /** The most lanes any row uses, for sizing the column the graph is drawn in. */
  width: number;
}

export function layoutGraph(commits: readonly GraphInput[]): Graph {
  const listed = new Set(commits.map((c) => c.hash));
  /** What each lane is waiting for next, or null when it is free. */
  const waiting: (string | null)[] = [];
  const free = () => {
    const at = waiting.indexOf(null);
    return at === -1 ? waiting.length : at;
  };
  const rows: GraphRow[] = [];
  let width = 0;

  for (const commit of commits) {
    const into: number[] = [];
    waiting.forEach((hash, lane) => {
      if (hash === commit.hash) into.push(lane);
    });
    const lane = into[0] ?? free();
    const through: number[] = [];
    waiting.forEach((hash, i) => {
      if (hash !== null && hash !== commit.hash) through.push(i);
    });
    // Every lane that was waiting for this commit ends here; its own carries on below.
    for (const i of into) waiting[i] = null;
    waiting[lane] = null;

    const out: number[] = [];
    // A parent outside the listing (history cut short) draws no line: nothing is there to reach.
    const parents = commit.parents.filter((p) => listed.has(p));
    parents.forEach((parent, n) => {
      // The first parent carries this lane on, even when another lane already
      // waits for the same commit: the two meet there, and neither bends early.
      let to = n === 0 ? lane : waiting.indexOf(parent);
      if (to === -1) to = free();
      waiting[to] = parent;
      if (!out.includes(to)) out.push(to);
    });

    while (waiting.length > 0 && waiting[waiting.length - 1] === null) waiting.pop();
    width = Math.max(width, lane + 1, ...through.map((i) => i + 1), ...out.map((i) => i + 1));
    rows.push({ lane, into, through, out });
  }
  return { rows, width };
}
