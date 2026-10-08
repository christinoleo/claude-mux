import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * The hook runs as its own process, reading one event from stdin, so it is
 * driven the same way here: a scratch HOME, and no tmux in the environment.
 */
const HOOK = join(__dirname, "../../src/hooks/claude-mux-hook.ts");

let home: string;

function runHook(event: Record<string, unknown>): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.MAESTRO_ROLE;
  delete env.MAESTRO_ISSUE;
  const result = spawnSync("bun", [HOOK], { input: JSON.stringify(event), env, encoding: "utf-8" });
  expect(result.status).toBe(0);
}

function session(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".claude-mux", "sessions", `${id}.json`), "utf-8"));
}

describe("hook: turn timestamps", () => {
  beforeEach(() => {
    home = join(tmpdir(), `claude-mux-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(home, ".claude-mux", "sessions"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stamps the turn's start on the prompt and its end on Stop", () => {
    const base = { session_id: "s1", cwd: home };
    const before = Date.now();
    runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "do the thing" });
    const started = session("s1");
    expect(started.turn_started_at).toBeGreaterThanOrEqual(before);
    expect(started.turn_completed_at).toBeUndefined();

    runHook({ ...base, hook_event_name: "Stop" });
    const done = session("s1");
    expect(done.state).toBe("idle");
    expect(done.turn_completed_at).toBeGreaterThanOrEqual(started.turn_started_at as number);
    expect(done.turn_started_at).toBe(started.turn_started_at);
  });

  it("does not call a turn complete while a background agent will wake it", () => {
    const base = { session_id: "s2", cwd: home };
    runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    runHook({
      ...base,
      hook_event_name: "Stop",
      background_tasks: [{ type: "subagent", agent_type: "Explore" }],
    });
    const paused = session("s2");
    expect(paused.state).toBe("busy");
    expect(paused.turn_completed_at).toBeUndefined();

    runHook({ ...base, hook_event_name: "Stop", background_tasks: [] });
    expect(session("s2").turn_completed_at).toEqual(expect.any(Number));
  });

  it("keeps the last completion when the next turn starts", () => {
    const path = join(home, ".claude-mux", "sessions", "s3.json");
    writeFileSync(
      path,
      JSON.stringify({ v: 1, id: "s3", pid: 0, cwd: home, git_root: null, tmux_target: null, state: "idle", current_action: null, prompt_text: null, last_update: 1, turn_completed_at: 1234 })
    );
    runHook({ session_id: "s3", cwd: home, hook_event_name: "UserPromptSubmit", prompt: "again" });
    expect(session("s3").turn_completed_at).toBe(1234);
  });
});
