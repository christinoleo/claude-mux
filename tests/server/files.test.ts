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
  readProjectFile,
  readProjectImage,
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

  it("refuses .git and answers 404 for a missing path", async () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "");
    expect(await refused(resolveInRoot(root, ".git/config"))).toBe(403);
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

  it("refuses a directory outside the root", async () => {
    expect(await refused(listDir(root, "..", { repo: false }))).toBe(403);
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
  });

  it("serves an image only through the guard", async () => {
    writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await readProjectFile(root, "logo.png")).toMatchObject({ kind: "image", mime: "image/png" });
    expect((await readProjectImage(root, "logo.png")).bytes.length).toBe(4);
    writeFileSync(join(outside, "x.png"), "");
    expect(await refused(readProjectImage(root, "../secret/x.png"))).toBe(403);
    expect(await refused(readProjectImage(root, "src/a.ts"))).toBe(415);
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
