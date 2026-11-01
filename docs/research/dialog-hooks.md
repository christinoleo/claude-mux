# What hooks do in the untested dialog cases

Research note, 2026-11-01, for [#157](https://github.com/christinoleo/claude-mux/issues/157)
(map [#155](https://github.com/christinoleo/claude-mux/issues/155)). The question:
what do hooks do for a multi-select answer, several questions in one call,
answering `AskUserQuestion` through `PermissionRequest`, a person answering in
the terminal while a hook holds, a hook that times out or is killed, a held hook
during a dashboard restart, and subagents?

Every row in the tables below was run against the real binary, Claude Code
2.1.309, and is proven live unless the row or [What stays unproven](#what-stays-unproven)
says otherwise. Each case ran in a fresh session on a private tmux socket, with
`--setting-sources project`, `--model haiku`, `--permission-mode default`,
`--strict-mcp-config` and every inherited `CLAUDE*` variable removed. Results come
from hook logs, the session transcript and captured screens, not from what the
model said, except where a row says so.

Each case ran once, apart from a few reruns noted under
[Mistakes made and corrected](#mistakes-made-and-corrected). So this shows what
happens, not how often.

Sources:

| Source | Used for |
|---|---|
| The real binary, through [`fixtures/dialog-hooks/`](fixtures/dialog-hooks/) | Every result in the tables |
| [Hooks reference](https://code.claude.com/docs/en/hooks.md), read 2026-11-01 | The contract the results are compared with |
| [Subagents](https://code.claude.com/docs/en/sub-agents.md) and [environment variables](https://code.claude.com/docs/en/env-vars.md), read 2026-11-01 | Tool filters, foreground and background, fork mode |
| claude-mux `CLAUDE.md`, `package.json`, `src/hooks/claude-mux-hook.ts` at `acdf730` | What a real restart does |

## Short answer

- **Multi-select works through `updatedInput`, and the form matters a little.** A
  person's keyboard selection produces `Red, Blue`. The documented comma form
  `Red,Blue` also works, but Claude gets different result wording for it.
- **Several questions work.** Answers are keyed by question text. Claude Code does
  not check that they are complete: a missing question is dropped silently, and
  wrong keys produce "The user did not answer the questions". No dialog appears in
  either case.
- **`PermissionRequest` with `updatedInput` answers `AskUserQuestion`,** including
  several questions and multi-select. The dialog is on screen during the hold and
  closes when the hook answers. `allow` without `updatedInput` does not answer: the
  dialog stays. `deny` closes it and Claude receives the message as a tool error.
- **A person and a hook race only under `PermissionRequest`.** Whoever decides first
  wins and the later decision is ignored. Under `PreToolUse` there is no dialog to
  answer, so only Esc reaches it.
- **A hook is not told when a person says yes.** It keeps running until its timeout
  or the session's exit, measured at 600.5s with the default timeout. A person's
  Esc or "No" does send it SIGTERM.
- **A timed-out or killed hook loses nothing.** The normal dialog is there afterwards
  and can be answered by keyboard. But a stalled `PreToolUse` hides the dialog until
  the hook ends, which by default can be ten minutes.
- **A held hook survives the holder's death,** because Claude Code is its parent, not
  the dashboard. A hook that retries gets the answer from the restarted holder. A hook
  that gives up falls back to the dialog.
- **Subagents do not behave the same in three ways.** Normal subagents have no
  `AskUserQuestion` at all, whether foreground or background; only forks do. Approvals
  fire hooks with `agent_id` and `agent_type` everywhere, but in a background subagent
  or a fork the dialog appears only after the `PermissionRequest` hook returns, so a
  person cannot answer during the hold. And Esc denies only that one tool call.

## Results

"Hook" below means the probe script `hook.py`. "Holds" means it waits and has not yet
returned. Case names are directories under
[`fixtures/dialog-hooks/results/`](fixtures/dialog-hooks/results/).

### Multi-select

The question has `multiSelect: true` and options Red, Green and Blue. Except for
`multi_keys`, a `PreToolUse` hook answers with `allow` plus `updatedInput`, and no
dialog shows.

| Case | Setup | Result |
|---|---|---|
| `multi_keys` | Hook passes; a person selects Red and Blue by keyboard and submits | The tool receives `answers: {"Pick colors": "Red, Blue"}`. Claude reads "Your questions have been answered". This is the reference form |
| `multi_comma_space` | Hook sends `"Red, Blue"` | Same result text as the keyboard answer |
| `multi_commas` | Hook sends `"Red,Blue"`, the form the docs describe | Accepted. Claude reads "The user answered ... Read the answers carefully", the wording that free text also got |
| `multi_array` | Hook sends `["Red", "Blue"]`, which the docs do not describe | Accepted and joined to `"Red, Blue"`, same text as the keyboard answer |

### Several questions in one call

| Case | Setup | Result |
|---|---|---|
| `several_full` | Three questions, one of them multi-select and one given free text; hook answers all three | All three reach Claude; no dialog |
| `several_partial` | Two questions; hook answers only the first | The tool succeeds with one answer. The second question is dropped with no error and no dialog |
| `several_wrong_key` | Two questions; hook keys answers by `header` instead of question text | The tool succeeds and Claude reads "The user did not answer the questions". No error and no dialog. The screen disagrees: it shows "User answered Claude's questions" with the two answers |

### `AskUserQuestion` through `PermissionRequest`

`PreToolUse` passes in all of these, then `PermissionRequest` fires.

| Case | Setup | Result |
|---|---|---|
| `pr_answer` | Hook holds 2s, then `allow` with `updatedInput` and `answers` | Dialog visible during the hold, then closes. Claude gets the answer. No keystrokes |
| `pr_several_multi` | Same, with two questions, one multi-select | Both answers reach Claude |
| `pr_allow_no_input` | Hook returns `allow` with no `updatedInput` | Not an answer. The dialog stays, and a person's keystroke answered it |
| `pr_deny` | Hook returns `deny` with a message | The dialog closes. Claude gets the message as a tool error. No `PostToolUse` |

### A person answers in the terminal while a hook holds

| Case | Setup | Result |
|---|---|---|
| `hold_pre_auq_keys` | `PreToolUse` holds; a person presses Down and Enter | Nothing visible happens: there is no dialog, only "running PreToolUse hook". The hook's answer applies when it returns |
| `hold_pre_auq_text` | `PreToolUse` holds; a person types a message and presses Enter | The message queues ("Press up to edit queued messages"). The hook's answer applies, then the queued message runs |
| `hold_pre_auq_esc` | `PreToolUse` holds; a person presses Esc | The hook gets SIGTERM. The screen shows "User declined to answer questions". Claude gets a rejection. No `PostToolUse` and no `Stop` |
| `hold_pr_auq_person` | `PermissionRequest` holds; a person picks Circle; the hook then returns Square | Circle wins and the hook's later output is ignored. The hook was still alive when the person answered |
| `hold_pr_auq_esc` | `PermissionRequest` holds on a question; a person presses Esc | The hook gets SIGTERM; rejection; no `PostToolUse` and no `Stop` |
| `hold_pr_bash_yes` | `PermissionRequest` holds on Bash; a person chooses Yes; the hook then returns `deny` | The command runs and the file exists. The late `deny` is ignored |
| `hold_pr_bash_no` | Same; a person presses Esc | The hook gets SIGTERM; the command does not run. The screen shows "Interrupted". No `Stop` |
| `hold_pr_bash_no_select` | Same; a person chooses option 4, "No" | Same as Esc: SIGTERM, no command, no `Stop` |

How long a hook lives when a person says yes and the hook never returns:

| Case | Setup | Result |
|---|---|---|
| `leftover_bash` | Default timeout; a person approves Bash; then another turn; then `/exit` | The tool runs and `PostToolUse` fires while the hook holds. It is alive at the end of the turn, at +25s and after the next turn. It gets SIGTERM at `/exit` |
| `leftover_auq` | Same, on a question | Same |
| `leftover_bash_timeout` | Same with `timeout: 12` | Alive at +5s, gone by +15s, with SIGTERM |
| `leftover_bash_default_timeout` | Default timeout, no `/exit` | SIGTERM at 600.5s, matching the documented default of 600 |

### Hook timeout and killed hook

Timeout cases set `timeout: 6`. Kill cases send SIGKILL to the hook 2s into the hold.
After the hook ended, a person answered by keyboard in every case, and the answer or
the command went through.

| Case | Setup | On screen during the hold | On screen afterwards |
|---|---|---|---|
| `timeout_pre_auq` | `PreToolUse`, question, timeout | No dialog; "running PreToolUse hook" | The dialog appears; no notice. `PermissionRequest` fires next |
| `kill_pre_auq` | `PreToolUse`, question, killed | Same | The dialog appears; the transcript area shows `PreToolUse:AskUserQuestion hook error` |
| `timeout_pre_bash` | `PreToolUse`, Bash, timeout | No dialog | The approval dialog appears; no notice |
| `kill_pre_bash` | `PreToolUse`, Bash, killed | No dialog | The approval dialog appears; `PreToolUse:Bash hook error` |
| `timeout_pr_auq` | `PermissionRequest`, question, timeout | Dialog visible | The dialog stays; no notice |
| `kill_pr_auq` | `PermissionRequest`, question, killed | Dialog visible | The dialog stays; no notice |
| `timeout_pr_bash` | `PermissionRequest`, Bash, timeout | Dialog visible | The dialog stays; no notice |
| `kill_pr_bash` | `PermissionRequest`, Bash, killed | Dialog visible | The dialog stays; no notice |

The hook received SIGTERM at each timeout. None of these used `onFailure: "block"`,
which the docs say would block the call or deny the request instead.

### A held hook and a dashboard restart

This is a model, not the real server. `holder.py` stands in for the dashboard, as a
process the hook waits on. It was killed with SIGKILL 1.5s into the hold and stayed
down for 6s. Claude Code stayed up throughout, as a session in tmux would.

| Case | Setup | With the holder down | Result |
|---|---|---|---|
| `restart_file_auq` | `PreToolUse` question; hook waits on a file; a new holder writes it | No dialog | Answered by the new holder, no keystrokes |
| `restart_sock_reconnect_auq` | `PreToolUse` question; hook on a Unix socket sees EOF and retries | No dialog | The hook re-registers with the new holder and gets the answer, no keystrokes |
| `restart_sock_giveup_auq` | `PreToolUse` question; hook exits with no output on EOF | The dialog appears | `PermissionRequest` fires and a person answers by keyboard |
| `restart_file_bash` | `PermissionRequest` Bash; file | Dialog visible | The new holder approves, the dialog closes and the command runs |
| `restart_sock_reconnect_bash` | `PermissionRequest` Bash; socket with retry | Dialog visible | Same |
| `restart_sock_giveup_bash` | `PermissionRequest` Bash; hook exits on EOF | Dialog visible | A person approves by keyboard |

The hook lives through this because it is a child of Claude Code. What the model
leaves out is below, under [What stays unproven](#what-stays-unproven).

### Subagents

Three kinds were tested, because they differ. **Background** is what a subagent gets
by default (`status: async_launched`). **Foreground** needs fork mode off
(`CLAUDE_CODE_FORK_SUBAGENT=0`) and `run_in_background: false`; each foreground case
was checked to have returned `status: completed`. **Fork** was started with `/subtask`
and reports `agent_type: "fork"`. "General" is the built-in `general-purpose`; "custom"
is a project agent whose frontmatter lists `tools: AskUserQuestion, Bash`.

Questions:

| Case | Setup | Result |
|---|---|---|
| `sub_bg_gp_auq_pass`, `sub_bg_gp_auq_answer` | Background, general; hook passes or answers | No `AskUserQuestion` call and its hook never fires. `ToolSearch` returns "No matching deferred tools found" |
| `sub_fg_gp_auq_pass`, `sub_fg_gp_auq_answer` | Foreground, general; hook passes or answers | Same |
| `sub_bg_custom_auq_pass`, `_answer`, `_pr` | Background, custom, listing the tool; hook passes, answers through `PreToolUse`, or answers through `PermissionRequest` | No call and no hook fires. The agent reports Bash as its only tool |
| `sub_fg_custom_auq_pass`, `_answer`, `_pr` | Foreground, custom, same three | Same |
| `sub_fork_auq_pass` | Fork; hook passes | The tool exists. The dialog appears on the main screen and a person's keystroke answers it |
| `sub_fork_auq_answer` | Fork; `PreToolUse` answers | Answered with no dialog |
| `sub_fork_auq_pr` | Fork; `PermissionRequest` holds 1s and answers | Answered. No dialog when checked 0.8s into the hold |

Approvals. Hooks carry `agent_id` and `agent_type` in all of these, and the dialog
names the source ("Bash command · from the asker agent").

| Case | Setup | Dialog during the hold | Result |
|---|---|---|---|
| `sub_fg_bash_pr_allow` | Foreground; hook holds 2s and allows | Visible | Runs |
| `sub_bg_bash_pr_allow` | Background; same | **Not visible** | Runs |
| `sub_fork_bash_pr_allow` | Fork; same | **Not visible** | Runs |
| `sub_fg_bash_keys`, `sub_bg_bash_keys`, `sub_fork_bash_keys` | Hook passes; a person presses Enter | No hold | The dialog appears on the main screen; the command runs |
| `sub_fg_bash_hold_person` | Foreground; hook holds; a person chooses Yes; hook then denies | Visible | The person wins and the command runs. The hook was still alive, as on the main thread |
| `sub_bg_bash_hold_person` | Background; hook holds; a person presses Enter; hook then denies | **Not visible** | Enter does nothing, as there is no dialog. The hook's `deny` decides: the command does not run |
| `sub_fg_bash_esc`, `sub_bg_bash_esc` | Hook passes; a person presses Esc | No hold | Only that call is denied: "Permission for this tool use was denied". The subagent carries on and reports. `Stop` still fires, unlike Esc on the main thread |
| `sub_fg_bash_timeout`, `sub_fg_bash_kill` | Foreground; `timeout: 6`, or killed | Visible | The dialog stays and a person approves |
| `sub_bg_bash_timeout`, `sub_bg_bash_kill` | Background; same | **Not visible** | The dialog appears only once the hook has ended, and a person approves |

## Facts the `PreToolUse` and `PermissionRequest` choice rests on

This note does not choose between them. That is for a later ticket.

| | `PreToolUse` on `AskUserQuestion` | `PermissionRequest` on `AskUserQuestion` |
|---|---|---|
| In the docs' recipe | Yes, [Tools that require user interaction](https://code.claude.com/docs/en/hooks.md#tools-that-require-user-interaction) describes exactly this | Its `updatedInput` is documented in general; the recipe does not name this route. It worked live |
| Dialog while the hook holds | None; the screen shows "running PreToolUse hook" | Visible on the main thread |
| Person at the terminal during a hold | Can only press Esc or queue a message | Can answer; first decision wins |
| If the hook stalls | No dialog until it ends, by default up to 600s | The dialog is usable throughout |
| When the holder dies and the hook retries | No dialog for the person during the outage | The dialog stays usable during the outage |
| Hook told when a person answers | Only Esc can reach it, and that sends SIGTERM | No on a yes or an answer, so the hook runs on. SIGTERM on Esc or "No" |
| `tool_use_id` in the payload | Yes | No, so matching a later `PostToolUse` must go through the tool input or the `PreToolUse` that came before |
| When it fires | Every call to the tool | Only when a prompt is about to show; only tested in default mode |
| Inside a fork | Worked, no dialog | Worked, no dialog during the hold |

For Bash approvals, only `PermissionRequest` was tested as the way to answer:
`PreToolUse` was tested here only for stalling. The dialog's visibility during the
hold differs between the main thread or a foreground subagent (visible) and a
background subagent or fork (not visible).

## Other facts these runs turned up

- **`PostToolUse` carries the answer.** Its `tool_input.answers` held what a person
  chose (`multi_keys`), so a person's answer is observable afterwards through a hook.
- **A rejection fires neither `PostToolUse` nor `Stop`.** On the main thread, Esc or
  "No" ends the turn with no event at all. This matches the screen check described
  in `CLAUDE.md`.
- **The result wording is not a stable signal.** `Red,Blue` and free text produced
  "The user answered ... Read the answers carefully"; exact labels and `Red, Blue`
  produced "Your questions have been answered". The pattern fits every run, but the
  rule behind it is an inference. Nothing should parse this text.
- **An agent with no type fires hook events.** In 35 of the 64 kept sessions, including
  ones with no subagent, a `SubagentStop` arrived with an `agent_id`, an empty
  `agent_type` and no `SubagentStart`. In `sub_fork_bash_keys` this agent fired
  `PreToolUse` for `rm probe_sub_fork_bash_keys.txt`, which nobody asked for, after the
  turn had ended. `PermissionRequest` and `PostToolUse` did not follow, the file is still
  there, and the agent stopped 1.4s later. A discarded run showed the same for
  `echo waiting`. What this agent is remains unproven; it may be the helper behind the
  greyed prompt suggestions. Two things follow from what was seen: a hook that treats
  `agent_id` as "a subagent the user started" would count these, and a `PreToolUse` event
  does not prove that the command ran or that the user asked for it.
- **Background `Stop` is early.** With a background subagent, `Stop` can fire before
  the subagent has finished, and `PostToolUse` for `Agent` arrives at launch. A second
  `Stop` follows when the main session handles the report.
- **`Notification` with `permission_prompt` fired during long holds.** It fired when a
  dialog had been visible for about six seconds, as the docs state, even though a hook
  was still deciding.

## What stays unproven

- **Other permission modes.** Everything ran in default mode, by design. Whether
  `PermissionRequest` fires for `AskUserQuestion` in `acceptEdits`, `auto` or
  `bypassPermissions` was not tested, and the `PermissionRequest` route depends on it.
- **The real dashboard restart.** The real server was left alone by design, and today's
  `src/hooks/claude-mux-hook.ts` writes JSON files and never holds. `prod:restart` stops
  the server by killing the `serve` process and whatever holds port 3456, which matches
  the model. However, `CLAUDE.md` records that a tmux server already running inside
  `claude-mux.service` has panes tied to that unit, so stopping the unit closes them,
  and any held hook would go with them. New tmux servers start in a scope of their own.
  That path was not exercised. The model also kept each outage to 6s, far inside the timeout.
- **A hook timeout running out during an outage.** Not run with a restart. The separate
  timeout cases show what the end of a timeout does.
- **A process tree under the hook.** SIGTERM and timeouts were observed only on the hook
  process itself. Whether children of a wrapper script also receive them was not tested.
- **`onFailure: "block"`.** Documented, not run.
- **Forks under stall or a person's answer during a hold.** Fork timeout, kill and
  hold-then-person were not run. Only the absence of a dialog during a hold was
  observed, on Bash for 2s and on a question for 1s.
- **Forks Claude starts itself.** Docs say Claude can start them. An Agent call with no
  type ran `general-purpose` here, so only `/subtask` forks were tested.
- **Why custom subagents lack the tool.** The docs say `AskUserQuestion` is removed from
  every subagent even when listed in `tools`. Live, the hook never fired and the
  transcript has no call, but "Bash is my only tool" is the model's own report. General
  subagents have the stronger evidence, from `ToolSearch`.
- **Exact-moment races.** A person and a hook were separated by seconds. Two decisions
  milliseconds apart were not tried.

## Mistakes made and corrected

Three first attempts tested the wrong thing and were thrown away, then rerun. None of
those results are in the tables.

- **Socket restart cases.** The socket path exceeded the 108-byte `AF_UNIX` limit, so
  the holder crashed and the hook never connected. Hook and holder now use a relative
  path.
- **"Foreground" subagents.** With fork mode on, subagents start in the background
  whatever the prompt says. Even with it off, the model sometimes left out
  `run_in_background: false`. The harness now retries a foreground case until the Agent
  call returns `completed`; no case needed a retry after the prompt named the parameter.
- **"Fork" cases.** An Agent call with no type runs `general-purpose`. `SubagentStart`
  showed it, and `/subtask` replaced it.

`multi_keys` also ran twice, because the first attempt's key presses went past Submit.
`multi_commas` and `pr_answer` ran twice, once as smoke tests, with the same result.

## Running it again

```sh
mkdir -p "$PROBE_DIR/probe157-proj"
cp docs/research/fixtures/dialog-hooks/*.py "$PROBE_DIR/"
python3 "$PROBE_DIR/drive.py" "$PROBE_DIR" list
python3 "$PROBE_DIR/drive.py" "$PROBE_DIR" multi_keys pr_answer
python3 "$PROBE_DIR/summarize.py" "$PROBE_DIR" multi_keys pr_answer
```

The driver removes inherited `CLAUDE*` variables itself. It uses only the tmux socket
`probe157` and the project settings under its own directory. It does spend model turns
on haiku, and Claude Code records the probe project's folder trust in `~/.claude.json`. Paths in the committed evidence are normalized to
`$PROBE_DIR`. Each case in `results/` holds `result.json` and the captured screens.
