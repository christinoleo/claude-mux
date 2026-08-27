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
	import TerminalView from '$lib/components/TerminalView.svelte';
	import VoiceButton from '$lib/components/VoiceButton.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import CommandList from '$lib/components/CommandList.svelte';
	import { voiceStore } from '$lib/stores/voice.svelte';
	import { draftsStore } from '$lib/stores/drafts.svelte';
	import { untrack } from 'svelte';
	import { longPress } from '$lib/actions/longPress';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { STORAGE_KEYS } from '$lib/constants';
	import { useGamepad, STICK_DEADZONE } from '$lib/gamepad.svelte';
	import { sidebarActionsStore, type ChordAction } from '$lib/stores/sidebarActions.svelte';

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
	let commandsOpen = $state(false);
	let queuePopoverOpen = $state(false);
	let attachPickerOpen = $state(false);
	let attachStackOpen = $state(false);
	let ctrlCount = $state(0);
	let altCount = $state(0);
	let chordMenuOpen = $state(false);
	let chordIndex = $state(0);
	let chordItems = $state<ChordAction[]>([]);
	let chordTitle = $state('');
	let chordStickArmed = $state(false);
	let chordStickX = $state(0);
	let chordStickY = $state(0);
	let showCopied = $state(false);
	const CHORD_STICK_DEADZONE = 0.3;
	const CHORD_RING_THRESHOLD = 0.7;
	const CHORD_RING_RADII = [130, 220];
	const CHORD_CURSOR_RADIUS_PX = 240;
	const CHORD_MAX_PER_RING = 12;
	let chordInnerCount = $state(0);
	const chordRings = $derived.by(() => {
		const items = chordItems;
		if (chordInnerCount <= 0 || chordInnerCount >= items.length) return [items];
		return [items.slice(0, chordInnerCount), items.slice(chordInnerCount)];
	});
	const chordPositions = $derived(
		chordRings.flatMap((ring, ringIdx) => {
			const r = CHORD_RING_RADII[ringIdx] ?? CHORD_RING_RADII[CHORD_RING_RADII.length - 1];
			return ring.map((_, i) => {
				const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
				return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
			});
		})
	);

	const headerActions: ChordAction[] = $derived([
		...(isAlive
			? [
					{
						label: 'Copy cmd',
						icon: showCopied ? 'mdi:check' : 'mdi:content-copy',
						run: () => copyTmuxCmd(),
						flashing: showCopied
					},
					{ label: 'Fit screen', icon: 'mdi:fit-to-screen', run: () => handleResize() },
					{ label: 'Refresh', icon: 'mdi:refresh', run: () => location.reload() }
				]
			: []),
		{ label: 'Kill pane', icon: 'mdi:power', run: () => (showConfirmKill = true), danger: true }
	]);

	const ctrlActions: ChordAction[] = [
		{ label: 'Ctrl+L', icon: 'mdi:eraser', run: () => void sendKeys('C-l') },
		{ label: 'Ctrl+U', icon: 'mdi:backspace-outline', run: () => void sendKeys('C-u') },
		{ label: 'Ctrl+W', icon: 'mdi:delete-sweep-outline', run: () => void sendKeys('C-w') },
		{ label: 'Ctrl+C', icon: 'mdi:stop', run: () => void sendKeys('C-c') },
		{ label: 'Ctrl+R', icon: 'mdi:magnify', run: () => void sendKeys('C-r') }
	];

	const slashActions: ChordAction[] = [
		{ label: '/clear', icon: 'mdi:broom', run: () => runText('/clear') },
		{ label: '/compact', icon: 'mdi:archive-arrow-down', run: () => runText('/compact') },
		{ label: '/resume', icon: 'mdi:play-circle-outline', run: () => runText('/resume') },
		{ label: '/memory', icon: 'mdi:memory', run: () => runText('/memory') },
		{ label: '/init', icon: 'mdi:rocket-launch-outline', run: () => runText('/init') },
		{ label: '/grill-me', icon: 'mdi:fire', run: () => runText('/grill-me') },
		{ label: '/grill-with-docs', icon: 'mdi:fire-circle', run: () => runText('/grill-with-docs') },
		{ label: '/tdd', icon: 'mdi:test-tube', run: () => runText('/tdd') },
		{ label: '/diagnose', icon: 'mdi:stethoscope', run: () => runText('/diagnose') },
		{ label: '/simplify', icon: 'mdi:vector-difference-ab', run: () => runText('/simplify') },
		{ label: '/frontend-design', icon: 'mdi:palette-outline', run: () => runText('/frontend-design') },
		{ label: '/ak:linus', icon: 'mdi:code-tags-check', run: () => runText('/ak:linus') },
		{ label: '/ak:replan', icon: 'mdi:clipboard-text-outline', run: () => runText('/ak:replan') },
		{ label: '/ak:redelta', icon: 'mdi:compare', run: () => runText('/ak:redelta') },
		{ label: '/ak:triage', icon: 'mdi:sort-variant', run: () => runText('/ak:triage') },
		{ label: '/ak:verify', icon: 'mdi:check-decagram', run: () => runText('/ak:verify') },
		{ label: '/ak:bcheck', icon: 'mdi:checkbox-marked-circle-outline', run: () => runText('/ak:bcheck') },
		{ label: '/ak:p1', icon: 'mdi:numeric-1-circle', run: () => runText('/ak:p1') },
		{ label: '/ak:p2', icon: 'mdi:numeric-2-circle', run: () => runText('/ak:p2') }
	];

	function chunk<T>(arr: T[], size: number): T[][] {
		const out: T[][] = [];
		for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
		return out;
	}

	// File attachments staged for the next send (see docs/adr/0001, 0002).
	type AttachmentStatus = 'uploading' | 'ready' | 'failed';
	interface Attachment {
		localId: string;
		file: File;
		name: string;
		size: number;
		mime: string;
		status: AttachmentStatus;
		path?: string;
		error?: string;
		thumb?: string;
		abort?: AbortController;
	}
	let attachments = $state<Attachment[]>([]);
	let cameraInput: HTMLInputElement | null = $state(null);
	let galleryInput: HTMLInputElement | null = $state(null);
	let filesInput: HTMLInputElement | null = $state(null);
	let isTouchDevice = $state(false);
	let dropActive = $state(false);

	const canSend = $derived(attachments.every((a) => a.status === 'ready'));
	const readyPaths = $derived(
		attachments.filter((a) => a.status === 'ready' && a.path).map((a) => a.path!)
	);
	const hasAttachments = $derived(attachments.length > 0);
	const stackThumbs = $derived(attachments.filter((a) => a.thumb).slice(-3).reverse());
	const anyFailed = $derived(attachments.some((a) => a.status === 'failed'));
	const anyUploading = $derived(attachments.some((a) => a.status === 'uploading'));
	$effect(() => {
		if (!hasAttachments) attachStackOpen = false;
	});
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
		// Clear whatever is typed in Claude's prompt: Ctrl+E (end of line) then
		// Ctrl+U repeatedly (delete to line start; repeats walk up multiline input).
		// Extra Ctrl+U on an empty prompt is a no-op, so over-sending is safe.
		{ label: 'Clear', keys: 'C-e ' + Array(12).fill('C-u').join(' '), icon: 'mdi:eraser' },
	];

	// Pinned commands — shown first in the command palette (Cmds button)
	const pinnedCommands = [
		'/clear',
		'/rc',
		'/ak:linus',
		'/ak:replan',
		'/ak:redelta',
		'/ak:triage',
		'/ak:verify',
		'/ak:bcheck',
		'/ak:p1',
		'/ak:p2',
	];

	function fillInput(text: string) {
		textInput = textInput ? textInput + ' ' + text : text;
		// Picked from the dialog: don't immediately re-open the inline slash popup for it.
		slashDismissedFor = `${textInput.length - text.length}:${text}`;
		commandsOpen = false;
		// Delay focus until after popover closes so it isn't stolen
		setTimeout(() => {
			if (textareaElement) {
				textareaElement.focus();
				const end = textareaElement.value.length;
				textareaElement.setSelectionRange(end, end);
				syncCaret();
				autoResize();
			}
		}, 100);
	}
	let outputElement: HTMLDivElement | null = $state(null);
	let textareaElement: HTMLTextAreaElement | null = $state(null);
	let userScrolledUp = $state(false);
	let showSelectionCopied = $state(false);
	let selectedText = $state('');
	let measureCanvas: HTMLCanvasElement | null = null;

	// Freeze terminal rendering while user has text selected (iOS dismisses
	// the copy callout on any DOM mutation under the selection)
	let hasSelection = $state(false);

	$effect(() => {
		if (!browser) return;
		const handler = () => {
			const sel = window.getSelection();
			const text = sel?.toString() || '';
			const selActive = !!(text.length > 0 && outputElement?.contains(sel?.anchorNode ?? null));
			if (selActive) selectedText = text;
			hasSelection = selActive;
		};
		document.addEventListener('selectionchange', handler);
		return () => document.removeEventListener('selectionchange', handler);
	});

	// "New lines below" indicator: history lines appended since the user scrolled up
	let seenAppended = $state(0);
	const unseenLines = $derived(userScrolledUp ? Math.max(0, terminalStore.appended - seenAppended) : 0);

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

	// New target: forget any scrolled-up state from the previous session so the
	// view always opens pinned to the latest output.
	$effect(() => {
		target;
		untrack(() => {
			userScrolledUp = false;
			seenAppended = 0;
			terminalStore.atBottom = true;
		});
	});

	onDestroy(() => {
		terminalStore.setTarget(null);
	});

	onMount(() => tmuxPanesStore.subscribe());

	$effect(() => {
		if (!browser || !target) return;
		try {
			if (isAlive) {
				localStorage.setItem(STORAGE_KEYS.lastSession, target);
			} else if (paneIsDead && localStorage.getItem(STORAGE_KEYS.lastSession) === target) {
				localStorage.removeItem(STORAGE_KEYS.lastSession);
			}
		} catch {
			// quota / private mode — resume just won't work this device
		}
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
		if (nextScrolledUp !== userScrolledUp) {
			userScrolledUp = nextScrolledUp;
			terminalStore.atBottom = !nextScrolledUp;
			// Count "new" lines from the moment the user left the bottom
			seenAppended = terminalStore.appended;
			if (!nextScrolledUp) terminalStore.trimToBottom();
		}

		// Near the top: fetch an older chunk and keep the viewport anchored on the
		// same content (history only ever grows at the ends, so the distance from
		// the bottom is a stable anchor).
		if (scrollTop < 200 && !hasSelection && !terminalStore.historyAtStart) {
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

	function scrollToBottom() {
		if (!outputElement) return;
		userScrolledUp = false;
		terminalStore.atBottom = true;
		seenAppended = terminalStore.appended;
		terminalStore.trimToBottom();
		tick().then(() => {
			if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
		});
	}

	// Auto-scroll to bottom only if user hasn't scrolled up and no active selection.
	// While scrolled up we deliberately leave scrollTop alone: history only appends
	// below, so whatever the user is reading stays where it is.
	$effect(() => {
		// track output changes (screen redraws, appended history, and the initial
		// history tail / load-more prepends, which grow the block above the screen)
		terminalStore.screen;
		terminalStore.appended;
		terminalStore.history.length;
		terminalStore.historyStart;
		if (outputElement && !userScrolledUp && !hasSelection) {
			const el = outputElement;
			el.scrollTop = el.scrollHeight;
			// Layout may still settle (fonts, viewport/keyboard changes on mobile): pin again next frame.
			requestAnimationFrame(() => {
				if (!userScrolledUp && !hasSelection) el.scrollTop = el.scrollHeight;
			});
		}
	});

	// Layout can change without any store update (toolbar/attachment rows,
	// keyboard on mobile, fonts loading): keep the view pinned through those too.
	$effect(() => {
		const el = outputElement;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (!userScrolledUp && !hasSelection) el.scrollTop = el.scrollHeight;
		});
		ro.observe(el);
		for (const child of el.children) ro.observe(child);
		return () => ro.disconnect();
	});

	async function sendKeys(keys: string) {
		if (!target) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys })
		});
	}

	// Send button with empty input: single tap → Enter, double tap → Tab+Enter
	// (accept suggestion). The single Enter is delayed briefly so a second tap
	// can upgrade it; keyboard Enter stays immediate (see handleKeydown).
	const DOUBLE_TAP_MS = 300;
	let emptyEnterTimer: ReturnType<typeof setTimeout> | null = null;
	async function sendFromButton() {
		if (!target || !canSend) return;
		if (textInput.trim() || readyPaths.length > 0) {
			await sendText();
			return;
		}
		if (emptyEnterTimer) {
			clearTimeout(emptyEnterTimer);
			emptyEnterTimer = null;
			await acceptSuggestion();
			return;
		}
		emptyEnterTimer = setTimeout(() => {
			emptyEnterTimer = null;
			void sendKeys('Enter');
		}, DOUBLE_TAP_MS);
	}

	async function sendText() {
		if (!target) return;
		if (!canSend) return;
		const paths = readyPaths;
		if (!textInput.trim() && paths.length === 0) {
			// Empty input: just send Enter key
			await sendKeys('Enter');
			return;
		}
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput, attachments: paths })
		});
		textInput = '';
		clearAttachments();
		// Reset textarea height after sending
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	async function sendTextRaw() {
		if (!target) return;
		if (!canSend) return;
		const paths = readyPaths;
		if (!textInput && paths.length === 0) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput, raw: true, attachments: paths })
		});
		textInput = '';
		clearAttachments();
		if (textareaElement) textareaElement.style.height = 'auto';
	}

	async function acceptSuggestion() {
		queuePopoverOpen = false;
		await sendKeys('Tab Enter');
	}

	async function queueText() {
		if (!target || !textInput.trim()) return;
		if (!canSend) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/queue`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: textInput, attachments: readyPaths })
		});
		textInput = '';
		clearAttachments();
		queuePopoverOpen = false;
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	function handleSendContextMenu(e: MouseEvent) {
		e.preventDefault();
		queuePopoverOpen = true;
	}

	// ─── Attachments ────────────────────────────────────────────────────────

	function makeLocalId(): string {
		return typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}

	async function doUpload(localId: string, file: File, signal: AbortSignal) {
		const sessionId = currentSession?.id;
		if (!sessionId) {
			attachments = attachments.map((a) =>
				a.localId === localId ? { ...a, status: 'failed', error: 'No active session' } : a
			);
			return;
		}
		const form = new FormData();
		form.append('file', file);
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
				method: 'POST',
				body: form,
				signal
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const data = (await res.json()) as { path: string; name: string; size: number; mime: string };
			attachments = attachments.map((a) =>
				a.localId === localId ? { ...a, status: 'ready', path: data.path, abort: undefined } : a
			);
		} catch (err) {
			if (signal.aborted) return;
			const msg = err instanceof Error ? err.message : String(err);
			attachments = attachments.map((a) =>
				a.localId === localId ? { ...a, status: 'failed', error: msg, abort: undefined } : a
			);
		}
	}

	function uploadAttachment(file: File) {
		const localId = makeLocalId();
		const thumb = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
		const abort = new AbortController();
		const chip: Attachment = {
			localId,
			file,
			name: file.name || `pasted-${Date.now()}`,
			size: file.size,
			mime: file.type || 'application/octet-stream',
			status: 'uploading',
			thumb,
			abort
		};
		attachments = [...attachments, chip];
		void doUpload(localId, file, abort.signal);
	}

	function uploadFiles(files: FileList | File[] | null | undefined) {
		if (!files) return;
		for (const f of Array.from(files)) uploadAttachment(f);
	}

	function retryAttachment(localId: string) {
		const chip = attachments.find((a) => a.localId === localId);
		if (!chip || chip.status !== 'failed') return;
		const abort = new AbortController();
		attachments = attachments.map((a) =>
			a.localId === localId
				? { ...a, status: 'uploading', error: undefined, abort }
				: a
		);
		void doUpload(localId, chip.file, abort.signal);
	}

	function removeAttachment(localId: string) {
		const chip = attachments.find((a) => a.localId === localId);
		if (!chip) return;
		chip.abort?.abort();
		if (chip.thumb) URL.revokeObjectURL(chip.thumb);
		if (chip.status === 'ready' && chip.path && currentSession?.id) {
			// Best-effort server cleanup; chip is gone either way.
			void fetch(
				`/api/sessions/${encodeURIComponent(currentSession.id)}/attach?path=${encodeURIComponent(chip.path)}`,
				{ method: 'DELETE' }
			);
		}
		attachments = attachments.filter((a) => a.localId !== localId);
	}

	function clearAttachments() {
		for (const a of attachments) {
			a.abort?.abort();
			if (a.thumb) URL.revokeObjectURL(a.thumb);
		}
		attachments = [];
	}

	function handlePaste(e: ClipboardEvent) {
		const files = e.clipboardData?.files;
		if (files && files.length > 0) {
			e.preventDefault();
			uploadFiles(files);
		}
	}

	function handlePickerInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		uploadFiles(input.files);
		input.value = '';
		attachPickerOpen = false;
	}

	function openPicker(which: 'camera' | 'gallery' | 'files') {
		attachPickerOpen = false;
		const el = which === 'camera' ? cameraInput : which === 'gallery' ? galleryInput : filesInput;
		// Tick so popover close doesn't swallow the click on iOS.
		setTimeout(() => el?.click(), 0);
	}

	// Clear chips on session change (revoke blob URLs, abort in-flight uploads).
	$effect.pre(() => {
		const _t = target;
		untrack(clearAttachments);
	});

	// Touch detection + window-level drag-drop wiring.
	onMount(() => {
		if (!browser) return;
		try {
			isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
		} catch {
			isTouchDevice = 'ontouchstart' in window;
		}

		let counter = 0;
		const hasFiles = (e: DragEvent) =>
			Array.from(e.dataTransfer?.types ?? []).includes('Files');
		const onEnter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			counter++;
			if (counter === 1) dropActive = true;
			e.preventDefault();
		};
		const onLeave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			counter--;
			if (counter <= 0) {
				counter = 0;
				dropActive = false;
			}
		};
		const onOver = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		};
		const onDrop = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			counter = 0;
			dropActive = false;
			uploadFiles(e.dataTransfer?.files);
		};
		window.addEventListener('dragenter', onEnter);
		window.addEventListener('dragleave', onLeave);
		window.addEventListener('dragover', onOver);
		window.addEventListener('drop', onDrop);
		return () => {
			window.removeEventListener('dragenter', onEnter);
			window.removeEventListener('dragleave', onLeave);
			window.removeEventListener('dragover', onOver);
			window.removeEventListener('drop', onDrop);
		};
	});

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

	// Inline slash popup: when the word under the caret starts with "/" (anywhere
	// in the input), open the same command list as the Cmds button above the
	// input, filtered by the rest of that word. Picking an entry replaces just
	// that word; the rest of the input is left alone.
	let slashList = $state<CommandList | null>(null);
	let slashDismissedFor = $state<string | null>(null);
	let caretPos = $state(0);
	function syncCaret() {
		if (textareaElement) caretPos = textareaElement.selectionStart ?? textInput.length;
	}
	const slashToken = $derived.by(() => {
		const text = textInput;
		const pos = Math.min(caretPos, text.length);
		let start = pos;
		while (start > 0 && !/\s/.test(text[start - 1])) start--;
		if (text[start] !== '/') return null;
		let end = pos;
		while (end < text.length && !/\s/.test(text[end])) end++;
		return { start, end, text: text.slice(start, end) };
	});
	const slashKey = $derived(slashToken ? `${slashToken.start}:${slashToken.text}` : null);
	const slashOpen = $derived(!modArmed && slashKey != null && slashKey !== slashDismissedFor);
	const slashQuery = $derived(slashOpen && slashToken ? slashToken.text.slice(1) : '');
	function chooseSlash(insert: string) {
		const tok = slashToken;
		if (!tok) return;
		const before = textInput.slice(0, tok.start);
		const after = textInput.slice(tok.end);
		// Trailing space closes the popup and matches Claude Code's own completion.
		const sep = after.startsWith(' ') ? '' : ' ';
		textInput = before + insert + sep + after;
		const pos = before.length + insert.length + 1;
		slashDismissedFor = null;
		caretPos = pos;
		void tick().then(() => {
			if (textareaElement) {
				textareaElement.focus();
				textareaElement.setSelectionRange(pos, pos);
			}
			autoResize();
		});
	}
	function dismissSlash() {
		slashDismissedFor = slashKey;
	}

	async function runText(text: string) {
		if (!target) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text })
		});
	}

	function chordStep(delta: number) {
		const n = chordItems.length;
		if (n === 0) return;
		chordIndex = (chordIndex + delta + n) % n;
		chordStickArmed = true;
	}

	function openChord(items: ChordAction[], title: string, innerCount = 0) {
		chordItems = items;
		chordInnerCount = innerCount;
		chordIndex = 0;
		chordTitle = title;
		chordStickArmed = false;
		chordStickX = 0;
		chordStickY = 0;
		chordMenuOpen = true;
	}
	function closeChord() {
		chordMenuOpen = false;
		chordStickArmed = false;
		chordStickX = 0;
		chordStickY = 0;
	}
	function releaseChord() {
		if (chordStickArmed) chordItems[chordIndex]?.run();
		closeChord();
	}

	$effect(() => {
		if (!browser) return;
		const handler = (e: WheelEvent) => {
			if (!outputElement) return;
			const t = e.target as Element | null;
			if (!t) return;
			if (outputElement.contains(t)) return;
			// Only hijack wheel from non-scrollable regions; leave native scroll alone.
			let el: Element | null = t;
			while (el && el !== document.body) {
				const style = getComputedStyle(el);
				const overflowY = style.overflowY;
				if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return;
				el = el.parentElement;
			}
			outputElement.scrollTop += e.deltaY;
		};
		window.addEventListener('wheel', handler, { passive: true });
		return () => window.removeEventListener('wheel', handler);
	});

	useGamepad({
		enabled: () => target != null,
		axes: () => (axes) => {
			const lx = axes[0] ?? 0;
			const ly = axes[1] ?? 0;
			if (chordMenuOpen) {
				chordStickX = lx;
				chordStickY = ly;
				const mag = Math.hypot(lx, ly);
				if (mag < CHORD_STICK_DEADZONE || chordItems.length === 0) {
					chordStickArmed = false;
					return;
				}
				chordStickArmed = true;
				const rings = chordRings;
				const ringIdx = rings.length > 1 && mag >= CHORD_RING_THRESHOLD ? 1 : 0;
				const ring = rings[ringIdx];
				const stickAngle = Math.atan2(ly, lx);
				const norm = (stickAngle + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
				const localIdx = Math.round((norm / (Math.PI * 2)) * ring.length) % ring.length;
				let offset = 0;
				for (let i = 0; i < ringIdx; i++) offset += rings[i].length;
				chordIndex = offset + localIdx;
				return;
			}
			if (Math.abs(ly) < STICK_DEADZONE) return;
			if (outputElement) outputElement.scrollTop += ly * 24;
		},
		buttons: () => ({
			A: () => {
				if (chordMenuOpen) {
					chordItems[chordIndex]?.run();
					closeChord();
				} else {
					void sendText();
				}
			},
			B: async () => {
				if (chordMenuOpen) return closeChord();
				if (voiceStore.isOwnedBy(target)) {
					await voiceStore.cancel();
				} else {
					void sendKeys('Escape');
				}
			},
			X: async () => {
				if (chordMenuOpen) return;
				if (!target) return;
				if (!voiceStore.isActive || voiceStore.isOwnedBy(target)) {
					await voiceStore.toggle(target);
				}
			},
			Y: () => {
				if (chordMenuOpen) return;
				commandsOpen = !commandsOpen;
			},
			L1: () => history.back(),
			R1: () => history.forward(),
			L2: {
				press: () => openChord([...ctrlActions, ...slashActions], 'Commands', ctrlActions.length),
				release: releaseChord
			},
			R2: {
				press: () =>
					openChord([...headerActions, ...sidebarActionsStore.actions], 'Actions'),
				release: releaseChord
			},
			DpadUp: () => {
				if (!chordMenuOpen) void sendKeys('Up');
			},
			DpadDown: () => {
				if (!chordMenuOpen) void sendKeys('Down');
			},
			DpadLeft: () => {
				if (chordMenuOpen) chordStep(-1);
				else void sendKeys('Left');
			},
			DpadRight: () => {
				if (chordMenuOpen) chordStep(1);
				else void sendKeys('Right');
			}
		})
	});

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

		if (slashOpen) {
			if (e.key === 'Escape') {
				e.preventDefault();
				dismissSlash();
				return;
			}
			if (slashList?.handleKeydown(e)) return;
		}

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
		const arrowKeys: Record<string, string> = {
			ArrowUp: 'Up',
			ArrowDown: 'Down',
			ArrowLeft: 'Left',
			ArrowRight: 'Right',
		};
		if (arrowKeys[e.key] && textInput === '' && !modArmed) {
			e.preventDefault();
			sendKeys(arrowKeys[e.key]);
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

	// Mobile soft keyboards (iOS especially) don't fire reliable repeated
	// keydown events for Backspace during long-press — they fire `beforeinput`
	// with inputType="deleteContentBackward" each time, including at the
	// keyboard's accelerated repeat rate. Mirror handleKeydown's empty-input
	// Backspace forwarding here so long-press-to-delete works on mobile.
	function handleBeforeInput(e: InputEvent) {
		if (e.inputType === 'deleteContentBackward' && textInput === '' && !modArmed) {
			e.preventDefault();
			void sendKeys('BSpace');
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

{#if chordMenuOpen}
	<div class="chord-overlay">
		<div class="chord-panel">
			<div class="chord-title">{chordTitle}</div>
			<div class="chord-stage">
				<div class="chord-ring">
					{#each chordItems as item, i (item.label)}
						{@const pos = chordPositions[i] ?? { x: 0, y: 0 }}
						<div
							class="chord-item"
							class:armed={chordStickArmed && chordIndex === i}
							class:danger={item.danger}
							style:--x="{pos.x}px"
							style:--y="{pos.y}px"
						>
							<iconify-icon icon={item.icon}></iconify-icon>
							<span>{item.label}</span>
						</div>
					{/each}
				</div>
				<div class="chord-deadzone" class:inactive={!chordStickArmed}>
					<span>Cancel</span>
				</div>
				<div
					class="chord-cursor"
					class:armed={chordStickArmed}
					style:--cx="{chordStickX * CHORD_CURSOR_RADIUS_PX}px"
					style:--cy="{chordStickY * CHORD_CURSOR_RADIUS_PX}px"
				></div>
			</div>
			<div
				class="chord-status"
				class:danger={chordStickArmed && chordItems[chordIndex]?.danger}
			>
				{chordStickArmed ? chordItems[chordIndex]?.label ?? '' : 'Release to cancel'}
			</div>
		</div>
	</div>
{/if}

<div class="session-container">
	<header class="header">
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
					<span class="name-text">{currentSession ? getSessionDisplayName(currentSession) : target}</span>
					{#if isClaudeSession}
						<iconify-icon icon="mdi:pencil"></iconify-icon>
					{/if}
				</button>
				{#if statusText}<span class="status">· {statusText}</span>{/if}
			</div>
		</div>
		<div class="header-actions">
			{#each headerActions as action (action.label)}
				<Button
					variant="secondary"
					size="icon-sm"
					onclick={action.run}
					title={action.label}
					class={action.flashing
						? 'bg-emerald-900 text-emerald-300 hover:bg-emerald-900'
						: action.danger
							? 'text-red-400 hover:bg-red-950/40 hover:text-red-300'
							: ''}
				>
					<iconify-icon icon={action.icon} style="font-size: 18px;"></iconify-icon>
				</Button>
			{/each}
		</div>
	</header>

	<div class="output-wrap">
			<div class="output" bind:this={outputElement} onscroll={handleScroll}>
				<TerminalView
					history={terminalStore.history}
					historyStart={terminalStore.historyStart}
					screen={terminalStore.screen}
					themed={preferences.terminalTheming}
					frozen={hasSelection}
				/>
			</div>
			{#if userScrolledUp}
				<button class="jump-bottom" onclick={scrollToBottom} title="Jump to bottom">
					<iconify-icon icon="mdi:arrow-down"></iconify-icon>
					{#if unseenLines > 0}<span>{unseenLines} new</span>{/if}
				</button>
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

			<!-- Commands palette -->
			<Button variant="secondary" size="toolbar" class="flex-1" onclick={() => (commandsOpen = true)}>
				<iconify-icon icon="mdi:lightning-bolt"></iconify-icon>
				<span>Cmds</span>
			</Button>

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
			<!-- Attach popover -->
			<Popover.Root bind:open={attachPickerOpen}>
				<Popover.Trigger class="flex-1 flex-col gap-0.5 px-2 py-1.5 min-w-11 h-auto text-[9px] uppercase tracking-wide inline-flex shrink-0 items-center justify-center rounded-md font-medium cursor-pointer bg-[#222] text-stone-100 hover:bg-[#333]">
					<iconify-icon icon="mdi:paperclip" style="font-size: 18px;"></iconify-icon>
					<span>Attach</span>
				</Popover.Trigger>
				<Popover.Content side="top" class="w-auto p-2 bg-[#1a1a1a] border-[#333]">
					<div class="popover-grid">
						{#if isTouchDevice}
							<Button variant="secondary" size="toolbar" class="min-w-14 min-h-12" onclick={() => openPicker('camera')}>
								<iconify-icon icon="mdi:camera"></iconify-icon>
								<span>Camera</span>
							</Button>
						{/if}
						<Button variant="secondary" size="toolbar" class="min-w-14 min-h-12" onclick={() => openPicker('gallery')}>
							<iconify-icon icon="mdi:image-multiple"></iconify-icon>
							<span>{isTouchDevice ? 'Gallery' : 'Image'}</span>
						</Button>
						<Button variant="secondary" size="toolbar" class="min-w-14 min-h-12" onclick={() => openPicker('files')}>
							<iconify-icon icon="mdi:file-document-outline"></iconify-icon>
							<span>Files</span>
						</Button>
					</div>
				</Popover.Content>
			</Popover.Root>
			<input
				bind:this={cameraInput}
				type="file"
				accept="image/*"
				capture="environment"
				multiple
				class="attach-input-hidden"
				onchange={handlePickerInput}
			/>
			<input
				bind:this={galleryInput}
				type="file"
				accept="image/*,video/*"
				multiple
				class="attach-input-hidden"
				onchange={handlePickerInput}
			/>
			<input
				bind:this={filesInput}
				type="file"
				multiple
				class="attach-input-hidden"
				onchange={handlePickerInput}
			/>
			{#if voiceEnabled}
				<VoiceButton {target} />
			{/if}
		</div>

		<form class="input-row" onsubmit={async (e) => { e.preventDefault(); if (await finishVoiceIfRecording()) { handleResize(); return; } if (modArmed) await sendModSequence(); else await sendFromButton(); handleResize(); }}>
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
			{#if hasAttachments}
				<Popover.Root bind:open={attachStackOpen}>
					<Popover.Trigger
						class="attach-stack"
						title={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
					>
						{#if stackThumbs.length}
							{#each stackThumbs as t, i (t.localId)}
								<img class="attach-stack-thumb" src={t.thumb} alt="" style="--i: {i}" />
							{/each}
						{:else}
							<span class="attach-stack-thumb attach-stack-file" style="--i: 0">
								<iconify-icon icon="mdi:file-outline"></iconify-icon>
							</span>
						{/if}
						<span class="attach-stack-badge" class:attach-stack-badge-failed={anyFailed}>
							{#if anyUploading}
								<iconify-icon class="attach-spin" icon="mdi:loading"></iconify-icon>
							{:else}
								{attachments.length}
							{/if}
						</span>
					</Popover.Trigger>
					<Popover.Content side="top" align="start" class="w-72 p-2 bg-[#1a1a1a] border-[#333]">
						<div class="attach-list">
							{#each attachments as att (att.localId)}
								<div
									class="attach-item"
									class:attach-item-failed={att.status === 'failed'}
									title={att.status === 'failed' ? `Upload failed: ${att.error}` : att.name}
								>
									{#if att.thumb}
										<img class="attach-item-thumb" src={att.thumb} alt="" />
									{:else}
										<span class="attach-item-thumb attach-item-file">
											<iconify-icon icon="mdi:file-outline"></iconify-icon>
										</span>
									{/if}
									<span class="attach-item-name">{att.name}</span>
									{#if att.status === 'uploading'}
										<iconify-icon class="attach-spin" icon="mdi:loading"></iconify-icon>
									{:else if att.status === 'failed'}
										<button type="button" class="attach-item-btn" title="Retry" onclick={() => retryAttachment(att.localId)}>
											<iconify-icon icon="mdi:refresh"></iconify-icon>
										</button>
									{/if}
									<button type="button" class="attach-item-btn" title="Remove" onclick={() => removeAttachment(att.localId)}>
										<iconify-icon icon="mdi:close"></iconify-icon>
									</button>
								</div>
							{/each}
						</div>
						{#if attachments.length > 1}
							<button type="button" class="attach-clear" onclick={clearAttachments}>Remove all</button>
						{/if}
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if slashOpen}
				<div class="slash-popup">
					<CommandList
						bind:this={slashList}
						cwd={currentSession?.cwd}
						pinned={pinnedCommands}
						query={slashQuery}
						onselect={chooseSlash}
					/>
				</div>
			{/if}
			<textarea
				bind:this={textareaElement}
				bind:value={textInput}
				placeholder={modArmed ? 'Type keys, Enter to send as mod sequence…' : 'Type a message...'}
				rows={1}
				onkeydown={handleKeydown}
				onkeyup={(e) => { handleKeyup(e); syncCaret(); }}
				onbeforeinput={handleBeforeInput}
				onblur={handleBlur}
				oninput={() => { syncCaret(); autoResize(); }}
				onclick={syncCaret}
				onfocus={syncCaret}
				onselect={syncCaret}
				onpaste={handlePaste}
			></textarea>
			<div class="send-btn-wrapper"
				oncontextmenu={handleSendContextMenu}
				use:longPress={{ onTrigger: () => (queuePopoverOpen = true) }}
				use:clickOutside={{
					enabled: queuePopoverOpen,
					onOutside: () => (queuePopoverOpen = false)
				}}
			>
				<Button type="submit" variant="success" class="min-w-[52px] min-h-[48px] text-lg touch-manipulation select-none" disabled={!canSend} title="Send · empty: tap = Enter, double-tap = accept suggestion (Tab+Enter) · long-press = queue">
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

<CommandPalette bind:open={commandsOpen} cwd={currentSession?.cwd} pinned={pinnedCommands} onselect={fillInput} />

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

{#if dropActive}
	<div class="drop-overlay">
		<iconify-icon icon="mdi:tray-arrow-down"></iconify-icon>
		<span>Drop files to attach</span>
	</div>
{/if}

<style>
	.chord-overlay {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		z-index: 1000;
		pointer-events: none;
		background: radial-gradient(ellipse at center, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.92) 100%);
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		animation: chord-fade-in 120ms ease-out;
	}
	@keyframes chord-fade-in {
		from { opacity: 0; transform: scale(0.96); }
		to   { opacity: 1; transform: scale(1); }
	}
	.chord-panel {
		position: relative;
		padding: 1.25rem 1.5rem 1rem;
		background: linear-gradient(180deg, #14141a, #0a0a0d);
		border: 1px solid rgba(226, 160, 82, 0.22);
		border-radius: 14px;
		box-shadow:
			0 0 0 1px rgba(226, 160, 82, 0.06),
			0 24px 60px rgba(0, 0, 0, 0.7),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}
	.chord-title {
		color: #e2a052;
		font-size: 0.65rem;
		letter-spacing: 0.32em;
		text-transform: uppercase;
		text-align: center;
		opacity: 0.7;
		margin-bottom: 0.85rem;
	}
	.chord-stage {
		position: relative;
		isolation: isolate;
		width: 30rem;
		height: 30rem;
	}
	.chord-ring {
		position: absolute;
		inset: 0;
	}
	.chord-item {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 4.5rem;
		min-height: 4.5rem;
		transform: translate(calc(-50% + var(--x, 0px)), calc(-50% + var(--y, 0px)));
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		padding: 0.4rem 0.3rem;
		background: rgba(22, 22, 28, 0.65);
		border: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 50%;
		color: rgba(255, 255, 255, 0.5);
		font-size: 0.55rem;
		letter-spacing: 0.03em;
		text-align: center;
		transition:
			border-color 140ms,
			background 140ms,
			color 140ms,
			box-shadow 140ms,
			scale 140ms cubic-bezier(0.2, 0.9, 0.2, 1);
	}
	.chord-item iconify-icon { font-size: 26px; }
	.chord-item.armed {
		background: linear-gradient(180deg, rgba(226,160,82,0.22), rgba(226,160,82,0.04));
		border-color: rgba(226, 160, 82, 0.85);
		color: #fff;
		scale: 1.15;
		box-shadow:
			0 0 28px rgba(226, 160, 82, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}
	.chord-item.danger.armed {
		border-color: rgba(239, 68, 68, 0.9);
		background: linear-gradient(180deg, rgba(239,68,68,0.22), rgba(239,68,68,0.04));
		color: #fecaca;
		box-shadow: 0 0 28px rgba(239, 68, 68, 0.35);
	}
	.chord-deadzone {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 6.5rem;
		height: 6.5rem;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		border: 1.5px dashed rgba(255, 255, 255, 0.18);
		display: grid;
		place-items: center;
		pointer-events: none;
		z-index: 2;
		transition: border-color 180ms, background 180ms;
	}
	.chord-deadzone span {
		font-size: 0.6rem;
		letter-spacing: 0.25em;
		color: rgba(255, 255, 255, 0.25);
		opacity: 0;
		transition: opacity 160ms, color 160ms;
		text-transform: uppercase;
	}
	.chord-deadzone.inactive {
		border-color: rgba(239, 68, 68, 0.55);
		background: radial-gradient(circle, rgba(239, 68, 68, 0.10) 0%, transparent 70%);
	}
	.chord-deadzone.inactive span {
		opacity: 1;
		color: rgba(252, 165, 165, 0.85);
	}
	.chord-cursor {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		transform: translate(calc(-50% + var(--cx, 0px)), calc(-50% + var(--cy, 0px)));
		background: rgba(239, 68, 68, 0.9);
		box-shadow:
			0 0 10px rgba(239, 68, 68, 0.5),
			0 0 20px rgba(239, 68, 68, 0.25);
		pointer-events: none;
		z-index: 3;
		will-change: transform;
		transition: background 100ms, box-shadow 100ms;
	}
	.chord-cursor.armed {
		background: #e2a052;
		box-shadow:
			0 0 12px rgba(226, 160, 82, 0.9),
			0 0 28px rgba(226, 160, 82, 0.45);
	}
	.chord-cursor::before {
		content: '';
		position: absolute;
		inset: -8px;
		border-radius: 50%;
		border: 1px solid currentColor;
		opacity: 0.25;
	}
	.chord-status {
		margin-top: 1rem;
		text-align: center;
		font-size: 0.72rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.75);
		min-height: 1rem;
	}
	.chord-status.danger {
		color: #fca5a5;
	}

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

	/* Sidebar-toggle hamburger overlaps the header on narrow viewports */
	@media (max-width: 768px) {
		.header {
			min-height: 40px;
			padding: 4px 6px 4px 44px;
			gap: 6px;
		}
		.header-actions {
			gap: 4px;
		}
		.toolbar :global(button) {
			border-radius: 3px;
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
		flex-shrink: 0;
	}

	.output-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.jump-bottom {
		position: absolute;
		right: 18px;
		bottom: 12px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border-radius: 999px;
		border: 1px solid #3a3a3a;
		background: rgba(30, 30, 30, 0.92);
		color: #e5e5e5;
		font-size: 12px;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
		z-index: 5;
	}
	.jump-bottom:hover {
		background: #2a2a2a;
	}
	.jump-bottom iconify-icon {
		font-size: 16px;
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

	.toolbar {
		display: flex;
		gap: 6px;
		padding: 8px 12px;
		background: #111;
		border-top: 1px solid #222;
	}

	.input-row {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 12px 16px;
		background: #111;
		border-top: 1px solid #222;
	}

	.slash-popup {
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 100%;
		margin-bottom: 6px;
		max-height: min(50dvh, 420px);
		display: flex;
		flex-direction: column;
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 8px;
		overflow: hidden;
		z-index: 10;
		box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
		color: #f5f5f4;
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

	:global(.attach-stack) {
		position: relative;
		flex-shrink: 0;
		width: 48px;
		height: 48px;
		border: 0;
		background: transparent;
		padding: 0;
		cursor: pointer;
	}
	.attach-stack-thumb {
		position: absolute;
		left: 0;
		top: 0;
		width: 40px;
		height: 40px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid #3a6ad4;
		background: #1f2c44;
		transform: translate(calc(var(--i) * 4px), calc(var(--i) * 4px));
		z-index: calc(3 - var(--i));
	}
	.attach-stack-file {
		display: flex;
		align-items: center;
		justify-content: center;
		color: #d4e3ff;
		font-size: 22px;
	}
	.attach-stack-badge {
		position: absolute;
		right: -4px;
		top: -4px;
		z-index: 4;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 9px;
		background: #27ae60;
		color: #fff;
		font-size: 11px;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.attach-stack-badge-failed {
		background: #d44d4d;
	}
	.attach-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 50vh;
		overflow-y: auto;
	}
	.attach-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px;
		border-radius: 6px;
		color: #d4e3ff;
		font-size: 12px;
	}
	.attach-item:hover {
		background: rgba(255, 255, 255, 0.06);
	}
	.attach-item-failed {
		color: #ffd4d4;
	}
	.attach-item-thumb {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		object-fit: cover;
		border-radius: 6px;
		background: #1f2c44;
	}
	.attach-item-file {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 22px;
	}
	.attach-item-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.attach-item-btn {
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		cursor: pointer;
		font-size: 18px;
	}
	.attach-item-btn:hover {
		background: rgba(255, 255, 255, 0.12);
	}
	.attach-clear {
		margin-top: 6px;
		width: 100%;
		padding: 6px;
		border: 0;
		border-radius: 6px;
		background: #2a2a2a;
		color: #ccc;
		font-size: 12px;
		cursor: pointer;
	}
	.attach-clear:hover {
		background: #4a1d22;
		color: #ffd4d4;
	}
	.attach-spin {
		animation: attach-spin 1s linear infinite;
	}
	@keyframes attach-spin {
		to { transform: rotate(360deg); }
	}

	.attach-input-hidden {
		position: absolute;
		left: -9999px;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.drop-overlay {
		position: fixed;
		inset: 0;
		background: rgba(20, 40, 80, 0.55);
		backdrop-filter: blur(2px);
		z-index: 9999;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		border: 3px dashed #4f8df7;
		color: #d4e3ff;
		font-size: 20px;
		font-weight: 600;
		gap: 12px;
	}
	.drop-overlay iconify-icon {
		font-size: 48px;
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
