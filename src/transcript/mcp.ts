/**
 * MCP tools reach the transcript as `mcp__<server>__<tool>`. Server names may
 * themselves hold single underscores (`claude_ai_Claude_Docs`), so the name is
 * split on the double underscore, never on `_`.
 */
export interface McpToolName {
  server: string;
  tool: string;
}

export function parseMcpToolName(name: string): McpToolName | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : null;
}
