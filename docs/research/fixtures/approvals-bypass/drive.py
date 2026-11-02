#!/usr/bin/env python3
"""Drives real Claude Code sessions through approval and question cases, claude-mux #161.

Usage: drive.py PROBE_DIR WORKER TRIAL CASE [CASE...] | drive.py PROBE_DIR 0 0 list

Each run is a fresh session on the private tmux socket probe161w<WORKER>, in a scratch
project under PROBE_DIR, with project-only settings, haiku and inherited CLAUDE* variables
removed. "by_" cases launch with --dangerously-skip-permissions, "df_" cases with
--permission-mode default. Evidence lands in PROBE_DIR/results/<case>/t<TRIAL>/.

Every tmux call goes through tm(), which always names the socket.
"""
import glob, json, os, shutil, signal, subprocess as s, sys, time

HERE = os.path.dirname(os.path.realpath(__file__))
P = os.path.realpath(sys.argv[1])
WORKER, TRIAL = sys.argv[2], sys.argv[3]
SOCKET = f"probe161w{WORKER}"
PROJ = f"{P}/proj{WORKER}"
TMUX = ["tmux", "-L", SOCKET]
HOLD = 2
TIMEOUT = 6
NOT_THERE = "/probe161-not-there"
HOOK_EVENTS = ("UserPromptSubmit", "PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse",
               "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
               "Elicitation", "ElicitationResult")
DIALOG_MARKS = ("Esc to cancel", "Enter to select", "to navigate", "Do you want", "Would you like", "Esc to dismiss",
                "Enter to submit", "Enter to confirm")
CASES = {}


def tm(*a):
    return s.run(TMUX + list(a), capture_output=True, text=True).stdout


def alive(pid):
    try:
        st = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0]
        return st != "Z" and "hook.py" in open(f"/proc/{pid}/cmdline").read()
    except OSError:
        return False


def dialog(scr):
    return any(m in scr for m in DIALOG_MARKS)


class C:
    def __init__(self, name, mode, rules, timeout=None, perms=None, mcp=False):
        self.name = name
        self.d = f"{P}/results/{name}/t{TRIAL}"
        shutil.rmtree(self.d, ignore_errors=True)
        os.makedirs(self.d)
        self.flags = {}
        json.dump(rules, open(self.d + "/case.json", "w"), indent=1)
        cmd = f"PROBE={self.d} python3 {HERE}/hook.py"
        hooks = {}
        for ev in HOOK_EVENTS:
            h = {"type": "command", "command": cmd}
            if timeout and ev in ("PreToolUse", "PermissionRequest"):
                h["timeout"] = timeout
            hooks[ev] = [{"hooks": [h]}]
        os.makedirs(PROJ + "/.claude", exist_ok=True)
        if not os.path.exists(PROJ + "/.git"):
            s.run(["git", "init", "-q", PROJ], check=True)
        settings = {"hooks": hooks, "plansDirectory": ".plans"}
        if perms:
            settings["permissions"] = perms
        json.dump(settings, open(PROJ + "/.claude/settings.json", "w"), indent=1)
        strip = " ".join("-u " + k for k in sorted(set(os.environ) | {
            "TMUX", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"}) if k == "TMUX" or k.startswith("CLAUDE"))
        launch = f"env {strip} claude --setting-sources project --strict-mcp-config --model haiku"
        if mode == "by":
            # Records acceptance of the bypass warning for this launch only, so the dialog that
            # would write to ~/.claude/settings.json never appears.
            launch += f" --dangerously-skip-permissions --settings {P}/flag-settings.json"
        else:
            launch += " --permission-mode default"
        if mcp:
            cfg = {"mcpServers": {"probe": {"command": "python3", "args": [HERE + "/mcp_probe.py"], "env": {"PROBE": self.d}}}}
            json.dump(cfg, open(self.d + "/mcp.json", "w"))
            launch += f" --mcp-config {self.d}/mcp.json"
        # A launch on a freshly started socket sometimes left an empty pane list; such a run sent
        # nothing and fired nothing, so start again instead of recording it.
        for _ in range(60):
            if not tm("list-sessions").strip():
                tm("new-session", "-d", "-s", "p", "-x", "140", "-y", "50", "-c", PROJ, launch)
                self.flags["launches"] = self.flags.get("launches", 0) + 1
            time.sleep(.5)
            c = self.cap()
            if "Yes, I accept" in c:
                tm("kill-session", "-t", "p")
                raise RuntimeError("bypass warning appeared; refusing to accept it")
            if "Yes, I trust" in c:
                # 2.1.316 lists "No, exit" first, with the cursor on it.
                tm("send-keys", "-t", "p", "Down")
                time.sleep(.3)
                tm("send-keys", "-t", "p", "Enter")
                time.sleep(1.5)
                continue
            if "shortcuts" in c or "for bypass" in c or "⏵" in c or "? for" in c:
                break
        time.sleep(1.5)
        self.snap("start")
        self.t0 = time.time()

    def cap(self, hist=False):
        return tm(*(["capture-pane", "-p", "-t", "p"] + (["-S", "-300"] if hist else [])))

    def snap(self, tag):
        txt = self.cap()
        open(f"{self.d}/screen-{tag}.txt", "w").write("\n".join(x.rstrip() for x in txt.splitlines()).strip() + "\n")
        self.flags[f"at_{tag}_s"] = round(time.time() - getattr(self, "t0", time.time()), 1)
        return txt

    def send(self, x):
        tm("send-keys", "-t", "p", "-l", x)
        time.sleep(.4)
        tm("send-keys", "-t", "p", "Enter")
        self.t0 = time.time()

    def keys(self, *k):
        for x in k:
            tm("send-keys", "-t", "p", x)
            time.sleep(.35)

    def evs(self):
        f = self.d + "/events.jsonl"
        return [json.loads(l) for l in open(f)] if os.path.exists(f) else []

    def wait(self, pred, to=60):
        t = time.time()
        while time.time() - t < to:
            r = [e for e in self.evs() if pred(e)]
            if r:
                return r[0]
            time.sleep(.1)
        return None

    def stopped(self):
        return any(e["kind"] == "fired" and e["ev"] == "Stop" and not e.get("agent_id") for e in self.evs())

    def wait_hold(self, ev, to=90):
        return self.wait(lambda e: e["kind"] == "hold_start" and e["ev"] == ev, to)

    def transcript(self):
        paths = {e.get("transcript_path") for e in self.evs()} - {None}
        out = {"tool_uses": [], "tool_results": [], "assistant_text": []}
        files = []
        for p in paths:
            if os.path.exists(p):
                files.append(p)
            files += glob.glob(p[:-6] + "/subagents/*.jsonl")
        for fp in files:
            for line in open(fp, errors="replace"):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                m = r.get("message") or {}
                if not isinstance(m.get("content"), list):
                    continue
                side = bool(r.get("isSidechain"))
                for b in m["content"]:
                    if b.get("type") == "tool_use":
                        out["tool_uses"].append({"name": b["name"], "sidechain": side, "input": b["input"]})
                    elif b.get("type") == "tool_result":
                        cont = b.get("content")
                        if isinstance(cont, list):
                            cont = " ".join(x.get("text", "") for x in cont if isinstance(x, dict))
                        out["tool_results"].append({"sidechain": side, "is_error": b.get("is_error", False), "content": str(cont)[:600]})
                    elif b.get("type") == "text" and r.get("type") == "assistant":
                        out["assistant_text"].append({"sidechain": side, "text": b["text"][:300]})
        return out

    def finish(self, **kw):
        time.sleep(1.2)
        self.snap("final")
        evs = self.evs()
        pids = sorted({e["pid"] for e in evs if e["kind"] == "hold_start"})
        res = {"case": self.name, "trial": TRIAL, "flags": self.flags, **kw,
               "hold_pids_alive_at_end": [p for p in pids if alive(p)],
               "hook_lifecycle": [{k: v for k, v in e.items() if k in ("kind", "ev", "sig", "held_s", "got_reply", "out")}
                                  for e in evs if e["kind"] != "fired"],
               "fired": [{k: e.get(k) for k in ("ev", "tool_name", "permission_mode", "agent_type", "agent_id", "notification_type",
                                                "tool_use_id", "tool_input", "tool_response", "payload_keys", "action", "content", "mcp_server_name", "mode")
                          if e.get(k) is not None}
                         for e in evs if e["kind"] == "fired" and e["ev"] != "UserPromptSubmit"],
               "transcript": self.transcript()}
        if os.path.exists(self.d + "/mcp.jsonl"):
            res["mcp"] = [json.loads(l) for l in open(self.d + "/mcp.jsonl") if "elicit_result" in l or "elicit_error" in l]
        json.dump(res, open(self.d + "/result.json", "w"), indent=1)
        tm("kill-session", "-t", "p")
        time.sleep(1)
        for pid in pids:
            if alive(pid):
                os.kill(pid, signal.SIGKILL)
        fired = [f["ev"] + (":" + f["tool_name"] if f.get("tool_name") else "") for f in res["fired"]]
        print(self.name, "t" + TRIAL, json.dumps({k: v for k, v in kw.items()})[:200], fired[:14], flush=True)


def scenario(name, prompt, rules=(), hold_ev=None, keys=None, during=False, stall=False, kill=False, timeout=None,
             perms=None, mcp=False, check=None, stop_to=70, chain_keys=None, until_sub=False, stuck_after=9):
    """Send a prompt, observe the hold if any, then answer a dialog with `keys` if one is shown.

    during: press keys while the hook holds, and release it afterwards.
    stall: the hook never returns on its own; wait for its timeout or kill it.
    chain_keys: keys for any dialog that shows after the first was answered.
    """
    mode = name.split("_")[0]
    c = C(name, mode, list(rules), timeout=timeout, perms=perms, mcp=mcp)
    f = {"mode": mode}
    c.send(prompt)
    pending = keys
    if hold_ev:
        h = c.wait_hold(hold_ev)
        f["held"] = bool(h)
        if h:
            time.sleep(.8)
            f["dialog_during_hold"] = dialog(c.snap("holding"))
            if kill:
                time.sleep(1)
                if alive(h["pid"]):
                    os.kill(h["pid"], signal.SIGKILL)
            if during:
                c.keys(*(pending or []))
                pending = None
                c.snap("after_person")
                f["hook_alive_after_person"] = alive(h["pid"])
                time.sleep(1)
                open(c.d + "/release", "w").close()
            else:
                t = time.time()
                while alive(h["pid"]) and time.time() - t < (timeout or HOLD) + 8:
                    time.sleep(.1)
                f["hook_ended_after_s"] = round(time.time() - t + .8, 1)
                if stall:
                    time.sleep(1.5)
                    f["dialog_after_hook_end"] = dialog(c.snap("after_hook_end"))
    t = time.time()
    dialog_since = None
    # With a background subagent the first Stop comes early, so wait for the agent itself.
    done = (lambda: any(e["kind"] == "fired" and e["ev"] == "SubagentStop" and e.get("agent_type") == "general-purpose" for e in c.evs())) if until_sub else c.stopped
    while time.time() - t < stop_to:
        if done():
            break
        scr = c.cap()
        if dialog(scr):
            if "dialog_seen" not in f:
                f["dialog_seen"] = True
                c.snap("dialog")
            dialog_since = dialog_since or time.time()
            if pending:
                time.sleep(.8)
                c.keys(*pending)
                pending, chain_keys, dialog_since = chain_keys, None, None
                f["keys_sent"] = True
                c.snap("after_keys")
                time.sleep(1)
            elif time.time() - dialog_since > stuck_after:
                f["dialog_stuck"] = True
                c.snap("stuck")
                break
        else:
            dialog_since = None
        time.sleep(.15)
    f.setdefault("dialog_seen", False)
    f["stop_fired"] = c.stopped()
    if check:
        f.update(check())
    c.finish(**f)


def case(name, *a, **kw):
    CASES[name] = lambda: scenario(name, *a, **kw)


def tag(name):
    return f"{name}_t{TRIAL}"


def exists(rel):
    return lambda: {"file_exists": os.path.exists(f"{PROJ}/{rel}")}


def opt(*labels):
    return [{"label": x, "description": x.lower() + " option"} for x in labels]


Q_SHAPE = {"question": "Pick a shape", "header": "Shape", "multiSelect": False, "options": opt("Square", "Circle")}
Q_COLORS = {"question": "Pick colors", "header": "Colors", "multiSelect": True, "options": opt("Red", "Green", "Blue")}
AUQ = ("Call the AskUserQuestion tool exactly once with this exact JSON input: " + json.dumps({"questions": [Q_SHAPE]}) +
       " After it returns, reply with one line starting with GOT: and the tool result verbatim. Use no other tool.")
AUQ2 = ("Call the AskUserQuestion tool exactly once with this exact JSON input: " + json.dumps({"questions": [Q_SHAPE, Q_COLORS]}) +
        " After it returns, reply with one line starting with GOT: and the tool result verbatim. Use no other tool.")
ANS = {"Pick a shape": "Square"}
PICK_CIRCLE = ["Down", "Enter"]


def bash_cmd(cmd):
    return f"Run this exact command with the Bash tool, then reply DONE whatever its result. Use no other tool: {cmd}"


def echo(name):
    return f"echo probe >> probe_{tag(name)}.txt"


def define():
    AR = {"ask": ["Bash(echo *)"]}
    PLAN = ("/plan Plan adding one file named notes_" + TRIAL + ".txt to this directory. Keep the plan to one line. "
            "Read nothing, ask nothing, then call ExitPlanMode.")
    RMDIR = bash_cmd(f"rmdir {NOT_THERE}")
    ELICIT = "Call the MCP tool elicit_probe from the server named probe exactly once, using ToolSearch to load it if needed. Then reply with GOT: and its result."
    CONFIRM = "Call the MCP tool confirm_probe from the server named probe exactly once, using ToolSearch to load it if needed. Then reply with GOT: and its result."
    MCPRI = "mcp__probe__confirm_probe"

    for m in ("by", "df"):
        # Bash
        n = f"{m}_bash_pass"
        case(n, bash_cmd(echo(n)), keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_bash_pre_hold_allow"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "hold": HOLD, "behavior": "allow"}], "PreToolUse", check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_bash_pre_hold_deny"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "hold": HOLD, "behavior": "deny", "message": "no from probe"}], "PreToolUse", check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_bash_pre_ask"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "behavior": "ask", "hold": 0}], keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_bash_pre_ask_pr_allow"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "behavior": "ask", "hold": 0},
                                    {"ev": "PermissionRequest", "tool": "Bash", "hold": HOLD, "behavior": "allow"}], "PermissionRequest", check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_bash_pre_stall"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "hold": "forever"}], "PreToolUse", stall=True, timeout=TIMEOUT, keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_bash_pre_kill"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "hold": "forever"}], "PreToolUse", stall=True, kill=True, keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
        # AskUserQuestion
        case(f"{m}_auq_pass", AUQ, keys=PICK_CIRCLE)
        case(f"{m}_auq_pre_answer", AUQ, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": HOLD, "answers": ANS}], "PreToolUse")
        case(f"{m}_auq_pre_allow_alone", AUQ, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "behavior": "allow", "hold": 0}], keys=PICK_CIRCLE)
        case(f"{m}_auq_pre_several_multi", AUQ2, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": HOLD,
                                                   "answers": {"Pick a shape": "Circle", "Pick colors": "Red, Blue"}}], "PreToolUse")
        case(f"{m}_auq_pre_stall", AUQ, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": "forever"}], "PreToolUse", stall=True, timeout=TIMEOUT, keys=PICK_CIRCLE)
        case(f"{m}_auq_pre_kill", AUQ, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": "forever"}], "PreToolUse", stall=True, kill=True, keys=PICK_CIRCLE)
        case(f"{m}_auq_pre_esc", AUQ, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": "release", "answers": ANS}], "PreToolUse", keys=["Escape"], during=True, stop_to=12)
        case(f"{m}_auq_pr_answer", AUQ, [{"ev": "PermissionRequest", "tool": "AskUserQuestion", "hold": HOLD, "answers": ANS}], "PermissionRequest")
        case(f"{m}_auq_pr_person", AUQ, [{"ev": "PermissionRequest", "tool": "AskUserQuestion", "hold": "release", "answers": ANS}], "PermissionRequest", keys=PICK_CIRCLE, during=True)
        case(f"{m}_auq_pr_deny", AUQ, [{"ev": "PermissionRequest", "tool": "AskUserQuestion", "hold": HOLD, "behavior": "deny", "message": "no from probe"}], "PermissionRequest")
        case(f"{m}_auq_pr_stall", AUQ, [{"ev": "PermissionRequest", "tool": "AskUserQuestion", "hold": "forever"}], "PermissionRequest", stall=True, timeout=TIMEOUT, keys=PICK_CIRCLE)
        # Ask rule
        n = f"{m}_askrule_pass"
        case(n, bash_cmd(echo(n)), perms=AR, keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_askrule_pr_allow"
        case(n, bash_cmd(echo(n)), [{"ev": "PermissionRequest", "tool": "Bash", "hold": HOLD, "behavior": "allow"}], "PermissionRequest", perms=AR, check=exists(f"probe_{tag(n)}.txt"))
        n = f"{m}_askrule_pre_allow"
        case(n, bash_cmd(echo(n)), [{"ev": "PreToolUse", "tool": "Bash", "behavior": "allow", "hold": 0}], perms=AR, keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
        # Protected paths
        n = f"{m}_protected_git_write"
        case(n, f"Use the Write tool to create the file .git/probe_{tag(n)}.txt containing the word probe, then reply DONE. Use no other tool.", keys=["Enter"], check=exists(f".git/probe_{tag(n)}.txt"))
        n = f"{m}_protected_claude_write"
        case(n, f"Use the Write tool to create the file .claude/probe_{tag(n)}.txt containing the word probe, then reply DONE. Use no other tool.", keys=["Enter"], check=exists(f".claude/probe_{tag(n)}.txt"))
        n = f"{m}_protected_vscode_bash"
        os.makedirs(PROJ + "/.vscode", exist_ok=True)
        case(n, bash_cmd(f"echo probe >> .vscode/probe_{tag(n)}.txt"), keys=["Enter"], check=exists(f".vscode/probe_{tag(n)}.txt"))
        # A critical-path rmdir, on a top-level directory that does not exist: it can only fail.
        case(f"{m}_critical_pass", RMDIR, keys=["Enter"])
        case(f"{m}_critical_pre_allow", RMDIR, [{"ev": "PreToolUse", "tool": "Bash", "behavior": "allow", "hold": 0}], keys=["Enter"])
        case(f"{m}_critical_pr_allow", RMDIR, [{"ev": "PermissionRequest", "tool": "Bash", "hold": HOLD, "behavior": "allow"}], "PermissionRequest")
        # Plan approval
        case(f"{m}_plan_pass", PLAN, keys=["Enter"])
        case(f"{m}_plan_pre_allow", PLAN, [{"ev": "PreToolUse", "tool": "ExitPlanMode", "behavior": "allow", "echo_input": True, "hold": 0}], keys=["Enter"])
        case(f"{m}_plan_pr_allow", PLAN, [{"ev": "PermissionRequest", "tool": "ExitPlanMode", "hold": HOLD, "behavior": "allow"}], "PermissionRequest")
        case(f"{m}_plan_pr_echo", PLAN, [{"ev": "PermissionRequest", "tool": "ExitPlanMode", "hold": HOLD, "behavior": "allow", "echo_input": True}], "PermissionRequest")
        # MCP form request
        typed = ["r", "e", "d", "Down", "Enter"]
        # In default mode the MCP call itself needs approval first; in bypass it does not.
        if m == "df":
            case(f"{m}_elicit_pass", ELICIT, mcp=True, keys=["Enter"], chain_keys=typed, stop_to=60)
            case(f"{m}_elicit_hook", ELICIT, [{"ev": "PermissionRequest", "tool": "mcp__probe__elicit_probe", "behavior": "allow", "hold": 0},
                                              {"ev": "Elicitation", "hold": HOLD, "action": "accept", "content": {"color": "red"}}], "Elicitation", mcp=True)
        else:
            case(f"{m}_elicit_pass", ELICIT, mcp=True, keys=typed, stop_to=60)
            case(f"{m}_elicit_hook", ELICIT, [{"ev": "Elicitation", "hold": HOLD, "action": "accept", "content": {"color": "red"}}], "Elicitation", mcp=True)
        # MCP tool marked requiresUserInteraction
        case(f"{m}_mcpri_pass", CONFIRM, mcp=True, keys=["Enter"])
        case(f"{m}_mcpri_pre_allow", CONFIRM, [{"ev": "PreToolUse", "tool": MCPRI, "behavior": "allow", "hold": 0}], mcp=True, keys=["Enter"])
        case(f"{m}_mcpri_pr_allow", CONFIRM, [{"ev": "PermissionRequest", "tool": MCPRI, "hold": HOLD, "behavior": "allow"}], "PermissionRequest", mcp=True)
        case(f"{m}_mcpri_pr_echo", CONFIRM, [{"ev": "PermissionRequest", "tool": MCPRI, "hold": HOLD, "behavior": "allow", "echo_input": True}], "PermissionRequest", mcp=True)
        # Fork and background subagent
        n = f"{m}_sub_bg_bash"
        case(n, f"Use the Agent tool with subagent_type general-purpose to run this exact Bash command, and wait for its report: {echo(n)}", keys=["Enter"], stop_to=90, until_sub=True, check=exists(f"probe_{tag(n)}.txt"))
        case(f"{m}_fork_auq_pass", "/subtask " + AUQ, keys=PICK_CIRCLE, stop_to=90)
        case(f"{m}_fork_auq_pre", "/subtask " + AUQ, [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": HOLD, "answers": ANS}], "PreToolUse", stop_to=90)
    # Default mode only: the bash cases where a person is at the dialog during a hold.
    n = "df_bash_pr_hold_allow"
    case(n, bash_cmd(echo(n)), [{"ev": "PermissionRequest", "tool": "Bash", "hold": HOLD, "behavior": "allow"}], "PermissionRequest", check=exists(f"probe_{tag(n)}.txt"))
    n = "df_bash_pr_person"
    case(n, bash_cmd(echo(n)), [{"ev": "PermissionRequest", "tool": "Bash", "hold": "release", "behavior": "deny"}], "PermissionRequest", keys=["Enter"], during=True, check=exists(f"probe_{tag(n)}.txt"))
    n = "df_bash_pr_stall"
    case(n, bash_cmd(echo(n)), [{"ev": "PermissionRequest", "tool": "Bash", "hold": "forever"}], "PermissionRequest", stall=True, timeout=TIMEOUT, keys=["Enter"], check=exists(f"probe_{tag(n)}.txt"))
    # Bypass only: the two-minute countdown on a critical-path dialog, and a hold past two minutes.
    case("by_critical_expire", RMDIR, stuck_after=140, stop_to=170)
    case("by_critical_pr_long", RMDIR, [{"ev": "PermissionRequest", "tool": "Bash", "hold": "forever"}], "PermissionRequest", stall=True, timeout=200, stop_to=60)
    case("by_auq_pr_long", AUQ, [{"ev": "PermissionRequest", "tool": "AskUserQuestion", "hold": 130, "answers": ANS}], "PermissionRequest", timeout=200)
    # Bypass only: a PermissionRequest rule on plain Bash, to show a hold on it never starts.
    n = "by_bash_pr_rule_waits"
    case(n, bash_cmd(echo(n)), [{"ev": "PermissionRequest", "tool": "Bash", "hold": 30, "behavior": "deny"}], check=exists(f"probe_{tag(n)}.txt"))


if __name__ == "__main__":
    os.makedirs(P, exist_ok=True)
    json.dump({"skipDangerousModePermissionPrompt": True}, open(P + "/flag-settings.json", "w"))
    os.makedirs(PROJ, exist_ok=True)
    assert not os.path.exists(NOT_THERE)
    define()
    names = sys.argv[4:]
    if names == ["list"]:
        print("\n".join(CASES))
        sys.exit(0)
    try:
        for n in names:
            print("RUN", n, "t" + TRIAL, flush=True)
            try:
                CASES[n]()
            except Exception as e:
                print(n, "ERROR", repr(e), flush=True)
                tm("kill-session", "-t", "p")
    finally:
        tm("kill-server")  # tm() names the socket: this ends only probe161w<WORKER>.
