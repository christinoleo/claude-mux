"""Writes the reconstructed Codex rollout fixtures. Shapes follow openai/codex rust-v0.160.0 source."""
import json
import os
import sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

ROOT = "019a2b3c-4d5e-7f60-8a1b-2c3d4e5f6071"
CHILD = "019a2b3d-1111-7a22-9b33-4c4d5e6f7081"
T1 = "019a2b3c-5000-7000-8000-000000000001"
T2 = "019a2b3c-6000-7000-8000-000000000002"
T3 = "019a2b3c-7000-7000-8000-000000000003"
CWD = "/home/user/Projects/demo"
BASE = 1792173600  # 2026-10-16T18:00:00Z


def ts(sec, ms=0):
    import datetime as dt
    t = dt.datetime.fromtimestamp(BASE + sec, dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


class Log:
    def __init__(self, paginated=True):
        self.lines = []
        self.paginated = paginated

    def add(self, sec, kind, payload, ms=0):
        line = {"timestamp": ts(sec, ms)}
        if self.paginated:
            line["ordinal"] = len(self.lines)
        line["type"] = kind
        line["payload"] = payload
        self.lines.append(line)

    def write(self, name):
        with open(os.path.join(out, name), "w") as f:
            for line in self.lines:
                f.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")


def usage(i, c, o, r):
    return {"input_tokens": i, "cached_input_tokens": c, "cache_write_input_tokens": 0,
            "output_tokens": o, "reasoning_output_tokens": r, "total_tokens": i + o}


def meta(thread_id, session_id, source, mode, sec=0, extra=None):
    m = {
        "session_id": session_id,
        "id": thread_id,
        "timestamp": ts(sec),
        "cwd": CWD,
        "originator": "codex-tui",
        "cli_version": "0.160.0",
        "source": source,
        "model_provider": "openai",
        "base_instructions": {"text": "You are Codex, a coding agent ... [several KB, trimmed in this fixture]"},
    }
    if mode:
        m["history_mode"] = mode
    if extra:
        m.update(extra)
    m["git"] = {"commit_hash": "4f1c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e", "branch": "main",
                "repository_url": "https://github.com/example/demo.git"}
    return m


def turn_context(turn_id, model="gpt-5.5-codex", effort="medium"):
    return {"turn_id": turn_id, "cwd": CWD, "approval_policy": "on-request",
            "sandbox_policy": {"type": "workspace-write", "writable_roots": [], "network_access": False,
                               "exclude_tmpdir_env_var": False, "exclude_slash_tmp": False},
            "model": model, "effort": effort, "summary": "auto"}


def item(thread, turn, it, start_ms, done_ms):
    return {"type": "item_completed", "thread_id": thread, "turn_id": turn, "item": it,
            "started_at_ms": start_ms, "completed_at_ms": done_ms}


MS = BASE * 1000

# ---------------------------------------------------------------- paginated
p = Log()
p.add(0, "session_meta", meta(ROOT, ROOT, "cli", "paginated", extra={"thread_source": "user"}))
# turn 1
p.add(5, "event_msg", {"type": "task_started", "turn_id": T1, "started_at": BASE + 5,
                        "model_context_window": 258400, "collaboration_mode_kind": "default"})
p.add(5, "turn_context", turn_context(T1), ms=10)
p.add(5, "response_item", {"type": "message", "role": "developer", "content": [
    {"type": "input_text", "text": "<permissions instructions>... [trimmed]</permissions instructions>"}]}, ms=11)
p.add(5, "response_item", {"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "# AGENTS.md instructions for /home/user/Projects/demo\n\n<INSTRUCTIONS>... [trimmed]</INSTRUCTIONS>"}]}, ms=12)
p.add(5, "response_item", {"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "<environment_context>\n  <cwd>/home/user/Projects/demo</cwd>\n  <shell>bash</shell>\n</environment_context>"}]}, ms=13)
p.add(5, "response_item", {"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "Rename the greeting in src/hello.ts to say hi, then run the tests."}]}, ms=14)
p.add(5, "event_msg", item(ROOT, T1, {"type": "UserMessage", "id": "019a2b3c-5000-7000-8000-0000000000a1",
    "content": [{"type": "text", "text": "Rename the greeting in src/hello.ts to say hi, then run the tests.", "text_elements": []}]},
    MS + 5014, MS + 5014), ms=15)
p.add(8, "response_item", {"type": "reasoning", "summary": [
    {"type": "summary_text", "text": "**Locating the greeting**\n\nI'll read src/hello.ts first."}],
    "encrypted_content": "gAAAAB...[opaque]"})
p.add(8, "event_msg", item(ROOT, T1, {"type": "Reasoning", "id": "rs_01",
    "summary_text": ["**Locating the greeting**\n\nI'll read src/hello.ts first."], "raw_content": []},
    MS + 6000, MS + 8000), ms=1)
p.add(8, "response_item", {"type": "function_call", "name": "exec_command",
    "arguments": json.dumps({"cmd": "sed -n 1,40p src/hello.ts", "workdir": CWD}), "call_id": "call_read1"}, ms=2)
p.add(9, "event_msg", item(ROOT, T1, {"type": "CommandExecution", "id": "call_read1",
    "process_id": "41231", "command": ["/bin/bash", "-lc", "sed -n 1,40p src/hello.ts"],
    "cwd": "file:///home/user/Projects/demo",
    "parsed_cmd": [{"type": "read", "cmd": "sed -n 1,40p src/hello.ts", "name": "hello.ts", "path": "src/hello.ts"}],
    "source": "agent", "status": "completed", "stdout": "export const greeting = \"hello\";\n", "stderr": "",
    "aggregated_output": "export const greeting = \"hello\";\n", "exit_code": 0,
    "duration": {"secs": 0, "nanos": 41000000},
    "formatted_output": "export const greeting = \"hello\";\n"}, MS + 8100, MS + 9000))
p.add(9, "response_item", {"type": "function_call_output", "call_id": "call_read1",
    "output": "Chunk ID: 1a2b3c\nWall time: 0.0410 seconds\nProcess exited with code 0\nOutput:\nexport const greeting = \"hello\";\n"}, ms=1)
p.add(9, "token_usage_record", {"thread_id": ROOT, "turn_id": T1, "session_id": ROOT, "root_turn_id": T1,
    "response_id": "resp_01", "usage": usage(9120, 0, 210, 128), "turn_token_usage": usage(9120, 0, 210, 128),
    "thread_token_usage": usage(9120, 0, 210, 128)}, ms=2)
p.add(9, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(9120, 0, 210, 128),
    "last_token_usage": usage(9120, 0, 210, 128), "model_context_window": 258400},
    "rate_limits": {"limit_id": "codex", "limit_name": None,
                    "primary": {"used_percent": 12.0, "window_minutes": 300, "resets_at": BASE + 14400},
                    "secondary": {"used_percent": 3.0, "window_minutes": 10080, "resets_at": BASE + 500000},
                    "credits": None, "individual_limit": None, "plan_type": "plus", "rate_limit_reached_type": None}}, ms=3)
patch = "*** Begin Patch\n*** Update File: src/hello.ts\n@@\n-export const greeting = \"hello\";\n+export const greeting = \"hi\";\n*** Add File: src/hello.test.ts\n+import { greeting } from \"./hello\";\n+test(\"greets\", () => expect(greeting).toBe(\"hi\"));\n*** End Patch\n"
p.add(12, "response_item", {"type": "custom_tool_call", "status": "completed", "call_id": "call_patch1",
    "name": "apply_patch", "input": patch})
p.add(12, "event_msg", item(ROOT, T1, {"type": "FileChange", "id": "call_patch1", "changes": {
    "/home/user/Projects/demo/src/hello.ts": {"type": "update",
        "unified_diff": "@@ -1 +1 @@\n-export const greeting = \"hello\";\n+export const greeting = \"hi\";\n", "move_path": None},
    "/home/user/Projects/demo/src/hello.test.ts": {"type": "add",
        "content": "import { greeting } from \"./hello\";\ntest(\"greets\", () => expect(greeting).toBe(\"hi\"));\n"}},
    "status": "completed", "stdout": "Success. Updated the following files:\nM src/hello.ts\nA src/hello.test.ts\n", "stderr": ""},
    MS + 12000, MS + 12100), ms=200)
p.add(12, "response_item", {"type": "custom_tool_call_output", "call_id": "call_patch1",
    "output": "{\"output\":\"Success. Updated the following files:\\nM src/hello.ts\\nA src/hello.test.ts\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.0}}"}, ms=201)
p.add(13, "response_item", {"type": "function_call", "name": "exec_command",
    "arguments": json.dumps({"cmd": "bun test", "workdir": CWD}), "call_id": "call_test1"})
p.add(15, "event_msg", item(ROOT, T1, {"type": "CommandExecution", "id": "call_test1",
    "command": ["/bin/bash", "-lc", "bun test"], "cwd": "file:///home/user/Projects/demo",
    "parsed_cmd": [{"type": "unknown", "cmd": "bun test"}], "source": "agent", "status": "failed",
    "stdout": "", "stderr": "error: 1 test failed\n", "aggregated_output": "error: 1 test failed\n", "exit_code": 1,
    "duration": {"secs": 1, "nanos": 520000000}, "formatted_output": "error: 1 test failed\n"}, MS + 13000, MS + 15000))
p.add(15, "response_item", {"type": "function_call_output", "call_id": "call_test1",
    "output": "Process exited with code 1\nOutput:\nerror: 1 test failed\n"}, ms=1)
p.add(18, "token_usage_record", {"thread_id": ROOT, "turn_id": T1, "session_id": ROOT, "root_turn_id": T1,
    "response_id": "resp_02", "usage": usage(10480, 8960, 340, 96), "turn_token_usage": usage(19600, 8960, 550, 224),
    "thread_token_usage": usage(19600, 8960, 550, 224)})
p.add(18, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(19600, 8960, 550, 224),
    "last_token_usage": usage(10480, 8960, 340, 96), "model_context_window": 258400}, "rate_limits": None}, ms=1)
p.add(18, "response_item", {"type": "message", "role": "assistant", "content": [
    {"type": "output_text", "text": "Renamed the greeting to `hi` in `src/hello.ts` and added a test. `bun test` fails: the test runner is not configured yet."}],
    "phase": "final_answer"}, ms=2)
p.add(18, "event_msg", item(ROOT, T1, {"type": "AgentMessage", "id": "msg_01", "content": [
    {"type": "Text", "text": "Renamed the greeting to `hi` in `src/hello.ts` and added a test. `bun test` fails: the test runner is not configured yet."}],
    "phase": "final_answer"}, MS + 17000, MS + 18000), ms=3)
p.add(18, "event_msg", {"type": "task_complete", "turn_id": T1,
    "last_agent_message": "Renamed the greeting to `hi` in `src/hello.ts` and added a test. `bun test` fails: the test runner is not configured yet.",
    "started_at": BASE + 5, "completed_at": BASE + 18, "duration_ms": 13004, "time_to_first_token_ms": 2100}, ms=4)
# turn 2: interrupted with Escape
p.add(60, "event_msg", {"type": "task_started", "turn_id": T2, "started_at": BASE + 60,
                         "model_context_window": 258400, "collaboration_mode_kind": "default"})
p.add(60, "turn_context", turn_context(T2), ms=1)
p.add(60, "response_item", {"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "Set up the bun test runner"}]}, ms=2)
p.add(60, "event_msg", item(ROOT, T2, {"type": "UserMessage", "id": "019a2b3c-6000-7000-8000-0000000000a2",
    "content": [{"type": "text", "text": "Set up the bun test runner", "text_elements": []}]}, MS + 60002, MS + 60002), ms=3)
p.add(63, "event_msg", {"type": "turn_aborted", "turn_id": T2, "reason": "interrupted",
                         "started_at": BASE + 60, "completed_at": BASE + 63, "duration_ms": 3100})
# turn 3: /compact
p.add(120, "event_msg", {"type": "task_started", "turn_id": T3, "started_at": BASE + 120,
                          "model_context_window": 258400, "collaboration_mode_kind": "default"})
p.add(125, "compacted", {"message": "Summary of the conversation so far: the greeting in src/hello.ts was renamed to hi ...",
                         "replacement_history": [
                             {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Rename the greeting ... [the retained history, often very large]"}]}],
                         "window_number": 1})
p.add(125, "turn_context", turn_context(T3), ms=1)
p.add(125, "event_msg", item(ROOT, T3, {"type": "ContextCompaction", "id": "cmp_01"}, MS + 120000, MS + 125000), ms=2)
p.add(125, "event_msg", {"type": "task_complete", "turn_id": T3, "last_agent_message": None,
                          "started_at": BASE + 120, "completed_at": BASE + 125, "duration_ms": 5002}, ms=3)
p.write("rollout-2026-10-16T15-00-00-" + ROOT + ".jsonl")

# ---------------------------------------------------------------- subagent parent excerpt + child
TP = "019a2b3d-0000-7000-8000-0000000000b1"
TC = "019a2b3d-1111-7000-8000-0000000000c1"
sp = Log()
sp.add(0, "session_meta", meta(ROOT, ROOT, "cli", "paginated", extra={"thread_source": "user"}))
sp.add(200, "event_msg", {"type": "task_started", "turn_id": TP, "started_at": BASE + 200,
                           "model_context_window": 258400, "collaboration_mode_kind": "default"})
sp.add(200, "turn_context", turn_context(TP), ms=1)
sp.add(200, "event_msg", item(ROOT, TP, {"type": "UserMessage", "id": "u-b1", "content": [
    {"type": "text", "text": "Use an explorer subagent to find where config is loaded", "text_elements": []}]}, MS + 200002, MS + 200002), ms=2)
sp.add(203, "response_item", {"type": "function_call", "name": "spawn_agent", "namespace": "multi_agent_v1", "arguments": json.dumps(
    {"message": "Find where config is loaded and report file:line.", "agent_type": "explorer"}), "call_id": "call_spawn1"})
sp.add(204, "event_msg", item(ROOT, TP, {"type": "CollabAgentToolCall", "id": "call_spawn1", "tool": "spawn_agent",
    "status": "completed", "sender_thread_id": ROOT, "receiver_thread_ids": [CHILD],
    "receiver_agents": [{"thread_id": CHILD, "agent_nickname": "Hubble", "agent_role": "explorer"}],
    "prompt": "Find where config is loaded and report file:line.", "model": "gpt-5.5-codex-mini",
    "reasoning_effort": "low", "agents_states": {CHILD: "pending_init"}}, MS + 203000, MS + 204000))
sp.add(204, "response_item", {"type": "function_call_output", "call_id": "call_spawn1",
    "output": json.dumps({"agent_id": CHILD, "nickname": "Hubble"})}, ms=1)
sp.add(205, "response_item", {"type": "function_call", "name": "wait", "namespace": "multi_agent_v1", "arguments": json.dumps(
    {"targets": [CHILD], "timeout_ms": 120000}), "call_id": "call_wait1"})
sp.add(230, "event_msg", item(ROOT, TP, {"type": "CollabAgentToolCall", "id": "call_wait1", "tool": "wait",
    "status": "completed", "sender_thread_id": ROOT, "receiver_thread_ids": [CHILD], "receiver_agents": [],
    "agents_states": {CHILD: {"completed": "Config is loaded in src/config.ts:42."}}}, MS + 205000, MS + 230000))
sp.write("subagent-parent-excerpt.jsonl")

sc = Log()
sc.add(203, "session_meta", meta(CHILD, ROOT, {"subagent": {"thread_spawn": {
    "parent_thread_id": ROOT, "depth": 1, "agent_path": None, "agent_nickname": "Hubble", "agent_role": "explorer"}}},
    "paginated", sec=203, extra={"parent_thread_id": ROOT, "thread_source": "subagent",
                                 "agent_nickname": "Hubble", "agent_role": "explorer"}), ms=500)
sc.add(203, "event_msg", {"type": "task_started", "turn_id": TC, "started_at": BASE + 203,
                           "model_context_window": 258400, "collaboration_mode_kind": "default"}, ms=600)
sc.add(203, "turn_context", turn_context(TC, model="gpt-5.5-codex-mini", effort="low"), ms=601)
sc.add(203, "event_msg", item(CHILD, TC, {"type": "UserMessage", "id": "u-c1", "content": [
    {"type": "text", "text": "Find where config is loaded and report file:line.", "text_elements": []}]}, MS + 203602, MS + 203602), ms=602)
sc.add(229, "event_msg", item(CHILD, TC, {"type": "AgentMessage", "id": "msg_c1", "content": [
    {"type": "Text", "text": "Config is loaded in src/config.ts:42."}], "phase": "final_answer"}, MS + 228000, MS + 229000))
sc.add(229, "event_msg", {"type": "task_complete", "turn_id": TC, "last_agent_message": "Config is loaded in src/config.ts:42.",
                           "started_at": BASE + 203, "completed_at": BASE + 229, "duration_ms": 25400}, ms=1)
sc.write("rollout-2026-10-16T15-03-23-" + CHILD + ".jsonl")

# ---------------------------------------------------------------- legacy (Codex before 0.147, or a thread started as legacy)
LEG = "0199f000-aaaa-7bbb-8ccc-ddddeeeeffff"
TL = "0199f000-aaaa-7000-8000-000000000001"
lg = Log(paginated=False)
lg.add(0, "session_meta", meta(LEG, LEG, "cli", None))
lg.add(5, "event_msg", {"type": "task_started", "turn_id": TL, "model_context_window": 258400})
lg.add(5, "turn_context", turn_context(TL), ms=1)
lg.add(5, "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Fix the typo in README.md"}]}, ms=2)
lg.add(5, "event_msg", {"type": "user_message", "message": "Fix the typo in README.md"}, ms=3)
lg.add(7, "response_item", {"type": "reasoning", "summary": [{"type": "summary_text", "text": "**Fixing the typo**"}], "encrypted_content": "gAAAAB...[opaque]"})
lg.add(7, "event_msg", {"type": "agent_reasoning", "text": "**Fixing the typo**"}, ms=1)
lg.add(8, "response_item", {"type": "custom_tool_call", "status": "completed", "call_id": "call_p1", "name": "apply_patch",
                             "input": "*** Begin Patch\n*** Update File: README.md\n@@\n-Teh demo\n+The demo\n*** End Patch\n"})
lg.add(8, "event_msg", {"type": "patch_apply_end", "call_id": "call_p1", "turn_id": TL,
                         "stdout": "Success. Updated the following files:\nM README.md\n", "stderr": "", "success": True,
                         "changes": {"/home/user/Projects/demo/README.md": {"type": "update",
                                                                            "unified_diff": "@@ -1 +1 @@\n-Teh demo\n+The demo\n", "move_path": None}},
                         "status": "completed"}, ms=1)
lg.add(8, "response_item", {"type": "custom_tool_call_output", "call_id": "call_p1", "output": "Success. Updated the following files:\nM README.md\n"}, ms=2)
lg.add(9, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage(8200, 0, 120, 64),
                         "last_token_usage": usage(8200, 0, 120, 64), "model_context_window": 258400}, "rate_limits": None})
lg.add(9, "response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Fixed: \"Teh\" is now \"The\" in README.md."}]}, ms=1)
lg.add(9, "event_msg", {"type": "agent_message", "message": "Fixed: \"Teh\" is now \"The\" in README.md."}, ms=2)
lg.add(9, "event_msg", {"type": "task_complete", "turn_id": TL, "last_agent_message": "Fixed: \"Teh\" is now \"The\" in README.md."}, ms=3)
lg.write("legacy-rollout-2026-08-01T09-00-00-" + LEG + ".jsonl")

# ---------------------------------------------------------------- side files
with open(os.path.join(out, "session_index.jsonl"), "w") as f:
    for e in [{"id": ROOT, "thread_name": "Say hi in hello.ts", "updated_at": "2026-10-16T18:00:21Z"},
              {"id": LEG, "thread_name": "README typo", "updated_at": "2026-08-01T12:00:12Z"},
              {"id": ROOT, "thread_name": "Greeting rename", "updated_at": "2026-10-16T18:05:00Z"}]:
        f.write(json.dumps(e, separators=(",", ":")) + "\n")
with open(os.path.join(out, "version.json"), "w") as f:
    json.dump({"latest_version": "0.163.0", "last_checked_at": "2026-10-16T09:12:44.123456Z", "dismissed_version": None}, f)
    f.write("\n")
