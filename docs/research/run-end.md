# How a Run reliably ends itself

Research note, 2026-11-01, for [#165](https://github.com/christinoleo/claude-mux/issues/165)
(map [#163](https://github.com/christinoleo/claude-mux/issues/163)). The question:
how can an unattended interactive session be started with a prompt, kept going
until its job is done, and closed, including at a 45-minute limit? What do
`hooks/maestro-stopgate.sh` and `MAESTRO_ROLE` already give, how would claude-mux
see the Run in its session JSON, and what does a Run that hangs on a dialog do?

This note gives facts only. Who starts the worker, and where the limit lives, are
for a later ticket.

| Source | Version |
|---|---|
| Claude Code | 2.1.309, the installed build, driven live |
| Hook docs | <https://code.claude.com/docs/en/hooks.md>, plus `env-vars`, `permission-modes`, `tools-reference`, `goal`, `cli-reference`, read 2026-11-01 |
| Maestro | `ak` plugin 1.10.0: `scripts/maestro-daemon.sh`, `hooks/maestro-stopgate.sh`, `skills/maestro-worker/SKILL.md` |
| claude-mux | `origin/main` `acdf730` |

**How to read the labels.** **Live** means seen in a real session on a private tmux
socket (`tmux -L probe165`, `--model haiku`, `--setting-sources project`), with
claude-mux's real hook, bundled from source, writing to a throwaway `HOME`. The
time limit used a 60-second stand-in. **Code** means read from the source and not
run. **Docs** means the official docs say so and it was not tried. The claude-mux
server itself was never run. Its pane readers were run directly over captured
screens. Scripts and raw output are in [`fixtures/run-end/`](fixtures/run-end/).

## Short answer

- **Nothing inside Claude Code closes an interactive session when a turn ends.**
  An allowed Stop leaves it sitting at the prompt, and so does `{"continue": false}`
  from a Stop hook. `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY=3000` did not exit it either
  (the docs describe it for SDK mode). Live. Something has to close it from outside
  the turn: typing `/exit`, a signal, or killing the tmux session.
- **Starting is easy.** A prompt as a positional argument runs by itself as soon as
  the session is up, with no keystrokes. Live.
- **Keeping it going works, up to a cap.** A Stop hook returning `decision: block`
  puts it back to work. Claude Code overrides the ninth block in a row. Live.
- **The Stop gate cannot enforce a time limit or rescue a hang.** Stop did not fire
  during a running tool, on a dialog, after an API error, or after Escape. Live. The
  limit has to come from outside the session's turn. `timeout --foreground` and
  `tmux kill-session` both worked mid-tool, and neither left the job running. Live.
- **A Run on a dialog waits indefinitely, and blind `/exit` plus Enter approves the
  dialog.** Nothing changed during 75 seconds on a permission dialog, and the
  keystrokes ran the command that was waiting for approval. Live. `--permission-mode
  dontAsk`, or a `PermissionRequest` hook that denies, avoids the dialog. Live.
- **Maestro's gate does not fit a Run as it stands.** It only acts for
  `MAESTRO_ROLE=worker` with a `MAESTRO_ISSUE`, it judges by that issue's state, and
  it never closes anything or looks at the clock. Maestro's closing is the daemon
  killing the window once the issue is closed. Its `--stale` option only warns.
- **The session JSON says less than it seems to.** A clean end deletes the file, so
  no outcome stays behind. A blocked Stop still writes `idle` and
  `turn_completed_at`. An API error leaves `busy` with no end. Live.

## Starting a Run

**Live.** This starts a session and runs the prompt, with SessionStart at about 1.3 s
and UserPromptSubmit about 0.25 s later:

```bash
tmux -L <socket> new-session -d -s <name> -x 140 -y 50 -c <project> \
  "env -u CLAUDECODE claude --model haiku --permission-mode default '<prompt>'"
```

**What claude-mux has today (Code).**

- `POST /api/projects/new-session` takes a `prompt` and passes it as that positional
  argument (`web/src/routes/api/projects/new-session/+server.ts`,
  `web/src/lib/server/start-session.ts`). The `new-session` CLI command has no prompt
  option (`src/commands/new-session.ts`).
- Neither path can set an environment variable on the session. The command line is
  fixed at `env -u CLAUDECODE claude ...` plus arguments. A `MAESTRO_ROLE`-style
  marker would need that changed.
- For Claude, `startSession` always adds `--dangerously-skip-permissions`
  (`src/agents.ts:19`), and the CLI adds it unless told not to. Maestro's daemon also
  uses it by default. **This mode was not run here**, so nothing below about dialogs
  has been tried in it. The docs say some actions still prompt or are denied even in
  bypass mode (`permission-modes`).

### The trust dialog comes first

**Live**, in a folder never trusted before:

- The prompt waits behind the dialog. In 20 seconds nothing ran, no SessionStart
  fired and no session JSON appeared, so to hooks this hang is invisible. Killing the
  session did fire SessionEnd (`other`), with no SessionStart before it.
- If the folder pre-approves tools in `.claude/settings.json`, the cursor starts on
  **"No, continue without these permissions"**, so a bare Enter picks No. The session
  then runs, hooks included, the prompt runs, and `hasTrustDialogAccepted` stays
  `false` in `~/.claude.json`, so the dialog comes back next time.
- "Yes" sets `hasTrustDialogAccepted: true`, and the dialog does not return, even
  after the project's hooks changed.
- A key sent as the dialog drew was sometimes lost: one `Down` and one `Enter`
  vanished. The cause is inferred to be timing, since a resend worked.

**Code.** Both claude-mux paths pre-trust by writing that same key
(`ensureWorkspaceTrusted`). That write itself was not run here: the probe never wrote
`~/.claude.json` itself.

## Keeping it going

**Live** (`gate`): the Stop hook blocked with "run `touch run-done`", the model ran it
through an allow rule, and the next Stop was allowed.

**Live** (`cap`, round 2): a hook that always blocks saw nine Stops, and the first
had `stop_hook_active: false`, the rest `true`. Claude Code printed: *"A hook blocked
the turn from ending 9 consecutive times — overriding and ending turn."* So eight
continuations happen and the ninth block is overridden.

**Docs.** The count resets each time Claude calls a tool, and
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` changes the cap (0 disables it). `/goal` is a
built-in session-scoped version of the same thing. Its time bound is only a clause in
the condition that a model judges, so it is not a clock.

**A gate can push a session into a dialog.** Twice, in default mode, a blocked model
went looking for a way forward and stopped on a permission prompt: a Bash command in
`maestro`, and a Read in `cap` (round 3, which therefore never reached the cap). Live.

**A Stop can arrive with work still running.** The Stop payload listed
`background_tasks` length 1 for a background shell, while claude-mux recorded idle
(its `WAKING_TASKS` counts only subagents and workflows). Live, round 2 `limit-*`.
A signal at that point ends the shell too, as the limit tests below show. `/exit`
with a background shell running was not tried.

## Closing it

One small turn each, then the method below. Live, rounds 2 and 3. "Exit code" came
from `; echo $? > rc` after `claude` in the pane's command.

| Method | Closes? | SessionEnd `reason` | Exit code | Session JSON |
|---|---|---|---|---|
| Stop hook allows, nothing else | no | none until killed | none | stays `idle` |
| Stop hook `{"continue": false}` | no | none until killed | none | stays `idle` |
| `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY=3000` | no, still up 20 s later | none until killed | none | stays `idle` |
| `/exit` + Enter, sent by `tmux send-keys` from the Stop hook | yes | `prompt_input_exit` | 0 | deleted |
| SIGTERM to `claude` | yes | `other` | 143 | deleted |
| SIGINT to `claude` | yes | `other` | 0 | deleted |
| `tmux kill-session` (SIGHUP) | yes | `other` | none, the shell dies too | deleted |
| SIGKILL to `claude` | yes | never fires | 137 | **left behind** |

Timings: the pane was gone within about 1 s of the signal or keystrokes. The hook
deleted the JSON about 0.1 s after SessionEnd fired, inside its 1.5 s budget (Docs).
The hook sends the keys or signal from a detached process after a one-second delay,
so that it has already returned.

**Telling the endings apart.** `/exit` is the only one with its own `reason`, and
SIGINT also exits 0. A limit hit by `timeout` exits 124.

**Not a way out.** `EndConversation` is for sustained abuse or an explicit demo, and
it locks the session rather than serving as a finish signal (Docs,
`tools-reference`). `--max-turns` and `--max-budget-usd` are print-mode only (Docs,
`cli-reference`), and this question is about interactive sessions.

## The time limit

### Hard limits

Both tests had a background and a foreground job really running, confirmed by `pgrep`
at about 12 s. Live, round 3.

| Limit | When | SessionEnd | Exit code | Jobs left after 3 s |
|---|---|---|---|---|
| `timeout --foreground -k 10 60 claude ...` | SessionEnd at 60.4 s | yes, `other` | 124 | none |
| `tmux run-shell -b "sleep 56; tmux kill-session ..."` (started about 4 s in) | SessionEnd at 60.3 s | yes, `other` | none | none |

No Stop fired in either, and the JSON said `busy` until SessionEnd deleted it. The
`-k` escalation was never needed.

**`--foreground` is required.** With plain `timeout 25 claude ...` the screen stayed
blank at 12 s and no hook ever fired, until the timeout ended it with 124. Live. This
is consistent with `timeout` moving the child out of the terminal's foreground group
(inferred from `timeout`'s documented behaviour, not traced).

The limit also ended a Run on a dialog: SIGTERM (exit 143) and `kill-session` each
fired SessionEnd and deleted the JSON there. Live, `dialog-perm` and `dialog-ask`.

What each one depends on (Code and inferred, not tested): `timeout` lives in the pane
and goes down with it. A tmux `run-shell` job lives in the tmux server, which by
design survives a claude-mux restart (`src/tmux/server.ts`). A timer held in the
claude-mux server would not survive that restart without being restored.

### Soft limits: a chance to finish

A PreToolUse hook can act once the clock has passed. It cannot interrupt a tool that
is already running, so it does not replace a hard limit. Live, deadline 25 s.

- **Deny with a reason works.** The next tool call was refused, the model replied
  "TIMEUP", Stop fired, the gate allowed it because the deadline had passed, `/exit`
  followed, and the pane closed at 37 s with exit code 0 (`soft-deny`). The gate has
  to let a late Stop through, or it blocks the wrap-up.
- **`{"continue": false}` is a trap.** The tool it was meant to stop still ran to
  completion, the turn ended, **no Stop fired**, so the exit step in the Stop hook
  never ran, and the JSON stayed `busy` for the 50 s until the probe killed it
  (`soft-continue`).

## What a Run on a dialog does

**Live.**

| | Permission dialog (75 s) | Question dialog (10 s) |
|---|---|---|
| Hooks | PreToolUse, PermissionRequest, then Notification `permission_prompt` about 6 s later, then nothing | the same three |
| Stop, `idle_prompt`, any timeout | none | none |
| Session JSON | `waiting` / "Waiting...", then `permission` / "Waiting for permission" at 6 s, then unchanged | `waiting` / "Asking a question", unchanged |
| claude-mux's `isPaneShowingIdlePrompt` on the screen | false | false |

The Run simply stays there. The permission dialog's text and the question's options
are on the pane ([screens](fixtures/run-end/results/)).

**How a dialog can be left (Live).**

- **`/exit` + Enter approves it.** The typed text did not end the session, and Enter
  chose the default "1. Yes": `touch blocked-file` ran, and the session stayed open
  (`dialog-keys`). So
  keystrokes are only safe once the prompt is showing.
- **Escape, then `/exit`, is safe.** Nothing ran, the session exited with code 0 and
  reason `prompt_input_exit`, and no Stop fired. The JSON stayed `waiting` after
  Escape, since no hook reports it, but `detectRecentInterruption` read the screen as
  `interrupted` (`dialog-escape`).
- **A signal or `kill-session`** ends it without answering, as above.

**How to avoid it (Live).**

| Setup | Bash needing approval | AskUserQuestion |
|---|---|---|
| `--permission-mode dontAsk` | denied at once, no PermissionRequest, the model reported it, Stop fired | denied, the model replied "REFUSED", Stop fired |
| `PermissionRequest` hook returning `behavior: deny` | denied, the model retried once, denied again, Stop fired | denied, Stop fired |

In both setups the file was not created. The JSON showed `waiting` for a few seconds
in every case but `dontAsk` on Bash. The docs say allow rules and read-only commands
still run in `dontAsk` (`permission-modes`). Neither setup was tried against an MCP
elicitation.

## What maestro already gives

**Live** (`maestro-dontask`): the real `maestro-stopgate.sh`, with a stub `gh` and
`MAESTRO_ROLE=worker MAESTRO_ISSUE=165`, blocked three Stops and let the fourth
through, labelling `needs-help` and commenting through the stub. The session then sat
at its prompt. The JSON carried `maestro_role: worker` and `maestro_issue: 165`. The
script was registered directly in project settings, not through the plugin.

**Live, script run alone against the stub** ([`stopgate-matrix.sh`](fixtures/run-end/stopgate-matrix.sh)):

| Situation | What the gate does |
|---|---|
| No `MAESTRO_ROLE`, or a role other than `worker`, or no `MAESTRO_ISSUE` | allows, does nothing |
| Issue closed, or labelled `needs-help` | allows |
| Open, with a label | blocks up to 3 times, then labels, comments and allows |
| **`gh` fails** | **allows** |
| **Open with no labels** | **allows**: the `--jq` filter prints nothing when `labels` is empty, confirmed with real `gh` on an unlabelled issue, so the state reads as empty |
| A later session on the same issue | **carries on the count**: the file is `.worktree/.maestro/stopgate-<issue>`, and only an allowed stop clears it |

**Code.**

- The comment says "blocks in a row", but progress between blocks does not reset the
  count. It never reads `stop_hook_active`.
- A Run hunting bugs has no issue until it files one, so the gate would do nothing
  for it. The gate has no notion of time.
- The daemon closes a worker by `tmux kill-window` when it sees the issue is not
  `OPEN`, on a 30-second poll (`reap_workers`). A `needs-help` session stays open on
  purpose. `--stale` is off by default, and it only labels and comments: "never kills
  it". So a maestro worker has no time limit, and one hung on a dialog stays until
  someone acts (Live for the hang: `maestro`, screen in results).
- Workers run `--dangerously-skip-permissions` by default, which is why they rarely
  meet a dialog at all (inferred; not run).
- `MAESTRO_ROLE` is otherwise only a label. The hook copies any non-empty value into
  `maestro_role`, and the web sidebar nests rows only for `worker`
  (`AllSessionsPanel.svelte`). `src/server/github.ts` reads `maestro_issue` to find
  the issue a worker owns.

## How claude-mux sees the Run

**The row's life.** `startSession` first registers a row with a random id and `pid: 0`
(Code). SessionStart deletes it by `tmux_target` and writes one keyed by the real
`session_id` (Code), so the id returned at start is not the id the Run ends up with,
and only the tmux target carries over. Live from SessionStart onward. The `pid` is
Claude's: sending SIGKILL to it killed the session.

**Normal states, Live:** `idle` at SessionStart, `busy` at the prompt, `idle` with
`turn_completed_at` set at an allowed Stop, file deleted at SessionEnd.

**Where it misleads.**

| Situation | JSON says | Really | Evidence |
|---|---|---|---|
| Stop blocked by a gate | `idle`, `turn_completed_at` set | still working | Live: `handleStop` does not know another hook blocked. `gate`: idle for 1.9 s. `cap`: idle through all eight continuations |
| Working on after a blocked Stop | `busy`, `turn_completed_at` still set | turn not over | Live: only UserPromptSubmit clears it. Each block should also raise a "done" alert, since `detectNotifications` watches that value (Code) |
| API error | `busy` forever | at the prompt | Live, `badmodel`: StopFailure (`model_not_found`) fired, no Stop. The hook does not handle StopFailure |
| `continue: false` from PreToolUse | `busy` forever | at the prompt | Live, `soft-continue` |
| Escape on a dialog | `waiting` | at the prompt | Live, `dialog-escape` |
| A tool call tagged with an `agent_id`, not from the main loop | `busy`, with no Stop to follow if the turn is over | mid-loop or at the prompt | Live, `cap` round 3: commands such as `echo noop`, absent from the session's transcripts. In round 2 an untagged log shows one after the turn, leaving `busy` to the end. The source was not established. Seen only in `cap` |
| SIGKILL | file stays, last state | dead | Live, `e-sigkill` |

**The server corrects some of this, but only with a client connected (Code).** Its
pane readers turn `busy` to `idle` when the screen shows the ready prompt, and
`isPaneShowingIdlePrompt` returned true on the `badmodel` and `soft-continue` screens
(Live, readers only). But that check, and the `cleanupStaleSessions` sweep that
removes a dead pid's file, run on timers started when the first sessions client
subscribes (`src/server/ws-handlers.ts:755-766`); the sweep also runs in the TUI
(`src/app.tsx`). A Run at 3 a.m. with no page or TUI open gets neither (inferred from
that code). The sweep skips `pid: 0`, so a row whose
session never reached SessionStart, such as one stuck on the trust dialog, is not
swept. `pane_alive` is the live field that would show it, and it too is built only
when the server reads panes.

**After the end.** A clean end leaves no JSON and no outcome in it: no reason, exit
code or "finished" flag. What remains is the transcript JSONL, which is what Past
sessions read (`CLAUDE.md`, section 11), plus whatever the Run itself wrote, such as
a GitHub issue. Anything wanting to know how a Run ended has to record that itself
before SessionEnd.

**A hung Run is detectable (Live for the fields, Code for the alerts).** `state` is
`waiting` or `permission`, `last_update` stops moving, and `pid` and pane are alive.
These are the same states that drive Needs you and the alerts.

## Not proven

- **45 minutes.** Only a 60-second stand-in was run. Nothing suggests the length
  matters, but behaviour across compaction or a long turn was not seen.
- **`--dangerously-skip-permissions`**, used by claude-mux's start path and by maestro,
  was deliberately not run, including whether it shows a dialog of its own.
- **Pre-trust by writing `~/.claude.json`.** "Yes" sets the same key, but the write
  was not run.
- **The plugin route.** The gate was registered directly, not via the plugin's
  `hooks.json`.
- **Usage-limit pauses** (`quota_auto_resume_*` notifications), MCP elicitations and
  subagent dialogs: docs only.
- **`idle_prompt`** (docs: about 60 s after a turn) was never observed, as no run sat
  idle quite that long.
- **A real claude-mux server** was not run. Everything about its timers, alerts and
  sidebar is from code.
- **`/exit` with a turn still running** was not tried. **SIGKILL with jobs running**
  was not tried, so orphaned processes are only ruled out for SIGTERM and SIGHUP.
- **A model's behaviour varies.** Two runs of the same always-block loop went
  differently. The cap was reached in one, and a dialog stopped the other. Only the mechanisms are
  claimed, not how often each happens.

## Reproducing

```bash
# Bundle the real hook, without touching the installed one
bun build src/hooks/claude-mux-hook.ts --target=node --format=esm --outfile=<base>/mux-hook.mjs

# Scenarios: trust_dialog trust_no boot e_sendkeys e_sigterm e_sigint e_continue_false
# e_delay e_killsession e_sigkill gate cap_test maestro maestro_dontask limit_timeout
# limit_plain_timeout limit_tmux soft_continue soft_deny dialog_perm dialog_keys
# dialog_escape dialog_ask dontask_bash dontask_ask hookdeny_bash hookdeny_ask badmodel
# boot writes the project's settings and answers the trust dialog, so it goes first.
mkdir -p <base>/mux-home/.claude-mux/sessions <base>/main-probe165-proj <base>/trust-probe165-proj
timeout 590 python3 docs/research/fixtures/run-end/drive.py <base> <base>/mux-hook.mjs <maestro-stopgate.sh> boot gate soft_deny

# The gate on its own, with no model
docs/research/fixtures/run-end/stopgate-matrix.sh <maestro-stopgate.sh> <work dir>

# claude-mux's pane readers over captured screens
bun docs/research/fixtures/run-end/read-screens.ts "$PWD/src/tmux/pane.ts" <screen files>
```

Accepting the trust dialog writes an entry to `~/.claude.json`, and each run leaves a
transcript under `~/.claude/projects/`. `results/round2.out` and `results/round3.out`
are the raw output. In round 2, read `cap` for the block cap and the dialog, deny and
exit scenarios, and ignore `limit-timeout`, `limit-tmux` (Claude Code refused their
bare `sleep`, so they were not mid-tool) and `trust-no` (its Enter was lost). Round 3
reruns those three properly. In both, the `[allow]` a Stop shows in `maestro*` runs
is only the logging hook's own verdict: the real gate's decisions are in `gh_calls`
and the stop count. A first round of the `e_*` scenarios, run with the "No" trust
answer by mistake, gave the same results and is not kept.
