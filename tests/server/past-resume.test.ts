import { describe, expect, it } from "vitest";
import { fallbackRoot, planResume, settleCloses, type ResumeInput } from "../../src/server/past-resume.js";

const dirs = new Set(["/home/leo/Projects/app", "/home/leo/Projects", "/home/leo", "/tmp"]);
const isDir = (p: string) => dirs.has(p);

function input(patch: Partial<ResumeInput> = {}): ResumeInput {
  return {
    id: "s1",
    cwd: null,
    sessions: [],
    transcript: "/home/leo/.claude/projects/-home-leo-Projects-app/s1.jsonl",
    ranIn: "/home/leo/Projects/app",
    projects: ["/home/leo/Projects/app"],
    isDir,
    ...patch,
  };
}

describe("planResume", () => {
  it("starts in the folder the session ran in", () => {
    expect(planResume(input())).toEqual({
      kind: "start",
      cwd: "/home/leo/Projects/app",
      transcript: "/home/leo/.claude/projects/-home-leo-Projects-app/s1.jsonl",
    });
  });

  it("goes to the pane of a session that is already live, never a second process", () => {
    expect(planResume(input({ sessions: [{ id: "s1", tmux_target: "main:2.0", pane_alive: true }] }))).toEqual({
      kind: "live",
      target: "main:2.0",
    });
    // A closed pane is not live.
    expect(planResume(input({ sessions: [{ id: "s1", tmux_target: "main:2.0", pane_alive: false }] })).kind).toBe("start");
  });

  it("offers the project's root when the folder is gone, and starts there once chosen", () => {
    const gone = input({ ranIn: "/home/leo/Projects/app/.worktree/101" });
    expect(planResume(gone)).toEqual({ kind: "folder-gone", cwd: "/home/leo/Projects/app/.worktree/101", root: "/home/leo/Projects/app" });
    expect(planResume({ ...gone, cwd: "/home/leo/Projects/app" }).kind).toBe("start");
  });

  it("says so for a transcript this machine does not hold", () => {
    expect(planResume(input({ transcript: null }))).toEqual({ kind: "unknown" });
  });
});

describe("fallbackRoot", () => {
  it("takes the deepest remembered project still there, else the nearest folder above", () => {
    expect(fallbackRoot("/home/leo/Projects/app/x/y", ["/home/leo/Projects", "/home/leo/Projects/app"], isDir)).toBe("/home/leo/Projects/app");
    expect(fallbackRoot("/home/leo/Projects/gone/sub", [], isDir)).toBe("/home/leo/Projects");
    expect(fallbackRoot("/srv/x", [], isDir)).toBeNull();
  });
});

describe("settleCloses", () => {
  const idle = { id: "a", tmux_target: "main:1.0", pane_alive: true, state: "idle" };
  it("ends Claude Code idle at its prompt", () => {
    expect(settleCloses(idle)).toBe(true);
  });
  it("leaves running anything else", () => {
    expect(settleCloses({ ...idle, state: "busy" })).toBe(false);
    expect(settleCloses({ ...idle, state: "waiting" })).toBe(false);
    expect(settleCloses({ ...idle, agent: "gemini" })).toBe(false);
    expect(settleCloses({ ...idle, queue: [{}] })).toBe(false);
    expect(settleCloses({ ...idle, subagents: [{ state: "running" }] })).toBe(false);
    expect(settleCloses({ ...idle, pane_alive: false })).toBe(false);
    expect(settleCloses({ ...idle, draft_input: "half a thought" })).toBe(false);
    expect(settleCloses({ ...idle, pane_activity: { label: "Compacting" } })).toBe(false);
    expect(settleCloses({ ...idle, draft_input: "try this", draft_kind: "suggestion" })).toBe(true);
  });
});
