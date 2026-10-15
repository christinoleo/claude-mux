import { describe, expect, it } from "vitest";
import { carryPath, folderMarker, openOn, type OpenFolder } from "../src/folder-marks.js";

const repo = "git:github.com/christinoleo/claude-mux";

function folder(machineId: string, root: string, over: Partial<OpenFolder> = {}): OpenFolder {
  return { machineId, root, project: `path:${machineId}:${root}`, name: root.split("/").pop()!, live: 0, wants: false, ...over };
}

const omarchyWatch = folder("omarchy", "/home/leo/Projects/claude-watch", { project: repo, name: "claude-mux", live: 2 });
const omarchyNotes = folder("omarchy", "/home/leo/Projects/notes", { project: "dir:notes" });
const omarchyDeep = folder("omarchy", "/home/leo/Projects/work/api", { project: "dir:work/api", live: 1, wants: true });
const engageOther = folder("engage", "/home/leo/Projects/other", { project: "dir:other", live: 1 });
const open = [omarchyWatch, omarchyNotes, omarchyDeep, engageOther];

describe("folderMarker", () => {
  it("marks a folder with live sessions on the machine browsed", () => {
    const marks = folderMarker("omarchy", open)("/home/leo/Projects/claude-watch");
    expect(marks.here).toBe(omarchyWatch);
    expect(marks.here?.live).toBe(2);
    expect(marks.elsewhere).toEqual([]);
  });

  it("marks a project on the rail with no live session", () => {
    const marks = folderMarker("omarchy", open)("/home/leo/Projects/notes");
    expect(marks.here).toBe(omarchyNotes);
    expect(marks.here?.live).toBe(0);
  });

  it("marks a folder no root here as open on the machine that holds its project", () => {
    // engage's clone is called claude-mux; the project is named after the repo.
    const marks = folderMarker("engage", open)("/home/leo/Projects/claude-mux");
    expect(marks.here).toBeNull();
    expect(marks.elsewhere).toEqual([omarchyWatch]);
  });

  it("matches by the place under ~/Projects when the folder keeps another machine's name", () => {
    const marks = folderMarker("engage", open)("/home/leo/Projects/claude-watch");
    expect(marks.elsewhere).toEqual([omarchyWatch]);
  });

  it("matches a root on both machines by its project key, whatever the folders are called", () => {
    const engageMux = folder("engage", "/srv/claude-mux", { project: repo, name: "claude-mux" });
    const marks = folderMarker("engage", [...open, engageMux])("/srv/claude-mux");
    expect(marks.here).toBe(engageMux);
    expect(marks.elsewhere).toEqual([omarchyWatch]);
  });

  it("puts machines with live sessions first among the others", () => {
    const idle = folder("distilo", "/home/leo/Projects/claude-mux", { project: repo, name: "claude-mux" });
    const marks = folderMarker("engage", [idle, ...open])("/home/leo/Projects/claude-mux");
    expect(marks.elsewhere).toEqual([omarchyWatch, idle]);
  });

  it("leaves a folder nobody holds unmarked", () => {
    const marks = folderMarker("engage", open)("/home/leo/Projects/elsewhere");
    expect(marks).toEqual({ here: null, elsewhere: [], below: 0 });
  });

  it("does not guess between two projects of one name", () => {
    const a = folder("a", "/opt/x/tool", { project: "path:a:/opt/x/tool", name: "tool" });
    const b = folder("b", "/opt/y/tool", { project: "path:b:/opt/y/tool", name: "tool" });
    expect(folderMarker("c", [a, b])("/home/leo/Projects/tool").elsewhere).toEqual([]);
  });

  it("counts the open folders below a folder on the machine browsed, at any depth", () => {
    const mark = folderMarker("omarchy", open);
    expect(mark("/home/leo/Projects").below).toBe(3);
    expect(mark("/home/leo/Projects/work").below).toBe(1);
    expect(mark("/home/leo").below).toBe(3);
    expect(mark("/").below).toBe(3);
    // Not the folder itself, nor a sibling that shares its prefix.
    expect(mark("/home/leo/Projects/claude-watch").below).toBe(0);
    expect(mark("/home/leo/Projects/claude").below).toBe(0);
  });

  it("counts only the machine browsed", () => {
    expect(folderMarker("engage", open)("/home/leo/Projects").below).toBe(1);
  });

  it("ignores sessions that said nowhere", () => {
    const loose = folder("omarchy", "", { live: 1 });
    expect(folderMarker("omarchy", [loose])("/").below).toBe(0);
  });
});

describe("openOn", () => {
  it("lists one machine's open folders, wanting first, then live, then the rest", () => {
    expect(openOn("omarchy", open)).toEqual([omarchyDeep, omarchyWatch, omarchyNotes]);
  });

  it("leaves out the no-folder project", () => {
    expect(openOn("omarchy", [folder("omarchy", "", { live: 1 })])).toEqual([]);
  });
});

describe("carryPath", () => {
  it("keeps a path relative to home", () => {
    expect(carryPath("/home/leo/Projects/claude-watch", "/home/leo")).toBe("~/Projects/claude-watch");
  });

  it("keeps home as home", () => {
    expect(carryPath("/home/leo", "/home/leo")).toBe("~");
  });

  it("keeps a path outside home as it is", () => {
    expect(carryPath("/srv/data", "/home/leo")).toBe("/srv/data");
    expect(carryPath("/home/leonard/x", "/home/leo")).toBe("/home/leonard/x");
  });

  it("keeps the path when home is unknown", () => {
    expect(carryPath("/home/leo/x", "")).toBe("/home/leo/x");
  });
});

describe("folderMarker, a root here that another machine reports properly", () => {
  it("joins a root reported without its remote to the repo held elsewhere", () => {
    const stale = folder("engage", "/home/leo/Projects/claude-mux", { project: "dir:claude-mux", name: "claude-mux" });
    const marks = folderMarker("engage", [...open, stale])("/home/leo/Projects/claude-mux");
    expect(marks.here).toBe(stale);
    expect(marks.elsewhere).toEqual([omarchyWatch]);
  });
});

describe("folderMarker, unrelated projects that share a place or name", () => {
  it("does not join a repo here to another repo at the same place elsewhere", () => {
    const a = folder("omarchy", "/home/leo/Projects/api", { project: "git:x/a", name: "api" });
    const b = folder("engage", "/home/leo/Projects/api", { project: "git:x/b", name: "api" });
    expect(folderMarker("omarchy", [a, b])("/home/leo/Projects/api").elsewhere).toEqual([]);
  });

  it("matches by name only a repo, never a folder that happens to share it", () => {
    const notes = folder("engage", "/srv/notes", { project: "path:engage:/srv/notes", name: "notes" });
    expect(folderMarker("omarchy", [notes])("/home/leo/Projects/notes").elsewhere).toEqual([]);
  });

  it("keys two checkouts on one machine apart", () => {
    const one = folder("engage", "/home/leo/Projects/claude-mux", { project: repo, name: "claude-mux" });
    const two = folder("engage", "/srv/claude-mux", { project: repo, name: "claude-mux" });
    expect(folderMarker("omarchy", [omarchyWatch, one, two])("/home/leo/Projects/claude-watch").elsewhere).toEqual([one, two]);
  });
});
