import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** A Trigger's Run names itself through `CLAUDE_MUX_RUN`, and the hook records it as `run_id`. */
const HOOK = join(__dirname, "../../src/hooks/claude-mux-hook.ts");

let home: string;

function runHook(event: Record<string, unknown>, run: string | undefined): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.MAESTRO_ROLE;
  delete env.MAESTRO_ISSUE;
  delete env.CLAUDE_MUX_RUN;
  if (run !== undefined) env.CLAUDE_MUX_RUN = run;
  const result = spawnSync("bun", [HOOK], { input: JSON.stringify(event), env, encoding: "utf-8" });
  expect(result.status).toBe(0);
}

function session(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".claude-mux", "sessions", `${id}.json`), "utf-8"));
}

describe("hook: run_id", () => {
  beforeEach(() => {
    home = join(tmpdir(), `claude-mux-hook-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
});
