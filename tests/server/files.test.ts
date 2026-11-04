import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileAccessError,
  READ_LIMIT_BYTES,
  listDir,
  listRepoFiles,
  locateProjectFile,
  readProjectFile,
  readProjectMedia,
  resolveInRoot,
} from "../../src/server/files.js";

let base: string;
let root: string;
let outside: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function refused(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FileAccessError) return err.status;
    throw err;
  }
  throw new Error("expected the path to be refused");
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cm-files-")));
  root = join(base, "repo");
  outside = join(base, "secret");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "key.txt"), "hunter2\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "# Hi\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveInRoot", () => {
  it("resolves a relative path and an absolute one inside the root", async () => {
    expect((await resolveInRoot(root, "src/a.ts")).rel).toBe("src/a.ts");
    expect((await resolveInRoot(root, join(root, "src/a.ts"))).rel).toBe("src/a.ts");
    expect((await resolveInRoot(root, "")).rel).toBe("");
  });

  it("refuses `..` that climbs out of the root", async () => {
    expect(await refused(resolveInRoot(root, "../secret/key.txt"))).toBe(403);
    expect(await refused(resolveInRoot(root, "src/../../secret/key.txt"))).toBe(403);
  });

  it("refuses an absolute path outside the root", async () => {
    expect(await refused(resolveInRoot(root, join(outside, "key.txt")))).toBe(403);
    expect(await refused(resolveInRoot(root, "/etc/passwd"))).toBe(403);
  });

  it("with `anywhere`, resolves a path outside the root, absolute or relative", async () => {
    const any = { anywhere: true };
    expect((await resolveInRoot(root, join(outside, "key.txt"), any)).rel).toBe(join(outside, "key.txt"));
    expect((await resolveInRoot(root, join(root, "src/a.ts"), any)).rel).toBe("src/a.ts");
    expect((await resolveInRoot(root, "../secret/key.txt", any)).rel).toBe(join(outside, "key.txt"));
    expect(await refused(resolveInRoot(root, join(outside, "nope.txt"), any))).toBe(404);
    mkdirSync(join(outside, ".git"));
    writeFileSync(join(outside, ".git", "config"), "");
    expect(await refused(resolveInRoot(root, join(outside, ".git/config"), any))).toBe(403);
  });

  it("refuses a symlink that points out of the root", async () => {
    symlinkSync(join(outside, "key.txt"), join(root, "leak.txt"));
    symlinkSync(outside, join(root, "leakdir"));
    expect(await refused(resolveInRoot(root, "leak.txt"))).toBe(403);
    expect(await refused(resolveInRoot(root, "leakdir/key.txt"))).toBe(403);
    expect(await refused(readProjectFile(root, "leak.txt"))).toBe(403);
  });

  it("follows a symlink that stays inside the root", async () => {
    symlinkSync(join(root, "src", "a.ts"), join(root, "alias.ts"));
    expect((await resolveInRoot(root, "alias.ts")).rel).toBe("src/a.ts");
  });

  it("accepts a root reached through a symlink", async () => {
    const via = join(base, "via");
    symlinkSync(root, via);
    expect((await resolveInRoot(via, "src/a.ts")).rel).toBe("src/a.ts");
    expect((await resolveInRoot(via, join(via, "src/a.ts"))).rel).toBe("src/a.ts");
  });

  it("refuses .git at any depth and answers 404 for a missing path", async () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "");
    mkdirSync(join(root, "vendor", "lib", ".git"), { recursive: true });
    writeFileSync(join(root, "vendor", "lib", ".git", "config"), "");
    expect(await refused(resolveInRoot(root, ".git/config"))).toBe(403);
    expect(await refused(resolveInRoot(root, "vendor/lib/.git/config"))).toBe(403);
    expect((await listDir(root, "vendor/lib", { repo: false })).entries).toEqual([]);
    expect(await refused(resolveInRoot(root, "nope.ts"))).toBe(404);
  });
});

describe("listDir", () => {
  it("lists directories first and leaves out links that escape", async () => {
    symlinkSync(outside, join(root, "leakdir"));
    symlinkSync(join(root, "src"), join(root, "srclink"));
    const listing = await listDir(root, "", { repo: false });
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([
      ["src", "dir"],
      ["srclink", "dir"],
      ["README.md", "file"],
    ]);
  });

  it("hides git-ignored entries and .git unless asked", async () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "debug.log"), "x");
    const plain = await listDir(root, "", { repo: true });
    expect(plain.entries.map((e) => e.name)).toEqual(["src", ".gitignore", "README.md"]);
    expect(plain.hidden).toBe(2);
    const all = await listDir(root, "", { repo: true, showIgnored: true });
    expect(all.entries.filter((e) => e.ignored).map((e) => e.name)).toEqual(["dist", "debug.log"]);
    expect(all.entries.some((e) => e.name === ".git")).toBe(false);
  });

  it("still filters ignored entries when a directory is a symlink", async () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    mkdirSync(join(root, "dist"));
    symlinkSync(join(root, "src"), join(root, "lnk"));
    const listing = await listDir(root, "", { repo: true });
    expect(listing.entries.map((e) => e.name)).toEqual(["lnk", "src", ".gitignore", "README.md"]);
    expect(listing.hidden).toBe(1);
  });

  it("refuses a directory outside the root", async () => {
    expect(await refused(listDir(root, "..", { repo: false }))).toBe(403);
  });

  it("with `anywhere`, lists a folder outside the root by its absolute path", async () => {
    const listing = await listDir(root, outside, { repo: true, anywhere: true });
    expect(listing.dir).toBe(outside);
    expect(listing.entries).toEqual([{ name: "key.txt", path: join(outside, "key.txt"), type: "file" }]);
    expect((await readProjectFile(root, join(outside, "key.txt"), { anywhere: true })).kind).toBe("text");
  });
});

describe("a link out of the root, with `anywhere`", () => {
  const any = { anywhere: true };

  beforeEach(() => {
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "deep.txt"), "deep\n");
    symlinkSync(outside, join(root, "mount"));
  });

  it("is listed, marked as a link, as what it points to", async () => {
    symlinkSync(join(outside, "key.txt"), join(root, "key-link.txt"));
    const { entries } = await listDir(root, "", { repo: false, ...any });
    expect(entries.find((e) => e.name === "mount")).toEqual({ name: "mount", path: "mount", type: "dir", link: true });
    expect(entries.find((e) => e.name === "key-link.txt")).toEqual({
      name: "key-link.txt",
      path: "key-link.txt",
      type: "file",
      link: true,
    });
  });

  it("is followed, and what is below it keeps the path through the link", async () => {
    const top = await listDir(root, "mount", { repo: false, ...any });
    expect(top.dir).toBe("mount");
    expect(top.entries.map((e) => e.path)).toEqual(["mount/sub", "mount/key.txt"]);
    const sub = await listDir(root, "mount/sub", { repo: false, ...any });
    expect(sub.entries).toEqual([{ name: "deep.txt", path: "mount/sub/deep.txt", type: "file" }]);
  });

  it("resolves a relative path through it, and a file there reads like any other", async () => {
    const resolved = await resolveInRoot(root, "mount/sub/deep.txt", any);
    expect(resolved.rel).toBe("mount/sub/deep.txt");
    expect(resolved.abs).toBe(join(outside, "sub", "deep.txt"));
    expect(await readProjectFile(root, "mount/sub/deep.txt", any)).toMatchObject({
      kind: "text",
      path: "mount/sub/deep.txt",
      text: "deep\n",
    });
    expect(await refused(resolveInRoot(root, "mount/sub/nope.txt", any))).toBe(404);
  });

  it("is reachable by its absolute path too, which settles on the path through it", async () => {
    expect((await resolveInRoot(root, join(root, "mount/key.txt"), any)).rel).toBe("mount/key.txt");
  });

  it("stays refused without `anywhere`", async () => {
    expect(await refused(resolveInRoot(root, "mount/key.txt"))).toBe(403);
    expect(await refused(listDir(root, "mount", { repo: false }))).toBe(403);
  });

  it("lists a dangling link as broken, and refuses to open it", async () => {
    symlinkSync(join(base, "gone"), join(root, "dangling"));
    const { entries } = await listDir(root, "", { repo: false, ...any });
    expect(entries.find((e) => e.name === "dangling")).toEqual({
      name: "dangling",
      path: "dangling",
      type: "file",
      link: true,
      broken: true,
    });
    expect(await refused(resolveInRoot(root, "dangling", any))).toBe(404);
    expect((await listDir(root, "", { repo: false })).entries.some((e) => e.name === "dangling")).toBe(false);
  });

  it("lists a loop of links as broken, and refuses to open it", async () => {
    symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
    const { entries } = await listDir(root, "", { repo: false, ...any });
    expect(entries.filter((e) => e.broken).map((e) => e.name)).toEqual(["loop-a", "loop-b"]);
    expect(await refused(resolveInRoot(root, "loop-a/x", any))).toBe(404);
  });

  it("gives a link back to a folder that holds it a longer path each time, so a tree never holds itself", async () => {
    symlinkSync(root, join(root, "up"));
    symlinkSync(outside, join(outside, "self"));
    const up = await listDir(root, "up", { repo: false, ...any });
    expect(up.dir).toBe("up");
    expect(up.entries.map((e) => e.path)).toContain("up/up");
    expect((await listDir(root, "up/up", { repo: false, ...any })).entries.map((e) => e.path)).toContain("up/up/up");
    const self = await listDir(root, "mount/self", { repo: false, ...any });
    expect(self.entries.map((e) => e.path)).toContain("mount/self/self");
  });

  it("refuses .git through a link, by the link's own name or its target's", async () => {
    mkdirSync(join(outside, ".git"));
    writeFileSync(join(outside, ".git", "config"), "");
    symlinkSync(join(outside, ".git"), join(root, "gitdir"));
    symlinkSync(join(outside, ".git", "config"), join(root, "gitfile"));
    expect(await refused(resolveInRoot(root, "mount/.git/config", any))).toBe(403);
    expect(await refused(resolveInRoot(root, "gitdir", any))).toBe(403);
    expect(await refused(resolveInRoot(root, "gitdir/config", any))).toBe(403);
    expect(await refused(resolveInRoot(root, "gitfile", any))).toBe(403);
    const names = (await listDir(root, "", { repo: false, ...any })).entries.map((e) => e.name);
    expect(names).not.toContain("gitdir");
    expect(names).not.toContain("gitfile");
    expect((await listDir(root, "mount", { repo: false, ...any })).entries.map((e) => e.name)).not.toContain(".git");
  });

  it("is not asked of git below the link, and stays listed when git ignores it", async () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "mount\nsrc-ignored\n");
    mkdirSync(join(root, "src-ignored"));
    const top = await listDir(root, "", { repo: true, ...any });
    expect(top.entries.find((e) => e.name === "mount")).toMatchObject({ link: true, ignored: true });
    expect(top.entries.some((e) => e.name === "src-ignored")).toBe(false);
    expect(top.hidden).toBe(1);
    const below = await listDir(root, "mount", { repo: true, ...any });
    expect(below.entries.map((e) => e.name)).toEqual(["sub", "key.txt"]);
    expect(below.hidden).toBe(0);
  });

  it("still asks git about a link that leads back into the project, by its real path", async () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "src", "debug.log"), "x");
    symlinkSync(join(root, "src"), join(root, "srclink"));
    const listing = await listDir(root, "srclink", { repo: true, ...any });
    expect(listing.entries.map((e) => e.path)).toEqual(["srclink/a.ts"]);
    expect(listing.hidden).toBe(1);
  });

  it("is found by a message's spelling of the path, from the cwd as well", async () => {
    git("init", "-q");
    expect(await locateProjectFile(root, "mount/sub/deep.txt", root, any)).toBe("mount/sub/deep.txt");
    expect(await locateProjectFile(root, "../mount/key.txt", join(root, "src"), any)).toBe(join(root, "mount/key.txt"));
  });

  it("reads a path that climbs from the cwd only, however it is spelled", async () => {
    git("init", "-q");
    const cwd = join(root, "src");
    const home = join(root, "b.ts");
    writeFileSync(home, "from the cwd\n");
    writeFileSync(join(base, "b.ts"), "from above the root\n");
    for (const spelled of ["../b.ts", "./../b.ts", "lib/../../b.ts"]) {
      expect(await locateProjectFile(root, spelled, cwd, any)).toBe(home);
    }
    rmSync(home);
    const missing = await locateProjectFile(root, "../b.ts", cwd, any);
    expect(await refused(readProjectFile(root, missing, any))).toBe(404);
  });
});

describe("a PDF", () => {
  const PDF = Buffer.from("%PDF-1.4\n\0binary\n%%EOF\n");

  it("answers its own kind and its bytes with the right type, whatever bytes it opens with", async () => {
    writeFileSync(join(root, "doc.PDF"), PDF);
    expect(await readProjectFile(root, "doc.PDF")).toEqual({
      kind: "pdf",
      path: "doc.PDF",
      size: PDF.length,
      mime: "application/pdf",
    });
    const served = await readProjectMedia(root, "doc.PDF");
    expect(served.mime).toBe("application/pdf");
    expect(served.bytes.equals(PDF)).toBe(true);
  });

  it("opens through a link, under the guard", async () => {
    writeFileSync(join(outside, "paper.pdf"), PDF);
    symlinkSync(outside, join(root, "mount"));
    const any = { anywhere: true };
    expect((await readProjectFile(root, "mount/paper.pdf", any)).kind).toBe("pdf");
    expect((await readProjectMedia(root, "mount/paper.pdf", any)).mime).toBe("application/pdf");
    expect(await refused(readProjectMedia(root, "mount/paper.pdf"))).toBe(403);
  });

  it("is judged on the real path, so a link named .pdf hands out nothing else", async () => {
    symlinkSync(join(outside, "key.txt"), join(root, "fake.pdf"));
    const any = { anywhere: true };
    expect((await readProjectFile(root, "fake.pdf", any)).kind).toBe("text");
    expect(await refused(readProjectMedia(root, "fake.pdf", any))).toBe(415);
  });
});

describe("readProjectFile", () => {
  it("reads text, and calls a file with a NUL binary", async () => {
    expect(await readProjectFile(root, "src/a.ts")).toMatchObject({
      kind: "text",
      text: "export const a = 1;\n",
      truncated: false,
    });
    writeFileSync(join(root, "blob.bin"), Buffer.from([1, 0, 2]));
    expect((await readProjectFile(root, "blob.bin")).kind).toBe("binary");
  });

  it("cuts text past the limit at a line end", async () => {
    const line = "x".repeat(99) + "\n";
    writeFileSync(join(root, "big.txt"), line.repeat(Math.ceil(READ_LIMIT_BYTES / line.length) + 10));
    const read = await readProjectFile(root, "big.txt");
    if (read.kind !== "text") throw new Error("expected text");
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(READ_LIMIT_BYTES);
    expect(read.text.endsWith("\n")).toBe(true);
    expect(read.shown).toBe(Buffer.byteLength(read.text));
  });

  it("never splits a character when a file has no line end to cut at", async () => {
    // Three-byte characters straddle the limit, which is not a multiple of three.
    writeFileSync(join(root, "wide.txt"), "€".repeat(Math.ceil(READ_LIMIT_BYTES / 3) + 10));
    const read = await readProjectFile(root, "wide.txt");
    if (read.kind !== "text") throw new Error("expected text");
    expect(read.text.includes("\uFFFD")).toBe(false);
    expect(read.shown).toBeLessThanOrEqual(READ_LIMIT_BYTES);
  });

  it("serves an image only through the guard", async () => {
    writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await readProjectFile(root, "logo.png")).toMatchObject({ kind: "image", mime: "image/png" });
    expect((await readProjectMedia(root, "logo.png")).bytes.length).toBe(4);
    writeFileSync(join(outside, "x.png"), "");
    expect(await refused(readProjectMedia(root, "../secret/x.png"))).toBe(403);
    expect(await refused(readProjectMedia(root, "src/a.ts"))).toBe(415);
  });
});

describe("listRepoFiles", () => {
  it("lists tracked and untracked files git does not ignore", async () => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "debug.log"), "x");
    git("add", "src/a.ts");
    const list = await listRepoFiles(root);
    expect(list?.files.sort()).toEqual([".gitignore", "README.md", "src/a.ts"]);
  });

  it("answers null outside a repo", async () => {
    expect(await listRepoFiles(outside)).toBeNull();
  });
});

describe("locateProjectFile", () => {
  beforeEach(() => {
    mkdirSync(join(root, "web", "lib"), { recursive: true });
    writeFileSync(join(root, "web", "lib", "markdown.ts"), "export {};\n");
    writeFileSync(join(root, "web", "a.ts"), "export {};\n");
    git("init", "-q");
  });

  it("keeps a path that is there from the root, and an absolute one", async () => {
    expect(await locateProjectFile(root, "src/a.ts", root)).toBe("src/a.ts");
    expect(await locateProjectFile(root, "/etc/hosts", root)).toBe("/etc/hosts");
  });

  it("tries the session's cwd when the root does not have it", async () => {
    const found = await locateProjectFile(root, "lib/markdown.ts", join(root, "web"));
    expect((await resolveInRoot(root, found)).rel).toBe("web/lib/markdown.ts");
  });

  it("finds the one file a tail names, and leaves an ambiguous or missing one as given", async () => {
    expect(await locateProjectFile(root, "markdown.ts", root)).toBe("web/lib/markdown.ts");
    expect(await locateProjectFile(root, "./lib/markdown.ts", root)).toBe("web/lib/markdown.ts");
    expect(await locateProjectFile(root, "a.ts", root)).toBe("a.ts");
    expect(await locateProjectFile(root, "nope.ts", root)).toBe("nope.ts");
    expect(await locateProjectFile(root, "../secret/key.txt", root)).toBe("../secret/key.txt");
  });

  it("never finds a way out of the root", async () => {
    const found = await locateProjectFile(root, "../secret/key.txt", join(root, "src"));
    expect(await refused(readProjectFile(root, found))).toBe(403);
  });
});
