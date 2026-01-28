# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Server

The dev server is running at **http://localhost:3000** (started with `bun run dev:serve`).

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode TypeScript compilation
npm run dev:serve      # Build + run with --watch
npm test               # Run vitest tests
npm run test:watch     # Watch mode tests
npm run lint           # ESLint check
npm run format         # Prettier formatting
```

Run a single test file:
```bash
npx vitest run tests/db/sessions.test.ts
```

## Architecture

claude-watch has three main components that work together:

### 1. Claude Code Hooks → Database
The hook script (`src/hooks/claude-watch-hook.ts`) runs inside Claude Code's process. It receives events via stdin (SessionStart, UserPromptSubmit, PreToolUse, Stop, etc.) and writes state to SQLite at `~/.claude-watch/state.db`.

### 2. Database → TUI/Web Server
The TUI (`src/app.tsx`) and HTTP server (`src/server/index.ts`) poll the database every 500ms. They also capture tmux pane content to detect "Esc to interrupt" as a fallback for state detection.

### 3. State Detection Issue
The `syncSessionStates()` function in `src/server/routes/sessions.ts` and `checkPanes()` in `src/app.tsx` can override correct hook state with incorrect pane-based detection. If state flapping occurs, hooks are authoritative—pane checks are fallback only.

## Key Data Flow

```
Claude Code events → stdin → hook script → SQLite (WAL mode)
                                              ↓
                              TUI/Server polls every 500ms
                                              ↓
                              tmux pane content check (fallback)
```

## Session States

- `busy` - Claude is working (tool use, thinking)
- `idle` - At prompt, waiting for user input
- `waiting` - Elicitation (Claude asked a question)
- `permission` - Waiting for permission approval

State colors: Red (permission/waiting), Yellow (idle), Green (busy)

## Important Files

- `src/cli.ts` - Entry point, routes to subcommands
- `src/hooks/claude-watch-hook.ts` - Runs in Claude's process, updates DB
- `src/tmux/pane.ts` - `isPaneShowingWorking()` checks for "Esc to interrupt"
- `src/server/routes/sessions.ts` - `syncSessionStates()` reconciles hook state with pane content

## tmux Integration

- TUI auto-creates a `watch` tmux session
- `prefix + W` keybinding jumps to watch session (set dynamically)
- Pane targets use format: `session:window.pane` (e.g., "main:1.0")
