import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionsWsMessageSchema } from "../../src/types/ws-messages.js";
import type { Session, Subagent } from "../../src/db/sessions-json.js";

/** Driven like turn-times.test.ts: the hook as its own process, a scratch HOME, no tmux. */
const HOOK = join(__dirname, "../../src/hooks/claude-mux-hook.ts");

let home: string;
let transcript: string;

function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.MAESTRO_ROLE;
  delete env.MAESTRO_ISSUE;
  return env;
}

function hookInput(event: Record<string, unknown>): string {
  return JSON.stringify({ session_id: "s1", cwd: home, transcript_path: transcript, ...event });
}

function runHook(event: Record<string, unknown>): void {
  const result = spawnSync("bun", [HOOK], { input: hookInput(event), env: hookEnv(), encoding: "utf-8" });
  expect(result.status).toBe(0);
}

/** The hook in the background, holding the session between its read and its write for `holdMs`. */
function startHook(event: Record<string, unknown>, holdMs: number): Promise<number | null> {
  const child = spawn("bun", [HOOK], { env: hookEnv({ CLAUDE_MUX_TEST_HOLD_MS: String(holdMs) }) });
  child.stdin.end(hookInput(event));
  return new Promise((resolve) => child.on("exit", resolve));
}

function session(): Session & { subagents: Subagent[]; agent_calls?: unknown[] } {
  return JSON.parse(readFileSync(join(home, ".claude-mux", "sessions", "s1.json"), "utf-8"));
}

function agentPath(id: string, ext: string): string {
  return join(home, "project", "s1", "subagents", `agent-${id}.${ext}`);
}

function spawnAgent(toolUseId: string, description: string): void {
  runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: toolUseId,
    tool_input: { subagent_type: "Explore", description, prompt: "look around" },
  });
}

describe("hook: subagents", () => {
  beforeEach(() => {
    home = join(tmpdir(), `claude-mux-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(home, ".claude-mux", "sessions"), { recursive: true });
    mkdirSync(join(home, "project", "s1", "subagents"), { recursive: true });
    transcript = join(home, "project", "s1.jsonl");
    runHook({ hook_event_name: "UserPromptSubmit", prompt: "fan out" });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lists two Explore agents as running, and each as done after its SubagentStop", () => {
    spawnAgent("toolu_1", "Find the hook");
    spawnAgent("toolu_2", "Find the schema");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "Explore" });

    const running = session();
    expect(running.subagents).toMatchObject([
      { id: "a1", type: "Explore", description: "Find the hook", state: "running", tool_use_id: "toolu_1", ended_at: null, transcript_path: agentPath("a1", "jsonl") },
      { id: "a2", type: "Explore", description: "Find the schema", state: "running", tool_use_id: "toolu_2" },
    ]);
    expect(running.agent_calls).toEqual([]);

    // The broadcast keeps them: a field missing from the schema would be stripped.
    const parsed = SessionsWsMessageSchema.parse({
      type: "sessions",
      sessions: [{ ...running, pane_title: null, pane_alive: true }],
      count: 1,
      timestamp: Date.now(),
    });
    expect(parsed.type === "sessions" && parsed.sessions[0].subagents?.map((a) => a.state)).toEqual(["running", "running"]);

    runHook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore", agent_transcript_path: agentPath("a1", "jsonl") });
    expect(session().subagents.map((a) => a.state)).toEqual(["done", "running"]);

    runHook({ hook_event_name: "SubagentStop", agent_id: "a2", agent_type: "Explore", agent_transcript_path: agentPath("a2", "jsonl") });
    const done = session().subagents;
    expect(done.map((a) => a.state)).toEqual(["done", "done"]);
    expect(done[1].ended_at).toEqual(expect.any(Number));
  });

  it("keeps a background agent whose start lands while its call's PostToolUse is mid-write", async () => {
    spawnAgent("toolu_bg", "Research in the background");
    // A background agent's call returns at once, so its PostToolUse reads the
    // session before the SubagentStart writes and would write after it.
    const post = startHook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_bg" }, 500);
    const lock = join(home, ".claude-mux", "sessions", "s1.json.lock");
    const deadline = Date.now() + 5000;
    while (!existsSync(lock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(existsSync(lock)).toBe(true);

    runHook({ hook_event_name: "SubagentStart", agent_id: "bg", agent_type: "Explore" });
    expect(await post).toBe(0);

    const after = session();
    expect(after.subagents).toMatchObject([{ id: "bg", state: "running", tool_use_id: "toolu_bg", description: "Research in the background" }]);
    expect(after.agent_calls).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps a background agent running while a shell it started runs, through its stops and wake-ups", () => {
    spawnAgent("toolu_bg", "Sleepy");
    runHook({ hook_event_name: "SubagentStart", agent_id: "bg", agent_type: "Explore" });
    runHook({ hook_event_name: "PostToolUse", agent_id: "bg", tool_name: "Bash", tool_input: { command: "sleep 45" }, tool_response: { backgroundTaskId: "sh1" } });
    expect(session().subagents[0].shells).toEqual(["sh1"]);

    const running = [
      { id: "bg", type: "subagent", status: "running", agent_type: "Explore" },
      { id: "sh1", type: "shell", status: "running" },
    ];
    runHook({ hook_event_name: "SubagentStop", agent_id: "bg", agent_type: "Explore", background_tasks: running });
    expect(session().subagents[0]).toMatchObject({ state: "running", ended_at: null });
    // The parent's turn ends with only the agent's shell left; the agent is still not done.
    runHook({ hook_event_name: "Stop", background_tasks: [running[1]] });
    expect(session().subagents[0].state).toBe("running");

    // The shell's end wakes the agent under the same id, which must not take
    // the call parked for a later agent of the same type.
    spawnAgent("toolu_next", "Next one");
    runHook({ hook_event_name: "SubagentStart", agent_id: "bg", agent_type: "Explore" });
    expect(session().subagents).toHaveLength(1);
    expect(session().agent_calls).toHaveLength(1);

    runHook({ hook_event_name: "SubagentStop", agent_id: "bg", agent_type: "Explore", background_tasks: [running[0]] });
    expect(session().subagents[0]).toMatchObject({ state: "done", description: "Sleepy", ended_at: expect.any(Number) });
  });

  it("ends a paused agent once its pause has run past half an hour", () => {
    spawnAgent("toolu_bg", "Left a server running");
    runHook({ hook_event_name: "SubagentStart", agent_id: "bg", agent_type: "Explore" });
    runHook({ hook_event_name: "PostToolUse", agent_id: "bg", tool_name: "Bash", tool_response: { backgroundTaskId: "dev" } });
    runHook({ hook_event_name: "SubagentStop", agent_id: "bg", agent_type: "Explore", background_tasks: [{ id: "dev", type: "shell", status: "running" }] });
    const s = session();
    expect(s.subagents[0].state).toBe("running");

    const longAgo = Date.now() - 31 * 60 * 1000;
    s.subagents[0].paused_at = longAgo;
    writeFileSync(join(home, ".claude-mux", "sessions", "s1.json"), JSON.stringify(s));
    runHook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });
    expect(session().subagents[0]).toMatchObject({ state: "done", ended_at: longAgo });
  });

  it("leaves a failed agent failed when a start under its id arrives", () => {
    spawnAgent("toolu_1", "Doomed");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: "toolu_1", error: "boom" });
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(session().subagents[0].state).toBe("failed");
  });

  it("ends an agent whose stop lists only the parent's own shells", () => {
    spawnAgent("toolu_1", "Quick");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore", background_tasks: [{ id: "dev", type: "shell", status: "running" }] });
    expect(session().subagents[0].state).toBe("done");
  });

  it("takes the description from the agent's meta.json when Claude Code has written it", () => {
    writeFileSync(agentPath("a1", "meta.json"), JSON.stringify({ agentType: "Explore", description: "From meta", toolUseId: "toolu_9" }));
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(session().subagents[0]).toMatchObject({ description: "From meta", tool_use_id: "toolu_9" });
  });

  it("marks an agent failed when its Agent call fails, whichever lands first", () => {
    spawnAgent("toolu_1", "Doomed");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: "toolu_1", error: "boom" });
    expect(session().subagents[0].state).toBe("failed");

    spawnAgent("toolu_2", "Doomed too");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "Explore" });
    runHook({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: "toolu_2", error: "boom" });
    runHook({ hook_event_name: "SubagentStop", agent_id: "a2", agent_type: "Explore" });
    expect(session().subagents[1].state).toBe("failed");
  });

  it("lets the meta correct a start that was paired with the wrong call", () => {
    spawnAgent("toolu_1", "Find the hook");
    spawnAgent("toolu_2", "Find the schema");
    runHook({ hook_event_name: "SubagentStart", agent_id: "b", agent_type: "Explore" });
    expect(session().subagents[0]).toMatchObject({ description: "Find the hook", tool_use_id: "toolu_1" });

    writeFileSync(agentPath("b", "meta.json"), JSON.stringify({ description: "Find the schema", toolUseId: "toolu_2" }));
    runHook({ hook_event_name: "SubagentStop", agent_id: "b", agent_type: "Explore" });
    expect(session().subagents[0]).toMatchObject({ description: "Find the schema", tool_use_id: "toolu_2", state: "done" });
  });

  it("drops meta values that are not strings, which would break the broadcast", () => {
    writeFileSync(agentPath("a1", "meta.json"), JSON.stringify({ description: 42, toolUseId: { x: 1 } }));
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    expect(session().subagents[0]).toMatchObject({ description: null, tool_use_id: null });
  });

  it("ends every agent, and forgets unstarted calls, when the turn ends for good", () => {
    spawnAgent("toolu_1", "Interrupted");
    spawnAgent("toolu_2", "Denied");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "Stop", background_tasks: [{ type: "subagent", agent_type: "Explore" }] });
    expect(session().subagents[0].state).toBe("running");

    runHook({ hook_event_name: "Stop", background_tasks: [] });
    const after = session();
    expect(after.subagents[0]).toMatchObject({ state: "done", ended_at: expect.any(Number) });
    expect(after.agent_calls).toEqual([]);
  });

  it("drops an agent no Agent call spawned that leaves no transcript", () => {
    runHook({ hook_event_name: "SubagentStop", agent_id: "internal", agent_type: "general-purpose", agent_transcript_path: agentPath("internal", "jsonl") });
    expect(session().subagents ?? []).toEqual([]);
  });

  it("keeps an agent no call was paired with when its transcript is on disk", () => {
    writeFileSync(agentPath("loose", "jsonl"), "");
    runHook({ hook_event_name: "SubagentStop", agent_id: "loose", agent_type: "Explore", agent_transcript_path: agentPath("loose", "jsonl") });
    expect(session().subagents.map(a => a.id)).toEqual(["loose"]);
  });

  it("ignores a subagent event without an agent id", () => {
    runHook({ session_id: "ghost", hook_event_name: "SubagentStart", agent_type: "Explore" });
    expect(() => readFileSync(join(home, ".claude-mux", "sessions", "ghost.json"))).toThrow();
  });

  it("records the tool a running agent last called, and clears it at its stop", () => {
    writeFileSync(agentPath("a1", "jsonl"), "");
    runHook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    runHook({ hook_event_name: "PreToolUse", agent_id: "a1", tool_name: "Grep", tool_input: { pattern: "x" } });
    expect(session().subagents[0].current_tool).toBe("Grep");
    runHook({ hook_event_name: "PreToolUse", agent_id: "a1", tool_name: "mcp__svelte__get-documentation" });
    expect(session().subagents[0].current_tool).toBe("get-documentation");

    runHook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore" });
    expect(session().subagents[0].current_tool).toBeNull();
  });

  it("keeps finished agents for an hour, failed ones for a day, so the sidebar can fold them", () => {
    const s = session();
    const at = (min: number) => Date.now() - min * 60 * 1000;
    const agent = (id: string, state: Subagent["state"], ended: number | null): Subagent => ({
      id, type: "Explore", description: null, state, started_at: at(2000), ended_at: ended, transcript_path: null,
    });
    s.subagents = [
      agent("recent", "done", at(11)),
      agent("old", "done", at(61)),
      agent("failed", "failed", at(61)),
      agent("ancient-failure", "failed", at(25 * 60)),
      agent("long", "running", null),
    ];
    writeFileSync(join(home, ".claude-mux", "sessions", "s1.json"), JSON.stringify(s));
    runHook({ hook_event_name: "SubagentStart", agent_id: "new", agent_type: "Plan" });
    expect(session().subagents.map((a) => a.id)).toEqual(["recent", "failed", "long", "new"]);
  });
});
