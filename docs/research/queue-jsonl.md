# What the JSONL says about the queue

Research for [#159](https://github.com/christinoleo/claude-mux/issues/159), part of map #155. Claude Code 2.1.309, measured on 2026-11-01.

Every claim carries one of four labels:

- **Measured:** seen in a live probe session. The timelines are in [`fixtures/queue-jsonl/measured-timelines.txt`](fixtures/queue-jsonl/measured-timelines.txt), and letters such as (H) name the scenario.
- **Source:** read in the JavaScript bundled inside the installed 2.1.309 binary. It is minified, so names like `SRo` are the bundle's own.
- **Census:** counted over the existing `queue-operation` lines under `~/.claude/projects`. Only metadata and counts were printed, never message text.
- **Inference:** my reasoning from the above, not observed directly.

## Short answer

**Yes, the queue can come from the JSONL, and it would be more reliable than the screen, but the JSONL cannot be the only source.** A queued message appears in the file about 0.16 s after Enter, and it leaves within 0.1 s of the screen's own signal. Removing, steering and delivery all show up.

The gaps are specific:

- Text is withheld during compaction.
- Nothing is written until the `UserPromptSubmit` hook finishes.
- Entries left behind by a dead process look exactly like waiting ones.

The two reports are explained mostly by the screen reader and the Transcript parser, not by Claude Code:

- **Not shown while queued.** `readQueuedMessages()` returned nothing for a queued message in five measured situations. The largest is truecolor panes, where it never finds anything.
- **Shown as queued after being sent.** A message absorbed mid-turn keeps its queued entry in the Transcript for good. Separately, the pane reader lists a message for about 1.4 s after it was sent when the session has just compacted.

## How claude-mux reads the queue today

There are two separate paths, and neither reads `queue-operation` lines for display.

- **The queue strip** uses `pane_queue`, which `src/server/ws-handlers.ts` fills from `readQueuedMessages()` in `src/tmux/pane.ts`. The reader anchors on `QUEUE_HINT` ("… to send now"), then walks up through rows painted with `DIM_TEXT` (`38;5;246`). That is the layout from commit 2585b7d, extended with more hint wordings in PR #149.
- **The Transcript** uses `feedAttachment()` in `src/transcript/parser.ts`. It creates a `queued` entry from a `queued_command` attachment, and `deliverQueued()` marks it delivered when a later user line equals it or starts with it.

The one existing reader of `queue-operation` lines is `loggedSince()` in `src/server/message-queue.ts`, added by PR #152. It only confirms that a pasted line was taken. `readPaneHold()`, which stops the drain from pasting into a pane holding messages, uses the same screen reader as the strip.

## What the entries record

Each line has `type`, `operation`, `timestamp` and `sessionId`, and sometimes more (Source: the writer in `SRo`).

| Operation | Text in `content` | Other fields | Meaning |
| :- | :- | :- | :- |
| `enqueue` | Usually; can be absent | none | Entered the queue. **No id and no priority.** |
| `dequeue` | **Never** | none | Taken as a new prompt. |
| `remove` | Yes, except `dropped_by_hook` | `reason`, `commandUuid`, and `deliveryId` where one exists | Left the queue for the stated reason. |
| `popAll`, `popOne` | Yes | none | Moved back to the prompt box for editing. |

**Removal reasons** (Source): `absorbed_mid_turn`, `delivered_to_agent`, `delivered_as_tool_result`, `dropped_by_hook`, `cleared_on_cancel`, `cancelled_by_sender`, `agent_stopped`, `rewound`, `carried_to_background`, `not_carried_to_background`. Only the first two occur in the census, which is 984 and 573 lines. Treat the list as open: this format is undocumented and could change in any release.

**How the lines link up** (Measured: B256):

- `commandUuid` on a `remove` equals `source_uuid` on its `queued_command` attachment.
- The attachment's `timestamp` is the moment of Enter, although the line itself is written at absorption.
- A `dequeue` is followed by an ordinary `user` line with `origin: {kind: "human"}`. Nothing links the two except position.

**Census:** 4,482 lines in 271 of 1,427 transcripts, with first-seen versions from 2.1.263 to 2.1.309. `commandUuid` first appears in 2.1.285 and `deliveryId` in 2.1.288.

**Most entries are not from people.** Of 2,255 enqueues, 1,984 are task notifications, 26 have no text, and 27 are wrapped in a tag, such as cross-session messages and a few long pastes. Only the remaining 218, about 10%, are plainly typed. A display has to filter. A long paste is the exception to "starts with `<`", since it is logged inside a `<pasted_content>` wrapper that `unwrapPasted()` already handles (Measured: J).

## How soon they are written

Times are from Enter, over the 11 runs that queued one message. The sampler polled the pane and the file in a loop of about 25 ms, so differences under that are noise (Measured).

| Signal | Min | Median | Max |
| :- | :- | :- | :- |
| Row on screen | 0.03 s | 0.04 s | 0.05 s |
| "to send now" hint on screen, which the reader needs | 0.06 s | 0.07 s | 0.10 s |
| `enqueue` line in the file | 0.15 s | 0.16 s | 0.19 s |

The line's own `timestamp` is 0.10 to 0.12 s older than its appearance in the file, which suggests writes are buffered (Inference). The `UserPromptSubmit` hook fired 0.03 to 0.04 s after Enter in the runs where I compared it (A256, B256, E2, K), so it is level with the row and carries the text.

The screen is not always first. PR #152 recorded a long session where the `enqueue` was on disk about 1.9 s before the pane redrew. My probe sessions were short, so I did not reproduce that.

These times are for the file. A reader sees them later, by however long the tailer's poll takes.

**Leaving the queue.** In all 12 runs that ended with a `dequeue` or `remove` during normal work, the line appeared 0.03 to 0.08 s after the hint vanished, so the two are effectively in step (Measured). The row itself stays grey on screen for another 0.9 to 1.4 s before turning white. Anyone watching the terminal sees "queued" during that time, but the reader does not, because the hint has gone.

## Removing, steering and delivery

All measured, on 2.1.309.

| What happened | What the file shows | Latency |
| :- | :- | :- |
| Turn ends, one queued (A256) | `dequeue`, then `user` | 0.05 s after the hint goes |
| Turn ends, three queued (C) | Three `dequeue`, then three `user` lines with separate `promptId`s | Same |
| Tool finishes (B256, R) | `remove` `absorbed_mid_turn`, then `queued_command` attachment | 0.05 s |
| Up arrow, two queued (D) | `popAll` per message, with text | 0.11 s after the key |
| Clearing the box afterwards (D) | **Nothing** | n/a |
| Editing and resubmitting (D2) | `popAll`, later a fresh `enqueue` | No line links them |
| Send-now chord during a tool (F3) | Tool result ("running in background"), `remove` `absorbed_mid_turn`, attachment | 0.24 s after the chord |
| Send-now chord during text (G) | `dequeue`, then `user` | 0.16 s after the chord |
| Esc during a tool (E3) | `dequeue`, interrupt line, `user` | 0.19 s after the key |
| Esc during text (E2) | `dequeue`, interrupt line, `user` | 0.21 s after the key |
| Second Esc just after that (E4) | **Nothing.** The text is back in the box. | n/a |
| Compaction, two queued (N) | Two `enqueue` without text, one `dequeue` per turn | See below |

Three things stand out:

- **Esc does not clear the queue.** It interrupts and delivers the queued message as a new prompt.
- **The chord has no line of its own.** It raises the priority in memory (`promoteToNow`, Source), and only its effects are logged, in the same form as normal delivery. A steer cannot be told apart from an ordinary hand-over in the file. claude-mux already records its own steers through `recordDelivery()`.
- **`remove` does not mean answered.** In one run the message was absorbed and Esc arrived 0.7 s later, so the turn ended without a reply (E).

## What the entries cannot express

1. **Text during compaction (Measured: N).** Both `enqueue` lines had no `content`, and the hook fired only at delivery, about 4 s after Enter. The cause is in `zce`: there is no text until the prompt has been screened (Source). The screen did show the text in that window. The census has 26 such lines. The same function also withholds prompt text when a loaded mod hooks prompts (Source), and non-string values such as content blocks get none either (Source, not tested live).
2. **The time before screening ends (Measured: K).** With a 4 s `UserPromptSubmit` hook, the row appeared at 0.03 s, but both the `enqueue` line and the hint waited for the hook, at 4.14 s and 4.07 s. The real hooks are fast, so this gap should normally be small.
3. **A prompt blocked by a hook (Measured: L).** No queue line at all. The row flashed for 50 ms and the text returned to the box. A line appears only for a prompt dropped after being logged, and then with no text (Source).
4. **The queue's real order.** `enqueue` has no id or priority and `dequeue` has no text, while dequeue takes the highest priority first (`now`, `next`, `later`; Source). The order has to be predicted, with human prompts as `next` and notifications as `later`. Checked against the census, the human entry predicted for a dequeue appeared in a following user line in 153 of 160 cases. I did not inspect the other 7, because that would mean reading private text.
5. **Whether the queue is still alive (Measured: M3, M4).** After `kill -9` the `enqueue` stays in the file forever with nothing to close it. `--resume` appended to the same file, did not restore the message and never delivered it. The census has 30 entries left at end of file across 17 transcripts, 4 of them human or textless. Some of those sessions may be running now.
6. **Changes of mind after hand-over.** Clearing popped text and the second Esc above leave no line.
7. **Commands marked `unlogged` (Source).** Some internal queue items are never logged. The ones I found are not human prompts, so this should not matter for display (Inference).
8. **Anything typed but not submitted (Measured).** The box stays a screen-only fact.

A permission dialog is *not* a gap. In H the file correctly kept the message queued for the 6 s the dialog was up.

## Accounting for the reports

### Queued items not shown while queued

Each row was checked by replaying saved captures through the real `readQueuedMessages()` (Measured).

| Situation | What the reader returned | What the file showed |
| :- | :- | :- |
| **Truecolor pane (A, B)** | Nothing, for the whole run | The message |
| **Permission dialog up (H)** | Nothing, for 6.1 s; Claude Code hides the hint then | The message |
| **Message taller than the pane (J)** | Nothing, for 10.6 s; its first row scrolled off and the walk drops a run with no start | The message |
| **Slow prompt hook (K)** | Nothing, for 4.0 s, with the row visible | Nothing either |
| **More than ten queued (R)** | Ten of twelve, by the `MAX_QUEUED_MESSAGES` cap | All twelve |
| **Each new message arriving (C, R)** | Nothing, for 30 to 50 ms during the redraw | All so far |

**Truecolor is the one to confirm first.** With `COLORTERM=truecolor`, Claude Code paints the row as `38;2;153;153;153`. `DIM_TEXT` is `38;5;246`, so the walk stops at the first row and returns an empty list even though the hint matched. The older-layout fallback does not run, because an empty list still counts as a result. With `COLORTERM` unset the reader works, which is what the tests and the capture behind 2585b7d cover.

All 19 `claude` processes running here, counted with my probe stopped, have `COLORTERM=truecolor` in their environment (Measured). Those panes should therefore be blind (**Inference**: the rule against touching the default tmux server meant I could not capture one directly). If this holds, `readPaneHold()` is blind in the same way. Its spinner check still covers most of the danger, but its protection against pasting into a pane that holds messages does not work there.

The Transcript cannot fill this gap, since its `queued` entry exists only once the message is absorbed, by which point it is no longer waiting.

### Shown as queued after being sent

| Situation | What happens | Label |
| :- | :- | :- |
| **Absorbed mid-turn** | `feedAttachment()` writes a `queued` entry from a line that means "delivered". `deliverQueued()` only runs on a later user line, and an absorbed message never gets one, so it keeps the clock icon for good. | Source: `parser.ts`, `TranscriptView.svelte`; run with `parser-check.ts` |
| **Just after compaction (N)** | The reader lists `/compact ⎿ Compacted…` as a queued message for 1.5 s. It also keeps a sent message for 1.35 s after its `dequeue`. | Measured |
| **Watching the terminal** | The row stays grey for up to 1.4 s after delivery. | Measured |

Which of these Leo's report describes is **Inference**. The first fits a persistent "shown as queued" best, since the others last under two seconds.

A related bug goes the other way: `deliverQueued()` matches by prefix, so an absorbed "ok" followed by a typed "ok thanks, now do the next thing" is marked delivered, and `TranscriptView` then hides the earlier message entirely. `parser-check.ts` reproduces this with synthetic lines.

## If the queue moves to the JSONL

Input for the "The queue" item on map #155, not a decision. `replay.py` implements steps 1 to 3, apart from the unwrapping, and matches all the fixtures, and it left the expected result on all 17 probe transcripts: empty except for the killed session in M3.

1. **Keep a list per session.** `enqueue` appends. `remove`, `popAll` and `popOne` take the first entry with the same text. `dequeue` takes the first entry that is not a task notification, otherwise the first entry.
2. **Show only human entries.** Hide anything starting with `<` except `<pasted_content`, and unwrap that.
3. **Keep textless entries as a count.** Take their text from the screen when it can be read, or show "1 message waiting".
4. **Discard stale entries.** Ignore entries older than the pane's process, or clear the list when the session has been idle for a moment. The idle rule needs a delay, since `Stop` fired about 0.1 s before the `dequeue` in A256. Neither rule has been tested (Inference).
5. **Treat `absorbed_mid_turn` and its attachment as sent.** This fixes the Transcript regardless of the rest. The attachment's `timestamp` gives the time of Enter.
6. **Keep the screen for what the file cannot say:** the box, and text during compaction. `UserPromptSubmit` can cover the moments before the `enqueue` line.

This fits the map's trust order of hooks, then the JSONL, then the screen. `readPaneHold()` could use the same list, which needs its own decision because the drain depends on it.

Independently of all this, the truecolor gap and the `deliverQueued()` prefix match are ordinary bugs.

## Method

The probe ran in a private tmux socket with `--setting-sources project`, `--model haiku`, `--permission-mode default` and inherited `CLAUDE*` variables unset. A sampler read the pane and the transcript side by side and logged each change with a wall-clock time. Scenarios A and B ran with `COLORTERM=truecolor`, inherited from the launching shell. All the others ran with it unset, which is the case the reader supports.

The scripts are in [`fixtures/queue-jsonl/`](fixtures/queue-jsonl/): `probe/` for the harness, `replay.py` and the synthetic `*.jsonl` fixtures (run `python3 replay.py --check *.jsonl`), `parser-check.ts`, and three `census-*.py` that print counts only. Probe transcripts were deleted afterwards. The census scripts skip paths containing "probe".

Two things went wrong and were corrected. First, Claude Code refused `sleep 30` (`Blocked: standalone sleep 30`), and with `sleep 25` the model backgrounded the command, so the first E, F and M runs did not test a running tool. E3, E4, F3 and M3 replace them, using `sleep 20` and an explicit request to stay in the foreground. The timeline for the original E is kept only for its absorb-then-Esc observation. Second, in L the second message was typed into a box that still held the blocked text, so the two merged and it did not test a separate prompt. L therefore shows only that a blocked prompt leaves no line.

## Not proven

- That Leo's real panes paint truecolor, or that they are blind. Capturing one in a real pane would settle it in a minute.
- Which situation the original reports came from.
- Every removal reason except `absorbed_mid_turn`. The rest are from source or census only, as is `popOne`.
- Long-session behaviour, where PR #152 saw the screen fall behind the file.
- Real images in the queue, and `/clear` or rewind with a queue waiting.
- Any version other than 2.1.309. The census shows the operations are older, but the live timing is for this one.
