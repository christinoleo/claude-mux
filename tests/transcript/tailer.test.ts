import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listSubagents,
  resolveTranscriptPath,
  transcriptPathFor,
} from "../../src/transcript/tailer.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

let home: string;
let realHome: string | undefined;

/** Create ~/.claude/projects/<encoded>/<name> with some content. */
function writeProjectFile(encodedDir: string, name: string, content = "{}\n"): string {
  const dir = join(home, ".claude", "projects", encodedDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "mux-tailer-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveTranscriptPath", () => {
  it("prefers the path the hooks recorded", () => {
    const recorded = writeProjectFile("-home-someone-project", `${SESSION}.jsonl`);
    const path = resolveTranscriptPath(
      { cwd: "/home/someone/project/nested", transcript_path: recorded },
      SESSION
    );
    expect(path).toBe(recorded);
  });

  it("falls back to the path derived from cwd", () => {
    const derived = writeProjectFile("-home-someone-project", `${SESSION}.jsonl`);
    expect(derived).toBe(transcriptPathFor("/home/someone/project", SESSION));
    expect(resolveTranscriptPath({ cwd: "/home/someone/project" }, SESSION)).toBe(derived);
  });

  it("finds the file by session id when cwd no longer matches the project dir", () => {
    // What a session that changed directory looks like: the transcript sits
    // under the launch directory, and `cwd` points somewhere below it.
    const actual = writeProjectFile("-home-someone-project", `${SESSION}.jsonl`);
    writeProjectFile("-home-someone-other", "another-session.jsonl");
    const path = resolveTranscriptPath({ cwd: "/home/someone/project/runner" }, SESSION);
    expect(path).toBe(actual);
  });

  it("ignores a recorded path that no longer exists", () => {
    const actual = writeProjectFile("-home-someone-project", `${SESSION}.jsonl`);
    const path = resolveTranscriptPath(
      { cwd: "/home/someone/project", transcript_path: join(home, "gone.jsonl") },
      SESSION
    );
    expect(path).toBe(actual);
  });

  it("returns null when the session has written nothing yet", () => {
    expect(resolveTranscriptPath({ cwd: "/home/someone/project" }, SESSION)).toBeNull();
  });
});

describe("listSubagents", () => {
  it("reads the subagents sitting beside the transcript", () => {
    const transcript = writeProjectFile("-home-someone-project", `${SESSION}.jsonl`);
    writeProjectFile(join("-home-someone-project", SESSION, "subagents"), "agent-a1.jsonl");
    writeProjectFile(
      join("-home-someone-project", SESSION, "subagents"),
      "agent-a1.meta.json",
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_1" })
    );

    const found = listSubagents(transcript);
    expect(found).toHaveLength(1);
    expect(found[0].agentId).toBe("a1");
    expect(found[0].meta.toolUseId).toBe("toolu_1");
  });

  it("skips agents the caller already tracks", () => {
    const transcript = writeProjectFile("-home-someone-project", `${SESSION}.jsonl`);
    writeProjectFile(join("-home-someone-project", SESSION, "subagents"), "agent-a1.jsonl");
    expect(listSubagents(transcript, new Set(["a1"]))).toEqual([]);
  });
});
