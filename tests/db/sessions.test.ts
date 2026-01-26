import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  upsertSession,
  updateSession,
  getSession,
  getAllSessions,
  deleteSession,
  getSessionPids,
  deleteSessionsByPids,
  setSessionsDir,
} from "../../src/db/index.js";

const testDir = join(tmpdir(), `claude-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe("sessions (JSON files)", () => {
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

  describe("upsertSession", () => {
    it("should insert a new session", () => {
      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/home/user/project",
      });

      const session = getSession("session-1");
      expect(session).not.toBeNull();
      expect(session?.id).toBe("session-1");
      expect(session?.pid).toBe(1234);
      expect(session?.cwd).toBe("/home/user/project");
      expect(session?.state).toBe("busy");
      expect(session?.v).toBe(1); // Schema version
    });

    it("should update an existing session", () => {
      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/home/user/project",
      });

      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/home/user/other-project",
        state: "idle",
      });

      const session = getSession("session-1");
      expect(session?.cwd).toBe("/home/user/other-project");
      expect(session?.state).toBe("idle");
    });

    it("should store tmux_target", () => {
      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/home/user/project",
        tmux_target: "main:0.1",
      });

      const session = getSession("session-1");
      expect(session?.tmux_target).toBe("main:0.1");
    });

    it("should handle null tmux_target", () => {
      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/home/user/project",
        tmux_target: null,
      });

      const session = getSession("session-1");
      expect(session?.tmux_target).toBeNull();
    });
  });

  describe("updateSession", () => {
    beforeEach(() => {
      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/home/user/project",
      });
    });

    it("should update state", () => {
      updateSession("session-1", { state: "waiting" });

      const session = getSession("session-1");
      expect(session?.state).toBe("waiting");
    });

    it("should update current_action", () => {
      updateSession("session-1", { current_action: "Running: Bash" });

      const session = getSession("session-1");
      expect(session?.current_action).toBe("Running: Bash");
    });

    it("should update prompt_text", () => {
      updateSession("session-1", { prompt_text: "What should I do next?" });

      const session = getSession("session-1");
      expect(session?.prompt_text).toBe("What should I do next?");
    });

    it("should update last_update timestamp", () => {
      const before = Date.now();
      updateSession("session-1", { state: "idle" });
      const after = Date.now();

      const session = getSession("session-1");
      expect(session?.last_update).toBeGreaterThanOrEqual(before);
      expect(session?.last_update).toBeLessThanOrEqual(after);
    });
  });

  describe("getAllSessions", () => {
    it("should return empty array when no sessions", () => {
      const sessions = getAllSessions();
      expect(sessions).toEqual([]);
    });

    it("should return all sessions sorted by priority", () => {
      upsertSession({
        id: "session-1",
        pid: 1001,
        cwd: "/project1",
        state: "busy",
      });
      upsertSession({
        id: "session-2",
        pid: 1002,
        cwd: "/project2",
        state: "waiting",
      });
      upsertSession({
        id: "session-3",
        pid: 1003,
        cwd: "/project3",
        state: "permission",
      });
      upsertSession({
        id: "session-4",
        pid: 1004,
        cwd: "/project4",
        state: "idle",
      });

      const sessions = getAllSessions();
      expect(sessions.length).toBe(4);
      // Permission first, then waiting, then idle, then busy
      expect(sessions[0].state).toBe("permission");
      expect(sessions[1].state).toBe("waiting");
      expect(sessions[2].state).toBe("idle");
      expect(sessions[3].state).toBe("busy");
    });
  });

  describe("deleteSession", () => {
    it("should delete a session", () => {
      upsertSession({
        id: "session-1",
        pid: 1234,
        cwd: "/project",
      });

      deleteSession("session-1");

      const session = getSession("session-1");
      expect(session).toBeNull();
    });

    it("should not throw when deleting non-existent session", () => {
      expect(() => deleteSession("non-existent")).not.toThrow();
    });
  });

  describe("getSessionPids", () => {
    it("should return all PIDs", () => {
      upsertSession({ id: "s1", pid: 1001, cwd: "/p1" });
      upsertSession({ id: "s2", pid: 1002, cwd: "/p2" });
      upsertSession({ id: "s3", pid: 1003, cwd: "/p3" });

      const pids = getSessionPids();
      expect(pids).toContain(1001);
      expect(pids).toContain(1002);
      expect(pids).toContain(1003);
      expect(pids.length).toBe(3);
    });
  });

  describe("deleteSessionsByPids", () => {
    it("should delete sessions by PIDs", () => {
      upsertSession({ id: "s1", pid: 1001, cwd: "/p1" });
      upsertSession({ id: "s2", pid: 1002, cwd: "/p2" });
      upsertSession({ id: "s3", pid: 1003, cwd: "/p3" });

      deleteSessionsByPids([1001, 1003]);

      const sessions = getAllSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe("s2");
    });

    it("should handle empty PID array", () => {
      upsertSession({ id: "s1", pid: 1001, cwd: "/p1" });

      deleteSessionsByPids([]);

      const sessions = getAllSessions();
      expect(sessions.length).toBe(1);
    });
  });
});
