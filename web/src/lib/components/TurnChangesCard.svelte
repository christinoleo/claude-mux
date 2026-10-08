<script lang="ts">
	/**
	 * What one turn changed, drawn where the turn ends in the transcript. Closed,
	 * it is one quiet line ("Changed 3 files +42 −10"); open, a card with the
	 * turn's files and their counts. A file, or "View diff", opens the side
	 * panel's Changes pane on this turn.
	 */
	import { Button } from '$lib/components/ui/button';
	import { displayPath, statusLetter, sumCounts, type Turn } from '$lib/side-panel/changes';

	let {
		turn,
		root,
		open = $bindable(false),
		link
	}: {
		turn: Turn;
		/** Paths under it are shown relative to it. */
		root: string | null;
		open?: boolean;
		/** Where the Changes pane opens on this turn, at `file` or its first file. */
		link: (file: string | null) => string;
	} = $props();

	const totals = $derived(sumCounts(turn.files));
	const count = $derived(`${turn.files.length} ${turn.files.length === 1 ? 'file' : 'files'}`);
</script>

{#if open}
	<section class="card" aria-label="Files changed in this turn">
		<header>
			<span class="label">
				CHANGED FILES ({turn.files.length}) · <span class="add">+{totals.additions}</span>
				<span class="del">−{totals.deletions}</span>
			</span>
			<span class="grow"></span>
			<Button variant="ghost" size="sm" class="h-[30px] border border-[#2f2a27] px-2.5 text-xs" onclick={() => (open = false)}>
				Collapse
			</Button>
			<Button
				variant="secondary"
				size="sm"
				class="h-[30px] border border-[#3f3a36] px-2.5 text-xs"
				href={link(null)}
				data-sveltekit-noscroll
				data-sveltekit-keepfocus
			>
				View diff
			</Button>
		</header>
		<ul>
			{#each turn.files as f (f.file)}
				{@const letter = statusLetter(f)}
				<li>
					<a href={link(f.file)} title={f.file} data-sveltekit-noscroll data-sveltekit-keepfocus>
						<span class="st" class:new={letter === 'A'} class:gone={letter === 'D'}>{letter}</span>
						<span class="path"><bdi>{displayPath(f.file, root)}</bdi></span>
						{#if f.additions}<span class="add">+{f.additions}</span>{/if}
						{#if f.deletions}<span class="del">−{f.deletions}</span>{/if}
					</a>
				</li>
			{/each}
		</ul>
	</section>
{:else}
	<button type="button" class="line" onclick={() => (open = true)} aria-expanded="false">
		<iconify-icon icon="mdi:chevron-right"></iconify-icon>
		<span>Changed {count}</span>
		<span class="nums"><span class="add">+{totals.additions}</span> <span class="del">−{totals.deletions}</span></span>
	</button>
{/if}

<style>
	.card {
		margin: 8px 0 10px 12px;
		border: 1px solid #262220;
		border-radius: 10px;
		background: #141210;
	}
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px 8px 14px;
	}
	.label {
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.12em;
		color: #a8a29e;
		white-space: nowrap;
	}
	.grow {
		flex: 1;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 6px;
		border-top: 1px solid #221e1c;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	li a {
		display: flex;
		gap: 10px;
		padding: 6px 10px;
		border-radius: 6px;
		color: #d6d3d1;
		text-decoration: none;
	}
	li a:hover {
		background: #1f1c1a;
		color: #fff;
	}
	.st {
		width: 1ch;
		color: #fbbf24;
	}
	.st.new {
		color: #4ade80;
	}
	.st.gone {
		color: #f87171;
	}
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		/* Cut from the left, so the file name stays in view. */
		direction: rtl;
		text-align: left;
	}
	.add {
		color: #4ade80;
	}
	.del {
		color: #f87171;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 6px 0 8px 12px;
		padding: 6px 12px 6px 8px;
		border: 1px solid #1f1c1a;
		border-radius: 8px;
		background: transparent;
		color: #a8a29e;
		font-size: 13px;
		cursor: pointer;
	}
	.line:hover {
		border-color: #2f2a27;
		color: #d6d3d1;
	}
	.line iconify-icon {
		color: #78716c;
		font-size: 15px;
	}
	.nums {
		font-family: var(--font-mono);
		font-size: 12px;
	}
</style>
