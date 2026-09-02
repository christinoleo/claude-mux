import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getSavedProjects,
  saveProject,
  saveProjects,
  removeProject,
  setProjectsPath,
} from "../../src/db/projects-json.js";

const testDir = join(tmpdir(), `claude-mux-projects-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const path = join(testDir, "projects.json");

describe("projects (JSON file)", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    setProjectsPath(path);
  });

  afterEach(() => {
    setProjectsPath(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("starts empty and remembers projects in the order they were first seen", () => {
    expect(getSavedProjects()).toEqual([]);
    expect(saveProject("/home/me/b")).toBe(true);
    expect(saveProjects(["/home/me/a", "/home/me/b"])).toBe(true);
    expect(getSavedProjects()).toEqual(["/home/me/b", "/home/me/a"]);
  });

  it("says when nothing changed, so a poll can skip the broadcast", () => {
    saveProject("/home/me/a");
    expect(saveProject("/home/me/a")).toBe(false);
    expect(saveProjects(["", "/home/me/a"])).toBe(false);
    expect(removeProject("/home/me/zzz")).toBe(false);
  });

  it("forgets a project on request", () => {
    saveProjects(["/home/me/a", "/home/me/b"]);
    expect(removeProject("/home/me/a")).toBe(true);
    expect(getSavedProjects()).toEqual(["/home/me/b"]);
  });

  it("survives a torn or hand-edited file", () => {
    writeFileSync(path, "{ not json");
    expect(getSavedProjects()).toEqual([]);
    writeFileSync(path, JSON.stringify({ projects: ["/x", 3, "", "/x", "/y"] }));
    expect(getSavedProjects()).toEqual(["/x", "/y"]);
  });
});
