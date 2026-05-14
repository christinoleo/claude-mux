# Attachment files are deleted only on session-kill, not after each send

Status: accepted
Date: 2026-05-14

## Context

When the user sends a prompt with attached files, those files are referenced
via `@/path` tokens injected into the tmux pane. The obvious eager-cleanup
strategy is: after `tmux paste-buffer` returns, delete the file — the path is
already in the terminal's input buffer, so we don't need the bytes anymore.

The risk: it is not empirically verified that Claude Code reads `@/path` files
synchronously at prompt-submission time. If Claude reads the file lazily during
turn processing (a few hundred ms after our send returns), an eager delete
yields a "file not found" error mid-turn.

## Decision

Attachment files persist for the lifetime of the session. They are deleted in
exactly one place: the `deleteSession(id)` cleanup hook in
`src/db/sessions-json.ts`, which is called by both `kill` and `restart`
endpoints.

The UI-level "attachment" (the chip) is still prompt-scoped — chips clear on
send. Only the **backing file** lingers.

## Consequences

- No race between disk delete and Claude's file read, regardless of whether
  Claude reads `@/path` sync or lazy.
- Disk usage grows with session lifetime. In practice attachments are KB-MB
  per file and sessions are bounded by user attention span, so this is
  negligible.
- Single cleanup site = single place to audit. No periodic sweeper, no
  per-message bookkeeping.
- A long-lived session that uploads many large files is the worst case. If
  that ever becomes real, add a size-based LRU eviction; do not switch to
  per-send delete.

## Considered alternatives

- **Delete after `tmux paste-buffer` returns** — minimal disk usage. Rejected:
  unproven assumption that Claude has consumed the file by then.
- **Delete after the prompt's reply arrives** — would require tracking
  message round-trips, which the system does not currently do. Adds a new
  state machine for a small disk win.
