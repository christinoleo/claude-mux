#!/usr/bin/env python3
"""Drives real Claude Code sessions through the dialog cases of claude-mux #157.

Usage: drive.py PROBE_DIR CASE [CASE...] | drive.py PROBE_DIR all | drive.py PROBE_DIR list

Each case gets a fresh session in a private tmux socket with project-only
settings, haiku, default permission mode and every inherited CLAUDE* variable
removed. Evidence lands in PROBE_DIR/results/<case>/: screens, events, result.json.
"""
import glob, json, os, shutil, signal, subprocess as s, sys, time

P = os.path.realpath(sys.argv[1])
PROJ = P + "/probe157-proj"
TMUX = ["tmux", "-L", "probe157"]
HOLD_TIMEOUT = 6
CASES = {}


def case(fn):
    CASES[fn.__name__] = fn
    return fn


def tm(*a):
    return s.run(TMUX + list(a), capture_output=True, text=True).stdout


def pstate(pid):
    """R/S/Z etc. from /proc, or None when the process is gone."""
    try:
        return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0]
    except OSError:
        return None


class C:
    def __init__(self, name, rules, timeout=None, agents=False, env=None):
        self.name, self.rules = name, rules
        self.d = f"{P}/results/{name}"
        shutil.rmtree(self.d, ignore_errors=True)
        os.makedirs(self.d)
        self.flags = {}
        self.procs = []
        json.dump(rules, open(self.d + "/case.json", "w"), indent=1)
        cmd = f"PROBE={self.d} python3 {P}/hook.py"
        hooks = {}
        for ev in ("UserPromptSubmit", "PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse",
                   "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop"):
            h = {"type": "command", "command": cmd}
            if timeout and ev in ("PreToolUse", "PermissionRequest"):
                h["timeout"] = timeout
            hooks[ev] = [{"hooks": [h]}]
        os.makedirs(PROJ + "/.claude/agents", exist_ok=True)
        json.dump({"hooks": hooks, **({"env": env} if env else {})}, open(PROJ + "/.claude/settings.json", "w"), indent=1)
        shutil.rmtree(PROJ + "/.claude/agents")
        os.makedirs(PROJ + "/.claude/agents")
        if agents:
            open(PROJ + "/.claude/agents/asker.md", "w").write(
                "---\nname: asker\ndescription: Probe agent that follows its prompt exactly.\n"
                "tools: AskUserQuestion, Bash\nmodel: haiku\n---\n"
                "Do exactly what the prompt says, using the tools it names. If a tool is unavailable, "
                "say so in your final reply and name the tools you do have.\n")
        strip = " ".join("-u " + k for k in os.environ if k.startswith("CLAUDE"))
        env = (f"env {strip} -u TMUX claude --setting-sources project --strict-mcp-config "
               "--model haiku --permission-mode default")
        tm("new-session", "-d", "-s", "p", "-x", "140", "-y", "50", "-c", PROJ, env)
        for _ in range(60):
            time.sleep(.5)
            c = self.cap()
            if "trust" in c.lower() and "Yes" in c:
                tm("send-keys", "-t", "p", "Enter")
                time.sleep(1)
            if "shortcuts" in c or "for bypass" in c or "⏵" in c:
                break
        time.sleep(1.5)
        self.t0 = time.time()

    def cap(self, hist=False):
        a = ["capture-pane", "-p", "-t", "p"] + (["-S", "-300"] if hist else [])
        return tm(*a)

    def snap(self, tag):
        txt = self.cap()
        open(f"{self.d}/screen-{tag}.txt", "w").write("\n".join(x.rstrip() for x in txt.splitlines()).strip() + "\n")
        self.flags[f"at_{tag}_s"] = round(time.time() - self.t0, 1)
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

    def wait_screen(self, needle, to=30):
        t = time.time()
        while time.time() - t < to:
            if needle in self.cap():
                return True
            time.sleep(.15)
        return False

    def wait_hold(self, ev, to=60):
        return self.wait(lambda e: e["kind"] == "hold_start" and e["ev"] == ev, to)

    def wait_stop(self, to=60):
        return self.wait(lambda e: e["kind"] == "fired" and e["ev"] == "Stop", to) is not None

    def release(self):
        open(self.d + "/release", "w").close()

    def holder(self, reply, *extra):
        p = s.Popen(["python3", P + "/holder.py", self.d, reply, *extra])
        self.procs.append(p)
        return p

    def transcript(self):
        paths = {e.get("transcript_path") for e in self.evs()} - {None}
        out = {"tool_uses": [], "tool_results": [], "assistant_text": [], "subagent_files": []}
        files = []
        for p in paths:
            if os.path.exists(p):
                files.append(p)
            sub = glob.glob(p[:-6] + "/subagents/*.jsonl")
            out["subagent_files"] += [os.path.basename(x) for x in sub]
            files += sub
        for fp in files:
            for line in open(fp, errors="replace"):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                m = r.get("message") or {}
                if isinstance(m.get("content"), str) or not isinstance(m.get("content"), list):
                    continue
                for b in m["content"]:
                    side = bool(r.get("isSidechain"))
                    if b.get("type") == "tool_use":
                        out["tool_uses"].append({"name": b["name"], "sidechain": side, "input": b["input"]})
                    elif b.get("type") == "tool_result":
                        cont = b.get("content")
                        if isinstance(cont, list):
                            cont = " ".join(x.get("text", "") for x in cont if isinstance(x, dict))
                        out["tool_results"].append({"sidechain": side, "is_error": b.get("is_error", False),
                                                    "content": str(cont)[:900]})
                    elif b.get("type") == "text" and r.get("type") == "assistant":
                        out["assistant_text"].append({"sidechain": side, "text": b["text"][:400]})
        return out

    def finish(self, **kw):
        time.sleep(1.5)
        self.snap("final")
        open(self.d + "/screen-scrollback.txt", "w").write(self.cap(True))
        for e in self.evs():
            e.pop("transcript_path", None)
        tr = self.transcript()
        evs = self.evs()
        pids = sorted({e["pid"] for e in evs if e["kind"] == "hold_start"})
        res = {"case": self.name, "flags": self.flags, **kw,
               "hold_pids_after": {p: pstate(p) for p in pids},
               "hook_lifecycle": [{k: v for k, v in e.items() if k in ("kind", "ev", "sig", "held_s", "got_reply", "reconnect", "err")}
                                  for e in evs if e["kind"] != "fired"],
               "fired": [[e["ev"], e.get("tool_name"), e.get("agent_type"), bool(e.get("agent_id")), e.get("notification_type")]
                         for e in evs if e["kind"] == "fired" and e["ev"] not in ("UserPromptSubmit",)],
               "transcript": tr}
        json.dump(res, open(self.d + "/result.json", "w"), indent=1)
        tm("kill-session", "-t", "p")
        for p in self.procs:
            p.kill()
        time.sleep(1)
        # Whatever the session did not clean up by itself dies here so no case leaks into the next.
        for pid in pids:
            if pstate(pid) not in (None, "Z"):
                res.setdefault("leaked_after_session_kill", []).append(pid)
                os.kill(pid, signal.SIGKILL)
        json.dump(res, open(self.d + "/result.json", "w"), indent=1)
        print(self.name, "DONE", json.dumps({k: v for k, v in res.items() if k not in ("transcript", "fired", "hook_lifecycle", "case")})[:600], flush=True)


# Prompts ---------------------------------------------------------------------

def opt(*labels):
    return [{"label": x, "description": x.lower() + " option"} for x in labels]


Q_COLORS = {"question": "Pick colors", "header": "Colors", "multiSelect": True, "options": opt("Red", "Green", "Blue")}
Q_SHAPE = {"question": "Pick a shape", "header": "Shape", "multiSelect": False, "options": opt("Square", "Circle")}
Q_SIZE = {"question": "Pick a size", "header": "Size", "multiSelect": False, "options": opt("Small", "Large")}


def ask(*qs):
    return ("Call the AskUserQuestion tool exactly once with this exact JSON input: " + json.dumps({"questions": list(qs)}) +
            " After it returns, reply with one line starting with GOT: and the tool result verbatim. Use no other tool.")


def bash(name):
    return f"Run this exact command with the Bash tool, then reply DONE: touch probe_{name}.txt"


def created(name):
    return os.path.exists(f"{PROJ}/probe_{name}.txt")


def answer_case(name, ev, answers, qs, **rule):
    c = C(name, [{"ev": ev, "tool": "AskUserQuestion", "answers": answers, **rule}])
    c.send(ask(*qs))
    c.wait_hold(ev)
    time.sleep(.7)
    scr = c.snap("during")
    c.wait_stop()
    c.finish(dialog_during="Enter to" in scr or "Esc to" in scr)


# 1. Multi-select --------------------------------------------------------------
@case
def multi_commas():
    answer_case("multi_commas", "PreToolUse", {"Pick colors": "Red,Blue"}, [Q_COLORS])


@case
def multi_comma_space():
    answer_case("multi_comma_space", "PreToolUse", {"Pick colors": "Red, Blue"}, [Q_COLORS])


@case
def multi_array():
    answer_case("multi_array", "PreToolUse", {"Pick colors": ["Red", "Blue"]}, [Q_COLORS])


@case
def multi_keys():
    """A person's multi-select by keyboard, as the reference for the form hooks should send."""
    c = C("multi_keys", [])
    c.send(ask(Q_COLORS))
    c.wait_screen("Pick colors", 30)
    c.wait_screen("to navigate", 30)
    c.snap("open")
    c.keys("Enter")
    c.snap("first_toggled")
    c.keys("Down", "Down", "Enter")
    c.snap("third_toggled")
    c.keys("Down", "Down")
    c.snap("on_submit")
    c.keys("Enter")
    time.sleep(1)
    scr = c.snap("after_submit")
    if "Submit answers" in scr or "Review" in scr:
        c.keys("Enter")
    c.wait_stop(30)
    post = [e for e in c.evs() if e["kind"] == "fired" and e["ev"] == "PostToolUse"]
    c.finish(tool_input_answers=post[0]["tool_input"].get("answers") if post else None)


# 2. Several questions ---------------------------------------------------------
@case
def several_full():
    answer_case("several_full", "PreToolUse",
                {"Pick a shape": "Circle", "Pick colors": "Green,Blue", "Pick a size": "free text size"},
                [Q_SHAPE, Q_COLORS, Q_SIZE])


@case
def several_partial():
    answer_case("several_partial", "PreToolUse", {"Pick a shape": "Circle"}, [Q_SHAPE, Q_SIZE])


@case
def several_wrong_key():
    answer_case("several_wrong_key", "PreToolUse", {"Shape": "Circle", "Size": "Large"}, [Q_SHAPE, Q_SIZE])


# 3. Through PermissionRequest -------------------------------------------------
@case
def pr_answer():
    answer_case("pr_answer", "PermissionRequest", {"Pick a shape": "Circle"}, [Q_SHAPE], hold=2)


@case
def pr_several_multi():
    answer_case("pr_several_multi", "PermissionRequest", {"Pick a shape": "Square", "Pick colors": "Red,Green"},
                [Q_SHAPE, Q_COLORS], hold=2)


def pr_outcome(name, **rule):
    c = C(name, [{"ev": "PermissionRequest", "tool": "AskUserQuestion", **rule}])
    c.send(ask(Q_SHAPE))
    c.wait_hold("PermissionRequest")
    time.sleep(.6)
    c.snap("during")
    c.wait(lambda e: e["kind"] == "output_written", 8)
    time.sleep(2)
    scr = c.snap("after_hook")
    still = "Enter to" in scr or "Esc to" in scr
    if still:
        c.keys("Down", "Enter")
    c.wait_stop(40)
    c.finish(dialog_left_after_hook=still)


@case
def pr_allow_no_input():
    pr_outcome("pr_allow_no_input", hold=1)


@case
def pr_deny():
    pr_outcome("pr_deny", hold=1, behavior="deny", message="The operator declined this question.")


# 4. A person answers in the terminal while a hook holds -----------------------
@case
def hold_pre_auq_keys():
    c = C("hold_pre_auq_keys", [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": "release", "answers": {"Pick a shape": "Square"}}])
    c.send(ask(Q_SHAPE))
    c.wait_hold("PreToolUse")
    time.sleep(2)
    c.snap("holding")
    c.keys("Down", "Enter")
    time.sleep(2)
    scr = c.snap("after_keys")
    time.sleep(1)
    c.release()
    c.wait_stop(40)
    c.finish(hook_answered="Square", dialog_during="Enter to" in scr or "Esc to" in scr)


@case
def hold_pre_auq_text():
    c = C("hold_pre_auq_text", [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": "release", "answers": {"Pick a shape": "Square"}}])
    c.send(ask(Q_SHAPE))
    c.wait_hold("PreToolUse")
    time.sleep(2)
    tm("send-keys", "-t", "p", "-l", "Reply only with TYPED")
    time.sleep(.3)
    tm("send-keys", "-t", "p", "Enter")
    time.sleep(2)
    c.snap("after_typing")
    c.release()
    c.wait_stop(40)
    time.sleep(8)
    c.snap("later")
    c.finish()


@case
def hold_pre_auq_esc():
    c = C("hold_pre_auq_esc", [{"ev": "PreToolUse", "tool": "AskUserQuestion", "hold": "release", "answers": {"Pick a shape": "Square"}}])
    c.send(ask(Q_SHAPE))
    c.wait_hold("PreToolUse")
    time.sleep(2)
    c.snap("holding")
    c.keys("Escape")
    time.sleep(2.5)
    c.snap("after_esc")
    pids = {e["pid"]: pstate(e["pid"]) for e in c.evs() if e["kind"] == "hold_start"}
    c.release()
    time.sleep(3)
    c.snap("after_release")
    c.finish(hook_state_after_esc=pids)


def hold_pr(name, tool, prompt, keys, rule_extra=None):
    rule = {"ev": "PermissionRequest", "tool": tool, "hold": "release", **(rule_extra or {})}
    c = C(name, [rule])
    c.send(prompt)
    c.wait_hold("PermissionRequest")
    time.sleep(1.5)
    scr = c.snap("holding")
    dialog = "Enter to" in scr or "Esc to" in scr or "Do you want" in scr
    pid = c.wait_hold("PermissionRequest")["pid"]
    c.keys(*keys)
    time.sleep(2.5)
    state = pstate(pid)
    c.snap("after_person")
    # A hook still alive now tries to answer the other way. Claude Code must ignore it.
    c.release()
    c.wait_stop(30)
    return c, dict(dialog_during_hold=dialog, hook_state_after_person=state)


@case
def hold_pr_auq_person():
    c, f = hold_pr("hold_pr_auq_person", "AskUserQuestion", ask(Q_SHAPE), ["Down", "Enter"], {"answers": {"Pick a shape": "Square"}})
    c.finish(person_answered="Circle", hook_tried="Square", **f)


@case
def hold_pr_bash_yes():
    c, f = hold_pr("hold_pr_bash_yes", "Bash", bash("hold_pr_bash_yes"), ["Enter"], {"behavior": "deny"})
    c.finish(created=created("hold_pr_bash_yes"), hook_tried="deny", **f)


@case
def hold_pr_bash_no():
    c, f = hold_pr("hold_pr_bash_no", "Bash", bash("hold_pr_bash_no"), ["Escape"], {"behavior": "allow"})
    c.finish(created=created("hold_pr_bash_no"), hook_tried="allow", **f)


@case
def hold_pr_bash_no_select():
    c, f = hold_pr("hold_pr_bash_no_select", "Bash", bash("hold_pr_bash_no_select"), ["Down", "Down", "Down", "Enter"], {"behavior": "allow"})
    c.finish(created=created("hold_pr_bash_no_select"), hook_tried="allow", **f)


@case
def hold_pr_auq_esc():
    c, f = hold_pr("hold_pr_auq_esc", "AskUserQuestion", ask(Q_SHAPE), ["Escape"], {"answers": {"Pick a shape": "Square"}})
    c.finish(hook_tried="Square", **f)


def leftover(name, tool, prompt, keys, timeout=None):
    """A person answers while the hook holds, and the hook is never released. How long does it live?"""
    c = C(name, [{"ev": "PermissionRequest", "tool": tool, "hold": "forever"}], timeout=timeout)
    c.send(prompt)
    pid = c.wait_hold("PermissionRequest")["pid"]
    time.sleep(1.5)
    c.keys(*keys)
    t_person = time.time()
    states = {}
    c.wait_stop(40)
    states["at_stop"] = [round(time.time() - t_person, 1), pstate(pid)]
    for label, until in (("plus_5s", 5), ("plus_15s", 15), ("plus_25s", 25)):
        while time.time() - t_person < until:
            time.sleep(.2)
        states[label] = [round(time.time() - t_person, 1), pstate(pid)]
    stops = sum(e["kind"] == "fired" and e["ev"] == "Stop" for e in c.evs())
    c.send("Reply only with NEXT")
    t = time.time()
    while time.time() - t < 30 and sum(e["kind"] == "fired" and e["ev"] == "Stop" for e in c.evs()) <= stops:
        time.sleep(.2)
    states["after_next_turn"] = [round(time.time() - t_person, 1), pstate(pid)]
    c.send("/exit")
    time.sleep(4)
    states["after_exit"] = [round(time.time() - t_person, 1), pstate(pid)]
    post = [e for e in c.evs() if e["kind"] == "fired" and e["ev"] == "PostToolUse"]
    alive_at_post = not any(e["kind"] == "signal" and post and e["t"] < post[0]["t"] for e in c.evs())
    return c, dict(states=states, post_tool_use_fired=bool(post), alive_at_post=alive_at_post, timeout=timeout)


@case
def leftover_bash():
    c, f = leftover("leftover_bash", "Bash", bash("leftover_bash"), ["Enter"])
    c.finish(created=created("leftover_bash"), **f)


@case
def leftover_auq():
    c, f = leftover("leftover_auq", "AskUserQuestion", ask(Q_SHAPE), ["Down", "Enter"])
    c.finish(**f)


@case
def leftover_bash_timeout():
    c, f = leftover("leftover_bash_timeout", "Bash", bash("leftover_bash_timeout"), ["Enter"], timeout=12)
    c.finish(created=created("leftover_bash_timeout"), **f)


# 5. Hook timeout and killed hook ----------------------------------------------
def stall(name, ev, tool, how, prompt, keys, proof=None):
    c = C(name, [{"ev": ev, "tool": tool, "hold": "forever"}], timeout=HOLD_TIMEOUT if how == "timeout" else None)
    c.send(prompt)
    h = c.wait_hold(ev)
    t_hold = time.time()
    time.sleep(2)
    c.snap("stalled")
    if how == "kill":
        os.kill(h["pid"], signal.SIGKILL)
        time.sleep(2.5)
    else:
        time.sleep(HOLD_TIMEOUT + 1.5)
    state = pstate(h["pid"])
    scr = c.snap("after_" + how)
    dialog = "Enter to" in scr or "Esc to" in scr or "Do you want" in scr
    c.keys(*keys)
    c.wait_stop(40)
    extra = {"created": created(name)} if proof else {}
    c.finish(hook_state_after=state, dialog_after=dialog, stall_elapsed_s=round(time.time() - t_hold, 1), keys_sent=keys, **extra)


# Timeout and kill cases are generated: event x tool x how.
for _how in ("timeout", "kill"):
    for _ev, _tool, _short in (("PreToolUse", "AskUserQuestion", "pre_auq"), ("PermissionRequest", "AskUserQuestion", "pr_auq"),
                               ("PreToolUse", "Bash", "pre_bash"), ("PermissionRequest", "Bash", "pr_bash")):
        _n = f"{_how}_{_short}"

        def _mk(n=_n, ev=_ev, tool=_tool, how=_how):
            is_bash = tool == "Bash"
            stall(n, ev, tool, how, bash(n) if is_bash else ask(Q_SHAPE), ["Enter"] if is_bash else ["Down", "Enter"], proof=is_bash)
        CASES[_n] = _mk


# 6. A held hook and a dashboard restart ----------------------------------------
ANS = json.dumps({"answers": {"Pick a shape": "Circle"}})


def restart_case(name, ev, tool, via, prompt, reply, restart=True, keys=()):
    c = C(name, [{"ev": ev, "tool": tool, "via": via}])
    silent_args = ("--file",) if via == "file" else ()
    h1 = c.holder("silent", *silent_args)
    time.sleep(.3)
    c.send(prompt)
    c.wait_hold(ev)
    time.sleep(1.5)
    c.snap("holding")
    h1.kill()
    h1.wait()
    killed_at = time.time()
    time.sleep(6)
    c.snap("holder_dead")
    flags = {"holder_down_s": 6}
    scr = c.snap("before_answer")
    flags["dialog_with_holder_down"] = "Enter to" in scr or "Esc to" in scr or "Do you want" in scr
    if restart:
        c.holder(reply, *silent_args)
    if keys:
        c.keys(*keys)
    c.wait_stop(40)
    flags["recovered_after_s"] = round(time.time() - killed_at, 1)
    if tool == "Bash":
        flags["created"] = created(name)
    c.finish(**flags)


@case
def restart_file_auq():
    restart_case("restart_file_auq", "PreToolUse", "AskUserQuestion", "file", ask(Q_SHAPE), ANS)


@case
def restart_sock_reconnect_auq():
    restart_case("restart_sock_reconnect_auq", "PreToolUse", "AskUserQuestion", "sock-reconnect", ask(Q_SHAPE), ANS)


@case
def restart_sock_giveup_auq():
    restart_case("restart_sock_giveup_auq", "PreToolUse", "AskUserQuestion", "sock-noreconnect", ask(Q_SHAPE), ANS, restart=False, keys=["Down", "Enter"])


@case
def restart_file_bash():
    restart_case("restart_file_bash", "PermissionRequest", "Bash", "file", bash("restart_file_bash"), json.dumps({"behavior": "allow"}))


@case
def restart_sock_reconnect_bash():
    restart_case("restart_sock_reconnect_bash", "PermissionRequest", "Bash", "sock-reconnect", bash("restart_sock_reconnect_bash"), json.dumps({"behavior": "allow"}))


@case
def restart_sock_giveup_bash():
    restart_case("restart_sock_giveup_bash", "PermissionRequest", "Bash", "sock-noreconnect", bash("restart_sock_giveup_bash"), "", restart=False, keys=["Enter"])


# 7. Subagents -------------------------------------------------------------------
# With fork mode on (the default) every subagent starts in the background, so a real
# foreground subagent needs CLAUDE_CODE_FORK_SUBAGENT=0, set through project settings.
FG_ENV = {"CLAUDE_CODE_FORK_SUBAGENT": "0"}


def spawn(sub_type, task, foreground):
    if sub_type == "fork":
        return "/subtask " + task  # A real fork. An Agent call with no type runs general-purpose instead.
    how = "Pass run_in_background: false and wait for it to finish. " if foreground else ""
    return (f'Call the Agent tool exactly once with subagent_type "{sub_type}" and description "probe". {how}'
            f"Give it this prompt word for word: <<{task}>> "
            "Do not call any other tool yourself. When the subagent has finished, reply with one line starting with SUB: and what it reported.")


SUB_Q = ("Call the AskUserQuestion tool exactly once with question \"Pick a shape\", header \"Shape\", multiSelect false, "
         "options Square and Circle. Report what it returned verbatim. If you do not have that tool, say NO_TOOL and list the tools you do have.")


def sub_bash(name):
    return f"Run this exact command with the Bash tool: touch probe_{name}.txt . Report exactly what happened, including any permission error."


def sub_case(name, sub_type, task, rules, foreground=False, keys_on=None, keys=(), release=False):
    c = C(name, rules, agents=sub_type == "asker", env=FG_ENV if foreground else None)
    c.send(spawn(sub_type, task, foreground))
    f = {"foreground_requested": foreground}
    if keys_on:
        got = c.wait(lambda e: e["kind"] == "fired" and e["ev"] == keys_on[0] and e.get("tool_name") == keys_on[1], 60)
        f["trigger_fired"] = got is not None
        if got:
            time.sleep(1.5)
            scr = c.snap("dialog")
            f["dialog_visible"] = any(n in scr for n in ("Enter to", "Esc to", "Do you want"))
            f["trigger_agent_id"] = bool(got.get("agent_id"))
            c.keys(*keys)
            time.sleep(2.5)
            holds = [e for e in c.evs() if e["kind"] == "hold_start"]
            if holds:
                f["hook_state_after_person"] = pstate(holds[0]["pid"])
            c.snap("after_keys")
            if release:
                c.release()
    elif any("hold" in r for r in rules):
        h = c.wait(lambda e: e["kind"] == "hold_start", 60)
        f["hold_fired"] = h is not None
        time.sleep(.8)
        scr = c.snap("during")
        f["dialog_visible"] = any(n in scr for n in ("Enter to", "Esc to", "Do you want"))
    else:
        c.wait(lambda e: e["kind"] == "fired" and e["ev"] in ("PreToolUse", "PermissionRequest") and e.get("agent_id"), 40)
        time.sleep(1.5)
        c.snap("during")
    stop = c.wait(lambda e: e["kind"] == "fired" and e["ev"] == "SubagentStop" and (e.get("agent_type") or sub_type == "fork"), 60)
    f["subagent_stop_type"] = stop.get("agent_type") if stop else None
    if sub_type == "fork":
        time.sleep(8)  # A fork reports back without the main session having to answer first.
    else:
        c.wait_stop(45)
    time.sleep(4)
    if "bash" in name:
        f["created"] = created(name)
    post = [e for e in c.evs() if e["kind"] == "fired" and e["ev"] == "PostToolUse" and e.get("tool_name") == "Agent"]
    if post:
        resp = post[0].get("tool_response") or {}
        f["agent_status"] = resp.get("status") if isinstance(resp, dict) else str(resp)[:80]
    c.finish(**f)


ANS_RULE = {"ev": "PreToolUse", "tool": "AskUserQuestion", "answers": {"Pick a shape": "Circle"}}
PR_ANS = {"ev": "PermissionRequest", "tool": "AskUserQuestion", "hold": 1, "answers": {"Pick a shape": "Circle"}}
PR_ALLOW = {"ev": "PermissionRequest", "tool": "Bash", "behavior": "allow", "hold": 2}
PR_HOLD = {"ev": "PermissionRequest", "tool": "Bash", "behavior": "deny", "hold": "release"}


def status_of(name):
    return json.load(open(f"{P}/results/{name}/result.json")).get("agent_status")


def with_retry(name, run, foreground):
    """The model picks run_in_background. A foreground case only counts if the Agent call really waited."""
    for attempt in range(3):
        if os.path.exists(f"{PROJ}/probe_{name}.txt"):
            os.remove(f"{PROJ}/probe_{name}.txt")
        run()
        if not foreground or status_of(name) == "completed":
            return
        print(name, "not foreground, attempt", attempt + 1, flush=True)
    print(name, "NEVER FOREGROUND", flush=True)


def _sub(name, *a, **k):
    CASES[name] = lambda: with_retry(name, lambda: sub_case(name, *a, **k), k.get("foreground", False))


def sub_stall(name, foreground, how):
    c = C(name, [{"ev": "PermissionRequest", "tool": "Bash", "hold": "forever"}], agents=True,
          timeout=HOLD_TIMEOUT if how == "timeout" else None, env=FG_ENV if foreground else None)
    c.send(spawn("asker", sub_bash(name), foreground))
    h = c.wait_hold("PermissionRequest")
    time.sleep(1.5)
    scr = c.snap("stalled")
    needles = ("Enter to", "Esc to", "Do you want")
    f = {"foreground_requested": foreground, "dialog_during_hold": any(n in scr for n in needles)}
    if how == "kill":
        os.kill(h["pid"], signal.SIGKILL)
        time.sleep(2.5)
    else:
        time.sleep(HOLD_TIMEOUT + 1.5)
    f["hook_state_after"] = pstate(h["pid"])
    scr = c.snap("after_" + how)
    f["dialog_after"] = any(n in scr for n in needles)
    c.keys("Enter")
    c.wait(lambda e: e["kind"] == "fired" and e["ev"] == "SubagentStop" and e.get("agent_type"), 40)
    c.wait_stop(45)
    time.sleep(4)
    f["created"] = created(name)
    post = [e for e in c.evs() if e["kind"] == "fired" and e["ev"] == "PostToolUse" and e.get("tool_name") == "Agent"]
    if post:
        f["agent_status"] = (post[0].get("tool_response") or {}).get("status")
    c.finish(**f)


KEY_AUQ = dict(keys_on=("PreToolUse", "AskUserQuestion"), keys=["Down", "Enter"])
for _fg, _p in ((False, "bg"), (True, "fg")):
    _sub(f"sub_{_p}_gp_auq_pass", "general-purpose", SUB_Q, [], foreground=_fg, **KEY_AUQ)
    _sub(f"sub_{_p}_gp_auq_answer", "general-purpose", SUB_Q, [ANS_RULE], foreground=_fg)
    _sub(f"sub_{_p}_custom_auq_pass", "asker", SUB_Q, [], foreground=_fg, **KEY_AUQ)
    _sub(f"sub_{_p}_custom_auq_answer", "asker", SUB_Q, [ANS_RULE], foreground=_fg)
    _sub(f"sub_{_p}_custom_auq_pr", "asker", SUB_Q, [PR_ANS], foreground=_fg)
    _sub(f"sub_{_p}_bash_pr_allow", "asker", sub_bash(f"sub_{_p}_bash_pr_allow"), [PR_ALLOW], foreground=_fg)
    _sub(f"sub_{_p}_bash_keys", "asker", sub_bash(f"sub_{_p}_bash_keys"), [], foreground=_fg,
         keys_on=("PermissionRequest", "Bash"), keys=["Enter"])
    _sub(f"sub_{_p}_bash_hold_person", "asker", sub_bash(f"sub_{_p}_bash_hold_person"), [PR_HOLD], foreground=_fg,
         keys_on=("PermissionRequest", "Bash"), keys=["Enter"], release=True)
    _sub(f"sub_{_p}_bash_esc", "asker", sub_bash(f"sub_{_p}_bash_esc"), [], foreground=_fg,
         keys_on=("PermissionRequest", "Bash"), keys=["Escape"])

    for _how in ("timeout", "kill"):
        _n = f"sub_{_p}_bash_{_how}"
        CASES[_n] = (lambda n=_n, fg=_fg, how=_how: with_retry(n, lambda: sub_stall(n, fg, how), fg))

_sub("sub_fork_auq_pass", "fork", SUB_Q, [], **KEY_AUQ)
_sub("sub_fork_auq_answer", "fork", SUB_Q, [ANS_RULE])
_sub("sub_fork_auq_pr", "fork", SUB_Q, [PR_ANS])
_sub("sub_fork_bash_pr_allow", "fork", sub_bash("sub_fork_bash_pr_allow"), [PR_ALLOW])
_sub("sub_fork_bash_keys", "fork", sub_bash("sub_fork_bash_keys"), [], keys_on=("PermissionRequest", "Bash"), keys=["Enter"])


@case
def leftover_bash_default_timeout():
    """How long a hook left behind lives with no timeout set: the documented default is 600s."""
    c = C("leftover_bash_default_timeout", [{"ev": "PermissionRequest", "tool": "Bash", "hold": "forever", "deadline": 720}])
    c.send(bash("leftover_bash_default_timeout"))
    h = c.wait_hold("PermissionRequest")
    t_start = time.time()
    time.sleep(1.5)
    c.keys("Enter")
    c.wait_stop(40)
    pid, died_at = h["pid"], None
    while time.time() - t_start < 700:
        if pstate(pid) in (None, "Z"):
            died_at = round(time.time() - t_start, 1)
            break
        time.sleep(1)
    c.finish(created=created("leftover_bash_default_timeout"), hook_died_after_s=died_at)


if __name__ == "__main__":
    names = sys.argv[2:]
    if names == ["list"]:
        print("\n".join(CASES))
        sys.exit(0)
    if names == ["all"]:
        names = list(CASES)
    try:
        for n in names:
            print("RUN", n, flush=True)
            try:
                CASES[n]()
            except Exception as e:
                print(n, "ERROR", repr(e), flush=True)
                tm("kill-session", "-t", "p")
    finally:
        tm("kill-server")
