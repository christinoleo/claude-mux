<script lang="ts">
	import { beadsStore, type BeadsFilter, type BeadsIssue } from '$lib/stores/beads.svelte';
	import { Button } from '$lib/components/ui/button';
	import SidebarAccordion from './SidebarAccordion.svelte';
	import EpicSection from './EpicSection.svelte';
	import IssueItem from './IssueItem.svelte';

	interface Props {
		project: string | null;
		onSelect?: (issue: BeadsIssue) => void;
	}

	let { project, onSelect }: Props = $props();

	let beadsLoaded = $state(false);

	function handleExpandChange(expanded: boolean) {
		beadsStore.setProject(expanded ? project : null);
		if (expanded) beadsLoaded = true;
	}

	function setFilter(filter: BeadsFilter) {
		beadsStore.setFilter(filter);
	}

	function handleIssueSelect(issue: BeadsIssue) {
		onSelect?.(issue);
	}

	const filters: { label: string; value: BeadsFilter }[] = [
		{ label: 'Active', value: 'active' },
		{ label: 'All', value: 'all' }
	];

	const hasEpics = $derived(beadsStore.epicGroups.length > 0);
	const hasOrphans = $derived(beadsStore.orphanTasks.length > 0);
	const isEmpty = $derived(!hasEpics && !hasOrphans);
</script>

<SidebarAccordion
	icon="mdi:checkbox-multiple-marked-outline"
	title="Issues"
	count={beadsLoaded ? beadsStore.issueCount : null}
	lazy
	onExpandChange={handleExpandChange}
>
	<div class="filter-buttons">
		{#each filters as f (f.value)}
			<Button
				variant={beadsStore.filter === f.value ? 'default' : 'ghost'}
				size="sm"
				onclick={() => setFilter(f.value)}
				class="filter-btn"
			>
				{f.label}
			</Button>
		{/each}
	</div>

	<div>
		{#if beadsStore.loading}
			<div class="loading">Loading issues...</div>
		{:else if beadsStore.error}
			<div class="error">{beadsStore.error}</div>
		{:else if isEmpty}
			<div class="empty">No issues</div>
		{:else}
			{#each beadsStore.epicGroups as group (group.epic.id)}
				<EpicSection {group} onSelect={handleIssueSelect} />
			{/each}

			{#if hasEpics && hasOrphans}
				<div class="section-label">Other tasks</div>
			{/if}

			{#each beadsStore.orphanTasks as issue (issue.id)}
				<IssueItem {issue} onSelect={handleIssueSelect} />
			{/each}
		{/if}
	</div>
</SidebarAccordion>

<style>
	.filter-buttons {
		display: flex;
		gap: 3px;
		margin-bottom: 4px;
	}

	.filter-buttons :global(.filter-btn) {
		flex: 1;
		height: 24px;
		font-size: 11px;
	}

	.section-label {
		font-size: 10px;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 6px 8px 2px;
	}

	.loading,
	.error,
	.empty {
		color: hsl(var(--muted-foreground));
		font-size: 11px;
		margin: 0;
	}

	.error {
		color: hsl(var(--destructive));
	}
</style>
