# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Server

Dev server runs via Vite with HMR at **http://localhost:5173** (or `--port` to change).

```bash
bun run dev:serve                    # Start dev server
bun run dev:serve --port 3456        # Custom port
bun run dev:serve --host 0.0.0.0     # LAN access
```

**HMR handles most changes automatically** - no restart needed for Svelte components, stores, routes, or API endpoints. Only `vite.config.ts` changes require a restart.

After each change, check tmux pane `0:1.1` to verify HMR worked. If the server died, restart it. Do not start a new server if one is already running. If the pane reference is wrong, find the correct one and update this file.

## Build & Development Commands

```bash
bun run build          # Build CLI + SvelteKit web app
bun run build:cli      # Build CLI only (TypeScript)
bun run build:web      # Build SvelteKit web app only
bun run dev:serve      # Vite dev server with HMR
bun test               # Run vitest tests
bun run lint           # ESLint check
bun run format         # Prettier formatting
```

Production server (after build):
```bash
bun dist/cli.js serve --port 3456 --host 0.0.0.0
```

Run a single test file:
```bash
bun vitest run tests/db/sessions.test.ts
```

## Architecture

claude-watch has three main components:

### 1. Claude Code Hooks → JSON Files
The hook script (`src/hooks/claude-watch-hook.ts`) runs inside Claude Code's process. It receives events via stdin (SessionStart, UserPromptSubmit, PreToolUse, Stop, etc.) and writes state to per-session JSON files in `~/.claude-watch/sessions/`.

### 2. SvelteKit Web Server + WebSocket
The web server (`web/`) is built with SvelteKit and svelte-adapter-bun:
- **File watcher** (`src/server/watcher.ts`): Polls JSON files for changes (500ms interval)
- **WebSocket channels**: Real-time updates for sessions list and terminal output
- **API routes**: REST endpoints for session management, tmux control, folder browsing
- **Hooks** (`web/src/hooks.server.ts`): WebSocket upgrade handling, session managers

### 3. State Detection
**Hooks are authoritative** for all state transitions. Pane content polling only catches one edge case: when the user presses Escape to interrupt. The `checkForInterruption()` function in `src/tmux/pane.ts` detects "Interrupted" or "User declined" messages.

## Key Data Flow

```
Claude Code events → stdin → hook script → JSON files (~/.claude-watch/sessions/)
                                                ↓
                                    file watcher (500ms polling)
                                                ↓
                                    WebSocket broadcast to clients
                                                ↓
                                    Svelte stores → UI update
```

## Session States

| State | Color | Description |
|-------|-------|-------------|
| `idle` | Yellow | Ready for new task |
| `busy` | Green | Working (thinking, tool use) |
| `waiting` | Red | Asking user a question |
| `permission` | Red | Needs permission to proceed |

## Project Structure

```
claude-watch/
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
- `src/hooks/claude-watch-hook.ts` - Runs in Claude's process, writes JSON
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
