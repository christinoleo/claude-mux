<script lang="ts">
	import type { DialogHold } from '$shared/types/ws-messages.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import DictateButton from './DictateButton.svelte';
	import { keepsCaret, sayInto } from '$lib/dictation';
	import { composeAnswers, type HoldQuestion } from '$lib/hold-answer';

	let {
		hold,
		base = '',
		onAnswered,
		onMoreOptions = null,
		dictateTarget = null
	}: {
		/** The dialog whose hook is waiting for this card. */
		hold: DialogHold;
		/** The machine's address, for a session on another machine. */
		base?: string;
		onAnswered: () => void;
		/** Opens the pane's own rows, for what only the terminal's dialog offers. Null when none are drawn. */
		onMoreOptions?: (() => void) | null;
		/** Where dictation's words are heard, as `DictateButton` takes it; null draws no microphone. */
		dictateTarget?: string | null;
	} = $props();

	let picks = $state<Record<string, string[]>>({});
	let typed = $state<Record<string, string>>({});
	let message = $state('');
	/** Each question's field, for dictation to find its caret. */
	const fields: Record<string, HTMLInputElement> = {};
	let messageEl = $state<HTMLInputElement | null>(null);
	let sending = $state(false);
	let error = $state<string | null>(null);

	const questions = $derived(hold.kind === 'question' ? hold.questions : []);

	const composed = $derived(composeAnswers(questions, picks, typed));
	const complete = $derived(questions.every((q) => composed.answers[q.question]));

	async function send(body: Record<string, unknown>) {
		sending = true;
		error = null;
		const res = await fetch(`${base}/api/dialog-holds/${hold.id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(() => null);
		sending = false;
		if (res?.ok) {
			onAnswered();
			return;
		}
		const answer = (await res?.json().catch(() => null)) as { error?: string } | null | undefined;
		error = answer?.error ?? 'The machine did not answer. The dialog is still open in the terminal.';
	}

	const LABELS = {
		question: { allow: 'Submit', deny: 'Decline' },
		plan: { allow: 'Approve', deny: 'Keep planning' },
		approval: { allow: 'Allow', deny: 'Deny' }
	};

	function allow() {
		void send(
			hold.kind === 'question'
				? { decision: 'allow', ...composed }
				: { decision: 'allow' }
		);
	}

	function deny() {
		void send({ decision: 'deny', message: message.trim() || undefined });
	}

	function toggle(q: HoldQuestion, label: string) {
		const now = picks[q.question] ?? [];
		const lone = questions.length === 1 && !typed[q.question]?.trim();
		// A second tap on the one choice of a card sends it again, as a failed send leaves it picked.
		if (!q.multiSelect && lone && now.includes(label)) return allow();
		if (q.multiSelect || now.includes(label)) {
			picks[q.question] = now.includes(label) ? now.filter((l) => l !== label) : [...now, label];
			return;
		}
		picks[q.question] = [label];
		// One choice on the whole card has nothing left to confirm, unless a note is being written for it.
		if (lone) allow();
	}
</script>

<section class="hold-card" aria-label={{ approval: 'Permission needed', plan: 'Plan to approve', question: 'Claude is asking' }[hold.kind]}>
	{#if hold.kind === 'question'}
		<header class="title"><iconify-icon icon="mdi:chat-question"></iconify-icon>Claude is asking</header>
		{#each questions as q (q.question)}
			{@const picked = (picks[q.question]?.length ?? 0) > 0}
			<div class="question-block">
				{#if q.header}<span class="chip">{q.header}</span>{/if}
				<p class="question">{q.question}</p>
				<div class="rows" role="group" aria-label={q.question}>
					{#each q.options as option (option.label)}
						{@const on = picks[q.question]?.includes(option.label) ?? false}
						<button
							type="button"
							class="row"
							class:on
							aria-pressed={on}
							disabled={sending}
							onclick={() => toggle(q, option.label)}
						>
							<iconify-icon
								icon={q.multiSelect
									? on
										? 'mdi:checkbox-marked'
										: 'mdi:checkbox-blank-outline'
									: on
										? 'mdi:radiobox-marked'
										: 'mdi:radiobox-blank'}
							></iconify-icon>
							<span class="label">
								<span class="name">{option.label}</span>
								{#if option.description}<span class="hint">{option.description}</span>{/if}
								{#if option.preview}<pre class="detail">{option.preview}</pre>{/if}
							</span>
						</button>
					{/each}
				</div>
				<div class="field">
					<Input
						{@attach (el: HTMLInputElement) => {
							fields[q.question] = el;
						}}
						bind:value={typed[q.question]}
						{@attach keepsCaret}
						placeholder={picked ? 'Add a note to your pick' : 'Type something else'}
						aria-label={picked ? `A note on your answer to: ${q.question}` : `Your own answer to: ${q.question}`}
						disabled={sending}
						onkeydown={(e: KeyboardEvent) => {
							e.stopPropagation();
							if (e.key === 'Enter' && complete && !sending) {
								e.preventDefault();
								allow();
							}
						}}
					/>
					{#if dictateTarget}
						<DictateButton
							target={dictateTarget}
							disabled={sending}
							onText={(text) =>
								void sayInto(fields[q.question], typed[q.question] ?? '', text, (t) => (typed[q.question] = t))}
						/>
					{/if}
				</div>
			</div>
		{/each}
	{:else if hold.kind === 'plan'}
		<header class="title"><iconify-icon icon="mdi:clipboard-text-outline"></iconify-icon>Plan to approve</header>
		<pre class="detail">{hold.detail}</pre>
		<div class="field">
			<Input
				bind:ref={messageEl}
				bind:value={message}
				{@attach keepsCaret}
				placeholder="What to change, if you keep planning"
				aria-label="What to change in the plan"
				disabled={sending}
				onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
			/>
			{#if dictateTarget}
				<DictateButton
					target={dictateTarget}
					disabled={sending}
					onText={(text) => void sayInto(messageEl, message, text, (t) => (message = t))}
				/>
			{/if}
		</div>
	{:else}
		<header class="title"><iconify-icon icon="mdi:shield-alert-outline"></iconify-icon>Permission needed</header>
		<p class="question">{hold.tool}</p>
		<pre class="detail">{hold.detail}</pre>
	{/if}

	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<div class="actions">
		<Button variant="warning" size="sm" disabled={sending || !complete} onclick={allow}>{LABELS[hold.kind].allow}</Button>
		<Button variant="ghost" size="sm" disabled={sending} onclick={deny}>{LABELS[hold.kind].deny}</Button>
		{#if onMoreOptions}
			<Button variant="ghost" size="sm" class="more" onclick={onMoreOptions}>More options</Button>
		{/if}
	</div>
</section>

<style>
	.hold-card {
		margin: 14px 0 14px 12px;
		border: 1px solid #5c4410;
		border-left: 3px solid #fbbf24;
		border-radius: 8px;
		background: #1a1610;
		padding: 10px 12px 12px;
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
	.question-block + .question-block {
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid #2c2416;
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
	.question {
		margin: 0 0 8px;
		color: #f5f0ee;
		font-weight: 600;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 8px;
	}
	.row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 7px 9px;
		border: 1px solid #3a2f17;
		border-radius: 6px;
		background: none;
		color: #e7e0d6;
		text-align: left;
		cursor: pointer;
	}
	.row:hover:not(:disabled),
	.row:focus-visible,
	.row.on {
		border-color: #fbbf24;
		background: #2a2010;
	}
	.row iconify-icon {
		flex: none;
		margin-top: 2px;
		color: #d6b46a;
	}
	.label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.name {
		overflow-wrap: anywhere;
	}
	.hint {
		color: #a8a29e;
		font-size: 12px;
	}
	.detail {
		max-height: 40vh;
		margin: 0 0 8px;
		overflow: auto;
		padding: 8px;
		border-radius: 6px;
		background: #12100c;
		color: #d6d3d1;
		font-size: 12px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.field {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.error {
		margin: 8px 0 0;
		color: #fca5a5;
		font-size: 12.5px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
	}
	.actions :global(.more) {
		margin-left: auto;
	}
</style>
