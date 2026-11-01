/**
 * Live text: the words of a reply while Claude writes them, before they enter
 * the session's record (see GLOSSARY.md).
 *
 * The `MessageDisplay` hook hands the server batches of whole lines. They are
 * held here, in memory only, until the transcript's own entry lands and takes
 * their place. The JSONL stays the only record: nothing here is written down,
 * a restart loses it, and live text that never gets an entry is discarded.
 *
 * Neither ids nor anything else ties a batch to an entry — `message_id` appears
 * nowhere in the transcript — so they are matched by text and order
 * (docs/research/message-display.md on the research/message-display branch).
 *
 * An entry holds one content block and a message's batches run its text blocks
 * together with no separator, so a landing entry can account for only part of
 * a message. `consumed` counts how much of it the record has taken so far. It
 * may run past the text held, which is how a batch that arrives after its own
 * entry stays hidden, and an entry that took a message by order alone says
 * nothing about what remains, so it takes all of it.
 */

import { z } from "zod";

/** What a reader is sent of one message: what the record has not taken yet. */
export interface LiveText {
  id: string;
  ts: number;
  text: string;
}

export const LiveBatchSchema = z.object({
  // It names a file under the sessions directory.
  session_id: z.string().regex(/^[\w-]+$/),
  message_id: z.string(),
  index: z.number().int(),
  delta: z.string(),
  final: z.boolean().nullish(),
});

export type LiveBatch = z.infer<typeof LiveBatchSchema>;

/** One batch's effect on what a reader holds: from `start` on, the text is now `text`. */
interface LivePiece {
  start: number;
  text: string;
}

interface LiveMessage {
  id: string;
  startedAt: number;
  lastBatchAt: number;
  /** In `index` order: calls overlap, so they can arrive in any. */
  batches: { index: number; length: number }[];
  text: string;
  consumed: number;
  final: boolean;
  /** When its final batch, a newer message or a prompt showed it will get no more text. */
  endedAt: number | null;
}

/** Live text with no entry goes this long after it ended: its entry reached the file long ago, or never will. */
export const CUT_OFF_KEEP_MS = 60_000;
/**
 * A message the record has taken in full is forgotten after this long. It
 * outlasts the hook's 1s timeout, so no straggler can bring the text back.
 */
const CONSUMED_KEEP_MS = 5_000;
/**
 * How long an entry that matched no live text waits for its batches. The last
 * batch usually beats its entry by a fraction of a second, so a stall can turn
 * that around, and the same reply would then be drawn twice.
 */
const UNCLAIMED_KEEP_MS = 5_000;

function visible(message: LiveMessage): string {
  const rest = message.text.slice(message.consumed);
  return rest.trim().length > 0 ? rest : "";
}

/** Batches are numbered from 0, so a hole in the numbers is a hook call that failed. */
function hasGap(message: LiveMessage): boolean {
  return message.batches.some((batch, i) => batch.index !== i);
}

/** The entry begins with this live text, so all of it is the record's now. */
function takenWhole(message: LiveMessage, entryText: string): boolean {
  const text = visible(message);
  const whole = entryText.trim();
  if (!whole.startsWith(text.trim())) return false;
  const end = text.length - text.trimStart().length + whole.length;
  const rest = text.slice(end);
  message.consumed += end + rest.length - rest.trimStart().length;
  return true;
}

/** The live text begins with this entry: an earlier text block of the same message. */
function takenInPart(message: LiveMessage, entryText: string): boolean {
  const text = visible(message);
  const body = text.trimStart();
  const whole = entryText.trim();
  if (!body.startsWith(whole)) return false;
  const rest = body.slice(whole.length);
  message.consumed += text.length - rest.trimStart().length;
  return true;
}

export class LiveTextStore {
  private sessions = new Map<string, LiveMessage[]>();
  private unclaimed = new Map<string, { text: string; at: number }[]>();

  holds(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Store a batch; returns what changed for a reader, or null if nothing did. */
  accept(batch: LiveBatch, now: number): LivePiece | null {
    let messages = this.sessions.get(batch.session_id);
    if (!messages) {
      messages = [];
      this.sessions.set(batch.session_id, messages);
    }
    let message = messages.find((m) => m.id === batch.message_id);
    if (!message) {
      for (const older of messages) older.endedAt ??= now;
      message = {
        id: batch.message_id,
        startedAt: now,
        lastBatchAt: now,
        batches: [],
        text: "",
        consumed: 0,
        final: false,
        endedAt: null,
      };
      messages.push(message);
    }
    message.lastBatchAt = now;
    // More text means a prompt did not end it after all, as one queued mid-reply
    // would seem to. A newer message did, and so did its own final batch: this
    // is only a call that was in flight.
    if (message === messages[messages.length - 1] && !message.final) message.endedAt = null;
    if (batch.final) {
      message.final = true;
      message.endedAt ??= now;
    }

    const { batches } = message;
    let at = batches.length;
    let start = message.text.length;
    while (at > 0 && batches[at - 1].index > batch.index) {
      at--;
      start -= batches[at].length;
    }
    if (at > 0 && batches[at - 1].index === batch.index) return null;

    const before = visible(message);
    batches.splice(at, 0, { index: batch.index, length: batch.delta.length });
    message.text = message.text.slice(0, start) + batch.delta + message.text.slice(start);
    const claimed = this.claim(batch.session_id, message, now);

    const after = visible(message);
    if (after === before) return null;
    // A reader holding nothing for this message (it was all whitespace, or all
    // taken), or text an entry has just taken from under it, starts over.
    const from = before === "" || claimed ? 0 : Math.max(0, start - message.consumed);
    return { start: from, text: after.slice(from) };
  }

  /** An entry that arrived ahead of this message's batches takes them now. */
  private claim(sessionId: string, message: LiveMessage, now: number): boolean {
    this.pruneUnclaimed(now);
    const entries = this.unclaimed.get(sessionId);
    if (!entries || visible(message) === "") return false;
    const at = entries.findIndex((e) => takenWhole(message, e.text) || takenInPart(message, e.text));
    if (at < 0) return false;
    entries.splice(at, 1);
    return true;
  }

  /** Across all sessions: one that goes quiet would never clear its own, and every session parks entries, hook or no hook. */
  private pruneUnclaimed(now: number): void {
    for (const [sessionId, entries] of this.unclaimed) {
      const fresh = entries.filter((e) => now - e.at < UNCLAIMED_KEEP_MS);
      if (fresh.length > 0) this.unclaimed.set(sessionId, fresh);
      else this.unclaimed.delete(sessionId);
    }
  }

  /** A prompt was submitted at `at`: whatever had stopped by then was cut off. */
  promptSubmitted(sessionId: string, at: number): void {
    for (const message of this.sessions.get(sessionId) ?? []) {
      if (message.lastBatchAt < at) message.endedAt ??= at;
    }
  }

  /**
   * An assistant entry landed. It replaces the oldest live text it begins
   * with, takes its share of a message that begins with it, and failing both
   * replaces the oldest live text that could have lost a batch. Live text
   * still streaming with no hole in it cannot be that entry's, whatever the
   * entry says. An entry that finds nothing waits a moment for its batches.
   * Returns true if what readers see changed.
   */
  land(sessionId: string, entryText: string, now: number): boolean {
    const messages = (this.sessions.get(sessionId) ?? []).filter((m) => visible(m) !== "");
    if (messages.some((m) => takenWhole(m, entryText))) return true;
    if (messages.some((m) => takenInPart(m, entryText))) return true;
    const lost = messages.find((m) => m.endedAt !== null || hasGap(m));
    if (lost) {
      lost.consumed = Infinity;
      return true;
    }
    this.pruneUnclaimed(now);
    const entries = this.unclaimed.get(sessionId) ?? [];
    entries.push({ text: entryText, at: now });
    this.unclaimed.set(sessionId, entries);
    return false;
  }

  /** Discard what has outstayed its welcome; returns true if a reader could see it. */
  expire(sessionId: string, now: number): boolean {
    const messages = this.sessions.get(sessionId);
    if (!messages) return false;
    let seen = false;
    const kept = messages.filter((message) => {
      const shown = visible(message) !== "";
      const gone = shown
        ? message.endedAt !== null && now - message.endedAt >= CUT_OFF_KEEP_MS
        : now - message.lastBatchAt >= CONSUMED_KEEP_MS;
      if (gone && shown) seen = true;
      return !gone;
    });
    if (kept.length > 0) this.sessions.set(sessionId, kept);
    else this.sessions.delete(sessionId);
    return seen;
  }

  /** The session died; returns true if a reader could see any of it. */
  drop(sessionId: string): boolean {
    const seen = this.view(sessionId).length > 0;
    this.sessions.delete(sessionId);
    this.unclaimed.delete(sessionId);
    return seen;
  }

  /** What a reader connecting now should hold, oldest first. */
  view(sessionId: string): LiveText[] {
    const live: LiveText[] = [];
    for (const message of this.sessions.get(sessionId) ?? []) {
      const text = visible(message);
      if (text !== "") live.push({ id: message.id, ts: message.startedAt, text });
    }
    return live;
  }
}
