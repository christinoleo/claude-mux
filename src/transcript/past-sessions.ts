/**
 * Past sessions: the Claude Code conversations a machine still holds on disk
 * (GLOSSARY.md, "Past session"), read from their transcripts.
 *
 * A transcript is `~/.claude/projects/<launch dir>/<session id>.jsonl`; its
 * subagents sit below it in `<session id>/subagents/`, so only the files at
 * the top of each project directory are conversations. Each is read at its
 * two ends, never whole: the head gives where it ran and the first prompt,
 * the tail when it was last active, its latest folder and branch, and its
 * title (a `custom-title` set with /rename, else Claude Code's `ai-title`).
 * A title written mid-file is missed, and the first prompt stands in.
 *
 * Claude Code deletes transcripts after 30 days; what is on disk is the list.
 * The format is Claude Code's own and changes between versions, so every
 * field is optional and a file that cannot be read is left out.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type PastSession } from "../past-session.js";
import { parseSlashCommand, unwrapPasted } from "./parser.js";
import { projectsRoot } from "./tailer.js";


/** How much of each end of a transcript is read. */
export const END_BYTES = 64 * 1024;
/** A prompt or title longer than this is cut; the list shows one line. */
export const MAX_LABEL = 160;

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;


type Entry = Record<string, unknown>;

/** The whole JSON lines in `text`; with `cutStart`/`cutEnd` the first or last line is a fragment and is dropped. */
function parseLines(text: string, cutStart: boolean, cutEnd: boolean): Entry[] {
  const lines = text.split("\n");
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  const out: Entry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Entry);
    } catch {
      // A torn or foreign line: skip it.
    }
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

/**
 * What a person typed in a user entry, or null for anything else: a tool
 * result, a meta line, a hook's or a command's output. A slash command reads
 * as typed (`/ak:maestro-worker 102`).
 */
export function promptText(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return null;
  const message = entry.message as { content?: unknown } | undefined;
  let text: string | null = null;
  if (typeof message?.content === "string") text = message.content;
  else if (Array.isArray(message?.content)) {
    const block = message.content.find(
      (b): b is { type: "text"; text: string } => !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string"
    );
    if (!block || message.content.some((b) => b?.type === "tool_result")) return null;
    text = block.text;
  }
  // A long paste is logged inside Claude Code's <pasted_content> wrapper.
  if (text) text = unwrapPasted(text);
  if (!text?.trim()) return null;
  const command = parseSlashCommand(text);
  if (command) return clip(command.args ? `${command.name} ${command.args}` : command.name);
  if (/^\s*<(local-command|command-message|system-reminder|bash-|user-memory)/.test(text) || text.startsWith("Caveat:")) {
    return null;
  }
  return clip(text);
}

function timestampOf(entry: Entry): number | null {
  const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Read one transcript's two ends into a past session, or null when it is not
 * one a person would reopen: a subagent's (sidechain), one run by the SDK or
 * `claude -p` rather than at the prompt, or one where nothing was ever asked.
 */
export async function readPastSession(path: string): Promise<PastSession | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  let head: string;
  let tail: string;
  let size: number;
  let mtimeMs: number;
  try {
    const info = await handle.stat();
    size = info.size;
    mtimeMs = info.mtimeMs;
    const headBuf = Buffer.alloc(Math.min(size, END_BYTES));
    await handle.read(headBuf, 0, headBuf.length, 0);
    head = headBuf.toString("utf8");
    if (size > END_BYTES) {
      const tailLength = Math.min(size - END_BYTES, END_BYTES);
      const tailBuf = Buffer.alloc(tailLength);
      await handle.read(tailBuf, 0, tailLength, size - tailLength);
      tail = tailBuf.toString("utf8");
    } else {
      tail = "";
    }
  } catch {
    return null;
  } finally {
    await handle.close();
  }

  const headEntries = parseLines(head, false, size > END_BYTES);
  // The tail's first line is whole only when it starts right after the head.
  const tailEntries = tail ? parseLines(tail, size > 2 * END_BYTES || !head.endsWith("\n"), false) : [];
  const all = [...headEntries, ...tailEntries];

  let cwd: string | null = null;
  let branch: string | null = null;
  let prompt: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let last: number | null = null;
  for (const entry of all) {
    // A subagent's line inside the conversation is not the conversation's.
    if (entry.isSidechain === true) continue;
    const entrypoint = str(entry.entrypoint);
    if (entrypoint?.startsWith("sdk")) return null;
    cwd = str(entry.cwd) ?? cwd;
    branch = str(entry.gitBranch) ?? branch;
    prompt ??= promptText(entry);
    if (entry.type === "custom-title") customTitle = str(entry.customTitle) ?? customTitle;
    if (entry.type === "ai-title") aiTitle = str(entry.aiTitle) ?? aiTitle;
    if (entry.type === "last-prompt") lastPrompt = str(entry.lastPrompt) ?? lastPrompt;
    last = timestampOf(entry) ?? last;
  }
  prompt ??= lastPrompt ? clip(lastPrompt) : null;
  // /rename also leaves the title beside the transcript.
  customTitle = (await readTitleFile(path)) ?? customTitle;
  const title = customTitle ?? aiTitle;
  if (!prompt && !title) return null;
  return {
    id: basename(path, ".jsonl"),
    cwd,
    branch,
    title: title ? clip(title) : null,
    prompt,
    lastActivity: last ?? mtimeMs,
  };
}

async function readTitleFile(transcriptPath: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(transcriptPath.replace(/\.jsonl$/, ""), "custom-title.json"), "utf8"));
    return str(raw?.customTitle);
  } catch {
    return null;
  }
}

/** The conversation transcripts under `root`: the top of each project directory, never a subagent's. */
export async function listTranscripts(root = projectsRoot()): Promise<{ path: string; mtimeMs: number; size: number }[]> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const out: { path: string; mtimeMs: number; size: number }[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!SESSION_FILE.test(name)) continue;
      const path = join(root, dir, name);
      try {
        const info = await stat(path);
        if (info.isFile()) out.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Gone between the listing and the stat.
      }
    }
  }
  return out;
}

/**
 * Every past session on this machine, kept between reads: a transcript is
 * read again only when its size or time changes, so a listing after the
 * first costs a directory walk and a stat per file.
 */
export class PastSessionIndex {
  private cache = new Map<string, { mtimeMs: number; size: number; session: PastSession | null }>();

  constructor(private readonly root: () => string = projectsRoot) {}

  /** Every past session, newest first. A session id found twice (a transcript moved by /cd) keeps the newer. */
  async list(): Promise<PastSession[]> {
    const files = await listTranscripts(this.root());
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.path);
      const known = this.cache.get(file.path);
      if (known && known.mtimeMs === file.mtimeMs && known.size === file.size) continue;
      this.cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, session: await readPastSession(file.path) });
    }
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    const byId = new Map<string, PastSession>();
    for (const { session } of this.cache.values()) {
      if (!session) continue;
      const other = byId.get(session.id);
      if (!other || other.lastActivity < session.lastActivity) byId.set(session.id, session);
    }
    return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }
}

/** The past sessions that are not live: any session this machine's broadcast lists is left out. */
export function withoutLive(past: readonly PastSession[], live: ReadonlySet<string>): PastSession[] {
  return past.filter((p) => !live.has(p.id));
}
