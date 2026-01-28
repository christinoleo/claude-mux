<script lang="ts">
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { sessionStore, stateColor } from '$lib/stores/sessions.svelte';

	const target = $derived($page.params.target ? decodeURIComponent($page.params.target) : null);

	// Find session state from session store
	const currentSession = $derived(
		sessionStore.sessions.find((s) => s.tmux_target === target || s.id === target)
	);

	let textInput = $state('');
	let showConfirmKill = $state(false);
	let outputElement: HTMLPreElement | null = $state(null);
	let textareaElement: HTMLTextAreaElement | null = $state(null);
	let userScrolledUp = $state(false);
	let showCopied = $state(false);
	let measureCanvas: HTMLCanvasElement | null = null;

	// Measure monospace character dimensions using canvas
	function measureFont(): { width: number; height: number } {
		if (!browser) return { width: 7.8, height: 18.2 };

		if (!measureCanvas) measureCanvas = document.createElement('canvas');
		const ctx = measureCanvas.getContext('2d');
		if (!ctx) return { width: 7.8, height: 18.2 };

		// Match CSS: font-family from .output, font-size: 13px, line-height: 1.4
		ctx.font = "13px 'SF Mono', Monaco, 'Cascadia Code', monospace";
		const width = ctx.measureText('M').width;
		const height = 13 * 1.4; // 18.2px

		return { width, height };
	}

	// Calculate terminal dimensions from output element
	function calculateTerminalSize(): { cols: number; rows: number } | null {
		if (!outputElement) return null;

		// Padding is 16px on each side (from CSS .output)
		const padding = 32;
		const innerWidth = outputElement.clientWidth - padding;
		const innerHeight = outputElement.clientHeight - padding;

		if (innerWidth <= 0 || innerHeight <= 0) return null;

		const { width: charW, height: charH } = measureFont();
		const cols = Math.floor(innerWidth / charW);
		const rows = Math.floor(innerHeight / charH);

		if (cols < 10 || rows < 3) return null;
		return { cols, rows };
	}

	// Send resize to server
	function handleResize() {
		const size = calculateTerminalSize();
		if (size) terminalStore.sendResize(size.cols, size.rows);
	}

	// Connect to terminal when target changes (including initial mount)
	$effect(() => {
		terminalStore.connect(target);
	});

	onDestroy(() => {
		terminalStore.disconnect();
	});

	// Track if user has scrolled up from bottom
	function handleScroll() {
		if (!outputElement) return;
		const { scrollTop, scrollHeight, clientHeight } = outputElement;
		// Consider "at bottom" if within 50px of the bottom
		userScrolledUp = scrollHeight - scrollTop - clientHeight > 50;
	}

	// Auto-scroll to bottom only if user hasn't scrolled up
	$effect(() => {
		if (outputElement && terminalStore.output && !userScrolledUp) {
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
		// Reset textarea height after sending
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendText();
		}
	}

	function autoResize() {
		if (!textareaElement) return;
		// Reset to single row to measure actual content height
		textareaElement.style.height = '0';
		const newHeight = Math.max(48, Math.min(textareaElement.scrollHeight, 150));
		textareaElement.style.height = newHeight + 'px';
	}

	async function killSession() {
		if (!currentSession) return;
		await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/kill`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pid: currentSession.pid, tmux_target: currentSession.tmux_target })
		});
		showConfirmKill = false;
		window.location.href = '/';
	}

	function copyTmuxCmd() {
		if (!target) return;
		const cmd = `tmux attach -t "${target.split(':')[0]}"`;
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(cmd);
		} else {
			// Fallback for non-secure contexts (HTTP)
			const textarea = document.createElement('textarea');
			textarea.value = cmd;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
		}
		showCopied = true;
		setTimeout(() => { showCopied = false; }, 2000);
	}
</script>

<svelte:head>
	<title>{currentSession?.pane_title || target || 'Session'}</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
</svelte:head>

<div class="container">
	<header class="header">
		<a href="/" class="back">
			<iconify-icon icon="mdi:arrow-left"></iconify-icon>
		</a>
		<div class="title-row">
			<span class="state" style="background: {stateColor(currentSession?.state || 'idle')}"></span>
			<div class="title-info">
				<span class="target">{currentSession?.pane_title || target}</span>
				<span class="status">{currentSession?.current_action || currentSession?.state || 'idle'}</span>
			</div>
		</div>
		<div class="header-actions">
			<button onclick={copyTmuxCmd} title="Copy tmux attach command" class:copied={showCopied}>
				<iconify-icon icon={showCopied ? "mdi:check" : "mdi:content-copy"}></iconify-icon>
				<span>{showCopied ? 'Copied!' : 'Tmux'}</span>
			</button>
			<button onclick={handleResize} title="Resize tmux pane to fit viewport">
				<iconify-icon icon="mdi:fit-to-screen"></iconify-icon>
				<span>Fit</span>
			</button>
			<button onclick={() => sendKeys('Escape')} title="Send Escape key">
				<iconify-icon icon="mdi:stop"></iconify-icon>
				<span>Esc</span>
			</button>
			<button class="danger" onclick={() => (showConfirmKill = true)} title="Kill Session">
				<iconify-icon icon="mdi:power"></iconify-icon>
				<span>Kill</span>
			</button>
		</div>
	</header>

	<pre class="output" bind:this={outputElement} onscroll={handleScroll}>{terminalStore.output}</pre>

	<div class="toolbar">
		<button onclick={() => sendKeys('Up')}>
			<iconify-icon icon="mdi:arrow-up"></iconify-icon>
			<span>Up</span>
		</button>
		<button onclick={() => sendKeys('Down')}>
			<iconify-icon icon="mdi:arrow-down"></iconify-icon>
			<span>Down</span>
		</button>
		<button onclick={() => sendKeys('Space')}>
			<iconify-icon icon="mdi:keyboard-space"></iconify-icon>
			<span>Space</span>
		</button>
		<button onclick={() => sendKeys('Tab')}>
			<iconify-icon icon="mdi:keyboard-tab"></iconify-icon>
			<span>Tab</span>
		</button>
		<button onclick={() => sendKeys('Enter')}>
			<iconify-icon icon="mdi:keyboard-return"></iconify-icon>
			<span>Enter</span>
		</button>
		<button onclick={() => sendKeys('C-l')}>
			<iconify-icon icon="mdi:broom"></iconify-icon>
			<span>Clear</span>
		</button>
		<button class="danger" onclick={() => sendKeys('C-c')}>
			<iconify-icon icon="mdi:cancel"></iconify-icon>
			<span>Ctrl-C</span>
		</button>
	</div>

	<form class="input-row" onsubmit={(e) => { e.preventDefault(); sendText(); }}>
		<textarea
			bind:this={textareaElement}
			bind:value={textInput}
			placeholder="Type a message..."
			rows="1"
			onkeydown={handleKeydown}
			oninput={autoResize}
		></textarea>
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
		height: 100%;
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

	/* Make room for hamburger menu on mobile */
	@media (max-width: 768px) {
		.header {
			padding-left: 64px;
		}
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

	.title-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.target {
		font-weight: 600;
		font-size: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status {
		font-size: 13px;
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-actions {
		display: flex;
		gap: 6px;
	}

	.header-actions button {
		background: #333;
		color: #fff;
		border: none;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-width: 44px;
	}

	.header-actions button iconify-icon {
		font-size: 18px;
	}

	.header-actions button span {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.3px;
		opacity: 0.8;
	}

	.header-actions button:hover {
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

	.header-actions button.copied {
		background: #166534;
		color: #4ade80;
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
		gap: 6px;
		padding: 8px 12px;
		background: #111;
		border-top: 1px solid #222;
	}

	.toolbar button {
		flex: 1;
		background: #333;
		color: #fff;
		border: none;
		padding: 6px 4px;
		border-radius: 6px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-width: 0;
	}

	.toolbar button iconify-icon {
		font-size: 18px;
	}

	.toolbar button span {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.3px;
		opacity: 0.8;
	}

	.toolbar button:hover {
		background: #444;
	}

	.toolbar button:active {
		background: #555;
	}

	.toolbar button.danger {
		background: #7f1d1d;
		color: #fca5a5;
	}

	.toolbar button.danger:hover {
		background: #991b1b;
		color: #fff;
	}

	.input-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 12px 16px;
		background: #111;
		border-top: 1px solid #222;
	}

	.input-row textarea {
		flex: 1;
		min-width: 0;
		height: 48px;
		background: #222;
		color: #fff;
		border: 1px solid #333;
		padding: 12px 16px;
		border-radius: 8px;
		font-size: 14px;
		font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, 'Cascadia Code', monospace;
		line-height: 1.5;
		resize: none;
		overflow-y: auto;
		overflow-x: hidden;
		max-height: 150px;
		word-wrap: break-word;
		box-sizing: border-box;
		scrollbar-width: none; /* Firefox */
	}

	.input-row textarea::-webkit-scrollbar {
		display: none; /* Chrome, Safari */
	}

	.input-row textarea:focus {
		outline: none;
		border-color: #27ae60;
	}

	.input-row textarea::placeholder {
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
