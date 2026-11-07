<script lang="ts">
	/**
	 * The session's terminal, drawn where a dialog card would be.
	 *
	 * The hooks said the session waits on a person, but no reader could make a
	 * card of what the pane shows. Rather than leave the person with nothing to
	 * press, the Transcript draws the foot of the screen as it is and the keys a
	 * dialog takes. The server keeps the screen that beat the readers
	 * (`src/server/failed-reads.ts`), so the reader can be fixed.
	 */
	import TerminalView from '$lib/components/TerminalView.svelte';
	import { stripAnsi } from '$lib/terminal/ansi';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	let {
		screen,
		onKeys,
		onText,
		onClose = null
	}: {
		/** The pane's visible rows (ANSI), as the terminal stream sends them. */
		screen: string[];
		onKeys: (keys: string) => Promise<void> | void;
		onText: (text: string) => Promise<void> | void;
		/** Puts the terminal away again, when a person opened it over a card. */
		onClose?: (() => void) | null;
	} = $props();

	/** Enough rows for any dialog Claude Code draws, few enough to fit a phone. */
	const ROWS = 30;

	const shown = $derived.by(() => {
		let end = screen.length;
		while (end > 0 && !stripAnsi(screen[end - 1]).trim()) end--;
		return screen.slice(Math.max(0, end - ROWS), end);
	});

	let draft = $state('');
	let sending = $state(false);

	async function press(keys: string) {
		if (sending) return;
		sending = true;
		try {
			await onKeys(keys);
		} finally {
			sending = false;
		}
	}

	async function submit() {
		const text = draft;
		if (!text.trim() || sending) return;
		sending = true;
		try {
			await onText(text);
			await onKeys('Enter');
			draft = '';
		} finally {
			sending = false;
		}
	}

	let screenEl = $state<HTMLDivElement | null>(null);
	// The dialog sits at the foot; a narrow screen scrolls sideways for the rest.
	$effect(() => {
		shown;
		if (screenEl) screenEl.scrollTop = screenEl.scrollHeight;
	});
</script>

<section class="pane-card" aria-label="Terminal">
	<div class="title">
		<iconify-icon icon="mdi:console"></iconify-icon>
		<span>Answer in the terminal</span>
		{#if onClose}
			<Button variant="ghost" size="sm" class="close" onclick={onClose}>Hide</Button>
		{/if}
	</div>
	{#if onClose === null}
		<p class="lead">This dialog could not be read into a card. Here is the terminal as it stands.</p>
	{/if}

	{#if shown.length}
		<div class="screen" bind:this={screenEl}>
			<TerminalView history={[]} historyStart={0} screen={shown} wrap={false} />
		</div>
	{:else}
		<p class="muted">Connecting to the terminal…</p>
	{/if}

	<div class="keys" role="group" aria-label="Keys">
		<Button variant="secondary" size="sm" class="k-up" aria-label="Up" disabled={sending} onclick={() => void press('Up')}>
			<iconify-icon icon="mdi:arrow-up"></iconify-icon>
		</Button>
		<Button variant="secondary" size="sm" class="k-left" aria-label="Left" disabled={sending} onclick={() => void press('Left')}>
			<iconify-icon icon="mdi:arrow-left"></iconify-icon>
		</Button>
		<Button variant="secondary" size="sm" class="k-down" aria-label="Down" disabled={sending} onclick={() => void press('Down')}>
			<iconify-icon icon="mdi:arrow-down"></iconify-icon>
		</Button>
		<Button variant="secondary" size="sm" class="k-right" aria-label="Right" disabled={sending} onclick={() => void press('Right')}>
			<iconify-icon icon="mdi:arrow-right"></iconify-icon>
		</Button>
		<Button variant="warning" size="sm" class="k-enter" disabled={sending} onclick={() => void press('Enter')}>
			<iconify-icon icon="mdi:keyboard-return"></iconify-icon>Enter
		</Button>
		<Button variant="ghost" size="sm" class="k-esc" disabled={sending} onclick={() => void press('Escape')}>Esc</Button>
	</div>

	<form
		class="text-row"
		onsubmit={(e) => {
			e.preventDefault();
			void submit();
		}}
	>
		<Input bind:value={draft} placeholder="Type into the terminal" aria-label="Text for the terminal" autocomplete="off" />
		<Button type="submit" variant="warning" size="sm" disabled={sending || !draft.trim()}>
			<iconify-icon icon="mdi:send"></iconify-icon>Send
		</Button>
	</form>
</section>

<style>
	/* Amber like the other dialog cards: the session waits on a person. */
	.pane-card {
		margin: 14px 0 14px 12px;
		border: 1px solid #5c4410;
		border-left: 3px solid #fbbf24;
		border-radius: 8px;
		background: #1a1610;
		padding: 10px 12px 12px;
		min-width: 0;
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
	.title :global(.close) {
		margin-left: auto;
		text-transform: none;
		letter-spacing: normal;
	}
	.lead {
		margin: 0 0 8px;
		color: #f5f0ee;
	}
	.muted {
		margin: 0 0 8px;
		color: #a8a29e;
	}
	.screen {
		margin: 0 0 10px;
		padding: 8px;
		max-height: 60vh;
		overflow: auto;
		background: #000;
		color: #fff;
		border-radius: 6px;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 11px;
		line-height: 1.35;
		/* The scroll belongs to the screen, not the transcript behind it. */
		touch-action: pan-x pan-y;
		overscroll-behavior: contain;
	}
	.keys {
		display: grid;
		grid-template-columns: repeat(3, 44px) 1fr auto;
		grid-template-areas:
			'. up . enter esc'
			'left down right enter esc';
		gap: 6px;
		margin-bottom: 10px;
	}
	.keys :global(.k-up) {
		grid-area: up;
	}
	.keys :global(.k-left) {
		grid-area: left;
	}
	.keys :global(.k-down) {
		grid-area: down;
	}
	.keys :global(.k-right) {
		grid-area: right;
	}
	.keys :global(.k-enter) {
		grid-area: enter;
		height: auto;
	}
	.keys :global(.k-esc) {
		grid-area: esc;
		height: auto;
	}
	.text-row {
		display: flex;
		gap: 6px;
	}
	.text-row :global(input) {
		min-width: 0;
		flex: 1;
	}
</style>
