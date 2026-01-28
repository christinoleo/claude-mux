<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { sessionStore, stateColor } from '$lib/stores/sessions.svelte';

	const target = $derived(decodeURIComponent($page.params.target));

	// Find session state from session store
	const currentSession = $derived(
		sessionStore.sessions.find((s) => s.tmux_target === target || s.id === target)
	);

	let textInput = $state('');
	let showConfirmKill = $state(false);
	let outputElement: HTMLPreElement | null = $state(null);

	onMount(() => {
		sessionStore.connect();
		terminalStore.connect(target);
	});

	onDestroy(() => {
		terminalStore.disconnect();
		sessionStore.disconnect();
	});

	// Auto-scroll to bottom when output changes
	$effect(() => {
		if (outputElement && terminalStore.output) {
			outputElement.scrollTop = outputElement.scrollHeight;
		}
	});

	async function sendKeys(keys: string) {
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys })
		});
	}

	async function sendText() {
		if (!textInput.trim()) {
			// Empty input: just send Enter key
			await sendKeys('Enter');
			return;
		}
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput })
		});
		textInput = '';
	}

	async function killSession() {
		if (!currentSession) return;
		await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/kill`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pid: currentSession.pid, tmux_target: currentSession.tmux_target })
		});
		showConfirmKill = false;
		window.history.back();
	}

	function copyTmuxCmd() {
		navigator.clipboard.writeText(`tmux attach -t "${target.split(':')[0]}"`);
	}
</script>

<svelte:head>
	<title>{target}</title>
</svelte:head>

<div class="container">
	<header class="header">
		<a href="/" class="back">
			<iconify-icon icon="mdi:arrow-left"></iconify-icon>
		</a>
		<div class="title-row">
			<span class="state" style="background: {stateColor(currentSession?.state || 'idle')}"></span>
			<span class="target">{currentSession?.pane_title || target}</span>
		</div>
		<div class="header-actions">
			<button onclick={copyTmuxCmd} title="Copy tmux attach command">
				<iconify-icon icon="mdi:content-copy"></iconify-icon>
			</button>
			<button onclick={() => sendKeys('Escape')} title="Stop (Esc)">
				<iconify-icon icon="mdi:stop"></iconify-icon>
			</button>
			<button class="danger" onclick={() => (showConfirmKill = true)} title="Kill Session">
				<iconify-icon icon="mdi:power"></iconify-icon>
			</button>
		</div>
	</header>

	<pre class="output" bind:this={outputElement}>{terminalStore.output}</pre>

	<div class="toolbar">
		<button onclick={() => sendKeys('Up')}>
			<iconify-icon icon="mdi:arrow-up"></iconify-icon>
		</button>
		<button onclick={() => sendKeys('Down')}>
			<iconify-icon icon="mdi:arrow-down"></iconify-icon>
		</button>
		<button onclick={() => sendKeys('Space')}>Space</button>
		<button onclick={() => sendKeys('Tab')}>Tab</button>
		<button onclick={() => sendKeys('Enter')}>
			<iconify-icon icon="mdi:keyboard-return"></iconify-icon>
		</button>
		<button onclick={() => sendKeys('C-l')}>Clear</button>
		<button class="danger" onclick={() => sendKeys('C-c')}>Ctrl-C</button>
	</div>

	<form class="input-row" onsubmit={(e) => { e.preventDefault(); sendText(); }}>
		<input type="text" bind:value={textInput} placeholder="Type a message..." />
		<button type="submit">
			<iconify-icon icon="mdi:send"></iconify-icon>
		</button>
	</form>
</div>

{#if showConfirmKill}
	<div class="modal" onclick={() => (showConfirmKill = false)}>
		<div class="modal-content" onclick={(e) => e.stopPropagation()}>
			<h3>Kill this session?</h3>
			<p>This will terminate the Claude process.</p>
			<div class="modal-actions">
				<button onclick={() => (showConfirmKill = false)}>Cancel</button>
				<button class="danger" onclick={killSession}>Kill</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		height: 100vh;
		display: flex;
		flex-direction: column;
		background: #000;
	}

	.header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: #111;
		border-bottom: 1px solid #222;
	}

	.back {
		color: #888;
		text-decoration: none;
		display: flex;
		align-items: center;
		padding: 8px;
	}

	.back:hover {
		color: #fff;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}

	.state {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.target {
		font-weight: 600;
		font-size: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.header-actions button {
		background: #333;
		color: #fff;
		border: none;
		padding: 12px;
		border-radius: 8px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 18px;
		min-width: 44px;
		min-height: 44px;
	}

	.header-actions button:hover {
		color: #fff;
		background: #444;
	}

	.header-actions button:active {
		background: #555;
	}

	.header-actions button.danger {
		background: #7f1d1d;
		color: #fca5a5;
	}

	.header-actions button.danger:hover {
		background: #991b1b;
		color: #fff;
	}

	.output {
		flex: 1;
		overflow-y: auto;
		padding: 16px;
		margin: 0;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 13px;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
		background: #000;
		color: #ddd;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 12px 16px;
		background: #111;
		border-top: 1px solid #222;
	}

	.toolbar button {
		background: #333;
		color: #fff;
		border: none;
		padding: 12px 16px;
		border-radius: 8px;
		cursor: pointer;
		font-size: 16px;
		white-space: nowrap;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-height: 44px;
		flex: 1 1 auto;
	}

	.toolbar button:hover {
		background: #444;
	}

	.toolbar button:active {
		background: #555;
	}

	.toolbar button.danger {
		background: #991b1b;
		color: #fff;
	}

	.toolbar button.danger:hover {
		background: #b91c1c;
	}

	.input-row {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
		background: #111;
		border-top: 1px solid #222;
	}

	.input-row input {
		flex: 1;
		min-width: 0;
		background: #222;
		color: #fff;
		border: 1px solid #333;
		padding: 14px 16px;
		border-radius: 8px;
		font-size: 16px;
	}

	.input-row input:focus {
		outline: none;
		border-color: #27ae60;
	}

	.input-row input::placeholder {
		color: #666;
	}

	.input-row button {
		background: #27ae60;
		color: #fff;
		border: none;
		padding: 14px 18px;
		border-radius: 8px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 18px;
		min-width: 52px;
		min-height: 48px;
	}

	.input-row button:hover {
		background: #2ecc71;
	}

	.input-row button:active {
		background: #229954;
	}

	/* Modal */
	.modal {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal-content {
		background: #1a1a1a;
		border-radius: 12px;
		padding: 24px;
		width: 90%;
		max-width: 400px;
	}

	.modal-content h3 {
		margin: 0 0 12px 0;
		font-size: 18px;
	}

	.modal-content p {
		color: #888;
		margin: 0 0 20px 0;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
	}

	.modal-actions button {
		background: #333;
		color: #fff;
		border: none;
		padding: 10px 20px;
		border-radius: 8px;
		cursor: pointer;
		font-size: 16px;
	}

	.modal-actions button:hover {
		background: #444;
	}

	.modal-actions button.danger {
		background: #c0392b;
	}

	.modal-actions button.danger:hover {
		background: #e74c3c;
	}
</style>
