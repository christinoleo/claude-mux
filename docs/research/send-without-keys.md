# Whether text can reach a session without send-keys

Research note, 2026-11-01, for [#158](https://github.com/christinoleo/claude-mux/issues/158)
(map [#155](https://github.com/christinoleo/claude-mux/issues/155)). The question: is
there a supported way to give a running interactive session text without
`tmux send-keys`? For each route: is it supported, does it deliver into a live session
both idle and busy, and does it report that the text was taken?

## Short answer

**`send-keys` stays as the way a person's message reaches a session, but its worst bugs
are in how we call tmux, and they can be fixed.** Four routes do deliver text without
keystrokes. Only one of them, a mod calling `$.prompt.submit`, delivers the text as the
user's own words and reports the outcome, and it cannot replace `send-keys` alone: it
waits for idle, so it cannot steer, and it is refused after Esc until someone types at
the prompt.

| Route | Status | Idle | Busy | Says it was taken | The model reads it as | Slash commands |
| :- | :- | :- | :- | :- | :- | :- |
| Paste and Enter (today) | tmux, not a Claude Code API | Yes | Yes, queued | No; we infer it | The user | Yes |
| Mod `$.prompt.submit({ asUser: true })` | **Documented** | Yes, new turn | Waits for idle | **Yes**: result or `{ drop }` | The user | Refused; `$.command.run` works |
| Inbox socket | Socket, path and auth line **documented**; message format **undocumented** | Yes, new turn | Yes, between tool calls | **No**: the socket never replies | **Another session, not the user** | Plain text |
| Channel | **Research preview**, needs a dangerous flag | Yes, new turn | Yes, at a tool boundary | **No**, and the docs say so | An outside source, sometimes ignored | Plain text |
| `PostToolUse` `additionalContext` | Documented | No | At tool boundaries only | No | Added context | n/a |
| `asyncRewake` hook | Documented | Yes | Not tested | No | System reminder | n/a |
| `UserPromptSubmit` | Documented | **Cannot start anything** | Same | n/a | Added context | n/a |

Everything in the table was run live on Claude Code 2.1.309 and tmux 3.8, except the
empty cells and `UserPromptSubmit`, which no test tried to trigger from outside. No test
ran claude-mux itself; the scripts make the same tmux calls as `sendTextToPane`.

## What is wrong with delivery today

The issue says delivery failures keep returning. Most of what I could reproduce comes
down to a missing flag. `sendTextToPane` (`src/server/message-queue.ts`) runs
`paste-buffer` without `-p`, so tmux sends the text as plain input with each newline
turned into a carriage return, instead of as a bracketed paste. Claude Code then has to
guess what is pasted and what is typed.

Each cell counts sends that arrived whole on the first Enter. "Now" is today's call
sequence; "`-p`" is the same sequence with bracketed paste. Idle runs had 12 sends per
cell; busy runs had 8, while a foreground tool ran. A hook blocked the prompts in the
idle runs so none reached the model.

| Message | Idle, now | Idle, `-p` | Busy, now | Busy, `-p` |
| :- | :- | :- | :- | :- |
| One short line | 12 | 12 | 7 of 7 (see below) | 8 |
| Two short lines | **0: split into two prompts** | 12 | **0: split into two messages** | 8 |
| Five lines | **0 of 4: first Enter lost** | not run | **0: first Enter lost** | 8 |
| Ten lines | **0: first Enter lost** | 12 | **0: first Enter lost** | 8 |
| Forty lines | not run | not run | 8 | 8 |
| 200 lines | 12 | 12 | not run | not run |
| 6,000 characters on one line | 12 | 12 | not run | not run |

Counts of a bracketed or long paste include those that arrived inside Claude Code's
`<pasted_content>` wrapper with the full text intact. In a separate idle run of 4 sends
each, unbracketed messages of 3, 4, 5, 6, 8, 10, 14, 20 and 30 lines all lost the first
Enter, which is where the five-line idle figure comes from. Messages long enough for
Claude Code to detect the paste by themselves, such as 800 or more characters on one
line, are fine.

Four bugs follow, the first two measured directly:

1. **A two-line message becomes two messages.** The first line starts a turn and the
   second arrives on its own. This is not retried or reported: `confirmSubmitted` sees
   an empty box and answers `taken`.
2. **A short multi-line message loses its Enter every time, and the retry does not
   always save it.** This is the "Enter folded into the paste" that #149 worked around.
   The Enter sent at 1.5s by `confirmSubmitted` recovers it, so such a message always
   arrives late. While busy, a five-line message was still in the box after the retry in
   3 of 8 sends. In the product that would surface as "Claude Code did not take the
   message". Linking the earlier reports to this is an inference, because the original
   messages are gone. The one report that names its cause, #152, is a different bug: a
   slow redraw in a long session, which I did not reproduce and which #152 addressed.
3. **A message sent to an open permission dialog answers it.** With a dialog open, I
   pasted "please stop, do not run that" and pressed Enter. The dialog took the Enter on
   its default, "Yes", and the command ran ([results/t12.txt](fixtures/send-without-keys/results/t12.txt)).
   In code, `drainQueues` reads the pane first with `paneHold`, but `submitToPane`, used
   by the send and steer routes, returns from `readPromptBox` and pastes when there is
   no box to read. No server check stops it. Sessions launched with the default
   `--dangerously-skip-permissions` rarely show this dialog; the same Enter applies to
   any other dialog that accepts one. I did not test whether the web UI hides the
   composer while a dialog is up.
4. **A shared buffer name.** Every send loads the tmux buffer `claude-mux-input`. A dev
   server and the systemd server on one tmux server could paste each other's text. This
   comes from reading the code; it was not observed.

### Fixes that keep send-keys

These are suggestions for the map, and none has been made:

- Add `-p` to `paste-buffer`. It fixed bugs 1 and 2 in all the cells above. tmux only
  adds the brackets if the application asked for them, so this should be safe for other
  agents, but I did not test Codex.
- Refuse to paste when `readPaneHold`-style checks or the hooks show a dialog, in
  `submitToPane` as well as in `drainQueues`.
- Use a unique buffer name per send, and `paste-buffer -d` to remove it.
- Confirm from the transcript first and the box second. A `queue-operation` `enqueue`
  record appeared 0.15 to 0.22s after each send that was taken while busy, in tool and
  no-tool turns ([t9](fixtures/send-without-keys/results/t9.txt),
  [t10](fixtures/send-without-keys/results/t10.txt)). `confirmSubmitted` already uses
  this as a secondary sign. `UserPromptSubmit` fires for prompts the model is about to
  read. Both are better evidence than the picture of the box.

## The routes without keystrokes

### Mods: `$.prompt.submit`

**Supported.** A mod is a plugin with a hooks module, available from v2.1.287
([create a mod](https://code.claude.com/docs/en/plugins/mods/create.md)).
[Start a turn from a background job](https://code.claude.com/docs/en/plugins/mods/api.md#start-a-turn-from-a-background-job)
documents `$.prompt.submit({ text })` and `asUser: true`. "The call waits until the
session is idle and then starts a new turn." A refusal
[resolves with `{ drop: '<reason>' }`](https://code.claude.com/docs/en/plugins/mods/api.md#what-refused-calls-return).
The docs also warn that "the events and methods can change between releases", and that
[Anthropic can turn installed mods off remotely](https://code.claude.com/docs/en/plugins/mods/troubleshoot.md#check-whether-mods-can-load).

**The probe.** A small mod ([fixtures/.../mod](fixtures/send-without-keys/mod/)) spawns a
child with `$.process.spawn` that listens on a Unix socket of ours and prints each line.
The mod submits each line and records the outcome. Results in
[results/t3.txt](fixtures/send-without-keys/results/t3.txt) and
[results/t5.txt](fixtures/send-without-keys/results/t5.txt):

- **Idle:** in the transcript within 0.3s; the call resolved at about 0.1s, when the
  turn started.
- **Busy:** logged as queued at once. The call resolved only when the turn ended, 11.9s
  later, and the text then ran as its own turn. It does not reach the model mid-turn.
- **Reads as the user's:** no framing sentence in the prompt. The terminal does label it
  "Prompt from the mux-inbox-probe plugin", and the transcript records
  `origin: {kind: "plugin", asUser: true}`. Without `asUser` the model gets a sentence
  that names the plugin.
- **A half-typed draft survives.** Text in the prompt box stayed put while the prompt
  ran, which pasting cannot do.
- **An open permission dialog is safe.** The prompt waited behind the dialog, did not
  answer it, and ran after it closed.
- **Large text:** 7,954 characters over 400 lines arrived intact. Three prompts queued
  while busy ran in order but as one turn, like Claude Code's own queue.
- **Failure is visible.** A prompt queued when the user pressed Esc resolved with
  `{ drop: 'the prompt was removed from the queue before it ran' }`. A dead session
  gives `ECONNREFUSED` on our socket.
- **Commands:** text starting with `/` is rejected ("a text beginning with / would run a
  command as the user"). `$.command.run({ command: 'rename', args })` ran `/rename` and
  returned its result, with no turn.

**What stops it replacing send-keys:**

- **No steering.** Steer depends on text reaching the model during a turn.
- **Refused after Esc.** After an interrupt, `$.prompt.submit` resolved with
  `{ drop: 'the session was stopped and nobody has sent input since' }` until a prompt
  was typed in the pane. Pressing Esc and sending a correction is a daily flow, so it
  would need send-keys anyway. This is
  [documented](https://code.claude.com/docs/en/plugins/mods/api.md#calls-and-background-work-after-the-user-interrupts-a-turn).
- **Attachments.** `composePromptWithAttachments` relies on `@path`, and the generated
  types say "`@file` mentions and pasted images are not expanded for a plugin's prompt,
  `asUser` or not". Not tested live.
- **The Transcript would hide it.** `feedUser` in `src/transcript/parser.ts` drops user
  lines whose `origin.kind` is neither `human` nor `peer`. The parser would need a change.
- **Every session must load it.** That means `--plugin-dir` in every launch and restart
  path, or an installed plugin, plus one listener per session. How `claude-mux` would
  address that listener is an open design question.

Where it fits best is the queue. `drainQueues` already waits for idle and guesses from
the pane, and this call does that waiting itself and reports the result. Whether that
gain is worth a second delivery path is a decision for the map.

### The inbox socket

**Partly documented, and easy to get wrong.** The
[session's inbox socket](https://code.claude.com/docs/en/cross-session-messaging.md#the-sessions-inbox-socket)
section is written for when "you want a script or hook to post into a session". The
docs cover the socket, `CLAUDE_CODE_MESSAGING_SOCKET`, the
`{"type":"auth","token":"<token>"}` line, the 30-second close and the inbound controls.
**They do not give the format of the message line.** I learned it by having a session I
started send `SendMessage` to a fake socket
([results/frame-sample.jsonl](fixtures/send-without-keys/results/frame-sample.jsonl)):

```json
{"msgV":1,"msg_id":"…","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:…\" from-name=\"…\" from-mode=\"prompting\">\n…\n</cross-session-message>"},"priority":"next","from":"uds:…"}
```

That shape is **observed, not supported**. A release could change it, and nothing
promises otherwise.

Results, all on sessions I started ([results/t2.txt](fixtures/send-without-keys/results/t2.txt)):

- **Idle:** a new turn. Timing is only known to within 1.5s, because the script waited
  that long for a reply before checking.
- **Busy, tool running:** logged as `enqueue` at once and read at the next tool boundary,
  as [documented](https://code.claude.com/docs/en/cross-session-messaging.md#message-delivery).
- **Busy, no tool:** delivered as a new turn once the reply finished.
- **No reply, ever.** The connection returned nothing for a delivered message, a plain
  text line, malformed JSON, or a message held by `crossSessionInbound: "hold"`. **The
  plain line and the bad JSON were dropped with no sign at all.** The only external
  evidence is the transcript, where `origin.msg_id` does match the id you sent. A dead
  session gives `ENOENT`.

**Why it is the wrong route for a person's messages:**

- **It says the message is not from the user.** The model is told: "This came from
  another Claude session — not typed by your user", and that it must not treat the text
  as approval or change configuration because of it. Leaving out the wrapper did not
  avoid this; the framing is added on receipt. These
  [limits are documented](https://code.claude.com/docs/en/cross-session-messaging.md#how-a-session-treats-an-incoming-message)
  and intended.
- **Commands do not run.** `/rename` arrives as text, so claude-mux's control messages
  would stop working.
- **It is held by default in claude-mux's sessions.** `src/agents.ts` launches with
  `--dangerously-skip-permissions`. The docs say a
  [session that bypasses permissions holds each message](https://code.claude.com/docs/en/cross-session-messaging.md#control-inbound-messages)
  for approval in a dialog, unless the sender identifies itself as also bypassing. **I did
  not test this**, because the probe stayed in `default` mode as instructed. Setting
  `crossSessionInbound: "accept"` avoids the dialog, but for every peer. Writing
  `from-mode` to claim a class we do not have would forge a safety input, and nobody
  should do that.

It suits what it was built for: one agent telling another something. That could be useful
to maestro-style workers, as a separate question.

### Channels

**Research preview.** The
[docs](https://code.claude.com/docs/en/channels.md#research-preview) say the flag syntax
and protocol "may change". Only allowlisted plugins can use `--channels`; anything else
needs `--dangerously-load-development-channels`, whose startup warning needs a keystroke
([results/t5b.txt](fixtures/send-without-keys/results/t5b.txt)). They need claude.ai or
Console authentication, and an organization must enable them. On acknowledgement the
[reference](https://code.claude.com/docs/en/channels-reference.md#notification-format) is
blunt: "Claude Code doesn't acknowledge notifications."

A small hand-written MCP server delivered in both states
([results/t4.txt](fixtures/send-without-keys/results/t4.txt)): idle within 0.3s, and busy
at a tool boundary. **But the model treated the text as coming from outside.** In the busy
test it said the message "came from that channel, not from you, so I ignored it", and it
refused a `/rename` for the same reason. Not usable for a person's messages.

### Hooks

- **`UserPromptSubmit`** runs when a prompt is submitted and
  [can block it or add context](https://code.claude.com/docs/en/hooks.md#userpromptsubmit-decision-control).
  It cannot start anything. It did fire for every delivered prompt, including socket and
  mod ones, which makes it useful as evidence of delivery.
- **`PostToolUse` `additionalContext`** is documented. A hook reading a mailbox file got
  text to the model mid-turn, and the model acted on it
  ([results/t5.txt](fixtures/send-without-keys/results/t5.txt)). It only fires when a tool
  finishes, so a text-only turn or an idle session gets nothing, and it gives no
  acknowledgement. It is the one documented, non-peer way I found to reach a running
  turn, so it is a candidate if steering ever moves off send-keys. It would be added
  context rather than a user message.
- **`asyncRewake`** is [documented](https://code.claude.com/docs/en/hooks.md#run-hooks-in-the-background).
  A hook held open from `SessionStart` woke an idle session about 2s after the mailbox
  file appeared. The text arrives as a system reminder under the odd label "Stop hook
  feedback". It has a timeout and is meant for background failures. A misuse here.

### Ruled out from the docs, not run

- **Remote Control** drives a session from claude.ai or the Claude app. It goes through
  Anthropic's servers and needs a claude.ai sign-in, and I found no scripting interface
  in [its docs](https://code.claude.com/docs/en/remote-control.md).
- **Agent view** can [reply from its peek panel](https://code.claude.com/docs/en/agent-view.md#peek-and-reply),
  which is a screen for a person, and only for background sessions.
- **`--input-format stream-json`** with `--replay-user-messages`
  ([CLI reference](https://code.claude.com/docs/en/cli-reference.md)) does acknowledge
  input, but only in `-p` runs, not a live TUI. `docs/adr/0003` already rejected that shape.
- **`$.session.send`** makes [the same delivery as `SendMessage`](https://code.claude.com/docs/en/plugins/mods/api.md#send-and-receive-messages-between-sessions),
  so it reads as a peer. It does report `{ isDelivered, reason }`. **`$.prompt.fill`** puts
  a draft in the box and reports `isFilled`; it does not submit. Neither was run.

## Limits of this research

- **Not tested:** a session in `bypassPermissions`; the token auth line, since I did not
  read token values and it is optional on Linux; macOS and Windows; the slow redraw of a
  very long session; Codex; the real claude-mux server and web UI.
- **Sample sizes are small:** 8 to 12 sends per cell. The failures were all-or-nothing,
  but a rare failure would not show up.
- **Blocked prompts return to the box.** In the idle runs the hook blocks each prompt and
  Claude Code restores it, so the script clears the box between sends. That is why the
  two-line row in `t7.txt` shows a third prompt after the retry; it is an artifact.
- **Results I threw out.** Three busy runs were invalid. The harness blocks a long
  standalone `sleep`, so a `sleep 70` turn ended early and the "busy" sends went to an
  idle session. That covers the second half of `t7.txt` (kept only for its threshold
  section) and two runs whose results are not in the fixtures. The valid busy data is in
  `t10.txt`, whose script checks that the tool is still running.
- **The first send in `t10.txt`.** The "7 of 7" in the table excludes the first send: the
  probe had no allow rule in force for that command, so a permission dialog was open and
  the send answered it. That is how bug 3 was found, and `t12.txt` then tested it directly.
- **An accident in one probe session.** In `t5.txt`, my keystrokes picked "Yes, and switch
  to auto mode" on a dialog, so the rest of that probe session ran in auto mode. It
  affected only the mod's large-text and queue-order checks, neither of which depends on
  the mode. `~/.claude/settings.json` was last modified before that step.

## Sources

| Source | Version |
| :- | :- |
| Claude Code | 2.1.309, installed; not upgraded |
| Claude Code docs | <https://code.claude.com/docs/en/>, read 2026-11-01, which describe newer releases too |
| Generated mod types | `.claude-plugin/types/claude-code/index.d.ts`, written by 2.1.309 when a mod loads |
| claude-mux | `origin/main` at `acdf730`; `src/server/message-queue.ts`, `src/tmux/pane.ts`, `src/transcript/parser.ts`, the send and steer routes; PRs #149 and #152 |
| tmux | 3.8 |

Scripts and raw output are in [fixtures/send-without-keys/](fixtures/send-without-keys/).
They ran on a private tmux socket, with `--setting-sources project`, `--model haiku`,
`--permission-mode default` and inherited `CLAUDE*` variables unset, except where a test
needed one more flag (`--plugin-dir`, `--mcp-config`, a `--settings` value). Paths in them
were rewritten to `$PROBE` and `$SCRATCH`. Only sockets of sessions the scripts started
were touched, and no token value was read.
