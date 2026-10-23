<script lang="ts">
	import type { RewindAction, RewindChoice, RewindScreen } from '$shared/tmux/rewind.js';
	import { Button } from '$lib/components/ui/button';

	let {
		screen,
		onRewind
	}: {
		/** The rewind dialog as the pane draws it right now. */
		screen: NonNullable<RewindScreen>;
		/** Works the dialog through the rewind route; resolves false when it failed (the page says why). */
		onRewind: (action: RewindAction) => Promise<boolean>;
	} = $props();

	let pending = $state<string | null>(null);
	let card = $state<HTMLElement | null>(null);

	async function run(key: string, action: RewindAction) {
		if (pending) return;
		pending = key;
		try {
			await onRewind(action);
		} finally {
			pending = null;
		}
	}

	// Opened from a prompt far up the transcript, the card is at its foot.
	$effect(() => {
		card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});

	/** The choices that restore, which are what a rewind is for; the summaries come after. */
	const restores = $derived(
		screen.step === 'confirm' ? screen.options.filter((o) => o.label.startsWith('Restore')) : []
	);
	const summaries = $derived(
		screen.step === 'confirm' ? screen.options.filter((o) => o.label.startsWith('Summarize')) : []
	);
</script>

<section class="rewind-card" aria-label="Rewind" bind:this={card}>
	<header class="title">
		<iconify-icon icon="mdi:history"></iconify-icon>
		<span>Rewind</span>
	</header>

	{#if screen.step === 'list'}
		<p class="lead">Go back to before which prompt?</p>
		<div class="rows">
			{#if screen.above > 0}<p class="muted">{screen.above} earlier, use Rewind on a prompt above</p>{/if}
			{#each screen.rows.filter((r) => !r.current) as row (row.text)}
				<button
					type="button"
					class="row"
					class:selected={row.selected}
					disabled={pending !== null}
					onclick={() => void run(row.text, { action: 'open', prompt: row.text, back: null })}
				>
					<span class="row-text">{row.text}</span>
					{#if row.files}<span class="row-files">{row.files}</span>{/if}
				</button>
			{/each}
		</div>
	{:else}
		<p class="lead">Go back to before this prompt{screen.ago ? `, sent ${screen.ago}` : ''}:</p>
		<blockquote>{screen.prompt}</blockquote>
		{#if screen.effects.length > 0}
			<ul class="effects">
				{#each screen.effects as effect (effect)}<li>{effect}</li>{/each}
			</ul>
		{/if}
		<div class="choices">
			{#each restores as option (option.n)}
				<Button
					variant={option.n === restores[0]?.n ? 'warning' : 'outline'}
					size="sm"
					disabled={pending !== null}
					onclick={() => void run(option.label, { action: 'choose', choice: option.label as RewindChoice })}
				>
					{pending === option.label ? 'Rewinding…' : option.label}
				</Button>
			{/each}
		</div>
		{#if summaries.length > 0}
			<div class="choices">
				{#each summaries as option (option.n)}
					<Button
						variant="ghost"
						size="sm"
						disabled={pending !== null}
						onclick={() => void run(option.label, { action: 'choose', choice: option.label as RewindChoice })}
					>
						<iconify-icon icon="mdi:text-box-outline"></iconify-icon>{option.label}
					</Button>
				{/each}
			</div>
		{/if}
		<p class="muted">Files changed through Bash or by hand stay as they are.</p>
	{/if}
	<div class="foot">
		<Button variant="ghost" size="sm" disabled={pending !== null} onclick={() => void run('cancel', { action: 'cancel' })}>
			Cancel
		</Button>
	</div>
</section>

<style>
	/* Amber like a dialog: the pane waits on a person until it is answered. */
	.rewind-card {
		margin: 14px 0 14px 12px;
		border: 1px solid #5c4410;
		border-left: 3px solid #fbbf24;
		border-radius: 8px;
		background: #1a1610;
		padding: 10px 12px 12px;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 8px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #fbbf24;
	}
	.lead {
		margin: 0 0 8px;
		color: #f5f0ee;
	}
	blockquote {
		margin: 0 0 8px;
		padding: 4px 0 4px 10px;
		border-left: 2px solid #5c4410;
		color: #e7e5e4;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.effects {
		margin: 0 0 10px;
		padding-left: 18px;
		color: #d6d3d1;
		font-size: 12.5px;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		width: 100%;
		padding: 6px 8px;
		border: 1px solid #3a2f17;
		border-radius: 6px;
		background: transparent;
		color: #f5f0ee;
		text-align: left;
		cursor: pointer;
	}
	.row:hover:not(:disabled),
	.row:focus-visible {
		border-color: #fbbf24;
	}
	.row.selected {
		border-color: #8a6a1c;
	}
	.row-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row-files {
		flex: none;
		color: #a8a29e;
		font-size: 12px;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 6px;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 6px;
	}
	.muted {
		margin: 8px 0 0;
		color: #a8a29e;
		font-size: 12.5px;
	}
</style>
