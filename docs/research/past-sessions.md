# Past sessions: where they live, how to list them, how to reopen them

Research for #80 (map #76). Measured on omarchy, 2026-10-14, Claude Code 2.1.296.
"Past session" is a Claude Code conversation whose transcript is on a machine's
disk but has no live pane (see `GLOSSARY.md`).

Sources: the Claude Code docs page [Manage sessions][sessions] (cited as
**[S]**), `claude --help` on 2.1.296 (**[H]**), this machine's disk, read only
(**[disk]**), and this repo's code (cited by path).

## 1. Where a past session lives

- **The transcript is the session.** Each one is
  `~/.claude/projects/<project>/<session-id>.jsonl`. `<project>` is the working
  directory with every non-alphanumeric character replaced by `-`. Names longer
  than 200 characters are cut and given a hash suffix. [S, "Where transcripts
  are stored"] `CLAUDE_CONFIG_DIR` moves the root. `CLAUDE_CODE_PROJECT_DIR_NAME`
  pins the directory name. [S]
- **The directory is named for the launch directory, not the current `cwd`.**
  CLAUDE.md §5 already relies on this. `/cd` moves the transcript into the new
  directory's project storage. [S, "Sessions in other worktrees and projects"]
- **Transcripts are deleted after 30 days by default** (`cleanupPeriodDays`).
  [S, table under "Where transcripts are stored"] This machine does not set it,
  and the oldest top-level transcript is from 2026-09-13, 31 days ago. [disk] So
  "every past session" really means "the last 30 days per machine" unless the
  setting is raised.
- **Subagent transcripts** sit in `<project>/<session-id>/subagents/`.
  Each has an `agent-<id>.meta.json` beside it (CLAUDE.md §1). They are not
  sessions in their own right.
- **The format is internal.** "The entry format is internal to Claude Code and
  changes between versions, so scripts that parse these files directly can break
  on any release." [S] claude-mux already parses it (`src/transcript/`), so the
  risk is accepted today, but any lister should read defensively.

### Files that look like an index but are not

| File | What it is | Usable as the list? |
|---|---|---|
| `<project>/sessions-index.json` | `{version, entries[]}` with `sessionId, fullPath, fileMtime, firstPrompt, messageCount, created, modified, gitBranch, projectPath, isSidechain` | **No.** 11 of 54 project dirs have one, and none has been written since 2026-03-11. 8 of the 11 list transcripts that are already deleted. Claude Code has stopped maintaining it. [disk] |
| `~/.claude/history.jsonl` | Prompt history for the up arrow: `{display, timestamp, project, sessionId}` per prompt | **No.** 7,448 lines, 964 distinct session ids, back to 2025-11-12. Most of those transcripts are already deleted, so it names sessions that cannot be resumed. It reads in 17 ms, and could serve as a search aid joined against what exists. [disk] |
| `~/.claude/sessions/<pid>.json` | One per running process (`peerToken`, `procStart`) | No. These are live processes only. [disk] |

## 2. What is in a transcript, and how cheaply it can be read

Record types seen at the top level [disk]: `user`, `assistant`, `system`,
`attachment`, `file-history-snapshot`, `file-history-delta`, `mode`,
`permission-mode`, `queue-operation`, `last-prompt`, `ai-title`,
`custom-title`, `pr-link`, `bridge-session`, `environment`, `cost-state`.
None of the 307 files contains a `summary` record.

| Field a list wants | Where it is | Cost |
|---|---|---|
| id | the file name | `readdir` |
| size, last activity | `stat` (mtime). The last record's `timestamp` gives a more exact value | `stat`, or a tail read |
| project / launch dir | the directory name (lossy: `/` and `.` both become `-`). The `cwd` on any message record gives the exact path | head read |
| git branch | `gitBranch` on message records | head read |
| Claude Code version | `version` on message records | head read |
| first prompt | first `user` record that is not `isMeta` or a tool result. It begins about 11.6 KB into the file at the median and 22 KB at most, after the attachment records | read the first ~32 KB |
| last prompt | `{"type":"last-prompt","lastPrompt":…}`, appended repeatedly. Present in 303 of 307 files | tail read |
| title | `custom-title.customTitle` (set by `/rename` or `-n`: 5 files) or `ai-title.aiTitle` (generated from the first prompt by a Haiku-class model: 87 files, 28%). Take the last one in the file. [S, "Name your sessions"] | tail read finds it if it was written recently. Otherwise the whole file must be scanned |
| linked PR | `{"type":"pr-link","prNumber","prUrl","prRepository"}`: 215 files | full scan, or tail if recent |

The picker shows "the session name if you set one, otherwise the AI-generated
session title, conversation summary, or first prompt, along with time since last
activity, git branch, and file size." [S, "Use the session picker"] The table
above can rebuild every one of those fields.

**`cwd` is not constant within a file.** Many files carry more than one `cwd`
value, through `/cd`, worktree entry, or a nested tool input that also has a
`cwd` key. My count of 239/307 used a regex and overcounts. Use the first
message record's `cwd` as the launch dir.

## 3. Measured on this machine

[disk] Measured by throwaway scripts (`stat`, a 64 KB head, a 64 KB tail, and a
full read), not committed.

| | |
|---|---|
| project directories | 54 |
| top-level transcripts (sessions) | 307 (1,421 `.jsonl` counting subagents) |
| total size of top-level transcripts | 604 MB (whole `projects/` dir 1.1 GB). Median 1.4 MB, max 28.5 MB |
| touched in the last 7 / 30 days | 183 / 306 |
| `readdir` + `stat` of all 307 | **4 ms** |
| 64 KB head + 64 KB tail of all 307 | **~150 ms** warm |
| full read of all 307 (604 MB) | **~1.7 s** warm |

A full listing with id, launch dir, branch, first prompt, last prompt, last
activity and size costs about 150 ms per machine at this volume. That is cheap
enough to compute on request, with a cache keyed on `(path, mtime, size)`.
Titles are the exception, because they can sit mid-file. Two options: cache a
full scan per file once (it is append-only, so only new bytes need reading
after that), or fall back to the last prompt or first prompt when no title is
in the tail. Cold-cache times were not measured separately. The first run was
already warm.

## 4. Reopening: `--resume` and `--continue`

All of this is from [S] unless marked otherwise.

- `claude --resume <session-id>` **works from any directory.** It looks in the
  current project and its git worktrees first, then every other project on the
  machine. It resolves only when exactly one other project holds the id.
  Otherwise it prints `No conversation found with session ID: <id>`.
  ("Resume by session ID or name")
- `claude --resume <absolute path to .jsonl>` resumes that file directly. This
  is the most exact handle a dashboard can pass. ("Resume a session" table)
- `claude --resume <name>` resolves names and generated titles, but only across
  the current repository and its worktrees. An ambiguous name opens the picker.
- `claude --continue` takes the most recent session **in the current
  directory**. It skips `-p`, Agent SDK and `/loop` sessions. With none, it
  prints `No conversation found to continue` and exits.
- **Picker** (`--resume` with no id): it lists the current worktree by default.
  `Ctrl+W` widens to all worktrees and `Ctrl+A` to all projects. A session from
  another worktree resumes in place. If that worktree is gone, it resumes in
  the current directory. A session from an unrelated project copies a
  `cd … && claude --resume …` command to the clipboard instead of resuming. If
  the project dir is gone, it resumes in the current directory.
- **Folder moved or deleted:** the transcript stays under the old directory
  name. `--resume <id>` still finds it through the cross-project search. The
  picker resumes it in the current directory. **Unverified:** what working
  directory `--resume <id>` uses when started from an unrelated directory while
  the original still exists. The docs imply the current directory, and nothing
  was resumed here to check it. A dashboard should launch from the session's
  recorded `cwd` when that path exists. claude-mux's own restart already does
  this (`src/server/restart-claude.ts`, which types the command "in the launch
  directory `--resume` looks the session up under").
- **What comes back:** history, model, agent, permission mode (with
  exceptions: `bypassPermissions` is not restored from the terminal), goal, and
  unexpired scheduled tasks. **Not** restored: `--mcp-config`, `--settings`,
  `--plugin-dir`, `--add-dir`, and background Bash or monitor tasks.
  ("What a resumed session restores")
- **Two terminals on one session interleave** into one transcript unless
  `--fork-session` is used. A dashboard must not resume a session that is
  still live elsewhere. Since v2.1.285, resuming a running *background*
  session attaches to it instead. ("Branch a session", "Resume a running
  background session")
- **Expensive resumes:** on Pro or Max, a session idle for more than ~1 h and
  over 100k tokens opens a "Resume from summary / full session" dialog before
  the first message. A dashboard-driven resume will land on that dialog. The
  existing `readPromptOptions()` would see it as a numbered dialog, but only
  if the hooks report `waiting`, which has not been checked. ("Resume from a
  summary")
- `--from-pr <n|url>` opens the picker filtered to sessions linked to a PR.
  `--fork-session` gives the resumed copy a new id. [H]

## 5. What claude-mux keeps about ended sessions today

- **Session JSON lives only as long as the process.** The `SessionEnd` hook
  deletes it (`handleSessionEnd` → `deleteSessionFile`,
  `src/hooks/claude-mux-hook.ts`). SessionStart also removes older files on
  the same pid or tmux target. On this machine `~/.claude-mux/sessions/` holds
  5 files, all live. claude-mux keeps **nothing** about a conversation that
  ended cleanly: no id, no title, no transcript path.
- **"Closed sessions"** are session JSON whose pane is gone (`pane_alive ===
  false`, `src/server/ws-handlers.ts`). That happens when the process died
  without a `SessionEnd`, for example a killed pane. The sidebar counts them
  per project card, and the "no session" section offers "clear N closed"
  (`AllSessionsPanel.svelte`, `sweepDead`). They carry `transcript_path` and
  `cwd`, so they are the one kind of past session claude-mux already knows
  about, by accident.
- **The "no session" section** lists folders from `~/.claude-mux/projects.json`
  (`src/db/projects-json.ts`) that have no live session. It is a list of
  folders, not of conversations.
- **Worktree sessions** are grouped under their repo root, labelled by the path
  after `.worktree(s)/` (`AllSessionsPanel.svelte`). Their transcripts live
  under the worktree's own project dir, for example
  `-home-christinoleo-Projects-claude-watch--worktree-14`.
- **Resume support exists only in the CLI:** `claude-mux new-session --resume
  <id>` (`src/commands/new-session.ts`), plus the restart action, which replays
  argv with `--resume <id>`. No web route starts a resumed session. No API lists
  `~/.claude/projects`, although `resolveTranscriptPath()`
  (`src/transcript/tailer.ts`) already scans project dirs for one id.

## 6. What later decisions need

1. A per-machine lister can be built from the transcripts alone in ~150 ms at
   300 sessions. There is no index file to lean on, so each machine's server
   must read its own disk. It cannot be done from another machine.
2. The list's horizon is `cleanupPeriodDays` (30 days by default) on each
   machine. Raising it is a per-machine settings change, and that decision
   belongs to Leo.
3. The handle for reopening is `(machine, transcript path or id, cwd)`. Launch
   `claude --resume <path>` in a new tmux pane at the recorded `cwd`, or in the
   repo root when that path is gone. Refuse or fork when the id is live.
4. Titles exist for only ~30% of sessions. The rest need the first or last
   prompt as a label.

[sessions]: https://code.claude.com/docs/en/sessions
