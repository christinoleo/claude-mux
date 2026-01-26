import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  cleanupStaleSessions,
  upsertSession,
  getAllSessions,
  setSessionsDir,
} from "../../src/db/index.js";

const testDir = join(tmpdir(), `claude-watch-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe("db/index (JSON files)", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    setSessionsDir(testDir);
  });

  afterEach(() => {
    setSessionsDir(null); // Reset to default
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe("cleanupStaleSessions", () => {
    it("should remove sessions with dead PIDs", () => {
      // Insert a session with a non-existent PID
      upsertSession({
        id: "dead-session",
        pid: 999999999, // Very unlikely to exist
        cwd: "/test",
      });

      const removed = cleanupStaleSessions();
      expect(removed).toBe(1);

      const sessions = getAllSessions();
      expect(sessions.find((s) => s.id === "dead-session")).toBeUndefined();
    });

    it("should keep sessions with alive PIDs", () => {
      // Insert a session with our current PID
      upsertSession({
        id: "alive-session",
        pid: process.pid,
        cwd: "/test",
      });

      const removed = cleanupStaleSessions();
      expect(removed).toBe(0);

      const sessions = getAllSessions();
      expect(sessions.find((s) => s.id === "alive-session")).toBeDefined();
    });

    it("should handle empty directory", () => {
      const removed = cleanupStaleSessions();
      expect(removed).toBe(0);
    });

    it("should skip sessions with PID 0", () => {
      // Sessions with PID 0 should only be cleaned by session-end
      upsertSession({
        id: "unknown-pid-session",
        pid: 0,
        cwd: "/test",
      });

      const removed = cleanupStaleSessions();
      expect(removed).toBe(0);

      const sessions = getAllSessions();
      expect(sessions.find((s) => s.id === "unknown-pid-session")).toBeDefined();
    });
  });
});
