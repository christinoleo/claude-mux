import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGitCache } from "../../src/server/git.js";
import { projectIcon, projectReports, readProject, resetProjectReports } from "../../src/server/project-icons.js";

/** A PNG header with the given width, enough for the reader to size it. */
function png(width: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(width, 20);
  return buf;
}

let home: string;

function write(path: string, body: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function gitInit(dir: string, remote?: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
}

/** A fetch that answers from a table of URLs, and 404 for anything else. */
function fakeFetch(pages: Record<string, { body: string | Buffer; type: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const page = pages[String(input)];
    if (!page) return new Response("nope", { status: 404 });
    return new Response(typeof page.body === "string" ? page.body : Uint8Array.from(page.body), { headers: { "content-type": page.type } });
  }) as typeof fetch;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "project-icons-")));
  resetGitCache();
  resetProjectReports();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("readProject", () => {
  it("reports the remote, the place under ~/Projects and the repo's own favicon", async () => {
    const root = join(home, "Projects", "claude-watch");
    gitInit(root, "git@github.com:christinoleo/claude-mux.git");
    write(join(root, "web/static/favicon.svg"), "<svg/>");
    write(join(root, "web/static/apple-touch-icon.png"), png(180));
    write(join(root, "node_modules/x/public/favicon.svg"), "<svg>dep</svg>");

    const { report, icon } = await readProject(root, { home });
    expect(report).toMatchObject({
      root,
      remote: "github.com/christinoleo/claude-mux",
      sub: "",
      home: "claude-watch",
    });
    expect(report.icon).toMatch(/^[0-9a-f]{12}$/);
    expect(icon).toEqual({ bytes: new Uint8Array(Buffer.from("<svg/>")), type: "image/svg+xml" });
  });

  it("uses .claude-mux.json's icon over any file in the repo", async () => {
    const root = join(home, "Projects", "site");
    gitInit(root);
    write(join(root, "public/favicon.svg"), "<svg/>");
    write(join(root, "brand/logo.png"), png(64));
    write(join(root, ".claude-mux.json"), JSON.stringify({ icon: "brand/logo.png" }));

    const { report, icon } = await readProject(root, { home });
    expect(report).toMatchObject({ remote: null, home: "site" });
    expect(icon?.type).toBe("image/png");
    expect(Buffer.from(icon!.bytes).equals(png(64))).toBe(true);
  });

  it("takes an icon URL from .claude-mux.json, and moves on when it cannot be had", async () => {
    const root = join(home, "Projects", "remote-icon");
    mkdirSync(root, { recursive: true });
    write(join(root, ".claude-mux.json"), JSON.stringify({ icon: "https://cdn.test/logo.svg" }));
    const fetcher = fakeFetch({ "https://cdn.test/logo.svg": { body: "<svg>cdn</svg>", type: "image/svg+xml" } });
    expect((await readProject(root, { home, fetch: fetcher })).icon?.type).toBe("image/svg+xml");

    write(join(root, "static/favicon.ico"), "ico");
    expect((await readProject(root, { home, fetch: fakeFetch({}) })).icon?.type).toBe("image/x-icon");
  });

  it("falls back to the prod site's favicon, and to nothing", async () => {
    const root = join(home, "elsewhere", "app");
    mkdirSync(root, { recursive: true });
    write(join(root, ".claude-mux.json"), JSON.stringify({ urls: { prod: "https://app.test/" } }));
    const fetcher = fakeFetch({
      "https://app.test/": { body: '<link rel="icon" href="/brand.png" sizes="64x64">', type: "text/html; charset=utf-8" },
      "https://app.test/brand.png": { body: png(64), type: "image/png" },
    });
    const { report, icon } = await readProject(root, { home, fetch: fetcher });
    expect(report.home).toBeNull();
    expect(icon?.type).toBe("image/png");

    const none = await readProject(root, { home, fetch: fakeFetch({}) });
    expect(none.icon).toBeNull();
    expect(none.report.icon).toBeNull();
  });

  it("names a subfolder of a repo by where it sits in it", async () => {
    const repo = join(home, "Projects", "mono");
    gitInit(repo, "https://github.com/leo/mono.git");
    mkdirSync(join(repo, "web"));
    const { report } = await readProject(join(repo, "web"), { home });
    expect(report).toMatchObject({ remote: "github.com/leo/mono", sub: "web", home: "mono/web" });
  });
});

describe("projectReports", () => {
  it("answers from what it has read, reads in the background, and serves only those icons", async () => {
    const root = join(home, "Projects", "p");
    mkdirSync(root, { recursive: true });
    write(join(root, "static/icon.svg"), "<svg/>");

    expect(projectReports([root], { home })).toEqual([]);
    await vi.waitFor(() => expect(projectReports([root], { home })).toHaveLength(1));
    expect(projectReports([root], { home })[0]).toMatchObject({ root, home: "p" });
    expect(projectIcon(root)?.type).toBe("image/svg+xml");
    expect(projectIcon(join(root, "static/icon.svg"))).toBeNull();
  });
});
