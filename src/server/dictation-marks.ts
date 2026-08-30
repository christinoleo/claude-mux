/**
 * Remember which injected prompts arrived by voice.
 *
 * The voice endpoint pastes transcribed text into the pane, after which it is
 * indistinguishable from typing — the JSONL user line it becomes carries no
 * origin. So the endpoint records what it injected here, and the transcript
 * manager asks on each new user/queued entry whether its text matches a
 * recent dictation. Matching is by normalized text within a time window: if
 * the user edits the paste before submitting, the text no longer matches and
 * the prompt correctly reads as typed.
 *
 * Marks are mirrored to ~/.claude-mux/dictation.json so a server restart
 * (which re-parses transcripts from scratch) re-marks old entries the same
 * way. Kept in globalThis to survive Vite's dual module loading.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CLAUDE_MUX_DIR } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/atomic-write.js";

interface DictationMark {
  /** Normalized injected text. */
  text: string;
  /** When it was injected (ms). */
  at: number;
}

/** How far apart the injection and the JSONL user line may sit. Generous:
 * a dictation can sit in the prompt box a while before the user submits it. */
const MATCH_WINDOW_MS = 15 * 60_000;

/** Per session; old marks only matter until the entry they match is written,
 * but they must survive restarts, so cap by count rather than age. */
const MAX_MARKS_PER_SESSION = 100;

/** Sessions kept in the file, most recently dictated-into first, so the
 * per-utterance rewrite cannot grow with every session ever spoken to. */
const MAX_SESSIONS = 50;

// Read at call time, not module load, so tests can point it at a temp file.
function marksPath(): string {
  return process.env.CLAUDE_MUX_DICTATION_PATH ?? join(CLAUDE_MUX_DIR, "dictation.json");
}

interface MarksGlobalState {
  marks: Map<string, DictationMark[]>;
  loaded: boolean;
}

function state(): MarksGlobalState {
  const g = globalThis as typeof globalThis & { __claudeMuxDictationMarks?: MarksGlobalState };
  return (g.__claudeMuxDictationMarks ??= { marks: new Map(), loaded: false });
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function load(): Map<string, DictationMark[]> {
  const s = state();
  if (!s.loaded) {
    s.loaded = true;
    try {
      if (existsSync(marksPath())) {
        const raw = JSON.parse(readFileSync(marksPath(), "utf8")) as Record<string, DictationMark[]>;
        for (const [id, list] of Object.entries(raw)) {
          if (Array.isArray(list)) s.marks.set(id, list);
        }
      }
    } catch (err) {
      console.error("[dictation] failed to read marks file:", err);
    }
  }
  return s.marks;
}

function save(marks: Map<string, DictationMark[]>): void {
  try {
    writeFileAtomic(marksPath(), JSON.stringify(Object.fromEntries(marks)));
  } catch (err) {
    console.error("[dictation] failed to write marks file:", err);
  }
}

/** Record that `text` was just injected into `sessionId`'s pane by voice. */
export function recordDictation(sessionId: string, text: string): void {
  const normalized = normalize(text);
  if (!normalized) return;
  const marks = load();
  const list = marks.get(sessionId) ?? [];
  list.push({ text: normalized, at: Date.now() });
  marks.set(sessionId, list.slice(-MAX_MARKS_PER_SESSION));
  if (marks.size > MAX_SESSIONS) {
    // Marks are appended in time order, so a list's last entry is its newest.
    const stalest = [...marks.entries()]
      .sort((a, b) => (b[1].at(-1)?.at ?? 0) - (a[1].at(-1)?.at ?? 0))
      .slice(MAX_SESSIONS);
    for (const [id] of stalest) marks.delete(id);
  }
  save(marks);
}

/** Whether a transcript entry with this text and timestamp was dictated. */
export function isDictated(sessionId: string, text: string, ts: number): boolean {
  const list = load().get(sessionId);
  if (!list || list.length === 0) return false;
  const normalized = normalize(text);
  if (!normalized) return false;
  return list.some((m) => m.text === normalized && Math.abs(ts - m.at) <= MATCH_WINDOW_MS);
}

/** Test hook: drop all in-memory state so the next call re-reads the file. */
export function resetDictationMarksForTest(): void {
  const s = state();
  s.marks = new Map();
  s.loaded = false;
}
