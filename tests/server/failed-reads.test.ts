import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FailedReads, FAIL_AFTER_MS, type ReadObservation } from "../../src/server/failed-reads.js";
import { readPromptOptions, stripAnsi } from "../../src/tmux/pane.js";
import { readLoginScreen } from "../../src/tmux/login.js";
import { readRewindScreen } from "../../src/tmux/rewind.js";

/** A dialog no reader knows: its choices are lettered, not numbered. */
const RAW = [
  "● I need to run the migration.",
  "",
  "\u001b[1m Apply migration to production? \u001b[22m",
  "",
  "  a. Apply it",
  "  b. Not now",
  "",
  " \u001b[2mpress a letter\u001b[22m",
].join("\n");
const STRIPPED = stripAnsi(RAW);

/** What the poll does for one session on one tick. */
function tick(reads: FailedReads, overrides: Partial<ReadObservation> = {}) {
  const failing =
    !readPromptOptions(STRIPPED) && !readLoginScreen(STRIPPED) && !readRewindScreen(STRIPPED);
  return reads.observe({
    session_id: "s1",
    tmux_target: "work:1.0",
    state: "permission",
    current_action: "Waiting for permission",
    claudeVersion: () => "2.1.320",
    held: false,
    failing,
    stripped: STRIPPED,
    raw: RAW,
    ...overrides,
  });
}

let dir: string;
let clock: number;
let reads: FailedReads;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "failed-reads-"));
  clock = 1_000_000;
  reads = new FailedReads(dir, () => clock);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const files = () => readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("FailedReads", () => {
  it("records a dialog no reader can read, with the screen that beat them", () => {
    expect(readPromptOptions(STRIPPED)).toBeNull();

    expect(tick(reads)).toBeNull();
    clock += FAIL_AFTER_MS - 1;
    expect(tick(reads)).toBeNull();
    expect(files()).toEqual([]);

    clock += 1;
    const record = tick(reads);
    expect(record).not.toBeNull();
    expect(files()).toHaveLength(1);

    const saved = JSON.parse(readFileSync(join(dir, files()[0]), "utf-8"));
    expect(saved).toEqual(record);
    expect(saved).toMatchObject({
      session_id: "s1",
      tmux_target: "work:1.0",
      state: "permission",
      claude_version: "2.1.320",
      held: false,
    });
    expect(saved.screen).toContain("a. Apply it");
    expect(saved.screen).not.toContain("\u001b");
    expect(saved.ansi).toContain("\u001b[1m Apply migration");
  });

  it("writes one record per dialog, however long it stays", () => {
    tick(reads);
    clock += FAIL_AFTER_MS;
    tick(reads);
    clock += 60_000;
    expect(tick(reads)).toBeNull();
    expect(files()).toHaveLength(1);
  });

  it("starts over once the dialog closes, and records the next one", () => {
    tick(reads);
    clock += FAIL_AFTER_MS;
    tick(reads);
    tick(reads, { failing: false });
    clock += 1;
    tick(reads);
    clock += FAIL_AFTER_MS;
    expect(tick(reads)).not.toBeNull();
    expect(files()).toHaveLength(2);
  });

  it("records nothing for a dialog a reader found before the wait ran out", () => {
    tick(reads);
    clock += FAIL_AFTER_MS / 2;
    tick(reads, { failing: false });
    clock += FAIL_AFTER_MS;
    expect(tick(reads, { failing: false })).toBeNull();
    expect(files()).toEqual([]);
  });

  it("asks for the version only when it writes", () => {
    let asked = 0;
    const claudeVersion = () => (asked++, null);
    tick(reads, { claudeVersion });
    expect(asked).toBe(0);
    clock += FAIL_AFTER_MS;
    tick(reads, { claudeVersion });
    expect(asked).toBe(1);
  });

  it("keeps the coloured copy on the same rows as the plain one", () => {
    const raw = RAW + "\n\u001b[0m\n\u001b[0m   \n";
    tick(reads, { raw });
    clock += FAIL_AFTER_MS;
    const record = tick(reads, { raw })!;
    expect(stripAnsi(record.ansi)).toBe(record.screen);
  });

  it("starts the wait again after a tick with no screen", () => {
    tick(reads);
    clock += FAIL_AFTER_MS - 1;
    reads.forget("s1");
    clock += 1;
    expect(tick(reads)).toBeNull();
    clock += FAIL_AFTER_MS;
    expect(tick(reads)).not.toBeNull();
  });

  it("forgets a session that left the poll", () => {
    tick(reads);
    reads.forgetExcept(new Set());
    clock += FAIL_AFTER_MS;
    expect(tick(reads)).toBeNull();
  });
});
