# Glossary

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
