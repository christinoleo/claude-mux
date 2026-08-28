<script lang="ts">
	import type { SubagentPayload } from '$lib/stores/transcript.svelte';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';

	let {
		agents,
		onReveal
	}: {
		/** Subagents working right now. */
		agents: SubagentPayload[];
		/** Scrolls the transcript to an agent's Task card. */
		onReveal?: (toolUseId: string) => void;
	} = $props();

	/** Beyond this the stack would cover the conversation; the rest is a count. */
	const MAX_SHOWN = 3;
	const shown = $derived(agents.slice(0, MAX_SHOWN));
	const overflow = $derived(Math.max(0, agents.length - MAX_SHOWN));
</script>

<!--
  Floats over the transcript instead of sitting in the layout, so agents
  starting and finishing never reflow the conversation or the input row.
-->
{#if agents.length > 0}
	<div class="agent-overlay">
		{#each shown as agent (agent.agentId)}
			{@const doing = agent.activity[agent.activity.length - 1]}
			<button
				class="agent-float"
				onclick={() => agent.toolUseId && onReveal?.(agent.toolUseId)}
				title={agent.toolUseId ? 'Jump to this agent' : 'Running agent'}
			>
				<SessionStateIndicator state="busy" />
				<span class="body">
					<span class="name">{agent.description ?? agent.agentType ?? 'agent'}</span>
					{#if doing}<span class="doing">{doing.summary}</span>{/if}
				</span>
			</button>
		{/each}
		{#if overflow > 0}
			<div class="agent-float more">+{overflow} more running</div>
		{/if}
	</div>
{/if}

<style>
	.agent-overlay {
		position: absolute;
		right: 12px;
		/* Clears the jump-to-bottom button, which owns the corner. */
		bottom: 58px;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 5px;
		max-width: min(340px, calc(100% - 24px));
		/* The stack is a readout: clicks land on the cards, scrolling passes through. */
		pointer-events: none;
	}
	.agent-float {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: 8px;
		max-width: 100%;
		padding: 6px 11px;
		border: 1px solid #3b3358;
		border-radius: 10px;
		background: rgba(24, 21, 33, 0.94);
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
		cursor: pointer;
		text-align: left;
		color: #e7e5e4;
	}
	.agent-float:hover {
		border-color: #6d5bb0;
		background: rgba(34, 31, 46, 0.97);
	}
	.agent-float.more {
		cursor: default;
		font-size: 11px;
		color: #9b8fd4;
		padding: 3px 11px;
	}
	.agent-float :global(.pulse-dot) {
		margin-top: 5px;
	}
	.body {
		min-width: 0;
	}
	.name {
		display: block;
		font-size: 12.5px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.doing {
		display: block;
		font-family: var(--font-mono);
		font-size: 11px;
		color: #a8a29e;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
