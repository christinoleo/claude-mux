# What Codex's screen looks like, and how text reaches it

Research for [#143](https://github.com/christinoleo/claude-mux/issues/143), part of the map
[#140](https://github.com/christinoleo/claude-mux/issues/140).

## Short answer

Codex draws a full-screen ratatui app on the alternate screen. claude-mux finds Claude Code's
prompt box between two `─────` rules, and Codex draws no such rules. Its input box is the last row
that starts with a **bold `›`** (SGR `1`), with the text two columns in. An empty box shows the
placeholder `Ask Codex to do anything` in **dim** (SGR `2`). Typed text is unstyled, and a prompt
already sent in the transcript starts with a **bold and dim** `› ` (SGR `1;2`). While a turn runs, a
status row sits above the box: `• Working (12s • esc to interrupt)`. Messages typed during the turn
are listed between that row and the box, under fixed headings. **Enter while busy steers** the
running turn: the message goes in after the next tool call. **Tab queues** the message for after
the turn. **Esc** interrupts. When steers are pending, Esc instead interrupts and sends them at
once. Approval dialogs replace the box with a numbered list: the selected row is `› ` in bold
reverse, each option carries a one-letter key (`y`, `p`, `a`, `d`, `n`/`esc`), and a digit picks a
row and confirms it.

Delivery is the part that has to change. claude-mux runs `tmux paste-buffer` **without `-p`**, so
Codex gets plain keystrokes and treats them as an unbracketed "paste burst". An Enter that arrives
within 120 ms of the last pasted character becomes a newline, not a submit. I checked this live: a
paste followed at once by Enter is not submitted. **`paste-buffer -p`** (bracketed paste, which
Codex turns on) followed at once by Enter submits reliably, multi-line text included. Waiting about
250 ms before the Enter also works. Do not send Claude's send-now chord `C-x C-s` to Codex. Do not
send `C-c` to an empty Codex box either: with nothing typed and no turn running, Ctrl+C quits
Codex.

## Sources and method

- **Source:** `openai/codex`, tag `rust-v0.160.0` (commit `a956835d`, 2026-10-01), the version
  installed on omarchy. I compared the strings and constants this note relies on against `main`
  at `e7de1f44` (2026-10-16), and they are unchanged there unless a section says otherwise. Paths
  below are relative to `codex-rs/tui/src/`.
- **Snapshots:** the insta `.snap` files in the `tui` crate are screens rendered by Codex's own
  test harness. I copied only snapshots whose test still exists in the tag. Some `.snap` files are
  orphans: for example, `snapshots/codex_tui__status_indicator_widget__tests__renders_with_queued_messages.snap`
  shows an older queue layout (`↳ first`, `alt + ↑ edit`) that no test renders any more. Ignore it.
- **Live probe:** I ran Codex 0.160.0 in a throwaway tmux session (`codex-probe`, 100×30) with a
  throwaway `CODEX_HOME`. It was **never logged in**. On a fresh home, Codex opens on the sign-in
  screen (`live/00-onboarding-signin.ansi`). To reach the chat screen without credentials, I
  pointed a custom model provider (`requires_openai_auth = false`) at a stub HTTP server on
  127.0.0.1. The stub either keeps the response stream open forever (so a turn stays busy) or
  answers one message with an `exec_command` call that asks for escalation (so the approval dialog
  opens). Every capture under `fixtures/codex-screen/live/` is a real `tmux capture-pane -e -p` of
  that session. The stub never streamed assistant text, so this note does not cover how assistant
  replies render.

## 1. The layout

Codex uses the alternate screen by default. `tui.alternate_screen` defaults to `auto`, which means
the alternate screen everywhere except Terminal.app over SSH, and `--no-alt-screen` turns it off
(`lib.rs`, `determine_alt_screen_mode`). In the probe, `#{alternate_on}` was `1`. A capture
therefore shows the whole live screen, not scrollback.

From the bottom of the screen up:

1. **Footer**, one or two rows indented two columns. One row is the status line (model, effort and
   cwd by default: `probe-model default · /tmp/…`). The other holds hints: `? for shortcuts`, `tab
   to queue message` while a draft exists during a turn, `esc again to edit previous message`, and
   so on. Context usage is right-aligned (`100% context left`), as is the warnings badge (`⚠ 1
   warning · f2 to view`).
2. A blank row.
3. **The input box**: the first row starts with the prompt glyph in column 0 and the text from
   column 2. Continuation rows are indented two spaces.
4. A blank row, then the **pending input preview** (steers and queued messages, §4) when any exist.
5. A blank row, then the **status row** while a turn runs (§3).
6. The transcript fills the rest of the screen upward.

When an approval or question view is open, it takes the place of the input box and its footer
(§5). Example: `live/03-busy.ansi`, `live/06-busy-steer-and-queue.ansi`, and
`snapshots/…status_and_queued_messages_snapshot.snap`.

## 2. The input box

Rendering is in `bottom_pane/chat_composer.rs` (around line 4925 in the tag):

| What | How it is drawn | Source |
|---|---|---|
| Prompt glyph | `›` in bold (`ESC[1m›ESC[0m`). With reasoning effort Max it is still `›` but coloured (yellow/orange); Ultra uses `»`; Luna Reserve uses a yellow `›` | `chat_composer.rs`; `bottom_pane/effort_ignition.rs` (`prompt_glyph`) |
| Shell mode | `!` in bold light red, after typing a leading `!` | `chat_composer.rs` |
| Input disabled | `›` dim, followed by the disabled placeholder (default `Input disabled.`; a sub-agent view shows `Viewing sub-agent — direct input is disabled`) | `chat_composer.rs` |
| Placeholder (empty box) | `Ask Codex to do anything` in **dim** (SGR 2), from column 2. A side conversation uses `Ask a follow-up question` | `chatwidget.rs` (`PLACEHOLDER`, `SIDE_PLACEHOLDER`) |
| Typed text | Unstyled: the default foreground with no modifier | live `02-idle-typed.ansi`: `ESC[1m›ESC[0m hello codex` |
| Large paste (over 1000 characters) | An atomic element `[Pasted Content 1200 chars]`, with `#2`, `#3` … added for repeats of the same size. It expands to the full text on submit | `chat_composer.rs` (`LARGE_PASTE_CHAR_THRESHOLD = 1000`); live `14-busy-large-paste.ansi` |
| Box background | The box is filled with a tint of the terminal background, but only when Codex can read that background colour. Under tmux in the probe it could not, and no `48;…` codes appear. Do not rely on the fill | `style.rs` (`user_message_style`); snapshot `light_terminal_palette_composer.snap` shows the fill when the colour is known |

**Placeholder or suggestion?** Codex has no faint "suggestion" text of the kind Claude Code
offers. The only dim text in the box is the placeholder, and the placeholder only shows when the
textarea is empty (`textarea_is_empty`). A `readPromptBox` for Codex can therefore apply the same
rule as for Claude, "dim means not typed", without a `suggestion` kind. I found no
suggestion feature in `chat_composer.rs` at the tag. This is unverified beyond that search.

**Telling the box from transcript prompts.** Sent prompts in the transcript use the same glyph,
but drawn as `› ` in bold and dim (`ESC[1;2m› ESC[0m`, `history_cell/messages.rs`; seen live in
`08-esc-interrupt.ansi`), or in red and bold for a dictated prompt. Look for the last bold-only `›`
row above the footer. `scanCells()` already tracks the faint flag, which is enough here: the
transcript's `›` is faint and the box's is not.

**Where the box ends.** The draft runs from the `›` row down to the blank row above the footer. A
draft that itself ends in blank lines cannot be told apart from that separator, which only matters
for trailing whitespace, and Codex trims that on submit (`trim_submission`).

## 3. Busy, interrupted, compaction

**The status row** (`status_indicator_widget.rs`, `StatusIndicator::lines`):

```
• Working (12s • esc to interrupt)
```

- The leading `•` is the activity indicator. With true colour it shimmers. Otherwise it blinks
  between `•` and a dim `◦` every 600 ms (`motion.rs`, `animated_activity_indicator`). With reduced
  motion (`tui.animations = false`) it is **left out**, and the row starts at the header.
- The header is `Working` by default but changes with the work: `Analyzing`, `Compacting context`,
  `Investigating rendering code`, a hook's status, and others (snapshots `status_widget_active`,
  `manual_compaction_pending`, `chatwidget_exec_and_status_layout_vt100_snapshot`). Do not match
  the word.
- The stable part is the dim parenthesis: `(<elapsed> • <interrupt key> to interrupt)`. The elapsed
  time comes from `fmt_elapsed_compact` (`0s`, `1m 00s`, `1h 00m 00s`). The interrupt key is `esc`
  by default and can be remapped (`tui.keymap.chat.interrupt_turn`). When no interrupt hint is
  shown, the row reads `(12s)`. Optional context follows after ` · `. Details may follow on rows
  starting `  └ `.
- A detector: a row matching `^(?:[•◦] )?\S.*? \((?:\d+h )?(?:\d+m )?\d+s(?: • .+ to interrupt)?\)`
  above the input box.

**The terminal title is a second signal.** It is set by OSC 0/2, and tmux shows it as
`#{pane_title}`. By default it is made of the `activity`, `thread-name` and `project-name` items
(`chatwidget/status_surfaces.rs`, `DEFAULT_TERMINAL_TITLE_ITEMS`). While busy it starts with a
braille spinner frame (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`). While an approval or question waits, it is
`[ ! ] Action Required | …`, blinking to `[ . ] Action Required` every second. Seen live: `⠇ ⠇ |
work` while busy, then `[ ! ] Action Required | ⠇ | work` with the dialog open. The title items are
configurable (`tui.terminal_title`), so treat the title as a hint, not a source of truth.

**An interrupted turn** (`chatwidget/input_restore.rs`, `on_interrupted_turn`) adds this row to the
transcript:

```
■ Conversation interrupted - use /feedback if something went wrong
```

It is drawn in the secondary text colour (`secondary_text_style`). If steers were pending and Esc
was pressed to send them now, the row is instead `• Model interrupted to submit steer
instructions.` (snapshots `interrupted_turn_error_message`, `interrupted_turn_pending_steers_message`;
live `07-esc-with-steer.ansi`, `08-esc-interrupt.ansi`). A budget stop reads `Goal budget reached -
the turn was stopped.`

On an interrupt, **queued messages are not sent**. They are put back into the input box, joined by
newlines (`restore_composer_state`). Seen live: after Esc, `queued with tab` sat in the box as a
typed draft (`08-esc-interrupt.ansi`). claude-mux's queue drain must therefore expect a typed box
after an interrupt, and its `typed` hold covers that case.

Declining an approval with Esc/`n` ("No, and tell Codex what to do differently") also ends the
turn. Live, it left `✗ You canceled the request to run …` followed by the interrupted row
(`17-approval-declined.ansi`).

## 4. Messages typed while busy, the queue, and steering

The keys are `submit = Enter` and `queue = Tab` (`keymap.rs`, `ComposerKeymap`). The rules are
written in the module doc of `chat_composer.rs`, and the routing is in
`chatwidget/input_flow.rs`, `handle_composer_input_result`:

- **Enter while a turn runs** submits through `turn/steer` (`app_server_session.rs`). The message
  becomes a *pending steer*, which the model reads after its next tool call.
- **Tab while a turn runs** keeps the message in Codex's own queue. It is sent as the next turn
  when this one ends.
- **Tab while idle** submits, the same as Enter, so input is never dropped. Tab does not submit a
  `!` shell command.
- **Esc while steers are pending** interrupts and sends them at once as a new turn ("press esc to
  interrupt and send immediately").
- **Esc with no pending steers** interrupts the turn, and queued messages return to the box (§3).
- **Shift+← or Alt+↑** pulls the last queued message back into the box for editing
  (`edit_queued_message`).

The preview between the status row and the box (`bottom_pane/pending_input_preview.rs`) lists
three sections in this order, each section headed by a dim `• `:

```
• Messages to be submitted after next tool call (press esc to interrupt and send immediately)
  ↳ typed while busy

• Messages to be submitted at end of turn
  ↳ Rejected steer that will be retried.

• Queued follow-up inputs
  ↳ queued with tab
    shift+← edit last queued message
```

- Pending steers: the heading is plain, the `(press esc …)` part dim with `esc` bold, and each item
  is `  ↳ ` plus the text, **dim**.
- Rejected steers (for example, steers sent during `/review` or `/compact`, which those turns do
  not accept) are listed under `Messages to be submitted at end of turn`.
- Queued messages: each item is `  ↳ ` plus the text in **dim italic** (SGR `2;3`). The section
  ends with an edit hint of four spaces, the binding in bold, and ` edit last queued message` in dim.
- Each item shows at most 3 wrapped lines, then `    …` (`PREVIEW_LINE_LIMIT`). A large paste shows
  as its `[Pasted Content N chars]` label (snapshot `hidden_shell_paste_queued_preview`).
- When the screen is narrow, the steer heading wraps with a two-space indent (snapshot
  `render_pending_steers_above_queued_messages`, 52 columns). At 100 columns it stays on one line
  (live `06-busy-steer-and-queue.ansi`).

Fixtures: `live/05-busy-steer.ansi`, `live/06-busy-steer-and-queue.ansi`,
`live/15-busy-large-paste-steer.ansi`, `snapshots/…render_pending_steers_above_queued_messages.snap`
(with styles), and `snapshots/…compact_queues_user_messages_snapshot.snap` (a rejected steer).

**What this means for claude-mux's verbs:**

| Verb | Claude Code | Codex |
|---|---|---|
| `send` | paste, then Enter | paste, then Enter, while idle |
| `queue` | claude-mux's own queue | claude-mux's own queue, unchanged. Codex's Tab queue could be used instead, but its items return to the box on an interrupt |
| `steer` | paste, then Enter while busy (Claude queues it) | paste, then Enter while busy: a Codex steer, read after the next tool call |
| `now` | steer, then `C-x C-s` | steer, wait until the item shows under "Messages to be submitted after next tool call", then **Esc**. If Esc lands before the steer is registered, it is a plain interrupt (unverified race) |

**Never send `C-x C-s` to Codex.** In 0.160.0, Ctrl+X toggles voice mute (`toggle_voice_mute`;
it moves to F9 on `main`), and Ctrl+S steps forward through history search
(`history_search_next`).

## 5. Approval and question dialogs

**Approvals** (`bottom_pane/approval_overlay.rs`, built on `list_selection_view.rs`) replace the
input box. Each starts with a bold title:

- `Would you like to run the following command?`
- `Would you like to send input to the existing terminal?` / `… to terminal <id>?`
- `Would you like to make the following edits?`
- `Would you like to grant these permissions?`

The title is followed by context lines (`Environment: local`, `Reason: <italic justification>`,
`$ <command>` with syntax colouring), then the numbered options and the footer hint:

```
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `touch /etc/probe-file` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

- The selected row starts with `› ` and is drawn in **bold reverse** (`ESC[1;7m`). The other rows
  start with two spaces and draw their key letter in bold (live `16-approval.ansi`).
- Default keys (`keymap.rs`, `ApprovalKeymap`): `y` approve, `a` approve for the session, `p`
  approve the command prefix, `d` deny ("No, continue without running it"), `esc`/`n` decline
  ("No, and tell Codex …", which ends the turn), `c` cancel (MCP elicitation), and Ctrl+A to open
  the full-screen view. Each option names its own key in parentheses, so read the key off the row
  rather than assume it.
- A digit selects that row and confirms it in one keystroke, unless the item needs explicit
  confirmation (`list_selection_view.rs`, `select_shortcut`). Arrows plus Enter also work.
- The options vary by request. Network requests offer `Yes, just this once`, `Yes, and allow this
  host for this conversation` and `… in the future`. Permission requests offer `Yes, grant these
  permissions for this turn` and similar (snapshots `exec_approval_modal_exec`,
  `status_widget_and_approval_modal`, `approval_modal_patch`).
- No status row is drawn while the dialog is open (live `16-approval.ansi`).

**Questions** (the `request_user_input` tool, `bottom_pane/request_user_input/`) are Codex's
version of AskUserQuestion:

```
  Question 1/2 (2 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.

  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt
```

The rows are indented two columns, with `› ` marking the selection, and each description sits in
a column to the right of its label. A digit picks an option (`option_index_for_digit`), and a
free-form question shows `› Type your answer (optional)`. See snapshots `request_user_input_options`,
`…multi_question_first` and `…freeform`.

For `readPromptOptions()`: its `OPTION_ROW` pattern expects `❯` or `>` and would not match Codex's
`›`. The footer hints differ too (`Press enter to confirm or esc to cancel`, `enter to submit
answer | … | esc to interrupt`). A Codex reader needs its own patterns, but the same strategy works:
find the last run of rows numbered 1, 2, 3 above a known hint.

## 6. The update notice

At startup, when a newer release exists, Codex puts a boxed cell at the top of the transcript
(`history_cell`, snapshot `standalone_unix_update_available_history_cell_snapshot`; live
`01-idle-empty.ansi`):

```
╭─────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ✨ Update available! 0.0.0 -> 9.9.9                                                                 │
│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' to update. │
│                                                                                                     │
│ See full release notes:                                                                             │
│ https://github.com/openai/codex/releases/latest                                                     │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The URLs in it are OSC 8 hyperlinks (`ESC]8;;<url>ESC\`), and `capture-pane -e` keeps them (live
`01-idle-empty.ansi`). claude-mux's `stripAnsi()` and `scanCells()` already skip OSC sequences, so
nothing new is needed there.

When Codex does not know how it was installed (the probe's mise install, for example), the second
line is `See https://github.com/openai/codex for installation options.` The commands it can name
come from `update_action.rs` (`command_args`): `npm install -g @openai/codex`, `bun install -g
@openai/codex`, `pnpm add -g @openai/codex`, `vp install -g @openai/codex`, `brew upgrade --cask
codex`, the standalone `curl … install.sh | sh` installer, and a daemon variant. There is also a
modal update prompt (`update_prompt.rs`, snapshot `update_prompt_modal`) whose options are `Update
now (runs \`npm install -g @openai/codex\`)`, `Skip` and `Skip until next version`.

This notice is a transcript cell, not a footer item, so it scrolls away once the session has run
for a while. `readUpdateNotice()` would need a Codex branch that looks for the `✨ Update
available!` box anywhere on screen, plus an allowlist of the commands above.

## 7. Delivering text

**What Codex does with input.** At startup Codex turns on bracketed paste
(`tui.rs`: `execute!(stdout(), EnableBracketedPaste)`). A bracketed paste arrives as one
`Event::Paste`, and `apply_paste` (`bottom_pane/chat_composer/paste_input.rs`) inserts it and then
calls `clear_after_explicit_paste()`, which clears every paste-burst timer. The next Enter is an
ordinary submit.

Without bracketed paste, the characters arrive one by one. `bottom_pane/paste_burst.rs` then groups
fast keystrokes into a "burst": characters less than 8 ms apart count as pasted. **Any Enter while
a burst is active, or within `PASTE_ENTER_SUPPRESS_WINDOW` = 120 ms of the last burst character,
inserts a newline instead of submitting** (`newline_should_insert_instead_of_submit`, used from
`chat_composer/reconnect.rs`, `handle_paste_enter`). The one exception is a draft whose first line
starts with `/`: there Enter still submits.

**What claude-mux sends today.** `sendTextToPane()` runs `tmux load-buffer`, then `tmux
paste-buffer` **without `-p`**, then `send-keys Enter`, with no wait between them. Without `-p`,
tmux types the buffer into the pane as plain input, turns each newline into a CR, and never
brackets it. Codex therefore sees a burst, and the Enter right after it lands inside the 120 ms
window.

**Live results** (Codex 0.160.0 in tmux; captures in `fixtures/codex-screen/live/`):

| Delivery | Result | Capture |
|---|---|---|
| `paste-buffer` (no `-p`), one line, Enter at once | **Not submitted.** The Enter became a newline, and the text sat in the box with an empty second line | `09-plainpaste-single-enter.ansi` |
| Same, then a second Enter about 1.5 s later (what `confirmSubmitted()` does) | Submitted. The extra newline was trimmed, and the transcript shows one line | `10-plainpaste-second-enter.ansi` |
| `paste-buffer` (no `-p`), two lines, Enter at once | **Not submitted** (two lines plus a blank one in the box) | `12-plainpaste-multiline-enter.ansi` |
| `paste-buffer` (no `-p`), two lines, wait 250 ms, then Enter | Submitted as one two-line message | `13-plainpaste-wait-enter.ansi` |
| **`paste-buffer -p`**, two lines, Enter at once | **Submitted** as one two-line message | `11-bracketed-multiline-enter.ansi` |
| `paste-buffer -p`, 1200 characters, while busy | The box shows `[Pasted Content 1200 chars]`. Enter then turned it into a steer | `14-…`, `15-busy-large-paste-steer.ansi` |

**Recommendation for the Codex adapter:** send with `tmux paste-buffer -p` and then Enter. Keep
`confirmSubmitted()` as a safety net, since its second Enter also works. Do not deliver multi-line
text by typing it with `send-keys`: each newline would be an Enter, and outside a detected burst
each one would submit a separate message. The same risk applies if a user sets
`tui.disable_paste_burst = true`, which turns off the newline protection for unbracketed input.

**No key sends at once while idle.** Enter is the submit key, and Tab submits too when no turn is
running. While busy, Esc is the "send pending steers now" key (§4).

**Keys to avoid:**

- `C-c` on an empty box with no turn running **quits Codex immediately**
  (`DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED = false` in `bottom_pane/mod.rs`; it happened during the
  probe). With text in the box, `C-c` clears it.
- A stray Esc on an idle, empty box arms "esc again to edit previous message", and a second Esc
  opens backtracking.
- `C-x C-s`: see §4.

## 8. claude-mux function by function

| claude-mux (`src/tmux/pane.ts`, `src/server/message-queue.ts`) | Codex equivalent |
|---|---|
| `readPromptBox()`: text between the last two `─────` rules; a faint run means a suggestion or hint | The last row starting with a bold-only `›`/`»`/`!` above the footer, with text from column 2 and continuation rows indented two. Dim text means the placeholder. There is no suggestion kind |
| `readQueuedMessages()`: rows above the spinner or above the box | The `pending_input_preview` sections in §4: dim `↳` items are steers, dim italic `↳` items are queued |
| `readPromptOptions()`: numbered rows with `❯` | Numbered rows with `›` in bold reverse, closed by `Press enter to confirm or esc to cancel` (approvals) or `… enter to submit answer … esc to interrupt` (questions) |
| `checkForInterruption()` / `detectRecentInterruption()`: "Interrupted", "User declined" | The `■ Conversation interrupted - use /feedback if something went wrong` row, or `• Model interrupted to submit steer instructions.` |
| `readPaneHold()` / spinner (`ACTIVITY_LINE`) | The status row in §3, and a braille spinner in `#{pane_title}`; `typed` when the box holds unstyled text; `queued` when the preview lists items |
| `readUpdateNotice()`: the footer, or right-aligned above the box | The `✨ Update available! A -> B` box in the transcript, plus the modal prompt; commands come from `update_action.rs` |
| `sendTextToPane()`: paste, then Enter | `paste-buffer -p`, then Enter |
| `confirmSubmitted()` | Works as is. A taken message leaves the box; while busy it shows up as a steer in the preview |
| `sendNowInPane()`: `C-x C-s` | Esc, but only once the steer is visible as pending |

## Fixtures

All under `docs/research/fixtures/codex-screen/`.

**`live/`**: real captures from Codex 0.160.0, taken with `tmux capture-pane -e -p` at 100×30,
alternate screen, true colour. Each one is the raw ANSI exactly as captured. The status line holds
the probe's scratch path, truncated with `…`. The model name `probe-model` comes from the stub
provider.

| File | Shows |
|---|---|
| `00-onboarding-signin.ansi` | A fresh home with no login: the sign-in picker (`> 1. Sign in with ChatGPT`) |
| `01-idle-empty.ansi` | The idle screen: update box, header, placeholder, footer |
| `02-idle-typed.ansi` | `hello codex` typed in the box |
| `03-busy.ansi` | Status row `• Working (2s • esc to interrupt)` with an empty box |
| `04-busy-typed.ansi` | A draft during a turn, with the footer hint `tab to queue message` |
| `05-busy-steer.ansi` | One pending steer |
| `06-busy-steer-and-queue.ansi` | A pending steer and a queued message |
| `07-esc-with-steer.ansi` | After Esc: `Model interrupted to submit steer instructions.`, and the steer starts a new turn |
| `08-esc-interrupt.ansi` | After Esc: `■ Conversation interrupted …`, and the queued message is back in the box |
| `09-plainpaste-single-enter.ansi` | Unbracketed paste plus Enter: not submitted |
| `10-plainpaste-second-enter.ansi` | After a second Enter: submitted, busy |
| `11-bracketed-multiline-enter.ansi` | `paste-buffer -p` plus Enter: submitted, two lines |
| `12-plainpaste-multiline-enter.ansi` | Unbracketed two-line paste plus Enter: not submitted |
| `13-plainpaste-wait-enter.ansi` | Unbracketed, a 250 ms wait, then Enter: submitted |
| `14-busy-large-paste.ansi` | `[Pasted Content 1200 chars]` in the box during a turn |
| `15-busy-large-paste-steer.ansi` | That paste as a pending steer, three lines and `…` |
| `16-approval.ansi` | The exec approval dialog |
| `17-approval-declined.ansi` | After Esc on the dialog: canceled, interrupted |
| `18-after-decline.ansi` | A second approval (`APPROVE again`), declined the same way, then idle |

**`snapshots/`**: insta snapshots copied unchanged from the `rust-v0.160.0` tag. These are screens
Codex's own tests render, not terminal captures. Plain ones hold text only. The `Buffer { … }` form
also lists style runs (`modifier: DIM`, `BOLD | REVERSED`, `fg: Rgb(…)`), from which the ANSI can
be rebuilt. Each file's header names the test that renders it. Source paths, relative to
`codex-rs/tui/src/`:

| File | Source |
|---|---|
| `codex_tui__chatwidget__tests__status_widget_active.snap` | `chatwidget/snapshots/` (busy, header `Analyzing`) |
| `codex_tui__chatwidget__tests__status_widget_and_approval_modal.snap` | `chatwidget/snapshots/` (exec approval with a prefix option) |
| `codex_tui__chatwidget__tests__exec_approval_modal_exec.snap` | `chatwidget/snapshots/` (exec approval, **with styles**) |
| `codex_tui__chatwidget__tests__approval_modal_patch.snap` | `chatwidget/snapshots/` (edit approval) |
| `codex_tui__chatwidget__tests__chatwidget_exec_and_status_layout_vt100_snapshot.snap` | `chatwidget/snapshots/` (full screen: transcript, status row, draft, `tab to queue message`) |
| `codex_tui__bottom_pane__pending_input_preview__tests__render_pending_steers_above_queued_messages.snap` | `bottom_pane/snapshots/` (all three sections, **with styles**) |
| `codex_tui__bottom_pane__tests__status_and_queued_messages_snapshot.snap` | `bottom_pane/snapshots/` (status row, queue, box, footer) |
| `codex_tui__chatwidget__tests__hidden_shell_paste_queued_preview.snap` | `chatwidget/snapshots/` (queued large paste) |
| `codex_tui__chatwidget__tests__compact_queues_user_messages_snapshot.snap` | `chatwidget/snapshots/` (rejected steer during `/compact`) |
| `codex_tui__chatwidget__tests__manual_compaction_pending.snap` | `chatwidget/snapshots/` (`Compacting context` with a detail row) |
| `codex_tui__chatwidget__tests__esc_interrupt_goal_paused_footer.snap` | `chatwidget/snapshots/` (busy, plus a right-aligned footer note) |
| `codex_tui__bottom_pane__chat_composer__tests__empty.snap` | `bottom_pane/snapshots/` (placeholder) |
| `codex_tui__bottom_pane__chat_composer__tests__multiple_pastes.snap` | `bottom_pane/snapshots/` (paste placeholders in the box) |
| `codex_tui__bottom_pane__chat_composer__tests__light_terminal_palette_composer.snap` | `bottom_pane/snapshots/` (box fill, bold `›`, dim placeholder, **with styles**) |
| `codex_tui__bottom_pane__footer__tests__footer_composer_has_draft_queue_hint_enabled.snap` | `bottom_pane/snapshots/` |
| `codex_tui__chatwidget__tests__interrupted_turn_error_message.snap` | `chatwidget/snapshots/` |
| `codex_tui__chatwidget__tests__interrupted_turn_pending_steers_message.snap` | `chatwidget/snapshots/` |
| `codex_tui__bottom_pane__request_user_input__tests__request_user_input_options.snap` | `bottom_pane/request_user_input/snapshots/` |
| `codex_tui__bottom_pane__request_user_input__tests__request_user_input_multi_question_first.snap` | `bottom_pane/request_user_input/snapshots/` |
| `codex_tui__bottom_pane__request_user_input__tests__request_user_input_freeform.snap` | `bottom_pane/request_user_input/snapshots/` |
| `codex_tui__update_prompt__tests__update_prompt_modal.snap` | `snapshots/` |
| `codex_tui__history_cell__tests__standalone_unix_update_available_history_cell_snapshot.snap` | `history_cell/snapshots/` |

## Unverified, and other caveats

- **No assistant output was seen live.** The stub never streamed text, reasoning or tool output,
  so how replies and tool cells look in a capture rests on the snapshots alone.
- **The steer race** for `now` (Esc sent before the steer is registered) is inferred from
  `on_interrupted_turn` and was not tried.
- **Box background under tmux:** in the probe, Codex drew no fill under tmux. Whether some tmux
  configurations report the background colour, and so get a fill, is untested.
- **The shared app-server daemon.** In 0.160.0 the TUI connects to a background `codex app-server
  --managed-daemon` by default, which outlived the TUI in the probe (`daemon_startup.rs`;
  `--no-daemon` opts out). The process that runs a turn may therefore not be the pane's own
  process. This matters to whoever detects Codex sessions by process. It is outside this ticket
  and was not looked into further.
- **On `main` only:** `terminal_program_status.rs` reports lifecycle state through OSC 7501 (and
  OSC 21337 for iTerm2). tmux does not pass unknown OSC sequences through to the pane's own state,
  so claude-mux cannot read them from a capture. Not in 0.160.0.
- Keys and the terminal title are user-configurable (`tui.keymap.*`, `tui.terminal_title`,
  `tui.status_line`). Everything here assumes the defaults.
