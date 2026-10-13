<script lang="ts">
	/**
	 * A file's hunks drawn as a unified diff: line numbers on both sides, a row
	 * for each stretch of unchanged lines the diff leaves out, and the code
	 * coloured once highlight.js has loaded. Given a way to read the file
	 * (`loadText`), a left-out stretch can be opened a few lines at a time from
	 * either end, or all at once. The Changes pane and the History pane both
	 * read a diff through it.
	 */
	import { untrack } from 'svelte';
	import { diffRows, languageFor, type DiffRow, type Hunk } from '$lib/side-panel/changes';
	import { highlightLines } from '$lib/side-panel/highlight';

	let {
		hunks,
		file,
		loadText
	}: {
		hunks: Hunk[];
		file: string;
		/** The file's new side, whole, or null when it cannot be read as text. */
		loadText?: () => Promise<string | null>;
	} = $props();

	type Gap = Extract<DiffRow, { type: 'gap' }>;
	/** A stretch still hidden, with what is left of it and which ends can be opened further. */
	type Hidden = { type: 'hidden'; gap: Gap; left: number | null; first: boolean; last: boolean };
	type Shown = Exclude<DiffRow, Gap> | Hidden;

	/** Lines shown per press on one end of a hidden stretch. */
	const STEP = 20;

	/** The file's lines once someone has asked for hidden ones; false when it could not be read. */
	let text = $state<string[] | false | null>(null);
	let reading = $state(false);
	/** Lines opened at the top and the bottom of each hidden stretch, keyed by where it starts. */
	let opened = $state<Record<number, { top: number; bottom: number }>>({});

	const canOpen = $derived(loadText !== undefined && text !== false);
	const base = $derived(diffRows(hunks, { tail: loadText !== undefined }));

	const rows = $derived.by((): Shown[] => {
		const out: Shown[] = [];
		const gaps = base.filter((r): r is Gap => r.type === 'gap');
		for (const row of base) {
			if (row.type !== 'gap') {
				out.push(row);
				continue;
			}
			const lines = text || null;
			const count = row.count ?? (lines ? Math.max(0, lines.length - row.from + 1) : null);
			const open = opened[row.from] ?? { top: 0, bottom: 0 };
			const top = count === null ? open.top : Math.min(open.top, count);
			const bottom = count === null ? 0 : Math.min(open.bottom, count - top);
			const line = (n: number): Shown => ({
				type: 'context',
				old: row.old + (n - row.from),
				new: n,
				text: lines?.[n - 1] ?? ''
			});
			for (let i = 0; i < top; i++) out.push(line(row.from + i));
			const left = count === null ? null : count - top - bottom;
			// The rest of a file that turns out to end where the diff does needs no row.
			if (left === null ? canOpen : left > 0) {
				out.push({ type: 'hidden', gap: row, left, first: row === gaps[0] && row.from === 1, last: row.count === null });
			}
			if (count !== null) for (let i = bottom; i > 0; i--) out.push(line(row.from + count - i));
		}
		return out;
	});

	async function open(gap: Gap, end: 'top' | 'bottom' | 'all') {
		if (text === null && loadText && !reading) {
			reading = true;
			try {
				const read = await loadText();
				text = read === null ? false : read.replace(/\n$/, '').split('\n');
			} catch {
				text = false;
			} finally {
				reading = false;
			}
		}
		if (!text) return;
		const was = opened[gap.from] ?? { top: 0, bottom: 0 };
		opened[gap.from] =
			end === 'all' ? { top: Infinity, bottom: 0 } : { ...was, [end]: was[end] + STEP };
	}

	// Another file is another set of hidden lines.
	$effect(() => {
		void file;
		untrack(() => {
			text = null;
			opened = {};
		});
	});

	const SIGN = { add: '+', del: '−', context: ' ' } as const;

	/** Rows past this many are drawn plain: colouring them costs more than it gives. */
	const PAINT_LIMIT = 4000;
	/** Highlighted HTML per row index, filled in once highlight.js has loaded. */
	let painted = $state<(string | null)[] | null>(null);
	$effect(() => {
		painted = null;
		if (rows.length === 0 || rows.length > PAINT_LIMIT) return;
		const lines = rows.map((r) => ('text' in r ? r.text : ''));
		const language = untrack(() => languageFor(file));
		let stale = false;
		void highlightLines(lines, language).then((html) => {
			if (!stale && html) painted = html;
		});
		return () => (stale = true);
	});
</script>

<div class="lines">
	{#each rows as row, i (i)}
		{#if row.type === 'hunk'}
			<div class="hunk">{row.header}</div>
		{:else if row.type === 'hidden'}
			{@const some = row.left === null || row.left > STEP}
			<div class="gap">
				{#if canOpen && some && !row.first}
					<button type="button" title="Show {STEP} more lines below" aria-label="Show {STEP} more lines below" onclick={() => void open(row.gap, 'top')}>
						<iconify-icon icon="mdi:arrow-expand-down"></iconify-icon>
					</button>
				{/if}
				{#if canOpen}
					<button type="button" class="all" title="Show all of these lines" onclick={() => void open(row.gap, 'all')}>
						{#if row.left === null}
							{reading ? 'Reading…' : 'the rest of the file'}
						{:else}
							{row.left} unchanged {row.left === 1 ? 'line' : 'lines'}
						{/if}
					</button>
				{:else}
					<span>⋯ {row.left} unchanged {row.left === 1 ? 'line' : 'lines'} ⋯</span>
				{/if}
				{#if canOpen && some && !row.last}
					<button type="button" title="Show {STEP} more lines above" aria-label="Show {STEP} more lines above" onclick={() => void open(row.gap, 'bottom')}>
						<iconify-icon icon="mdi:arrow-expand-up"></iconify-icon>
					</button>
				{/if}
			</div>
		{:else}
			<div class="ln {row.type}">
				<span class="no">{row.old ?? ''}</span><span class="no">{row.new ?? ''}</span><span class="sign"
					>{SIGN[row.type]}</span
				><!-- eslint-disable-next-line svelte/no-at-html-tags -- highlight.js escapes the text it colours --><span
					class="code">{#if painted?.[i] != null}{@html painted[i]}{:else}{row.text}{/if}</span
				>
			</div>
		{/if}
	{/each}
</div>

<style>
	.lines {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 6px 0 16px;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.65;
	}
	.hunk {
		padding: 2px 14px;
		color: #78716c;
		background: #161616;
		white-space: pre;
	}
	.gap {
		position: sticky;
		left: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-height: 26px;
		padding: 0 14px;
		color: #78716c;
		background: #141414;
	}
	.gap button {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 8px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: #a8a29e;
		font: inherit;
		cursor: pointer;
	}
	.gap button:hover {
		background: #232323;
		color: #f5f5f4;
	}
	.gap button:focus-visible {
		outline: 2px solid #7dd3fc;
		outline-offset: -2px;
	}
	.gap iconify-icon {
		font-size: 14px;
	}
	@media (pointer: coarse) {
		.gap {
			min-height: 38px;
		}
		.gap button {
			height: 34px;
			padding: 0 12px;
		}
	}
	.ln {
		display: flex;
		width: max-content;
		min-width: 100%;
		color: #a8a29e;
	}
	.ln.add {
		background: #0f2417;
		color: #bbf7d0;
	}
	.ln.del {
		background: #2a1215;
		color: #fecaca;
	}
	.no {
		flex: none;
		width: 4ch;
		padding-right: 1ch;
		text-align: right;
		color: #57534e;
		user-select: none;
	}
	.sign {
		flex: none;
		width: 2ch;
		text-align: center;
		user-select: none;
	}
	.ln.add .sign {
		color: #4ade80;
	}
	.ln.del .sign {
		color: #f87171;
	}
	.code {
		white-space: pre;
		padding-right: 14px;
	}
	/* highlight.js tokens, muted so the add/del backgrounds still lead. */
	.code :global(.hljs-keyword),
	.code :global(.hljs-built_in),
	.code :global(.hljs-literal),
	.code :global(.hljs-selector-tag) {
		color: #c4b5fd;
	}
	.code :global(.hljs-string),
	.code :global(.hljs-regexp),
	.code :global(.hljs-attr),
	.code :global(.hljs-selector-attr) {
		color: #fcd34d;
	}
	.code :global(.hljs-number),
	.code :global(.hljs-symbol) {
		color: #fdba74;
	}
	.code :global(.hljs-comment),
	.code :global(.hljs-meta) {
		color: #78716c;
		font-style: italic;
	}
	.code :global(.hljs-title),
	.code :global(.hljs-function),
	.code :global(.hljs-section) {
		color: #93c5fd;
	}
	.code :global(.hljs-type),
	.code :global(.hljs-class),
	.code :global(.hljs-name),
	.code :global(.hljs-selector-class) {
		color: #5eead4;
	}
	.code :global(.hljs-variable),
	.code :global(.hljs-template-variable),
	.code :global(.hljs-property) {
		color: #f9a8d4;
	}
</style>
