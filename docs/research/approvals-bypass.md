# Approvals and questions under `--dangerously-skip-permissions`

Research note, 2026-11-02, for [#161](https://github.com/christinoleo/claude-mux/issues/161)
(map [#155](https://github.com/christinoleo/claude-mux/issues/155)). It fills one gap left
by [#157](https://github.com/christinoleo/claude-mux/issues/157), whose
[note](https://github.com/christinoleo/claude-mux/blob/research/dialog-hooks/docs/research/dialog-hooks.md)
ran only in default permission mode, while Leo's sessions and workers launch with
`--dangerously-skip-permissions`.

Everything below ran live on Claude Code 2.1.316, on Haiku. There are 264 kept runs across
87 cases: 132 runs of 44 cases in bypass mode, 132 runs of 43 cases in default mode. Most
cases ran 3 times. `by_plan_pr_echo` and `df_plan_pr_echo` ran 6 times, and the three
long-hold cases ran 2 times. So "3/3" means every kept run of that case, not a rate.
[Discarded runs](#mistakes-made-and-corrected) are listed at the end.

Each run was a fresh session on a private `tmux -L` socket, in a scratch project, with
`--setting-sources project`, hooks in the project's own settings, and inherited `CLAUDE*`
variables and `TMUX` removed. Results come from hook logs, the session transcript, files on
disk and captured screens, not from what the model said.

## Short answer

1. **`PermissionRequest` under bypass.** It does not fire for an ordinary Bash command
   (0/3, plus 0/3 with a rule waiting for it). The command just runs. It does fire for
   `AskUserQuestion` (3/3), and its `updatedInput` plus `answers` answers the question with
   the dialog visible during the hold (3/3).
2. **`PreToolUse` under bypass.** It fires and holds for both (3/3 each). It answers
   `AskUserQuestion` through `updatedInput` plus `answers`, with no dialog during the hold
   (3/3, and 3/3 with several questions and multi-select). `permission_mode` reads
   `bypassPermissions`.
3. **What such a session still shows.** `AskUserQuestion`, plan approval, an explicit `ask`
   rule, a `PreToolUse` `ask`, a critical-path `rm` or `rmdir`, an MCP tool marked
   `requiresUserInteraction`, and an MCP form request. A protected path shows nothing: the
   write just happens (9/9, across `.git`, `.claude` and `.vscode`). `PermissionRequest`
   fired for each of these except the form request, which has its own `Elicitation` hook.
4. **Default mode on 2.1.316.** Every behaviour re-run matches 2.1.309. The new
   permission-related behaviour found is listed under
   [Default mode compared with 2.1.309](#default-mode-compared-with-2109).

**In a bypass session, `PermissionRequest` fired exactly when a person was being asked, MCP forms aside.** That
is what makes it usable there, not a gap. The facts favour holding in `PermissionRequest`
([details](#what-this-means-for-the-choice)); the decision stays with #161.

## Results

Each cell gives the kept runs that behaved this way. "Dialog" means the dialog was on screen.

### What fires, and what shows, with hooks that pass

| Action | Bypass: `PreToolUse` | Bypass: `PermissionRequest` | Bypass: dialog | Default: `PermissionRequest` and dialog | Cases |
|---|---|---|---|---|---|
| Bash, `echo` to a file | 3/3 | 0/3 | No, it ran | 3/3 | `*_bash_pass` |
| `AskUserQuestion` | 3/3 | 3/3 | Yes | 3/3 | `*_auq_pass` |
| Plan approval, `ExitPlanMode` | 3/3 | 3/3 | Yes | 3/3 | `*_plan_pass` |
| Bash matching a `permissions.ask` rule | 3/3 | 3/3 | Yes, "Permission rule ... requires confirmation" | 3/3 | `*_askrule_pass` |
| Bash after `PreToolUse` returns `ask` | 3/3 | 3/3 | Yes, "Hook PreToolUse:Bash requires confirmation" | 3/3 | `*_bash_pre_ask` |
| `rmdir` of a critical path | 3/3 | 3/3 | Yes, with a countdown under bypass only | 3/3, no countdown | `*_critical_pass` |
| MCP tool with `requiresUserInteraction` | 3/3 | 3/3 | Yes | 3/3 | `*_mcpri_pass` |
| MCP form request (elicitation) | 3/3 | 0/3; `Elicitation` fires | Yes | The call itself needs approval first, then the same form | `*_elicit_pass` |
| `Write` into `.git/` | 3/3 | 0/3 | No, it wrote | 3/3 | `*_protected_git_write` |
| `Write` into `.claude/` | 3/3 | 0/3 | No, it wrote | 3/3 | `*_protected_claude_write` |
| Bash writing into `.vscode/` | 3/3 | 0/3 | No, it wrote | 3/3 | `*_protected_vscode_bash` |

The critical path used was `/probe161-not-there`, a top-level directory that does not exist, so
`rmdir` could only fail. Its failure is what the runs record.

### Whether a hook can answer each dialog

These results are the same in both modes unless stated, 3/3 per mode.

| Dialog | `PreToolUse` `allow` | `PermissionRequest` `allow` | Cases |
|---|---|---|---|
| `AskUserQuestion` | Answers with `updatedInput` and `answers`, no dialog. `allow` alone does not answer: the dialog appears and `PermissionRequest` fires | Answers with `updatedInput` and `answers`; dialog visible during the hold, then closes | `*_auq_pre_answer`, `*_auq_pre_allow_alone`, `*_auq_pr_answer` |
| Plan approval | Answers with `updatedInput` echoing the input, no dialog | Answers with `updatedInput` echoing the input (6/6 per mode). `allow` alone does not: the dialog stays (3/3 per mode) | `*_plan_pre_allow`, `*_plan_pr_echo`, `*_plan_pr_allow` |
| `ask` rule | Cannot: the dialog still appears | Answers; dialog visible during the hold | `*_askrule_pre_allow`, `*_askrule_pr_allow` |
| `PreToolUse` `ask` | n/a | Answers; dialog visible during the hold | `*_bash_pre_ask_pr_allow` |
| Critical-path `rm`/`rmdir` | Cannot: the dialog still appears | **Answers: the command ran with no person.** Dialog visible during the hold | `*_critical_pre_allow`, `*_critical_pr_allow` |
| MCP `requiresUserInteraction` | Cannot: the dialog still appears | Cannot, with or without `updatedInput`: the dialog stays | `*_mcpri_pre_allow`, `*_mcpri_pr_allow`, `*_mcpri_pr_echo` |
| MCP form | n/a | n/a. The `Elicitation` hook answers: no dialog during its hold, and the server got the content | `*_elicit_hook` |

A person's keystroke answered every dialog in the "hooks that pass" table, in both modes.

Dialogs on `requiresUserInteraction` tools were not answered by hand after the hook's `allow`, so
it stays unproven whether a person can still answer one after that.

### Holds, stalls and a person at the terminal under bypass

| Case | What happens, 3/3 unless stated |
|---|---|
| `by_bash_pre_hold_allow` | No dialog; "running PreToolUse hook" on screen. The command runs when the hook allows |
| `by_bash_pre_hold_deny` | No dialog. The command does not run; Claude gets the message as a tool error |
| `by_bash_pre_stall` | Timeout: **the command runs with no dialog and no notice** |
| `by_bash_pre_kill` | Killed hook: **the command runs with no dialog**, and the screen shows `PreToolUse:Bash hook error` |
| `by_auq_pre_stall`, `by_auq_pre_kill` | No dialog during the hold. It appears when the hook ends, `PermissionRequest` fires, and a person answers |
| `by_auq_pre_esc` | Esc sends SIGTERM. The tool is rejected. No `PostToolUse` and no `Stop` |
| `by_auq_pr_person` | A person picks Circle; the hook, still alive, later returns Square. Circle wins |
| `by_auq_pr_stall` | Dialog visible throughout. It stays after the timeout, and a person answers |
| `by_auq_pr_deny` | Dialog closes and Claude gets the message as a tool error |
| `by_auq_pr_long` (2/2) | A hold of 130s on a question answered normally. No countdown applies to a question |

The stall cases used `timeout: 6`, and kill cases SIGKILL 2s into the hold.

### The two-minute countdown

Under bypass, the critical-path dialog says "Claude Code will automatically block this request in
1:59". This is [documented](https://code.claude.com/docs/en/permission-modes.md#time-limits-and-denials-in-auto-and-bypasspermissions-modes)
and it keeps running while a hook holds:

- `by_critical_expire` (2/2): with nobody answering, the command was denied and the turn ended at
  about 122s after `PermissionRequest`.
- `by_critical_pr_long` (2/2): a hook held past that point. The denial still came at about 122s. The
  hook received no signal and ran on to its own limit at 170s.

No other dialog's screen in this run mentioned a countdown. The docs also say three expiries in a
session make later ones deny at once, which was not tested.

### Subagents and forks

| Case | Result, 3/3 |
|---|---|
| `by_sub_bg_bash` | Background subagent under bypass: `PreToolUse` fires, `PermissionRequest` does not, no dialog, the command runs |
| `df_sub_bg_bash` | In default mode: `PermissionRequest` fires, the dialog appears on the main screen, a person approves |
| `by_fork_auq_pass`, `df_fork_auq_pass` | A fork's question: `PermissionRequest` fires, the dialog appears, a person answers |
| `by_fork_auq_pre`, `df_fork_auq_pre` | A fork's question answered by `PreToolUse`, no dialog |

`permission_mode` inside a fork reads `bypassPermissions` under bypass and `bubble` in default mode, so
a hook should not test for `default`.

### Payload

- `PermissionRequest` still has no `tool_use_id` (0 of 199 events), and `PreToolUse` always has it.
  Matching one to the other goes through the tool input.
- `permission_mode` during a plan reads `plan` even in a bypass session, and returns to
  `bypassPermissions` after approval. A hook must not read `plan` as "not bypass".
- `PermissionDenied` never fired, as expected outside auto mode.
- A `SubagentStop` with an `agent_id`, an empty `agent_type` and no start, as #157 saw, came in 55
  of the 264 runs. None of these fired a tool event in this set, including under bypass.

## Default mode compared with 2.1.309

These 2.1.309 results held on 2.1.316, 3/3 each:

- `PreToolUse` answers a question with no dialog, including several questions and multi-select.
- `PermissionRequest` shows the dialog during the hold and answers with `updatedInput`.
- `PermissionRequest` `deny` is a tool error. `PreToolUse` `allow` alone leaves the dialog.
- A person during a `PermissionRequest` hold wins, on a question and on Bash, and the hook is still alive.
- A stalled `PreToolUse` hides the dialog until it ends. A stalled `PermissionRequest` leaves it usable.
- A killed `PreToolUse` shows `hook error`. Esc during a hold sends SIGTERM and no `Stop` follows.

New here, and not comparable with 2.1.309 because #157 did not test them: the `ask` routes, plan
approval, critical paths, MCP tools and forms, and protected paths.

**Not re-run on 2.1.316:** the 600s default timeout, `PermissionRequest` `allow` alone on a question,
killed `PermissionRequest`, foreground subagents, keyboard multi-select, wrong answer keys, and the
restart model.

**One unrelated change.** The folder trust dialog now lists "No, exit" first with the cursor on it, so
Enter leaves Claude Code. #157's harness pressed Enter there and proceeded, so this looks new, but
2.1.309 was not re-checked. `claude-mux new` pre-trusts the folder, so it should not meet this dialog;
the code was read but that path was not run.

## What this means for the choice

The ticket's choice is between holding in `PermissionRequest` (the dialog stays, either side answers)
and holding in `PreToolUse` (the dashboard answers, and the dialog appears only if the hook gives up).
The facts favour `PermissionRequest`:

- **It reaches more.** It answers 4 of the 5 permission-style dialogs (question, plan, `ask` rule,
  critical path). `PreToolUse` answers 2. Neither answers `requiresUserInteraction`.
- **It fires when, and only when, someone is asked, MCP forms aside.** That held in both modes, so one hook covers both,
  and nothing needs to know the mode. `PreToolUse` fires on every call.
- **It fails towards the person.** If the dashboard is down or the hook stalls, the dialog is there and
  answers by keyboard. Under `PreToolUse` the question is invisible until the hook ends.
- **The bypass gap does not hurt it.** The missing `PermissionRequest` for Bash and protected paths means
  nobody was going to be asked.

What it costs, and what a design must handle:

- **The hook is not told when a person answers.** It stays alive, so the dashboard must end it on
  `PostToolUse` or by matching tool input, and a hook needs a sensible timeout. `PermissionRequest` has
  no `tool_use_id` to help.
- **A question or plan needs the input echoed.** `allow` alone leaves the dialog open.
- **It can approve a critical-path removal with no person.** `PreToolUse` cannot. So a dashboard button
  on this path carries real weight, and an automatic rule on it would be dangerous.
- **A long hold loses to the countdown** on critical paths at about 2 minutes, and the hook is not told.
- **A background subagent or fork shows no dialog during a hold,** per #157 on 2.1.309. Not re-tested here.

`PreToolUse` keeps one real advantage: it is the only route that can stop a Bash command under bypass.
Used that way it fails open: a killed or timed-out hook lets the command run with no dialog. So it can
serve as a guard only with that caveat, and that use is outside this ticket's question.

An MCP form needs the `Elicitation` hook whichever way this goes. Its stall behaviour was not tested.

## What stays unproven

- Whether the numbers hold beyond these small samples. Cases ran 2 to 6 times, on one machine.
- Dialogs the docs list but this did not run: connector tools set to `ask`, cross-session messaging
  safeguards, `blockReadsOutsideWorkingDirectories`, sandbox escalation, the `Dangerous rm operation not
  ruled out` prompt and the mounted drive prompt. The last two were skipped on purpose, as the only way
  to trigger them is a command that could delete things if the check failed.
- `onFailure: "block"`, `PermissionRequest` `deny` on critical paths and MCP tools, and Esc during a
  `PermissionRequest` hold under bypass.
- A hold on a `PermissionRequest` inside a fork or background subagent under bypass, and a person's
  answer there.
- A session launched with the flag and then moved out of bypass with Shift+Tab.
- Models other than Haiku. Hook behaviour should not depend on the model, but only Haiku ran.
- Real dashboard restarts, as in #157.
- TUI-only dialogs such as `/model`. Hooks are not expected to see them, per the map; not exercised here.

## Mistakes made and corrected

None of these results are in the tables.

- **Trust dialog.** The first runs pressed Enter on it, which exits on 2.1.316. The driver now moves to
  "Yes" first.
- **Empty launches.** The first launches in each new project directory (about four per directory) left
  no session at all: a blank screen and no events. The cause was not found. They sent no prompt, so they
  were rerun, and the driver now relaunches when no session exists.
- **The model skipped the tool.** Three times Haiku replied "GOT:" with an invented answer and never called
  `AskUserQuestion`. These runs were caught because no hook fired, and were rerun.
- **The model mistyped a path.** In one `df_protected_git_write` run Haiku wrote to a misspelt directory
  under `/tmp`. The stray directory held only the probe file and was removed; the run was repeated.
- **Early `Stop` with background subagents.** The first `*_sub_bg_bash` runs read the file at the first
  `Stop`, too soon. The driver now waits for the subagent's own stop.
- **Keys sent to the wrong dialog.** `df_elicit_*` first typed the form's keys into the MCP call's approval
  dialog, so those runs were replaced.
- **Results written under `$HOME`.** A shell slip (`cd $SC` with `SC` unset) ran one batch with the home
  folder as the probe directory, creating `~/results`, `~/proj1`-`4`, `~/flag-settings.json` and four logs.
  None existed before. They were moved out, and the valid results merged in. Those runs still used
  private sockets and project-only settings, with Bash commands confined to those scratch folders.

## Side effects on this machine

- Claude Code recorded folder trust in `~/.claude.json` and transcripts under `~/.claude/projects/` for the
  scratch folders, as in #157.
- `~/.claude/settings.json` was not edited by this work. Its hash did change between the first reading and the
  first launch (modified 21:42:17; the first project was created at 21:43), by something else on the machine.
  It stayed the same through every run. The bypass warning that would write there was avoided by passing
  `skipDangerousModePermissionPrompt` in a `--settings` file, and the driver refuses to accept that warning.

## Sources

- The real binary through [`fixtures/approvals-bypass/`](fixtures/approvals-bypass/), whose hook comes from #157's harness.
- [Permission modes](https://code.claude.com/docs/en/permission-modes.md),
  [hooks](https://code.claude.com/docs/en/hooks.md) and
  [permissions](https://code.claude.com/docs/en/permissions.md), read 2026-11-02.

## Running it again

```sh
mkdir -p "$PROBE_DIR"
F=docs/research/fixtures/approvals-bypass
python3 $F/drive.py "$PROBE_DIR" 0 0 list
python3 $F/drive.py "$PROBE_DIR" 1 1 by_bash_pass by_auq_pr_answer   # socket probe161w1, trial 1
python3 $F/summarize.py "$PROBE_DIR" by_
```

`PROBE_DIR` must be set and absolute. The driver only uses `tmux -L probe161w<worker>`, spends model turns on
Haiku, and records folder trust as above. Committed evidence has paths normalized and no `screen-start`
captures. Each `results/<case>/t<trial>/` holds `result.json`, `case.json` and the captured screens.
