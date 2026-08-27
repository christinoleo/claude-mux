<script lang="ts">
	import type { SubagentPayload } from '$lib/stores/transcript.svelte';

	let {
		agents,
		onReveal
	}: {
		/** Subagents currently working. */
		agents: SubagentPayload[];
		/** Scrolls the transcript to this agent's Task card. */
		onReveal?: (toolUseId: string) => void;
	} = $props();
</script>

{#if agents.length > 0}
	<div class="dock">
		<span class="dock-label">
			<iconify-icon icon="mdi:robot-outline"></iconify-icon>
			{agents.length} running
		</span>
		<div class="dock-agents">
			{#each agents as agent (agent.agentId)}
				{@const doing = agent.activity[agent.activity.length - 1]}
				<button
					class="dock-agent"
					onclick={() => agent.toolUseId && onReveal?.(agent.toolUseId)}
					title="Jump to this agent"
				>
					<span class="dot"></span>
					<span class="name">{agent.description ?? agent.agentType ?? 'agent'}</span>
					{#if doing}<span class="doing">{doing.summary}</span>{/if}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	/* Sits above the toolbar so running agents never scroll out of sight. */
	.dock {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 10px;
		background: #14131a;
		border-top: 1px solid #2a2637;
		overflow: hidden;
	}
	.dock-label {
		display: flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #9b8fd4;
	}
	.dock-agents {
		display: flex;
		gap: 6px;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.dock-agents::-webkit-scrollbar {
		display: none;
	}
	.dock-agent {
		display: flex;
		align-items: center;
		gap: 7px;
		flex-shrink: 0;
		max-width: 340px;
		padding: 3px 10px;
		border: 1px solid #2a2637;
		border-radius: 999px;
		background: #1b1926;
		cursor: pointer;
		color: #d6d3d1;
		font-size: 12px;
	}
	.dock-agent:hover {
		border-color: #4c3f7a;
		background: #221f2e;
	}
	.dot {
		flex-shrink: 0;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #34d399;
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.3;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none;
		}
	}
	.name {
		flex-shrink: 0;
		font-weight: 600;
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.doing {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 11px;
		color: #8a837c;
	}
</style>
