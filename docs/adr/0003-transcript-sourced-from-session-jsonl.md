# Transcript view is sourced from Claude Code's session JSONL, not the Agent SDK or terminal scraping

The web UI's transcript view needs structured conversation data (messages, tool
calls with full inputs, thinking, subagents). Tools like T3 Code get this by
running Claude headless through the Agent SDK, but that replaces the interactive
TUI — and claude-mux exists to mirror real interactive tmux sessions. Parsing
the terminal text itself was rejected as fragile and lossy. Instead, we tail the
session's own log at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,
which contains everything the SDK stream does (with a small write lag) while
leaving the running TUI untouched.

## Consequences

- The JSONL format is undocumented and changes between Claude Code versions;
  the parser must be tolerant (skip unknown line types, never crash the
  channel) and the Terminal Mirror remains the fallback view.
- The path is derived from the session's stored launch `cwd`
  (`cwd.replace(/\//g, '-')`) plus session id. The encoding is lossy (`-` vs
  `/`), so the mapping must always go session → path, never be reverse-parsed
  from a directory name.
- Subagent activity lives in sibling files
  (`<session-id>/subagents/agent-*.jsonl` + `.meta.json`, joined via
  `toolUseId`); a transcript reader that ignores them undercounts the
  session's work.
- A previous JSONL watcher (`src/server/jsonl-watcher.ts`, removed in
  `1b76932`) was buggy and should not be resurrected; the tailer is written
  fresh.
