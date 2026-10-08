<script lang="ts">
	/**
	 * One subagent in the sidebar, under the session that spawned it.
	 *
	 * Smaller than a session row, because it is a thread of that session, not a
	 * session of its own: a diamond, what it was asked to do, its agent type,
	 * then how long it has run and the tool it is on — or when it finished.
	 * A finished row dims; a failed one turns red and stays until opened.
	 */
	import type { SubagentInfo } from '$shared/types/ws-messages.js';
	import { agentTypeLabel } from '$shared/subagents.js';
	import { formatElapsed, formatAgo } from '$lib/format';
	import { clock } from '$lib/stores/clock.svelte';

	interface Props {
		agent: SubagentInfo;
		href: string;
		active: boolean;
		onclick: (e: MouseEvent) => void;
	}

	let { agent, href, active, onclick }: Props = $props();

	const running = $derived(agent.state === 'running');

	$effect(() => {
		if (running) return clock.fine();
	});

	const status = $derived.by(() => {
		if (running) {
			const elapsed = formatElapsed((clock.now - agent.started_at) / 1000);
			return ['running', elapsed, agent.current_tool].filter(Boolean).join(' · ');
		}
		const ago = formatAgo(agent.ended_at, clock.now);
		return `${agent.state} ${ago === 'now' ? 'just now' : `${ago} ago`}`;
	});
	const title = $derived(agent.description || agentTypeLabel(agent.type));
</script>

<a
	{href}
	class="agent"
	class:cur={active}
	class:done={agent.state === 'done'}
	class:failed={agent.state === 'failed'}
	{onclick}
	title={agent.description ?? agent.type}
>
	<span class="glyph" aria-hidden="true">
		{#if agent.state === 'done'}
			<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>
		{:else}
			<svg viewBox="0 0 24 24"><path d="M12 3l9 9-9 9-9-9z" /></svg>
		{/if}
	</span>
	<span class="desc">{title}</span>
	<span class="type">{agentTypeLabel(agent.type)}</span>
	<span class="status">{status}</span>
</a>

<style>
	.agent {
		display: grid;
		grid-template-columns: 14px 1fr auto;
		column-gap: 7px;
		row-gap: 2px;
		align-items: center;
		padding: 5px 8px;
		border-radius: 8px;
		color: var(--text);
		text-decoration: none;
		--teal: #5eead4;
		--teal-deep: #155e63;
	}
	.agent:hover {
		background: var(--surface-2);
	}
	.agent.cur {
		background: #10292a;
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 14px;
		height: 14px;
		color: var(--teal);
	}
	.glyph svg {
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.desc {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: #d6d3d1;
	}
	.agent.cur .desc {
		color: #f5f5f4;
	}
	.type {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--teal);
		border: 1px solid var(--teal-deep);
		border-radius: 4px;
		padding: 0 5px;
		white-space: nowrap;
	}
	.status {
		grid-column: 2 / 4;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: #78716c;
		font-variant-numeric: tabular-nums;
	}
	/* Finished: it steps back until it folds into the parent's count. */
	.agent.done {
		opacity: 0.55;
	}
	.agent.done .glyph,
	.agent.done .type {
		color: var(--muted);
	}
	.agent.done .type {
		border-color: #44403c;
	}
	.agent.failed .glyph,
	.agent.failed .status {
		color: #f87171;
	}
	@media (pointer: coarse) {
		.agent {
			min-height: 44px;
			box-sizing: border-box;
		}
	}
</style>
