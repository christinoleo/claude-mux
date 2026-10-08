# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Server

Dev server runs via Vite with HMR at **http://localhost:3434** (or `--port` to change). Prod server uses :3456.

```bash
bun run dev:serve                    # Start dev server on :3434
bun run dev:serve --port 3456        # Custom port
bun run dev:serve --host 0.0.0.0     # LAN access
```

**HMR handles most changes automatically** - no restart needed for Svelte components, stores, routes, or API endpoints. Only `vite.config.ts` changes require a restart.

After each change, check tmux pane `dev:1.1` to verify HMR worked. If the server died, restart it. Do not start a new server if one is already running. If the pane reference is wrong, find the correct one and update this file.

## Build & Development Commands

```bash
bun src/cli.ts <command>               # Run CLI directly from source (no build needed)
bun run build                          # Build CLI + SvelteKit web app
bun run build:cli                      # Build CLI only (TypeScript)
bun run build:web                      # Build SvelteKit web app only
bun run dev:serve                      # Vite dev server with HMR
bun run prod:restart                   # Kill, rebuild, and relaunch prod server on :3456 (detached)
bun test                               # Run vitest tests
bun run lint                           # ESLint check
bun run format                         # Prettier formatting
```

**Use `bun src/cli.ts` for development** — bun runs TypeScript directly, no build step needed. Only build for production (`bun dist/cli.js`).

Run a single test file:
```bash
bun vitest run tests/db/sessions.test.ts
```

## Releasing

Releases are fully automated. **Do not `npm publish` manually.**

```bash
npm version minor    # bumps package.json + src/utils/version.ts, commits, tags vX.Y.Z
git push origin main
git push origin vX.Y.Z   # tag push triggers .github/workflows/release.yml
```

The workflow builds CLI + web, publishes to npm via **OIDC trusted publishing** (no token, no MFA — the trust anchor is `christinoleo/claude-mux` + `release.yml` registered on npmjs.com), and creates a GitHub release. Publish runs as `npx -y npm@latest publish --access public --provenance` because the runner's bundled npm is too old for OIDC.

After release, other machines update with: `claude-mux update`.

The published package installs only the root `dependencies`, so web packages
belong in web `devDependencies`, where Vite bundles them into the server; a web
`dependencies` entry stays a bare import and fails on every host but this one
(0.30.0 served `/` as a 500 that way, over `marked`). `prepublishOnly` runs
`scripts/check-server-externals.ts` after the build to catch it.

## Service management on remote hosts

For machines that should run claude-mux as a long-lived service (e.g. `engage`):

```bash
claude-mux service install               # ~/.config/systemd/user/claude-mux.service, enabled + started
sudo loginctl enable-linger $USER        # one-time: survive logout, start on boot
journalctl --user -u claude-mux -f       # logs
```

`update` auto-detects how the server is running and restarts it accordingly, installing with whichever of npm or bun owns the running binary. On systemd-managed hosts it never runs `systemctl stop` or `restart`: it installs while the server runs, then ends the main process and lets `Restart=always` start it again (patching an older unit to that first). For hosts started manually it stops the `nohup claude-mux serve` before installing and starts it after. Use `--skip-restart` to leave the server alone.

Why not `stop`: tmux 3.4+ built with systemd puts each pane in a scope that is `PartOf=` the unit the tmux server runs in. A server started by the dashboard's first New Session ran inside `claude-mux.service`, so stopping the service closed every pane on the host. `tmuxNewSession()` (`src/tmux/server.ts`) now starts a fresh tmux server under `systemd-run --user --scope` of its own; a server already running inside the service keeps that tie until it next exits, which is why `update` still avoids stop jobs.

## Architecture

claude-mux has three main components:

### 1. Claude Code Hooks → JSON Files
The hook script (`src/hooks/claude-mux-hook.ts`) runs inside Claude Code's process. It receives events via stdin (SessionStart, UserPromptSubmit, PreToolUse, Stop, etc.) and writes state to per-session JSON files in `~/.claude-mux/sessions/`.

Subagents land on the parent's JSON as `subagents`, from `SubagentStart` to
`SubagentStop`. The start payload names only `agent_id` and `agent_type`, so the
description comes from the `agent-<id>.meta.json` Claude Code writes beside the
agent's transcript (`<session id>/subagents/` next to the parent's JSONL), or
else from the parent's `Agent` call in `PreToolUse`, parked in `agent_calls`
until its start claims it; `SubagentStop` reads the meta again, since that
pairing goes by agent type alone. A failed `Agent` call marks its agent
`failed`, a Stop that really ends the turn closes any agent still marked
running (Escape never sends its `SubagentStop`). A subagent's own tool calls
arrive under the parent's session id with `agent_id` set, and the latest one
rides on the agent as `current_tool`. Finished agents stay an hour and failed
ones a day: the sidebar (`agentView()` in `src/subagents.ts`) draws a finished
agent as a dimmed row for ten minutes and then only counts it ("3 agents done"
on the parent), while a failed one keeps its red row until it is opened from
this browser.

### 2. SvelteKit Web Server + WebSocket
The web server (`web/`) is built with SvelteKit and svelte-adapter-bun:
- **File watcher** (`src/server/watcher.ts`): Polls JSON files for changes (500ms interval)
- **WebSocket channels**: Real-time updates for sessions list and terminal output
- **API routes**: REST endpoints for session management, tmux control, folder browsing
- **Hooks** (`web/src/hooks.server.ts`): WebSocket upgrade handling, session managers

### 3. State Detection
**Hooks are authoritative** for all state transitions. Pane content polling only catches one edge case: when the user presses Escape to interrupt. The `checkForInterruption()` function in `src/tmux/pane.ts` detects "Interrupted" or "User declined" messages.

### 4. Reading the prompt box

`readPromptBox()` in `src/tmux/pane.ts` reads whatever sits in Claude Code's
input box — the region between the last two `─────` separators in the pane. It
needs a capture taken with colour (`capture-pane -e`), because ANSI is the only
thing that separates text a human typed (unstyled) from text Claude Code drew
itself (faint, SGR 2): prompt suggestions and hints such as "Press up to edit
queued messages". Suggestions surface as `draft_kind: 'suggestion'` and are
accepted with Tab then Enter; hints are dropped via the `PROMPT_HINTS` patterns.

`readQueuedMessages()` reads the other half of the same picture: messages the
user typed into the pane while Claude was busy. Claude Code has drawn them two
ways. Since September 2026 the queue sits above the spinner, closed by the hint
`ctrl+x ctrl+s to send now`, and each row starts at column 0 like a submitted
message; only the dim grey text (`38;5;246`, against white for a sent one)
tells them apart. Before, the queue sat directly above the box, indented two
spaces on a painted row (`48;5;237`), and a submitted message started at
column 0. The reader tries the hint first and falls back to the older layout.

`readPromptOptions()` reads the third thing a pane can hold: the numbered rows
of a permission or question dialog, which `readPromptBox` recognises only in
order to bail out of. It is deliberately layout-agnostic — rather than locating
Claude Code's dialog frame it scans the foot of the pane for the last run
numbered 1, 2, 3 with no gap — and the poll only calls it for a session the
hooks already report as `waiting` or `permission`, because the hooks are
authoritative for whether a dialog is open and prose can look like a list.

The rows need not be adjacent, and how far the scan will reach for them turns
on one thing: whether the pane's last line is the hint naming the dialog's own
keys (`Enter to select · ↑/↓ to navigate · Esc to cancel`). With it, the pane
has said outright that a dialog is drawn, so the rows may sit well above the
foot and anything at all may separate them — which is what a question needs,
because its rows carry descriptions, a rule, and sometimes a preview panel
several lines deep. Without it the scan stays strict, the way a permission
prompt (which draws no such hint) is read: rows adjacent bar a blank line, a
rule, or a line indented past the row below it, and the run at the foot.

Three shapes come out of that, all verified against real captures in
`tests/tmux/prompt-options.test.ts`. A plain question carries a description
under each label, which rides along as the option's `hint`. A multi-select
question carries `[ ]`/`[✔]` in the labels: the checkbox becomes `checked`,
the choice is marked `multi`, and picking a row toggles it rather than
answering — the answer goes in from a tab of its own, one `Right` away, which
is what the composer's "Done" button sends. A question with previews draws the
panel to the right of the rows, sharing their lines: the label is cut where
the panel starts, and because that leaves the left column too narrow for a
long label, the indented line under a preview row is joined to the label
rather than read as a description.

Delivery goes the other way through the same box. `sendTextToPane()` in
`src/server/message-queue.ts` pastes the text and sends Enter; Claude Code
sometimes folds an Enter that lands inside the paste burst into the text, so
the send and voice routes then call `confirmSubmitted()`, which reads the box
back: a taken message has left it (the turn started, or Claude Code queued it
and shows its own hint), text still sitting there typed gets one more Enter,
and if it stays the route answers 502 and the composer keeps the draft.

The session poll captures with colour once per tick and hands the stripped copy
to every other check, so adding a detector there costs no extra `tmux` calls.
`draft_input`, `draft_kind`, `pane_queue`, `pane_choice` and `pane_update` (Claude
Code's notice about its own update, which `readUpdateNotice()` finds in the
footer below the box, or right-aligned just above the box in the fullscreen
layout), `pane_activity`, and `queue` (everything claude-mux's own send queue
holds for the pane, each item with a stable `id` that the queue-edit and
`/steer` routes address it by; attachments ride beside the text and are
folded in only on delivery), `last_visited_at` (see Session States), and `delivered` (what the queue and steers handed
the pane lately, which the transcript matches to label a turn "Queued" or
"Steer") are live-only: they
ride the WebSocket broadcast and are never written to the session JSON. They are
typed once as `LivePaneFields` in `src/server/ws-handlers.ts`, and **each one
also needs a line in `EnrichedSessionSchema`** (`src/types/ws-messages.ts`) —
without it Zod strips the field on the way into the browser and the UI silently
never sees it.

### 5. Finding and streaming a transcript

A session's JSONL lives in `~/.claude/projects/<launch dir with / as ->/<session
id>.jsonl`. The directory is named after the directory Claude Code was *launched*
in, which stops matching the session's `cwd` as soon as it changes directory, so
the path cannot be derived from `cwd` alone. The hooks record Claude Code's own
`transcript_path` in the session JSON; `resolveTranscriptPath()` in
`src/transcript/tailer.ts` prefers it, falls back to the cwd-derived path, and
finally scans the project directories for `<session id>.jsonl` (which is what
rescues sessions written by an older hook). It returns null when the session has
not written a file yet, and `TranscriptWsManager` keeps looking every few polls.

Long sessions run to thousands of entries, so the socket sends the tail
(`SNAPSHOT_ENTRIES`) with the `firstIndex` it starts at, and the client asks for
older slices with `history_request` — the same message the terminal uses for its
scrollback. Delta messages carry each entry's index so a client holding only the
tail can tell a new entry from an update to one it never received.

A subagent opens as a window of its own at `/session/<target>/agent/<id>`. Its
page connects to `/api/sessions/<id>/agents/<agent id>/transcript/stream`, which
joins the parent session's state in `TranscriptWsManager` — the same tailer that
feeds the Task cards — and is sent the same messages carrying that agent's
entries, its payload (with the brief, the Task prompt, as `prompt`) and its
context instead of the session's. An agent whose file is not on disk is
`available: false` until it turns up. The page takes no input; its "Message"
button returns to the parent with `?compose`, which focuses the composer.

### 6. What GitHub says a session is waiting on

The maestro and wayfinder skills keep their state in GitHub issues, not in any
pane. The maestro daemon starts each worker with `MAESTRO_ROLE` and
`MAESTRO_ISSUE` in its environment, and the hook copies them into the session
JSON (`maestro_role`, `maestro_issue`). `src/server/github.ts` reads the repos
the live sessions sit in through `gh`, at most once a minute and never on the
poll's own time: the issue each worker owns rides the broadcast as the live
field `issue`, and the tickets that want a person ride it as `inbox`. Those are
a worker's `needs-help` while that worker's session is still alive (a
`needs-help` with no live worker was parked by hand, and nobody waits on it),
and the wayfinder `grilling`/`prototype` tickets that are open, unassigned and
unblocked. Anything labelled `hold` (maestro's "not the daemon's") is left out. Where `gh` is missing or logged out, both stay
empty.

The sidebar nests a worker under the session that runs its daemon (the one
non-worker in the same tmux session) and names it after its issue. Two kinds
of child hang off a row and must read differently: a worker (a whole session)
on a solid violet thread with a terminal tile and an issue chip, and a
subagent (`SubagentRow.svelte`, no pane of its own) on a dashed teal thread
with a diamond and its agent type, linking to `/session/<target>/agent/<id>`.
A worker's subagents ride inside the worker's thread.
`NeedsYou.svelte` lists everything waiting on a person, oldest wait first:
dialogs in panes, workers asking for help, then wayfinder tickets with a Start
button that opens a session on the ticket. `src/transcript/grilling.ts` reads
a grilling round (`❓ **Qn**` … `➡️`) out of Claude's last reply, so the
transcript can draw it as a form and write the reply.

### 7. What a session changed

Two sources, both served by `GET /api/sessions/<id>/changes?source=session|git`
and, one file at a time, `/changes/diff?source=…&file=…`. The session source
(`src/transcript/changes.ts`) reads only the log: every Edit/Write/MultiEdit/
NotebookEdit result carries `structuredPatch`, and a Write with `type: "create"`
counts its whole content as added. It covers files outside any repo, groups
them by the turn (prompt uuid) that made them, and misses whatever Bash did.
The git source (`src/server/git.ts`) runs `status --porcelain=v2 -z` and
`diff --numstat` through `execFile`, untracked files included, and diffs a
file only when it sits inside the repo root and git lists it as changed. Its
cache is re-read when a session in the repo writes its JSON, at most every
2s, never on a timer. The live field `changes` carries the count: git's when
the session is in a repo, the log's otherwise.

### 8. What a project serves

The side panel's Web pane frames the project's site. `src/server/web-preview.ts`
finds dev servers by reading `ss -ltnpH` and keeping the listeners whose
`/proc/<pid>/cwd` sits inside the project and that answer with HTML within a
second (Linux only; elsewhere it finds nothing). It reads `tailscale serve
status --json` for which local ports already have an HTTPS mapping, and
`checkFraming()` fetches a page's headers to read `X-Frame-Options` and CSP
`frame-ancestors` before the pane draws a frame. Where a URL can be shown from
is decided in the browser (`resolveEmbed()` in `web/src/lib/side-panel/web.ts`),
because only the page knows whether it was opened over HTTPS or on this
machine: a `localhost` URL is framed through its tailscale serve mapping, as it
is when the page itself is on localhost, and otherwise becomes a card with
"Open in new tab" and the `tailscale serve` command that would map it.

## Key Data Flow

```
Claude Code events → stdin → hook script → JSON files (~/.claude-mux/sessions/)
                                                ↓
                                    file watcher (500ms polling)
                                                ↓
                                    WebSocket broadcast to clients
                                                ↓
                                    Svelte stores → UI update
```

## Session States

| State | Indicator | Description |
|-------|-----------|-------------|
| `idle` | Dim grey dot (#78716c) | Ready for new task; the row recedes |
| `done` | Emerald `mdi:check-circle` (#34d399) | Idle, and the last turn finished after anyone last looked |
| `busy` | Green pulsing dot (#34d399) | Working (thinking, tool use); the row counts the turn up |
| `waiting` | Amber `mdi:chat-question-outline` (#fbbf24) | Asking user a question |
| `permission` | Amber `mdi:shield-alert-outline` (#fbbf24) | Needs permission to proceed |

Indicators live in one place: `src/session-state.ts` maps a state to its icon,
web color, Ink color, and whether it pulses. Every surface reads from it — the
web sidebar, the transcript's live status row and the session header (all via
`SessionStateIndicator.svelte`), and the Ink TUI. It also covers two states the
hooks never report: `dead` (pane closed) and `plain` (a non-Claude tmux pane).
Add a state there, not in a component. Amber is reserved for the states that
want a human — idle deliberately recedes, and `recedes()` dims its row's title.
The busy dots pulse in steps, all in phase off the wall clock.

`done` is the unread watermark. The hook stamps `turn_started_at` on each
prompt and `turn_completed_at` on a Stop that really ends the turn (not one
paused on a background agent). The server keeps when anyone last had each
session open in `~/.claude-mux/visits.json` (`src/db/visits-json.ts`; the hook
never touches it) and rides it on the broadcast as the live field
`last_visited_at`. The session page posts `/api/sessions/<id>/visit` on open
and whenever a turn finishes while it is visible; the sidebar's "Mark unread"
posts `{ unread: true }`, which rewinds the watermark to just before the turn
ended. `isUnread()` compares the two, and a session nobody ever opened counts
as read. Both tab titles count the sessions that want a person or are done.

Alerts come from `NotificationCoordinator.svelte`, mounted once in the layout
(never in a split's frames). `detectNotifications()` in
`src/session-notifications.ts` compares each broadcast with the last one and
raises an event when a session starts waiting on a person (or switches between
a question and an approval) and when `turn_completed_at` advances; sessions
seen for the first time raise nothing. In the background that becomes a
system notification tagged with the session id; in front, a svelte-sonner
toast. The sidebar foot holds the per-browser settings (mode
`off | notifications | sound | both`, in-page toasts), and the favicon carries
a red count of sessions that want a person. The sounds are synthesised with
WebAudio in `web/src/lib/notifications.ts`, so there are no audio assets.

Web Push carries the same events to a device with no tab open, so its
detection runs on the server: `startPushMonitor()` in `src/server/push.ts`
feeds the session JSON through the same `detectNotifications()` on every
watcher change (and keeps the GitHub cache warm so a worker is named by its
issue), from the moment the server starts (the `init` hook in
`hooks.server.ts`), not when a page connects. It reads the dialog's question
off the pane for the body and sends to the devices in
`~/.claude-mux/push-subscriptions.json` that want that event, dropping any the
push service answers 404/410. `web/src/lib/server/push.ts` holds the VAPID
keys (`~/.claude-mux/vapid.json`) and the `web-push` call, which must stay a
web devDependency so Vite bundles it into the server. `web/src/service-worker.ts`
shows the push (skipping it while any claude-mux window has focus, since the
page alerts for itself there) and on a
tap hands an open page the URL by `postMessage`, which `NotificationCoordinator`
routes; it has no fetch handler and caches nothing.

The sidebar row is `SessionRow.svelte`: a `meta` slot on line 1 after the time,
for badges that come later, and a `children` snippet for rows nested under it.

## Project Structure

```
claude-mux/
├── src/                    # CLI/TUI/Hooks
│   ├── cli.ts              # Entry point
│   ├── app.tsx             # React Ink TUI
│   ├── commands/
│   │   ├── serve.ts        # Web server command
│   │   └── tui.ts          # TUI command
│   ├── db/                 # JSON file operations
│   ├── hooks/              # Claude Code hooks
│   ├── server/
│   │   └── watcher.ts      # File watcher
│   └── tmux/               # tmux integration
├── web/                    # SvelteKit app
│   ├── src/
│   │   ├── hooks.server.ts # WebSocket handlers
│   │   ├── lib/stores/     # Svelte 5 runes stores
│   │   └── routes/         # Pages and API routes
│   └── svelte.config.js
└── dist/                   # Build output
    ├── cli.js              # CLI
    └── web/                # SvelteKit server
```

## Important Files

- `src/cli.ts` - Entry point, routes to subcommands
- `src/hooks/claude-mux-hook.ts` - Runs in Claude's process, writes JSON
- `src/db/sessions-json.ts` - Session CRUD operations on JSON files
- `src/tmux/pane.ts` - `checkForInterruption()` detects Escape interruptions
- `src/server/watcher.ts` - File watcher for session changes
- `web/src/hooks.server.ts` - WebSocket handlers and session managers
- `web/src/lib/stores/sessions.svelte.ts` - Reactive session store

## UI Components

Use **shadcn-svelte** components from `$lib/components/ui/`. Do not build custom UI components—add shadcn components instead.

## tmux Integration

- TUI auto-creates a `watch` tmux session
- `prefix + W` keybinding jumps to watch session (set dynamically)
- Pane targets use format: `session:window.pane` (e.g., "main:1.0")
