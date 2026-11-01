#!/usr/bin/env python3
"""Probe hook for the dialog-hooks research (claude-mux #157).

Claude Code runs this for every configured event. It logs what it received and
what happened to it, then acts on the first matching rule in $PROBE/case.json.
Rule fields: ev, tool, agent (True: only inside a subagent), hold, via, answers,
behavior, message. See drive.py for how each case sets them.
"""
import json, os, signal, socket, sys, time

P = os.environ["PROBE"]
raw = sys.stdin.read()
i = json.loads(raw)
ev = i["hook_event_name"]
start = time.time()


def log(kind, **kw):
    rec = {"t": round(time.time(), 3), "kind": kind, "ev": ev, "pid": os.getpid(), **kw}
    with open(P + "/events.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")


def on_signal(num, _frame):
    log("signal", sig=signal.Signals(num).name)
    sys.exit(128 + num)


for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(s, on_signal)

fields = {}
for k in ("tool_name", "tool_use_id", "agent_id", "agent_type", "permission_mode",
          "notification_type", "message", "error", "is_interrupt", "reason", "agent_transcript_path"):
    if k in i:
        fields[k] = i[k]
if "tool_input" in i:
    fields["tool_input"] = i["tool_input"]
if "tool_response" in i:
    fields["tool_response"] = i["tool_response"]
fields["transcript_path"] = i.get("transcript_path")
log("fired", ppid=os.getppid(), **fields)

rules = []
if os.path.exists(P + "/case.json"):
    rules = json.load(open(P + "/case.json"))


def match(r):
    if r["ev"] != ev or r.get("tool") != i.get("tool_name"):
        return False
    if "agent" in r and bool(i.get("agent_id")) != r["agent"]:
        return False
    return True


rule = next((r for r in rules if match(r)), None)
if rule is None:
    sys.exit(0)

DEADLINE = rule.get("deadline", 170)


def hold_file(path):
    """Wait for a file; return its JSON content, or {} for an empty file."""
    ppid = os.getppid()
    while time.time() - start < DEADLINE:
        if os.path.exists(path):
            time.sleep(0.05)
            txt = open(path).read().strip()
            return json.loads(txt) if txt else {}
        if os.getppid() != ppid:
            log("reparented", old=ppid, new=os.getppid())
            ppid = os.getppid()
        time.sleep(0.1)
    log("deadline")
    return None


def hold_socket(reconnect):
    """Register with the holder over a Unix socket and wait for its reply line."""
    os.chdir(P)  # A relative path: the full one exceeds the 108-byte AF_UNIX limit.
    while time.time() - start < DEADLINE:
        c = socket.socket(socket.AF_UNIX)
        try:
            c.connect("holder.sock")
        except OSError as e:
            log("sock_connect_failed", err=type(e).__name__)
            if not reconnect:
                return None
            time.sleep(0.2)
            continue
        log("sock_connected")
        c.sendall((json.dumps({"tool": i.get("tool_name")}) + "\n").encode())
        data = b""
        while b"\n" not in data:
            chunk = c.recv(65536)
            if not chunk:
                break
            data += chunk
        if b"\n" in data:
            log("sock_reply")
            return json.loads(data.split(b"\n")[0])
        log("sock_eof", reconnect=reconnect)
        if not reconnect:
            return None
        time.sleep(0.2)
    log("deadline")
    return None


reply = {}
hold = rule.get("hold")
via = rule.get("via")
log("hold_start", hold=hold, via=via)
if via == "file":
    with open(P + "/pending.json", "w") as f:
        json.dump({"tool": i.get("tool_name")}, f)
    reply = hold_file(P + "/answer.json")
elif via in ("sock-reconnect", "sock-noreconnect"):
    reply = hold_socket(via == "sock-reconnect")
elif hold == "release":
    reply = hold_file(P + "/release")
elif hold == "forever":
    reply = hold_file(P + "/never")
elif isinstance(hold, (int, float)):
    time.sleep(hold)
log("hold_end", got_reply=reply is not None, held_s=round(time.time() - start, 2))

if reply is None:
    log("pass_no_output")
    sys.exit(0)
answers = reply.get("answers", rule.get("answers"))
behavior = reply.get("behavior", rule.get("behavior", "allow"))
if rule.get("no_output"):
    log("pass_no_output")
    sys.exit(0)

if ev == "PreToolUse":
    o = {"hookEventName": ev, "permissionDecision": behavior}
    if behavior == "allow" and answers is not None:
        o["updatedInput"] = {**i["tool_input"], "answers": answers}
    out = {"hookSpecificOutput": o}
else:
    d = {"behavior": behavior}
    if behavior == "allow" and answers is not None:
        d["updatedInput"] = {**i["tool_input"], "answers": answers}
    if behavior == "deny":
        d["message"] = rule.get("message", "denied by probe hook")
    out = {"hookSpecificOutput": {"hookEventName": ev, "decision": d}}
try:
    print(json.dumps(out), flush=True)
    log("output_written", out=out)
except BrokenPipeError:
    log("output_broken_pipe")
