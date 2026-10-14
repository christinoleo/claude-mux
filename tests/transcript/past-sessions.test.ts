import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  END_BYTES,
  MAX_LABEL,
  PastSessionIndex,
  promptText,
  readPastSession,
  withoutLive,
} from "../../src/transcript/past-sessions.js";

/** Sample transcripts in the shape Claude Code 2.1 writes them, in a fake `~/.claude/projects`. */

const A = "1ecad7e5-2457-45db-8ade-0f912e58683a";
const B = "2ea42983-4271-4928-a780-ffdeefcb17ca";
const C = "3d3be993-7e0e-4339-a7ea-809545edd3a9";
const D = "4d3be993-7e0e-4339-a7ea-809545edd3a9";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "past-sessions-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function user(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    isSidechain: false,
    message: { role: "user", content },
    timestamp: "2026-10-14T10:00:00.000Z",
    entrypoint: "cli",
    cwd: "/home/leo/Projects/app",
    gitBranch: "main",
    ...extra,
  };
}

function write(dir: string, id: string, entries: unknown[], mtime?: Date): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, `${id}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

describe("promptText", () => {
  it("reads typed text, and a slash command as typed", () => {
    expect(promptText(user("fix the build"))).toBe("fix the build");
    expect(promptText(user([{ type: "text", text: "from a block" }]))).toBe("from a block");
    expect(
      promptText(user("<command-message>x</command-message>\n<command-name>/ak:maestro-worker</command-name>\n<command-args>102</command-args>"))
    ).toBe("/ak:maestro-worker 102");
  });

  it("skips tool results, meta lines and command output", () => {
    expect(promptText(user([{ type: "tool_result", tool_use_id: "t", content: "out" }]))).toBeNull();
    expect(promptText(user("Caveat: the messages below", { isMeta: true }))).toBeNull();
    expect(promptText(user("<local-command-stdout>ok</local-command-stdout>"))).toBeNull();
    expect(promptText({ type: "assistant", message: { content: "hi" } })).toBeNull();
  });

  it("cuts a long prompt to one line", () => {
    const text = promptText(user(`line one\n${"x".repeat(400)}`))!;
    expect(text.length).toBe(MAX_LABEL);
    expect(text).not.toContain("\n");
  });
});

describe("readPastSession", () => {
  it("reads where it ran, its first prompt, title and last activity", async () => {
    const path = write("-home-leo-Projects-app", A, [
      { type: "last-prompt", leafUuid: "x", sessionId: A },
      user("<command-name>/clear</command-name>", { isMeta: true }),
      user("add a settled section"),
      { type: "assistant", message: { content: [] }, timestamp: "2026-10-14T10:05:00.000Z", cwd: "/home/leo/Projects/app/.worktree/101", gitBranch: "task/101" },
      { type: "ai-title", aiTitle: "Settled section", sessionId: A },
    ]);
    expect(await readPastSession(path)).toEqual({
      id: A,
      cwd: "/home/leo/Projects/app/.worktree/101",
      branch: "task/101",
      title: "Settled section",
      prompt: "add a settled section",
      lastActivity: Date.parse("2026-10-14T10:05:00.000Z"),
    });
  });

  it("prefers a /rename title over Claude Code's, and the file beside the transcript over both", async () => {
    const path = write("p", A, [user("hi"), { type: "ai-title", aiTitle: "Auto" }, { type: "custom-title", customTitle: "Mine" }]);
    expect((await readPastSession(path))?.title).toBe("Mine");
    mkdirSync(join(root, "p", A));
    writeFileSync(join(root, "p", A, "custom-title.json"), JSON.stringify({ customTitle: "Renamed" }));
    expect((await readPastSession(path))?.title).toBe("Renamed");
  });

  it("reads both ends of a long transcript and nothing between", async () => {
    const filler = { type: "assistant", message: { content: "y".repeat(1000) }, timestamp: "2026-10-14T10:01:00.000Z" };
    const path = write("p", A, [
      user("the first prompt"),
      ...Array.from({ length: 3 * Math.ceil(END_BYTES / 1000) }, () => filler),
      { type: "ai-title", aiTitle: "Late title" },
      { type: "system", timestamp: "2026-10-14T12:00:00.000Z", cwd: "/elsewhere" },
    ]);
    const session = await readPastSession(path);
    expect(session?.prompt).toBe("the first prompt");
    expect(session?.title).toBe("Late title");
    expect(session?.cwd).toBe("/elsewhere");
    expect(session?.lastActivity).toBe(Date.parse("2026-10-14T12:00:00.000Z"));
  });

  it("leaves out subagent, SDK and empty transcripts", async () => {
    expect(await readPastSession(write("p", A, [user("brief", { isSidechain: true })]))).toBeNull();
    expect(await readPastSession(write("p", B, [user("summarise this", { entrypoint: "sdk-cli" })]))).toBeNull();
    expect(await readPastSession(write("p", C, [{ type: "file-history-snapshot", snapshot: {} }]))).toBeNull();
  });

  it("falls back to the file's time when no entry carries one", async () => {
    const when = new Date("2026-09-01T00:00:00Z");
    const path = write("p", A, [{ type: "user", message: { content: "untimed" } }], when);
    expect((await readPastSession(path))?.lastActivity).toBe(when.getTime());
  });
});

describe("PastSessionIndex", () => {
  it("lists the top of each project directory newest first, never a subagent's file", async () => {
    write("-home-leo-Projects-app", A, [user("older", { timestamp: "2026-10-01T00:00:00Z" })]);
    write("-home-leo-Projects-web", B, [user("newer", { timestamp: "2026-10-10T00:00:00Z" })]);
    // A subagent's transcript, where Claude Code keeps it, and a stray file.
    mkdirSync(join(root, "-home-leo-Projects-app", A, "subagents"), { recursive: true });
    writeFileSync(join(root, "-home-leo-Projects-app", A, "subagents", "agent-abc.jsonl"), JSON.stringify(user("brief")) + "\n");
    writeFileSync(join(root, "-home-leo-Projects-app", "agent-abc.jsonl"), JSON.stringify(user("brief")) + "\n");

    const index = new PastSessionIndex(() => root);
    expect((await index.list()).map((p) => p.prompt)).toEqual(["newer", "older"]);
  });

  it("reads a file again only when it changed, and forgets one deleted", async () => {
    const path = write("p", A, [user("first", { timestamp: "2026-10-01T00:00:00Z" })], new Date("2026-10-01T00:00:00Z"));
    write("p", B, [user("other", { timestamp: "2026-10-02T00:00:00Z" })]);
    const index = new PastSessionIndex(() => root);
    expect((await index.list()).map((p) => p.id)).toEqual([B, A]);

    write("p", A, [user("first", { timestamp: "2026-10-01T00:00:00Z" }), user("later", { timestamp: "2026-10-05T00:00:00Z" })]);
    expect((await index.list()).map((p) => p.id)).toEqual([A, B]);

    rmSync(path);
    expect((await index.list()).map((p) => p.id)).toEqual([B]);
  });

  it("keeps the newer copy of a session found in two directories", async () => {
    write("old-dir", A, [user("before /cd", { timestamp: "2026-10-01T00:00:00Z" })]);
    write("new-dir", A, [user("after /cd", { timestamp: "2026-10-03T00:00:00Z" })]);
    const list = await new PastSessionIndex(() => root).list();
    expect(list).toHaveLength(1);
    expect(list[0].prompt).toBe("after /cd");
  });

  it("is empty where Claude Code has never run", async () => {
    expect(await new PastSessionIndex(() => join(root, "nowhere")).list()).toEqual([]);
  });
});

describe("withoutLive", () => {
  it("leaves out every session the machine's broadcast lists", async () => {
    write("p", A, [user("live one")]);
    write("p", B, [user("past one")]);
    write("p", D, [user("closed pane")]);
    const all = await new PastSessionIndex(() => root).list();
    expect(withoutLive(all, new Set([A, D])).map((p) => p.id)).toEqual([B]);
  });
});
