<script lang="ts">
	import type { TranscriptEntry } from '../../../../src/transcript/parser';
	import type { PaneChoice } from '$shared/types/ws-messages.js';
	import {
		keysForAnswer,
		keysForOptionMove,
		keysForOptionPick
	} from '$shared/tmux/answer-keys.js';
	import { longPress } from '$lib/actions/longPress';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	type AskEntry = Extract<TranscriptEntry, { kind: 'ask' }>;
	type Row = PaneChoice['options'][number];

	let {
		choice,
		ask = null,
		permission = false,
		closed = false,
		onKeys,
		onText,
		onSubmitted
	}: {
		/** The dialog as the pane draws it right now; null when the poll has not read one. */
		choice: PaneChoice | null;
		/** The AskUserQuestion call behind the dialog, when it is one: every question up front. */
		ask?: AskEntry | null;
		/** A permission prompt rather than a question. */
		permission?: boolean;
		/** The dialog has been answered and is gone from the pane. */
		closed?: boolean;
		/** Sends a tmux key sequence (space-separated) to the pane. */
		onKeys: (keys: string) => Promise<void> | void;
		/** Types text into the pane as-is, with no Enter after it. */
		onText: (text: string) => Promise<void> | void;
		/** The card sent the keys that close the dialog without the pane to confirm it. */
		onSubmitted?: () => void;
	} = $props();

	// ── where the dialog stands ──────────────────────────────────────────
	// The pane is the truth about which question is open and which row is
	// highlighted. The AskUserQuestion entry knows every question in advance,
	// so the card can draw them all and say which ones are already answered.

	const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

	/** The pane is on the Submit tab a multi-question or multi-select dialog ends with. */
	const reviewing = $derived(
		choice != null && choice.options.some((o) => o.label === 'Submit answers')
	);

	/** Which of the entry's questions the pane has open; -1 when it cannot tell. */
	const liveIndex = $derived.by(() => {
		if (!ask || !choice) return -1;
		if (reviewing) return ask.questions.length;
		const asked = norm(choice.question);
		const byText = ask.questions.findIndex(
			(q) => asked !== '' && (norm(q.question) === asked || asked.startsWith(norm(q.question)))
		);
		if (byText >= 0) return byText;
		// The question wrapped or was cut; the rows still name the same options.
		const first = norm(choice.options[0]?.label);
		return ask.questions.findIndex(
			(q) => q.options.length > 0 && first !== '' && norm(q.options[0].label).startsWith(first.slice(0, 16))
		);
	});

	/** Driving the entry's questions blind: no pane read, so the card keeps count. */
	let sentCount = $state(0);
	let picks = $state<Set<number>>(new Set());
	const blind = $derived(ask != null && choice == null && !closed);

	/** The question the card answers now: an index into the entry, or its length on the Submit tab. */
	const current = $derived(blind ? sentCount : liveIndex);

	/** A dialog with a Submit tab: several questions, or any multi-select. */
	const hasSubmitTab = $derived(
		ask != null && (ask.questions.length > 1 || ask.questions.some((q) => q.multiSelect))
	);
	const atSubmit = $derived(ask != null && current === ask.questions.length);

	// ── free text ────────────────────────────────────────────────────────

	let draft = $state('');
	let sending = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	/** The pane's "Type something" row, which the card answers with its own field. */
	const textRow = $derived(choice?.options.find((o) => o.text) ?? null);
	/** Rows the card draws as buttons: everything but the text row. */
	const rows = $derived(choice?.options.filter((o) => !o.text) ?? []);

	/** The pane has a text field open: the free-text row, or the highlighted option's notes. */
	const typing = $derived(choice?.typing === true);
	const noting = $derived(choice?.noting === true);

	/** Notes go on the highlighted option; say which. */
	const notingOn = $derived(
		noting ? (choice?.options.find((o) => o.selected)?.label ?? choice?.question ?? 'this option') : null
	);

	$effect(() => {
		// The pane opened a text field (a key, or the terminal): the card's field is where to type.
		if ((typing || noting) && inputEl && document.activeElement?.tagName !== 'TEXTAREA') {
			inputEl.focus({ preventScroll: true });
		}
	});

	async function sendFree() {
		const text = draft.trim();
		if (!text || sending) return;
		sending = true;
		try {
			if (blind) {
				const q = ask!.questions[sentCount];
				// The text row sits under the options; the cursor starts on the first.
				await onKeys(Array(q.options.length).fill('Down').join(' '));
				await onText(text);
				await onKeys('Enter');
				advanceBlind();
			} else if (choice) {
				const opts = choice.options;
				const multi = choice.multi === true;
				const wasNoting = noting;
				if (!typing && !wasNoting) {
					const to = opts.findIndex((o) => o.text);
					const move = keysForOptionMove(
						opts.findIndex((o) => o.selected),
						to,
						opts.length
					);
					if (move === null) return;
					// Highlighting the row is what opens it for typing.
					if (move) await onKeys(move);
				}
				await onText(text);
				// A note closes with Escape, which keeps it and brings the rows back;
				// a multi-select's row ticks with its text, and the answer goes in
				// from the Submit tab, so only a single-select takes Enter.
				if (wasNoting) await onKeys('Escape');
				else if (!multi) await onKeys('Enter');
			}
			draft = '';
		} finally {
			sending = false;
		}
	}

	function freeKeydown(e: KeyboardEvent) {
		// The card's field never leaks keys to the page's own shortcuts.
		e.stopPropagation();
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void sendFree();
		} else if (e.key === 'Escape' && (typing || noting)) {
			e.preventDefault();
			void onKeys(noting ? 'Escape' : 'Up');
		}
	}

	// ── picking rows ─────────────────────────────────────────────────────

	/**
	 * Move Claude Code's own highlight to the row you tapped, then submit.
	 *
	 * Walks with arrows from the row the pane says is selected rather than
	 * typing the number, so it works whether or not the dialog takes digits.
	 */
	async function pick(row: Row) {
		if (!choice) return;
		const opts = choice.options;
		const keys = keysForOptionPick(
			opts.findIndex((o) => o.selected),
			opts.findIndex((o) => o.n === row.n),
			opts.length
		);
		// A text field is open: the arrows have to leave it first.
		if (keys) await onKeys(typing ? `Up ${keys}` : keys);
	}

	/**
	 * Move the highlight without picking — a long press. Some dialogs hang a
	 * setting off the highlighted row: the model picker's effort, a
	 * question's notes.
	 */
	async function highlight(row: Row) {
		if (!choice) return;
		const opts = choice.options;
		const keys = keysForOptionMove(
			opts.findIndex((o) => o.selected),
			opts.findIndex((o) => o.n === row.n),
			opts.length
		);
		if (keys) await onKeys(keys);
	}

	function advanceBlind() {
		sentCount += 1;
		picks = new Set();
		if (ask && !hasSubmitTab && sentCount >= ask.questions.length) onSubmitted?.();
	}

	function pickBlind(qi: number, oi: number) {
		const q = ask!.questions[qi];
		if (q.multiSelect) {
			const next = new Set(picks);
			if (next.has(oi)) next.delete(oi);
			else next.add(oi);
			picks = next;
			return;
		}
		const keys = keysForAnswer([oi], q);
		if (!keys) return;
		void onKeys(keys);
		advanceBlind();
	}

	function confirmBlind(qi: number) {
		const keys = keysForAnswer([...picks], ask!.questions[qi]);
		if (!keys) return;
		void onKeys(keys);
		advanceBlind();
	}

	/** Submit or Cancel on the closing tab. */
	async function finish(submit: boolean) {
		if (blind) {
			await onKeys(submit ? 'Enter' : 'Down Enter');
			onSubmitted?.();
			return;
		}
		const row = choice?.options.find((o) =>
			submit ? o.label === 'Submit answers' : norm(o.label) === 'cancel'
		);
		if (row) await pick(row);
	}

	/** A multi-select's ticks are done: on to the next tab (Submit, after the last question). */
	function done() {
		void onKeys(typing ? 'Up Right' : 'Right');
	}

	// ── the dialog's other keys ──────────────────────────────────────────

	/** A hint segment naming a key and what it does: "s to use this session only". */
	const KEY_SEGMENT = /^(\S+) to (.+)$/;
	/** Keys the card already drives with its rows and its own buttons. */
	const DRIVEN_KEYS = new Set(['Enter', 'Esc', '↑/↓', '←/→', 'ctrl+g']);
	/** A note the dialog adjusts with the horizontal arrows. */
	const ARROW_NOTE = /←\/→/;

	/**
	 * The keys a dialog answers to beyond picking a row — the model picker's
	 * "s to use this session only", a question's "n to add notes" — read off
	 * the hint line the dialog draws under itself, so a dialog this page has
	 * never seen still gets its extra keys offered as buttons.
	 */
	const extraKeys = $derived.by(() => {
		const out: { key: string; label: string }[] = [];
		for (const segment of (choice?.keys ?? '').split('·')) {
			const m = segment.trim().match(KEY_SEGMENT);
			if (!m || DRIVEN_KEYS.has(m[1])) continue;
			if (!/^[a-z]$/i.test(m[1]) && m[1] !== 'Tab' && m[1] !== 'Space') continue;
			out.push({ key: m[1], label: m[2] });
		}
		return out;
	});

	/** The panel a question draws beside an option, from the entry the pane cuts it out of. */
	function previewFor(qi: number, label: string): string | undefined {
		const q = ask?.questions[qi];
		if (!q) return undefined;
		const l = norm(label);
		return q.options.find((o) => norm(o.label) === l || (l !== '' && norm(o.label).startsWith(l)))
			?.preview;
	}

	/** Someone opened the session to answer this: bring the card into view once. */
	function reveal(el: HTMLElement) {
		requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
	}

	const title = $derived(permission && !ask ? 'Permission needed' : 'Claude is asking');
</script>

{#snippet liveRows(qi: number)}
	<div class="rows" role="group">
		{#each rows as row (row.n)}
			{@const preview = qi >= 0 ? previewFor(qi, row.label) : undefined}
			<button
				type="button"
				class="row"
				class:sel={row.selected}
				disabled={closed}
				title="Tap to pick · hold to highlight only"
				onclick={() => void pick(row)}
				use:longPress={{ onTrigger: () => void highlight(row) }}
			>
				{#if row.checked === undefined}
					<span class="num">{row.n}</span>
				{:else}
					<iconify-icon
						class="box"
						class:on={row.checked}
						icon={row.checked ? 'mdi:checkbox-marked' : 'mdi:checkbox-blank-outline'}
					></iconify-icon>
				{/if}
				<span class="label">
					<span class="name">{row.label}</span>
					{#if row.hint}<span class="hint">{row.hint}</span>{/if}
					{#if preview}<pre class="preview">{preview}</pre>{/if}
				</span>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet freeText(placeholder: string, label: string)}
	<form
		class="free"
		onsubmit={(e) => {
			e.preventDefault();
			void sendFree();
		}}
	>
		<Input
			bind:ref={inputEl}
			bind:value={draft}
			data-dialog-input
			class="free-input"
			{placeholder}
			aria-label={label}
			disabled={closed}
			onkeydown={freeKeydown}
		/>
		<Button
			type="submit"
			variant="warning"
			size="sm"
			class="free-send"
			disabled={closed || sending || draft.trim() === ''}
		>
			<iconify-icon icon={noting ? 'mdi:note-check-outline' : 'mdi:send'}></iconify-icon>
			{noting ? 'Save' : 'Send'}
		</Button>
	</form>
{/snippet}

{#snippet keysBar()}
	{#each choice?.notes ?? [] as note (note)}
		<p class="note">
			<span>{note}</span>
			{#if ARROW_NOTE.test(note)}
				<button type="button" class="arrow" title="Left" onclick={() => void onKeys('Left')}>
					<iconify-icon icon="mdi:chevron-left"></iconify-icon>
				</button>
				<button type="button" class="arrow" title="Right" onclick={() => void onKeys('Right')}>
					<iconify-icon icon="mdi:chevron-right"></iconify-icon>
				</button>
			{/if}
		</p>
	{/each}
	<div class="extra">
		<!-- Move the highlight without picking: what a setting under the rows,
		     or a note, applies to. A held row does the same. -->
		<button type="button" class="key nav" title="Highlight the row above" onclick={() => void onKeys('Up')}>
			<iconify-icon icon="mdi:chevron-up"></iconify-icon>
		</button>
		<button type="button" class="key nav" title="Highlight the row below" onclick={() => void onKeys('Down')}>
			<iconify-icon icon="mdi:chevron-down"></iconify-icon>
		</button>
		{#if choice?.multi && !reviewing}
			<!-- Ticking a box leaves the dialog open; the answer goes in from a
			     tab of its own, one key to the right. -->
			<button type="button" class="key done" onclick={done}>
				<iconify-icon icon="mdi:check-all"></iconify-icon>Done
			</button>
		{/if}
		{#each extraKeys as extra (extra.key)}
			<button type="button" class="key" onclick={() => void onKeys(extra.key)}>
				<kbd>{extra.key}</kbd>{extra.label}
			</button>
		{/each}
		<button type="button" class="key" title="Dismiss the dialog" onclick={() => void onKeys('Escape')}>
			<kbd>Esc</kbd>cancel
		</button>
	</div>
	{#if choice?.keys}<p class="keys">{choice.keys}</p>{/if}
{/snippet}

<section
	class="dialog-card"
	class:closed
	aria-label={title}
	use:reveal
>
	<header class="title">
		<iconify-icon icon={permission && !ask ? 'mdi:shield-alert-outline' : 'mdi:chat-question'}></iconify-icon>
		<span>{closed ? 'Answered' : title}</span>
		{#if closed}<iconify-icon class="ok" icon="mdi:check"></iconify-icon>{/if}
	</header>

	{#if ask}
		{#each ask.questions as q, qi (q.question)}
			{@const sent = closed || (current >= 0 && qi < current)}
			{@const active = !closed && qi === current}
			<div class="q" class:inactive={!active && !sent}>
				<span class="chip" class:done={sent}>{q.header}</span>
				<p class="question">{q.question}</p>
				{#if sent}
					<div class="sent">answer sent ✓</div>
				{:else if active && choice && !reviewing}
					{@render liveRows(qi)}
					{#if textRow || noting}
						{@render freeText(
							noting ? `Note on ${notingOn}` : 'Type something else',
							noting ? 'Note' : `Your own answer to: ${q.question}`
						)}
					{/if}
				{:else}
					<!-- Not open in the pane yet, or no pane read: the entry's own options. -->
					<div class="rows">
						{#each q.options as opt, oi (opt.label)}
							<button
								type="button"
								class="row"
								class:sel={active && q.multiSelect && picks.has(oi)}
								disabled={!active || !blind}
								onclick={() => pickBlind(qi, oi)}
							>
								{#if q.multiSelect}
									<iconify-icon
										class="box"
										class:on={active && picks.has(oi)}
										icon={active && picks.has(oi)
											? 'mdi:checkbox-marked'
											: 'mdi:checkbox-blank-outline'}
									></iconify-icon>
								{:else}
									<span class="num">{oi + 1}</span>
								{/if}
								<span class="label">
									<span class="name">{opt.label}</span>
									{#if opt.description}<span class="hint">{opt.description}</span>{/if}
									{#if opt.preview}<pre class="preview">{opt.preview}</pre>{/if}
								</span>
							</button>
						{/each}
					</div>
					{#if active && blind}
						{#if q.multiSelect}
							<Button
								variant="warning"
								size="sm"
								class="confirm"
								disabled={picks.size === 0}
								onclick={() => confirmBlind(qi)}
							>
								Confirm selection
							</Button>
						{:else}
							{@render freeText('Type something else', `Your own answer to: ${q.question}`)}
						{/if}
					{/if}
				{/if}
			</div>
		{/each}

		{#if liveIndex < 0 && choice && !closed}
			<!-- The pane shows something the entry does not name: draw it as it is. -->
			<div class="q">
				{#if choice.question}<p class="question">{choice.question}</p>{/if}
				{@render liveRows(-1)}
				{#if textRow || noting}{@render freeText('Type something else', 'Your own answer')}{/if}
			</div>
		{/if}

		{#if hasSubmitTab && !closed}
			<footer class="foot">
				<span class="tally">
					{#if atSubmit}
						All answered — ready to submit
					{:else}
						{Math.max(0, current)} of {ask.questions.length} answered
					{/if}
				</span>
				<Button variant="ghost" size="sm" disabled={!atSubmit} onclick={() => void finish(false)}>
					Cancel
				</Button>
				<Button
					variant="warning"
					size="sm"
					disabled={!atSubmit}
					title={atSubmit ? 'Submit your answers' : 'Answer every question first'}
					onclick={() => void finish(true)}
				>
					<iconify-icon icon="mdi:check-all"></iconify-icon>Submit
				</Button>
			</footer>
		{/if}
		{#if choice && !closed}{@render keysBar()}{/if}
	{:else if choice && !closed}
		<div class="q">
			{#if choice.question}<p class="question">{choice.question}</p>{/if}
			{@render liveRows(-1)}
			{#if textRow || noting}
				{@render freeText(
					noting ? `Note on ${notingOn}` : 'Type something else',
					noting ? 'Note' : 'Your own answer'
				)}
			{/if}
		</div>
		{@render keysBar()}
	{:else if !closed}
		<p class="question muted">Reading the dialog from the pane…</p>
	{/if}
</section>

<style>
	/* The one thing in the transcript that wants you: amber, the colour every
	   surface gives a waiting session. It cools to a log line once answered. */
	.dialog-card {
		margin: 14px 0 14px 12px;
		border: 1px solid #5c4410;
		border-left: 3px solid #fbbf24;
		border-radius: 8px;
		background: #1a1610;
		padding: 10px 12px 12px;
		scroll-margin: 16px;
	}
	.dialog-card.closed {
		border-color: #2a2a2e;
		border-left-color: #4d7c5f;
		background: #161616;
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
	.closed .title {
		color: #86b898;
	}
	.q + .q {
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid #2c2416;
	}
	.q.inactive {
		opacity: 0.45;
	}
	.chip {
		display: inline-block;
		margin-bottom: 4px;
		padding: 1px 7px;
		border-radius: 4px;
		background: #3a2d0d;
		color: #fde68a;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.chip.done {
		background: #262220;
		color: #a8a29e;
	}
	.question {
		margin: 0 0 8px;
		color: #f5f0ee;
		font-weight: 600;
		/* Carried whole from the pane, with the breaks the dialog drew itself. */
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.question.muted {
		color: #a8a29e;
		font-weight: 400;
	}
	.sent {
		font-size: 12.5px;
		color: #86b898;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.row {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		width: 100%;
		min-height: 34px;
		padding: 7px 10px;
		border: 1px solid #2c2416;
		border-radius: 7px;
		background: #201b12;
		color: #d6d3d1;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.12s,
			background 0.12s;
	}
	.row:hover:not(:disabled) {
		border-color: #b45309;
		background: #2a2214;
	}
	.row:disabled {
		cursor: default;
	}
	/* Claude Code's own highlight: Enter (or the gamepad's A) takes this row. */
	.row.sel {
		border-color: #fbbf24;
		background: #3a2d0d;
		color: #fde68a;
	}
	.num {
		flex: none;
		width: 10px;
		padding-top: 2px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: #78716c;
	}
	.row.sel .num {
		color: #fbbf24;
	}
	/* A multi-select row says what it is with its own box: the box is the
	   thing a tap changes. */
	.box {
		flex: none;
		padding-top: 1px;
		font-size: 15px;
		color: #57534e;
	}
	.box.on {
		color: #34d399;
	}
	.label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.name {
		font-size: 13px;
		font-weight: 600;
		color: inherit;
		overflow-wrap: anywhere;
	}
	.hint {
		font-size: 12px;
		line-height: 1.45;
		color: #a8a29e;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.row.sel .hint {
		color: #c8a94a;
	}
	/* The panel the terminal draws beside a highlighted option, shown under
	   it here: on a phone there is no room to the side. */
	.preview {
		margin: 6px 0 0;
		padding: 8px 10px;
		border: 1px solid #2c2416;
		border-radius: 6px;
		background: #14110c;
		color: #d6d3d1;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
		white-space: pre;
		overflow-x: auto;
	}
	.free {
		display: flex;
		gap: 6px;
		margin-top: 8px;
	}
	.free :global(.free-input) {
		flex: 1;
		min-width: 0;
		height: 34px;
		border-color: #3a2f1a;
		background: #14110c;
		color: #f5f0ee;
		font-size: 13px;
	}
	.free :global(.free-send) {
		height: 34px;
	}
	.dialog-card :global(.confirm) {
		margin-top: 8px;
	}
	.foot {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid #2c2416;
	}
	.tally {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		color: #a8a29e;
	}
	/* A line the dialog prints for itself under the rows, with the arrows that
	   adjust it when the line says they do. */
	.note {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 8px 0 0;
		font-size: 12px;
		line-height: 1.4;
		color: #a8a29e;
	}
	.note span {
		min-width: 0;
	}
	.arrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: #26262a;
		color: #d6d3d1;
		font-size: 16px;
		cursor: pointer;
	}
	.extra {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	/* One of the keys the dialog names: the key as a cap, then its verb. */
	.key {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 11px 0 8px;
		border: 0;
		border-radius: 8px;
		background: #26262a;
		color: #d6d3d1;
		font-family: var(--font-mono);
		font-size: 11.5px;
		cursor: pointer;
	}
	.key:hover {
		background: #33333a;
	}
	.key.nav {
		width: 34px;
		padding: 0;
		justify-content: center;
		font-size: 17px;
	}
	.key.done {
		background: #1c3326;
		color: #6ee7b7;
	}
	.key.done:hover {
		background: #244433;
	}
	.key kbd {
		padding: 0 5px;
		border: 1px solid #44444a;
		border-radius: 4px;
		font-family: inherit;
		font-size: 10.5px;
		color: #fbbf24;
	}
	.keys {
		margin: 6px 0 0;
		color: #6b6b70;
		font-family: var(--font-mono);
		font-size: 10.5px;
		overflow-wrap: anywhere;
	}
	@media (pointer: coarse) {
		.row {
			min-height: 44px;
		}
		.key,
		.free :global(.free-input),
		.free :global(.free-send) {
			height: 40px;
		}
		/* Below 16px, iOS zooms the page to the field on focus. */
		.free :global(.free-input) {
			font-size: 16px;
		}
	}
</style>
