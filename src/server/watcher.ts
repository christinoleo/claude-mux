import { readdirSync, statSync } from "fs";
import { SESSIONS_DIR } from "../utils/paths.js";
import { join } from "path";

export interface WatcherCallback {
  (): void;
}

/**
 * Simple polling-based file watcher for session JSON files.
 * More reliable than inotify for long-running processes.
 */
class SessionWatcher {
  private subscribers = new Set<WatcherCallback>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastState = new Map<string, number>(); // filename -> mtime
  private readonly pollInterval = 500;

  private start(): void {
    if (this.pollTimer) return;

    console.log("[watcher] Started polling", SESSIONS_DIR, `(${this.pollInterval}ms)`);

    // Initialize state
    this.updateState();

    this.pollTimer = setInterval(() => {
      if (this.checkForChanges()) {
        this.notifySubscribers();
      }
    }, this.pollInterval);
  }

  private updateState(): void {
    this.lastState.clear();
    try {
      const files = readdirSync(SESSIONS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const stat = statSync(join(SESSIONS_DIR, file));
          this.lastState.set(file, stat.mtimeMs);
        } catch {
          // File may have been deleted
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private checkForChanges(): boolean {
    const newState = new Map<string, number>();
    let changed = false;

    try {
      const files = readdirSync(SESSIONS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const stat = statSync(join(SESSIONS_DIR, file));
          newState.set(file, stat.mtimeMs);

          const oldMtime = this.lastState.get(file);
          if (oldMtime === undefined) {
            // New file
            console.log("[watcher] File added:", file);
            changed = true;
          } else if (oldMtime !== stat.mtimeMs) {
            // Modified file
            console.log("[watcher] File changed:", file);
            changed = true;
          }
        } catch {
          // File may have been deleted during iteration
        }
      }

      // Check for deleted files
      for (const file of this.lastState.keys()) {
        if (!newState.has(file)) {
          console.log("[watcher] File removed:", file);
          changed = true;
        }
      }
    } catch {
      // Directory may not exist
    }

    this.lastState = newState;
    return changed;
  }

  private notifySubscribers(): void {
    console.log("[watcher] Notifying", this.subscribers.size, "subscribers");
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch (error) {
        console.error("[watcher] Subscriber error:", error);
      }
    }
  }

  subscribe(callback: WatcherCallback): () => void {
    this.subscribers.add(callback);
    if (this.subscribers.size === 1) {
      this.start();
    }
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stop();
      }
    };
  }

  private stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.lastState.clear();
    console.log("[watcher] Stopped");
  }
}

export const sessionWatcher = new SessionWatcher();
