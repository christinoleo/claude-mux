import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** A Trigger's Run names itself through `CLAUDE_MUX_RUN`, and the hook records it as `run_id`. */
const HOOK = join(__dirname, "../../src/hooks/claude-mux-hook.ts");

let home: string;

/** A stand-in for claude: a script named `claude` that runs `then`, as claude runs its hooks. */
function fakeClaude(name: string, then: string): string {
  const path = join(home, name, "claude");
  mkdirSync(join(home, name), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${then}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Run the hook as a Run's shell would reach it: the shell names itself in
 * CLAUDE_MUX_RUN_SH and starts `claude`, whose hook runs.
 */
function runHook(event: Record<string, unknown>, run: string | undefined, { nested = false, shell = true } = {}): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.MAESTRO_ROLE;
  delete env.MAESTRO_ISSUE;
  delete env.CLAUDE_MUX_RUN;
  delete env.CLAUDE_MUX_RUN_SH;
  if (run !== undefined) env.CLAUDE_MUX_RUN = run;
  const hook = `bun ${HOOK}`;
  // A claude started from inside the Run's claude, as a Bash tool call would.
  const claude = nested ? fakeClaude("outer", fakeClaude("inner", hook)) : fakeClaude("only", hook);
  const command = shell ? `CLAUDE_MUX_RUN_SH=$$ ${claude}; true` : `${claude}; true`;
  const result = spawnSync("sh", ["-c", command], { input: JSON.stringify(event), env, encoding: "utf-8" });
  expect(result.status).toBe(0);
}

function session(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".claude-mux", "sessions", `${id}.json`), "utf-8"));
}

describe("hook: run_id", () => {
  beforeEach(() => {
    home = join(tmpdir(), `cmux-hook-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(home, ".claude-mux", "sessions"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("records the Run that started the session", () => {
    runHook({ session_id: "s1", cwd: home, hook_event_name: "SessionStart", source: "startup" }, "r-abc123");
    expect(session("s1").run_id).toBe("r-abc123");
  });

  it("records none for an ordinary session, and nothing that is not an id", () => {
    runHook({ session_id: "s2", cwd: home, hook_event_name: "SessionStart", source: "startup" }, undefined);
    expect(session("s2").run_id).toBeNull();
    runHook({ session_id: "s3", cwd: home, hook_event_name: "SessionStart", source: "startup" }, "x; rm -rf /");
    expect(session("s3").run_id).toBeNull();
  });

  it("records none for a claude that the Run's claude started", () => {
    runHook({ session_id: "s4", cwd: home, hook_event_name: "SessionStart", source: "startup" }, "r-abc123", { nested: true });
    expect(session("s4").run_id).toBeNull();
  });

  it("records none when no Run's shell is named, as for anything that only inherited the id", () => {
    runHook({ session_id: "s5", cwd: home, hook_event_name: "SessionStart", source: "startup" }, "r-abc123", { shell: false });
    expect(session("s5").run_id).toBeNull();
  });
});
