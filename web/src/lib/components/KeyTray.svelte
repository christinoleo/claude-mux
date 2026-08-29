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

	// Pointer capture can end without an up or a leave — and the tray itself is
	// removed by Ctrl+. or by leaving the session — so the timers need a
	// teardown that does not depend on the pointer reaching a handler.
	$effect(() => stopRepeat);

	/** The cluster, in the order a keyboard draws it. */
	const ARROWS: { keys: string; cls: string; icon: string; label: string }[] = [
		{ keys: 'Up', cls: 'k-up', icon: 'mdi:arrow-up', label: 'Up' },
		{ keys: 'Left', cls: 'k-left', icon: 'mdi:arrow-left', label: 'Left' },
		{ keys: 'Down', cls: 'k-down', icon: 'mdi:arrow-down', label: 'Down' },
		{ keys: 'Right', cls: 'k-right', icon: 'mdi:arrow-right', label: 'Right' }
	];

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
		<div class="tray-body">
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

				{#each ARROWS as arrow (arrow.keys)}
					<button
						type="button"
						class="k {arrow.cls}"
						aria-label={arrow.label}
						onclick={() => onKeys(arrow.keys)}
						onpointerdown={() => startRepeat(arrow.keys)}
						onpointerup={stopRepeat}
						onpointerleave={stopRepeat}
						onpointercancel={stopRepeat}
					>
						<iconify-icon icon={arrow.icon}></iconify-icon>
					</button>
				{/each}

				<button type="button" class="k wide k-a" onclick={onPutInPrompt}>
					<iconify-icon icon="mdi:tray-arrow-up"></iconify-icon>Put in prompt
				</button>
				<button type="button" class="k wide k-b" onclick={onAcceptSuggestion}>
					<iconify-icon icon="mdi:star-four-points-outline"></iconify-icon>Accept suggestion
				</button>
			</div>

			<div class="side">
				<div class="extras">
					{#each EXTRAS as extra (extra.label)}
						<button type="button" class="k" onclick={() => onKeys(extra.keys)}>{extra.label}</button>
					{/each}
					<button type="button" class="k" onclick={onClearPrompt}>clear</button>
				</div>

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
			</div>
		</div>

		<button type="button" class="k k-ent" aria-label="Enter" onclick={() => onKeys('Enter')}>
			<iconify-icon icon="mdi:keyboard-return"></iconify-icon>
		</button>
	</div>
{/if}

<style>
	/* A well cut into the card: darker than it, not lighter, so the keys are
	   the only lit things in it. */
	.tray {
		position: relative;
		/* The chords column answers to how wide the tray actually is. The
		   viewport is the wrong question: a resizable sidebar sits between the
		   window's edge and this card. */
		container-type: inline-size;
		background: #08080a;
		border-radius: 15px 15px 0 0;
		border-bottom: 1px solid #202023;
		box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.6);
		padding: 12px 10px;
		display: flex;
		gap: 12px;
		align-items: stretch;
	}
	/* Everything except Enter, which the tray keeps on its own right edge. */
	.tray-body {
		flex: 1;
		min-width: 0;
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

	/* The grid holds its 42px unit wherever there is room for it, and gives the
	   unit up rather than the layout on a phone too narrow for eight of them. */
	.keys {
		display: grid;
		grid-template-columns: repeat(8, minmax(0, 42px));
		grid-auto-rows: 30px;
		gap: 4px;
		flex: 1 1 300px;
		max-width: 364px;
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
		grid-area: 2 / 4 / 3 / 9;
	}
	.k-b {
		grid-area: 3 / 4 / 4 / 9;
	}
	/* Enter leaves the grid for the tray's own right edge, full height, in the
	   green the composer already uses for submitting — so a thumb reaching for
	   it aims at a corner rather than at one cell among forty, and finds the
	   same green in the same corner whether the tray is open or shut. */
	.tray .k-ent {
		flex: none;
		width: 54px;
		height: auto;
		align-self: stretch;
		border-radius: 12px;
		background: #15803d;
		color: #f0fdf4;
	}
	.tray .k-ent:hover {
		background: #16a34a;
		color: #f0fdf4;
	}
	.tray .k-ent :global(iconify-icon) {
		font-size: 22px;
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

	.chords {
		display: none;
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
	/* 364px of key grid, a 14px gap and the side column's 220px floor. */
	@container (min-width: 620px) {
		.chords {
			display: flex;
		}
	}

	.extras .k,
	.chords .k {
		width: auto;
		height: 30px;
		min-width: 44px;
	}
</style>
