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

## Service management on remote hosts

For machines that should run claude-mux as a long-lived service (e.g. `engage`):

```bash
claude-mux service install               # ~/.config/systemd/user/claude-mux.service, enabled + started
sudo loginctl enable-linger $USER        # one-time: survive logout, start on boot
journalctl --user -u claude-mux -f       # logs
```

`update` auto-detects how the server is running and restarts it accordingly: `systemctl --user stop/start claude-mux.service` for systemd-managed hosts, or `nohup claude-mux serve` for hosts started manually. Use `--skip-restart` to leave the server alone.

## Architecture

claude-mux has three main components:

### 1. Claude Code Hooks → JSON Files
The hook script (`src/hooks/claude-mux-hook.ts`) runs inside Claude Code's process. It receives events via stdin (SessionStart, UserPromptSubmit, PreToolUse, Stop, etc.) and writes state to per-session JSON files in `~/.claude-mux/sessions/`.

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
user typed into the pane while Claude was busy, which sit directly above the box
indented two spaces on a painted row (`48;5;237`). A submitted message looks the
same but starts at column 0, which is what keeps scrollback out of the result.

The session poll captures with colour once per tick and hands the stripped copy
to every other check, so adding a detector there costs no extra `tmux` calls.
`draft_input`, `draft_kind` and `pane_queue` are live-only: they ride the
WebSocket broadcast and are never written to the session JSON.

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
| `idle` | Dim grey dot (#78716c) | Ready for new task |
| `busy` | Green pulsing dot (#34d399) | Working (thinking, tool use) |
| `waiting` | Amber `mdi:chat-question-outline` (#fbbf24) | Asking user a question |
| `permission` | Amber `mdi:shield-alert-outline` (#fbbf24) | Needs permission to proceed |

Indicators live in one place: `src/session-state.ts` maps a state to its icon,
web color, Ink color, and whether it pulses. Every surface reads from it — the
web sidebar, the transcript's live status row and the session header (all via
`SessionStateIndicator.svelte`), and the Ink TUI. It also covers two states the
hooks never report: `dead` (pane closed) and `plain` (a non-Claude tmux pane).
Add a state there, not in a component. Amber is reserved for the states that
want a human — idle deliberately recedes.

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
