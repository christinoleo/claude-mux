<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { sessionStore, stateColor, splitPaneTitle, getSessionDisplayName } from '$lib/stores/sessions.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Popover from '$lib/components/ui/popover';
	import TerminalRenderer from '$lib/components/TerminalRenderer.svelte';

	const target = $derived($page.params.target ? decodeURIComponent($page.params.target) : null);

	// Find session state from session store (O(1) Map lookup)
	const currentSession = $derived(
		(target ? sessionStore.sessionByTarget.get(target) : undefined) ??
		(target ? sessionStore.sessionById.get(target) : undefined)
	);

	const sessionNotFound = $derived(target != null && !currentSession && sessionStore.sessions.length > 0);
	const paneIsDead = $derived(
		sessionNotFound || (currentSession?.tmux_target && currentSession?.pane_alive === false)
	);
	const parsedTitle = $derived(currentSession?.pane_title ? splitPaneTitle(currentSession.pane_title) : null);

	let textInput = $state('');
	let showConfirmKill = $state(false);
	let moreOpen = $state(false);
	let commandsOpen = $state(false);
	let queuePopoverOpen = $state(false);
	let ctrlCount = $state(0);
	let altCount = $state(0);
	// Tap candidate: modifier keydown with no intervening key → arm on keyup
	let ctrlTapCandidate = false;
	let altTapCandidate = false;
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressTriggered = false;
	const queueCount = $derived(currentSession?.queue_count ?? 0);
	const rcUrl = $derived(currentSession?.rc_url ?? null);
	let rcEnabling = $state(false);
	let rcTimeout: ReturnType<typeof setTimeout> | null = null;

	// When rc_url appears after enabling, open it and clear the enabling state
	$effect(() => {
		if (rcEnabling && rcUrl) {
			rcEnabling = false;
			if (rcTimeout) { clearTimeout(rcTimeout); rcTimeout = null; }
			window.open(rcUrl, '_blank');
		}
	});

	// If session returns to idle without rc_url, the command failed
	$effect(() => {
		if (rcEnabling && !rcUrl && currentSession?.state === 'idle') {
			// Small delay: state briefly flips to idle before going busy when processing /rc
			const check = setTimeout(() => {
				if (rcEnabling && !currentSession?.rc_url && currentSession?.state === 'idle') {
					rcEnabling = false;
					if (rcTimeout) { clearTimeout(rcTimeout); rcTimeout = null; }
				}
			}, 3000);
			return () => clearTimeout(check);
		}
	});

	async function enableAndOpenRc() {
		if (rcUrl) {
			window.open(rcUrl, '_blank');
			return;
		}

		// Session must be idle to accept /rc command
		if (currentSession?.state !== 'idle') return;

		rcEnabling = true;
		// Safety timeout: reset after 20s no matter what
		rcTimeout = setTimeout(() => { rcEnabling = false; rcTimeout = null; }, 20_000);

		// Send /rc command to enable Remote Control
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: '/rc' })
		});
		// $effects above handle success (rc_url appears) and failure (returns to idle without url)
	}

	const moreKeys: { label: string; keys: string; icon: string }[] = [
		{ label: 'Bksp', keys: 'BSpace', icon: 'mdi:backspace' },
		{ label: 'Left', keys: 'Left', icon: 'mdi:arrow-left' },
		{ label: 'Right', keys: 'Right', icon: 'mdi:arrow-right' },
		{ label: 'Space', keys: 'Space', icon: 'mdi:keyboard-space' },
		{ label: 'Yes', keys: 'y', icon: 'mdi:check' },
		{ label: 'Tab', keys: 'Tab', icon: 'mdi:keyboard-tab' },
		{ label: 'S-Tab', keys: 'BTab', icon: 'mdi:keyboard-tab-reverse' },
		{ label: 'Enter', keys: 'Enter', icon: 'mdi:keyboard-return' },
		{ label: 'PgUp', keys: 'PageUp', icon: 'mdi:chevron-double-up' },
		{ label: 'PgDn', keys: 'PageDown', icon: 'mdi:chevron-double-down' },
		{ label: 'Home', keys: 'Home', icon: 'mdi:page-first' },
		{ label: 'End', keys: 'End', icon: 'mdi:page-last' },
	];

	const commands: { label: string; text: string; keys?: string; icon: string }[] = [
		{ label: '/clear', text: '/clear', icon: 'mdi:broom' },
		{ label: '/rc', text: '/rc', icon: 'mdi:cellphone-link' },
		{ label: '/ak:linus', text: '/ak:linus', icon: 'mdi:code-tags-check' },
		{ label: '/ak:replan', text: '/ak:replan', icon: 'mdi:clipboard-text-outline' },
		{ label: '/ak:redelta', text: '/ak:redelta', icon: 'mdi:compare' },
		{ label: '/ak:triage', text: '/ak:triage', icon: 'mdi:sort-variant' },
		{ label: '/ak:verify', text: '/ak:verify', icon: 'mdi:check-decagram' },
		{ label: '/ak:bcheck', text: '/ak:bcheck', icon: 'mdi:checkbox-marked-circle-outline' },
		{ label: '/ak:p1', text: '/ak:p1', icon: 'mdi:numeric-1-circle' },
		{ label: '/ak:p2', text: '/ak:p2', icon: 'mdi:numeric-2-circle' },
	];

	function fillInput(text: string) {
		textInput = textInput ? textInput + ' ' + text : text;
		commandsOpen = false;
		// Delay focus until after popover closes so it isn't stolen
		setTimeout(() => {
			if (textareaElement) {
				textareaElement.focus();
				autoResize();
			}
		}, 100);
	}
	let outputElement: HTMLDivElement | null = $state(null);
	let textareaElement: HTMLTextAreaElement | null = $state(null);
	let userScrolledUp = $state(false);
	let showCopied = $state(false);
	let showSelectionCopied = $state(false);
	let selectedText = $state('');
	let measureCanvas: HTMLCanvasElement | null = null;

	// Freeze terminal rendering while user has text selected (iOS dismisses
	// the copy callout on any DOM mutation under the selection)
	let hasSelection = $state(false);
	let frozenOutput = $state('');

	$effect(() => {
		if (!browser) return;
		const handler = () => {
			const sel = window.getSelection();
			const text = sel?.toString() || '';
			const selActive = !!(text.length > 0 && outputElement?.contains(sel?.anchorNode ?? null));
			if (selActive) {
				selectedText = text;
				if (!hasSelection) {
					// Snapshot current output when selection starts
					frozenOutput = terminalStore.output;
				}
			}
			hasSelection = selActive;
		};
		document.addEventListener('selectionchange', handler);
		return () => document.removeEventListener('selectionchange', handler);
	});

	const displayOutput = $derived(hasSelection ? frozenOutput : terminalStore.output);

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
		// Subtract 1 col for safety margin (font rendering varies across devices)
		const cols = Math.floor(innerWidth / charW) - 1;
		const rows = Math.floor(innerHeight / charH);

		if (cols < 10 || rows < 3) return null;
		return { cols, rows };
	}

	// Send resize to server
	function handleResize() {
		const size = calculateTerminalSize();
		if (size) terminalStore.sendResize(size.cols, size.rows);
	}

	// Connect/disconnect terminal based on target and pane liveness
	$effect(() => {
		if (!paneIsDead) {
			terminalStore.connect(target);
		} else {
			terminalStore.disconnect();
		}
	});

	onDestroy(() => {
		terminalStore.disconnect();
	});

	// Distance-from-bottom anchor preserved across history-expansion so the
	// user's visible region doesn't jump when older lines prepend.
	let pendingScrollAnchor: number | null = null;
	let lastHistoryRequestAt = 0;

	// Track if user has scrolled up from bottom
	function handleScroll() {
		if (!outputElement) return;
		const { scrollTop, scrollHeight, clientHeight } = outputElement;
		// Consider "at bottom" if within 50px of the bottom
		userScrolledUp = scrollHeight - scrollTop - clientHeight > 50;

		// Lazy-load more scrollback when user nears the top. Skip while a
		// selection is active (output is frozen) or during cooldown so a
		// single mobile flick doesn't spam doublings.
		const now = Date.now();
		if (
			scrollTop < 200 &&
			!hasSelection &&
			!terminalStore.loadingMore &&
			!terminalStore.historyAtMax &&
			now - lastHistoryRequestAt > 400
		) {
			pendingScrollAnchor = scrollHeight - scrollTop;
			lastHistoryRequestAt = now;
			if (!terminalStore.requestMoreHistory()) {
				pendingScrollAnchor = null;
			}
		}
	}

	// After expanded buffer arrives, restore scroll position so the user's
	// viewport stays anchored to the same content (rather than jumping to
	// the new top). rAF lets the DOM lay out the larger <pre> first.
	$effect(() => {
		// Track the tick so this effect re-runs on each successful expansion.
		void terminalStore.historyTick;
		if (pendingScrollAnchor === null || !outputElement) return;
		const anchor = pendingScrollAnchor;
		pendingScrollAnchor = null;
		requestAnimationFrame(() => {
			if (!outputElement) return;
			outputElement.scrollTop = outputElement.scrollHeight - anchor;
		});
	});

	// Auto-scroll to bottom only if user hasn't scrolled up and no active selection
	$effect(() => {
		if (outputElement && terminalStore.output && !userScrolledUp && !hasSelection) {
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

	async function sendTextRaw() {
		if (!textInput) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput, raw: true })
		});
		textInput = '';
		if (textareaElement) textareaElement.style.height = 'auto';
	}

	async function queueText() {
		if (!textInput.trim()) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/queue`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput })
		});
		textInput = '';
		queuePopoverOpen = false;
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	function handleSendContextMenu(e: MouseEvent) {
		e.preventDefault();
		queuePopoverOpen = true;
	}

	function startLongPress() {
		longPressTriggered = false;
		if (longPressTimer) clearTimeout(longPressTimer);
		longPressTimer = setTimeout(() => {
			longPressTimer = null;
			longPressTriggered = true;
			queuePopoverOpen = true;
		}, 500);
	}

	function cancelLongPress() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
	}

	function handleSendTouchEnd(e: TouchEvent) {
		cancelLongPress();
		// Touch has no click event to capture; suppress here if long-press fired
		if (longPressTriggered) {
			e.preventDefault();
			longPressTriggered = false;
		}
	}

	function handleSendMouseDown(e: MouseEvent) {
		// Right button is handled by contextmenu; only left triggers long-press
		if (e.button !== 0) return;
		startLongPress();
	}

	function handleSendClickCapture(e: MouseEvent) {
		if (longPressTriggered) {
			e.preventDefault();
			e.stopPropagation();
			longPressTriggered = false;
		}
	}

	// If the popover closes without a click on the Send wrapper (user clicked an
	// item inside it, or outside entirely), the long-press flag would stay true
	// and swallow the next legitimate Send click. Reset on close.
	$effect(() => {
		if (!queuePopoverOpen) longPressTriggered = false;
	});

	// Close queue dropdown on click outside
	$effect(() => {
		if (!queuePopoverOpen || !browser) return;
		const handler = (e: Event) => {
			const target = e.target as HTMLElement;
			if (!target.closest('.send-btn-wrapper')) {
				queuePopoverOpen = false;
			}
		};
		// Delay to avoid immediate close from the triggering event
		const timeout = setTimeout(() => {
			document.addEventListener('click', handler);
			document.addEventListener('contextmenu', handler);
		}, 10);
		return () => {
			clearTimeout(timeout);
			document.removeEventListener('click', handler);
			document.removeEventListener('contextmenu', handler);
		};
	});

	function cycleCtrl() {
		ctrlCount = (ctrlCount + 1) % 3;
	}
	function cycleAlt() {
		altCount = (altCount + 1) % 3;
	}
	const modArmed = $derived(ctrlCount > 0 || altCount > 0);

	async function sendModSequence() {
		const text = textInput;
		const count = Math.max(ctrlCount, altCount);
		const prefix = `${ctrlCount > 0 ? 'C-' : ''}${altCount > 0 ? 'M-' : ''}`;
		ctrlCount = 0;
		altCount = 0;
		if (!text || !prefix) return;
		const tokens: string[] = [];
		for (let i = 0; i < count; i++) {
			for (const c of text) {
				tokens.push(c === ' ' ? `${prefix}Space` : `${prefix}${c}`);
			}
		}
		textInput = '';
		if (textareaElement) textareaElement.style.height = 'auto';
		await sendKeys(tokens.join(' '));
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Control') {
			if (!e.repeat) ctrlTapCandidate = true;
			return;
		}
		if (e.key === 'Alt') {
			// preventDefault suppresses browser menu-bar focus on Alt tap
			e.preventDefault();
			if (!e.repeat) altTapCandidate = true;
			return;
		}
		ctrlTapCandidate = false;
		altTapCandidate = false;

		if (e.key === 'Escape') {
			e.preventDefault();
			if (modArmed) {
				ctrlCount = 0;
				altCount = 0;
			} else {
				sendKeys('Escape');
			}
			return;
		}
		if (e.key === 'Backspace' && textInput === '' && !modArmed) {
			e.preventDefault();
			sendKeys('BSpace');
			return;
		}
		if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && textInput === '' && !modArmed) {
			e.preventDefault();
			sendKeys(e.key === 'ArrowUp' ? 'Up' : 'Down');
			return;
		}
		if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) {
			e.preventDefault();
			queueText();
		} else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (modArmed) {
				sendModSequence();
			} else {
				sendText();
			}
		}
	}

	function handleKeyup(e: KeyboardEvent) {
		if (e.key === 'Control' && ctrlTapCandidate) {
			ctrlTapCandidate = false;
			cycleCtrl();
		}
		if (e.key === 'Alt' && altTapCandidate) {
			altTapCandidate = false;
			cycleAlt();
		}
	}

	function handleBlur() {
		// A modifier held across focus changes would miss its keyup and misfire later
		ctrlTapCandidate = false;
		altTapCandidate = false;
	}

	function autoResize() {
		if (!textareaElement) return;
		// Reset to single row to measure actual content height
		textareaElement.style.height = '0';
		const newHeight = Math.max(48, Math.min(textareaElement.scrollHeight, 150));
		textareaElement.style.height = newHeight + 'px';
	}

	async function killSession() {
		if (currentSession) {
			await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/kill`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pid: currentSession.pid, tmux_target: currentSession.tmux_target })
			});
		} else if (target) {
			// No session record (stale URL) — still attempt to kill the tmux pane by target
			await fetch(`/api/sessions/${encodeURIComponent(target)}/kill`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pid: 0, tmux_target: target })
			});
		}
		showConfirmKill = false;
		goto('/');
	}

	function copySelection() {
		const text = selectedText;
		if (!text) return;
		// Use textarea + execCommand as primary method (works on iOS/Brave without HTTPS)
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.setAttribute('readonly', '');
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		textarea.setSelectionRange(0, text.length); // iOS needs this
		document.execCommand('copy');
		document.body.removeChild(textarea);
		showSelectionCopied = true;
		setTimeout(() => { showSelectionCopied = false; }, 2000);
	}

	async function renameSession() {
		if (!currentSession) return;
		const current = currentSession.display_name ?? '';
		const next = window.prompt('Session name (blank to reset):', current);
		if (next === null) return;
		const trimmed = next.trim();
		if (trimmed === current) return;
		try {
			await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/rename`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: trimmed || null })
			});
		} catch {
			// watcher will reconcile
		}
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
	<title>{currentSession ? getSessionDisplayName(currentSession) : (target || 'Session')}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
</svelte:head>

<div class="session-container">
	<header class="header">
		<div class="title-row">
			{#if parsedTitle?.symbol}
				<span class="state-symbol" class:braille={parsedTitle.isBraille} style="color: {paneIsDead ? '#555' : stateColor(currentSession?.state || 'idle')}">{parsedTitle.symbol}</span>
			{:else}
				<span class="state" style="background: {paneIsDead ? '#555' : stateColor(currentSession?.state || 'idle')}"></span>
			{/if}
			<div class="title-info">
				<button type="button" class="target-btn" onclick={renameSession} title="Tap to rename">
					<span class="name-text">{currentSession ? getSessionDisplayName(currentSession) : target}</span>
					<iconify-icon icon="mdi:pencil"></iconify-icon>
				</button>
				<span class="status">{paneIsDead ? 'pane closed' : (currentSession?.current_action || currentSession?.state || 'idle')}</span>
			</div>
		</div>
		<div class="header-actions">
			{#if !paneIsDead}
				<Button variant="secondary" size="toolbar" onclick={copyTmuxCmd} title="Copy tmux attach command" class={showCopied ? 'bg-green-800 text-green-300' : ''}>
					<iconify-icon icon={showCopied ? "mdi:check" : "mdi:content-copy"}></iconify-icon>
					<span>{showCopied ? 'Copied!' : 'Tmux'}</span>
				</Button>
				<Button variant="secondary" size="toolbar" onclick={handleResize} title="Resize tmux pane to fit viewport">
					<iconify-icon icon="mdi:fit-to-screen"></iconify-icon>
					<span>Fit</span>
				</Button>
				<Button
					variant={rcUrl ? "secondary" : "ghost"}
					size="toolbar"
					onclick={enableAndOpenRc}
					disabled={rcEnabling || (!rcUrl && currentSession?.state !== 'idle')}
					title={rcUrl ? "Open Remote Control" : "Enable Remote Control"}
				>
					{#if rcEnabling}
						<iconify-icon icon="mdi:loading" class="animate-spin"></iconify-icon>
					{:else}
						<iconify-icon icon="mdi:cellphone-link"></iconify-icon>
					{/if}
					<span>RC</span>
				</Button>
			{/if}
			<Button variant="ghost-destructive" size="toolbar" onclick={() => (showConfirmKill = true)} title="Kill Session">
				<iconify-icon icon="mdi:power"></iconify-icon>
				<span>Kill</span>
			</Button>
		</div>
	</header>

	<div class="output" bind:this={outputElement} onscroll={handleScroll}>
			{#if preferences.terminalTheming}
				<TerminalRenderer output={displayOutput} />
			{:else}
				<pre class="raw-output">{displayOutput}</pre>
			{/if}
		</div>

		<div class="toolbar">
			{#if hasSelection}
				<Button variant="success" size="toolbar" class="flex-1" onclick={copySelection}>
					<iconify-icon icon={showSelectionCopied ? "mdi:check" : "mdi:content-copy"}></iconify-icon>
					<span>{showSelectionCopied ? 'Copied!' : 'Copy'}</span>
				</Button>
			{/if}
			<Button variant="secondary" size="toolbar" class="flex-1" onclick={() => sendKeys('Up')}>
				<iconify-icon icon="mdi:arrow-up"></iconify-icon>
				<span>Up</span>
			</Button>
			<Button variant="secondary" size="toolbar" class="flex-1" onclick={() => sendKeys('Down')}>
				<iconify-icon icon="mdi:arrow-down"></iconify-icon>
				<span>Down</span>
			</Button>

			<!-- More keys popover -->
			<Popover.Root bind:open={moreOpen}>
				<Popover.Trigger class="flex-1 flex-col gap-0.5 px-2 py-1.5 min-w-11 h-auto text-[9px] uppercase tracking-wide inline-flex shrink-0 items-center justify-center rounded-md font-medium cursor-pointer bg-[#222] text-stone-100 hover:bg-[#333]">
					<iconify-icon icon="mdi:dots-horizontal" style="font-size: 18px;"></iconify-icon>
					<span>More</span>
				</Popover.Trigger>
				<Popover.Content side="top" class="w-auto max-w-[280px] p-2 bg-[#1a1a1a] border-[#333]">
					<div class="popover-grid">
						{#each moreKeys as item}
							<Button variant="secondary" size="toolbar" class="min-w-14 min-h-12" onclick={() => { sendKeys(item.keys); moreOpen = false; }}>
								<iconify-icon icon={item.icon}></iconify-icon>
								<span>{item.label}</span>
							</Button>
						{/each}
						<Button
							variant={altCount > 0 ? 'success' : 'secondary'}
							size="toolbar"
							class="min-w-14 min-h-12"
							onclick={() => { cycleAlt(); moreOpen = false; }}
							title="Arm Alt — next Enter sends input as Alt-key (Meta) sequence."
						>
							<iconify-icon icon="mdi:apple-keyboard-option"></iconify-icon>
							<span>Alt{altCount > 1 ? `×${altCount}` : ''}</span>
						</Button>
					</div>
				</Popover.Content>
			</Popover.Root>

			<!-- Commands popover -->
			<Popover.Root bind:open={commandsOpen}>
				<Popover.Trigger class="flex-1 flex-col gap-0.5 px-2 py-1.5 min-w-11 h-auto text-[9px] uppercase tracking-wide inline-flex shrink-0 items-center justify-center rounded-md font-medium cursor-pointer bg-[#222] text-stone-100 hover:bg-[#333]">
					<iconify-icon icon="mdi:lightning-bolt" style="font-size: 18px;"></iconify-icon>
					<span>Cmds</span>
				</Popover.Trigger>
				<Popover.Content side="top" class="w-auto p-2 bg-[#1a1a1a] border-[#333]">
					<div class="popover-grid">
						{#each commands as cmd}
							{#if cmd.keys}
								<Button variant="secondary" size="toolbar" class="min-w-14 min-h-12" onclick={() => { sendKeys(cmd.keys!); commandsOpen = false; }}>
									<iconify-icon icon={cmd.icon}></iconify-icon>
									<span>{cmd.label}</span>
								</Button>
							{:else}
								<Button variant="secondary" size="toolbar" class="min-w-14 min-h-12" onclick={() => fillInput(cmd.text)}>
									<iconify-icon icon={cmd.icon}></iconify-icon>
									<span>{cmd.label}</span>
								</Button>
							{/if}
						{/each}
					</div>
				</Popover.Content>
			</Popover.Root>

			<Button
				variant={ctrlCount > 0 ? 'success' : 'secondary'}
				size="toolbar"
				class="flex-1"
				onclick={cycleCtrl}
				title="Arm Ctrl — next Enter sends input as Ctrl-key sequence. Tap again for ×2, again to disarm."
			>
				<iconify-icon icon="mdi:apple-keyboard-control"></iconify-icon>
				<span>Ctrl{ctrlCount > 1 ? `×${ctrlCount}` : ''}</span>
			</Button>
			<Button variant="secondary" size="toolbar" class="flex-1" onclick={() => sendKeys('Escape')}>
				<iconify-icon icon="mdi:stop"></iconify-icon>
				<span>Esc</span>
			</Button>
		</div>

		<form class="input-row" onsubmit={(e) => { e.preventDefault(); if (modArmed) sendModSequence(); else sendText(); }}>
			{#if ctrlCount > 0}
				<button type="button" class="mod-chip" onclick={() => (ctrlCount = 0)} title="Disarm Ctrl">
					<iconify-icon icon="mdi:apple-keyboard-control"></iconify-icon>
					<span>Ctrl{ctrlCount > 1 ? `×${ctrlCount}` : ''}</span>
				</button>
			{/if}
			{#if altCount > 0}
				<button type="button" class="mod-chip" onclick={() => (altCount = 0)} title="Disarm Alt">
					<iconify-icon icon="mdi:apple-keyboard-option"></iconify-icon>
					<span>Alt{altCount > 1 ? `×${altCount}` : ''}</span>
				</button>
			{/if}
			<textarea
				bind:this={textareaElement}
				bind:value={textInput}
				placeholder={modArmed ? 'Type keys, Enter to send as mod sequence…' : 'Type a message...'}
				rows={1}
				onkeydown={handleKeydown}
				onkeyup={handleKeyup}
				onblur={handleBlur}
				oninput={autoResize}
			></textarea>
			<div class="send-btn-wrapper"
				oncontextmenu={handleSendContextMenu}
				ontouchstart={startLongPress}
				ontouchend={handleSendTouchEnd}
				ontouchmove={cancelLongPress}
				onmousedown={handleSendMouseDown}
				onmouseup={cancelLongPress}
				onmouseleave={cancelLongPress}
				onclickcapture={handleSendClickCapture}
			>
				<Button type="submit" variant="success" class="min-w-[52px] min-h-[48px] text-lg">
					<iconify-icon icon="mdi:send"></iconify-icon>
				</Button>
				{#if queueCount > 0}
					<span class="queue-badge">{queueCount}</span>
				{/if}
				{#if queuePopoverOpen}
					<div class="queue-dropdown">
						<Button variant="secondary" size="toolbar" class="min-w-[140px] min-h-[40px] justify-start gap-2" onclick={queueText}>
							<iconify-icon icon="mdi:tray-arrow-down"></iconify-icon>
							<span>Queue for idle</span>
							<kbd class="queue-kbd">Ctrl+Shift+↵</kbd>
						</Button>
						<Button variant="secondary" size="toolbar" class="min-w-[140px] min-h-[40px] justify-start gap-2" onclick={sendTextRaw}>
							<iconify-icon icon="mdi:send-variant-outline"></iconify-icon>
							<span>Send without Enter</span>
						</Button>
					</div>
				{/if}
			</div>
		</form>
</div>

<AlertDialog.Root bind:open={showConfirmKill}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Kill this session?</AlertDialog.Title>
			<AlertDialog.Description>This will terminate the Claude process.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={killSession} class="bg-destructive text-destructive-foreground hover:bg-destructive/90">Kill</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.session-container {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: #000;
		overflow: hidden;
		overscroll-behavior: none;
		touch-action: pan-y;
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

	.state-symbol {
		font-size: 18px;
		line-height: 1;
		flex-shrink: 0;
		font-variant-emoji: text;
	}

	.state-symbol.braille {
		font-size: 22px;
	}

	.title-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.target-btn {
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		font-weight: 600;
		font-size: 16px;
		padding: 4px 6px;
		margin: -4px -6px;
		cursor: pointer;
		border-radius: 6px;
		text-align: left;
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
	}

	.target-btn .name-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.target-btn iconify-icon {
		font-size: 14px;
		opacity: 0.5;
		margin-left: 6px;
		vertical-align: middle;
		flex-shrink: 0;
	}

	.target-btn:hover,
	.target-btn:focus-visible {
		background: rgba(255, 255, 255, 0.06);
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

	.output {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: none;
		touch-action: pan-y;
		padding: 16px;
		margin: 0;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 13px;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
		background: #000;
		color: #fff;
	}

	.raw-output {
		margin: 0;
		font-family: inherit;
		font-size: inherit;
		line-height: inherit;
		white-space: pre-wrap;
		word-break: break-word;
		background: transparent;
		color: inherit;
	}

	.toolbar {
		display: flex;
		gap: 6px;
		padding: 8px 12px;
		background: #111;
		border-top: 1px solid #222;
	}

	.input-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 12px 16px;
		background: #111;
		border-top: 1px solid #222;
	}

	.mod-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 48px;
		padding: 0 10px;
		background: #1e5b3a;
		color: #d7f5e4;
		border: 1px solid #27ae60;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.03em;
		cursor: pointer;
		flex-shrink: 0;
	}
	.mod-chip iconify-icon {
		font-size: 16px;
	}
	.mod-chip:hover {
		background: #257048;
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
		scrollbar-width: none;
	}

	.popover-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}


	.input-row textarea::-webkit-scrollbar {
		display: none;
	}

	.input-row textarea:focus {
		outline: none;
		border-color: #27ae60;
	}

	.input-row textarea::placeholder {
		color: #666;
	}

	.dead-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 32px;
		color: #888;
		text-align: center;
	}

	.dead-pane :global(.dead-icon) {
		font-size: 48px;
		color: #555;
	}

	.dead-pane h2 {
		font-size: 20px;
		font-weight: 600;
		color: #aaa;
		margin: 0;
	}

	.dead-target {
		font-family: monospace;
		font-size: 13px;
		color: #666;
		margin: 0;
	}

	.dead-hint {
		font-size: 13px;
		color: #555;
		margin: 0;
		max-width: 300px;
	}

	.dead-actions {
		display: flex;
		gap: 8px;
		margin-top: 4px;
	}

	.send-btn-wrapper {
		position: relative;
		display: inline-flex;
	}

	.queue-dropdown {
		position: absolute;
		bottom: 100%;
		right: 0;
		margin-bottom: 6px;
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 8px;
		padding: 4px;
		z-index: 10;
		box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
		white-space: nowrap;
	}

	.queue-kbd {
		font-size: 9px;
		color: #888;
		background: #2a2a2a;
		padding: 1px 4px;
		border-radius: 3px;
		margin-left: 4px;
		font-family: inherit;
	}

	.queue-badge {
		position: absolute;
		top: -4px;
		right: -4px;
		background: #e74c3c;
		color: white;
		border-radius: 50%;
		min-width: 18px;
		height: 18px;
		font-size: 11px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		z-index: 1;
	}

</style>
