<script lang="ts">
	import { Marked } from 'marked';
	import type { TranscriptEntry } from '../../../../src/transcript/parser';
	import { keysForAnswer } from '$shared/tmux/answer-keys.js';
	import type { SubagentPayload } from '$lib/stores/transcript.svelte';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';
	import { sessionStateVisual } from '$shared/session-state.js';
	import type { QueuedMessageKind } from '$shared/server/message-queue.js';

	type AskEntry = Extract<TranscriptEntry, { kind: 'ask' }>;

	let {
		entries,
		available,
		loaded,
		sessionState = null,
		currentAction = null,
		queueCount = 0,
		queueHeadText = null,
		queueHeadKind = null,
		paneQueue = [],
		subagents = {},
		onSendKeys,
		onOpenTerminal,
		olderCount = 0,
		loadingEarlier = false,
		onLoadEarlier
	}: {
		entries: TranscriptEntry[];
		available: boolean;
		/** False while the first snapshot is still in flight. */
		loaded: boolean;
		/** Live session state from the hooks (real-time, unlike the JSONL which lags). */
		sessionState?: 'busy' | 'idle' | 'waiting' | 'permission' | null;
		currentAction?: string | null;
		/** Messages waiting in claude-mux's own send queue. */
		queueCount?: number;
		/** The next queued message's text, so the row can name what it is waiting on. */
		queueHeadText?: string | null;
		/** Whether that message is the user's, or one claude-mux queued for itself. */
		queueHeadKind?: QueuedMessageKind | null;
		/** Messages waiting in Claude Code's own queue, typed into the terminal. */
		paneQueue?: string[];
		/** Sends a tmux key sequence (space-separated) to answer a question dialog. */
		onSendKeys?: (keys: string) => void;
		/** Switches to the terminal view (for "Other" / free-text answers). */
		onOpenTerminal?: () => void;
		/** Subagent work, keyed by the Task tool_use id that spawned it. */
		subagents?: Record<string, SubagentPayload>;
		/** Entries the server holds before the ones passed in `entries`. */
		olderCount?: number;
		/** A request for those older entries is in flight. */
		loadingEarlier?: boolean;
		/**
		 * Asks for the next slice of older entries. Called before they render,
		 * so the scroll container can note where the reader was.
		 */
		onLoadEarlier?: () => void;
	} = $props();

	/** Local multi-select staging + sequential-question progress per ask card. */
	let askSelections = $state<Record<string, Set<number>>>({});
	let askProgress = $state<Record<string, number>>({});

	/** Only the newest unanswered dialog can be driven — older cards are history. */
	const canAnswer = $derived(sessionState === 'waiting' && onSendKeys != null);
	const liveAskId = $derived(
		canAnswer
			? (entries.findLast((e) => e.kind === 'ask' && !e.answers && !e.rejected)?.id ?? null)
			: null
	);

	/**
	 * A message claude-mux queued and has already pasted into the pane appears in
	 * both queues. The transcript entry is the richer record, so drop the echo.
	 */
	const pendingInPane = $derived(
		paneQueue.length === 0
			? []
			: paneQueue.filter(
					(text) =>
						!entries.some(
							(e) => e.kind === 'queued' && !e.delivered && e.text.trim() === text.trim()
						)
				)
	);

	function askActive(entryId: string, qIndex: number): boolean {
		return canAnswer && entryId === liveAskId && (askProgress[entryId] ?? 0) === qIndex;
	}

	function pickOption(entry: AskEntry, qIndex: number, optIndex: number) {
		if (!askActive(entry.id, qIndex)) return;
		const question = entry.questions[qIndex];
		if (question.multiSelect) {
			const set = new Set(askSelections[entry.id] ?? []);
			if (set.has(optIndex)) set.delete(optIndex);
			else set.add(optIndex);
			askSelections[entry.id] = set;
			return;
		}
		submitAnswer(entry, qIndex, [optIndex]);
	}

	function confirmMulti(entry: AskEntry, qIndex: number) {
		if (!askActive(entry.id, qIndex)) return;
		submitAnswer(entry, qIndex, [...(askSelections[entry.id] ?? [])]);
	}

	function submitAnswer(entry: AskEntry, qIndex: number, picks: number[]) {
		const keys = keysForAnswer(picks, entry.questions[qIndex]);
		if (!keys) return;
		onSendKeys?.(keys);
		askProgress[entry.id] = qIndex + 1;
		delete askSelections[entry.id];
	}

	function escapeHtml(text: string): string {
		return text
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;');
	}

	// Raw HTML in model output is rendered as literal text, not injected.
	// breaks:false — the model writes standard markdown; hard-breaking every
	// newline doubles the vertical rhythm inside lists and paragraphs.
	const marked = new Marked({
		gfm: true,
		breaks: false,
		renderer: {
			html({ raw }) {
				return escapeHtml(raw);
			}
		}
	});

	function renderMarkdown(text: string): string {
		try {
			return marked.parse(text, { async: false });
		} catch {
			return `<pre>${escapeHtml(text)}</pre>`;
		}
	}

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

	function toolIcon(name: string): string {
		const n = name.toLowerCase();
		if (n.includes('bash') || n.includes('command')) return 'mdi:console';
		if (n.includes('edit') || n.includes('write') || n.includes('notebook')) return 'mdi:file-edit-outline';
		if (n.includes('read')) return 'mdi:file-eye-outline';
		if (n.includes('grep') || n.includes('glob') || n.includes('search')) return 'mdi:magnify';
		if (n.includes('task') || n.includes('agent')) return 'mdi:robot-outline';
		if (n.includes('web')) return 'mdi:web';
		if (n.includes('todo')) return 'mdi:checkbox-marked-outline';
		return 'mdi:tools';
	}
</script>

<div class="transcript">
	{#if !loaded}
		<div class="empty">
			<iconify-icon class="spin" icon="mdi:loading" style="font-size: 32px;"></iconify-icon>
			<p>Loading transcript…</p>
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
	{#each entries as entry (entry.id)}
		{#if entry.kind === 'user'}
			<div class="user-block">
				<span class="prompt-glyph">❯</span>
				<!-- A slash command is a different kind of turn: not prose the agent
				     read, but an instruction to the harness. Show the command as a
				     token so it is scannable, and its arguments as ordinary prompt
				     text — the raw <command-*> tags never reach the reader. -->
				{#if entry.command}
					<div class="user-text">
						<span class="slash-name">{entry.command.name}</span>{#if entry.command.args}<span
								class="slash-args">{entry.command.args}</span
							>{/if}
					</div>
				{:else}
					<div class="user-text">{entry.text}</div>
				{/if}
				<span class="time">{formatTime(entry.ts)}</span>
			</div>
		{:else if entry.kind === 'queued'}
			{#if !entry.delivered}
				<div class="user-block">
					<span class="prompt-glyph">❯</span>
					<div class="user-text">{entry.text}</div>
					<span class="time" title="sent while the agent was working">
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
								<span class="ask-header-chip done">{q.header}</span>
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
			{:else}
				<div class="ask-card">
					<div class="ask-title">
						<iconify-icon icon="mdi:chat-question"></iconify-icon>
						<span>Claude is asking</span>
					</div>
					{#each entry.questions as q, qi (q.question)}
						{@const active = askActive(entry.id, qi)}
						{@const done = (askProgress[entry.id] ?? 0) > qi}
						<div class="ask-q" class:inactive={!active && !done}>
							<span class="ask-header-chip">{q.header}</span>
							<p class="ask-question">{q.question}</p>
							{#if done}
								<div class="ask-sent">answer sent ✓</div>
							{:else}
								<div class="ask-options">
									{#each q.options as opt, oi (opt.label)}
										<button
											class="ask-opt"
											class:selected={q.multiSelect && askSelections[entry.id]?.has(oi)}
											disabled={!active}
											onclick={() => pickOption(entry, qi, oi)}
										>
											<span class="ask-opt-label">{opt.label}</span>
											{#if opt.description}<span class="ask-opt-desc">{opt.description}</span>{/if}
										</button>
									{/each}
								</div>
								{#if q.multiSelect}
									<button
										class="ask-confirm"
										disabled={!active || !(askSelections[entry.id]?.size > 0)}
										onclick={() => confirmMulti(entry, qi)}
									>
										Confirm selection
									</button>
								{/if}
							{/if}
						</div>
					{/each}
					<button class="ask-other" onclick={() => onOpenTerminal?.()}>
						Other / answer in terminal →
					</button>
				</div>
			{/if}
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
			>
				<summary>
					<iconify-icon class="tool-icon" icon={toolIcon(entry.name)}></iconify-icon>
					{#if sub}
						<span class="row-summary agent-line">
							<span class="agent-name">{sub.description ?? entry.summary}</span>
							{#if sub.agentType}<span class="agent-type">{sub.agentType}</span>{/if}
							{#if doing}
								<span class="agent-doing mono">{doing.summary}</span>
							{:else if sub.activity.length > 0}
								<span class="agent-count">{sub.activity.length} tools</span>
							{/if}
						</span>
					{:else}
						<span class="row-summary mono">{entry.summary}</span>
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
									<span class="mono">{act.summary}</span>
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
							<pre>{entry.result.output || '(no output)'}</pre>
						</section>
					{/if}
					</div>
				{/if}
			</details>
		{/if}
	{/each}

	<!-- Live status: driven by hooks, which fire the instant a tool starts;
	     the JSONL itself is written in batches and lags by seconds. -->
	{#if queueCount > 0}
		<div class="live-row queue-note">
			<iconify-icon icon={queueHeadKind === 'control' ? 'mdi:cog-outline' : 'mdi:tray-full'}
			></iconify-icon>
			<span class="live-text">
				{#if queueHeadKind === 'control'}
					Dashboard command waiting for the prompt: <code>{queueHeadText}</code>
				{:else}
					Queued for when this session is idle: {queueHeadText}
				{/if}
				{#if queueCount > 1}<span class="queue-more">+{queueCount - 1} more</span>{/if}
			</span>
		</div>
	{/if}
	{#if sessionState === 'busy'}
		<div class="live-row busy">
			<SessionStateIndicator state="busy" />
			<span class="live-text mono">{currentAction ?? 'Working…'}</span>
		</div>
	{:else if sessionState === 'permission'}
		<div class="live-row attention" style="color: {sessionStateVisual('permission').color}">
			<SessionStateIndicator state="permission" />
			<span class="live-text">Waiting for permission — switch to terminal view to respond</span>
		</div>
	{:else if sessionState === 'waiting'}
		{@const pendingAsk = entries.some((e) => e.kind === 'ask' && !e.answers && !e.rejected)}
		<div class="live-row attention" style="color: {sessionStateVisual('waiting').color}">
			<SessionStateIndicator state="waiting" />
			<span class="live-text">
				{#if pendingAsk}
					Waiting for your answer — pick an option above ↑
				{:else}
					Question incoming… answer here when it appears, or in the terminal view
				{/if}
			</span>
		</div>
	{/if}

	{#each pendingInPane as text, i (i + text)}
		<div class="user-block pending">
			<span class="prompt-glyph">❯</span>
			<div class="user-text">{text}</div>
			<span class="time" title="waiting in the terminal's queue">
				<iconify-icon icon="mdi:clock-outline"></iconify-icon>
				queued
			</span>
		</div>
	{/each}
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
	.prompt-glyph {
		flex-shrink: 0;
		width: 14px;
		font-family: var(--mono);
		font-weight: 700;
		font-size: 14px;
		color: #f59e0b;
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

	/* Vertical rhythm: one 7px step between blocks, nothing compounds.
	   Tailwind's preflight strips list markers and margins — restore them. */
	.markdown :global(p) {
		margin: 0 0 7px;
	}
	.markdown :global(p:last-child) {
		margin-bottom: 0;
	}
	.markdown :global(h1),
	.markdown :global(h2),
	.markdown :global(h3),
	.markdown :global(h4) {
		font-size: 1em;
		font-weight: 700;
		color: #fafaf9;
		margin: 12px 0 5px;
	}
	.markdown :global(ul),
	.markdown :global(ol) {
		margin: 0 0 7px;
		padding-left: 20px;
	}
	.markdown :global(ul) {
		list-style: disc outside;
	}
	.markdown :global(ol) {
		list-style: decimal outside;
	}
	.markdown :global(ul ul),
	.markdown :global(ol ol),
	.markdown :global(ul ol),
	.markdown :global(ol ul) {
		margin-bottom: 0;
	}
	.markdown :global(li) {
		margin: 1px 0;
		line-height: 1.55;
	}
	.markdown :global(li)::marker {
		color: #78716c;
	}
	.markdown :global(li p) {
		margin: 0;
	}
	.markdown :global(hr) {
		border: none;
		border-top: 1px solid #292524;
		margin: 12px 0;
	}
	.markdown :global(code) {
		font-family: var(--mono);
		font-size: 12px;
		background: #292524;
		border-radius: 4px;
		padding: 1px 5px;
		overflow-wrap: break-word;
	}
	.markdown :global(pre) {
		background: #17140f;
		border: 1px solid #292524;
		border-radius: 8px;
		padding: 10px 12px;
		overflow-x: auto;
		margin: 6px 0 10px;
	}
	.markdown :global(pre code) {
		background: none;
		padding: 0;
	}
	.markdown :global(blockquote) {
		border-left: 3px solid #44403c;
		margin: 6px 0;
		padding-left: 10px;
		color: #a8a29e;
	}
	.markdown :global(table) {
		border-collapse: collapse;
		margin: 6px 0 10px;
		display: block;
		overflow-x: auto;
	}
	.markdown :global(th),
	.markdown :global(td) {
		border: 1px solid #3a342c;
		padding: 4px 8px;
		font-size: 13px;
	}
	.markdown :global(a) {
		color: #93c5fd;
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

	/* --- AskUserQuestion: the waiting state made tangible. Red is the app's
	   waiting color; the card cools to a neutral log line once answered. --- */
	.ask-card {
		margin: 14px 0 14px 12px;
		border: 1px solid #7f1d1d;
		border-left: 3px solid #ef4444;
		border-radius: 8px;
		background: #1c1312;
		padding: 10px 12px 12px;
	}
	.ask-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #f87171;
		margin-bottom: 8px;
	}
	.ask-q + .ask-q {
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid #2b1c1a;
	}
	.ask-q.inactive {
		opacity: 0.45;
	}
	.ask-header-chip {
		display: inline-block;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #fca5a5;
		background: #3b1a18;
		border-radius: 4px;
		padding: 1px 7px;
		margin-bottom: 4px;
	}
	.ask-header-chip.done {
		color: #a8a29e;
		background: #262220;
	}
	.ask-question {
		margin: 0 0 8px;
		color: #f5f0ee;
		font-weight: 600;
	}
	.ask-options {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.ask-opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		text-align: left;
		width: 100%;
		padding: 7px 10px;
		border: 1px solid #322220;
		border-radius: 7px;
		background: #221715;
		cursor: pointer;
		transition:
			border-color 0.12s,
			background 0.12s;
	}
	.ask-opt:hover:not(:disabled) {
		border-color: #ef4444;
		background: #2b1a18;
	}
	.ask-opt.selected {
		border-color: #ef4444;
		background: #341c19;
	}
	.ask-opt:disabled {
		cursor: default;
	}
	.ask-opt-label {
		font-size: 13px;
		font-weight: 600;
		color: #f5f0ee;
	}
	.ask-opt-desc {
		font-size: 12px;
		line-height: 1.45;
		color: #a8a29e;
	}
	.ask-confirm {
		margin-top: 8px;
		padding: 6px 14px;
		border: none;
		border-radius: 7px;
		background: #dc2626;
		color: #fff;
		font-size: 12.5px;
		font-weight: 700;
		cursor: pointer;
	}
	.ask-confirm:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.ask-other {
		margin-top: 10px;
		padding: 0;
		border: none;
		background: none;
		color: #8a837c;
		font-size: 12px;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.ask-other:hover {
		color: #c7c2bd;
	}
	.ask-sent {
		font-size: 12.5px;
		color: #86b898;
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
	.ask-q-review .ask-question {
		font-weight: 500;
		color: #d6d3d1;
		margin: 4px 0 6px;
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

	/* --- Live status row --- */
	.live-row {
		display: flex;
		align-items: center;
		gap: 9px;
		margin: 8px 0 4px 12px;
		font-size: 12.5px;
		color: #a8a29e;
	}
	.live-row.queue-note {
		color: #78716c;
	}
	.live-row.queue-note code {
		font-family: var(--mono);
		color: #a8a29e;
	}
	.queue-more {
		margin-left: 6px;
		color: #57534e;
	}
	.live-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
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
