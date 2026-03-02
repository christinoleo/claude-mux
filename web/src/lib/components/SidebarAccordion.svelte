<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { Snippet } from 'svelte';

	interface Props {
		icon: string;
		title: string;
		count?: number | null;
		defaultExpanded?: boolean;
		lazy?: boolean;
		onExpandChange?: (expanded: boolean) => void;
		children: Snippet;
	}

	let {
		icon,
		title,
		count = null,
		defaultExpanded = false,
		lazy = false,
		onExpandChange,
		children
	}: Props = $props();

	let expanded = $state(defaultExpanded ?? false);
	let hasBeenExpanded = $state(defaultExpanded ?? false);

	function toggle() {
		expanded = !expanded;
		if (expanded && !hasBeenExpanded) {
			hasBeenExpanded = true;
		}
		onExpandChange?.(expanded);
	}

	const shouldRender = $derived(lazy ? hasBeenExpanded : true);
</script>

<div class="accordion" class:expanded>
	<button class="accordion-header" onclick={toggle} type="button">
		<iconify-icon {icon} class="header-icon"></iconify-icon>
		<span class="accordion-title">{title}</span>
		{#if count != null}
			<span class="count">{count}</span>
		{/if}
		<iconify-icon
			icon={expanded ? 'mdi:chevron-down' : 'mdi:chevron-right'}
			class="chevron"
		></iconify-icon>
	</button>

	{#if expanded && shouldRender}
		<div class="accordion-content">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.accordion {
		border-top: 1px solid hsl(var(--border) / 0.5);
	}

	.accordion-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 5px 10px;
		border: none;
		background: hsl(var(--muted) / 0.3);
		color: hsl(var(--muted-foreground));
		font-family: inherit;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		text-align: left;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.accordion-header:hover {
		background: hsl(var(--muted) / 0.6);
		color: hsl(var(--foreground));
	}

	.accordion.expanded .accordion-header {
		color: hsl(var(--foreground));
	}

	.header-icon {
		font-size: 13px;
		opacity: 0.7;
	}

	.count {
		margin-left: auto;
		font-size: 10px;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
		min-width: 14px;
		text-align: center;
	}

	.accordion-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chevron {
		font-size: 14px;
		opacity: 0.5;
	}

	.accordion-content {
		padding: 6px 10px 8px 14px;
		border-left: 2px solid hsl(var(--border) / 0.3);
		margin-left: 10px;
	}
</style>
