<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onDestroy, onMount, tick } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { sessionStore, stateColor, splitPaneTitle, getSessionDisplayName } from '$lib/stores/sessions.svelte';
	import { tmuxPanesStore } from '$lib/stores/tmuxPanes.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Popover from '$lib/components/ui/popover';
	import TerminalRenderer from '$lib/components/TerminalRenderer.svelte';
	import VoiceButton from '$lib/components/VoiceButton.svelte';
	import { voiceStore } from '$lib/stores/voice.svelte';
	import { draftsStore } from '$lib/stores/drafts.svelte';
	import { untrack } from 'svelte';
	import { longPress } from '$lib/actions/longPress';
	import { clickOutside } from '$lib/actions/clickOutside';

	const target = $derived($page.params.target ? decodeURIComponent($page.params.target) : null);
	const voiceEnabled = $derived(Boolean($page.data.voiceEnabled));

	// Find session state from session store (O(1) Map lookup)
	const currentSession = $derived(
		(target ? sessionStore.sessionByTarget.get(target) : undefined) ??
		(target ? sessionStore.sessionById.get(target) : undefined)
	);

	const tmuxPane = $derived(target ? tmuxPanesStore.panes.find((p) => p.target === target) ?? null : null);
	const isClaudeSession = $derived(currentSession != null);
	const isPlainPane = $derived(!isClaudeSession && tmuxPane != null);
	const claudeSessionDead = $derived(
		isClaudeSession && !!currentSession?.tmux_target && currentSession?.pane_alive === false
	);
	const targetMissing = $derived(
		tmuxPanesStore.loaded && sessionStore.sessions.length > 0 && !isClaudeSession && !isPlainPane
	);
	const paneIsDead = $derived(claudeSessionDead || targetMissing);
	const isAlive = $derived(!paneIsDead && (isClaudeSession || isPlainPane));
	const stateDotColor = $derived(
		paneIsDead ? '#555' : isPlainPane ? '#888' : stateColor(currentSession?.state || 'idle')
	);
	// Inline status next to the title. Skip bare states (idle/busy/etc.)
	// since the state symbol + color already convey them; only show when
	// there's information the symbol can't carry.
	const statusText = $derived.by(() => {
		if (paneIsDead) return 'pane closed';
		if (isPlainPane) return tmuxPane?.command || null;
		return currentSession?.current_action || null;
	});
	const parsedTitle = $derived(currentSession?.pane_title ? splitPaneTitle(currentSession.pane_title) : null);

	let textInput = $state('');
	let showConfirmKill = $state(false);
	let moreOpen = $state(false);
	let headerOverflowOpen = $state(false);
	let headerCompact = $state(false);
	let headerEl: HTMLElement | undefined = $state();
	let nameTextEl: HTMLElement | undefined = $state();
	let commandsOpen = $state(false);
	let queuePopoverOpen = $state(false);
	let ctrlCount = $state(0);
	let altCount = $state(0);
	// Tap candidate: modifier keydown with no intervening key → arm on keyup
	let ctrlTapCandidate = false;
	let altTapCandidate = false;
	const queueCount = $derived(currentSession?.queue_count ?? 0);

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

	// Drive the terminal store from view state. setTarget owns WS, output,
	// and history reset together; only attach when target is confirmed alive.
	$effect(() => {
		terminalStore.setTarget(isAlive ? target : null);
	});

	onDestroy(() => {
		terminalStore.setTarget(null);
	});

	onMount(() => tmuxPanesStore.subscribe());

	// Adaptive header: switch to the ⋮ dropdown only when inline actions
	// would crowd the title. ResizeObserver handles header width changes;
	// a separate effect handles name changes (no observer rebuild).
	// Width difference between the inline icon row (4×32 + 3 gaps = 140)
	// and the compact dropdown trigger (32). Hysteresis margin prevents
	// oscillation when collapsing/expanding the header on resize.
	const INLINE_VS_COMPACT_WIDTH = 108;

	function measureHeader() {
		if (!nameTextEl) return;
		const natural = nameTextEl.scrollWidth;
		const avail = nameTextEl.clientWidth;
		if (!headerCompact && natural > avail + 1) {
			headerCompact = true;
		} else if (headerCompact && natural + INLINE_VS_COMPACT_WIDTH <= avail) {
			headerCompact = false;
		}
	}

	$effect(() => {
		if (!headerEl) return;
		const ro = new ResizeObserver(measureHeader);
		ro.observe(headerEl);
		measureHeader();
		// Font swap fires no ResizeObserver tick on header; remeasure once
		// the real font is ready. Bail out if the component unmounted first.
		let cancelled = false;
		if (browser && document.fonts?.ready) {
			document.fonts.ready.then(() => {
				if (!cancelled) measureHeader();
			});
		}
		return () => {
			cancelled = true;
			ro.disconnect();
		};
	});

	$effect(() => {
		// Re-measure when title or inline status changes; either can flip
		// truncation without a corresponding ResizeObserver tick.
		void (currentSession?.display_name ?? target);
		void statusText;
		measureHeader();
	});

	// Load runs in $effect.pre so it precedes the save effect in the same flush;
	// otherwise a target switch would persist the previous textInput under the
	// new target.
	$effect.pre(() => {
		const t = target;
		untrack(() => {
			textInput = draftsStore.get(t);
		});
		void tick().then(autoResize);
	});

	$effect(() => {
		draftsStore.set(target, textInput);
	});

	function handleScroll() {
		if (!outputElement) return;
		const { scrollTop, scrollHeight, clientHeight } = outputElement;
		const nextScrolledUp = scrollHeight - scrollTop - clientHeight > 50;
		if (nextScrolledUp !== userScrolledUp) userScrolledUp = nextScrolledUp;

		if (scrollTop < 200 && !hasSelection) {
			const anchor = scrollHeight - scrollTop;
			const pending = terminalStore.requestMoreHistory();
			if (pending) {
				pending.then(() => {
					if (!outputElement) return;
					// rAF lets DOM lay out the larger <pre> before we re-anchor.
					requestAnimationFrame(() => {
						if (outputElement) outputElement.scrollTop = outputElement.scrollHeight - anchor;
					});
				});
			}
		}
	}

	// Auto-scroll to bottom only if user hasn't scrolled up and no active selection
	$effect(() => {
		if (outputElement && terminalStore.output && !userScrolledUp && !hasSelection) {
			outputElement.scrollTop = outputElement.scrollHeight;
		}
	});

	async function sendKeys(keys: string) {
		if (!target) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys })
		});
	}

	async function sendText() {
		if (!target) return;
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
		if (!target || !textInput) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput, raw: true })
		});
		textInput = '';
		if (textareaElement) textareaElement.style.height = 'auto';
	}

	async function acceptSuggestion() {
		queuePopoverOpen = false;
		await sendKeys('Tab Enter');
	}

	async function queueText() {
		if (!target || !textInput.trim()) return;
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

	async function finishVoiceIfRecording(): Promise<boolean> {
		if (!voiceEnabled) return false;
		if (voiceStore.status !== 'recording' || !voiceStore.isOwnedBy(target)) return false;
		await voiceStore.stopAndSubmit();
		return true;
	}

	function isVoiceHotkey(e: KeyboardEvent): boolean {
		if (!voiceEnabled) return false;
		if (e.altKey || e.metaKey || e.shiftKey) return false;
		if (e.code === 'F2' && !e.ctrlKey) return true;
		if (e.code === 'Pause' && !e.ctrlKey) return true;
		if (e.code === 'Backquote' && e.ctrlKey) return true;
		return false;
	}

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

	async function handleKeydown(e: KeyboardEvent) {
		if (!e.repeat && isVoiceHotkey(e)) {
			e.preventDefault();
			ctrlTapCandidate = false;
			altTapCandidate = false;
			if (target && (!voiceStore.isActive || voiceStore.isOwnedBy(target))) {
				await voiceStore.toggle(target);
			}
			return;
		}
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
			if (voiceStore.isOwnedBy(target)) {
				await voiceStore.cancel();
				return;
			}
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
		if (e.key === 'Tab' && textInput === '' && !modArmed && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			sendKeys('Tab');
			return;
		}
		if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) {
			e.preventDefault();
			queueText();
		} else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (await finishVoiceIfRecording()) return;
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
	<header class="header" class:compact={headerCompact} bind:this={headerEl}>
		<div class="title-row">
			{#if parsedTitle?.symbol}
				<span class="state-symbol" class:braille={parsedTitle.isBraille} style="color: {stateDotColor}">{parsedTitle.symbol}</span>
			{:else}
				<span class="state" style="background: {stateDotColor}"></span>
			{/if}
			<div class="title-info">
				<button
					type="button"
					class="target-btn"
					onclick={renameSession}
					disabled={!isClaudeSession}
					title={isClaudeSession ? 'Tap to rename' : undefined}
				>
					<span class="name-text" bind:this={nameTextEl}>{currentSession ? getSessionDisplayName(currentSession) : target}</span>
					{#if isClaudeSession}
						<iconify-icon icon="mdi:pencil"></iconify-icon>
					{/if}
				</button>
				{#if statusText}<span class="status">· {statusText}</span>{/if}
			</div>
		</div>
		<div class="header-actions">
			<div class="header-actions-desktop">
				{#if isAlive}
					<Button variant="secondary" size="icon-sm" onclick={copyTmuxCmd} class={showCopied ? 'bg-emerald-900 text-emerald-300 hover:bg-emerald-900' : ''}>
						<iconify-icon icon={showCopied ? 'mdi:check' : 'mdi:content-copy'} style="font-size: 18px;"></iconify-icon>
					</Button>
					<Button variant="secondary" size="icon-sm" onclick={handleResize}>
						<iconify-icon icon="mdi:fit-to-screen" style="font-size: 18px;"></iconify-icon>
					</Button>
					<Button variant="secondary" size="icon-sm" onclick={() => location.reload()}>
						<iconify-icon icon="mdi:refresh" style="font-size: 18px;"></iconify-icon>
					</Button>
				{/if}
				<Button variant="secondary" size="icon-sm" onclick={() => (showConfirmKill = true)} class="text-red-400 hover:bg-red-950/40 hover:text-red-300">
					<iconify-icon icon="mdi:power" style="font-size: 18px;"></iconify-icon>
				</Button>
			</div>
			<div class="header-actions-mobile">
				<Popover.Root bind:open={headerOverflowOpen}>
					<Popover.Trigger
						class="inline-flex items-center justify-center w-9 h-9 rounded-md bg-[#222] text-stone-100 hover:bg-[#333] cursor-pointer"
						aria-label="More actions"
					>
						<iconify-icon icon="mdi:dots-vertical" style="font-size: 20px;"></iconify-icon>
					</Popover.Trigger>
					<Popover.Content side="bottom" align="end" class="w-44 p-1 bg-[#1a1a1a] border-[#333]">
						{#if isAlive}
							<button class="overflow-item" onclick={() => { copyTmuxCmd(); headerOverflowOpen = false; }}>
								<iconify-icon icon={showCopied ? 'mdi:check' : 'mdi:content-copy'}></iconify-icon>
								<span>{showCopied ? 'Copied!' : 'Copy tmux cmd'}</span>
							</button>
							<button class="overflow-item" onclick={() => { handleResize(); headerOverflowOpen = false; }}>
								<iconify-icon icon="mdi:fit-to-screen"></iconify-icon>
								<span>Fit to viewport</span>
							</button>
							<button class="overflow-item" onclick={() => location.reload()}>
								<iconify-icon icon="mdi:refresh"></iconify-icon>
								<span>Refresh page</span>
							</button>
							<div class="overflow-sep"></div>
						{/if}
						<button class="overflow-item overflow-item-destructive" onclick={() => { showConfirmKill = true; headerOverflowOpen = false; }}>
							<iconify-icon icon="mdi:power"></iconify-icon>
							<span>Kill session</span>
						</button>
					</Popover.Content>
				</Popover.Root>
			</div>
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
			{#if voiceEnabled}
				<VoiceButton {target} />
			{/if}
		</div>

		<form class="input-row" onsubmit={async (e) => { e.preventDefault(); if (await finishVoiceIfRecording()) return; if (modArmed) sendModSequence(); else sendText(); }}>
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
				use:longPress={{ onTrigger: () => (queuePopoverOpen = true) }}
				use:clickOutside={{
					enabled: queuePopoverOpen,
					onOutside: () => (queuePopoverOpen = false)
				}}
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
						<Button variant="secondary" size="toolbar" class="min-w-[140px] min-h-[40px] justify-start gap-2" onclick={acceptSuggestion}>
							<iconify-icon icon="mdi:keyboard-tab"></iconify-icon>
							<span>Accept suggestion</span>
						</Button>
					</div>
				{/if}
			</div>
		</form>
</div>

<AlertDialog.Root bind:open={showConfirmKill}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Kill this {isClaudeSession ? 'session' : 'pane'}?</AlertDialog.Title>
			<AlertDialog.Description>{isClaudeSession ? 'This will terminate the Claude process.' : 'This will close the tmux pane.'}</AlertDialog.Description>
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

	.header-actions-mobile {
		display: none;
	}

	/* Hamburger room only depends on viewport (sidebar collapse) */
	@media (max-width: 768px) {
		.header {
			min-height: 40px;
			padding: 4px 6px 4px 44px;
		}
	}

	/* Compact mode: JS toggles .compact when the title would
	   truncate next to the inline actions. */
	.header.compact {
		gap: 6px;
	}
	.header.compact .title-row {
		gap: 6px;
	}
	.header.compact .title-info {
		flex-direction: row;
		align-items: center;
		gap: 6px;
		overflow: hidden;
		flex-wrap: nowrap;
	}
	.header.compact .target-btn {
		font-size: 13px;
		padding: 2px 4px;
		margin: -2px -4px;
		min-height: 0;
	}
	.header.compact .target-btn iconify-icon {
		font-size: 12px;
		margin-left: 4px;
	}
	.header.compact .status {
		font-size: 11px;
	}
	.header.compact .state-symbol {
		font-size: 13px;
	}
	.header.compact .state-symbol.braille {
		font-size: 15px;
	}
	.header.compact .state {
		width: 8px;
		height: 8px;
	}
	.header.compact .header-actions {
		gap: 4px;
	}
	.header.compact .header-actions-desktop {
		display: none;
	}
	.header.compact .header-actions-mobile {
		display: flex;
	}
	.header.compact .header-actions-mobile :global([data-popover-trigger]),
	.header.compact .header-actions-mobile > :global(*) {
		width: 32px;
		height: 32px;
	}
	@media (max-width: 768px) {
		.toolbar :global(button) {
			border-radius: 3px;
		}
	}

	.overflow-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		background: transparent;
		border: none;
		color: hsl(var(--foreground));
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
	}
	.overflow-item:hover {
		background: rgba(255, 255, 255, 0.06);
	}
	.overflow-item :global(iconify-icon) {
		font-size: 16px;
		opacity: 0.8;
	}
	.overflow-item-destructive {
		color: #e76060;
	}
	.overflow-item-destructive:hover {
		background: rgba(231, 96, 96, 0.12);
	}
	.overflow-sep {
		height: 1px;
		background: #2a2a2a;
		margin: 4px 2px;
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
		flex-direction: row;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		flex: 1;
		overflow: hidden;
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

	.target-btn:disabled {
		cursor: default;
	}

	.target-btn:disabled:hover,
	.target-btn:disabled:focus-visible {
		background: none;
	}

	.status {
		font-size: 13px;
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex-shrink: 1;
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
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: calc(100vw - 16px);
	}

	.queue-dropdown :global(button) {
		width: 100%;
		justify-content: flex-start;
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
