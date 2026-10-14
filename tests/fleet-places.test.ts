import { describe, expect, it } from "vitest";
import { NO_FOLDER, panesByRoot, projectRoots, rootOf, type PlainPane } from "../src/fleet-places.js";
import { guessReport, mergeProjects, type ProjectReport } from "../src/fleet-projects.js";

const pane = (target: string, cwd: string, command = "zsh"): PlainPane => ({
  target,
  session: target.split(":")[0],
  command,
  cwd,
  title: null,
});

const targets = (byRoot: Map<string, PlainPane[]>) =>
  Object.fromEntries([...byRoot].map(([root, list]) => [root, list.map((p) => p.target)]));

describe("projectRoots", () => {
  it("keeps the remembered roots and adds a folder under none of them, shallowest first", () => {
    expect(projectRoots(["/home/leo/Projects/app"], ["/home/leo/Projects/app/web", "/home/leo/Downloads/x/y", "/home/leo/Downloads/x"])).toEqual([
      "/home/leo/Projects/app",
      "/home/leo/Downloads/x",
    ]);
  });

  it("makes a folder that is nobody's project one of its own, after the rest, so it takes in nothing below it", () => {
    expect(projectRoots([], ["/home/leo", "/home/leo/Downloads/x", "/tmp"])).toEqual(["/home/leo/Downloads/x", "/home/leo", "/tmp"]);
  });

  it("adds the no-folder root only when something has not said where it runs", () => {
    expect(projectRoots(["/p/app"], ["/p/app"])).toEqual(["/p/app"]);
    expect(projectRoots(["/p/app"], ["/p/app", ""])).toEqual(["/p/app", NO_FOLDER]);
    expect(projectRoots([], [null])).toEqual([NO_FOLDER]);
  });
});

describe("rootOf", () => {
  it("is the deepest root holding the folder, the no-folder root for none given", () => {
    const roots = ["/p/app", "/p/app/web", NO_FOLDER];
    expect(rootOf("/p/app/web/src", roots)).toBe("/p/app/web");
    expect(rootOf("/p/app/.worktree/9", roots)).toBe("/p/app");
    expect(rootOf("", roots)).toBe(NO_FOLDER);
    expect(rootOf("/elsewhere", roots)).toBeNull();
    expect(rootOf(null, ["/p/app"])).toBeNull();
  });
});

describe("panesByRoot", () => {
  it("puts every plain pane under a root, leaving out those a Claude session runs in", () => {
    const panes = [
      pane("dev:1.0", "/home/leo/Projects/app/web", "node"),
      pane("main:1.0", "/home/leo"),
      pane("main:2.0", "/tmp/scratch"),
      pane("work:1.0", "/home/leo/Projects/app"),
      pane("odd:1.0", ""),
    ];
    const roots = projectRoots(
      ["/home/leo/Projects/app"],
      panes.map((p) => p.cwd)
    );
    expect(targets(panesByRoot(panes, roots, new Set(["work:1.0"])))).toEqual({
      "/home/leo/Projects/app": ["dev:1.0"],
      "/home/leo": ["main:1.0"],
      "/tmp/scratch": ["main:2.0"],
      [NO_FOLDER]: ["odd:1.0"],
    });
  });

  it("places each machine's panes under the one project the fleet makes of them", () => {
    // omarchy holds the repo and a shell in ~; engage runs a dev server in its own clone.
    const report: ProjectReport = { root: "/home/leo/Projects/claude-watch", remote: "github.com/leo/claude-mux", sub: "", home: "claude-watch", icon: null };
    const engageReport: ProjectReport = { ...report, root: "/home/leo/Projects/claude-mux", home: "claude-mux" };
    const machines = [
      { id: "omarchy", projects: [report.root], reports: [report], panes: [pane("main:1.0", "/home/leo")] },
      { id: "engage", projects: [engageReport.root], reports: [engageReport], panes: [pane("dev:1.0", "/home/leo/Projects/claude-mux/web", "bun")] },
    ];
    const placed = machines.map((m) => {
      const roots = projectRoots(m.projects, m.panes.map((p) => p.cwd));
      const known = new Map(m.reports.map((r) => [r.root, r]));
      return { id: m.id, roots, byRoot: panesByRoot(m.panes, roots, new Set()), reports: roots.map((r) => known.get(r) ?? guessReport(r)) };
    });
    const projects = mergeProjects(placed);

    const repo = projects.find((p) => p.key === "git:github.com/leo/claude-mux")!;
    const repoPanes = repo.places.flatMap((place) => placed.find((m) => m.id === place.machineId)!.byRoot.get(place.root) ?? []);
    expect(repoPanes.map((p) => p.target)).toEqual(["dev:1.0"]);

    const home = projects.find((p) => p.places.some((place) => place.root === "/home/leo"))!;
    expect(home.places).toEqual([{ machineId: "omarchy", root: "/home/leo" }]);
    expect(placed[0].byRoot.get("/home/leo")!.map((p) => p.target)).toEqual(["main:1.0"]);
  });
});
