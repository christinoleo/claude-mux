# Cross-agent workers: Claude Code and Codex handing work to each other

Research note, 2026-10-16. The question had three parts:

1. How does T3 Code (t3code) let an agent from one provider hand work to an
   agent from another provider, such as Claude Code delegating to Codex or
   Codex delegating to Claude?
2. What mechanisms exist in general for Claude and Codex to delegate to each
   other?
3. What would the maestro skill need for its workers to run on Codex instead
   of Claude Code?

Only primary sources were used: source code at a pinned commit, official
documentation, and the CLIs installed on this machine (`codex-cli 0.160.0`,
`Claude Code 2.1.300`). Anything not confirmed against one of those is marked
**unverified**.

Pinned sources:

| Source | Commit / version |
|---|---|
| `pingdotgg/t3code` (upstream `main`) | `cfafb4bb54` (2026-10-16). The local clone at `~/Projects/t3code` was at `d22c6f52` (2026-04-16), which predates the feature, so upstream was read from a `git archive` |
| `openai/codex` | `b5115cdd66` (2026-10-16) |
| `openai/codex-plugin-cc` | `db52e28f4d` (2026-07-07) |
| maestro (`ak` plugin) | `~/.claude/plugins/cache/aknakos-workflow/ak/1.10.0/` |

Link prefixes used below:
`T3` = `https://github.com/pingdotgg/t3code/blob/cfafb4bb54/`,
`CX` = `https://github.com/openai/codex/blob/b5115cdd66/`,
`CP` = `https://github.com/openai/codex-plugin-cc/blob/db52e28f4d/`.

---

## Summary

- **t3code does have cross-provider delegation.** It does not use any
  provider's native subagent mechanism. t3code runs its own MCP server
  (`t3-code`, streamable HTTP at `/mcp`, with a bearer token issued for each
  session) and injects it into every provider session it starts: through the
  Claude Agent SDK's `setMcpServers` for Claude, and through the
  `thread/start` config (`mcp_servers`) of `codex app-server` for Codex. The
  agent calls the `delegate_task` tool with a provider instance and model.
  t3code creates a child thread on that provider, runs it, and when the child
  finishes it wakes the parent with a message telling it to call
  `task_status`. Delegation is the orchestrator's job, and neither agent
  knows anything about the other. The feature landed on 2026-10-02
  (pingdotgg/t3code#2829, "introduce new orchestrator").
- **Claude to Codex, today:** shell out to `codex exec` (non-interactive,
  JSONL events, `-o` writes the last message to a file, `resume` continues a
  session), or install OpenAI's own Claude Code plugin
  `openai/codex-plugin-cc`, which wraps a Bash-only Claude subagent around
  `codex app-server`. **`codex mcp-server` no longer exists.** It was removed
  on 2026-09-05 (openai/codex#42993), and on 0.160 the words are taken as a
  prompt for the TUI.
- **Codex to Claude, today:** Codex's native subagents cannot change provider:
  per the docs they "inherit the parent's permissions, provider, and MCP
  servers". That leaves `claude -p` from Codex's shell (`--output-format
  json` returns `session_id` and `result`; `--resume` continues), or
  `claude mcp serve` as an MCP server for Codex. The second exposes Claude
  Code's *tools*, `Agent` among them, not a Claude conversation (see §2.4).
- **Maestro with Codex workers is mostly a launch-command change.** Codex
  now runs Claude-format hooks: its hook engine is named
  `ClaudeHooksEngine`, its `Stop` output takes `{"decision":"block","reason":…}`
  and feeds the reason back as a continuation prompt, it sets
  `CLAUDE_PLUGIN_ROOT` for plugin hooks, and it discovers
  `.claude-plugin/plugin.json` manifests. So the stop gate and the worker
  skill carry over with small edits. What breaks is the Claude-only pieces:
  the `claude … '/ak:maestro-worker N'` launch line, the `/simplify` and
  `/code-review` steps (Claude Code built-ins; Codex has `codex review`),
  hook trust (Codex skips untrusted hooks, so an unattended worker needs
  `--dangerously-bypass-hook-trust` or pre-trusted hooks), and claude-mux,
  which would not see a Codex worker at all because its hook is installed
  only into `~/.claude/settings.json`.

---

## 1. How t3code does it

### 1.1 How it drives each provider

t3code's server holds one adapter per provider. The built-in drivers are
Claude, Codex, Cursor, Grok, OpenCode, Muse, Pi, Antigravity and a generic ACP
registry driver (`T3 apps/server/src/provider/builtInDrivers.ts`).

- **Claude** goes through the Claude Agent SDK: `ClaudeAdapterV2.ts` imports
  `query` from `@anthropic-ai/claude-agent-sdk` (line 41) and feeds it a
  prompt queue (`T3 apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
  around lines 725–800).
- **Codex** goes through `codex app-server`, the JSON-RPC protocol behind the
  Codex IDE extension and app. `codexAppServerArgs()` returns
  `["app-server", …launchArgs]` (`T3 apps/server/src/provider/codexLaunchArgs.ts`),
  and `CodexAdapterV2.ts` talks to it with the `effect-codex-app-server`
  client (`thread/read`, `thread/inject_items`, …; `T3 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
  lines 73–75, 1033, 1727).

### 1.2 The delegation mechanism: an app-owned MCP server

t3code serves an MCP server over HTTP at `/mcp` with bearer-token auth
(`T3 apps/server/src/mcp/McpHttpServer.ts`, lines 81, 149–150, 830).
`McpSessionRegistry` issues a credential tied to the thread for each provider
session (`T3 apps/server/src/mcp/McpSessionRegistry.ts`), and
`ProviderSessionManager` reserves it while an adapter opens its session
(`T3 apps/server/src/orchestration-v2/ProviderSessionManager.ts`, lines
296–420).

The server is then injected into each provider session as `t3-code`:

- **Claude:** `claudeMcpQueryOverrides()` builds
  `mcpServers: { "t3-code": { type: "http", url, headers: { Authorization }, timeout } }`
  and adds `mcp__t3-code__*` to `allowedTools`, or only the read-only tools
  in a read-only sandbox (`ClaudeAdapterV2.ts` lines 1213–1240 and 1174).
  The adapter does not pass `mcpServers` to `query()`. It strips them out and
  calls `queryRuntime.setMcpServers()` over the CLI's stdin control channel,
  "so header credentials stay out of its argv and out of the environment"
  (lines 736–790). It also appends `T3_CODE_ORCHESTRATION_INSTRUCTIONS` to
  the system prompt when the MCP server is present (line 1161).
- **Codex:** `codexThreadRuntimeParams()` puts
  `mcp_servers: { "t3-code": { url, tool_timeout_sec: 3900, http_headers: { Authorization } } }`
  into the thread's `config` (`CodexAdapterV2.ts` lines 1295–1330). The
  65-minute tool timeout is there because t3code's wait tools can block for
  up to an hour.
- **ACP agents** that accept the server but do not expose its tools get a
  fallback: a CLI that runs the same tool from the terminal (`acp-mcp-call
  delegate_task '{…}'`), described in the injected instructions
  (`T3 packages/provider-core/src/server/orchestrationInstructions.ts` line 32;
  `T3 apps/server/src/mcp/AcpMcpStdioBridge.ts`).

### 1.3 The tools

The toolkit is defined in `T3 apps/server/src/mcp/toolkits/orchestrator/tools.ts`:

| Tool | What it does |
|---|---|
| `orchestrator_capabilities` | Lists provider instances and models from the same live catalog as the composer |
| `delegate_task` | Starts a child agent/subagent of *this* thread on any provider and model, with only the task prompt (the parent's history is not copied). Options: `mode: async \| wait`, `isolation: "worktree"` (a separate checkout from the parent's local commit), and overrides for runtime and interaction mode |
| `task_status`, `task_cancel` | Read or stop a delegated task |
| `t3_thread_send / read / wait / interrupt / list` | Message, read, wait on or interrupt any t3code thread (`send` modes: auto, queue, steer, restart) |
| `create_threads`, `t3_thread_launch` | Create ordinary top-level threads, not children. The instructions forbid using them just because the user said "subagent" |
| `schedule_task` and the related tools, `request_secret`, `t3_workflow_stop` | Scheduling, secrets, stopping a Claude workflow |

The tool description says outright that this is the cross-provider path:
"Prefer native subagent tools for same-provider work only when they support
the chosen model. Use this for any model missing from the native tool,
including same-provider work, for cross-provider work, or for explicitly
T3-owned child tasks." The system-prompt addendum says the same thing
(`orchestrationInstructions.ts` line 9). It also tells the agent that some
harnesses attach MCP servers lazily, so it should make one bounded direct
call such as `tools.mcp__t3_code__orchestrator_capabilities({})` before
deciding the capability is missing (line 30).

### 1.4 What happens on `delegate_task`

`OrchestratorMcpService.delegateTask` (`T3 apps/server/src/mcp/OrchestratorMcpService.ts`
lines 1902–2041):

1. Requires an active run on the parent thread owned by the calling MCP
   session, and resolves the target provider/model against the live catalog.
2. With `isolation: "worktree"`, resolves the parent checkout's `HEAD` and
   asks for a worktree workspace based on that commit.
3. Dispatches a `delegated_task.request` command to the orchestrator, with
   `completionWake: "always"` for async or `"settled_only"` for wait. That
   produces a `subagent.updated` event (origin `app_owned`) holding a
   `childThreadId`, and a `run.created` on the child, whose workspace is then
   prepared.
4. `async` returns the task at once. `wait` blocks up to a timeout (default
   10 min, max 60 min), and if it gives up it upgrades the wake policy so that
   a later completion still wakes the parent.

When the child finishes, the orchestrator posts a message to the parent:
"Delegated task X reached a terminal state. Use task_status with taskId X to
read the result." (`T3 apps/server/src/orchestration-v2/Orchestrator.ts`
lines 563–568, and `ProviderContinuationService.ts` lines 13–18). The message
is steered into an active turn where the provider supports that, or queued
otherwise. Delivery is at least once, and reusing the message id keeps
recovery from duplicating it
(`T3 apps/server/src/orchestration-v2/NotificationMailbox.ts`). A child that
asks a question surfaces it as `hasPendingQuestion`, and the parent answers
through `t3_pending_request_*` (`DelegatedTaskQuestionReactor.ts`; tool
description of `delegate_task`).

**What the design gets right:** neither provider has to support the other.
Each agent sees a provider-neutral MCP tool, the orchestrator owns the child's
lifecycle (worktree, permissions capped at the parent's, cancel, persistence,
restart recovery), and the result goes back as a message, not as a tool
result the parent has to poll for.

---

## 2. General mechanisms for Claude ↔ Codex

### 2.1 `codex mcp-server`: removed

openai/codex commit `531f3836a1` (2026-09-05, PR #42993): "Remove the `codex
mcp-server` subcommand and the standalone `codex-mcp-server` crate". On the
installed `codex-cli 0.160.0`, `codex --help` no longer lists it, and
`codex mcp-server` with piped stdin fails with `Error: stdin is not a
terminal`, which means the words were taken as a prompt for the interactive
TUI (checked on this machine). **Any recipe that registers Codex in Claude
Code with `claude mcp add codex -- codex mcp-server` is out of date.** What
remains under `codex mcp` is the client side: `list/get/add/remove/login/logout`
(`codex mcp --help`).

### 2.2 `codex exec`: Codex as a subprocess

From `codex exec --help` (0.160) and the official page
(<https://learn.chatgpt.com/docs/non-interactive-mode>, redirected from
developers.openai.com/codex/noninteractive):

- `codex exec "<prompt>"` runs without the TUI. Progress goes to stderr and
  only the final message to stdout.
- `--json` turns stdout into JSONL events (`thread.started`, `turn.started`,
  `item.*`, `turn.completed`, `turn.failed`, `error`).
- `-o/--output-last-message <file>` writes the final message to a file.
  `--output-schema <file>` constrains it to a JSON Schema.
- `codex exec resume --last "<prompt>"` or `codex exec resume <SESSION_ID>`
  continues a session.
- The sandbox is read-only by default. `--sandbox workspace-write` allows
  edits. `--full-auto` "is no longer supported", and `--approve-for-me` sends
  approvals to automatic review instead.
  `--dangerously-bypass-approvals-and-sandbox` removes both.
- Also available: `-m <model>`, `-C <dir>`, `--worktree` (a new managed git
  worktree), `--ephemeral`, `--skip-git-repo-check`.

This is the simplest way for Claude Code to delegate to Codex: a Bash call,
optionally run in the background, that reads `-o` when it finishes.

### 2.3 `codex app-server` and OpenAI's Claude Code plugin

`codex app-server` ("[experimental]" in `codex --help`) is the JSON-RPC
protocol that both t3code (§1.1) and OpenAI's own plugin use. The plugin,
`openai/codex-plugin-cc` ("Use Codex from Claude Code to review code or
delegate tasks", `CP README.md`), gives Claude Code:

- `/codex:review`, `/codex:adversarial-review`: read-only Codex reviews.
- `/codex:rescue` and the `codex:codex-rescue` subagent: hands a task to Codex,
  with `--background`, `--wait`, `--resume`, `--model`, `--effort`.
- `/codex:transfer`: turns the current Claude Code transcript into a Codex
  thread through Codex's external-agent session importer, and prints
  `codex resume <id>`.
- `/codex:status`, `/codex:result`, `/codex:cancel` for background jobs, and
  an optional `Stop`-hook "review gate".

How it is wired: the subagent is a Claude Code agent with `tools: Bash` and
`model: sonnet`, told to make "exactly one `Bash` call to invoke `node
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...`" and do nothing
else (`CP plugins/codex/agents/codex-rescue.md`). The companion runs
`spawn("codex", ["app-server"])` (`CP plugins/codex/scripts/lib/app-server.mjs`
line 190) and drives `thread/start` / `turn/start`
(`CP plugins/codex/scripts/lib/codex.mjs` lines 733, 1136). So the
first-party Claude → Codex route is a native Claude subagent acting as a thin
proxy over a Codex process, with no MCP involved.

### 2.4 Claude Code from Codex

- **Codex native subagents stay on one provider.** Custom agents are TOML files
  in `~/.codex/agents/` or `.codex/agents/` (`name`, `description`,
  `developer_instructions`, optional `model`, `model_reasoning_effort`, …).
  Subagents "inherit the parent's permissions, provider, and MCP servers; a
  custom agent file can't override those settings", and `model_provider`
  is listed among the settings that cannot be overridden
  (<https://learn.chatgpt.com/docs/agent-configuration/subagents>). In
  source, the spawn tool is `spawn_agent`, which hooks also see as `Agent`
  (`CX codex-rs/core/src/tools/hook_names.rs` lines 43–46).
- **`claude -p`** (<https://code.claude.com/docs/en/headless>): non-interactive;
  `--output-format json` returns `result` and `session_id`; `--resume <id>`
  (or a transcript path) continues; `--json-schema` for structured output;
  `--permission-mode`, `--allowedTools`, `--permission-prompts none` for
  unattended runs; `--bare` skips hooks, skills, plugins, MCP servers and
  CLAUDE.md for reproducible runs (and then needs `ANTHROPIC_API_KEY`). A
  `-p` run waits for its own background subagents before exiting. User skills
  and commands work if `/name` is in the prompt. From Codex this is a shell
  command, the mirror image of §2.2.
- **`claude mcp serve`** starts Claude Code as a stdio MCP server. The docs
  say it "only exposes Claude Code's tools to your MCP client, so your own
  client is responsible for implementing user confirmation"
  (<https://code.claude.com/docs/en/mcp>). On 2.1.300, a `tools/list` probe
  run on this machine returned `Agent, Bash, Read, Edit, Write, NotebookEdit,
  WebFetch, ReportFindings, WebSearch, TaskStop, Skill, DesignSync,
  EnterWorktree, ExitWorktree, SendMessage, ListAgents, Workflow, CronCreate,
  CronDelete, CronList, ScheduleWakeup, RemoteTrigger, Monitor,
  PushNotification, ToolSearch` (serverInfo `claude/tengu 2.1.300`). The
  `Agent` tool is in that list, so a Codex session with `claude mcp serve`
  registered might be able to start a Claude subagent through it.
  **Unverified:** I did not call `Agent` over MCP, and the docs say nothing
  about it.
- **Claude Code subagents stay on Claude.** The `model` field takes `sonnet`,
  `opus`, `haiku`, `fable`, a full Claude model id, or `inherit`
  (<https://code.claude.com/docs/en/sub-agents>). The docs list no way to run
  a non-Claude model as a subagent, other than a gateway behind
  `ANTHROPIC_BASE_URL`, which is about reaching Claude models.

### 2.5 The options side by side

| Route | Direction | Wiring | Result returns as | Notes |
|---|---|---|---|---|
| t3code `delegate_task` | any → any | App-owned HTTP MCP server injected into each session | A wake message, then `task_status` | Needs t3code as the host |
| `codex exec` | Claude → Codex | Bash subprocess | stdout / `-o` file / JSONL | Simplest. Sandbox is read-only unless told otherwise |
| `openai/codex-plugin-cc` | Claude → Codex | Claude subagent (Bash) → `codex app-server` | Subagent result, background jobs | First party. Also handles the transcript handoff |
| `claude -p` | Codex → Claude | Shell subprocess | stdout JSON (`result`, `session_id`) | The mirror of `codex exec` |
| `claude mcp serve` | Codex → Claude tools | stdio MCP | Tool results | Tools, not a conversation. `Agent` over MCP is unverified |
| `codex mcp-server` | Claude → Codex | (was stdio MCP) | — | **Removed 2026-09-05** |

---

## 3. Maestro with Codex workers

### 3.1 What a worker depends on today

| Dependency | Where | Claude-specific? |
|---|---|---|
| Launch line `env MAESTRO_ROLE=worker MAESTRO_ISSUE=$issue claude $CLAUDE_ARGS '/ak:maestro-worker $issue'`, defaults `--model opus --dangerously-skip-permissions` | `scripts/maestro-daemon.sh` lines 39, 133 | Yes: the binary, its flags, and slash-command invocation of a plugin skill |
| The `maestro-worker` skill: `disable-model-invocation: true`, `$ARGUMENTS`, plugin namespace `ak:` | `skills/maestro-worker/SKILL.md` lines 1–8 | Frontmatter and argument substitution are Claude Code's |
| Verify steps: "`/simplify`, as a subagent" and "`/code-review` at medium, as a subagent" | `SKILL.md` lines 27–28 | Yes: built-in Claude Code skills, run through Claude's subagent tool |
| UI check "with Chrome DevTools" | `SKILL.md` line 30 | Depends on an MCP server configured in Claude Code |
| Stop gate: a `Stop` hook that blocks with `{"decision":"block","reason":…}` until the issue is closed or labelled `needs-help`, three strikes | `hooks/hooks.json`, `hooks/maestro-stopgate.sh` | Written against Claude's hook protocol, but see §3.2 |
| Coordination: GitHub labels, `gh`, `git worktree`, tmux window `mw-<issue>-…`, the closed issue as the done signal | daemon, both skills | **No**: all agent-neutral |
| claude-mux: the hook copies `MAESTRO_ROLE`/`MAESTRO_ISSUE` into the session JSON, the sidebar nests the worker under its daemon, and Needs-you lists a `needs-help` only while that worker's session is alive | `src/hooks/claude-mux-hook.ts` lines 521–549; `src/server/github.ts` lines 260–282 | Yes: the hook is installed only into `~/.claude/settings.json` (`src/setup/hooks.ts`) |

The coordination design, where GitHub holds the state and closing the issue
is the done signal, is what makes swapping the agent cheap. The daemon never
reads a worker's terminal.

### 3.2 What Codex now provides that maps onto this

- **Hooks, Claude-shaped.** The events include `SessionStart`, `Stop`,
  `SubagentStart/Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `PermissionRequest`, `PreCompact/PostCompact`, `SessionEnd`, `Interrupt`.
  They are configured in `~/.codex/hooks.json`, `[hooks]` in
  `~/.codex/config.toml`, `<repo>/.codex/…`, or a plugin's `hooks/hooks.json`,
  and the payload carries `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model` (<https://learn.chatgpt.com/docs/hooks>). In
  source, the engine type is `ClaudeHooksEngine`, the `Stop` output wire takes
  `decision: "block"` and `reason` ("Claude requires `reason` when `decision`
  is `block`; we enforce that"), and a block turns the reason into the
  continuation prompt (`CX codex-rs/hooks/src/schema.rs` lines 455–463;
  `CX codex-rs/hooks/src/events/stop.rs` lines 17, 259–319). The input also
  carries `stop_hook_active` and `last_assistant_message` (stop.rs lines
  28–39). **Unverified:** I did not run `maestro-stopgate.sh` under Codex end to
  end, but its regex for `hook_event_name` and its JSON output both match.
- **Hook trust.** Hooks that are not managed must be reviewed and trusted
  (`/hooks`), trust is tied to each hook's hash, and project-local hooks load
  only in a trusted `.codex/` layer. `--dangerously-bypass-hook-trust` skips
  the check for one invocation (hooks doc; `codex --help`). An unattended
  worker needs one or the other, or the stop gate silently does not run.
- **Plugins.** Codex discovers `.codex-plugin/plugin.json`,
  `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`
  (`CX codex-rs/exec-server-protocol/src/protocol.rs` lines 52–56), and sets
  both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` in a plugin hook's environment
  (`CX codex-rs/hooks/src/engine/discovery.rs` lines 302–304). **Unverified:**
  whether the whole `ak` plugin (skills, commands, agents, hooks) loads in
  Codex unchanged.
- **Skills.** Codex reads `SKILL.md` folders with `name` and `description`
  from `.agents/skills` in each directory from cwd up to the repo root, from
  `$HOME/.agents/skills`, and from `/etc/codex/skills`
  (<https://learn.chatgpt.com/docs/build-skills>). The user path the brief
  assumed, `~/.codex/skills`, is the "deprecated user skills location
  (`$CODEX_HOME/skills`), kept for backward compatibility"
  (`CX codex-rs/ext/skills/src/host_roots.rs` lines 95–106). Explicit
  invocation is `$skill-name` in the prompt or `/skills`. Setting
  `allow_implicit_invocation: false` in `agents/openai.yaml` is the analogue
  of `disable-model-invocation`. The docs describe no `$ARGUMENTS`
  substitution, so the issue number has to go in the prompt text.
- **Instructions.** `AGENTS.md` (or `AGENTS.override.md`) is read from
  `~/.codex`, then from each directory from the repo root down to cwd,
  concatenated, capped at `project_doc_max_bytes` (32 KiB by default)
  (<https://learn.chatgpt.com/docs/agent-configuration/agents-md>).
- **Review.** `codex review [--uncommitted | --base <branch>] [PROMPT]` runs
  a non-interactive code review (`codex review --help`). That is the nearest
  equivalent to `/code-review`. Codex has no built-in `/simplify` (no
  primary source lists one).
- **Talking to a running session.** `codex queue --thread <id|name> --message
  <text>` queues a message into an existing session (`codex queue --help`),
  which the daemon could use the way claude-mux pastes into a Claude pane.

### 3.3 What a Codex worker would need

1. **Daemon: an agent-neutral launch line.** Replace the hard-coded `claude`
   with a `--worker-cmd` template (or `--agent claude|codex`). For Codex in a
   tmux window (interactive, so a person can look at a `needs-help` session,
   which is why the daemon leaves those windows open):

   ```bash
   env MAESTRO_ROLE=worker MAESTRO_ISSUE=$issue \
     codex -m <model> --dangerously-bypass-approvals-and-sandbox \
           --dangerously-bypass-hook-trust \
           '$maestro-worker Implement GitHub issue #'"$issue"
   ```

   The interactive `codex` takes a positional `[PROMPT]`
   (`codex --help`). **Unverified:** whether a `$skill` mention in the initial
   positional prompt triggers the skill the same way typing it does. A safe
   fallback is to inline the skill body into the prompt, which is what the
   maestro skill already does for its "Without tmux" transport
   (`skills/maestro/SKILL.md` line 59).
   `codex exec` would also work for a worker that runs to completion with no
   one watching, but there would be nothing left to inspect after a
   `needs-help`. The daemon's reaping only reads the issue state, so either
   mode fits it.
2. **Worker skill: a Codex copy, or a shared body.** Ship `maestro-worker`
   where Codex looks for it (`~/.agents/skills/maestro-worker/` or the repo's
   `.agents/skills/`, or as a Codex plugin). Take the issue number from the
   prompt, not `$ARGUMENTS`. Replace step 5.2–5.3 with Codex equivalents:
   `codex review --uncommitted` (or a Codex subagent told to review), and
   either drop `/simplify` or describe its checklist in prose. Replace "Chrome
   DevTools" with whatever browser MCP is configured in
   `~/.codex/config.toml` (`[mcp_servers.…]`), or drop the UI step.
3. **Stop gate: register it for Codex.** The script itself should work as is
   (§3.2). It needs a `Stop` entry in `~/.codex/hooks.json` or the plugin's
   `hooks/hooks.json`, and trust (see 1). `MAESTRO_ROLE` and `MAESTRO_ISSUE`
   do reach the hook. Codex runs a command hook as `$SHELL -lc "<command>"`
   and replays the session's environment snapshot into it, filtering only a
   fixed deny-list of Codex/OpenAI credential variables
   (`CX codex-rs/hooks/src/engine/command_runner.rs` lines 406–458;
   `CX codex-rs/protocol/src/shell_environment.rs` lines 14–23). Because it
   runs through a shell, `${CLAUDE_PLUGIN_ROOT}` in the hook's command string
   expands as well.
4. **Done and needs-help signals: no change.** The worker runs `gh pr merge`
   (closes the issue) or `gh issue edit --add-label needs-help`, exactly as
   now. Nothing about these is specific to Claude.
5. **claude-mux: the gap.** A Codex worker writes no session JSON, so
   claude-mux would show its window as a plain pane, not nest it under the
   daemon, and **drop its `needs-help` from Needs-you**, because
   `src/server/github.ts` keeps a `needs-help` only while the asking worker's
   session is alive. Closing the gap means (a) installing `claude-mux-hook`
   into `~/.codex/hooks.json` as well. Its payload fields overlap with
   Claude's, but transcripts are Codex rollouts, not
   `~/.claude/projects/*.jsonl`, so the transcript, subagent and changes
   features would not work without a Codex reader (**unverified** how much of
   the hook works unchanged). Or (b), as a stopgap, have the inbox treat a tmux
   window named `mw-<issue>-…` as a live worker. claude-mux already knows
   about other agents (`src/agents.ts`: `claude`, `gemini`, `copilot`), but
   only as launch commands. Codex is not among them.

### 3.4 Alternatives worth weighing

- **Keep Claude workers, delegate inside them.** Install
  `openai/codex-plugin-cc` and let a Claude worker hand a subtask to Codex
  with `/codex:rescue`, or get a second-opinion review with `/codex:review`.
  This changes nothing in maestro or claude-mux and keeps the stop gate,
  skills and claude-mux visibility. The cost: the Claude worker still runs
  the show (and uses Claude quota).
- **Mixed fleet per issue.** A label such as `agent:codex` read by
  `dispatch()` to choose the launch template. This only becomes cheap once
  step 3.3.1 exists.
- **Host maestro on t3code instead.** t3code's `delegate_task` with
  `isolation: "worktree"` already covers "one child per task, own worktree,
  any provider, completion wakes the parent". But it is t3code's own
  orchestrator and UI, not tmux + GitHub labels + claude-mux, so it would
  replace maestro rather than extend it.

---

## Open questions (not verified here)

1. Does `codex '$maestro-worker …'` trigger the skill from the initial
   positional prompt?
2. Does the whole `ak` plugin (skills, commands, agents) load in Codex
   through `.claude-plugin/plugin.json`? The manifest is discovered, and hook
   commands get `CLAUDE_PLUGIN_ROOT` through a shell. The rest is untested.
3. Does calling `Agent` through `claude mcp serve` run a real Claude subagent,
   and does its result come back as the tool result?
4. How much of `claude-mux-hook.ts` works unchanged on Codex hook payloads?
