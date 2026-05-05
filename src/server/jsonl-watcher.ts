import { existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAllSessions, updateSession, type PendingQuestionItem } from '../db/sessions-json.js';

function getJsonlPath(cwd: string, sessionId: string): string {
  // ~/.claude/projects/-home-user-project/session-id.jsonl
  const projectPath = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', projectPath, `${sessionId}.jsonl`);
}

class JsonlWatcher {
  // sessionId → byte offset of last read position
  private offsets = new Map<string, number>();
  // toolUseId → sessionId for in-flight AskUserQuestion calls
  private pendingAsks = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pollInterval = 300;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollInterval);
    console.log('[jsonl-watcher] Started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.offsets.clear();
    this.pendingAsks.clear();
  }

  private poll(): void {
    const sessions = getAllSessions();
    for (const session of sessions) {
      if (!session.cwd) continue;
      const path = getJsonlPath(session.cwd, session.id);
      if (!existsSync(path)) continue;
      this.readNewLines(session.id, path);
    }
  }

  private readNewLines(sessionId: string, path: string): void {
    try {
      const stat = statSync(path);
      let offset = this.offsets.get(sessionId);

      if (offset === undefined) {
        // First time seeing this file — start from end so we don't replay history
        this.offsets.set(sessionId, stat.size);
        return;
      }

      if (stat.size <= offset) return;

      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      const fd = openSync(path, 'r');
      const bytesRead = readSync(fd, buf, 0, len, offset);
      closeSync(fd);

      this.offsets.set(sessionId, offset + bytesRead);

      const text = buf.toString('utf8', 0, bytesRead);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.processLine(sessionId, trimmed);
      }
    } catch {
      // File may be temporarily inaccessible
    }
  }

  private processLine(sessionId: string, line: string): void {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content;
    if (!Array.isArray(content)) return;

    if (message.role === 'assistant') {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;

        const id = block.id as string;
        const input = block.input as Record<string, unknown>;
        if (!id || !input) continue;

        this.pendingAsks.set(id, sessionId);

        let questions: PendingQuestionItem[];
        const rawQs = input.questions as PendingQuestionItem[] | undefined;
        if (rawQs?.length) {
          questions = rawQs;
        } else if (input.question) {
          questions = [{
            question: input.question as string,
            header: input.header as string | undefined,
            multiSelect: input.multiSelect as boolean | undefined,
            options: input.options as PendingQuestionItem['options'],
          }];
        } else {
          questions = [];
        }

        updateSession(sessionId, {
          pending_question: { questions, started_at: Date.now() },
          state: 'waiting',
          current_action: 'Waiting for answer',
        });
        console.log(`[jsonl-watcher] AskUserQuestion pending for session ${sessionId.slice(0, 8)}`);
      }
    }

    if (message.role === 'user') {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = block.tool_use_id as string | undefined;
        if (!toolUseId || !this.pendingAsks.has(toolUseId)) continue;

        const sid = this.pendingAsks.get(toolUseId)!;
        this.pendingAsks.delete(toolUseId);

        updateSession(sid, { pending_question: null });
        console.log(`[jsonl-watcher] AskUserQuestion cleared for session ${sid.slice(0, 8)}`);
      }
    }
  }
}

export const jsonlWatcher = new JsonlWatcher();
