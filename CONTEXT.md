# Glossary

## Terminal Mirror

The raw, ANSI-rendered copy of a session's tmux pane shown in the web UI. It is
a faithful pixel-level view of what the Claude Code TUI is displaying, including
permission prompts and popups.

Not to be confused with **Transcript**: the mirror shows what the screen looks
like; the transcript shows what the conversation contains.

## Transcript

The structured record of a session's conversation: user prompts, assistant text,
thinking, and tool activity. Sourced from Claude Code's own session log, not
from the screen. Read-only — sending input to a session is not part of the
transcript.

## Transcript View

The chat-style rendering of a Transcript in the session page: a flat document
flow (no chat bubbles) of user prompts, assistant markdown, collapsed thinking,
and Tool Cards. Offered alongside the Terminal Mirror as a switchable view, and
shown by default.

## Turn

One assistant response as the user perceives it: all content the assistant
produced between receiving input and stopping (text, thinking, and tool calls
together). A turn may arrive fragmented in the underlying log and must be
reassembled for display.

## Tool Card

The transcript element representing one tool invocation: a one-line summary
(tool name plus its key argument, e.g. the command or file path), expandable to
the full input and result.

## Attachment

A file or image the user is staging to send into Claude Code on the **next** prompt.

An attachment has two layers:

- **Staging (prompt-scoped)** — the chip in the input row. Cleared from the UI
  when the prompt fires. Each prompt starts with an empty staging area.
- **Backing file (session-scoped)** — bytes persisted on disk under the session's
  attachment directory. Kept for the lifetime of the session and removed only
  when the session is killed. This avoids racing Claude Code's read of `@/path`.

Once a prompt is sent, the attached bytes also live inside Claude Code's own
conversation context (as multimodal message content). Re-referencing the same
image in later prompts ("look at the image again") works because Claude Code
already has the bytes in context; it does not need to re-open the backing file.

Not to be confused with **Screenshot**: screenshots are session artifacts emitted
by Claude Code hooks and displayed in the sidebar. Screenshots are read-only
context surfaced to the user; attachments are user-supplied payloads sent into
Claude Code.
