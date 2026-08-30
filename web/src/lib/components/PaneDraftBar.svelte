<script lang="ts">
	/**
	 * What sits in the tmux pane's prompt box, shown while the transcript view
	 * hides the terminal.
	 *
	 * It lives next to the composer rather than in the transcript because it is
	 * state, not history: typed text rides along in front of anything sent from
	 * here, since sending pastes into that same prompt. (Claude's suggestion is
	 * a different thing and is drawn inside the transcript — see TranscriptView.)
	 */
	let {
		text,
		composerHasText = false,
		onClear,
		onSend
	}: {
		/** What the user typed into the terminal's prompt box, if anything. */
		text: string | null;
		/** The web composer holds text that would land behind a typed draft. */
		composerHasText?: boolean;
		onClear: () => void;
		onSend: () => void;
	} = $props();
</script>

{#if text}
	<div class="draft" class:collides={composerHasText}>
		<div class="head">
			<span class="eyebrow">
				{composerHasText ? 'Sends before your message' : 'Typed in terminal'}
			</span>
			<div class="actions">
				<button type="button" onclick={onClear}>Clear</button>
				<button type="button" onclick={onSend}>Send</button>
			</div>
		</div>
		<div class="body">
			<span class="caret" aria-hidden="true">&#10095;</span>
			<p class="text">{text}</p>
		</div>
	</div>
{/if}

<style>
	.draft {
		display: block;
		width: 100%;
		flex-shrink: 0;
		padding: 8px 12px 9px;
		text-align: left;
		background: #151210;
		border: none;
		border-top: 1px solid #2a2420;
		border-left: 2px solid #2a2420;
		border-radius: 0;
		animation: shelf-in 140ms ease-out;
	}
	.draft.collides {
		border-left-color: #f59e0b;
		background: #17130d;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.eyebrow {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #78716c;
	}
	.draft.collides .eyebrow {
		color: #f59e0b;
	}

	.actions {
		display: flex;
		gap: 4px;
	}
	.actions button {
		min-height: 30px;
		padding: 6px 11px;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #a8a29e;
		background: #221e1b;
		border: none;
		border-radius: 5px;
		cursor: pointer;
	}
	.actions button:hover {
		background: #2e2926;
		color: #e7e5e4;
	}
	.actions button:focus-visible {
		outline: 2px solid #f59e0b;
		outline-offset: 1px;
	}

	.body {
		display: flex;
		gap: 8px;
		margin-top: 5px;
	}
	.caret {
		flex-shrink: 0;
		font-family: var(--mono, ui-monospace, monospace);
		font-size: 12px;
		line-height: 1.5;
		color: #57534e;
	}
	.text {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-family: var(--mono, ui-monospace, monospace);
		font-size: 12px;
		line-height: 1.5;
		color: #a8a29e;
		white-space: pre-wrap;
		word-break: break-word;
		/* Three lines, then ellipsis — the full text is one tap away in the
		   terminal view, so there is nothing to expand here. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
	}

	@keyframes shelf-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.draft {
			animation: none;
		}
	}
</style>
