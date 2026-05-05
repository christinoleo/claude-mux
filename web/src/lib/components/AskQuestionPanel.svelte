<script lang="ts">
	import type { PendingQuestion } from '$lib/stores/sessions.svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		question: PendingQuestion;
		target: string;
		onDismiss?: () => void;
	}

	let { question, target, onDismiss }: Props = $props();

	const q = $derived(question.questions[0]);
	const hasOptions = $derived((q?.options?.length ?? 0) > 0);
	const isMulti = $derived(q?.multiSelect === true);

	let collapsed = $state(false);
	let hidden = $state(false);
	let freeText = $state('');
	let sending = $state(false);
	let submitted = $state(false);

	const isDone = $derived(submitted || sending);

	async function sendKeys(keys: string) {
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ keys }),
		});
	}

	async function sendText(text: string) {
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text }),
		});
	}

	function delay(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function selectOption(index: number) {
		if (isDone) return;
		sending = true;
		try {
			// Single-select: cursor starts at 0, Down N times then Enter
			const keys = index === 0
				? 'Enter'
				: Array(index).fill('Down').join(' ') + ' Enter';
			await sendKeys(keys);
			submitted = true;
			onDismiss?.();
		} finally {
			sending = false;
		}
	}

	// Free-text: navigate to Other, Enter, paste text, Enter submits
	async function submitFreeText() {
		if (isDone || !freeText.trim()) return;
		sending = true;
		try {
			const options = q?.options ?? [];
			const otherIndex = options.length;
			if (otherIndex > 0) {
				const navKeys = Array(otherIndex).fill('Down').join(' ');
				await sendKeys(navKeys + ' Enter');
				await delay(150);
			}
			await sendText(freeText.trim());
			freeText = '';
			submitted = true;
			onDismiss?.();
		} finally {
			sending = false;
		}
	}

	function dismiss(e: Event) {
		e.stopPropagation();
		// Fully hide locally for this question. Component remounts on new question
		// (parent keys by started_at).
		hidden = true;
		onDismiss?.();
	}
</script>

{#if !hidden && !isMulti}
<div class="ask-panel" class:collapsed>
	<div class="ask-header" role="button" tabindex="0"
		onclick={() => (collapsed = !collapsed)}
		onkeydown={(e) => e.key === 'Enter' && (collapsed = !collapsed)}
	>
		<iconify-icon icon="mdi:comment-question-outline" style="font-size: 16px; color: #8aa9d6;"></iconify-icon>
		<span class="ask-title">{submitted ? 'Sent — Claude is processing' : 'Claude asks…'}</span>
		<button
			class="dismiss-btn"
			onclick={dismiss}
			title="Hide panel (does not send anything)"
			aria-label="Hide panel"
		>
			<iconify-icon icon="mdi:close" style="font-size: 14px;"></iconify-icon>
		</button>
		<button
			class="collapse-btn"
			onclick={(e) => { e.stopPropagation(); collapsed = !collapsed; }}
			title={collapsed ? 'Expand' : 'Collapse'}
			aria-label={collapsed ? 'Expand' : 'Collapse'}
		>
			<iconify-icon icon={collapsed ? 'mdi:chevron-up' : 'mdi:chevron-down'} style="font-size: 16px;"></iconify-icon>
		</button>
	</div>

	{#if !collapsed && q}
		<div class="ask-body">
			{#if q.header}
				<div class="ask-sub-header">{q.header}</div>
			{/if}
			<div class="ask-question">{q.question}</div>

			{#if hasOptions}
				<div class="options-list">
					{#each q.options ?? [] as opt, i}
						<button
							class="option-btn"
							disabled={isDone}
							onclick={() => selectOption(i)}
						>
							<span class="option-label">{opt.label}</span>
							{#if opt.description}
								<span class="option-desc">{opt.description}</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}

			<form class="free-text-row" onsubmit={(e) => { e.preventDefault(); submitFreeText(); }}>
				<input
					class="free-text-input"
					placeholder={hasOptions ? 'Or type custom reply (sent via Other)…' : 'Type your reply…'}
					bind:value={freeText}
					disabled={isDone}
				/>
				<Button type="submit" variant="secondary" size="toolbar" disabled={isDone || !freeText.trim()}>
					<iconify-icon icon="mdi:send"></iconify-icon>
				</Button>
			</form>
		</div>
	{/if}
</div>
{/if}

<style>
	.ask-panel {
		background: #15151a;
		border-top: 1px solid #3a3a4a;
		flex-shrink: 0;
	}

	.ask-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		cursor: pointer;
		user-select: none;
	}

	.ask-title {
		font-size: 12px;
		font-weight: 600;
		color: #b8b8c8;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-right: auto;
	}

	.dismiss-btn,
	.collapse-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		background: transparent;
		border: none;
		color: #888;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}

	.dismiss-btn:hover,
	.collapse-btn:hover {
		background: #2a2a36;
		color: #e0e0e0;
	}

	.dismiss-btn:focus-visible,
	.collapse-btn:focus-visible {
		outline: 2px solid #4a90e2;
		outline-offset: 1px;
	}

	.ask-body {
		padding: 0 12px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.ask-sub-header {
		font-size: 11px;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.ask-question {
		font-size: 14px;
		color: #e0e0e0;
		line-height: 1.4;
		white-space: pre-wrap;
	}

	.options-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.option-btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 10px 14px;
		background: #1f1f28;
		border: 1px solid #2e2e3a;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s, border-color 0.1s;
		width: 100%;
		outline: none;
	}

	.option-btn:hover:not(:disabled) {
		background: #2a2a36;
		border-color: #4a4a5e;
	}

	.option-btn:focus {
		outline: none;
	}

	.option-btn:focus-visible {
		outline: 2px solid #4a90e2;
		outline-offset: 1px;
	}

	.option-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.option-label {
		font-size: 14px;
		color: #e0e0e0;
		font-weight: 500;
	}

	.option-desc {
		font-size: 12px;
		color: #888;
	}

	.free-text-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.free-text-input {
		flex: 1;
		background: #111;
		border: 1px solid #333;
		border-radius: 6px;
		padding: 8px 12px;
		color: #e0e0e0;
		font-size: 14px;
		outline: none;
		min-height: 40px;
	}

	.free-text-input:focus {
		border-color: #555;
	}

	.free-text-input:disabled {
		opacity: 0.5;
	}
</style>
