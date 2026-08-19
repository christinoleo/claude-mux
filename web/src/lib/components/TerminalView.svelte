<script lang="ts">
	import { ansiLineToHtml, stripAnsi } from '$lib/terminal/ansi';

	interface Props {
		/** History lines (ANSI), oldest first. Immutable per index → rendered once, reused via keyed each. */
		history: string[];
		/** Absolute index of history[0] — used as the stable key base. */
		historyStart: number;
		/** Visible pane rows (ANSI). Re-rendered on every change. */
		screen: string[];
		/** Render with ANSI colors (true) or strip escapes (false). */
		themed?: boolean;
		/**
		 * While true, the view keeps showing the snapshot taken when it flipped
		 * on (iOS drops the copy callout on any DOM mutation under a selection).
		 */
		frozen?: boolean;
	}

	let { history, historyStart, screen, themed = true, frozen = false }: Props = $props();

	let snapHistory = $state<string[]>([]);
	let snapStart = $state(0);
	let snapScreen = $state<string[]>([]);
	let wasFrozen = false;

	$effect(() => {
		if (frozen && !wasFrozen) {
			snapHistory = [...history];
			snapStart = historyStart;
			snapScreen = [...screen];
		}
		wasFrozen = frozen;
	});

	const shownHistory = $derived(frozen ? snapHistory : history);
	const shownStart = $derived(frozen ? snapStart : historyStart);
	const shownScreen = $derived(frozen ? snapScreen : screen);

	// Screen is small (pane rows); one string → one render per tick.
	const screenHtml = $derived(
		themed ? shownScreen.map(ansiLineToHtml).join('\n') : shownScreen.map(stripAnsi).join('\n')
	);
</script>

<pre class="terminal-view" class:themed>{#each shownHistory as line, i (shownStart + i)}{#if themed}{@html ansiLineToHtml(line)}{:else}{stripAnsi(line)}{/if}{'\n'}{/each}{#if themed}{@html screenHtml}{:else}{screenHtml}{/if}</pre>

<style>
	.terminal-view {
		margin: 0;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 13px;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
		background: #000;
		color: #fff;
	}

	.terminal-view {
		margin: 0;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 13px;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
		background: #000;
		color: #fff;
	}

	/* ansi_up class-based colors */
	.terminal-view :global(.ansi-black-fg) { color: #555; }
	.terminal-view :global(.ansi-red-fg) { color: #f87171; }
	.terminal-view :global(.ansi-green-fg) { color: #4ade80; }
	.terminal-view :global(.ansi-yellow-fg) { color: #fbbf24; }
	.terminal-view :global(.ansi-blue-fg) { color: #60a5fa; }
	.terminal-view :global(.ansi-magenta-fg) { color: #c084fc; }
	.terminal-view :global(.ansi-cyan-fg) { color: #22d3ee; }
	.terminal-view :global(.ansi-white-fg) { color: #e5e7eb; }

	.terminal-view :global(.ansi-bright-black-fg) { color: #6b7280; }
	.terminal-view :global(.ansi-bright-red-fg) { color: #fca5a5; }
	.terminal-view :global(.ansi-bright-green-fg) { color: #86efac; }
	.terminal-view :global(.ansi-bright-yellow-fg) { color: #fde68a; }
	.terminal-view :global(.ansi-bright-blue-fg) { color: #93c5fd; }
	.terminal-view :global(.ansi-bright-magenta-fg) { color: #d8b4fe; }
	.terminal-view :global(.ansi-bright-cyan-fg) { color: #67e8f9; }
	.terminal-view :global(.ansi-bright-white-fg) { color: #fff; }

	.terminal-view :global(.ansi-black-bg) { background-color: #000; }
	.terminal-view :global(.ansi-red-bg) { background-color: #b91c1c; }
	.terminal-view :global(.ansi-green-bg) { background-color: #15803d; }
	.terminal-view :global(.ansi-yellow-bg) { background-color: #a16207; }
	.terminal-view :global(.ansi-blue-bg) { background-color: #1d4ed8; }
	.terminal-view :global(.ansi-magenta-bg) { background-color: #7e22ce; }
	.terminal-view :global(.ansi-cyan-bg) { background-color: #0e7490; }
	.terminal-view :global(.ansi-white-bg) { background-color: #e5e7eb; }

	.terminal-view :global(.ansi-bold) { font-weight: 700; }
	.terminal-view :global(.ansi-dim) { opacity: 0.7; }
	.terminal-view :global(.ansi-italic) { font-style: italic; }
	.terminal-view :global(.ansi-underline) { text-decoration: underline; }
	.terminal-view :global(.ansi-strikethrough) { text-decoration: line-through; }

	.terminal-view :global(a) {
		color: inherit;
		text-decoration: underline;
		text-decoration-style: dotted;
	}
	.terminal-view :global(a:hover) {
		text-decoration-style: solid;
	}
</style>
