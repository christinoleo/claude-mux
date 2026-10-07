/**
 * Folds runs of routine tool calls into one summary line, the way Claude
 * Code's fullscreen TUI does: "Ran 4 shell commands", "Searched for 1
 * pattern, called brave-windows 2 times". A working session otherwise reads
 * as a wall of tool rows with the prose lost between them.
 *
 * Only calls that are finished and unremarkable fold. Anything the reader
 * should see without opening a group stays a row of its own and ends the run:
 * a call still in flight, a subagent, a todo or plan update, an edit drawn as
 * a diff, a question. Thinking between folded calls folds with them; thinking
 * before the first call or after the last stays outside, with the prose.
 */

import { asRecord, readString } from "./json.js";
import { parseMcpToolName } from "./mcp.js";
import type { TranscriptEntry } from "./parser.js";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

export interface ToolGroup {
  kind: "group";
  /** The first call's id, so the group keeps its key as it grows. */
  id: string;
  entries: TranscriptEntry[];
  summary: string;
  failed: number;
}

/**
 * An entry passes through as the same object, so a keyed `each` over the
 * items re-renders only the rows that changed, not every row on every delta.
 */
export type TranscriptItem = TranscriptEntry | ToolGroup;

/** Tools whose rows the transcript draws specially, never folded. */
const STANDALONE_TOOLS = new Set([
  "Task",
  "Agent",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
]);

function foldable(entry: TranscriptEntry): entry is ToolEntry {
  return (
    entry.kind === "tool" &&
    entry.result != null &&
    !entry.patch &&
    !STANDALONE_TOOLS.has(entry.name)
  );
}

/** A verb phrase, singular and plural, for one category of call. */
interface Category {
  key: string;
  phrase: (n: number) => string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => plural(n, "time", "times");

const SHELL: Category = {
  key: "shell",
  phrase: (n) => `ran ${plural(n, "shell command", "shell commands")}`,
};
const READ: Category = { key: "read", phrase: (n) => `read ${plural(n, "file", "files")}` };
const EDIT: Category = { key: "edit", phrase: (n) => `edited ${plural(n, "file", "files")}` };
const WRITE: Category = { key: "write", phrase: (n) => `wrote ${plural(n, "file", "files")}` };
const SEARCH: Category = {
  key: "search",
  phrase: (n) => `searched for ${plural(n, "pattern", "patterns")}`,
};
const LIST: Category = {
  key: "list",
  phrase: (n) => `listed ${plural(n, "directory", "directories")}`,
};
const FETCH: Category = { key: "fetch", phrase: (n) => `fetched ${plural(n, "page", "pages")}` };
const WEB_SEARCH: Category = { key: "websearch", phrase: (n) => `searched the web ${times(n)}` };

/** A shell command chaining, redirecting or spanning lines is just a shell command. */
const COMPOUND = /[|;&<>`$\n]/;
const SHELL_VERBS: Record<string, Category> = {
  ls: LIST,
  tree: LIST,
  grep: SEARCH,
  rg: SEARCH,
  ag: SEARCH,
  cat: READ,
  head: READ,
  tail: READ,
};

/** A lone `ls` or `grep` reads as what it does, as the TUI shows it. */
function shellCategory(input: string): Category {
  let command: string | undefined;
  try {
    command = readString(asRecord(JSON.parse(input))?.command)?.trim();
  } catch {
    // Truncated input: fall through to a plain shell command.
  }
  if (!command || COMPOUND.test(command)) return SHELL;
  const [verb, ...args] = command.split(/\s+/);
  const category = SHELL_VERBS[verb] ?? SHELL;
  // `cat a b` is not "read 1 file"; only a read of exactly one file says so.
  if (category === READ && args.filter((a) => !a.startsWith("-")).length !== 1) return SHELL;
  return category;
}

const TOOL_CATEGORIES: Record<string, Category> = {
  BashOutput: SHELL,
  KillShell: SHELL,
  PowerShell: SHELL,
  Read: READ,
  Edit: EDIT,
  MultiEdit: EDIT,
  NotebookEdit: EDIT,
  Write: WRITE,
  Grep: SEARCH,
  Glob: SEARCH,
  LS: LIST,
  WebFetch: FETCH,
  WebSearch: WEB_SEARCH,
};

/**
 * Categories by entry. The view regroups on every streamed delta, and a Bash
 * call's category costs a JSON parse; an entry that changes is a new object.
 */
const categoryCache = new WeakMap<ToolEntry, Category>();

function categorize(tool: ToolEntry): Category {
  let category = categoryCache.get(tool);
  if (!category) {
    category = categorizeUncached(tool);
    categoryCache.set(tool, category);
  }
  return category;
}

function categorizeUncached(tool: ToolEntry): Category {
  const mcp = parseMcpToolName(tool.name);
  if (mcp) return { key: `mcp:${mcp.server}`, phrase: (n) => `called ${mcp.server} ${times(n)}` };
  if (tool.name === "Bash") return shellCategory(tool.input);
  return (
    TOOL_CATEGORIES[tool.name] ?? {
      key: `tool:${tool.name}`,
      phrase: (n) => `used ${tool.name} ${times(n)}`,
    }
  );
}

/** "Listed 1 directory, ran 2 shell commands": categories in order of first use. */
export function summarizeToolRun(tools: ToolEntry[]): string {
  const counts = new Map<string, { category: Category; n: number }>();
  for (const tool of tools) {
    const category = categorize(tool);
    const seen = counts.get(category.key);
    if (seen) seen.n++;
    else counts.set(category.key, { category, n: 1 });
  }
  const text = [...counts.values()].map(({ category, n }) => category.phrase(n)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The transcript as the view draws it: entries in order, with every run of two
 * or more foldable calls (and the thinking among them) gathered into a group.
 */
export function groupToolRuns(entries: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: TranscriptEntry[] = [];

  const flush = () => {
    // Thinking around the calls belongs to the prose beside it.
    let start = 0;
    let end = run.length;
    while (start < end && run[start].kind === "thinking") start++;
    while (end > start && run[end - 1].kind === "thinking") end--;
    const body = run.slice(start, end);
    const tools = body.filter(foldable);
    if (tools.length >= 2) {
      items.push(...run.slice(0, start));
      items.push({
        kind: "group",
        id: body[0].id,
        entries: body,
        summary: summarizeToolRun(tools),
        failed: tools.filter((t) => t.result?.ok === false).length,
      });
      items.push(...run.slice(end));
    } else {
      items.push(...run);
    }
    run = [];
  };

  for (const entry of entries) {
    if (entry.kind === "thinking" || foldable(entry)) {
      run.push(entry);
      continue;
    }
    flush();
    items.push(entry);
  }
  flush();
  return items;
}
