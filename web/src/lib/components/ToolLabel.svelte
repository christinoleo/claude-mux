<script lang="ts">
	import { parseMcpToolName } from '$shared/transcript/mcp.js';

	/**
	 * A tool call's one-line label. Built-in tools read as their summary; an MCP
	 * tool adds the server it came from, faint, ahead of the tool name, and sets
	 * its key argument apart from the name.
	 */
	let { name, summary }: { name: string; summary: string } = $props();

	const mcp = $derived(parseMcpToolName(name));
	// The summary reads `tool: arg`; tool names never hold ': '.
	const arg = $derived(mcp ? summary.split(': ').slice(1).join(': ') : '');
</script>

{#if mcp}<span class="server">{mcp.server}</span><span class="sep">·</span><span class="tool"
		>{mcp.tool}</span
	>{#if arg}<span class="arg">{arg}</span>{/if}{:else}{summary}{/if}

<style>
	.server {
		opacity: 0.55;
	}
	.sep {
		opacity: 0.4;
		margin: 0 0.45em;
	}
	.arg {
		margin-left: 1.2em;
		opacity: 0.7;
	}
</style>
