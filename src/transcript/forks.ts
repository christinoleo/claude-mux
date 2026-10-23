import type { TranscriptItem } from "./tool-groups.js";

/**
 * Where a rewind left the conversation.
 *
 * Claude Code's rewind (Esc Esc, or /rewind) writes nothing when it runs: the
 * next prompt is simply logged with the `parentUuid` of the point it went
 * back to, in the same file, so the log becomes a tree and the turns after
 * that point are a branch nobody follows any more. A prompt is the first sign
 * of it, then, and the test is whether anything the model said was logged
 * between its parent and itself: an ordinary prompt hangs off the line just
 * before it, give or take Claude Code's own bookkeeping, and only a rewind
 * skips an answer.
 */
export class ForkTracker {
  private seqByUuid = new Map<string, number>();
  private next = 0;
  private lastAssistant = -1;

  /** Note a main-conversation line in file order; answers its position. */
  see(uuid: string | null, type: unknown): number {
    const seq = this.next++;
    if (uuid) this.seqByUuid.set(uuid, seq);
    if (type === "assistant") this.lastAssistant = seq;
    return seq;
  }

  /**
   * For a prompt about to be noted, the position after which the conversation
   * was abandoned (everything after it, up to the prompt, is the old branch),
   * or null when the prompt simply follows on.
   */
  abandonedAfter(parentUuid: string | null): number | null {
    if (!parentUuid) return null;
    const parent = this.seqByUuid.get(parentUuid);
    if (parent === undefined || this.lastAssistant <= parent) return null;
    return parent;
  }
}

/** A run of items a rewind went back past, drawn folded. */
export interface RewoundRun {
  kind: "rewound";
  id: string;
  items: TranscriptItem[];
  /** How many prompts it holds. */
  turns: number;
}

const isRewound = (item: TranscriptItem) => (item.kind === "group" ? item.entries[0]?.rewound : item.rewound) === true;

/** Fold each run of rewound items into one, leaving the rest as they are. */
export function foldRewound(items: TranscriptItem[]): (TranscriptItem | RewoundRun)[] {
  const out: (TranscriptItem | RewoundRun)[] = [];
  for (const item of items) {
    if (!isRewound(item)) {
      out.push(item);
      continue;
    }
    let run = out[out.length - 1];
    if (run?.kind !== "rewound") {
      run = { kind: "rewound", id: `rewound:${item.id}`, items: [], turns: 0 };
      out.push(run);
    }
    run.items.push(item);
    if (item.kind === "user") run.turns++;
  }
  return out;
}
