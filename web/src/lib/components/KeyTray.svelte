<script lang="ts">
	/**
	 * The keys that drive the pane, in a well cut into the composer.
	 *
	 * One grid, one unit: every key is 42×30 or a whole-number span of it, so
	 * nothing is sized by its own label. The arrow cluster keeps the two cells
	 * beside Up empty — that gap is what makes an inverted T read as arrows in
	 * peripheral vision, and filling it is what made the old 4×2 block
	 * unreadable.
	 *
	 * Words for named keys, glyphs for direction. Chords use tmux's own `C-x`
	 * notation, because that is the vocabulary this app already speaks.
	 */
	interface Props {
		open: boolean;
		ctrlCount: number;
		altCount: number;
		/** Wide enough for the chords column beside the cluster. */
		wide?: boolean;
		onKeys: (keys: string) => void;
		onCycleCtrl: () => void;
		onCycleAlt: () => void;
		/** Put the draft in the prompt without submitting it. */
		onPutInPrompt: () => void;
		/** Take Claude Code's own suggestion: Tab, then Enter. */
		onAcceptSuggestion: () => void;
		/** Wipe whatever sits in the pane's prompt box. */
		onClearPrompt: () => void;
	}

	let {
		open,
		ctrlCount,
		altCount,
		wide = false,
		onKeys,
		onCycleCtrl,
		onCycleAlt,
		onPutInPrompt,
		onAcceptSuggestion,
		onClearPrompt
	}: Props = $props();

	const armed = $derived(ctrlCount > 0 || altCount > 0);

	/** Hold an arrow to repeat it, the way a real key repeats. */
	const REPEAT_DELAY = 400;
	const REPEAT_EVERY = 60;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let repeatTimer: ReturnType<typeof setInterval> | null = null;

	function startRepeat(keys: string) {
		stopRepeat();
		holdTimer = setTimeout(() => {
			repeatTimer = setInterval(() => onKeys(keys), REPEAT_EVERY);
		}, REPEAT_DELAY);
	}

	function stopRepeat() {
		if (holdTimer) clearTimeout(holdTimer);
		if (repeatTimer) clearInterval(repeatTimer);
		holdTimer = null;
		repeatTimer = null;
	}

	const CHORDS = ['C-c', 'C-l', 'C-r', 'C-u', 'C-w'];

	/** The rest of what the More popover used to hide, so nothing is lost with it. */
	const EXTRAS: { label: string; keys: string }[] = [
		{ label: 'bksp', keys: 'BSpace' },
		{ label: 'space', keys: 'Space' },
		{ label: 'y', keys: 'y' },
		{ label: '⇧tab', keys: 'BTab' }
	];
</script>

{#if open}
	<div class="tray" class:armed>
		<div class="keys">
			<button
				type="button"
				class="k"
				class:on={ctrlCount > 0}
				onclick={onCycleCtrl}
				title="Arm Ctrl — the next Enter sends your line as a Ctrl sequence"
			>
				ctrl
			</button>
			<button
				type="button"
				class="k"
				class:on={altCount > 0}
				onclick={onCycleAlt}
				title="Arm Alt — the next Enter sends your line as a Meta sequence"
			>
				alt
			</button>
			<button type="button" class="k" onclick={() => onKeys('Escape')}>esc</button>
			<button type="button" class="k" onclick={() => onKeys('Tab')}>tab</button>
			<button type="button" class="k k-pgup" onclick={() => onKeys('PageUp')}>pgup</button>
			<button type="button" class="k k-pgdn" onclick={() => onKeys('PageDown')}>pgdn</button>

			<button
				type="button"
				class="k k-up"
				aria-label="Up"
				onclick={() => onKeys('Up')}
				onpointerdown={() => startRepeat('Up')}
				onpointerup={stopRepeat}
				onpointerleave={stopRepeat}
			>
				<iconify-icon icon="mdi:arrow-up"></iconify-icon>
			</button>
			<button
				type="button"
				class="k k-left"
				aria-label="Left"
				onclick={() => onKeys('Left')}
				onpointerdown={() => startRepeat('Left')}
				onpointerup={stopRepeat}
				onpointerleave={stopRepeat}
			>
				<iconify-icon icon="mdi:arrow-left"></iconify-icon>
			</button>
			<button
				type="button"
				class="k k-down"
				aria-label="Down"
				onclick={() => onKeys('Down')}
				onpointerdown={() => startRepeat('Down')}
				onpointerup={stopRepeat}
				onpointerleave={stopRepeat}
			>
				<iconify-icon icon="mdi:arrow-down"></iconify-icon>
			</button>
			<button
				type="button"
				class="k k-right"
				aria-label="Right"
				onclick={() => onKeys('Right')}
				onpointerdown={() => startRepeat('Right')}
				onpointerup={stopRepeat}
				onpointerleave={stopRepeat}
			>
				<iconify-icon icon="mdi:arrow-right"></iconify-icon>
			</button>

			<button type="button" class="k wide k-a" onclick={onPutInPrompt}>
				<iconify-icon icon="mdi:tray-arrow-up"></iconify-icon>Put in prompt
			</button>
			<button type="button" class="k wide k-b" onclick={onAcceptSuggestion}>
				<iconify-icon icon="mdi:star-four-points-outline"></iconify-icon>Accept suggestion
			</button>
			<button type="button" class="k k-ent" aria-label="Enter" onclick={() => onKeys('Enter')}>
				<iconify-icon icon="mdi:keyboard-return"></iconify-icon>
			</button>
		</div>

		<div class="side">
			<div class="extras">
				{#each EXTRAS as extra (extra.label)}
					<button type="button" class="k" onclick={() => onKeys(extra.keys)}>{extra.label}</button>
				{/each}
				<button type="button" class="k" onclick={onClearPrompt}>clear</button>
			</div>

			{#if wide}
			<div class="chords">
				<span class="cap">chords</span>
				<div class="crow">
					{#each CHORDS as chord (chord)}
						<button type="button" class="k" onclick={() => onKeys(chord)}>{chord}</button>
					{/each}
				</div>
				<span class="cap cap-gap">jump</span>
				<div class="crow">
					<button type="button" class="k" onclick={() => onKeys('Home')}>home</button>
					<button type="button" class="k" onclick={() => onKeys('End')}>end</button>
				</div>
			</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* A well cut into the card: darker than it, not lighter, so the keys are
	   the only lit things in it. */
	.tray {
		position: relative;
		background: #08080a;
		border-radius: 15px 15px 0 0;
		border-bottom: 1px solid #202023;
		box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.6);
		padding: 12px 10px;
		display: flex;
		flex-wrap: wrap;
		gap: 12px 14px;
		align-items: flex-start;
	}
	/* An armed modifier lights the well's lower edge, beside the status line
	   that names it — so a tray you glance past still shows it is armed. */
	.tray.armed::after {
		content: '';
		position: absolute;
		left: 14px;
		right: 14px;
		bottom: -1px;
		height: 1px;
		background: linear-gradient(90deg, transparent, #fbbf24, transparent);
		opacity: 0.65;
	}

	.keys {
		display: grid;
		grid-template-columns: repeat(8, 42px);
		grid-auto-rows: 30px;
		gap: 4px;
		flex: none;
	}

	.tray .k {
		border: 0;
		border-radius: 6px;
		background: #212124;
		color: #a8a29e;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.02em;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 0 8px;
		width: 100%;
		height: 100%;
		min-width: 0;
		cursor: pointer;
		touch-action: manipulation;
		transition:
			background 0.1s,
			color 0.1s;
	}
	.tray .k :global(iconify-icon) {
		font-size: 15px;
	}
	.tray .k:hover {
		background: #2c2c31;
		color: #f5f5f4;
	}
	.tray .k.on {
		background: #3a2d0d;
		color: #fbbf24;
	}
	.tray .k.wide {
		justify-content: flex-start;
	}

	.k-pgup {
		grid-area: 1 / 5 / 2 / 7;
	}
	.k-pgdn {
		grid-area: 1 / 7 / 2 / 9;
	}
	/* the cluster's empty shoulders are deliberate — see the note above */
	.k-up {
		grid-area: 2 / 2;
	}
	.k-left {
		grid-area: 3 / 1;
	}
	.k-down {
		grid-area: 3 / 2;
	}
	.k-right {
		grid-area: 3 / 3;
	}
	.k-a {
		grid-area: 2 / 4 / 3 / 8;
	}
	.k-b {
		grid-area: 3 / 4 / 4 / 8;
	}
	/* Enter is marked by being twice as tall, the way a keyboard marks it —
	   filling it would give the composer a second green thing. */
	.k-ent {
		grid-area: 2 / 8 / 4 / 9;
		background: #2c2c31;
		font-size: 16px;
	}
	.tray .k-ent:hover {
		background: #37373d;
	}

	/* Width goes to the keys the More popover used to hide, not to stretching
	   the cluster — a wider arrow key is not a better arrow key. */
	.side {
		flex: 1;
		/* Narrower than this and it wraps below the cluster instead of
		   collapsing into a sliver beside it. */
		min-width: 220px;
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	/* The rest of the old More popover, kept visible rather than nested. */
	.extras {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.extras .k {
		width: auto;
		height: 30px;
		min-width: 44px;
	}
	.chords {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding-top: 3px;
		border-top: 1px solid #1b1b1f;
	}
	.cap {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #44403c;
	}
	.cap-gap {
		padding-top: 6px;
	}
	.crow {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.chords .k {
		width: auto;
		height: 30px;
		min-width: 44px;
	}
</style>
