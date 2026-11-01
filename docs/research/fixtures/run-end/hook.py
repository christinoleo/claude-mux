#!/usr/bin/env python3
"""Probe hook for docs/research/run-end.md. Logs every event and, as told by
$PROBE/ctl.json, plays the part of a Run's Stop gate, time limit and exit.

ctl.json fields, all optional:
  run           directory name under $PROBE/runs for this scenario's events
  gate          "until_marker" | "always": block Stop until the marker exists / always
  marker        file (relative to cwd) that means the job is done
  on_allow      "sendkeys_exit" | "sigterm" | "sigint" | "continue_false":
                what a Stop that is allowed does next
  soft_deadline epoch seconds past which PreToolUse acts
  soft_mode     "continue_false" | "deny"
  perm          "deny": answer every PermissionRequest with a denial
"""
import json, os, subprocess, sys, time

P = os.environ["PROBE"]
i = json.load(sys.stdin)
try:
    ctl = json.load(open(P + "/ctl.json"))
except Exception:
    ctl = {}
ev = i["hook_event_name"]
now = time.time()
rec = {"t": now, "ev": ev, "sid": i.get("session_id", "")[:8]}
for k in ("tool_name", "stop_hook_active", "reason", "notification_type", "error",
          "error_type", "source", "permission_mode"):
    if k in i:
        rec[k] = i[k]
if "last_assistant_message" in i:
    rec["last_msg"] = (i["last_assistant_message"] or "")[:80]
if "background_tasks" in i:
    rec["bg"] = len(i["background_tasks"])
rec["maestro"] = os.environ.get("MAESTRO_ROLE")
if "command" in i.get("tool_input", {}):
    rec["command"] = i["tool_input"]["command"][:80]
for k in ("agent_id", "agent_type", "tool_use_id"):
    if k in i:
        rec[k] = i[k]

d = f"{P}/runs/{ctl.get('run', 'none')}"
os.makedirs(d, exist_ok=True)


def claude_pid():
    pid = os.getppid()
    for _ in range(10):
        try:
            if open(f"/proc/{pid}/comm").read().strip() == "claude":
                return pid
            pid = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1])
        except Exception:
            return None
    return None


def detached(cmd):
    subprocess.Popen(["sh", "-c", cmd], start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


out = None
if ev == "Stop":
    done = os.path.exists(os.path.join(i["cwd"], ctl.get("marker", "run-done")))
    gate = ctl.get("gate")
    if gate == "always":
        out = {"decision": "block", "reason": "Gate says keep going. Reply with only the word: again"}
    elif gate == "until_marker" and not done:
        past = ctl.get("soft_deadline") and now > ctl["soft_deadline"]
        if not past:
            out = {"decision": "block", "reason": "The job is not done. Use the Bash tool to run exactly: touch run-done. Then reply with only: finished"}
    if out is None:
        act = ctl.get("on_allow")
        pane = os.environ.get("TMUX_PANE", "")
        if act == "sendkeys_exit":
            detached(f"sleep 1; tmux send-keys -t {pane} -l /exit; sleep .5; tmux send-keys -t {pane} Enter")
        elif act in ("sigterm", "sigint"):
            pid = claude_pid()
            rec["signalled"] = pid
            detached(f"sleep 1; kill -{'TERM' if act == 'sigterm' else 'INT'} {pid}")
        elif act == "continue_false":
            out = {"continue": False, "stopReason": "probe: run finished"}
    rec["decision"] = (out or {}).get("decision") or ("continue_false" if out else "allow")

if ev == "PreToolUse" and ctl.get("soft_deadline") and now > ctl["soft_deadline"]:
    mode = ctl.get("soft_mode")
    if mode == "continue_false":
        out = {"continue": False, "stopReason": "probe: time limit reached"}
    elif mode == "deny":
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
               "permissionDecisionReason": "Time limit reached. Do not call more tools. Reply with only: TIMEUP"}}
    rec["soft"] = mode

if ev == "PermissionRequest" and ctl.get("perm") == "deny":
    out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
           "decision": {"behavior": "deny", "message": "Nobody is here to answer. Carry on without it, or reply with only: BLOCKED"}}}
    rec["perm_decision"] = "deny"

open(d + "/events.jsonl", "a").write(json.dumps(rec) + "\n")
if out:
    print(json.dumps(out))
