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
		/** Resolves false when the pane refused the text, so no Enter follows it. */
		onText: (text: string) => Promise<boolean | void> | boolean | void;
		/** Puts the terminal away again, when a person opened it over a card. */
		onClose?: (() => void) | null;
	} = $props();

	/** Enough rows for the tallest question Claude Code draws; the box scrolls on a phone. */
	const ROWS = 60;

	const shown = $derived.by(() => {
		let end = screen.length;
		while (end > 0 && !stripAnsi(screen[end - 1]).trim()) end--;
		return screen.slice(Math.max(0, end - ROWS), end);
	});

	let draft = $state('');
	let sending = $state(false);
	let note = $state<string | null>(null);

	/** The dialog's keys, laid out as an inverted T beside Enter and Esc. */
	const KEYS: { keys: string; area: string; variant: 'secondary' | 'warning' | 'ghost'; icon?: string; label?: string }[] = [
		{ keys: 'Up', area: 'up', variant: 'secondary', icon: 'mdi:arrow-up' },
		{ keys: 'Left', area: 'left', variant: 'secondary', icon: 'mdi:arrow-left' },
		{ keys: 'Down', area: 'down', variant: 'secondary', icon: 'mdi:arrow-down' },
		{ keys: 'Right', area: 'right', variant: 'secondary', icon: 'mdi:arrow-right' },
		{ keys: 'Enter', area: 'enter', variant: 'warning', icon: 'mdi:keyboard-return', label: 'Enter' },
		{ keys: 'Escape', area: 'esc', variant: 'ghost', label: 'Esc' }
	];

	/** One send at a time, so a double tap cannot answer twice. */
	async function busy(fn: () => Promise<void> | void) {
		if (sending) return;
		sending = true;
		try {
			await fn();
		} finally {
			sending = false;
		}
	}

	const press = (keys: string) => busy(() => onKeys(keys));

	function submit() {
		const text = draft;
		if (!text.trim()) return;
		return busy(async () => {
			note = null;
			// Enter after refused text would pick whatever row is highlighted.
			if ((await onText(text)) === false) {
				note = 'The terminal did not take that text. Nothing was sent.';
				return;
			}
			await onKeys('Enter');
			draft = '';
		});
	}

	let screenEl = $state<HTMLDivElement | null>(null);
	// The dialog sits at the foot; a narrow screen scrolls sideways for the rest.
	// It follows the foot only while the reader is there, not while they read above it.
	let following = true;
	$effect(() => {
		shown;
		if (screenEl && following) screenEl.scrollTop = screenEl.scrollHeight;
	});
	function onScreenScroll() {
		if (screenEl) following = screenEl.scrollHeight - screenEl.scrollTop - screenEl.clientHeight < 24;
	}
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
		<div class="screen" bind:this={screenEl} onscroll={onScreenScroll}>
			<TerminalView history={[]} historyStart={0} screen={shown} wrap={false} />
		</div>
	{:else}
		<p class="muted">Connecting to the terminal…</p>
	{/if}

	<div class="keys" role="group" aria-label="Keys">
		{#each KEYS as k (k.keys)}
			<Button
				variant={k.variant}
				size="sm"
				class={k.label ? 'tall' : ''}
				style="grid-area: {k.area}"
				aria-label={k.label ?? k.keys}
				disabled={sending}
				onclick={() => void press(k.keys)}
			>
				{#if k.icon}<iconify-icon icon={k.icon}></iconify-icon>{/if}{k.label ?? ''}
			</Button>
		{/each}
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
	{#if note}<p class="muted">{note}</p>{/if}
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
		border-radius: 6px;
		/* The scroll belongs to the screen, not the transcript behind it. */
		touch-action: pan-x pan-y;
		overscroll-behavior: contain;
	}
	.screen :global(.terminal-view) {
		font-size: 11px;
		line-height: 1.35;
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
	.keys :global(.tall) {
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
