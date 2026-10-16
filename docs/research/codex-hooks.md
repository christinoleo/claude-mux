# What Codex's hooks send

Research note, 2026-10-16, for [#141](https://github.com/christinoleo/claude-mux/issues/141)
(map [#140](https://github.com/christinoleo/claude-mux/issues/140)). The question:
what do Codex's hooks send, and how much of `src/hooks/claude-mux-hook.ts`
works for them unchanged?

Only primary sources were used: the `openai/codex` source at the release
installed on omarchy, its generated hook schemas, the official hooks page, and
the installed CLI (`codex-cli 0.160.0`, not logged in). One claim was checked
live: Codex's own `hooks/list` (from `codex app-server`, which needs no login)
was asked for hook keys, hashes and trust status in an isolated `CODEX_HOME`.
No Codex turn was ever run, so **no hook payload here was seen live**. Each
payload is built from the Rust structs that serialize it, and checked against
Codex's generated JSON schemas. Anything resting on inference rather than a
line of source is marked **unverified**.

| Source | Version |
|---|---|
| `openai/codex` tag `rust-v0.160.0` | `a956835d02` (2026-10-01), the installed release |
| `openai/codex` `main` | `e7de1f4440` (2026-10-16), compared below |
| Official docs | <https://learn.chatgpt.com/docs/hooks> (where `developers.openai.com/codex/hooks` redirects), read 2026-10-16 |
| claude-mux | `src/hooks/claude-mux-hook.ts`, `src/setup/hooks.ts` at `origin/main` `b895042` |

Link prefix: `CX` = `https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/`.

## Short answer

- **Codex speaks Claude Code's hook dialect, nearly field for field.** It fires
  12 events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `SubagentStart`, `SubagentStop`, `Stop` and `Interrupt`. Each one sends JSON
  on stdin with `session_id`, `transcript_path`, `cwd` and `hook_event_name`,
  and every event but `SessionEnd` also sends `model`. The config format is
  the same `hooks.json` shape Claude Code reads. Codex has **no `Notification`
  event and no `PostToolUseFailure`**, and it adds `Interrupt`, which Claude
  Code lacks.
- **claude-mux's hook would run under Codex almost unchanged.** It dispatches
  on `hook_event_name`, and every Codex event it would care about uses the same
  name. But six behaviours differ in ways that matter (section "What breaks").
  The biggest has nothing to do with payloads. By default **Codex 0.160 runs
  sessions inside a shared background daemon**, so hooks run in the daemon's
  process with the environment of whichever pane started it. `TMUX_PANE`,
  `MAESTRO_ROLE` and the parent-process walk then point at the wrong pane, or
  at none. Launching with `--no-daemon` avoids this.
- **Hooks live in `~/.codex/hooks.json`** (or `[hooks]` in
  `~/.codex/config.toml`). They are skipped until trusted. Trust is a
  `trusted_hash` per hook under `[hooks.state."<key>"]` in the user's
  `config.toml`. The hash is a SHA-256 of the normalized hook, and claude-mux
  can compute it itself. That was checked live: all three hashes Codex reported
  were reproduced exactly, and writing one turned that hook `trusted`. So
  `claude-mux setup` can install and trust its hooks, and an unattended session
  then runs them with no review dialog.
- **Nothing in the environment says "Codex".** The surest discriminator is the
  command line: setup writes Codex's hooks with an agent flag. In the payload,
  `turn_id` (absent from Claude Code's) and a `transcript_path` under
  `~/.codex/sessions/` also tell the two apart.
- **States.** Codex can drive busy (`UserPromptSubmit`, `PreToolUse`), done
  (`Stop`) and permission (`PermissionRequest`). It can drive interruption
  outright (`Interrupt`, which replaces the pane-scraping
  `checkForInterruption()`), and question-waiting through
  `PreToolUse(request_user_input)`. It **cannot** drive idle-after-notification
  (there is no idle notification), "the dialog was answered", or the end of a
  turn that fails with an error. A failed turn fires neither `Stop` nor
  `Interrupt`, so the session would read busy until something else moves it.

## The events, beside Claude Code's

Every payload is one JSON object on stdin, from structs with
`deny_unknown_fields` in `CX hooks/src/schema.rs#L278-L637`. Codex writes the
same structs out as JSON Schema in
`CX hooks/schema/generated/*.command.input.schema.json`, and every fixture
below validates against them. The event list is `HOOK_EVENT_NAMES` in
`CX hooks/src/lib.rs#L23-L36`.

| Claude Code event (handled by claude-mux) | Codex event | Codex payload, beyond the common fields |
|---|---|---|
| `SessionStart` | `SessionStart` | `source` ∈ `startup`, `resume`, `clear`, `compact`, `fork`. **No `turn_id`.** (`schema.rs#L496-L510`, enum `#L853-L855`) |
| `UserPromptSubmit` | `UserPromptSubmit` | `turn_id`, `prompt`, optional `agent_id`/`agent_type` (`#L564-L583`) |
| `PreToolUse` | `PreToolUse` | `turn_id`, `tool_name`, `tool_input`, `tool_use_id`, optional `agent_id`/`agent_type` (`#L275-L296`) |
| `PermissionRequest` | `PermissionRequest` | `turn_id`, `tool_name`, `tool_input`, optional `agent_id`/`agent_type`. **No `tool_use_id`.** (`#L298-L318`) |
| `PostToolUse` | `PostToolUse` | `turn_id`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `agent_id`/`agent_type` (`#L320-L342`) |
| `PostToolUseFailure` | none | Codex runs PostToolUse only after a successful tool (`CX core/src/tools/registry.rs#L710-L732`) |
| `Stop` | `Stop` | `turn_id`, `stop_hook_active`, `last_assistant_message` (string or null). **No `background_tasks`.** (`#L585-L601`) |
| `SubagentStart` | `SubagentStart` | `turn_id`, `agent_id`, `agent_type` (`#L546-L562`) |
| `SubagentStop` | `SubagentStop` | `turn_id`, `agent_transcript_path`, `stop_hook_active`, `agent_id`, `agent_type`, `last_assistant_message` (`#L603-L622`) |
| `SessionEnd` | `SessionEnd` | `reason`, always `"other"`. **No `model`, no `permission_mode`, no `turn_id`.** (`#L512-L523`, const `#L799-L801`) |
| `Notification` (`idle_prompt`, `permission_prompt`, `elicitation_dialog`) | none | Not in `HOOK_EVENT_NAMES`. The official page lists no such event either |
| none | `Interrupt` | `turn_id`, `permission_mode`. Fires when the user interrupts a turn (`#L624-L637`) |
| `PreCompact` / `PostCompact` (claude-mux registers neither) | `PreCompact` / `PostCompact` | `turn_id`, `trigger` ∈ `manual`, `auto`, optional `agent_id`/`agent_type`. **No `permission_mode`.** (`#L344-L382`) |

Common fields:

- `session_id` is a UUID string. For the root thread it is the thread's own
  id. For a subagent it is **the root thread's id**: `Session::session_id()`
  returns `agent_control.identity()` (`CX core/src/session/session.rs#L651-L653`),
  and the field there is documented as "session_id is equal to the root
  thread's ID" (`CX core/src/agent/control.rs#L91-L92`). That matches Claude
  Code, where a subagent's events arrive under the parent's id.
- `transcript_path` is a string or `null` (`NullableString`, `schema.rs#L42-L67`).
  It is the session's rollout file, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<thread id>.jsonl`
  (`CX rollout/src/rollout_file_name.rs#L62-L73`; the date folders from
  `CX tui/src/lib.rs#L2503-L2508`). It is `null` for a thread that has no local
  rollout (`CX core/src/session/mod.rs#L5078-L5090`). For a subagent's own
  events it is **the subagent's rollout, not the parent's** (see "What breaks").
- `cwd` is the turn's working directory. For tool events it is the local
  environment's cwd when there is one (`CX core/src/hook_runtime.rs#L247-L253`).
- `model` is the model slug.
- `permission_mode` takes only two values in practice. The schema allows five
  (`schema.rs#L843-L851`), but Codex maps `approval_policy = never` to
  `bypassPermissions` and every other policy to `default`
  (`CX core/src/hook_runtime.rs#L1032-L1040`).
- `turn_id` is a Codex extension ("expose the active turn id to internal
  turn-scoped hooks", `schema.rs#L280`). Claude Code's payloads have no such
  field.

### When each event fires

- **SessionStart fires at the start of the first turn, not when the pane
  opens.** Creating a session only queues the start
  (`CX core/src/session/session.rs#L1931-L1934`). `run_turn` dispatches it
  (`CX core/src/session/turn.rs#L322`), just before the turn's
  `UserPromptSubmit` (`#L368`). A Codex pane sitting at its first prompt has
  therefore told claude-mux nothing yet. Compaction queues a second start with
  `source: "compact"` (`CX core/src/session/mod.rs#L4212`), dispatched mid-turn
  (`turn.rs#L640`).
- **UserPromptSubmit** fires for each user input, including messages steered
  into a running turn: the turn loop runs the same `run_hooks_and_record_inputs`
  on pending input (`turn.rs#L439`, `#L866-L900`).
- **PreToolUse** fires before every tool that offers a payload. Function tools
  do by default (`CX core/src/tools/registry.rs#L134-L143`, dispatched at
  `#L604`). The exceptions are `write_stdin` and code mode's `wait`, which
  return none.
- **PermissionRequest** fires when a tool needs approval, **before** anyone is
  asked. The order is hooks first, then the Guardian auto-reviewer if enabled,
  then the user (`CX core/src/tools/approvals.rs#L504-L527`). So the event means
  "approval is needed", not "a dialog is on screen": with Guardian on, no
  person may ever see it. It covers shell commands, `write_stdin`, `execve`,
  `apply_patch`, MCP tool calls, network access and `request_permissions`
  (`approvals.rs#L166-L238`). It sends no `tool_use_id`.
- **PostToolUse** fires only when the tool succeeded (`registry.rs#L710-L732`).
  For `Bash` it is also skipped while the command is still running in the
  background, since `post_tool_use_response` returns nothing when a
  `process_id` is set (`CX core/src/tools/context.rs#L438-L446`).
- **Stop** fires when the model ends a turn with no follow-up
  (`turn.rs#L653-L661`). A Stop hook that blocks makes the turn continue, and
  the next Stop carries `stop_hook_active: true` (`turn.rs#L670-L689`).
- **Interrupt** fires when a turn is aborted with reason `Interrupted`, which
  is what Escape does (`CX core/src/tasks/mod.rs#L812-L825`, `#L987-L989`;
  runner `CX core/src/hook_runtime.rs#L502-L542`). It never fires for
  subagents.
- **No hook fires when a turn fails with an error.** The task records
  `ThreadIdleCause::Failed` and runs neither Stop nor Interrupt
  (`tasks/mod.rs#L812-L825`).
- **SessionEnd** fires when the thread shuts down (`CX core/src/session/handlers.rs#L323`),
  for root threads only (`hook_runtime.rs#L480-L484`). Under the daemon (next
  section), a thread is unloaded only after it has had no subscriber and no
  activity for `thread_unload_delay_secs`, default 60
  (`CX app-server/src/request_processors/thread_lifecycle.rs#L56-L62`, `#L425`;
  default `CX core/src/config/mod.rs#L3911-L3912`). Closing the pane therefore
  ends the session about a minute later, and a turn still running keeps going
  (**unverified** beyond these lines). Its timeout defaults to 1 s and is
  capped at 3 s (`CX hooks/src/engine/discovery.rs#L742-L765`).
- **SubagentStart / SubagentStop** fire for agents spawned with `spawn_agent`
  (`SubAgentSource::ThreadSpawn`). Start fires at the child's first turn, in
  place of its SessionStart (`hook_runtime.rs#L132-L154`). Stop fires in place
  of the child's Stop, with `transcript_path` set to the **parent's** rollout
  and `agent_transcript_path` to the child's (`hook_runtime.rs#L399-L437`).
  `agent_id` is the child's thread id and `agent_type` its role, defaulting to
  the default role's name (`hook_runtime.rs#L1054-L1061`). Codex's internal
  agents (Guardian review, memory consolidation) fire none of these.

### Tool names and inputs

`tool_name` is Codex's own name, not Claude Code's. Claude-style names work
only as *matchers* (`CX core/src/tools/hook_names.rs#L28-L56`):

| Tool | `tool_name` sent | `tool_input` | Matcher aliases |
|---|---|---|---|
| Shell (`exec_command`, and shell approvals) | `Bash` | `{ "command": "<cmd>" }`; on PermissionRequest also `description` (the justification, or `network-access <host>`) | none |
| File edits | `apply_patch` | `{ "command": "<patch text>" }` | `Write`, `Edit` |
| Subagent spawn | `spawn_agent` | the tool's own arguments, e.g. `message`, `agent_type`, `fork_context` (`CX core/src/tools/handlers/multi_agents/spawn.rs#L217-L225`) | `Agent` |
| MCP tool | `mcp__<server>__<tool>` | the call's arguments | none |
| Question to the user | `request_user_input` | `{ questions: [{ id, header, question, isOther, isSecret, options? }], isBlocking }` (`CX protocol/src/request_user_input.rs#L9-L42`) | none |
| Any other function tool | its flat name (`update_plan`, `view_image`, …) | its JSON arguments | none |

Sources: Bash `CX core/src/tools/handlers/unified_exec/exec_command.rs#L520-L532`,
apply_patch `CX core/src/tools/handlers/apply_patch.rs#L415-L420`, MCP
`CX core/src/tools/handlers/mcp.rs#L115-L117`, the default
`CX core/src/tools/registry.rs#L834-L850`, PermissionRequest's Bash input
`CX core/src/tools/sandboxing.rs#L134-L146`. For `Bash`, `tool_response` is the
output as one string (`context.rs#L438-L446`). For `apply_patch` it is also a
string (`context.rs#L337-L339`).

`request_user_input` is registered by default (`CX core/src/tools/spec_plan.rs#L1169-L1176`,
`CX core/src/config/mod.rs#L2705-L2711`). It is offered only in Plan
collaboration mode, unless the `default_mode_request_user_input` feature also
allows it in Default mode (`CX tools/src/tool_config.rs#L17-L26`,
`CX protocol/src/config_types.rs#L700-L702`). That it reaches PreToolUse
through the default function payload is inferred from the trait default and is
**unverified** live.

### How Codex runs a hook, and what it does with the answer

- Hooks run as `$SHELL -lc "<command>"` (`/bin/sh` when `SHELL` is unset), in a
  new session (`setsid`), with `cwd` as the working directory
  (`CX hooks/src/engine/command_runner.rs#L226`, `#L384-L437`). Note the login
  shell: profile scripts run on every hook. Claude Code uses `/bin/sh -c`.
- The environment is a snapshot of the Codex process's environment, taken when
  the session's hooks are built (`std::env::vars_os()`,
  `CX hooks/src/registry.rs#L79`), minus a short list of secrets
  (`CX protocol/src/shell_environment.rs#L13-L20`). Codex adds nothing of its
  own. `CODEX_THREAD_ID` goes only to tool processes, not hooks
  (`shell_environment.rs#L152`). The process may differ from the pane's: see
  the next section.
- Exit 0 with empty stdout is a clean no-op. Exit 2 with stderr blocks, on
  events that can block. Any other exit code is recorded as a failed hook, and
  stdout that is not JSON fails too (`CX hooks/src/events/stop.rs#L277-L375`).
  claude-mux's hook prints nothing and exits 0 on success, so Codex reads it
  as a no-op. It exits 1 only on an event it does not know, which setup would
  never register.
- Timeouts default to 600 s (1 s for SessionEnd and Interrupt). Matching hooks
  for one event run concurrently, and `async: true` runs a hook in the
  background, eight at most per session (`command_runner.rs#L54`, official
  docs).

## Where hooks run: the daemon

`codex` in 0.160 does not, by default, run its agent in the process the pane
started. The `daemon_auto_start` feature is stable and on
(`CX features/src/lib.rs#L947-L952`; `codex features list` prints
`daemon_auto_start stable true`). With it on, an interactive launch starts or
joins a shared app-server daemon, and the TUI becomes a client of it
(`CX tui/src/startup_orchestration.rs#L494-L497`, `#L524-L530`;
`CX tui/src/lib.rs#L1013-L1040`). On Unix the daemon is spawned once, detached
with `setsid`, and inherits the environment of the TUI that spawned it
(`CX app-server-daemon/src/backend/pid_start.rs#L81-L144`). Its socket is
`$CODEX_HOME/app-server-control/app-server-control.sock`
(`CX app-server-transport/src/transport/mod.rs#L53-L70`).

Sessions, and so hooks, then run inside the daemon. A hook started there:

- inherits the first pane's `TMUX_PANE`, so `getTmuxTarget()` would name the
  wrong pane, and two Codex sessions would delete each other as "stale
  duplicates" in `deleteSessionsByTmuxTarget()`. If the daemon was started
  outside tmux, there is no pane at all;
- inherits the first pane's `MAESTRO_ROLE` / `MAESTRO_ISSUE`, so every worker
  would claim the first worker's issue;
- has the daemon, not the pane's `codex`, as its parent, so `getClaudePid()`
  walks to the wrong process.

The daemon is skipped, and the session runs embedded in the pane's own
process, when any of these hold (`CX tui/src/daemon_startup.rs#L25-L89`):
`--no-daemon`, `--oss`, `--profile`, `--strict-config`,
`--dangerously-bypass-hook-trust`, a custom config loader, `CODEX_EXEC_SERVER_URL`,
or **any `-c` override** outside a short allow-list. The flag is documented in
`codex --help` as "Run without the shared background server, even if it is
already running". So claude-mux has two choices. It can launch Codex with
`--no-daemon`, which leaves the hook's environment and process tree as they
are today. Or it can stop trusting the environment and resolve the pane some
other way, for example from `session_id` to rollout to the TUI client.
**Unverified:** nothing here shows how a TUI client could be found from a
thread id.

Hooks in `codex exec` run embedded too. `exec` is not considered here.

## Configuration, scope and trust

### Where

Hooks load from every config layer at once (`CX hooks/src/engine/discovery.rs#L94-L206`):

- user: `~/.codex/hooks.json`, or a `[hooks]` table in `~/.codex/config.toml`
  (`$CODEX_HOME` replaces `~/.codex`);
- project: `<repo>/.codex/hooks.json` or `.codex/config.toml`, loaded only when
  the project's `.codex/` layer is trusted (official docs);
- system and managed layers (`/etc/codex/config.toml`, MDM, enterprise
  `requirements.toml`), which count as managed and need no trust
  (`discovery.rs#L823-L839`);
- plugins (`hooks/hooks.json` in a plugin bundle);
- session flags (`-c hooks...`).

`hooks.json` is `{ "description"?: string, "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ handler ] } ] } }`
(`CX config/src/hook_config.rs#L10-L17`, `#L153-L159`). A command handler is
`{ "type": "command", "command", "commandWindows"?, "timeout"?, "async"?, "statusMessage"?, "additionalContextLimit"? }`
(`hook_config.rs#L161-L185`). This is Claude Code's shape, so
`getClaudeWatchHooks()` minus `Notification` and `PostToolUseFailure` can be
written there as it is. A layer holding hooks in both its `hooks.json` and its
`config.toml` gets a warning, and both are loaded (`discovery.rs#L152-L164`).
Matchers count only for tool, compaction, session-start/end and subagent
events. `UserPromptSubmit`, `Stop` and `Interrupt` ignore them
(`CX hooks/src/events/common.rs#L112-L128`). Hooks are on by default (feature
`hooks`, stable, true in `codex features list`).

### Trust

A non-managed hook runs only when it is enabled **and** trusted
(`discovery.rs#L713-L735`), unless `--dangerously-bypass-hook-trust` is passed.
Trust status is computed per hook (`discovery.rs#L794-L811`):

- `trusted`: the stored `trusted_hash` equals the hook's current hash;
- `modified`: a hash is stored but differs. **Any change to the command line,
  such as a new claude-mux version or path, un-trusts the hook;**
- `untrusted`: no hash is stored.

The hashes live **only in the user layer or session flags**
(`CX hooks/src/config_rules.rs#L15-L63`), as

```toml
[hooks.state."<source path>:<event_snake>:<group index>:<handler index>"]
trusted_hash = "sha256:<hex>"
```

The key is built by `hook_key()` (`CX hooks/src/lib.rs#L112-L123`), with the
event as a snake-case label (`#L95-L110`). The source path is the absolute
path of the `hooks.json` (or `config.toml`). The hash is
`"sha256:" + hex(sha256(canonical_json(identity)))`, where `identity` is
`{ event_name: <snake label>, matcher?: <matcher>, hooks: [ <normalized handler> ] }`
and the normalized handler has its timeout filled in, `commandWindows` dropped,
and unset fields left out (`discovery.rs#L503-L567`, `#L767-L792`;
`CX config/src/fingerprint.rs#L54-L84`). Canonical JSON means sorted keys and
no whitespace. For a command hook with no matcher this is

```json
{"event_name":"stop","hooks":[{"async":false,"command":"claude-mux-hook stop","timeout":600,"type":"command"}]}
```

**Verified live.** In an isolated `CODEX_HOME`, `codex app-server`'s
`hooks/list` reported keys and `currentHash`es for three hooks. A
ten-line Python reimplementation of the formula above gave the same three
hashes. Writing one of them to `config.toml` turned that hook `trusted`, and a
wrong hash turned another `modified`. Inputs and outputs are in
`fixtures/codex-hooks/trust/`.

People trust hooks through `/hooks` in the TUI, or the startup picker that
appears when any hook needs review: "Review hooks", "Trust all and continue",
"Continue without trusting (hooks won't run)". Both write `trusted_hash` under
`hooks.state` (`CX tui/src/hooks_rpc.rs#L51-L92`;
`CX tui/src/startup_hooks_review.rs#L143-L170`, `#L278-L289`). **An unattended
pane started with untrusted hooks stops at that picker**, unless it is launched
with `--dangerously-bypass-hook-trust`, which also forces embedded mode.

So `claude-mux setup` can make Codex sessions run its hooks, with no dialog,
in one of three ways:

1. Write `~/.codex/hooks.json` and the matching `trusted_hash` entries into
   `~/.codex/config.toml`, recomputing them on every rewrite. This is the one
   verified end to end, at the level of `hooks/list`.
2. Write the hooks into the system layer, `/etc/codex/config.toml`, which
   counts as managed and needs no trust. This needs root, so it is a poor fit.
3. Launch Codex with `--dangerously-bypass-hook-trust`. That runs every
   enabled hook, project ones included, and Codex calls it dangerous.

## Telling Codex from Claude Code

There is no environment variable. Codex sets nothing of its own in its
process environment. `load_dotenv` refuses to set `CODEX_*`
(`CX arg0/src/lib.rs#L302-L326`), and only `PATH` may gain a helper directory
(`#L162-L177`). Ways that work:

1. **The command line.** Setup controls it, so Codex's `hooks.json` can call
   `claude-mux-hook --agent codex <event>` (or an env assignment in front,
   `CLAUDE_MUX_AGENT=codex …`, as `hookCommand()` already prefixes `PATH=`).
   This is exact and costs nothing.
2. **The payload.** `turn_id` appears on every Codex event except SessionStart
   and SessionEnd, and on no Claude Code event. `transcript_path` sits under
   `$CODEX_HOME/sessions/` and is named `rollout-…jsonl`. Both are heuristics.
   A null `transcript_path` defeats the second, and Claude Code adding a field
   would defeat the first.
3. **The process tree.** In embedded mode the hook's ancestor is the `codex`
   binary. Under the daemon it is `codex app-server --managed-daemon`.

## Which states Codex can drive

| claude-mux state | Claude Code source | Codex source | Verdict |
|---|---|---|---|
| busy | UserPromptSubmit, PreToolUse, PostToolUse | the same | yes |
| done (`turn_completed_at`) | Stop with no waking `background_tasks` | Stop | yes, but no background awareness (below) |
| idle after an interruption | pane scrape (`checkForInterruption`) | `Interrupt` | yes, and better than Claude |
| permission | `Notification(permission_prompt)`, PermissionRequest | PermissionRequest | yes. It fires before Guardian, so with Guardian on it may mean "being reviewed", not "waiting on you" |
| waiting (question) | PreToolUse(AskUserQuestion) | PreToolUse(`request_user_input`) | yes, Plan mode only by default; **unverified** live |
| waiting (elicitation) | `Notification(elicitation_dialog)` | none (MCP elicitations fire no hook) | no |
| idle via notification | `Notification(idle_prompt)` | none | no; Stop and Interrupt cover it |
| back to busy after a dialog is answered | next PreToolUse/PostToolUse | the same, but a denied tool fires no PostToolUse | partly: busy returns at the next tool or Stop |
| turn ended by an error | (Claude fires Stop) | nothing | **no**: stays busy until the next prompt. Needs a pane or rollout check |
| session registered before the first prompt | SessionStart at launch | SessionStart at the first turn | **no**: an untouched Codex pane is unknown until it is first used |
| subagents | SubagentStart/Stop, `agent_id` on tool events | the same names | yes, with the differences below |

## What breaks if `claude-mux-hook.ts` runs unchanged

The hook would parse every Codex payload. `HookInput` has no strict schema,
and `mapEventName()` already maps every shared event name. What goes wrong:

1. **Wrong pane, issue and pid under the daemon** (section above). This
   decides whether Codex works at all: either launch with `--no-daemon`, or
   change how the hook finds its pane.
2. **A subagent's events overwrite the parent's transcript path.**
   `changeSession()` sets `session.transcript_path = input.transcript_path` on
   every event (`claude-mux-hook.ts#L548`). Codex sends a subagent's own
   rollout as `transcript_path` on its tool, prompt and start events
   (`hook_runtime.rs#L199-L201`, `#L159`), so the parent's transcript would
   switch to the child's. It must be ignored when `agent_id` is set (SubagentStop
   is fine: there `transcript_path` is the parent's).
3. **A subagent's UserPromptSubmit resets the parent's turn.** Codex sends
   UserPromptSubmit for a child's input with `agent_id` set
   (`hook_runtime.rs#L684-L694`). `handleUserPromptSubmit()` does not check
   `agent_id`, so it would reset `turn_started_at`, clear `turn_completed_at`
   and possibly take the child's brief as the session's title.
4. **Subagent bookkeeping keys on Claude names.** `isAgentTool()` looks for
   `Agent`/`Task`, but Codex sends `spawn_agent`. Its input has `agent_type`
   and `message` where Claude has `subagent_type` and `description`. The
   transcript locations differ too: `subagentTranscriptPath()` and
   `readSubagentMeta()` assume Claude's `<id>/subagents/agent-<id>.jsonl`
   layout, whereas Codex gives the child's rollout directly
   (`transcript_path` on SubagentStart, `agent_transcript_path` on
   SubagentStop). Agents would still appear, through
   SubagentStart/SubagentStop, but they would lack descriptions and be pruned
   as transcript-less (`claude-mux-hook.ts#L932-L937`) unless the child's
   rollout path is used.
5. **No `background_tasks` on Stop.** `wakingTasks()` reads an empty list, so
   every Stop marks the session done and closes any running subagent. **Unverified:**
   whether a Codex parent turn can end while a spawned agent still runs, and
   whether the child's end wakes the parent. If both are true, the parent would
   show done while its agent works.
6. **Labels.** `formatToolAction()` knows Claude tool names. Codex's `Bash`
   matches, but `apply_patch` shows "Running: apply_patch" with no file name
   (the path is inside the patch text), and `request_user_input` is not
   treated as `AskUserQuestion`, so a question would read busy.

Unchanged and fine: SessionStart (resume and compact keep state, and `fork` is
new but falls through to startup behaviour), Stop (apart from item 5),
PermissionRequest, PreToolUse and PostToolUse for root tools, and SessionEnd
(it deletes the file; under the daemon it comes about a minute late).
Interrupt needs a new handler. Today it would hit "unknown event" and exit 1,
which is why setup must not register it until there is one.

## Fixtures

`docs/research/fixtures/codex-hooks/` holds one sample stdin payload per event
and per interesting tool. Built from the 0.160.0 structs, they validate
against Codex's generated input schemas: every required key present, no key
outside `properties` (the schemas set `additionalProperties: false`), and
enum/const values respected. Ids, paths, prompts and outputs are illustrative.
Key order follows the structs. A subagent's id and type, when sent on
tool/prompt events, are placed after the common fields; order carries no
meaning.

| File | What it shows |
|---|---|
| `session-start.startup.json`, `.resume.json`, `.compact.json` | SessionStart, no `turn_id` |
| `user-prompt-submit.json` | prompt with `turn_id` |
| `pre-tool-use.bash.json`, `.apply-patch.json`, `.mcp.json`, `.spawn-agent.json`, `.request-user-input.json` | tool names and inputs |
| `pre-tool-use.subagent-bash.json` | a subagent's tool event: parent `session_id`, `agent_id`, child's rollout as `transcript_path` |
| `permission-request.bash.json`, `.apply-patch.json`, `.network.json` | no `tool_use_id`; Bash `description` |
| `post-tool-use.bash.json`, `.apply-patch.json` | `tool_response` as a string |
| `subagent-start.json`, `subagent-stop.json` | child ids; Stop carries both transcripts |
| `stop.json`, `stop.continued.json` | `stop_hook_active` false / true |
| `interrupt.json` | the event Claude lacks |
| `pre-compact.json`, `post-compact.json` | no `permission_mode` |
| `session-end.json` | no `model`, `reason: "other"` |
| `legacy-notify.argv.json` | the older `notify = [...]` config: a kebab-case `agent-turn-complete` JSON appended as the **last argv argument**, not stdin (`CX hooks/src/legacy_notify.rs`), fired after Stop (`turn.rs#L703`) |
| `trust/hooks.json`, `trust/config.toml`, `trust/hooks-list.*.response.json` | **real** Codex output: `hooks/list` before trust, and after one right and one wrong `trusted_hash` |

## `main` against 0.160.0

Between the tag and `main` (744 commits), the hook input structs and their
generated schemas did not change: `git diff rust-v0.160.0 main` is empty for
`hooks/src/schema.rs` and `hooks/schema/generated/`. The event list is the
same. The changes are internal (context metadata, compiled matchers) and one
trust change for **plugin** hooks only. A plugin hook's hash now also covers
the plugin's contents, with a new `trusted_content_hash` field
(`config/src/hook_config.rs` on `main`). A user `hooks.json` keeps the
declaration-only hash above. `daemon_auto_start` is still stable and on, and
hooks still snapshot `std::env::vars_os()`.

## What was never proven live

- Every payload. No Codex turn was run, because that needs a login.
- That `request_user_input` reaches PreToolUse in practice, and in which modes
  the default TUI offers it.
- SessionEnd's timing under the daemon, and whether a turn keeps running after
  its pane closes.
- Whether a parent turn can Stop while a spawned agent runs, and whether the
  agent's end wakes it.
- That `--no-daemon` keeps `TMUX_PANE` and the process tree as in embedded
  mode. This follows from the source (`registry.rs#L79`,
  `daemon_startup.rs#L33`), not from a run.
- The trust write was proven at the level of `hooks/list`. That a TUI then
  starts without the review picker follows from `review_is_needed()`
  (`startup_hooks_review.rs#L286-L288`), which was not run.
