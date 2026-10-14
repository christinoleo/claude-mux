import { describe, expect, it } from "vitest";
import {
  PROJECT_HUES,
  guessReport,
  iconSources,
  mergeProjects,
  normaliseRemote,
  pickIconFile,
  projectHue,
  projectInitials,
  projectKey,
  siteIconUrl,
  type ProjectReport,
} from "../src/fleet-projects.js";

const report = (root: string, patch: Partial<ProjectReport> = {}): ProjectReport => ({
  root,
  remote: null,
  sub: "",
  home: null,
  icon: null,
  ...patch,
});

describe("normaliseRemote", () => {
  it("reads every spelling of one GitHub repo as the same remote", () => {
    const spellings = [
      "https://github.com/christinoleo/claude-mux.git",
      "https://github.com/christinoleo/claude-mux",
      "https://user:token@github.com/christinoleo/claude-mux/",
      "git@github.com:christinoleo/claude-mux.git",
      "ssh://git@github.com/christinoleo/claude-mux.git",
      "git@github.com:Christinoleo/Claude-Mux",
    ];
    for (const url of spellings) expect(normaliseRemote(url)).toBe("github.com/christinoleo/claude-mux");
  });

  it("keeps a local path as it is and refuses nothing at all", () => {
    expect(normaliseRemote("/srv/git/thing.git")).toBe("/srv/git/thing");
    expect(normaliseRemote("  ")).toBeNull();
  });
});

describe("matching one project across machines", () => {
  it("matches by remote, whatever the folder is called on each machine", () => {
    const projects = mergeProjects([
      {
        id: "omarchy",
        reports: [report("/home/leo/Projects/claude-watch", { remote: "github.com/leo/claude-mux", home: "claude-watch" })],
      },
      {
        id: "distilo",
        reports: [report("/home/leo/Projects/claude-mux", { remote: "github.com/leo/claude-mux", home: "claude-mux" })],
      },
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      key: "git:github.com/leo/claude-mux",
      name: "claude-mux",
      places: [
        { machineId: "omarchy", root: "/home/leo/Projects/claude-watch" },
        { machineId: "distilo", root: "/home/leo/Projects/claude-mux" },
      ],
    });
  });

  it("keeps a subfolder of a repo apart from the repo itself", () => {
    const repo = report("/a/mono", { remote: "github.com/leo/mono" });
    const web = report("/a/mono/web", { remote: "github.com/leo/mono", sub: "web" });
    expect(projectKey("m", repo)).not.toBe(projectKey("m", web));
    expect(mergeProjects([{ id: "m", reports: [repo, web] }]).map((p) => p.name)).toEqual(["mono", "web"]);
  });

  it("without a remote, matches by the folder under ~/Projects", () => {
    const projects = mergeProjects([
      { id: "a", reports: [report("/home/leo/Projects/random", { home: "random" })] },
      { id: "b", reports: [report("/Users/leo/Projects/random", { home: "random" })] },
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0].key).toBe("dir:random");
  });

  it("outside ~/Projects, keeps each machine's folder its own", () => {
    const projects = mergeProjects([
      { id: "a", reports: [report("/home/leo/finances")] },
      { id: "b", reports: [report("/home/leo/finances")] },
    ]);
    expect(projects.map((p) => p.key)).toEqual(["path:a:/home/leo/finances", "path:b:/home/leo/finances"]);
  });

  it("a remote beats a matching folder name", () => {
    const projects = mergeProjects([
      { id: "a", reports: [report("/home/leo/Projects/x", { remote: "github.com/leo/x", home: "x" })] },
      { id: "b", reports: [report("/home/leo/Projects/x", { home: "x" })] },
    ]);
    expect(projects).toHaveLength(2);
  });

  it("guesses a machine's unreported folder by its place under ~/Projects", () => {
    expect(guessReport("/home/leo/Projects/games/aurora")).toEqual({
      ...report("/home/leo/Projects/games/aurora", { home: "games/aurora" }),
      guessed: true,
    });
    expect(guessReport("/home/leo/work").home).toBeNull();
  });

  it("joins an unreported folder to the one repo of its name, as an older machine's must be", () => {
    const projects = mergeProjects([
      { id: "omarchy", reports: [report("/home/leo/Projects/claude-watch", { remote: "github.com/leo/claude-mux", home: "claude-watch" })] },
      { id: "distilo", reports: [guessReport("/home/leo/Projects/claude-mux"), guessReport("/home/leo/Projects/quita")] },
      { id: "engage", reports: [guessReport("/home/ubuntu/Projects/claude-watch")] },
    ]);
    expect(projects.map((p) => [p.key, p.name, p.places.map((x) => x.machineId)])).toEqual([
      ["git:github.com/leo/claude-mux", "claude-mux", ["omarchy", "distilo", "engage"]],
      ["dir:quita", "quita", ["distilo"]],
    ]);
  });

  it("leaves a guessed folder alone when two repos could claim it", () => {
    const projects = mergeProjects([
      { id: "a", reports: [report("/home/leo/Projects/x", { remote: "github.com/one/x", home: "x" })] },
      { id: "b", reports: [report("/home/leo/Projects/x", { remote: "github.com/two/x", home: "x" })] },
      { id: "c", reports: [guessReport("/home/leo/Projects/x")] },
    ]);
    expect(projects.map((p) => p.key)).toEqual(["git:github.com/one/x", "git:github.com/two/x", "dir:x"]);
  });

  it("names a repo after itself when a machine's folder does, else after the first machine's folder", () => {
    const zap = report("/home/leo/Projects/zapSell", { remote: "github.com/leo/distilo-chat", home: "zapSell" });
    expect(mergeProjects([{ id: "a", reports: [zap] }])[0].name).toBe("zapSell");
    const renamed = report("/home/leo/Projects/claude-watch", { remote: "github.com/leo/claude-mux", home: "claude-watch" });
    expect(mergeProjects([{ id: "a", reports: [renamed] }])[0].name).toBe("claude-watch");
  });

  it("shows the icon of the first machine that has one", () => {
    const projects = mergeProjects([
      { id: "omarchy", reports: [report("/p/x", { remote: "r/x" })] },
      { id: "distilo", reports: [report("/q/x", { remote: "r/x", icon: "t1" })] },
      { id: "engage", reports: [report("/s/x", { remote: "r/x", icon: "t2" })] },
    ]);
    expect(projects[0].icon).toEqual({ machineId: "distilo", root: "/q/x", token: "t1" });
  });
});

describe("initials and hue", () => {
  it("takes two letters from the words of a name", () => {
    expect(projectInitials("claude-mux")).toBe("CM");
    expect(projectInitials("zapSell")).toBe("ZS");
    expect(projectInitials("random")).toBe("RA");
    expect(projectInitials("games/aurora4x")).toBe("AU");
    expect(projectInitials("my_cool.site")).toBe("MC");
  });

  it("gives a name the same hue every time, never one of the reserved ones", () => {
    const reserved = [
      [35, 60], // amber: wants a person
      [150, 180], // emerald and teal: working, done, subagents
      [190, 210], // sky: a machine
      [245, 300], // violet (workers) and fuchsia (a machine)
      [70, 95], // lime: a machine
      [350, 360],
      [0, 8], // red: failed
    ];
    for (const hue of PROJECT_HUES) {
      for (const [lo, hi] of reserved) expect(hue < lo || hue > hi, `hue ${hue} in ${lo}-${hi}`).toBe(true);
    }
    for (const name of ["claude-mux", "zapSell", "engage", "quita", "a", ""]) {
      expect(projectHue(name)).toBe(projectHue(name));
      expect(PROJECT_HUES).toContain(projectHue(name));
    }
  });
});

describe("icon resolution order", () => {
  it("takes .claude-mux.json's icon first, then a file in the repo, then the prod site's favicon", () => {
    const files = [{ path: "web/static/favicon.svg" }];
    expect(iconSources({ configIcon: "assets/logo.png", files, prodUrl: "https://x.dev" })).toEqual([
      { kind: "file", path: "assets/logo.png" },
      { kind: "file", path: "web/static/favicon.svg" },
      { kind: "site", url: "https://x.dev" },
    ]);
    expect(iconSources({ configIcon: "https://cdn.x.dev/logo.svg", files: [] })).toEqual([
      { kind: "url", url: "https://cdn.x.dev/logo.svg" },
    ]);
    expect(iconSources({ files: [], prodUrl: null })).toEqual([]);
  });

  it("does not let .claude-mux.json reach outside the repo", () => {
    expect(iconSources({ configIcon: "../secret.png", files: [] })).toEqual([]);
    expect(iconSources({ configIcon: "./static/../../x.png", files: [] })).toEqual([]);
    expect(iconSources({ configIcon: "/static/logo.svg", files: [] })).toEqual([{ kind: "file", path: "static/logo.svg" }]);
  });

  it("only counts icon names inside static/, public/ or app/", () => {
    expect(pickIconFile([{ path: "favicon.svg" }, { path: "build/icon.png" }, { path: "src/lib/assets/favicon.svg" }])).toBeNull();
    expect(pickIconFile([{ path: "public/favicon.ico" }])).toBe("public/favicon.ico");
    expect(pickIconFile([{ path: "apps/site/public/img/icon.png", width: 64 }])).toBe("apps/site/public/img/icon.png");
  });

  it("prefers an SVG, then the widest PNG, then an ICO", () => {
    expect(
      pickIconFile([
        { path: "static/favicon.ico" },
        { path: "static/favicon.png", width: 32 },
        { path: "static/apple-touch-icon.png", width: 180 },
        { path: "app/icon.svg" },
        { path: "web/static/favicon.svg" },
      ])
    ).toBe("web/static/favicon.svg");
    expect(
      pickIconFile([
        { path: "static/favicon.ico" },
        { path: "static/favicon.png", width: 32 },
        { path: "static/apple-touch-icon.png", width: 180 },
      ])
    ).toBe("static/apple-touch-icon.png");
    expect(pickIconFile([{ path: "static/favicon.ico" }, { path: "public/favicon.png", width: null }])).toBe(
      "public/favicon.png"
    );
  });
});

describe("siteIconUrl", () => {
  it("picks the page's SVG icon, else its largest, resolved against the page", () => {
    const html = `<head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel='apple-touch-icon' href='/touch.png' sizes='180x180'>
      <link href="/icon.svg" rel="icon" type="image/svg+xml">
    </head>`;
    expect(siteIconUrl(html, "https://x.dev/app/")).toBe("https://x.dev/icon.svg");
    expect(siteIconUrl(html.replace(/.*icon\.svg.*/, ""), "https://x.dev/")).toBe("https://x.dev/touch.png");
  });

  it("falls back to /favicon.ico", () => {
    expect(siteIconUrl("<html></html>", "https://x.dev/some/page")).toBe("https://x.dev/favicon.ico");
    expect(siteIconUrl('<link rel="stylesheet" href="/a.css">', "https://x.dev")).toBe("https://x.dev/favicon.ico");
  });
});
