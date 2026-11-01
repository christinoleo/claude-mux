# What MessageDisplay costs and how it behaves

Research note, 2026-11-01, for [#156](https://github.com/christinoleo/claude-mux/issues/156)
(map [#155](https://github.com/christinoleo/claude-mux/issues/155)). The question:
what does the `MessageDisplay` hook cost and how does it behave in a real
session, for a `command` hook written like claude-mux's own and for an `http`
hook, including `async: true`, long paragraphs, subagent text, thinking,
alignment with the JSONL, and the first version that has it?

Each claim carries one of three labels:

- **Measured**: seen in live sessions driven by the harness in
  [`fixtures/message-display/`](fixtures/message-display/), with the number of
  runs. All raw per-run summaries are in
  [`results.jsonl`](fixtures/message-display/results.jsonl).
- **Source**: read in the installed Claude Code binary, whose JavaScript bundle
  is minified but readable. Names such as `uos` are minifier output and will
  differ between releases.
- **Inference**: reasoned from the above, not observed directly.

| Source | Version |
|---|---|
| Claude Code, live and bundle | 2.1.309 (installed), 2.1.152 (live, n=4), 2.1.150 (bundle only) |
| [Hooks reference](https://code.claude.com/docs/en/hooks.md) | read 2026-11-01 |
| [`CHANGELOG.md`](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) | read 2026-11-01 |
| claude-mux | `src/hooks/claude-mux-hook.ts`, `src/setup/hooks.ts` at `origin/main` `acdf730` |

## Short answer

- **Cost on screen is negligible for a fast hook.** A bun hook or an `http` hook
  puts a line on the screen 0.03 to 0.04s after the hook call starts, and the end
  of a 150-line message moves by under 0.1s, close to the 0.06s the harness can resolve.
- **Cost on the machine is real for `command`.** A streaming message fires about
  10 hook calls a second. Each bun call used 29 to 39ms of CPU, so one streaming
  session costs roughly 0.3 to 0.4 of a core (inference from those two numbers).
  An `http` hook spawns nothing.
- **`async: true` does not work on this event.** Claude Code ignores it for both
  `command` and `http`. The hook still holds the screen and its output is still
  applied.
- **A slow hook delays the screen by its own duration, not cumulatively,** and
  never delays the model, tools, the JSONL or `Stop`. At most 3 calls run at once.
  A hung `http` endpoint with the default 10s timeout delayed first text by 10s
  and the last line by 14.5s (n=1), so an `http` hook should set a short `timeout`.
- **Batches are whole lines.** A paragraph with no line break produces one batch
  at the end of the message, no earlier than the screen. Worse, while the hook is
  installed the screen also stops streaming that paragraph: it appears all at once.
- **Only main-thread assistant text arrives.** No thinking and no subagent text.
- **Pressing Escape produces no `final` batch and no `Stop`,** contrary to the
  docs' "exactly one final batch".
- **Aligning with the JSONL works by order and text, not by id.** `message_id` and
  `turn_id` appear nowhere in the transcript. The k-th hook message of a session
  is the k-th main-thread API message with text, and joined deltas equal the
  stored text exactly, apart from interrupted messages. `prompt_id` joins a batch
  to its user entry on 2.1.309.
- **The event exists from 2.1.152,** released 2026-05-26.

A correction to the map: the "hook about 0.3s ahead of the screen" in #155 is an
artefact. That harness compared the first batch's time against the screen showing
line 3, and line 3 arrives a batch or two later. Compared line for line, the hook
is ahead by about 0.04s, so the hook and the screen are effectively simultaneous.
The large finding in that table, that both beat the JSONL by the length of the
message, still stands.

## Method

Each run is one fresh interactive session in a private tmux server
(`tmux -L p156`), with `--setting-sources project`, `--model haiku`,
`--permission-mode default`, every inherited `CLAUDE*` variable unset, and a
`--session-id` so the transcript path is known. In the main comparison, conditions were
rotated so that no condition always ran first. The driver polls the pane and the JSONL about every
55ms, which is the resolution of every pane and JSONL time below. Hook times are
stamped by the hook itself when its script starts, so they exclude the runtime's
own startup.

The hook under test is [`display-hook.ts`](fixtures/message-display/display-hook.ts),
launched in the shape `hookCommand()` builds
(`PATH="$PATH:<dir>" bun <script> <event>`). It imports the same local modules as
the real hook, reads stdin, and appends one JSON line. It does not take the session
lock or call `execSync`, so a real handler would cost more than this one if it did.
The `http` condition posts to a local `Bun.serve` endpoint,
[`http-sink.ts`](fixtures/message-display/http-sink.ts).

The main comparison uses a prompt for 150 numbered lines. Model speed varies
between runs, so raw durations are noisy. The comparison that removes it is the end
of the message on screen minus the moment its text reaches the JSONL, because the
JSONL write does not depend on the hook.

## Cost

### Slowdown against no hook

Measured, 2.1.309, 150 lines, about 5.2s of streaming. Values are mean [min, max],
in seconds.

| Condition | n | Last line on screen minus JSONL | Hook start to same line on screen | Batches | Hook duration (ms) |
|---|---|---|---|---|---|
| No hook | 5 | -0.12 [-0.16, -0.11] | n/a | 0 | n/a |
| bun `command` | 6 | -0.03 [-0.06, 0.07] | 0.04 [0.02, 0.07] | 53 [50, 55] | 20 [16, 30] |
| `http` | 4 | -0.10 [-0.12, -0.06] | 0.03 [0.03, 0.04] | 54 [54, 55] | under 1 |
| bun, `async: true` | 4 | -0.07 [-0.11, 0.00] | 0.04 [0.04, 0.05] | 53 [49, 55] | 17 [16, 19] |
| `http` to a closed port | 2 | -0.08 [-0.11, -0.05] | n/a | not logged | n/a |

Against no hook, bun adds about 0.09s at the end of the message and `http` about
0.02s, and the ranges overlap. Since the resolution is about 0.06s, the honest
reading is "under 0.1s, too small to separate from noise at n=4 to 6".

Hook duration is the script's own time for bun and handler time for `http`, so it
excludes spawning the process and making the request. The `http` hook's connection
cost was not measured separately; it is included in the screen numbers above.

`Stop` fired about 0.1s before the JSONL showed the text in every condition (mean -0.10 to
-0.15), so a hook makes no measurable difference to when a turn ends.

### Machine cost

Measured, outside Claude Code, with `time` around 100 calls per round, 3 rounds, on an
8-core machine ([`coldstart.sh`](fixtures/message-display/coldstart.sh) is the same loop
for wall time):

| Hook | Wall per call | User + system CPU per call |
|---|---|---|
| bun, minimal | 33 to 45ms | 29 to 34ms |
| bun, importing claude-mux's modules | 41 to 50ms | 36 to 39ms |

An earlier, quieter pass of `coldstart.sh` measured wall time of 21 to 25ms for the
same two hooks, so these figures move with machine load.

Inference: at 10 calls a second, a session uses about 0.3 to 0.4 of a core while it
is streaming text, and several sessions streaming at once add up. An `http` hook
moves that to one long-lived server. Its CPU was not measured.

Measured: the hook adds nothing to the transcript. Transcripts had 35 to 36 lines
with or without it (4 runs each). Across all transcripts, including the failing-endpoint
runs, there is no `hook_non_blocking_error` attachment, and the word `MessageDisplay`
appears only in 3 runs whose prompt contained it.

### Batching rate

Source: 2.1.309 flushes at most every 100ms and allows 3 hook calls in flight:
`var gs=10,go=1000/gs,yo=3,bo=1e4`, where `bo` is the 10s default timeout. A flush
sends everything up to the last newline in the buffer.

Measured: median interval between batches was 100ms, with the 10th to 90th
percentile at 98 to 103ms, over the fast runs. The first batch went out as soon as
the first line was complete. A message therefore costs about one call for each
100ms of streaming, whatever its line count.

### Slow and failing hooks

Measured, 2.1.309, 150 lines:

| Condition | n | Hook start to same line on screen | Last line on screen minus JSONL | Batches |
|---|---|---|---|---|
| bun, holds 1000ms | 4 | 1.06 [1.06, 1.07] | 0.96 [0.93, 0.99] | 18 [17, 18] |
| bun, holds 1000ms, `async: true` | 3 | 1.06 [1.06, 1.06] | 1.05 [0.92, 1.27] | 18 [17, 18] |
| `http`, holds 1000ms | 3 | 1.04 [1.03, 1.05] | 1.39 [0.87, 1.68] | 19 [18, 19] |
| `http`, holds 1000ms, `async: true` | 1 | 1.10 | 0.93 | 18 |
| `http` that never answers, `timeout: 1` | 2 | 1.03 [1.03, 1.04] | 1.22 [0.86, 1.58] | 19 [18, 19] |
| `http` that never answers, default timeout | 1 | 10.04 | 14.46 | 4 |

What these show:

- **The hold does not accumulate.** A 1000ms hook on a 5.3s message delays the
  screen by about 1s, not by 18s. Calls overlap: up to 3 run at once, so 3 per
  second get through and the rest of the text waits and is sent as a larger batch.
- **The hold applies even when the hook returns nothing.** The screen waits for the
  call to finish whether or not the hook replaces the text. A hook that only
  observes cannot opt out.
- **Only the screen waits.** `Stop` still fires about 0.1s before the JSONL text appears,
  even at a 1000ms hold. With a 1000ms hook in a tool-using turn (n=2), `PreToolUse`
  and `PostToolUse` both finished while the hook for the preceding text was still
  running. So in-flight batches can outlive `Stop`.
- **A dead endpoint costs nothing; a hung one costs up to the timeout, repeatedly.**
  A closed port showed no delay. A hung endpoint with the default timeout held first
  text for 10s and the last line until 14.5s after the JSONL (n=1): the first calls
  time out, and whatever accumulated goes out in the following calls, which time
  out too. The final pane shows no notice of the failure, and the transcript records
  nothing. The docs say failures appear only in debug output. `timeout: 1` bounds the damage to about 1s. Values under 1s were not tried.

### `async: true`

Source: the command runner's backgrounding path is guarded by
`if((e.async||e.asyncRewake&&vr)&&!we)`, where `we` is `forceSyncExecution`, and the
function that fires this event passes `forceSyncExecution:!0`. The docs' section on
background hooks does not mention this. It also says `async` exists only for
`type: "command"`.

Measured, agreeing with the source:

- A 1000ms hook delays the screen by the same amount with and without `async: true`
  (table above).
- A hook with `async: true` that prints `displayContent` still changes the screen:
  the pane showed `MIXEDCASE ONE`, upper-cased by the hook (n=1). A background hook
  could not have done that.
- On `http`, `async: true` made no difference either (n=1).

So `async: true` is not unusable so much as absent: it is accepted and does nothing.
To avoid the hold, the hook itself has to return fast and hand its work elsewhere,
which is what an `http` handler answering immediately amounts to. That is inference;
no hook that forks and exits was tested.

## Behaviour

### A long paragraph

Measured, prompts for one paragraph of about 1000 words with no line breaks. First text
came about 20s after the prompt:

| Condition | Runs | Batches | First words on screen to last words on screen |
|---|---|---|---|
| No hook | 3 | 0 | 6.25s, 5.67s, 4.38s |
| bun hook | 3 | 1 | 0.00s in all 3 |

Three more findings from these runs:

- The single batch is the `final` one, and the hook call started within 0.12s of the
  whole paragraph appearing on screen.
- The screen loses streaming. Without the hook the paragraph appears as it is
  generated. With the hook it appears whole, in one poll of the pane, at the moment the message ends.
  Going by the no-hook runs, that is 4 to 6s after it would otherwise have started to appear.
  This is a change Leo would see in the terminal, not only in the dashboard.
- A shorter prompt of about 350 words behaved the same way: 6 of 6 bun runs had one
  batch, and the one no-hook run that could be timed took 1.77s to appear. A fourth 1000-word bun run in which the model wrote 8 paragraphs instead
  of one produced 8 batches, confirming the rule is newlines and not size. It is
  excluded from the table.

At Haiku's speed the wait is seconds. Inference: it would be longer on slower
models, and in proportion to the paragraph, since it lasts as long as the paragraph
takes to generate.

Source: the buffer is flushed up to `raw.lastIndexOf("\n")+1`, so a batch cannot
contain a partial line except the final one. The docs say the same.

Consequence: `MessageDisplay` streams by line, not by word. Prose arrives one paragraph at
a time, each when it is complete. Mixed content does better. In a reply with a heading, a
30-line code block, a 20-row table, a list and one short paragraph, the hook delivered 27,
27, 27 and 46 batches (4 runs on 2.1.309). In the two runs inspected, code and table rows
arrived steadily, with fences and tables not held back. Batching looks only at newlines.

### Subagent text and thinking

- **Subagents: no.** Measured in 4 runs, 2 with background subagents and 2 with
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` so the parent waited. Each subagent
  transcript contains `SUBTEXT-ONE` and `SUBTEXT-TWO`, and no `MessageDisplay` batch
  contains either or carries an `agent_id`. Subagent tool hooks did fire with
  `agent_id`, so hooks in general reach subagents; this event does not. The parent's
  own text after the subagent returned did arrive. A consumer that wants subagent
  text must keep reading `subagents/agent-*.jsonl`.
- **Thinking: no.** Measured in 3 runs with `alwaysThinkingEnabled`. Two stored an
  empty thinking block, and the third, with `showThinkingSummaries`, stored 355
  characters of thinking text. All three hook deltas were only the reply,
  `THINKREPLY 17, 23`. Source: the only call feeding the batch buffer sits in the
  `text_delta` branch of the stream handler.

The docs say "assistant message text only" and do not mention subagents.

### Interrupting with Escape

Measured, n=3: Escape during a 150-line message gave no batch with `final: true` and
no `Stop` event. The next message in the same session got a new `message_id` and its
own final batch.

This contradicts the docs' "Each message has exactly one final batch". Source: a new
message or turn abandons an unfinished one and aborts its in-flight call.

The JSONL does record the interrupted message, and it holds more than the hook did:
the hook's 50 lines against a stored text ending in the partial line
`L051 alpha beta gamma delta`. The next signal after the abandoned batches is the
next `UserPromptSubmit`, so a consumer has to treat that, or a new `message_id`, as
the end of the old message.

### Other modes

- **`claude -p`:** one call, `index: 0`, `final: true`, whole message in `delta`, as
  the docs say (measured, n=1).
- **`--resume`:** the hook did not fire again for the restored history (measured, n=1).
- **`displayContent`:** replaces the text on screen, and the transcript keeps the
  original (measured, n=2 with slow rewrite, n=1 with fast rewrite). The docs say this.
  claude-mux has no use for it, but it is a way to break the terminal view by accident.
- **Empty final delta:** the docs say the final delta is empty when a message ends on a
  newline. It never occurred: 0 of 111 messages, since the model's text never ended on
  a newline. Treat it as documented but unobserved.

### Fields and ordering

The payload on 2.1.309 (measured): `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `prompt_id`, `scratchpad_dir`, `turn_id`, `message_id`, `index`,
`final`, `delta`. There is no `agent_id` and no `permission_mode`. `turn_id` stayed the
same across the tool loop of one prompt.

Calls overlap, so their order is not guaranteed. In 1,307 adjacent pairs of batches
across 111 messages, one pair started out of order (by 11ms, on 2.1.152) and another
finished out of order (by 4ms). Both were on fast hooks. A consumer must order by
`index`. Inference: the `http` hook has the same exposure, since its calls overlap in
the same way when slow.

## Alignment with the JSONL

**Ids.** Measured over 87 runs: none of the 187 distinct `message_id` and `turn_id` values
appears anywhere in the transcript, so they are not the entry `uuid` either. Source: both are fresh random UUIDs made by
Claude Code's display queue, which holds the API id internally and does not pass it
to the hook. `prompt_id` does match: all 1,285 batches carrying it matched a `promptId`
on a user entry in the same transcript. Assistant entries do not carry `promptId`, so
it identifies the prompt and not the message. 2.1.152 does not send `prompt_id` on this
event; the version that added it was not found.

**Text.** Measured: joining a message's deltas in `index` order gave exactly the text of
the transcript's main-thread assistant entries for one API `message.id` in 106 of 109
messages. The other 3 were the interrupted messages, where the hook's text was a prefix
of the stored text.

**Order.** Measured: in every run with a hook log, the k-th hook message by time was the
k-th main-thread API message with text, with the same count on both sides. This held for
turns with repeated identical text (`ALIGN-SAME.` twice, n=8), which text alone cannot
tell apart.

**Timing.** Measured with a 20ms poll of the file (3 runs, 12 text messages that each
preceded a tool call): the final batch started before the entry was visible on disk in
12 of 12, usually by 0.02 to 0.18s, with one at 1.71s. For plain text messages, the
JSONL's text appeared 0.11 to 0.17s after the final batch in 13 of 14 runs and 0.44s in
the other. The entry's own `timestamp` field is misleading here: it precedes the final batch by 0.03
to 0.75s (4.66s in the hung-endpoint run), but the entry reaches disk after that batch. So the batch
wins the race every time, but only by a fraction of a second for short messages.

**A recipe, for #160 to accept or reject.** This is inference from the above; it was
checked against the recorded runs but not built:

1. Keep a preview per `message_id`, ordered by `index`.
2. When an assistant entry with text lands in the JSONL, match it to the oldest
   unmatched preview for that session whose accumulated text is a prefix of the entry's
   text. Replace the preview with the entry.
3. When a new `message_id` or `UserPromptSubmit` arrives and an old preview has no
   `final`, mark the old one as cut off and wait for its JSONL entry.
4. Start from the end of the transcript on `--resume`, as the hook does not replay.

Treat the JSONL as the record and the preview as provisional. A failed or timed-out call
loses its text from the preview, and the session gives no sign of it, so the preview can
have gaps that only the JSONL fills. Inference from the source: a preview whose hook call
failed would no longer be a prefix of the entry, so step 2 needs a fallback to order alone.

One case was not observed live. Source: the batch buffer takes every text delta of an API
message with no separator, while the JSONL stores one entry per content block. An API
message with two text blocks would differ only by how the blocks join. No run produced one.

## Which version

- **Changelog:** "Added a `MessageDisplay` hook event that lets hooks transform or hide
  assistant message text as it is displayed", under 2.1.152.
- **Registry:** npm shows 2.1.152 published 2026-05-26. 2.1.151 was never published.
- **Bundles:** the string `MessageDisplay` appears 0 times in the 2.1.150 linux-x64 binary
  and 38 times in 2.1.152.
- **Live on 2.1.152** (n=4): it fires, batches at the same rate (39 and 51 batches on 150
  lines), ignores `async: true` (1.11s hold at 1000ms), and gives one batch for a long
  paragraph. The only difference found is the missing `prompt_id`.

## Not established

- How a machine older than 2.1.152 reacts to the hook in its settings: ignored, warned
  about, or rejected. The rollout note in #155 needs this; it was not tested.
- The cost of the real hook with session locking and its `tmux` and `git` calls, since the
  probe hook does neither. The figures here are a floor for a handler that does those.
- `http` hook CPU and connection cost, and any behaviour with a remote or TLS endpoint. Only
  a local plain-HTTP server was used.
- Whether several sessions streaming at once interact, since each run was one session.
- Timing on models other than Haiku. Rates and thinking time will differ.
- Whether a `timeout` under 1s is accepted.
- Which release added `prompt_id` to this event, between 2.1.152 and 2.1.309.
- Compaction, `/clear`, and rewinding, none of which were exercised with this hook.

## Reproducing

Copy the scripts in [`fixtures/message-display/`](fixtures/message-display/) to
`<root>/tools/`, create `<root>/probe156-proj/.claude/`, then run:

```sh
MUX_SRC=<claude-mux>/src python3 -I tools/drive.py <root> \
  lines150:none:g1-none lines150:bun:g1-bun lines150:http:g1-http lines150:async:g1-async \
  lines150:slow1000:s1 lines150:slow1000async:s2 para:bun:P1 para:none:P2 \
  mix:bun:m1 align:bun:a1 alignpoll:bun:ap1 sub:bun:b1-fg think:bun:t1 interrupt:bun:i1 \
  twoturn:rewrite:tt1 resume:bun:r1 print:bun:pr1
python3 -I tools/analyze.py <root>
python3 -I tools/inspect_run.py <root>/runs/a1
```

Each spec is `scenario:condition:label`, and `CLAUDE_BIN` selects another binary. A label
ending in `-fg` keeps subagents in the foreground.

The driver rewrites the project's settings for each run, stays on its own tmux socket, and
does not touch `~/.claude/settings.json`. Transcripts land in `~/.claude/projects/` under a
name ending in `probe156-proj` and should be deleted afterwards. `drive.py` needs `claude`,
`bun`, `tmux` and Python 3.

The raw run directories are not committed, because the transcripts carry session metadata,
so `analyze.py` and `inspect_run.py` need a fresh run to read. In the committed
`results.jsonl`, pane and JSONL times are meaningless wherever a prompt contained its own
marker word: `p1` to `p3`, `m1`, `m2`, `a*`, `t*` and `tt-*`. A few runs have missing markers
because the model spelled them differently. This note uses none of those times.
