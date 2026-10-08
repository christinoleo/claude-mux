import { parseMcpToolName } from '$shared/transcript/mcp.js';

/** Icons for MCP server families recognisable from the server name. */
const MCP_FAMILIES: [RegExp, string][] = [
	[/brave|chrome|browser|devtools|playwright|puppeteer/i, 'mdi:web'],
	[/docs|notion|confluence|drive/i, 'mdi:file-document-outline'],
	[/github/i, 'mdi:github'],
	[/slack/i, 'mdi:slack']
];

/** The icon a tool call is drawn with in the transcript. */
export function toolIcon(name: string): string {
	const mcp = parseMcpToolName(name);
	if (mcp) {
		return MCP_FAMILIES.find(([pattern]) => pattern.test(mcp.server))?.[1] ?? 'mdi:power-plug-outline';
	}
	const n = name.toLowerCase();
	if (n.includes('bash') || n.includes('command')) return 'mdi:console';
	if (n.includes('edit') || n.includes('write') || n.includes('notebook')) return 'mdi:file-edit-outline';
	if (n.includes('read')) return 'mdi:file-eye-outline';
	if (n.includes('grep') || n.includes('glob') || n.includes('search')) return 'mdi:magnify';
	if (n.includes('task') || n.includes('agent')) return 'mdi:robot-outline';
	if (n.includes('web')) return 'mdi:web';
	if (n.includes('todo')) return 'mdi:checkbox-marked-outline';
	return 'mdi:tools';
}
