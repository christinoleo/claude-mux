/**
 * Incremental parser for Claude Code session JSONL transcripts.
 *
 * The JSONL format is an undocumented internal of Claude Code and changes
 * between versions (see docs/adr/0003). The parser is deliberately tolerant:
 * unknown line types and malformed lines are skipped, never thrown on.
 *
 * Folding rules discovered from live session files:
 * - The streamer writes one `assistant` line per content block; lines from the
 *   same API response share `message.id`.
 * - A real user prompt has `message.content` as a plain string (or text
 *   blocks) and `origin.kind === "human"`; tool results come back as `user`
 *   lines whose content is an array of `tool_result` blocks.
 * - `toolUseResult` is a structured sidecar on tool_result lines, richer than
 *   the in-message content (stdout/stderr for Bash, file data for Read, ...).
 */

export type TranscriptEntry =
  | { kind: "user"; id: string; ts: number; text: string }
  /** A prompt typed mid-turn. By the time its queued_command line reaches the
   * file it has already been seen by the agent — most never get a user line
   * of their own (the harness injects them into tool results instead), so
   * this IS the user turn. `delivered` marks the rare double-delivery case
   * where a real user line with the same text follows; the UI hides those. */
  | { kind: "queued"; id: string; ts: number; text: string; delivered?: boolean }
  /** A cross-session (agent-to-agent) message from another Claude session. */
  | { kind: "peer"; id: string; ts: number; text: string; from?: string }
  /** An AskUserQuestion dialog: interactive while unanswered. */
  | {
      kind: "ask";
      id: string;
      ts: number;
      questions: AskQuestion[];
      /** question text -> chosen answer, from toolUseResult.answers. */
      answers?: Record<string, string>;
      rejected?: boolean;
    }
  | { kind: "text"; id: string; ts: number; text: string }
  | { kind: "thinking"; id: string; ts: number; text: string }
  | {
      kind: "tool";
      id: string;
      ts: number;
      name: string;
      summary: string;
      input: string;
      result?: { ok: boolean; output: string };
      /** Git-style hunks from the Edit/Write sidecar's structuredPatch. */
      patch?: { file: string; hunks: PatchHunk[] };
    };

export interface AskQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

function parseAskQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const questions: AskQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    if (!q) continue;
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) => asRecord(o))
          .filter((o): o is Record<string, unknown> => o !== null)
          .map((o) => ({
            label: readString(o.label) ?? "",
            ...(readString(o.description) ? { description: readString(o.description)! } : {}),
          }))
          .filter((o) => o.label.length > 0)
      : [];
    questions.push({
      header: readString(q.header) ?? "",
      question: readString(q.question) ?? "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions;
}

export interface PatchHunk {
  header: string;
  /** Unified-diff lines, first char is "+", "-" or " ". */
  lines: string[];
}

const PATCH_LINE_LIMIT = 400;

function extractPatch(sidecar: unknown): { file: string; hunks: PatchHunk[] } | undefined {
  const sc = asRecord(sidecar);
  const raw = sc?.structuredPatch;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const hunks: PatchHunk[] = [];
  let total = 0;
  for (const entry of raw) {
    const hunk = asRecord(entry);
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    const lines = hunk.lines.filter((line): line is string => typeof line === "string");
    if (lines.length === 0) continue;
    const kept = lines.slice(0, Math.max(0, PATCH_LINE_LIMIT - total));
    if (kept.length < lines.length) kept.push(`… ${lines.length - kept.length} more lines`);
    total += kept.length;
    hunks.push({
      header: `@@ -${hunk.oldStart ?? "?"},${hunk.oldLines ?? "?"} +${hunk.newStart ?? "?"},${hunk.newLines ?? "?"} @@`,
      lines: kept,
    });
    if (total >= PATCH_LINE_LIMIT) break;
  }
  if (hunks.length === 0) return undefined;
  return { file: readString(sc?.filePath) ?? "", hunks };
}

const INPUT_CHAR_LIMIT = 4_000;
const RESULT_CHAR_LIMIT = 8_000;
const TEXT_CHAR_LIMIT = 64_000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} more chars]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseTimestamp(value: unknown): number {
  const ts = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ts) ? ts : Date.now();
}

/** One-line human summary of a tool invocation: name + its key argument. */
export function summarizeToolUse(rawName: string, input: Record<string, unknown>): string {
  // Same display convention as the hook's formatToolAction: MCP tools read as
  // their bare name, not mcp__<server>__<tool>.
  const name = rawName.replace(/^mcp__[^_]+__/, "");
  const key =
    readString(input.command) ??
    readString(input.file_path) ??
    readString(input.pattern) ??
    readString(input.url) ??
    readString(input.query) ??
    readString(input.description) ??
    readString(input.prompt) ??
    readString(input.skill);
  if (!key) return name;
  const flat = key.replace(/\s+/g, " ").trim();
  return `${name}: ${flat.length > 120 ? `${flat.slice(0, 117)}...` : flat}`;
}

/** Flatten a tool_result / toolUseResult payload into displayable text. */
function toolResultText(sidecar: unknown, blockContent: unknown): string {
  const sc = asRecord(sidecar);
  if (sc) {
    const stdout = readString(sc.stdout);
    const stderr = readString(sc.stderr);
    if (stdout !== null || stderr !== null) {
      return [stdout, stderr && stderr.length > 0 ? `[stderr]\n${stderr}` : null]
        .filter((part): part is string => part !== null && part.length > 0)
        .join("\n");
    }
  }
  if (typeof blockContent === "string") return blockContent;
  if (Array.isArray(blockContent)) {
    const parts = blockContent
      .map((part) => {
        const rec = asRecord(part);
        // Screenshots and other image results carry no text; name the file the
        // sidecar saved instead of rendering an empty result.
        if (rec?.type === "image") return readString(sc?.file) ?? "[image]";
        return readString(rec?.text) ?? "";
      })
      .filter((text) => text.length > 0);
    if (parts.length > 0) return parts.join("\n");
  }
  if (sc) {
    try {
      return JSON.stringify(sc, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Stateful builder: feed raw JSONL lines in file order, read `entries` out.
 * `feed` returns the ids of entries it added or updated so a streaming caller
 * can broadcast only the delta.
 */
export class TranscriptBuilder {
  readonly entries: TranscriptEntry[] = [];
  /**
   * Subagents the harness has reported as finished. Background agents give no
   * other completion signal — their launching tool call returns immediately —
   * so this notification is the authoritative end, keyed by agent id.
   */
  readonly finishedAgents = new Set<string>();
  private indexById = new Map<string, number>();
  /** Queued prompts awaiting a possible re-delivery as a real user line. */
  private pendingQueued: { text: string; id: string }[] = [];

  /**
   * @param sidechain true when reading a subagent's own file, where every line
   * is marked `isSidechain` — the main transcript skips those, since subagent
   * work lives in its own file.
   */
  constructor(private readonly sidechain = false) {}

  feed(line: string): string[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(trimmed));
    } catch {
      return [];
    }
    if (!record) return [];
    if ((record.isSidechain === true) !== this.sidechain) return [];

    switch (record.type) {
      case "user":
        return this.feedUser(record);
      case "assistant":
        return this.feedAssistant(record);
      case "attachment":
        return this.feedAttachment(record);
      default:
        return [];
    }
  }

  private feedAttachment(record: Record<string, unknown>): string[] {
    const attachment = asRecord(record.attachment);
    if (!attachment || attachment.type !== "queued_command") return [];
    // Only human-typed prompts; system notifications also arrive queued.
    if (asRecord(attachment.origin)?.kind !== "human") return [];
    const prompt = readString(attachment.prompt);
    if (!prompt || prompt.trim().length === 0) return [];
    const uuid = readString(record.uuid) ?? `queued-${this.entries.length}`;
    const ts = parseTimestamp(record.timestamp ?? attachment.timestamp);
    this.pendingQueued.push({ text: prompt.trim(), id: uuid });
    return [
      this.upsert({ kind: "queued", id: uuid, ts, text: truncate(prompt, TEXT_CHAR_LIMIT) }),
    ];
  }

  /** Record a finished subagent from a harness task-notification. */
  private noteAgentFinished(text: string): void {
    const agentId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const status = text.match(/<status>([^<]+)<\/status>/)?.[1];
    if (agentId && status && status !== "running") this.finishedAgents.add(agentId);
  }

  /** Hide queued entries that a real user line re-delivers. The delivered
   * text may embed the queued prompt (harness wrapping), so match on exact
   * equality or prefix, not just identity. */
  private deliverQueued(text: string): string[] {
    const delivered = text.trim();
    const changed: string[] = [];
    this.pendingQueued = this.pendingQueued.filter((pending) => {
      if (delivered !== pending.text && !delivered.startsWith(pending.text)) return true;
      const entry = this.getEntry(pending.id);
      if (entry && entry.kind === "queued") {
        changed.push(this.upsert({ ...entry, delivered: true }));
      }
      return false;
    });
    return changed;
  }

  private upsert(entry: TranscriptEntry): string {
    const existing = this.indexById.get(entry.id);
    if (existing !== undefined) {
      this.entries[existing] = entry;
    } else {
      this.indexById.set(entry.id, this.entries.length);
      this.entries.push(entry);
    }
    return entry.id;
  }

  getEntry(id: string): TranscriptEntry | undefined {
    const index = this.indexById.get(id);
    return index === undefined ? undefined : this.entries[index];
  }

  private feedUser(record: Record<string, unknown>): string[] {
    const message = asRecord(record.message);
    if (!message) return [];
    const uuid = readString(record.uuid) ?? `user-${this.entries.length}`;
    const ts = parseTimestamp(record.timestamp);
    const content = message.content;

    // Cross-session (A2A) messages arrive as meta user lines with
    // origin.kind "peer"; origin.body is the clean text (message.content is
    // the harness-wrapped form) and origin.name the sender.
    const origin = asRecord(record.origin);
    if (origin?.kind === "peer") {
      const body =
        readString(origin.body) ?? (typeof content === "string" ? content : null);
      if (!body || body.trim().length === 0) return [];
      const from = readString(origin.name) ?? undefined;
      return [
        this.upsert({
          kind: "peer",
          id: uuid,
          ts,
          text: truncate(body, TEXT_CHAR_LIMIT),
          ...(from ? { from } : {}),
        }),
      ];
    }

    if (record.isMeta === true) return [];

    if (typeof content === "string") {
      if (content.trim().length === 0) return [];
      // Only human prompts render as turns. System-injected user lines (task
      // notifications, reminders) carry origin.kind !== "human"; when origin
      // is absent (older versions) fall back to sniffing system markers.
      const originKind = asRecord(record.origin)?.kind;
      if (originKind === "task-notification") {
        this.noteAgentFinished(content);
        return [];
      }
      if (originKind !== undefined && originKind !== "human") return [];
      if (originKind === undefined && /^<(task-notification|system-reminder)/.test(content.trim()))
        return [];
      return [
        ...this.deliverQueued(content),
        this.upsert({ kind: "user", id: uuid, ts, text: truncate(content, TEXT_CHAR_LIMIT) }),
      ];
    }

    if (!Array.isArray(content)) return [];
    const changed: string[] = [];
    const promptTexts: string[] = [];
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      if (rec.type === "tool_result") {
        // Tool and ask entries are keyed by their tool_use id.
        const toolUseId = readString(rec.tool_use_id);
        const entry = toolUseId ? this.getEntry(toolUseId) : undefined;
        if (!entry) continue;
        if (entry.kind === "ask") {
          const sidecar = asRecord(record.toolUseResult);
          const answersRaw = asRecord(sidecar?.answers);
          if (answersRaw) {
            const answers: Record<string, string> = {};
            for (const [q, a] of Object.entries(answersRaw)) {
              if (typeof a === "string") answers[q] = a;
            }
            changed.push(this.upsert({ ...entry, answers }));
          } else {
            changed.push(this.upsert({ ...entry, rejected: true }));
          }
          continue;
        }
        if (entry.kind !== "tool") continue;
        const patch = extractPatch(record.toolUseResult);
        // With a patch the textual output is redundant boilerplate — keep it
        // only for failures.
        const output =
          patch && rec.is_error !== true ? "" : toolResultText(record.toolUseResult, rec.content);
        changed.push(
          this.upsert({
            ...entry,
            result: { ok: rec.is_error !== true, output: truncate(output, RESULT_CHAR_LIMIT) },
            ...(patch ? { patch } : {}),
          }),
        );
      } else if (rec.type === "text") {
        const text = readString(rec.text);
        if (text && text.trim().length > 0) promptTexts.push(text);
      }
    }
    if (promptTexts.length > 0) {
      changed.push(
        this.upsert({
          kind: "user",
          id: uuid,
          ts,
          text: truncate(promptTexts.join("\n\n"), TEXT_CHAR_LIMIT),
        }),
      );
    }
    return changed;
  }

  private feedAssistant(record: Record<string, unknown>): string[] {
    const message = asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const uuid = readString(record.uuid) ?? `assistant-${this.entries.length}`;
    const ts = parseTimestamp(record.timestamp);
    const changed: string[] = [];

    for (let i = 0; i < content.length; i++) {
      const block = asRecord(content[i]);
      if (!block) continue;
      const blockId = `${uuid}:${i}`;
      switch (block.type) {
        case "text": {
          const text = readString(block.text);
          if (text && text.trim().length > 0) {
            changed.push(
              this.upsert({ kind: "text", id: blockId, ts, text: truncate(text, TEXT_CHAR_LIMIT) }),
            );
          }
          break;
        }
        case "thinking": {
          const text = readString(block.thinking);
          // Thinking lines can carry only a signature with empty text — skip those.
          if (text && text.trim().length > 0) {
            changed.push(
              this.upsert({
                kind: "thinking",
                id: blockId,
                ts,
                text: truncate(text, TEXT_CHAR_LIMIT),
              }),
            );
          }
          break;
        }
        case "tool_use": {
          const toolUseId = readString(block.id) ?? blockId;
          const name = readString(block.name) ?? "tool";
          const input = asRecord(block.input) ?? {};
          if (name === "AskUserQuestion") {
            const questions = parseAskQuestions(input);
            if (questions.length > 0) {
              changed.push(this.upsert({ kind: "ask", id: toolUseId, ts, questions }));
              break;
            }
          }
          let inputText: string;
          try {
            inputText = JSON.stringify(input, null, 2);
          } catch {
            inputText = "{}";
          }
          changed.push(
            this.upsert({
              kind: "tool",
              id: toolUseId,
              ts,
              name,
              summary: summarizeToolUse(name, input),
              input: truncate(inputText, INPUT_CHAR_LIMIT),
            }),
          );
          break;
        }
      }
    }
    return changed;
  }
}
