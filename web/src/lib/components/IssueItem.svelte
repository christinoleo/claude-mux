<script lang="ts">
	import type { BeadsIssue, ResolvedDep } from '$lib/stores/beads.svelte';
	import { statusColor, priorityColor } from '$shared/types/beads.js';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		issue: BeadsIssue;
		onSelect?: (issue: BeadsIssue) => void;
		nested?: boolean;
	}

	let { issue, onSelect, nested = false }: Props = $props();

	let expanded = $state(false);
	let descDialogOpen = $state(false);

	function formatStatus(status: BeadsIssue['status']): string {
		return status.replace('_', ' ');
	}

	function toggleExpanded() {
		expanded = !expanded;
	}

	function handleUseId(e: Event) {
		e.stopPropagation();
		onSelect?.(issue);
	}

	/** Check if a need is still active (not closed) */
	function isActiveNeed(dep: ResolvedDep): boolean {
		return dep.status !== 'closed';
	}

	/** Get status hint for a need */
	function needStatusHint(dep: ResolvedDep): string {
		if (dep.status === 'closed') return '← done';
		if (dep.status === 'in_progress') return '← in progress';
		return '← open';
	}

	const activeNeeds = $derived(issue.needs.filter(isActiveNeed));
	const hasActiveNeeds = $derived(activeNeeds.length > 0);

	// Dep summary for collapsed row line 2
	const depSummary = $derived.by(() => {
		if (hasActiveNeeds) {
			const first = activeNeeds[0];
			const truncated =
				first.title.length > 30 ? first.title.slice(0, 30) + '…' : first.title;
			return { text: `blocked · needs: ${truncated}`, type: 'blocked' as const };
		}
		if (issue.unblocks.length > 0) {
			return { text: `unblocks ${issue.unblocks.length}`, type: 'muted' as const };
		}
		return null;
	});
</script>

<div class="issue-wrapper" class:expanded class:nested>
	<button class="issue-item" onclick={toggleExpanded} type="button">
		<span
			class="status-dot"
			class:dependency={issue.epic_relation === 'dependency'}
			style={issue.epic_relation === 'dependency'
				? `border-color: ${statusColor(issue.status)}`
				: `background: ${statusColor(issue.status)}`}
		></span>
		<div class="issue-main">
			<div class="issue-title-row">
				<span class="issue-title">{issue.title}</span>
				<span class="priority-badge" style="background: {priorityColor(issue.priority)}"
					>P{issue.priority}</span
				>
				<iconify-icon
					icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'}
					class="chevron"
				></iconify-icon>
			</div>
			{#if depSummary}
				<div class="dep-summary" class:dep-blocked={depSummary.type === 'blocked'}>
					{depSummary.text}
				</div>
			{/if}
		</div>
	</button>

	{#if expanded}
		<div class="issue-details">
			<div class="full-title">{issue.title}</div>

			{#if issue.description}
				<button
				class="description"
				type="button"
				onclick={(e) => { e.stopPropagation(); descDialogOpen = true; }}
				title="Click to read full description"
			>{issue.description}</button>
			{/if}

			<div class="detail-row">
				<span class="detail-label">Status</span>
				<span class="detail-value status-value" style="color: {statusColor(issue.status)}"
					>{formatStatus(issue.status)}</span
				>
			</div>
			<div class="detail-row">
				<span class="detail-label">Type</span>
				<span class="detail-value">{issue.issue_type}</span>
			</div>
			{#if issue.assignee}
				<div class="detail-row">
					<span class="detail-label">Assignee</span>
					<span class="detail-value">{issue.assignee}</span>
				</div>
			{/if}
			{#if issue.owner}
				<div class="detail-row">
					<span class="detail-label">Owner</span>
					<span class="detail-value">{issue.owner}</span>
				</div>
			{/if}

			{#if issue.needs.length > 0}
				<div class="dep-section">
					<div class="dep-section-label">Needs</div>
					{#each issue.needs as dep (dep.id)}
						<div class="dep-item">
							<span class="dep-dot" style="background: {statusColor(dep.status)}"></span>
							<span class="dep-title">{dep.title}</span>
							<span class="dep-hint">{needStatusHint(dep)}</span>
						</div>
					{/each}
				</div>
			{/if}

			{#if issue.unblocks.length > 0}
				<div class="dep-section">
					<div class="dep-section-label">Unblocks</div>
					{#each issue.unblocks as dep (dep.id)}
						<div class="dep-item">
							<span class="dep-dot" style="background: {statusColor(dep.status)}"></span>
							<span class="dep-title"
								>{dep.title}{#if dep.type === 'epic'} (epic){/if}</span
							>
						</div>
					{/each}
				</div>
			{/if}

			<div class="detail-row">
				<span class="detail-label">ID</span>
				<span class="detail-value id-value">{issue.id}</span>
			</div>

			<Button variant="outline" size="sm" onclick={handleUseId} class="use-id-btn">
				<iconify-icon icon="mdi:arrow-right-circle"></iconify-icon>
				Use ID
			</Button>
		</div>
	{/if}
</div>


{#if issue.description}
	<Dialog.Root bind:open={descDialogOpen}>
		<Dialog.Content class="max-w-lg max-h-[70vh] flex flex-col gap-0 p-0">
			<Dialog.Header class="px-4 pt-4 pb-3 border-b border-border shrink-0">
				<Dialog.Title class="text-sm font-semibold leading-tight">{issue.title}</Dialog.Title>
			</Dialog.Header>
			<div class="desc-dialog-body">
				{issue.description}
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}

<style>
	.issue-wrapper {
		margin-bottom: 0;
	}

	.issue-wrapper.expanded {
		background: hsl(var(--accent) / 0.5);
	}

	.issue-wrapper.nested {
		padding-left: 4px;
	}

	.issue-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border: none;
		background: transparent;
		text-align: left;
		cursor: pointer;
		width: 100%;
		color: inherit;
		font-family: inherit;
	}

	.issue-item:hover {
		background: hsl(var(--accent));
	}

	.issue-item:active {
		background: hsl(var(--accent) / 0.8);
	}

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-dot.dependency {
		background: transparent;
		border: 2px solid;
		width: 7px;
		height: 7px;
		box-sizing: border-box;
	}

	.issue-main {
		flex: 1;
		min-width: 0;
	}

	.issue-title-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.issue-title {
		font-size: 12px;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.priority-badge {
		font-size: 9px;
		font-weight: 700;
		color: white;
		padding: 1px 4px;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.chevron {
		font-size: 13px;
		color: hsl(var(--muted-foreground));
		flex-shrink: 0;
	}

	.dep-summary {
		font-size: 10px;
		color: hsl(var(--muted-foreground));
		margin-top: 1px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dep-summary.dep-blocked {
		color: #e74c3c;
	}

	.issue-details {
		padding: 2px 8px 8px;
	}

	.full-title {
		font-size: 12px;
		font-weight: 600;
		margin-bottom: 4px;
		line-height: 1.3;
	}

	.description {
		font-size: 11px;
		color: hsl(var(--muted-foreground));
		margin-bottom: 6px;
		line-height: 1.4;
		white-space: pre-wrap;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		/* Make it a clickable button */
		border: none;
		background: transparent;
		padding: 0;
		text-align: left;
		font-family: inherit;
		cursor: pointer;
		width: 100%;
		border-radius: 3px;
		transition: color 0.1s;
	}

	.description:hover {
		color: hsl(var(--foreground));
	}

	/* Description dialog body */
	.desc-dialog-body {
		padding: 16px;
		font-size: 13px;
		line-height: 1.6;
		color: hsl(var(--foreground));
		white-space: pre-wrap;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 2px 0;
		font-size: 11px;
	}

	.detail-label {
		color: hsl(var(--muted-foreground));
	}

	.detail-value {
		font-weight: 500;
		text-align: right;
	}

	.status-value {
		text-transform: capitalize;
	}

	.id-value {
		font-family: monospace;
		font-size: 11px;
	}

	.dep-section {
		margin-top: 4px;
		margin-bottom: 2px;
	}

	.dep-section-label {
		font-size: 10px;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 2px;
	}

	.dep-item {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 2px 0;
		font-size: 11px;
	}

	.dep-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dep-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dep-hint {
		font-size: 10px;
		color: hsl(var(--muted-foreground));
		flex-shrink: 0;
	}

	.issue-details :global(.use-id-btn) {
		width: 100%;
		margin-top: 4px;
	}
</style>
