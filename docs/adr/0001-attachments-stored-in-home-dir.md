# Attachments are stored in `~/.claude-mux/attachments/{sessionId}/`, not in the session cwd

Status: accepted
Date: 2026-05-14

## Context

User-uploaded files (drag-drop, clipboard paste, mobile picker) need to land
somewhere on disk so we can hand a path to Claude Code via its `@/path` syntax.
Two plausible homes:

- **Under the user's project cwd**, e.g. `${session.cwd}/.claude-mux-attachments/`
- **Under the app's home dir**, `~/.claude-mux/attachments/{sessionId}/`

cwd-relative would work even if Claude Code were sandboxed to its working tree.
Home-relative requires Claude to be able to read paths outside cwd.

## Decision

Store under `~/.claude-mux/attachments/{sessionId}/`.

This is safe because claude-mux always launches Claude Code with
`--dangerously-skip-permissions` (see `web/src/routes/api/sessions/[id]/restart/+server.ts`),
which disables the read-path allowlist. Absolute paths anywhere on the user's
filesystem resolve fine.

## Consequences

- Clean separation: the user's working tree is never polluted with our cache.
- No `.gitignore` coordination needed.
- Cleanup is co-located with session state (`~/.claude-mux/sessions/`,
  `~/.claude-mux/attachments/`), single mental model.
- **Lock-in to `--dangerously-skip-permissions`.** If we ever want to support a
  permissions-enabled Claude Code, this storage choice breaks and attachments
  would have to move under cwd. Treat the flag as a load-bearing invariant.

## Considered alternatives

- `${session.cwd}/.claude-mux-attachments/` — bulletproof against any Claude
  Code sandbox change, but dirties the user's repo and forces them to gitignore.
  Rejected because the `--dangerously-skip-permissions` invariant is already
  load-bearing elsewhere in the codebase.
- `/tmp/claude-mux/{sessionId}/` — same sandbox issue as `~`, and the OS may
  reap files mid-session (`systemd-tmpfiles` typically clears `/tmp` entries
  after ~10 days or on reboot). Rejected.
