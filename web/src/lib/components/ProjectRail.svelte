<script lang="ts" module>
	export interface RailTile {
		key: string;
		name: string;
		initials: string;
		hue: number;
		icon: string | null;
		/** Amber when a session there wants a person, green when one works or just finished. */
		badge: 'wants' | 'working' | null;
		/** Nothing running: drawn quieter. */
		quiet: boolean;
		/** Where it is held, for the tooltip. */
		where: string;
	}
</script>

<script lang="ts">
	import ProjectTile from './ProjectTile.svelte';
	import { sessionStateVisual } from '$shared/session-state.js';

	/**
	 * The drawer's rail: the ⚡ Active tile, then a tile per project in the
	 * order the person set. A tile is dragged to reorder the rail, with the
	 * mouse at once and on a touch screen after a long press, so a finger can
	 * still scroll the rail. The rail never reorders itself; `onmove` hands the
	 * drop to the page, which saves the order (`moveTile()`).
	 */
	let {
		tiles,
		selected,
		activeBadge,
		onselect,
		onmove
	}: {
		tiles: RailTile[];
		/** 'active', or the selected project's key. */
		selected: string;
		activeBadge: 'wants' | 'working' | null;
		onselect: (key: string) => void;
		/** `key` was dropped before `before`, or at the end when null. */
		onmove: (key: string, before: string | null) => void;
	} = $props();

	/** A badge takes the colour of the state it stands for (`src/session-state.ts`). */
	const BADGE_COLORS = { wants: sessionStateVisual('waiting').color, working: sessionStateVisual('busy').color };

	/** A finger has to hold this long before a tile lifts. */
	const HOLD_MS = 350;
	/** A press that moves this far first is a scroll (touch) or a drag (mouse). */
	const SLOP_PX = 6;

	let rail = $state<HTMLElement | null>(null);
	/** The tile in flight, and where it would land. */
	let dragging = $state<string | null>(null);
	let dropBefore = $state<string | null | undefined>(undefined);

	let press: { key: string; id: number; touch: boolean; x: number; y: number; timer: ReturnType<typeof setTimeout> | null } | null =
		null;
	/** Swallow the click that ends a drag. */
	let suppressClick = false;

	/** The tile after `key` on the rail, or null at the end. */
	function nextKey(key: string): string | null {
		return tiles[tiles.findIndex((t) => t.key === key) + 1]?.key ?? null;
	}

	function lift(key: string) {
		dragging = key;
		dropBefore = undefined;
		navigator.vibrate?.(10);
	}

	function onPointerDown(e: PointerEvent, key: string) {
		if (e.button !== 0) return;
		// A drag a finger ended fires no click, so the swallow must not outlive it.
		suppressClick = false;
		const touch = e.pointerType !== 'mouse';
		press = { key, id: e.pointerId, touch, x: e.clientX, y: e.clientY, timer: null };
		if (touch) {
			press.timer = setTimeout(() => {
				if (!press) return;
				press.timer = null;
				lift(press.key);
			}, HOLD_MS);
		}
	}

	/** Where a pointer at `y` would drop: before the tile under it, or after it when past its middle. */
	function targetAt(x: number, y: number): string | null | undefined {
		const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tile]');
		if (!el || !rail?.contains(el)) {
			// Below the last tile is the end of the rail.
			const last = rail?.querySelector<HTMLElement>('[data-tile]:last-of-type');
			return last && y > last.getBoundingClientRect().bottom ? null : undefined;
		}
		const key = el.dataset.tile!;
		const box = el.getBoundingClientRect();
		if (y < box.top + box.height / 2) return key;
		return nextKey(key);
	}

	function onPointerMove(e: PointerEvent) {
		if (!press || e.pointerId !== press.id) return;
		// The button came up somewhere this tile never heard of: that press is over.
		if (!press.touch && e.buttons === 0) {
			cancel();
			return;
		}
		const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX;
		if (!dragging) {
			if (!moved) return;
			if (press.touch) {
				// Moved before the hold: the finger is scrolling.
				if (press.timer) clearTimeout(press.timer);
				press = null;
				return;
			}
			lift(press.key);
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		}
		dropBefore = targetAt(e.clientX, e.clientY);
	}

	function onPointerUp(e: PointerEvent) {
		if (!press || e.pointerId !== press.id) return;
		if (press.timer) clearTimeout(press.timer);
		const key = dragging;
		const before = dropBefore;
		press = null;
		if (key) {
			suppressClick = true;
			dragging = null;
			dropBefore = undefined;
			if (before !== undefined && before !== key && nextKey(key) !== before) {
				onmove(key, before);
			}
		}
	}

	function cancel() {
		if (press?.timer) clearTimeout(press.timer);
		press = null;
		dragging = null;
		dropBefore = undefined;
	}

	function onClick(key: string) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		onselect(key);
	}

	/**
	 * While a tile is lifted the finger must not scroll the rail, nor swipe the
	 * drawer shut; a touchmove is the only place either can be stopped.
	 */
	$effect(() => {
		const node = rail;
		if (!node) return;
		const hold = (e: TouchEvent) => {
			if (dragging) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		node.addEventListener('touchmove', hold, { passive: false });
		return () => node.removeEventListener('touchmove', hold);
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && dragging && cancel()} />

<nav class="rail" class:lifting={!!dragging} bind:this={rail} aria-label="Projects">
	<button
		type="button"
		class="rt all"
		class:sel={selected === 'active'}
		title="Active: what wants you, what is working, what just finished"
		onclick={() => onselect('active')}
	>
		<span class="bolt"><iconify-icon icon="mdi:lightning-bolt-outline"></iconify-icon></span>
		{#if activeBadge}<span class="bdg" style="--c:{BADGE_COLORS[activeBadge]}"></span>{/if}
	</button>
	<span class="rsep"></span>
	{#each tiles as tile (tile.key)}
		<button
			type="button"
			data-tile={tile.key}
			class="rt"
			class:sel={selected === tile.key}
			class:quiet={tile.quiet}
			class:dragging={dragging === tile.key}
			class:drop={dragging && dropBefore === tile.key && dragging !== tile.key}
			title="{tile.name}{tile.where ? `\n${tile.where}` : ''}\nDrag to reorder"
			aria-current={selected === tile.key ? 'true' : undefined}
			onpointerdown={(e) => onPointerDown(e, tile.key)}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={cancel}
			oncontextmenu={(e) => press?.touch && e.preventDefault()}
			onclick={() => onClick(tile.key)}
		>
			<ProjectTile initials={tile.initials} hue={tile.hue} icon={tile.icon} size={34} />
			{#if tile.badge}<span class="bdg" style="--c:{BADGE_COLORS[tile.badge]}"></span>{/if}
		</button>
	{/each}
	{#if dragging && dropBefore === null}<span class="drop-end"></span>{/if}
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 8px 0 16px;
		overflow-y: auto;
		overflow-x: hidden;
		border-right: 1px solid var(--line-soft, #1f1f21);
		scrollbar-width: none;
		overscroll-behavior: contain;
	}
	.rail::-webkit-scrollbar {
		display: none;
	}
	.rail.lifting {
		cursor: grabbing;
	}
	.rt {
		position: relative;
		flex: none;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		border-radius: 10px;
		/* A finger's hold lifts the tile; the browser must not select or call out. */
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		touch-action: pan-y;
	}
	.rt :global(.ptile) {
		transition: border-radius 0.15s;
	}
	.rt:hover :global(.ptile),
	.rt.sel :global(.ptile) {
		border-radius: 13px;
	}
	/* The chosen tile: a bar at the rail's edge. */
	.rt.sel::before {
		content: '';
		position: absolute;
		left: -9px;
		top: 6px;
		bottom: 6px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--text, #e7e5e4);
	}
	.rt:focus-visible {
		outline: 2px solid #7dd3fc;
		outline-offset: 2px;
	}
	/* Nothing running there: quieter until pointed at or chosen. */
	.rt.quiet :global(.ptile) {
		opacity: 0.5;
		filter: saturate(0.6);
	}
	.rt.quiet:hover :global(.ptile),
	.rt.quiet.sel :global(.ptile) {
		opacity: 1;
		filter: none;
	}
	.rt.dragging {
		opacity: 0.35;
	}
	.rt.drop::after,
	.drop-end {
		content: '';
		position: absolute;
		left: 2px;
		right: 2px;
		top: -5px;
		height: 2px;
		border-radius: 2px;
		background: var(--text, #e7e5e4);
	}
	.drop-end {
		position: static;
		width: 30px;
		flex: none;
	}
	.bolt {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 10px;
		background: var(--surface-3, #212124);
		box-shadow: inset 0 0 0 1px var(--line, #2a2a2c);
		color: var(--text, #e7e5e4);
		transition: border-radius 0.15s;
	}
	.bolt iconify-icon {
		font-size: 18px;
	}
	.rt.all:hover .bolt,
	.rt.all.sel .bolt {
		border-radius: 13px;
	}
	.bdg {
		position: absolute;
		right: -3px;
		bottom: -3px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid hsl(var(--background));
		background: var(--c);
	}
	.rsep {
		flex: none;
		width: 24px;
		height: 1px;
		background: var(--line, #2a2a2c);
		margin: 2px 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.rt :global(.ptile),
		.bolt {
			transition: none;
		}
	}
</style>
