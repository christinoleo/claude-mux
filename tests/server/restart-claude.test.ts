import { describe, expect, it } from "vitest";

import { bangFinished, buildRestartArgv, lastBangOutput, stripResumeFlags } from "../../src/server/restart-claude.js";
import { descendants, readProcessTree, type ProcessRow } from "../../src/utils/processes.js";
import { shellQuote } from "../../src/utils/shell.js";

describe("stripResumeFlags", () => {
  it("drops every way a launch can name a session", () => {
    expect(stripResumeFlags(["claude", "--resume", "abc", "--model", "opus"])).toEqual([
      "claude",
      "--model",
      "opus",
    ]);
    expect(stripResumeFlags(["claude", "-r", "abc"])).toEqual(["claude"]);
    expect(stripResumeFlags(["claude", "--resume=abc"])).toEqual(["claude"]);
    expect(stripResumeFlags(["claude", "--continue", "-c"])).toEqual(["claude"]);
  });

  it("keeps a flag that follows a bare --resume", () => {
    expect(stripResumeFlags(["claude", "--resume", "--dangerously-skip-permissions"])).toEqual([
      "claude",
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("shellQuote", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(shellQuote("--dangerously-skip-permissions")).toBe("--dangerously-skip-permissions");
    expect(shellQuote("it's a trap")).toBe(`'it'\\''s a trap'`);
  });
});

describe("buildRestartArgv", () => {
  it("replays the running argv with --resume, and refuses to guess for a dead pid", () => {
    const own = buildRestartArgv({ id: "sid", pid: process.pid });
    expect(own?.slice(-2)).toEqual(["--resume", "sid"]);
    expect(buildRestartArgv({ id: "sid", pid: 2 ** 22 - 1 })).toBeNull();
  });
});

describe("bangFinished", () => {
  const CLAUDE = 100;
  const COMMAND = "mise upgrade claude";
  const timing = { startMs: 50, timeoutMs: 400, pollMs: 10 };
  const mcp: ProcessRow = { pid: 101, ppid: CLAUDE, args: "bunx chrome-devtools-mcp@latest" };
  const shell: ProcessRow = {
    pid: 102,
    ppid: CLAUDE,
    args: `/usr/bin/bash -c source snapshot.sh && eval '${COMMAND}' < /dev/null && pwd -P >| /tmp/claude-cwd`,
  };
  const mise: ProcessRow = { pid: 103, ppid: 102, args: COMMAND };
  // What the pane drew while mise downloaded: its own progress, no "Running…".
  const progress = [
    "! mise upgrade claude",
    "  ⎿  mise claude@2.1.299  download claude-linux-x64.tar.gz  88 MiB/117 MiB 3.0s",
    "",
    "─".repeat(40),
    "❯ ",
    "─".repeat(40),
  ].join("\n");

  /** A process table that holds the shell for `runsFor` reads, then loses it. */
  function tree(runsFor: number) {
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      processes: () => (reads++ < runsFor ? [mcp, shell, mise] : [mcp]),
      pane: async () => progress,
    };
  }

  it("waits while Claude Code's shell for the command lives, whatever the pane draws", async () => {
    const probe = tree(8);
    expect(await bangFinished(CLAUDE, COMMAND, probe, timing)).toBe(true);
    expect(probe.reads).toBeGreaterThan(8);
  });

  it("counts the command's own process as running too", async () => {
    let reads = 0;
    const probe = { processes: () => (reads++ < 5 ? [{ ...mise, ppid: CLAUDE }] : []), pane: async () => progress };
    expect(await bangFinished(CLAUDE, COMMAND, probe, timing)).toBe(true);
    expect(reads).toBeGreaterThan(5);
  });

  it("is not fooled by long-lived children such as MCP servers, or the same command elsewhere", async () => {
    const elsewhere: ProcessRow = { pid: 900, ppid: 1, args: COMMAND };
    const probe = { processes: () => [mcp, elsewhere], pane: async () => progress };
    expect(await bangFinished(CLAUDE, COMMAND, probe, timing)).toBe(true);
  });

  it("gives up at the timeout while the shell never exits", async () => {
    const probe = { processes: () => [mcp, shell, mise], pane: async () => "" };
    expect(await bangFinished(CLAUDE, COMMAND, probe, timing)).toBe(false);
  });

  it("falls back to the pane's Running… line where there is no process table", async () => {
    const box = ["", "─".repeat(40), "❯ ", "─".repeat(40)];
    let reads = 0;
    const probe = {
      processes: () => null,
      pane: async () => (reads++ < 5 ? ["! mise upgrade claude", "  ⎿  Running…", ...box] : ["  ⎿  done", ...box]).join("\n"),
    };
    expect(await bangFinished(CLAUDE, COMMAND, probe, timing)).toBe(true);
    expect(reads).toBeGreaterThan(5);
  });
});

describe("lastBangOutput", () => {
  const entry = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });

  it("reads the last command's stdout and stderr, progress redraws collapsed", () => {
    const lines = [
      entry("<bash-stdout>old</bash-stdout><bash-stderr></bash-stderr>"),
      entry("<bash-input>mise upgrade claude</bash-input>"),
      entry(
        "<bash-stdout>\u001b[32mmise\u001b[0m downloading 10%\rdownloading 100%\r\nclaude@2.1.296 is already installed</bash-stdout><bash-stderr>mise WARN nothing to do</bash-stderr>"
      ),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    ];
    expect(lastBangOutput(lines)).toBe("downloading 100%\nclaude@2.1.296 is already installed\nmise WARN nothing to do");
  });

  it("is null when no command ran", () => {
    expect(lastBangOutput([entry("hello"), "{cut mid-rec"])).toBeNull();
  });
});

describe("descendants", () => {
  it("walks the tree below a pid at any depth and nothing beside it", () => {
    const rows: ProcessRow[] = [
      { pid: 2, ppid: 1, args: "a" },
      { pid: 3, ppid: 2, args: "b" },
      { pid: 4, ppid: 3, args: "c" },
      { pid: 5, ppid: 1, args: "d" },
    ];
    expect(descendants(rows, 2).map((r) => r.pid)).toEqual([3, 4]);
  });

  it("reads this process's own children off the live table", async () => {
    const { spawn } = await import("child_process");
    const child = spawn("sleep", ["5"]);
    try {
      const rows = readProcessTree(process.pid);
      expect(rows?.some((r) => r.pid === child.pid && r.args.includes("sleep 5"))).toBe(true);
    } finally {
      child.kill();
    }
  });
});
