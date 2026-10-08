<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';
	import type { TranscriptEntry } from '../../../../src/transcript/parser';
	import DialogCard from '$lib/components/DialogCard.svelte';
	import type { SubagentPayload } from '$lib/stores/transcript.svelte';
	import { toolIcon } from '$lib/tool-icons';
	import ToolLabel from '$lib/components/ToolLabel.svelte';
	import { toolFileTarget } from '$lib/side-panel/files';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';
	import { sessionStateVisual } from '$shared/session-state.js';
	import type { DeliveryInfo } from '$shared/types/ws-messages.js';
	import type { PaneActivity, PaneChoice } from '$shared/types/ws-messages.js';
	import { formatSpinnerElapsed } from '$lib/format';
	import { Badge } from '$lib/components/ui/badge';
	import {
		parseGrillRound,
		composeGrillReply,
		type GrillAnswer,
		type GrillRound
	} from '$shared/transcript/grilling.js';
	import { groupToolRuns } from '$shared/transcript/tool-groups.js';
	import TurnChangesCard from '$lib/components/TurnChangesCard.svelte';
	import { placeTurnChanges, type TranscriptChanges, type Turn } from '$lib/side-panel/changes';

	let {
		entries,
		available,
		loaded,
		sessionState = null,
		currentAction = null,
		activity = null,
		delivered = [],
		suggestion = null,
		onAcceptSuggestion,
		paneChoice = null,
		subagents = {},
		onLoadSubagent,
		onSendKeys,
		onSendPaneText,
		olderCount = 0,
		loadingEarlier = false,
		onLoadEarlier,
		onSendReply,
		fileLink,
		agentLink,
		turnChanges = null,
		changesLink
	}: {
		entries: TranscriptEntry[];
		available: boolean;
		/** False while the first snapshot is still in flight. */
		loaded: boolean;
		/** Live session state from the hooks (real-time, unlike the JSONL which lags). */
		sessionState?: 'busy' | 'idle' | 'waiting' | 'permission' | null;
		currentAction?: string | null;
		/** Claude Code's spinner line, split into its parts; null outside tmux or between frames. */
		activity?: PaneActivity | null;
		/** What claude-mux's queue and steers handed the pane lately, newest last. */
		delivered?: DeliveryInfo[];
		/** Claude Code's own ghost-text proposal for the next prompt. */
		suggestion?: string | null;
		/** Accepts the suggestion (Tab then Enter in the pane). */
		onAcceptSuggestion?: () => void;
		/** The dialog the pane is drawing, as the poll read it; drawn as a card here. */
		paneChoice?: PaneChoice | null;
		/** Sends a tmux key sequence (space-separated) to answer a dialog. */
		onSendKeys?: (keys: string) => Promise<void> | void;
		/** Types text into the pane as-is, for a dialog's free-text row or notes. */
		onSendPaneText?: (text: string) => Promise<void> | void;
		/** Subagent work, keyed by the Task tool_use id that spawned it. */
		subagents?: Record<string, SubagentPayload>;
		/** A reader opened an agent's card: fetch everything it ran and reported. */
		onLoadSubagent?: (agentId: string) => void;
		/** Entries the server holds before the ones passed in `entries`. */
		olderCount?: number;
		/** A request for those older entries is in flight. */
		loadingEarlier?: boolean;
		/**
		 * Asks for the next slice of older entries. Called before they render,
		 * so the scroll container can note where the reader was.
		 */
		onLoadEarlier?: () => void;
		/**
		 * Sends a message as the next prompt, the way the composer does;
		 * resolves false when the pane did not take it.
		 */
		onSendReply?: (text: string) => Promise<boolean>;
		/** The link that opens a file a tool row touched, at a line; without it the rows draw none. */
		fileLink?: (path: string, line: number | null) => string;
		/** Where a subagent opens as a page of its own; without it agent cards link nowhere. */
		agentLink?: (agentId: string) => string;
		/** The session's turns that edited files, from the changes API's session source. */
		turnChanges?: TranscriptChanges | null;
		/** Where the Changes pane opens on turn `n`, at `file` or its first file; without it no summaries draw. */
		changesLink?: (n: number, file: string | null) => string;
	} = $props();

	// ── live activity line ───────────────────────────────────────────────
	// The pane's elapsed count would move every second; the server sends the
	// turn's start instead, and the count ticks here.

	let now = $state(Date.now());
	const startedAt = $derived(activity?.started_at ?? null);
	const ticking = $derived(startedAt !== null);
	$effect(() => {
		if (!ticking) return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	/** The spinner's parts, drawn as quiet pills beside its verb. */
	const CHIP = 'border-[#2f2f36] px-[7px] py-0 text-[11.5px] leading-[18px] font-normal text-[#78716c]';

	const elapsedText = $derived(
		startedAt !== null ? formatSpinnerElapsed(Math.max(0, Math.floor((now - startedAt) / 1000))) : null
	);

	/** Entries as drawn: runs of routine tool calls fold into one summary row. */
	const items = $derived(groupToolRuns(entries));

	/** Each turn's change summary, by the item it follows; the turn still running has none yet. */
	const turnRunning = $derived(sessionState !== null && sessionState !== 'idle');
	const turnCards = $derived(
		changesLink && turnChanges
			? placeTurnChanges(items, turnChanges.turns, turnChanges.prompts, turnRunning)
			: new Map<string, Turn>()
	);
	/** The latest summary (the map runs in transcript order) starts open, the rest closed, until the reader says otherwise. */
	const latestCard = $derived([...turnCards.values()].at(-1)?.id ?? null);
	/** By the turn's prompt id, which unlike its number never repeats across sessions in one pane. */
	let cardOpen = $state<Record<string, boolean>>({});

	/**
	 * Which tool cards and groups the reader has open, by entry id (a group
	 * under `group:<first call>`). A run folds only as its calls finish, so the
	 * card someone is reading can turn into a group under them; remembering it
	 * here lets the new group open on that card instead of snapping shut.
	 */
	let opened = $state<Record<string, boolean>>({});

	// ── grilling rounds ──────────────────────────────────────────────────
	// A reply that asks a numbered round of questions, each with Claude's
	// recommendation, is drawn as a form: take the recommendation, write your
	// own answer, or leave the question open — and the reply is composed.

	/** Parsed rounds by entry text; a reply's text never changes once written. */
	const roundCache = new Map<string, GrillRound | null>();
	function grillRound(text: string): GrillRound | null {
		if (!text.includes('❓')) return null;
		let round = roundCache.get(text);
		if (round === undefined) {
			round = parseGrillRound(text);
			roundCache.set(text, round);
		}
		return round;
	}

	/**
	 * The one round that can still be answered: the latest one with nothing
	 * from you after it. Claude may go on talking past it — a background
	 * agent reports in, and it says so — without the questions being any
	 * less open; only your reply, or a question dialog, closes a round.
	 * Older rounds are history, drawn read-only.
	 */
	const liveGrillId = $derived.by(() => {
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.kind === 'user' || e.kind === 'queued' || e.kind === 'ask' || e.kind === 'interrupt')
				return null;
			if (e.kind === 'text' && grillRound(e.text)) return e.id;
		}
		return null;
	});

	let grillAnswers = $state<Record<string, Record<number, GrillAnswer>>>({});
	let grillSending = $state<string | null>(null);
	let grillSent = $state<Record<string, boolean>>({});

	function answerOf(id: string, q: GrillRound['questions'][number]): GrillAnswer {
		return grillAnswers[id]?.[q.n] ?? (q.recommended ? { mode: 'accept' } : { mode: 'own', text: '' });
	}

	function setAnswer(id: string, n: number, answer: GrillAnswer) {
		grillAnswers[id] = { ...(grillAnswers[id] ?? {}), [n]: answer };
	}

	/** Typing makes the answer yours; clearing the field hands it back. */
	function typeAnswer(id: string, q: GrillRound['questions'][number], text: string) {
		if (text.trim() === '' && q.recommended) setAnswer(id, q.n, { mode: 'accept' });
		else setAnswer(id, q.n, { mode: 'own', text });
	}

	function ownText(id: string, q: GrillRound['questions'][number]): string {
		const a = answerOf(id, q);
		return a.mode === 'own' ? a.text : '';
	}

	function tally(id: string, round: GrillRound): string {
		let agreed = 0;
		let own = 0;
		let open = 0;
		for (const q of round.questions) {
			const a = answerOf(id, q);
			if (a.mode === 'accept') agreed++;
			else if (a.mode === 'own' && a.text.trim()) own++;
			else open++;
		}
		const parts: string[] = [];
		if (agreed) parts.push(`${agreed} agreed`);
		if (own) parts.push(`${own} in your words`);
		if (open) parts.push(`${open} left open`);
		return parts.join(', ');
	}

	async function sendRound(id: string, round: GrillRound) {
		if (!onSendReply || grillSending) return;
		const answers: Record<number, GrillAnswer> = {};
		for (const q of round.questions) answers[q.n] = answerOf(id, q);
		grillSending = id;
		try {
			if (await onSendReply(composeGrillReply(round, answers))) grillSent[id] = true;
		} finally {
			grillSending = null;
		}
	}

	/** Grows a textarea with what is typed into it, up to the CSS max-height. */
	function autosize(el: HTMLTextAreaElement) {
		const fit = () => {
			el.style.height = 'auto';
			el.style.height = `${el.scrollHeight}px`;
		};
		fit();
		el.addEventListener('input', fit);
		return { destroy: () => el.removeEventListener('input', fit) };
	}

	/**
	 * Only the newest unanswered dialog can be driven — older cards are history.
	 * Claude Code also sends a permission notification for a question, which
	 * a hook from before 0.29.1 took for a permission prompt; an open question
	 * is answerable either way.
	 */
	const canAnswer = $derived(
		(sessionState === 'waiting' || sessionState === 'permission') && onSendKeys != null
	);

	const liveAskId = $derived(
		canAnswer
			? (entries.findLast((e) => e.kind === 'ask' && !e.answers && !e.rejected)?.id ?? null)
			: null
	);

	// ── the open dialog ──────────────────────────────────────────────────
	// A dialog is drawn as a card in the transcript, never in the composer:
	// an AskUserQuestion where its entry sits, anything else (a permission
	// prompt, a local command's picker) at the foot, where the turn stopped.

	/** Which dialog is open: the live question's entry, or the pane's own. */
	const dialogKey = $derived(liveAskId ?? (paneChoice || canAnswer ? 'pane' : null));
	/** The pane drew this dialog at some point, so its going away means it was answered. */
	let seenLive = $state<string | null>(null);
	/** The card sent the keys that close this dialog, with no pane read to confirm it. */
	let submitted = $state<string | null>(null);
	$effect(() => {
		if (dialogKey === null) {
			seenLive = null;
			submitted = null;
		} else if (paneChoice) {
			seenLive = dialogKey;
			// The pane still draws it, whatever keys the card sent blind.
			submitted = null;
		}
	});
	/** Answered and gone from the pane, while the hooks may still say it is open. */
	const dialogClosed = $derived(
		dialogKey !== null &&
			((seenLive === dialogKey && paneChoice === null) || submitted === dialogKey)
	);
	/**
	 * Questions answered here before the log says so. The JSONL records the
	 * answers a moment after the dialog closes, and the card should not flash
	 * back to open in between.
	 */
	let answeredAsks = $state<Record<string, true>>({});
	let lastLiveAsk: { id: string; seen: boolean } | null = null;
	$effect(() => {
		if (liveAskId && dialogClosed) answeredAsks[liveAskId] = true;
		// The hooks can leave `waiting` on the same tick the pane drops the
		// dialog, so a question seen live that stops being live was answered.
		if (lastLiveAsk && lastLiveAsk.id !== liveAskId && lastLiveAsk.seen) {
			answeredAsks[lastLiveAsk.id] = true;
		}
		lastLiveAsk = liveAskId ? { id: liveAskId, seen: seenLive === liveAskId } : null;
	});
	/** The pane's dialog at the foot, when it is not the live question's. */
	const footDialog = $derived(liveAskId === null && paneChoice !== null);

	/**
	 * The turns claude-mux delivered from its queue or as a steer, by entry id.
	 * Each delivery labels the first turn after it that carries its text, so
	 * the same words sent twice label two turns, not one.
	 */
	const deliveredVia = $derived.by(() => {
		const out = new Map<string, DeliveryInfo['via']>();
		for (const d of delivered) {
			const text = d.text.trim();
			// The JSONL stamps the turn a moment after the paste; allow for clock skew.
			const turn = entries.find(
				(e) =>
					// A delivered queued entry is hidden behind its user turn.
					(e.kind === 'user' || (e.kind === 'queued' && !e.delivered)) &&
					!out.has(e.id) &&
					e.ts >= d.at - 5000 &&
					e.text.trim() === text
			);
			if (turn) out.set(turn.id, d.via);
		}
		return out;
	});

	function formatTime(ts: number): string {
		try {
			return new Date(ts).toLocaleTimeString(undefined, {
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return '';
		}
	}

	interface InputField {
		key: string;
		value: string;
	}

	/**
	 * Split a tool's input into the shell command (when it has one), short
	 * key/value rows and long text blocks — one pass, since the template would
	 * otherwise filter the same list three times per render.
	 */
	function inputPanes(
		inputJson: string,
		toolName: string
	): { cmd: string | null; short: InputField[]; long: InputField[] } {
		let entries: [string, unknown][];
		try {
			entries = Object.entries(JSON.parse(inputJson) as Record<string, unknown>);
		} catch {
			return { cmd: null, short: [], long: [{ key: 'input', value: inputJson }] };
		}
		const isShell = toolName.toLowerCase().includes('bash');
		let cmd: string | null = null;
		const short: InputField[] = [];
		const long: InputField[] = [];
		for (const [key, raw] of entries) {
			const value = typeof raw === 'string' ? raw : (JSON.stringify(raw, null, 2) ?? String(raw));
			if (isShell && key === 'command') {
				cmd = value;
			} else if (value.includes('\n') || value.length > 90) {
				long.push({ key, value });
			} else {
				short.push({ key, value });
			}
		}
		return { cmd, short, long };
	}

</script>

{#snippet grill(id: string, round: GrillRound)}
	{@const live = id === liveGrillId && !grillSent[id] && onSendReply != null}
	<!-- A busy session takes the reply into Claude Code's own queue, as the
	     composer's does; only an open dialog would swallow it as keystrokes. -->
	{@const ready = live && sessionState !== 'waiting' && sessionState !== 'permission'}
	{#if round.intro}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
		<div class="assistant-text markdown">{@html renderMarkdown(round.intro)}</div>
	{/if}
	<section class="grill" class:live aria-label="Questions from Claude">
		{#each round.questions as q (q.n)}
			{@const a = answerOf(id, q)}
			<div class="gq" class:skipped={live && a.mode === 'skip'}>
				<span class="gq-n">Q{q.n}</span>
				<div class="gq-main">
					{#if q.title}<p class="gq-title">{q.title}</p>{/if}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
					<div class="gq-body markdown">{@html renderMarkdown(q.body)}</div>
					{#if q.recommended}
						{#if live}
							<button
								type="button"
								class="gq-rec"
								class:on={a.mode === 'accept'}
								aria-pressed={a.mode === 'accept'}
								onclick={() => setAnswer(id, q.n, { mode: 'accept' })}
							>
								<iconify-icon
									icon={a.mode === 'accept' ? 'mdi:check-circle' : 'mdi:circle-outline'}
								></iconify-icon>
								<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
								<span class="markdown">{@html renderMarkdown(q.recommended)}</span>
							</button>
						{:else}
							<div class="gq-rec past">
								<iconify-icon icon="mdi:arrow-right"></iconify-icon>
								<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
								<span class="markdown">{@html renderMarkdown(q.recommended)}</span>
							</div>
						{/if}
					{/if}
					{#if live}
						<div class="gq-own">
							<textarea
								rows="1"
								use:autosize
								placeholder={q.recommended ? 'Or answer in your own words' : 'Your answer'}
								value={ownText(id, q)}
								oninput={(e) => typeAnswer(id, q, e.currentTarget.value)}
								class:filled={a.mode === 'own' && a.text.trim() !== ''}
							></textarea>
							<button
								type="button"
								class="gq-skip"
								class:on={a.mode === 'skip'}
								aria-pressed={a.mode === 'skip'}
								title="Leave this question open for a later round"
								onclick={() =>
									setAnswer(id, q.n, a.mode === 'skip' ? (q.recommended ? { mode: 'accept' } : { mode: 'own', text: '' }) : { mode: 'skip' })}
							>
								{a.mode === 'skip' ? 'Left open' : 'Skip'}
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/each}
		{#if live}
			<footer class="grill-foot">
				<span class="grill-tally">{tally(id, round)}</span>
				<button
					type="button"
					class="grill-send"
					disabled={!ready || grillSending === id}
					title={ready
						? 'Send these answers as your next message'
						: 'Answer the open dialog first; these go in after it'}
					onclick={() => void sendRound(id, round)}
				>
					{grillSending === id ? 'Sending…' : 'Send answers'}
				</button>
			</footer>
		{:else if grillSent[id]}
			<footer class="grill-foot"><span class="grill-tally">Answers sent</span></footer>
		{/if}
	</section>
	{#if round.outro}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
		<div class="assistant-text markdown">{@html renderMarkdown(round.outro)}</div>
	{/if}
{/snippet}

<div class="transcript">
	{#if !loaded}
		<div class="empty">
			<iconify-icon class="spin" icon="mdi:loading" style="font-size: 32px;"></iconify-icon>
			<p>Loading transcript…</p>
		</div>
	{:else if !available && sessionState && sessionState !== 'idle'}
		<!-- The turn is under way; Claude Code writes the log as each block
		     finishes, and the live row below says what it is doing meanwhile. -->
		<div class="empty starting">
			<iconify-icon icon="mdi:text-box-plus-outline" style="font-size: 32px;"></iconify-icon>
			<p>Starting… waiting for the first entry.</p>
		</div>
	{:else if !available}
		<div class="empty">
			<iconify-icon icon="mdi:text-box-search-outline" style="font-size: 32px;"></iconify-icon>
			<p>No transcript for this session yet.</p>
			<p class="hint">It appears as soon as Claude Code writes its session log.</p>
		</div>
	{/if}
	{#if olderCount > 0}
		<div class="earlier">
			<button type="button" disabled={loadingEarlier} onclick={() => onLoadEarlier?.()}>
				<iconify-icon icon={loadingEarlier ? 'mdi:loading' : 'mdi:chevron-double-up'}
				></iconify-icon>
				{loadingEarlier ? 'Loading…' : 'Load earlier'}
			</button>
			<span class="earlier-count">{olderCount} older {olderCount === 1 ? 'entry' : 'entries'}</span>
		</div>
	{/if}
	{#snippet turnGlyph(dictated: boolean)}
		{#if dictated}
			<iconify-icon class="mic-glyph" icon="mdi:microphone" title="dictated"></iconify-icon>
		{:else}
			<span class="prompt-glyph">❯</span>
		{/if}
	{/snippet}
	{#snippet via(id: string)}
		{@const how = deliveredVia.get(id)}
		{#if how}
			<span
				class="via"
				title={how === 'steer' ? 'Steered into the running turn' : 'Sent from the queue'}
				>{how === 'steer' ? 'Steer' : 'Queued'}</span
			>
		{/if}
	{/snippet}
	{#snippet row(entry: TranscriptEntry)}
		{#if entry.kind === 'user'}
			<div class="user-block" class:dictated={entry.dictated} data-entry-id={entry.id}>
				{@render turnGlyph(entry.dictated ?? false)}
				<!-- A slash command is a different kind of turn: not prose the agent
				     read, but an instruction to the harness. Show the command as a
				     token so it is scannable, and its arguments as ordinary prompt
				     text — the raw <command-*> tags never reach the reader. -->
				{#if entry.command}
					<div class="user-text">
						<span class="slash-name">{entry.command.name}</span>{#if entry.command.args}<span
								class="slash-args">{entry.command.args}</span
							>{/if}
						<!-- A local command answers on the spot — "Set model to Fable" —
						     and that answer is the harness's, not the agent's, so it sits
						     under the command rather than as a turn. -->
						{#if entry.command.output}
							<div class="slash-output">{entry.command.output}</div>
						{/if}
					</div>
				{:else}
					<div class="user-text">{entry.text}</div>
				{/if}
				<span class="time">{@render via(entry.id)}{formatTime(entry.ts)}</span>
			</div>
		{:else if entry.kind === 'queued'}
			{#if !entry.delivered}
				<div class="user-block" class:dictated={entry.dictated} data-entry-id={entry.id}>
					{@render turnGlyph(entry.dictated ?? false)}
					<div class="user-text">{entry.text}</div>
					<span class="time" title="sent while the agent was working">
						{@render via(entry.id)}
						<iconify-icon icon="mdi:clock-fast"></iconify-icon>
						{formatTime(entry.ts)}
					</span>
				</div>
			{/if}
		{:else if entry.kind === 'peer'}
			<div class="user-block peer">
				<iconify-icon class="peer-icon" icon="mdi:swap-horizontal"></iconify-icon>
				<div class="peer-body">
					{#if entry.from}<span class="peer-from">{entry.from}</span>{/if}
					<div class="user-text peer-text">{entry.text}</div>
				</div>
				<span class="time peer-time">{formatTime(entry.ts)}</span>
			</div>
		{:else if entry.kind === 'interrupt'}
			<!-- Escape stopped the turn. Claude Code logs it as a user line, but
			     nobody typed it, so it reads as a log note like "Question dismissed". -->
			<div class="row note">
				<iconify-icon icon="mdi:stop-circle-outline"></iconify-icon>
				<span class="row-summary">{entry.text}</span>
				<span class="time">{formatTime(entry.ts)}</span>
			</div>
		{:else if entry.kind === 'compact'}
			<!-- The conversation was folded here. Everything above it is what the
			     model no longer sees; the summary is what it reads instead. -->
			<details class="compact">
				<summary>
					<iconify-icon icon="mdi:arrow-collapse-vertical"></iconify-icon>
					<span class="compact-title">
						Context compacted{entry.trigger === 'manual' ? ' (/compact)' : ' automatically'}
					</span>
					{#if entry.preTokens && entry.postTokens}
						<span class="compact-tokens">
							{Math.round(entry.preTokens / 1000)}k → {Math.round(entry.postTokens / 1000)}k tokens
						</span>
					{/if}
					<span class="time">{formatTime(entry.ts)}</span>
				</summary>
				{#if entry.summary}
					<div class="compact-summary">{@html renderMarkdown(entry.summary)}</div>
				{:else}
					<p class="compact-summary muted">Summary not written yet.</p>
				{/if}
			</details>
		{:else if entry.kind === 'ask'}
			{#if entry.answers || entry.rejected}
				<details class="row ask-done">
					<summary>
						<iconify-icon icon="mdi:chat-question-outline"></iconify-icon>
						<span class="row-summary">
							{#if entry.rejected}
								Question dismissed
							{:else}
								{entry.questions
									.map((q) => `${q.header}: ${entry.answers?.[q.question] ?? '—'}`)
									.join(' · ')}
							{/if}
						</span>
						<iconify-icon class="tool-status ok" icon="mdi:check"></iconify-icon>
					</summary>
					<div class="ask-detail">
						{#each entry.questions as q (q.question)}
							<div class="ask-q-review">
								<span class="ask-header-chip">{q.header}</span>
								<p class="ask-question">{q.question}</p>
								{#each q.options as opt (opt.label)}
									<div class="ask-opt-review" class:chosen={entry.answers?.[q.question] === opt.label}>
										{opt.label}
									</div>
								{/each}
								{#if entry.answers && !q.options.some((o) => o.label === entry.answers?.[q.question])}
									<div class="ask-opt-review chosen">{entry.answers?.[q.question]}</div>
								{/if}
							</div>
						{/each}
					</div>
				</details>
			{:else if entry.id === liveAskId || answeredAsks[entry.id]}
				<DialogCard
					ask={entry}
					choice={entry.id === liveAskId ? paneChoice : null}
					permission={sessionState === 'permission'}
					closed={entry.id !== liveAskId || dialogClosed}
					onKeys={(keys) => onSendKeys?.(keys)}
					onText={(text) => onSendPaneText?.(text)}
					onSubmitted={() => (submitted = entry.id)}
				/>
			{:else}
				<div class="row note">
					<iconify-icon icon="mdi:chat-question-outline"></iconify-icon>
					<span class="row-summary">
						Question not answered: {entry.questions.map((q) => q.header).join(' · ')}
					</span>
					<span class="time">{formatTime(entry.ts)}</span>
				</div>
			{/if}
		{:else if entry.kind === 'text' && grillRound(entry.text)}
			{@render grill(entry.id, grillRound(entry.text)!)}
		{:else if entry.kind === 'text'}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
			<div class="assistant-text markdown">{@html renderMarkdown(entry.text)}</div>
		{:else if entry.kind === 'thinking'}
			<details class="row thinking">
				<summary>
					<iconify-icon icon="mdi:thought-bubble-outline"></iconify-icon>
					<span class="row-summary">Thinking</span>
				</summary>
				<div class="thinking-text">{entry.text}</div>
			</details>
		{:else if entry.kind === 'tool'}
			{@const input = inputPanes(entry.input, entry.name)}
			{@const showResult = entry.result != null && !(entry.patch && entry.result.ok)}
			{@const sub = subagents[entry.id]}
			{@const doing = sub?.running ? sub.activity[sub.activity.length - 1] : null}
			<details
				class="row tool-card"
				class:error={entry.result?.ok === false}
				class:agent={sub != null}
				data-entry-id={entry.id}
				open={opened[entry.id] ?? false}
				ontoggle={(e) => {
					opened[entry.id] = e.currentTarget.open;
					if (sub && !sub.full && e.currentTarget.open) onLoadSubagent?.(sub.agentId);
				}}
			>
				<summary>
					<iconify-icon class="tool-icon" icon={toolIcon(entry.name)}></iconify-icon>
					{#if sub}
						<span class="row-summary agent-line">
							<span class="agent-name">{sub.description ?? entry.summary}</span>
							{#if sub.agentType}<span class="agent-type">{sub.agentType}</span>{/if}
							{#if doing}
								<span class="agent-doing mono"><ToolLabel name={doing.name} summary={doing.summary} /></span>
							{:else if sub.activity.length > 0}
								<span class="agent-count">{sub.activity.length} tools</span>
							{/if}
						</span>
						{#if agentLink}
							<a
								class="tool-open"
								href={agentLink(sub.agentId)}
								title="Open agent"
								aria-label="Open agent"
								onclick={(e) => e.stopPropagation()}
							>
								<iconify-icon icon="mdi:open-in-new"></iconify-icon>
							</a>
						{/if}
					{:else}
						<span class="row-summary mono"><ToolLabel name={entry.name} summary={entry.summary} /></span>
						{@const opens = fileLink ? toolFileTarget(entry) : null}
						{#if opens && fileLink}
							<a
								class="tool-open"
								href={fileLink(opens.path, opens.line)}
								title="Open in Files{opens.line ? ` at line ${opens.line}` : ''}"
								aria-label="Open in Files"
								data-sveltekit-noscroll
								data-sveltekit-keepfocus
								onclick={(e) => e.stopPropagation()}
							>
								<iconify-icon icon="mdi:file-eye-outline"></iconify-icon>
							</a>
						{/if}
					{/if}
					{#if entry.result}
						<iconify-icon
							class="tool-status {entry.result.ok ? 'ok' : 'fail'}"
							icon={entry.result.ok ? 'mdi:check' : 'mdi:alert-circle-outline'}
						></iconify-icon>
					{:else}
						<iconify-icon class="tool-status running spin" icon="mdi:loading"></iconify-icon>
					{/if}
				</summary>
				{#if sub}
					<div class="agent-detail">
						<div class="agent-meta">
							{#if sub.model}<span class="agent-chip">{sub.model}</span>{/if}
							<span class="agent-chip">{sub.activity.length} tools</span>
							{#if sub.running}<span class="agent-chip live">running</span>{/if}
						</div>
						{#if sub.trimmed > 0}
							<div class="agent-trimmed">{sub.trimmed} earlier calls not shown</div>
						{/if}
						<ol class="agent-activity">
							{#each sub.activity as act (act.id)}
								<li class:pending={act.ok === null} class:failed={act.ok === false}>
									<iconify-icon class="tool-icon" icon={toolIcon(act.name)}></iconify-icon>
									<span class="mono"><ToolLabel name={act.name} summary={act.summary} /></span>
								</li>
							{/each}
						</ol>
						{#if sub.report}
							<div class="agent-report">
								<header class="pane-head">Report</header>
								<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown output with raw HTML escaped above -->
								<div class="markdown">{@html renderMarkdown(sub.report)}</div>
							</div>
						{/if}
					</div>
				{:else}
				<div class="tool-detail" class:two-col={showResult && !entry.patch}>
					{#if entry.patch}
						<section class="pane diff-pane">
							<header class="pane-head">
								Diff
								{#if entry.patch.file}<span class="diff-file">{entry.patch.file.split('/').pop()}</span>{/if}
							</header>
							<pre class="diff">{#each entry.patch.hunks as hunk, hi (hi)}<span class="diff-hunk">{hunk.header}</span>{'\n'}{#each hunk.lines as dl, li (li)}<span
										class={dl.startsWith('+') ? 'diff-add' : dl.startsWith('-') ? 'diff-del' : 'diff-ctx'}>{dl}</span>{'\n'}{/each}{/each}</pre>
						</section>
					{:else if input.cmd || input.short.length > 0 || input.long.length > 0}
						<section class="pane">
							<header class="pane-head">Input</header>
							{#if input.cmd}
								<pre class="cmd"><span class="cmd-glyph">$</span> {input.cmd}</pre>
							{/if}
							{#each input.short as field (field.key)}
								<div class="kv"><span class="k">{field.key}</span><span class="v">{field.value}</span></div>
							{/each}
							{#each input.long as field (field.key)}
								<div class="kv-long">
									<span class="k">{field.key}</span>
									<pre>{field.value}</pre>
								</div>
							{/each}
						</section>
					{/if}
					{#if showResult && entry.result}
						<section class="pane result" class:ok={entry.result.ok} class:fail={!entry.result.ok}>
							<header class="pane-head">{entry.result.ok ? 'Result' : 'Error'}</header>
							{#each entry.result.images ?? [] as path, i (i)}
								{@const src = `/api/files/image?path=${encodeURIComponent(path)}`}
								<a class="result-image" href={src} target="_blank" rel="noopener">
									<img {src} alt={path.split('/').pop()} loading="lazy" />
								</a>
							{/each}
							{#if entry.result.output || !entry.result.images}
								<pre>{entry.result.output || '(no output)'}</pre>
							{/if}
						</section>
					{/if}
					</div>
				{/if}
			</details>
		{/if}
	{/snippet}
	{#each items as item (item.id)}
		{#if item.kind === 'group'}
			<!-- A run of routine calls, folded the way the terminal folds it. Open,
			     it is the same rows the run would have drawn on its own. -->
			<details
				class="row tool-group"
				open={opened[`group:${item.id}`] ?? opened[item.id] ?? false}
				ontoggle={(e) => (opened[`group:${item.id}`] = e.currentTarget.open)}
			>
				<summary>
					<iconify-icon class="tool-icon" icon="mdi:layers-outline"></iconify-icon>
					<span class="row-summary">{item.summary}</span>
					{#if item.failed > 0}
						<span class="group-failed">{item.failed} failed</span>
						<iconify-icon class="tool-status fail" icon="mdi:alert-circle-outline"></iconify-icon>
					{:else}
						<iconify-icon class="tool-status ok" icon="mdi:check"></iconify-icon>
					{/if}
				</summary>
				<div class="group-rows">
					{#each item.entries as entry (entry.id)}
						{@render row(entry)}
					{/each}
				</div>
			</details>
		{:else}
			{@render row(item)}
		{/if}
		{@const changed = turnCards.get(item.id)}
		{#if changed && changesLink}
			<TurnChangesCard
				turn={changed}
				root={turnChanges?.root ?? null}
				bind:open={() => cardOpen[changed.id!] ?? changed.id === latestCard, (v) => (cardOpen[changed.id!] = v)}
				link={(file) => changesLink(changed.n, file)}
			/>
		{/if}
	{/each}

	{#if footDialog}
		<DialogCard
			choice={paneChoice}
			permission={sessionState === 'permission'}
			onKeys={(keys) => onSendKeys?.(keys)}
			onText={(text) => onSendPaneText?.(text)}
		/>
	{/if}

	<!-- Live status: driven by hooks, which fire the instant a tool starts;
	     the JSONL itself is written in batches and lags by seconds. -->
	{#if sessionState === 'busy'}
		<div class="live-row busy">
			<SessionStateIndicator state="busy" />
			{#if activity}
				<span class="live-verb mono">{activity.verb}</span>
				<span class="live-chips">
					{#if activity.doing}
						<Badge variant="outline" class="{CHIP} min-w-0 shrink justify-start text-[#a8a29e]">
							<span class="truncate">{activity.doing}</span>
						</Badge>
					{/if}
					{#if elapsedText}<Badge variant="outline" class="{CHIP} font-mono">{elapsedText}</Badge>{/if}
					{#if activity.tokens}
						<Badge variant="outline" class="{CHIP} font-mono"
							>{activity.tokens.dir === 'up' ? '↑' : '↓'} {activity.tokens.count} tokens</Badge
						>
					{/if}
					{#if activity.thinking}<Badge variant="outline" class={CHIP}>{activity.thinking}</Badge>{/if}
				</span>
			{:else}
				<span class="live-text mono">{currentAction ?? 'Working…'}</span>
			{/if}
		</div>
	{:else if sessionState === 'permission' || sessionState === 'waiting'}
		{@const state = sessionState}
		<div class="live-row attention" style="color: {sessionStateVisual(state).color}">
			<SessionStateIndicator {state} />
			<span class="live-text">
				{#if dialogClosed}
					Answer sent — waiting for Claude to carry on
				{:else if liveAskId || footDialog}
					Waiting for your answer — answer in the card above ↑
				{:else if state === 'permission'}
					Waiting for permission — reading the dialog, or switch to terminal view to respond
				{:else}
					Question incoming… answer here when it appears, or in the terminal view
				{/if}
			</span>
		</div>
	{/if}

	{#if suggestion}
		<!-- Claude's own next-prompt proposal, drawn as the same not-yet-happened
		     turn anchor as a queued message — but in the suggestion's blue, and
		     tappable: accepting is the only interaction it has. -->
		<button
			type="button"
			class="user-block pending suggested"
			onclick={onAcceptSuggestion}
			title="Accept Claude's suggestion"
		>
			<span class="prompt-glyph">❯</span>
			<div class="user-text">{suggestion}</div>
			<span class="time suggested-tag" title="Claude's suggested next prompt — tap to accept">
				<iconify-icon icon="mdi:star-four-points-outline"></iconify-icon>
				suggested · accept <kbd>&#8677;</kbd>
			</span>
		</button>
	{/if}
</div>

<style>
	.transcript {
		width: 100%;
		max-width: 860px;
		margin: 0 auto;
		/* Assistant prose reads as text, not terminal output — deliberate contrast
		   with the mono user prompts and tool rows (the terminal's vernacular). */
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		--mono: var(--font-mono);
		font-size: 14.5px;
		line-height: 1.65;
		color: #d6d3d1;
		padding-bottom: 8px;
		/* The .output host is a terminal container with pre-wrap; without this,
		   the newlines marked emits between blocks render as visible gaps. */
		white-space: normal;
		container-type: inline-size;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 56px 16px;
		color: #78716c;
		text-align: center;
	}
	.empty.starting {
		padding-bottom: 24px;
	}
	.empty.starting iconify-icon {
		animation: starting-breathe 1.8s ease-in-out infinite;
	}
	@keyframes starting-breathe {
		50% {
			opacity: 0.4;
		}
	}
	.empty .hint {
		font-size: 12px;
		color: #57534e;
	}

	/* --- The head of a windowed transcript: quiet, since the reader who wants
	   older turns is looking for it and everyone else is reading downward. --- */
	.earlier {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 8px 12px;
		padding: 14px 8px 18px;
		border-bottom: 1px solid #292524;
		margin-bottom: 8px;
	}
	.earlier button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		border: 1px solid #44403c;
		border-radius: 999px;
		background: #1c1917;
		color: #d6d3d1;
		font-size: 12px;
		cursor: pointer;
	}
	.earlier button:hover {
		border-color: #57534e;
		color: #fafaf9;
	}
	.earlier button[disabled] {
		opacity: 0.6;
		cursor: default;
	}
	.earlier-count {
		font-size: 11px;
		color: #78716c;
	}

	/* --- User prompt: the turn anchor, in the terminal's own voice.
	   The one place this view spends visual weight: a warm panel against the
	   cool-dark tool cards, so turns are findable when scrolling fast. --- */
	.user-block {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin: 30px 0 12px;
		padding: 10px 12px;
		background: #241d12;
		border: 1px solid #46351c;
		border-left: 3px solid #d97706;
		border-radius: 8px;
	}
	.user-block:first-child {
		margin-top: 6px;
	}
	/* Queued in the terminal: the same turn anchor, drawn as an outline because
	   it has not happened yet. */
	.user-block.pending {
		background: transparent;
		border-style: dashed;
		border-left-style: solid;
		border-left-color: #7c5e2a;
		margin: 12px 0;
	}
	.user-block.pending .prompt-glyph,
	.user-block.pending .user-text {
		color: #8f8578;
	}
	/* Claude's suggestion: the queued anchor's shape, in the one colour nothing
	   else in the app uses — and clickable, because tapping accepts it. */
	.user-block.suggested {
		width: 100%;
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-color: #3b3b5c;
		border-left-color: #6366f1;
	}
	.user-block.suggested:hover {
		background: #14141c;
	}
	.user-block.suggested:focus-visible {
		outline: 2px solid #818cf8;
		outline-offset: -2px;
	}
	.user-block.suggested .prompt-glyph {
		color: #818cf8;
	}
	/* Ghost text reads faint in the terminal; keep it reading that way here. */
	.user-block.suggested .user-text {
		color: #8b8fb0;
	}
	.user-block.suggested .suggested-tag {
		color: #a5b4fc;
	}
	.suggested-tag kbd {
		font: inherit;
		padding: 0 4px;
		border: 1px solid #3a3a52;
		border-radius: 3px;
	}
	/* How a turn got there, when claude-mux delivered it for you. */
	.via {
		margin-right: 6px;
		padding: 0 5px;
		border-radius: 4px;
		background: #292524;
		color: #a8a29e;
		font-size: 10px;
	}

	.prompt-glyph,
	.mic-glyph {
		flex-shrink: 0;
		width: 14px;
		font-family: var(--mono);
		font-weight: 700;
		font-size: 14px;
		color: #f59e0b;
	}
	/* Dictated prompt: same turn anchor, warmed toward coral — spoken, not
	   typed — with the microphone standing where the prompt glyph would be. */
	.user-block.dictated {
		background: #261418;
		border-color: #492530;
		border-left-color: #e0566f;
	}
	.mic-glyph {
		color: #fb7185;
		align-self: baseline;
		transform: translateY(2px);
	}
	.user-block.dictated .user-text {
		color: #fde8e8;
	}
	.user-text {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
		font-size: 13px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		color: #fef3c7;
	}
	/* Slash command: the name reads as a token, its arguments as plain prompt
	   text — the same distinction the terminal's own input line makes. */
	.slash-name {
		padding: 1px 6px;
		border: 1px solid #6b4c1a;
		border-radius: 5px;
		background: #33260f;
		color: #fbbf24;
		font-weight: 600;
	}
	.slash-args {
		margin-left: 8px;
	}
	/* What the command printed back, in the harness's voice: quieter than the
	   prompt, and kept as printed. */
	.slash-output {
		margin-top: 5px;
		padding-left: 10px;
		border-left: 2px solid #6b4c1a;
		color: #b8a87a;
		font-size: 12.5px;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.time {
		flex-shrink: 0;
		font-size: 10px;
		color: #8a7a55;
		font-variant-numeric: tabular-nums;
	}

	.time iconify-icon {
		font-size: 12px;
		vertical-align: -2px;
	}

	/* Cross-session (A2A) message: same anchor shape as a human turn, cool
	   teal instead of warm amber — another agent's voice, not the user's. */
	.user-block.peer {
		background: #10201f;
		border-color: #1e3d3a;
		border-left-color: #14b8a6;
	}
	.peer-icon {
		flex-shrink: 0;
		align-self: baseline;
		font-size: 15px;
		color: #2dd4bf;
	}
	.peer-body {
		flex: 1;
		min-width: 0;
	}
	.peer-from {
		display: block;
		font-family: var(--mono);
		font-size: 10.5px;
		font-weight: 700;
		color: #2dd4bf;
		margin-bottom: 2px;
	}
	.peer-text {
		color: #d8f3ef;
	}
	.peer-time {
		color: #3f6f68;
	}

	/* Agent activity sits slightly indented under its prompt anchor — the
	   amber panel alone carries the turn structure, no rail needed. */
	.assistant-text,
	.row {
		margin-left: 12px;
	}

	/* --- Assistant prose --- */
	.assistant-text {
		margin-top: 10px;
		margin-bottom: 10px;
		word-break: break-word;
	}

	/* --- Collapsible rows (tools + thinking): closed, they read as slim log
	   lines — no box, dimmed, clearly "machine activity" next to the prose.
	   The card chrome only appears when a row is opened. --- */
	.row {
		margin-top: 1px;
		margin-bottom: 1px;
		border: 1px solid transparent;
		border-radius: 7px;
		background: transparent;
	}
	.row[open] {
		margin-top: 6px;
		margin-bottom: 8px;
		border-color: #262220;
		background: #1b1816;
	}
	.row summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 8px;
		cursor: pointer;
		list-style: none;
		user-select: none;
		font-size: 12.5px;
		color: #8a837c;
		border-radius: 7px;
		transition: background 0.12s;
	}
	.row summary:hover {
		background: #201c18;
		color: #c7c2bd;
	}
	.row summary::-webkit-details-marker {
		display: none;
	}
	.row[open] > summary {
		padding: 5px 10px;
		color: #c7c2bd;
		border-bottom: 1px solid #262220;
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	/* A row with nothing to open: the closed summary's look, no hover. */
	.row.note {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 8px;
		font-size: 12.5px;
		color: #8a837c;
	}
	.row-summary {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mono {
		font-family: var(--mono);
		font-size: 12px;
		color: inherit;
	}

	.tool-icon {
		flex-shrink: 0;
		color: #78716c;
		font-size: 15px;
	}
	.tool-status {
		flex-shrink: 0;
		font-size: 14px;
	}
	.tool-open {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		margin: -4px 0;
		border-radius: 6px;
		color: #78716c;
		font-size: 14px;
	}
	.tool-open:hover {
		background: #262626;
		color: #e7e5e4;
	}
	.tool-status.ok {
		color: #4d7c5f;
	}
	.tool-status.fail {
		color: #f87171;
	}
	.tool-status.running {
		color: #d97706;
	}
	.tool-card.error {
		border-color: rgba(127, 29, 29, 0.6);
	}
	/* A folded run opens in place, without a card of its own: its rows hang off
	   a thin rule under the summary, so a call opened inside it still reads as
	   the one card on the screen. */
	.tool-group[open] {
		border-color: transparent;
		background: transparent;
	}
	.tool-group[open] > summary {
		padding: 2px 8px;
		border-bottom: none;
		border-radius: 7px;
	}
	.group-rows {
		margin: 2px 0 6px 15px;
		padding-left: 8px;
		border-left: 1px solid #292524;
	}
	.group-failed {
		flex-shrink: 0;
		font-size: 11.5px;
		color: #f87171;
	}
	.spin {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.tool-detail {
		display: grid;
		grid-template-columns: 1fr;
		gap: 8px;
		padding: 8px 10px 10px;
	}
	/* Input and result share the row when there is room — the card stays short. */
	@container (min-width: 700px) {
		.tool-detail.two-col {
			grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
		}
	}
	.pane {
		min-width: 0;
		background: #14110e;
		border: 1px solid #221e1a;
		border-radius: 6px;
		padding: 6px 9px 8px;
	}
	.pane.result.ok {
		border-color: #1f2b22;
		background: #10140f;
	}
	.pane.result.fail {
		border-color: #3d1d1d;
		background: #171010;
	}
	.pane-head {
		font-size: 9.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: #6b6560;
		margin-bottom: 5px;
	}
	.pane.result.ok .pane-head {
		color: #5f8a6e;
	}
	.pane.result.fail .pane-head {
		color: #d16b6b;
	}
	.result-image {
		display: block;
		margin-bottom: 6px;
	}
	.result-image img {
		display: block;
		max-width: 100%;
		max-height: 320px;
		border: 1px solid #221e1a;
		border-radius: 4px;
	}
	.pane pre {
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.5;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 260px;
		overflow-y: auto;
		margin: 0;
	}
	.diff-file {
		margin-left: 8px;
		text-transform: none;
		letter-spacing: 0;
		font-size: 11px;
		font-weight: 400;
		color: #a8a29e;
		font-family: var(--mono);
	}
	.diff-hunk {
		color: #7d96b8;
	}
	.diff-add {
		color: #b7e0ae;
		background: rgba(46, 160, 67, 0.14);
		display: inline-block;
		width: 100%;
	}
	.diff-del {
		color: #f0b0aa;
		background: rgba(248, 81, 73, 0.13);
		display: inline-block;
		width: 100%;
	}
	.diff-ctx {
		color: #7d7871;
	}

	.cmd {
		color: #e7e5e4;
	}
	.cmd-glyph {
		color: #d97706;
		font-weight: 700;
		user-select: none;
	}
	.kv {
		display: flex;
		gap: 8px;
		align-items: baseline;
		font-size: 11.5px;
		margin-top: 4px;
		min-width: 0;
	}
	.kv-long {
		margin-top: 6px;
	}
	.k {
		flex-shrink: 0;
		font-family: var(--mono);
		font-size: 10.5px;
		color: #6b6560;
	}
	.kv-long .k {
		display: block;
		margin-bottom: 3px;
	}
	.v {
		font-family: var(--mono);
		color: #c7c2bd;
		overflow-wrap: anywhere;
		min-width: 0;
	}

	/* --- A grilling round: questions as a form. Amber while it waits on you,
	   the colour every surface keeps for "a person is needed"; the numbers sit
	   in a gutter of their own because the round is read in order. --- */
	.grill {
		margin: 12px 0 14px;
		border: 1px solid #2a2a2c;
		border-radius: 10px;
		background: #161514;
	}
	.grill.live {
		border-color: #5a4310;
		border-left: 3px solid #f59e0b;
		background: #1a1712;
	}
	.gq {
		display: grid;
		grid-template-columns: 34px 1fr;
		padding: 12px 14px 12px 0;
	}
	.gq + .gq {
		border-top: 1px solid #262320;
	}
	.gq.skipped .gq-main {
		opacity: 0.55;
	}
	.gq-n {
		font-family: var(--mono);
		font-size: 12px;
		/* The title's line box, so the number sits on the title's baseline. */
		line-height: calc(14.5px * 1.65);
		color: #78716c;
		text-align: right;
		padding-right: 10px;
	}
	.live .gq-n {
		color: #fbbf24;
	}
	.gq-main {
		min-width: 0;
	}
	.gq-title {
		margin: 0 0 2px;
		font-weight: 600;
		color: #f5f5f4;
	}
	.gq-body {
		color: #d6d3d1;
	}
	.gq-rec {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		margin-top: 9px;
		padding: 8px 10px;
		border: 1px dashed #44403c;
		border-radius: 8px;
		background: transparent;
		color: #a8a29e;
		font: inherit;
		font-size: 13.5px;
		line-height: 1.55;
		text-align: left;
	}
	button.gq-rec {
		cursor: pointer;
	}
	button.gq-rec:hover {
		border-color: #78716c;
		color: #d6d3d1;
	}
	.gq-rec.on {
		border-style: solid;
		border-color: #a16207;
		background: #2a2112;
		color: #fde68a;
	}
	.gq-rec iconify-icon {
		flex: none;
		font-size: 16px;
		margin-top: 2px;
	}
	.gq-rec.on iconify-icon {
		color: #fbbf24;
	}
	.gq-rec.past {
		border-style: solid;
		border-color: #292524;
		color: #a8a29e;
	}
	.gq-rec .markdown {
		min-width: 0;
	}
	.gq-own {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin-top: 6px;
	}
	.gq-own textarea {
		flex: 1;
		min-width: 0;
		max-height: 160px;
		resize: none;
		padding: 6px 10px;
		border: 1px solid #292524;
		border-radius: 8px;
		background: #121110;
		color: #e7e5e4;
		font: inherit;
		font-size: 13.5px;
		line-height: 1.5;
		outline: none;
	}
	.gq-own textarea::placeholder {
		color: #57534e;
	}
	.gq-own textarea:focus {
		border-color: #78716c;
	}
	.gq-own textarea.filled {
		border-color: #a16207;
	}
	.gq-skip {
		flex: none;
		height: 32px;
		padding: 0 10px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		color: #78716c;
		font-size: 12px;
		cursor: pointer;
	}
	.gq-skip:hover,
	.gq-skip.on {
		border-color: #292524;
		color: #d6d3d1;
	}
	.grill-foot {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px 12px 34px;
		border-top: 1px solid #262320;
	}
	.grill-tally {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
		font-size: 11.5px;
		color: #a8a29e;
	}
	.grill-send {
		flex: none;
		height: 34px;
		padding: 0 16px;
		border: 0;
		border-radius: 8px;
		background: #f59e0b;
		color: #1c1307;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}
	.grill-send:hover:not(:disabled) {
		background: #fbbf24;
	}
	.grill-send:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.gq-rec:focus-visible,
	.gq-skip:focus-visible,
	.grill-send:focus-visible {
		outline: 2px solid #fbbf24;
		outline-offset: 2px;
	}
	@media (pointer: coarse) {
		.gq-skip,
		.grill-send {
			height: 40px;
		}
	}

	/* --- AskUserQuestion, once answered: a log line that opens to the
	   choices. The open dialog is DialogCard's. --- */
	.ask-header-chip {
		display: inline-block;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #a8a29e;
		background: #262220;
		border-radius: 4px;
		padding: 1px 7px;
		margin-bottom: 4px;
	}
	.ask-question {
		font-weight: 500;
		color: #d6d3d1;
		margin: 4px 0 6px;
	}
	/* Answered question: review layout inside the collapsed row */
	.ask-detail {
		padding: 8px 12px 10px;
	}
	.ask-q-review + .ask-q-review {
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px solid #262220;
	}
	.ask-opt-review {
		font-size: 12.5px;
		color: #78716c;
		padding: 2px 8px;
		border-left: 2px solid transparent;
	}
	.ask-opt-review.chosen {
		color: #e7e5e4;
		border-left-color: #4d7c5f;
		background: #161a16;
		border-radius: 3px;
	}

	/* --- Subagent Task card: the one row that carries hierarchy. Closed, it
	   reports what its agent is doing right now; open, it becomes that agent's
	   own activity log and final report. --- */
	.tool-card.agent[open] {
		border-color: #33302a;
	}
	.agent-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.agent-name {
		min-width: 0;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		color: #d6d3d1;
	}
	.agent-type {
		flex-shrink: 0;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #9b8fd4;
		background: #221f2e;
		border-radius: 4px;
		padding: 1px 6px;
	}
	.agent-doing,
	.agent-count {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11.5px;
		color: #7d7871;
	}
	.agent-doing::before {
		content: '● ';
		color: #34d399;
	}

	.agent-detail {
		padding: 8px 12px 10px;
	}
	.agent-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-bottom: 8px;
	}
	.agent-chip {
		font-size: 10px;
		color: #a8a29e;
		background: #232019;
		border-radius: 4px;
		padding: 1px 7px;
	}
	.agent-chip.live {
		color: #6ee7b7;
		background: #14251d;
	}
	.agent-activity {
		list-style: none;
		margin: 0;
		padding: 0 0 0 11px;
		border-left: 2px solid #2b2622;
		/* Agents reach 150+ calls; scroll inside the card instead of growing it. */
		max-height: 260px;
		overflow-y: auto;
	}
	.agent-trimmed {
		font-size: 10.5px;
		color: #6b6560;
		margin-bottom: 3px;
	}
	.agent-activity li {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 1px 0;
		font-size: 11.5px;
		color: #8a837c;
		min-width: 0;
	}
	.agent-activity li span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.agent-activity li.pending {
		color: #d6d3d1;
	}
	.agent-activity li.failed {
		color: #f0b0aa;
	}
	.agent-report {
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px solid #262220;
		font-size: 13.5px;
	}

	/* --- Compaction boundary: a fold line across the conversation --- */
	.compact {
		margin: 22px 0 14px;
		border: 1px dashed #3a3a42;
		border-radius: 8px;
		background: #121216;
		font-size: 12.5px;
	}
	.compact summary {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 8px 12px;
		list-style: none;
		cursor: pointer;
		color: #a8a29e;
	}
	.compact summary::-webkit-details-marker {
		display: none;
	}
	.compact summary iconify-icon {
		font-size: 15px;
		color: #a78bfa;
	}
	.compact-title {
		color: #c4b5fd;
	}
	.compact-tokens {
		font-family: var(--mono);
		font-size: 11px;
		color: #78716c;
	}
	.compact summary .time {
		margin-left: auto;
	}
	.compact-summary {
		padding: 4px 14px 12px;
		border-top: 1px dashed #3a3a42;
		font-size: 13px;
		line-height: 1.55;
		color: #a8a29e;
	}
	.compact-summary.muted {
		color: #57534e;
	}

	/* --- Live status row --- */
	.live-row {
		display: flex;
		align-items: center;
		gap: 9px;
		margin: 8px 0 4px 12px;
		font-size: 12.5px;
		color: #a8a29e;
	}
	.live-verb {
		flex: none;
		color: #d6d3d1;
	}
	.live-chips {
		display: flex;
		gap: 5px;
		min-width: 0;
		overflow: hidden;
	}
	.live-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (prefers-reduced-motion: reduce) {
		.spin,
		.empty.starting iconify-icon {
			animation: none;
		}
	}

	.thinking summary {
		color: #6b6560;
		font-style: italic;
	}
	.thinking-text {
		padding: 8px 12px;
		white-space: pre-wrap;
		word-break: break-word;
		color: #78716c;
		font-size: 13px;
		font-style: italic;
	}
</style>
