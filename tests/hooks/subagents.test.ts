import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionsWsMessageSchema } from "../../src/types/ws-messages.js";
import type { Session, Subagent } from "../../src/db/sessions-json.js";

/** Driven like turn-times.test.ts: the hook as its own process, a scratch HOME, no tmux. */
const HOOK = join(__dirname, "../../src/hooks/claude-mux-hook.ts");

let home: string;
let transcript: string;

function runHook(event: Record<string, unknown>): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.MAESTRO_ROLE;
  delete env.MAESTRO_ISSUE;
  const result = spawnSync("bun", [HOOK], {
    input: JSON.stringify({ session_id: "s1", cwd: home, transcript_path: transcript, ...event }),
    env,
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
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

  it("prunes agents that finished more than ten minutes ago", () => {
    const s = session();
    const old = Date.now() - 11 * 60 * 1000;
    s.subagents = [
      { id: "old", type: "Explore", description: null, state: "done", started_at: old, ended_at: old, transcript_path: null },
      { id: "long", type: "Explore", description: null, state: "running", started_at: old, ended_at: null, transcript_path: null },
    ];
    writeFileSync(join(home, ".claude-mux", "sessions", "s1.json"), JSON.stringify(s));
    runHook({ hook_event_name: "SubagentStart", agent_id: "new", agent_type: "Plan" });
    expect(session().subagents.map((a) => a.id)).toEqual(["long", "new"]);
  });
});
