#!/usr/bin/env python3
"""Live scenarios for docs/research/run-end.md, on a private tmux socket.

usage: drive.py <base dir> <mux-hook.mjs> <maestro-stopgate.sh> <scenario> [...]
Each scenario is hard-bounded. Results land in <base>/runs/<name>/summary.json.
Uses `tmux -L probe165`, `--setting-sources project`, `--model haiku`, and strips
inherited CLAUDE*/MAESTRO*/TMUX variables. Never touches the default tmux server.
"""
import glob, json, os, shlex, shutil, subprocess as s, sys, threading, time

BASE, MUX_HOOK, GATE = map(os.path.realpath, sys.argv[1:4])
SOCK = "probe165"
PROJ = BASE + "/main-probe165-proj"
TRUST_PROJ = BASE + "/trust-probe165-proj"
MUX_HOME = BASE + "/mux-home"
SESS = MUX_HOME + "/.claude-mux/sessions"
TOOLS = os.path.dirname(os.path.realpath(__file__))
ENV = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "MAESTRO", "TMUX"))}
ENV["PROBE"] = BASE


def tm(*a):
    return s.run(["tmux", "-L", SOCK, *a], capture_output=True, text=True, env=ENV)


def alive(n):
    return tm("has-session", "-t", "=" + n).returncode == 0


def cap(n):
    return tm("capture-pane", "-p", "-t", f"={n}:", "-S", "-200").stdout


def write_settings(proj, gate_real=False):
    os.makedirs(proj + "/.claude", exist_ok=True)
    open(proj + "/long-job.sh", "w").write('#!/bin/sh\nsleep "$1"\n')
    os.chmod(proj + "/long-job.sh", 0o755)
    log = f"PROBE={BASE} python3 -I {TOOLS}/hook.py"
    mux = lambda e: f"HOME={MUX_HOME} node {MUX_HOOK} {e}"
    h = lambda *cmds: [{"type": "command", "command": c} for c in cmds]
    hooks = {
        "SessionStart": [{"hooks": h(log, mux("session-start"))}],
        "UserPromptSubmit": [{"hooks": h(log, mux("user-prompt-submit"))}],
        "Stop": [{"hooks": h(log, mux("stop"))}],
        "StopFailure": [{"hooks": h(log)}],
        "PermissionRequest": [{"hooks": h(log, mux("permission-request"))}],
        "Notification": [
            {"hooks": h(log)},
            {"matcher": "idle_prompt", "hooks": h(mux("notification-idle"))},
            {"matcher": "permission_prompt", "hooks": h(mux("notification-permission"))},
            {"matcher": "elicitation_dialog", "hooks": h(mux("notification-elicitation"))},
        ],
        "PreToolUse": [{"hooks": h(log, mux("pre-tool-use"))}],
        "PostToolUse": [{"hooks": h(log, mux("post-tool-use"))}],
        "PostToolUseFailure": [{"hooks": h(log, mux("post-tool-use-failure"))}],
        "SessionEnd": [{"hooks": h(log, mux("session-end"))}],
    }
    if gate_real:
        hooks["Stop"][0]["hooks"] = h(log, mux("stop"), f"GH_STUB_DIR={BASE}/ghstub PATH={BASE}/ghstub:$PATH bash {GATE}")
    json.dump({"hooks": hooks, "permissions": {"allow": ["Bash(touch run-done)", "Bash(sleep *)", "Bash(./long-job.sh *)"]}},
              open(proj + "/.claude/settings.json", "w"), indent=1)


def sleeps(*nums):
    r = {}
    for n in nums:
        p = s.run(["pgrep", "-fx", f"sleep {n}"], capture_output=True, text=True).stdout.split()
        r[str(n)] = len(p)
    return r


def reap_sleeps(*nums):
    for n in nums:
        s.run(["pkill", "-fx", f"sleep {n}"])


class Run:
    def __init__(self, name, prompt, ctl=None, flags="--permission-mode default", wrap="", env="", proj=PROJ, model="haiku"):
        self.name, self.dir = name, f"{BASE}/runs/{name}"
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        shutil.rmtree(SESS, ignore_errors=True)
        os.makedirs(SESS)
        for f in ("run-done", "blocked-file"):
            try:
                os.remove(f"{proj}/{f}")
            except FileNotFoundError:
                pass
        c = dict(ctl or {}, run=name)
        json.dump(c, open(BASE + "/ctl.json", "w"))
        self.ctl, self.proj = c, proj
        self.rcf = self.dir + "/rc"
        strip = " ".join(f"-u {k}" for k in os.environ if k.startswith(("CLAUDE", "MAESTRO")))
        q = shlex.quote(prompt) if prompt else ""
        cmd = f"env {strip} {env} {wrap} claude --setting-sources project --model {model} {flags} {q}; echo $? > {self.rcf}"
        self.cmd = cmd
        self.t0 = time.time()
        r = tm("new-session", "-d", "-s", name, "-x", "140", "-y", "50", "-c", proj, cmd)
        assert r.returncode == 0, r.stderr
        self.timeline, self.stop_flag, self.pane_gone, self.last = [], False, None, None
        self.th = threading.Thread(target=self._sample, daemon=True)
        self.th.start()
        if proj == PROJ:
            self.trust_if_shown(4)

    def rel(self):
        return round(time.time() - self.t0, 2)

    def _sample(self):
        while not self.stop_flag:
            cur = []
            for f in glob.glob(SESS + "/*.json"):
                try:
                    d = json.load(open(f))
                    cur.append({k: d.get(k) for k in ("state", "current_action", "maestro_role", "maestro_issue")} |
                               {"pid": d.get("pid"), "done": bool(d.get("turn_completed_at")), "tmux": d.get("tmux_target")})
                except Exception:
                    pass
            if cur != self.last:
                self.timeline.append([self.rel(), cur])
                self.last = cur
            if self.pane_gone is None and not alive(self.name):
                self.pane_gone = self.rel()
            time.sleep(0.15)

    def events(self):
        f = self.dir + "/events.jsonl"
        return [json.loads(l) for l in open(f)] if os.path.exists(f) else []

    def count(self, ev):
        return sum(e["ev"] == ev for e in self.events())

    def wait(self, pred, to):
        t = time.time()
        while time.time() - t < to:
            if pred():
                return True
            time.sleep(0.15)
        return False

    def wait_stop(self, n=1, to=60):
        return self.wait(lambda: self.count("Stop") >= n, to)

    def snap(self, label):
        open(f"{self.dir}/screen-{label}.txt", "w").write(cap(self.name))

    def trust_if_shown(self, to=8):
        if getattr(self, "trust_answer", None):
            return True
        def seen():
            c = cap(self.name)
            return "trust" in c.lower() and "Yes" in c
        if self.wait(seen, to):
            # With pre-approved tools the cursor starts on "No, continue without
            # these permissions", so a bare Enter does not grant them.
            if "❯ No" in cap(self.name):
                self.snap("trust-default")
                for _ in range(10):
                    tm("send-keys", "-t", f"={self.name}:", "Down")
                    if self.wait(lambda: "❯ Yes" in cap(self.name), 1):
                        break
            self.snap("trust")
            self.trust_answer = "Yes" if "❯ Yes" in cap(self.name) else "No"
            tm("send-keys", "-t", f"={self.name}:", "Enter")
            return True
        return False

    def finish(self, grace=4, **extra):
        time.sleep(grace)
        self.stop_flag = True
        self.th.join(2)
        still = alive(self.name)
        if still:
            self.snap("end")
            tm("kill-session", "-t", "=" + self.name)
            time.sleep(2.5)  # let the hooks of the dying session land before the next run
        ev = [{**{k: v for k, v in e.items() if k not in ("t", "sid") and v is not None}, "at": round(e["t"] - self.t0, 2)} for e in self.events()]
        rc = open(self.rcf).read().strip() if os.path.exists(self.rcf) else None
        out = {"name": self.name, "cmd": self.cmd.split(" claude ", 1)[1][:160], "pane_gone_s": self.pane_gone, "alive_at_end": still, "rc": rc,
               "trust_answer": getattr(self, "trust_answer", None), "json_left": len(glob.glob(SESS + "/*.json")), "events": ev, "json_timeline": self.timeline, **extra}
        json.dump(out, open(self.dir + "/summary.json", "w"), indent=1)
        print(f"== {self.name}: trust={getattr(self, 'trust_answer', None)} alive_at_end={still} pane_gone={self.pane_gone} rc={rc} json_left={out['json_left']} extra={extra}", flush=True)
        print("   ev:", " ".join(f"{e['ev']}{'['+str(e.get('reason') or e.get('notification_type') or e.get('tool_name') or e.get('decision') or '')+']' if (e.get('reason') or e.get('notification_type') or e.get('tool_name') or e.get('decision')) else ''}@{e['at']}" for e in ev), flush=True)
        print("   json:", " ".join(f"{t}:{(c[0]['state']+('/done' if c[0]['done'] else '')) if c else 'GONE'}" for t, c in self.timeline), flush=True)
        return out


OK = "Reply with only the word: OK"
# A bare foreground `sleep N` is refused by Claude Code's own guard, so the job is a script.
WORK = lambda bg, fg: f"Do these two steps in order, in two separate messages. First use the Bash tool with run_in_background true to run exactly: ./long-job.sh {bg}. Then use the Bash tool in the foreground, not in the background, with timeout 600000, to run exactly: ./long-job.sh {fg}. Then reply: done"


def trust_dialog():
    """Fresh, untrusted folder: what does a Run stuck at the trust dialog show?"""
    write_settings(TRUST_PROJ)
    r = Run("trust", OK, proj=TRUST_PROJ)
    time.sleep(20)
    r.snap("dialog")
    screen = cap("trust")
    r.finish(grace=0, dialog_visible="trust" in screen.lower())


def trust_no():
    """Enter at the trust dialog of a folder that pre-approves tools: picks No."""
    write_settings(TRUST_PROJ)
    r = Run("trust-no", OK, proj=TRUST_PROJ)
    r.wait(lambda: "❯ No" in cap("trust-no"), 8)
    r.snap("dialog")
    time.sleep(1.5)
    tries = 0
    while "❯ No" in cap("trust-no") and tries < 5:
        tm("send-keys", "-t", "=trust-no:", "Enter")
        tries += 1
        time.sleep(2)
    r.wait_stop(1, 40)
    r.finish(grace=2, enter_tries=tries, prompt_ran=r.count("UserPromptSubmit") > 0)


def boot():
    write_settings(PROJ)
    r = Run("boot", OK)
    accepted = r.trust_if_shown()
    r.wait_stop(1, 40)
    r.snap("after-stop")
    r.finish(grace=2, trust_accepted=accepted, prompt_ran=r.count("UserPromptSubmit") > 0)


def exit_via(name, on_allow=None, env="", ext=None):
    r = Run(name, OK, {"on_allow": on_allow} if on_allow else {}, env=env)
    r.trust_if_shown(3)
    got = r.wait_stop(1, 40)
    t = r.rel()
    if ext:
        time.sleep(2)
        ext(r)
    gone = r.wait(lambda: r.pane_gone is not None, 15)
    r.finish(grace=2.5, stop_at=t, stop_seen=got, gone_within_bound=gone)


def e_sendkeys(): exit_via("e-sendkeys", "sendkeys_exit")
def e_sigterm(): exit_via("e-sigterm", "sigterm")
def e_sigint(): exit_via("e-sigint", "sigint")
def e_continue_false(): exit_via("e-continue-false", "continue_false")
def e_delay(): exit_via("e-delay", env="CLAUDE_CODE_EXIT_AFTER_STOP_DELAY=3000")
def e_killsession(): exit_via("e-killsession", ext=lambda r: tm("kill-session", "-t", "=" + r.name))


def e_sigkill():
    def k(r):
        pid = r.last[0]["pid"] if r.last else 0
        if pid:
            os.kill(pid, 9)
    exit_via("e-sigkill", ext=k)


def gate():
    """Gate keeps it working until the marker exists, then the Run ends itself."""
    r = Run("gate", OK, {"gate": "until_marker", "on_allow": "sendkeys_exit"})
    r.wait_stop(2, 90)
    r.wait(lambda: r.pane_gone is not None, 15)
    r.finish(grace=2.5, marker=os.path.exists(PROJ + "/run-done"))


def cap_test():
    """A gate that always blocks: where does Claude Code stop it?"""
    r = Run("cap", "Reply with only the word: again", {"gate": "always"})
    last = -1
    t = time.time()
    while time.time() - t < 150:
        n = r.count("Stop")
        if n == last and time.time() - tick > 25:
            break
        if n != last:
            last, tick = n, time.time()
        time.sleep(0.5)
    r.snap("after")
    r.finish(grace=0, stops=last)


def maestro():
    """The real maestro-stopgate.sh, a stub gh, MAESTRO_* in the environment."""
    d = BASE + "/ghstub"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    shutil.copy(TOOLS + "/gh-stub.sh", d + "/gh")
    os.chmod(d + "/gh", 0o755)
    open(d + "/view", "w").write("OPEN\nin-progress\n")
    shutil.rmtree(PROJ + "/.worktree", ignore_errors=True)
    write_settings(PROJ, gate_real=True)
    r = Run("maestro", "Reply with only the word: OK. If told to keep working, reply with only the word: noted", env="MAESTRO_ROLE=worker MAESTRO_ISSUE=165")
    r.wait_stop(4, 120)
    time.sleep(5)
    r.snap("after")
    write_settings(PROJ)
    calls = open(d + "/calls.log").read().splitlines() if os.path.exists(d + "/calls.log") else []
    r.finish(grace=0, stops=r.count("Stop"), gh_calls=[c[:80] for c in calls])


def during(r, *nums):
    """Wait for the foreground job, then record what is really running mid-limit."""
    r.wait(lambda: sleeps(*nums)[str(nums[-1])] > 0, 40)
    time.sleep(2)
    return {"at": r.rel(), "sleeps": sleeps(*nums), "job_shells": s.run(["pgrep", "-fc", "long-job.sh 73"], capture_output=True, text=True).stdout.strip()}


def maestro_dontask():
    """The real gate again, in dontAsk, so a denied tool cannot hang it on a dialog."""
    d = BASE + "/ghstub"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    shutil.copy(TOOLS + "/gh-stub.sh", d + "/gh")
    os.chmod(d + "/gh", 0o755)
    open(d + "/view", "w").write("OPEN\nin-progress\n")
    shutil.rmtree(PROJ + "/.worktree", ignore_errors=True)
    write_settings(PROJ, gate_real=True)
    r = Run("maestro-dontask", "Reply with only the word: OK. If a hook tells you to keep working, do not use any tools, and reply with only the word: noted",
            flags="--permission-mode dontAsk", env="MAESTRO_ROLE=worker MAESTRO_ISSUE=165")
    r.wait_stop(4, 120)
    time.sleep(8)
    r.snap("after")
    write_settings(PROJ)
    calls = open(d + "/calls.log").read().splitlines() if os.path.exists(d + "/calls.log") else []
    r.finish(grace=0, stops=r.count("Stop"), gh_calls=[c[:80] for c in calls], count_file=os.path.exists(PROJ + "/.worktree/.maestro/stopgate-165"))


def limit_timeout():
    """Hard limit: timeout --foreground around claude, at 60s, mid-tool."""
    r = Run("limit-timeout", WORK(7304, 7305), wrap="timeout --foreground -k 10 60")
    mid = during(r, 7304, 7305)
    r.wait(lambda: r.pane_gone is not None, 85)
    time.sleep(3)
    o = sleeps(7304, 7305)
    r.finish(grace=1, mid=mid, sleeps_left=o)
    reap_sleeps(7304, 7305)


def limit_plain_timeout():
    """The same without --foreground: does the TUI even run?"""
    r = Run("limit-plain", OK, wrap="timeout -k 5 25")
    time.sleep(12)
    r.snap("t12")
    r.wait(lambda: r.pane_gone is not None, 35)
    r.finish(grace=1)


def limit_tmux():
    """Hard limit: a watchdog in the tmux server kills the session at 60s, mid-tool."""
    r = Run("limit-tmux", WORK(7302, 7303))
    tm("run-shell", "-b", f"sleep 56; tmux -L {SOCK} kill-session -t =limit-tmux")
    mid = during(r, 7302, 7303)
    r.wait(lambda: r.pane_gone is not None, 80)
    time.sleep(3)
    o = sleeps(7302, 7303)
    r.finish(grace=1, mid=mid, sleeps_left=o)
    reap_sleeps(7302, 7303)


SIX = "Use the Bash tool to run exactly: sleep 8. Run it six times, one call per message, never in parallel. Then reply: FINISHED"


def soft(name, mode, on_allow=None):
    r = Run(name, SIX, {"soft_deadline": time.time() + 25, "soft_mode": mode, "on_allow": on_allow, "gate": "until_marker"})
    r.wait(lambda: r.count("Stop") >= 1 or r.pane_gone is not None, 75)
    r.wait(lambda: r.pane_gone is not None, 12)
    r.snap("end") if alive(name) else None
    r.finish(grace=2.5, post_tool=r.count("PostToolUse"))


def soft_continue(): soft("soft-continue", "continue_false", "sendkeys_exit")
def soft_deny(): soft("soft-deny", "deny", "sendkeys_exit")


RUNBASH = "Use the Bash tool to run exactly: touch blocked-file. Then reply: done"
ASK = 'Call the AskUserQuestion tool once: header "Shape", question "Pick a shape", multiSelect false, options Square (four sides), Circle (round). After it returns, reply with only: GOT <answer>. If it is refused, reply with only: REFUSED'


def dialog_perm():
    """Hang on a permission dialog past a 60s stand-in limit, then SIGTERM."""
    r = Run("dialog-perm", RUNBASH, {"gate": "until_marker"})
    r.wait(lambda: r.count("PermissionRequest") >= 1, 40)
    time.sleep(8)
    r.snap("t8")
    time.sleep(67)
    r.snap("t75")
    pid = r.last[0]["pid"] if r.last else 0
    if pid:
        os.kill(pid, 15)
    r.wait(lambda: r.pane_gone is not None, 12)
    r.finish(grace=2.5, stops_during=r.count("Stop"), file_made=os.path.exists(PROJ + "/blocked-file"))


def dialog_keys():
    """Type /exit + Enter into a permission dialog: does it answer the dialog?"""
    r = Run("dialog-keys", RUNBASH)
    r.wait(lambda: r.count("PermissionRequest") >= 1, 40)
    time.sleep(2)
    tm("send-keys", "-t", "=dialog-keys:", "-l", "/exit")
    time.sleep(0.5)
    tm("send-keys", "-t", "=dialog-keys:", "Enter")
    time.sleep(10)
    r.snap("after")
    r.finish(grace=0, file_made=os.path.exists(PROJ + "/blocked-file"))


def dialog_escape():
    """Escape at the dialog, then /exit: the way out that does not approve anything."""
    r = Run("dialog-escape", RUNBASH, {"gate": "until_marker"})
    r.wait(lambda: r.count("PermissionRequest") >= 1, 40)
    time.sleep(2)
    tm("send-keys", "-t", "=dialog-escape:", "Escape")
    time.sleep(2)
    r.snap("after-esc")
    tm("send-keys", "-t", "=dialog-escape:", "-l", "/exit")
    time.sleep(0.5)
    tm("send-keys", "-t", "=dialog-escape:", "Enter")
    r.wait(lambda: r.pane_gone is not None, 12)
    r.finish(grace=2.5, file_made=os.path.exists(PROJ + "/blocked-file"), stops=r.count("Stop"))


def dialog_ask():
    r = Run("dialog-ask", ASK)
    r.wait(lambda: r.count("PermissionRequest") >= 1 or "Pick a shape" in cap("dialog-ask"), 40)
    time.sleep(10)
    r.snap("t10")
    tm("kill-session", "-t", "=dialog-ask")
    r.finish(grace=3)


def deny(name, prompt, **kw):
    r = Run(name, prompt, **kw)
    r.wait_stop(1, 50)
    r.snap("after")
    r.finish(grace=1, file_made=os.path.exists(PROJ + "/blocked-file"))


def dontask_bash(): deny("dontask-bash", RUNBASH, flags="--permission-mode dontAsk")
def dontask_ask(): deny("dontask-ask", ASK, flags="--permission-mode dontAsk")
def hookdeny_bash(): deny("hookdeny-bash", RUNBASH, ctl={"perm": "deny"})
def hookdeny_ask(): deny("hookdeny-ask", ASK, ctl={"perm": "deny"})


def badmodel():
    """A turn that fails on the API: no Stop. What does the session do?"""
    r = Run("badmodel", OK, {"gate": "until_marker"}, model="not-a-real-model")
    time.sleep(25)
    r.snap("t25")
    r.finish(grace=0)


for name in sys.argv[4:]:
    globals()[name]()
tm("kill-server")
