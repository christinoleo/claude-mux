import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetGitCache } from "../../src/server/git.js";
import { parseProjectConfig, projectInfo } from "../../src/server/project.js";

describe("parseProjectConfig", () => {
  it("keeps the http(s) URLs and drops anything else", () => {
    const config = parseProjectConfig(
      JSON.stringify({
        urls: {
          prod: "https://example.com",
          dev: "http://localhost:5173",
          ftp: "ftp://example.com",
          port: 5173,
          junk: "not a url",
        },
      })
    );
    expect(config).toEqual({ urls: { prod: "https://example.com", dev: "http://localhost:5173" } });
  });

  it("reads a file without urls as an empty config", () => {
    expect(parseProjectConfig("{}")).toEqual({ urls: {} });
    expect(parseProjectConfig('{"urls": ["https://example.com"]}')).toEqual({ urls: {} });
  });

  it("throws on JSON that does not parse", () => {
    expect(() => parseProjectConfig("{")).toThrow();
  });
});

describe("projectInfo", () => {
  let dir: string;

  beforeEach(() => {
    resetGitCache();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "project-info-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the repo root and branch from a subdirectory, with the repo's URLs", async () => {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    run("init", "-q", "-b", "trunk");
    writeFileSync(join(dir, ".claude-mux.json"), JSON.stringify({ urls: { dev: "http://localhost:3000" } }));
    mkdirSync(join(dir, "sub"));
    const info = await projectInfo(join(dir, "sub"));
    expect(info).toEqual({
      root: dir,
      repo: true,
      branch: "trunk",
      config: { urls: { dev: "http://localhost:3000" } },
      configError: null,
    });
  });

  it("falls back to the cwd outside a repo, with no config", async () => {
    const info = await projectInfo(dir);
    expect(info).toEqual({ root: dir, repo: false, branch: null, config: null, configError: null });
  });

  it("reports a config that does not parse instead of failing", async () => {
    writeFileSync(join(dir, ".claude-mux.json"), "{");
    const info = await projectInfo(dir);
    expect(info.config).toBeNull();
    expect(info.configError).toBeTruthy();
  });
});
