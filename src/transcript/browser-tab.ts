/**
 * Which browser page a session is on, read off its log.
 *
 * The browser MCP server (chrome-devtools-mcp) ends a tool's result with the
 * list of open pages, the selected one marked:
 *
 *   ## Pages
 *   1: Inbox (https://mail.example/) [selected]
 *   2: https://example.com/
 *
 * The last such list in the log names the page the session last opened or
 * selected. A `new_page` whose result carries no list falls back to the URL it
 * was asked to open.
 */
import { open } from "fs/promises";
import { asRecord, readString } from "./json.js";

/** How much of the log's end is read: page lists come with every browser call. */
const TAIL_BYTES = 4 * 1024 * 1024;

const PAGE_LINE = /^\d+: (.*) \[selected\]\s*$/;

/** The URL of the page marked selected in a tool result's text, or null. */
export function selectedPage(text: string): string | null {
  const at = text.lastIndexOf("## Pages");
  if (at < 0) return null;
  for (const line of text.slice(at).split("\n")) {
    const m = PAGE_LINE.exec(line);
    if (!m) continue;
    // "Title (url)" once the page has a title, the bare URL before. A bare URL
    // has no space in it, and may itself end in a bracket.
    const body = m[1].trim();
    const titled = /\s\(([a-z][a-z0-9+.-]*:\S*)\)$/i.exec(body);
    return titled ? titled[1] : body;
  }
  return null;
}

/** A tool name's server and tool: `mcp__brave-windows__new_page`. */
const MCP_TOOL = /^mcp__(.+)__([a-z_]+)$/;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => readString(asRecord(b)?.text) ?? "").join("\n");
}

/**
 * The URL of the page `server`'s tools last left selected, going by the log
 * lines given oldest first.
 */
export function lastBrowserPageIn(lines: Iterable<string>, server: string): string | null {
  const prefix = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  /** Calls still waiting for their result: the URL a `new_page` asked for, or null. */
  const calls = new Map<string, string | null>();
  let last: string | null = null;
  for (const line of lines) {
    // A line worth parsing names an MCP tool, or holds the result a call is waiting for.
    if (!line.includes("mcp__") && !(calls.size > 0 && line.includes('"tool_use_id"'))) continue;
    let record: { message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string") {
        const m = MCP_TOOL.exec(block.name);
        if (!m || m[1] !== prefix) continue;
        const url = (block.input as { url?: unknown } | undefined)?.url;
        calls.set(block.id, m[2] === "new_page" && typeof url === "string" ? url : null);
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && calls.has(block.tool_use_id)) {
        const asked = calls.get(block.tool_use_id) ?? null;
        calls.delete(block.tool_use_id);
        if (block.is_error) continue;
        last = selectedPage(resultText(block.content)) ?? asked ?? last;
      }
    }
  }
  return last;
}

/** How many logs are remembered before the memory is started over. */
const CACHE_PATHS = 64;
const cache = new Map<string, { size: number; server: string; url: string | null }>();

/** `lastBrowserPageIn` over the end of the log at `path`, re-read only when the file has grown. */
export async function lastBrowserPage(path: string, server: string): Promise<string | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;
  try {
    const { size } = await file.stat();
    const seen = cache.get(path);
    if (seen && seen.size === size && seen.server === server) return seen.url;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await file.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    // A read that starts mid-file starts mid-line.
    if (start > 0) lines.shift();
    const url = lastBrowserPageIn(lines, server);
    if (cache.size >= CACHE_PATHS) cache.clear();
    cache.set(path, { size, server, url });
    return url;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
