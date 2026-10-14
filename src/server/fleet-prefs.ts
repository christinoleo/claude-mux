/**
 * This machine's copy of the fleet preferences (`src/fleet-prefs.ts`), kept
 * in `~/.claude-mux/fleet-prefs.json`.
 *
 * A page writes through `set()`, stamped with this machine's clock and id;
 * another machine's set arrives through `merge()` from the fleet state, which
 * reads it off that machine's sessions socket. Either way the subscribers
 * hear of a change, and the sessions socket sends the whole set to every page
 * and every peer that follows this machine. A peer that learns nothing new
 * from it says nothing back, which is what ends the exchange.
 */

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isPrefKey, isServerOnlyKey, mergePrefs, type FleetPrefs } from "../fleet-prefs.js";

export interface FleetPrefsOptions {
  selfId: string;
  /** Where the set is kept on disk; null keeps it in memory only. */
  path: string | null;
  now?: () => number;
}

export class FleetPrefsStore {
  private prefs: FleetPrefs;
  private listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: FleetPrefsOptions) {
    this.now = options.now ?? Date.now;
    this.prefs = mergePrefs({}, this.restore()).prefs;
  }

  all(): FleetPrefs {
    return this.prefs;
  }

  /** The set without the keys the servers keep among themselves (`isServerOnlyKey()`): what a page is sent. */
  forPages(): FleetPrefs {
    return Object.fromEntries(Object.entries(this.prefs).filter(([key]) => !isServerOnlyKey(key)));
  }

  /**
   * A page's write. A clock that reads earlier than the entry it replaces
   * (another machine's, a little ahead) is moved past it, so the write a
   * person just made is never lost to the one before it. False for a key or
   * value that cannot be kept.
   */
  set(key: string, value: unknown): boolean {
    if (!isPrefKey(key) || value === undefined) return false;
    const before = this.prefs[key]?.at ?? 0;
    const at = Math.max(this.now(), before + 1);
    this.prefs = { ...this.prefs, [key]: { value, at, by: this.options.selfId } };
    this.changed();
    return true;
  }

  /** Another machine's set; true when anything in it was newer. */
  merge(incoming: unknown): boolean {
    const { prefs, changed } = mergePrefs(this.prefs, incoming);
    if (changed.length === 0) return false;
    this.prefs = prefs;
    this.changed();
    return true;
  }

  /** Called after every change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[fleet-prefs] listener failed:", err);
      }
    }
  }

  /**
   * The file is read and merged before it is written: a dev server beside
   * the prod one shares the file and the machine id, follows neither, and
   * would otherwise drop the other's writes from it with its own.
   */
  private persist(): void {
    const path = this.options.path;
    if (!path) return;
    this.prefs = mergePrefs(this.prefs, this.restore()).prefs;
    try {
      writeFileAtomic(path, JSON.stringify({ prefs: this.prefs }));
    } catch (err) {
      console.error("[fleet-prefs] could not write", path, err);
    }
  }

  private restore(): unknown {
    const path = this.options.path;
    if (!path) return {};
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { prefs?: unknown }).prefs;
    } catch {
      return {};
    }
  }
}
