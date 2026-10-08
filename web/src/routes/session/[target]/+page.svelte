<script lang="ts">
	import { page } from '$app/stores';
	import { goto, afterNavigate } from '$app/navigation';
	import { browser } from '$app/environment';
	import { reportClient } from '$lib/client-log';
	import { onDestroy, onMount, tick } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { sessionStore, getSessionDisplayName, attentionPrefix, postVisit } from '$lib/stores/sessions.svelte';
	import SessionStateIndicator from '$lib/components/SessionStateIndicator.svelte';
	import { sessionStateVisual, indicatorStateOf, isUnread, type IndicatorState } from '$shared/session-state.js';
	import { tmuxPanesStore } from '$lib/stores/tmuxPanes.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Popover from '$lib/components/ui/popover';
	import TerminalView from '$lib/components/TerminalView.svelte';
	import TranscriptView from '$lib/components/TranscriptView.svelte';
	import AgentRail from '$lib/components/AgentRail.svelte';
	import { transcriptStore } from '$lib/stores/transcript.svelte';
	import ContextGauge from '$lib/components/ContextGauge.svelte';
	import RailStats from '$lib/components/RailStats.svelte';
	import VoiceMeter from '$lib/components/VoiceMeter.svelte';
	import PaneDraftBar from '$lib/components/PaneDraftBar.svelte';
	import QueueStrip from '$lib/components/QueueStrip.svelte';
	import type { QueuedMessageInfo } from '$shared/types/ws-messages.js';
	import VoiceButton from '$lib/components/VoiceButton.svelte';
	import KeyTray from '$lib/components/KeyTray.svelte';
	import SessionSheet from '$lib/components/SessionSheet.svelte';
	import { drawer } from '$lib/stores/drawer.svelte';
	import Hint from '$lib/components/Hint.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { modelDisplayName } from '$shared/claude/model-name.js';
	import { serverStore } from '$lib/stores/servers.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import CommandList from '$lib/components/CommandList.svelte';
	import RenameSessionDialog from '$lib/components/RenameSessionDialog.svelte';
	import { voiceStore } from '$lib/stores/voice.svelte';
	import { draftsStore } from '$lib/stores/drafts.svelte';
	import { attachmentsStore, type Attachment } from '$lib/stores/attachments.svelte';
	import { untrack } from 'svelte';
	import { swipe } from '$lib/actions/swipe';
	import { STORAGE_KEYS } from '$lib/constants';
	import { useGamepad, STICK_DEADZONE } from '$lib/gamepad.svelte';
	import { sidebarActionsStore, type ChordAction } from '$lib/stores/sidebarActions.svelte';
	import { viewModesStore } from '$lib/stores/viewModes.svelte';

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
	// Dead panes and plain (non-Claude) panes are row states, not Claude states.
	const indicatorState = $derived<IndicatorState>(
		paneIsDead ? 'dead' : isPlainPane ? 'plain' : currentSession ? indicatorStateOf(currentSession) : 'idle'
	);
	// Browser tab: the state emoji rides in front of the name, so a background
	// tab says whether the session wants a human without being opened, and
	// the count before it says how many sessions anywhere want one or are done.
	const attention = $derived(attentionPrefix(sessionStore.sessions));
	const pageTitle = $derived(
		`${attention}${sessionStateVisual(indicatorState).emoji} ${
			currentSession ? getSessionDisplayName(currentSession) : (target || 'Session')
		}`
	);

	// The unread "Done" watermark: opening the session stamps it, and so does
	// a turn that finishes while the page is in front of someone — the same
	// visit clears the badge on every other browser. Split panes are this page
	// in a frame, so they count too. Adapted from t3code's ChatView visit
	// effect (MIT, © T3 Tools Inc.).
	let pageVisible = $state(browser && document.visibilityState === 'visible');
	onMount(() => {
		const onVisibility = () => (pageVisible = document.visibilityState === 'visible');
		document.addEventListener('visibilitychange', onVisibility);
		return () => document.removeEventListener('visibilitychange', onVisibility);
	});
	/** The session this page last stamped, and when: one post per change, not per broadcast. */
	let lastVisit: { id: string; at: number } | null = null;
	$effect(() => {
		const s = currentSession;
		if (!s || !pageVisible) return;
		const fresh = lastVisit?.id !== s.id;
		if (!fresh && (!isUnread(s) || Date.now() - lastVisit!.at < 2000)) return;
		lastVisit = { id: s.id, at: Date.now() };
		postVisit('', s.id);
	});
	// Inline status next to the title. Skip bare states (idle/busy/etc.)
	// since the state symbol + color already convey them; only show when
	// there's information the symbol can't carry.
	const statusText = $derived.by(() => {
		if (paneIsDead) return 'pane closed';
		if (isPlainPane) return tmuxPane?.command || null;
		return currentSession?.current_action || null;
	});

	// Transcript view exists only for Claude sessions (the JSONL is Claude Code's own log).
	const canTranscript = $derived(isClaudeSession && (currentSession?.agent ?? 'claude') === 'claude');
	// Each view has its own URL: `?view=terminal` is the raw mirror. Without the
	// param, the session reopens in whichever view it was last left in.
	/**
	 * This page is one pane of a split, drawn inside the split page's iframe.
	 * The composer then carries the pane's controls — swap, zoom, close — and
	 * asks the page outside for them with postMessage; the page outside only
	 * ever tells this one whether it holds the focus.
	 */
	const embed = $derived($page.url.searchParams.has('embed'));
	let paneFocused = $state(false);
	let paneSide = $state<'a' | 'b' | null>(null);
	/** Whether this pane runs on the same host as the page outside; a remote one names its host. */
	let paneLocal = $state(true);
	/** This host's tailnet name, for the label a pane on another host needs. */
	const machineName = $derived(embed ? serverStore.self || serverStore.current.hostname : '');

	function tellPane(action: 'focus' | 'focus-other' | 'swap' | 'zoom' | 'close' | 'ready') {
		if (!embed || window.parent === window) return;
		window.parent.postMessage({ type: 'claude-mux:pane', action }, '*');
	}

	onMount(() => {
		if (!embed) return;
		serverStore.init();
		const onMessage = (e: MessageEvent) => {
			if (e.source !== window.parent) return;
			const msg = e.data as { type?: string; focused?: boolean; side?: 'a' | 'b'; local?: boolean } | null;
			if (msg?.type !== 'claude-mux:focus') return;
			paneFocused = msg.focused === true;
			paneSide = msg.side ?? null;
			paneLocal = msg.local !== false;
		};
		// Any interaction inside the pane is a claim on the focus.
		const onPointer = () => tellPane('focus');
		const onKeys = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && (e.key === '1' || e.key === '2')) {
				e.preventDefault();
				const wanted = e.key === '1' ? 'a' : 'b';
				tellPane(wanted === paneSide ? 'focus' : 'focus-other');
			}
		};
		window.addEventListener('message', onMessage);
		window.addEventListener('pointerdown', onPointer, true);
		window.addEventListener('focus', onPointer);
		window.addEventListener('keydown', onKeys, true);
		tellPane('ready');
		return () => {
			window.removeEventListener('message', onMessage);
			window.removeEventListener('pointerdown', onPointer, true);
			window.removeEventListener('focus', onPointer);
			window.removeEventListener('keydown', onKeys, true);
		};
	});

	const viewMode = $derived.by(() => {
		if (!canTranscript) return 'terminal';
		const param = $page.url.searchParams.get('view');
		if (param === 'terminal' || param === 'transcript') return param;
		return viewModesStore.get(target);
	});

	function toggleView() {
		const next = viewMode === 'transcript' ? 'terminal' : 'transcript';
		viewModesStore.set(target, next);
		const params = new URLSearchParams($page.url.searchParams);
		if (next === 'terminal') params.set('view', 'terminal');
		else params.delete('view');
		const query = params.toString();
		goto(`${$page.url.pathname}${query ? `?${query}` : ''}`, { noScroll: true, keepFocus: true });
	}

	let textInput = $state('');
	/** Ctrl/⌘ is held, so the primary button shows what Ctrl/⌘+Enter would do. */
	let steerHeld = $state(false);
	/**
	 * A queued message loaded into the composer. What was typed before is put
	 * aside and comes back once the edit is saved or cancelled.
	 */
	let editing = $state<{ target: string; id: string; draft: string } | null>(null);
	/** Said once, when an edit outlived the message it was editing. */
	let editNotice = $state<string | null>(null);
	let showConfirmKill = $state(false);
	let showConfirmRestart = $state(false);
	let moreOpen = $state(false);
	let commandsOpen = $state(false);
	let attachPickerOpen = $state(false);
	let attachStackOpen = $state(false);
	let ctrlCount = $state(0);
	let altCount = $state(0);

	/** The key tray, and the sheet that replaced the page header. */
	let trayOpen = $state(false);
	let sheetOpen = $state(false);
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
		...(isAlive && canTranscript
			? [
					{
						label: viewMode === 'transcript' ? 'Terminal view' : 'Transcript view',
						icon: viewMode === 'transcript' ? 'mdi:console' : 'mdi:message-text-outline',
						run: () => toggleView()
					}
				]
			: []),
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
		// Remote Control: on, the row opens the session in the Claude app; off,
		// it asks the session to turn it on through the control queue.
		...(isAlive && isClaudeSession
			? [
					currentSession?.rc_url
						? {
								label: 'Open in Claude app',
								icon: 'mdi:cellphone-link',
								run: () => window.open(currentSession?.rc_url ?? '', '_blank')
							}
						: {
								label: 'Remote Control',
								icon: 'mdi:cellphone-link-off',
								run: () => void connectRemoteControl()
							}
				]
			: []),
		...(isAlive && isClaudeSession
			? [{ label: 'Restart Claude', icon: 'mdi:restart', run: () => (showConfirmRestart = true) }]
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

	const attachments = $derived(attachmentsStore.get(target));
	let cameraInput: HTMLInputElement | null = $state(null);
	let galleryInput: HTMLInputElement | null = $state(null);
	let filesInput: HTMLInputElement | null = $state(null);
	let isTouchDevice = $state(false);
	let dropActive = $state(false);

	const canSend = $derived(attachments.every((a) => a.status === 'ready'));
	const readyPaths = $derived(
		attachments.filter((a) => a.status === 'ready' && a.path).map((a) => a.path!)
	);
	const hasDraft = $derived(textInput.trim().length > 0 || readyPaths.length > 0);
	/** Claude Code's ghost-text proposal in the pane's prompt box, if any. */
	const suggestion = $derived(
		currentSession?.draft_kind === 'suggestion' ? (currentSession?.draft_input ?? null) : null
	);
	/** The action button names what it will do rather than always saying "send". */
	const actionKind = $derived.by(() => {
		if (modArmed) return 'keys' as const;
		if (!hasDraft) {
			return suggestion != null ? ('accept' as const) : ('enter' as const);
		}
		if (editing) return 'save' as const;
		if (isIdle) return 'send' as const;
		// Holding Ctrl/⌘ turns the button into what Ctrl/⌘+Enter does.
		return isBusy && steerHeld ? ('steer' as const) : ('queue' as const);
	});

	const ACTIONS = {
		keys: { label: 'Keys', icon: 'mdi:arrow-up-bold' },
		accept: { label: 'Accept', icon: 'mdi:keyboard-tab' },
		enter: { label: 'Enter', icon: 'mdi:keyboard-return' },
		send: { label: 'Send', icon: 'mdi:arrow-up' },
		queue: { label: 'Queue', icon: 'mdi:playlist-plus' },
		steer: { label: 'Steer', icon: 'mdi:arrow-right-top' },
		save: { label: 'Save', icon: 'mdi:content-save-outline' }
	} as const;
	/** An armed modifier names the sequence it will send, not the verb. */
	const actionLabel = $derived(
		actionKind === 'keys'
			? [ctrlCount > 0 ? 'Ctrl' : '', altCount > 0 ? 'Alt' : ''].filter(Boolean).join('+')
			: ACTIONS[actionKind].label
	);
	const actionIcon = $derived(ACTIONS[actionKind].icon);
	const hasAttachments = $derived(attachments.length > 0);
	const anyFailed = $derived(attachments.some((a) => a.status === 'failed'));
	const anyUploading = $derived(attachments.some((a) => a.status === 'uploading'));
	/** The pane is asking for a keypress, so the face toggle asks for attention. */
	const wantsKeypress = $derived(
		currentSession?.state === 'waiting' || currentSession?.state === 'permission'
	);
	$effect(() => {
		if (!hasAttachments) attachStackOpen = false;
	});



	const isBusy = $derived((currentSession?.state ?? 'idle') === 'busy');
	const isIdle = $derived((currentSession?.state ?? 'idle') === 'idle');

	/** What tmux calls the arrows the browser reports. */
	const ARROW_KEYS: Record<string, string> = {
		ArrowUp: 'Up',
		ArrowDown: 'Down',
		ArrowLeft: 'Left',
		ArrowRight: 'Right'
	};

	/** Apple keyboards say ⌘ where everyone else says Ctrl. */
	const MOD_LABEL =
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl';

	/**
	 * Shortcuts for the controls that have no caption to name them.
	 *
	 * Deliberately avoids Ctrl+J and Ctrl+W, which Chrome keeps for itself and
	 * will not hand back however hard the page asks.
	 */
	function handleGlobalKeys(e: KeyboardEvent) {
		if (handleChooserKeys(e)) return;
		// The voice key works wherever focus is; the composer handles it
		// itself when it has focus, and marks the event so it is not taken twice.
		if (!e.defaultPrevented && !e.repeat && isVoiceHotkey(e)) {
			e.preventDefault();
			if (target && (!voiceStore.isActive || voiceStore.isOwnedBy(target))) {
				void voiceStore.toggle(target);
			}
			return;
		}
		if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
		const key = e.key.toLowerCase();
		if (key === 'k') {
			e.preventDefault();
			commandsOpen = !commandsOpen;
		} else if (key === '.') {
			e.preventDefault();
			trayOpen = !trayOpen;
		} else if (key === 'e' && isAlive && canTranscript) {
			e.preventDefault();
			toggleView();
		}
	}

	/**
	 * The dialog the pane is drawing, as the poll read it. The server gates
	 * this on the state the hooks report — or, for a dialog a local command
	 * such as `/model` opens while the session is idle, on the pane naming its
	 * own keys — so a numbered list in Claude's prose never arrives here.
	 */
	const paneChoice = $derived(currentSession?.pane_choice ?? null);

	/**
	 * The pane has a dialog's text field open — the free-text row, or an
	 * option's notes. An empty Enter there would decline the question, so
	 * the composer leaves it to the card's own field.
	 */
	const paneTyping = $derived(paneChoice?.typing === true || paneChoice?.noting === true);

	/** Anything drawn over the page that answers to the keyboard itself. */
	const overlayOpen = $derived(
		commandsOpen || moreOpen || trayOpen || sheetOpen || chordMenuOpen || attachPickerOpen ||
			attachStackOpen
	);

	/** Element types that keep their own keystrokes. */
	const TYPING_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

	/**
	 * Answer the pane's dialog from the keyboard while nothing else wants the
	 * keys: no draft, and focus on no field. Enter takes the row the pane has
	 * highlighted, Escape declines, and the arrows walk it — the same keys the
	 * dialog answers to in the terminal. Returns whether the key was spent here.
	 */
	function handleChooserKeys(e: KeyboardEvent): boolean {
		if (!paneChoice || hasDraft || paneTyping || overlayOpen) return false;
		if (e.ctrlKey || e.metaKey || e.altKey) return false;
		const el = e.target as HTMLElement | null;
		if (el?.isContentEditable || TYPING_TAGS.test(el?.tagName ?? '')) return false;
		const key = e.key === 'Enter' || e.key === 'Escape' ? e.key : ARROW_KEYS[e.key];
		if (!key) return false;
		e.preventDefault();
		// Enter on the highlighted free-text row would decline the question:
		// the card's field is where its answer goes.
		if (key === 'Enter' && paneChoice.options.find((o) => o.selected)?.text) {
			focusDialogField();
			return true;
		}
		void sendKeys(key);
		return true;
	}

	/** Hands the keyboard to the dialog card's own text field. */
	function focusDialogField() {
		outputElement?.querySelector<HTMLInputElement>('[data-dialog-input]')?.focus();
	}

	/**
	 * The rare half of the old page header, folded into the session sheet.
	 *
	 * Derived from `headerActions` rather than restated, so the sheet and the
	 * gamepad chord menu can never drift apart. The composer draws the view
	 * toggle and the kill as controls of their own, so those two come out.
	 */
	const sheetActions = $derived([
		...(isClaudeSession
			? [
					{
						label: 'Rename',
						icon: 'mdi:pencil',
						run: () => (renameId = currentSession?.id ?? null)
					}
				]
			: []),
		...headerActions.filter(
			(a) => !a.danger && a.label !== 'Terminal view' && a.label !== 'Transcript view'
		)
	]);
	// Tap candidate: modifier keydown with no intervening key → arm on keyup
	let ctrlTapCandidate = false;
	let altTapCandidate = false;
	/** The model on the latest reply, named the way the terminal names it. */
	const modelName = $derived(modelDisplayName(transcriptStore.model));
	const paneUpdate = $derived(currentSession?.pane_update ?? null);
	const UPDATE_LABEL = {
		installed: 'Update installed · restart to apply',
		available: 'Update available',
		failed: 'Auto-update failed'
	} as const;
	const queue = $derived(currentSession?.queue ?? []);
	const queueCount = $derived(queue.length);
	/** Shown only in the transcript, which is the view that streams them. */
	/** Every subagent the transcript knows; the rail decides which to show. */
	const railAgents = $derived(
		viewMode === 'transcript' ? Object.values(transcriptStore.subagents) : []
	);
	const railShowing = $derived(railAgents.some((a) => a.running));

	function findCard(toolUseId: string): HTMLDetailsElement | null {
		return (
			outputElement?.querySelector<HTMLDetailsElement>(
				`[data-entry-id="${CSS.escape(toolUseId)}"]`
			) ?? null
		);
	}

	/** How many older slices to pull in looking for a card before giving up. */
	const REVEAL_PAGES = 40;

	/**
	 * Scroll the transcript to an agent's Task card and open it. A long
	 * session holds only its tail, so a card the socket never sent is asked
	 * for, slice by slice, until it is on the page or the history runs out.
	 */
	async function revealAgent(toolUseId: string) {
		let card = findCard(toolUseId);
		for (let i = 0; !card && i < REVEAL_PAGES && transcriptStore.firstIndex > 0; i++) {
			await transcriptStore.loadEarlier();
			await tick();
			card = findCard(toolUseId);
		}
		if (!card) return;
		card.open = true;
		userScrolledUp = true;
		card.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	/** The transcript's live status row is showing (its height affects scroll). */
	const liveRowVisible = $derived(
		viewMode === 'transcript' && !isIdle
	);

	// Clear whatever is typed in Claude's prompt: Ctrl+E (end of line) then
	// Ctrl+U repeatedly (delete to line start; repeats walk up multiline input).
	// Extra Ctrl+U on an empty prompt is a no-op, so over-sending is safe.
	const CLEAR_PROMPT_KEYS = 'C-e ' + Array(12).fill('C-u').join(' ');

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
		{ label: 'Clear', keys: CLEAR_PROMPT_KEYS, icon: 'mdi:eraser' },
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
	// Only one view is attached at a time, so a single counter serves both.
	const appendedNow = $derived(
		viewMode === 'transcript' ? transcriptStore.appended : terminalStore.appended
	);
	const unseenLines = $derived(
		userScrolledUp ? Math.max(0, appendedNow - seenAppended) : 0
	);

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
	// and history reset together; only attach when target is confirmed alive
	// and the raw mirror is the active view.
	$effect(() => {
		terminalStore.setTarget(isAlive && viewMode === 'terminal' ? target : null);
	});

	// Same contract for the transcript store, keyed by session id.
	$effect(() => {
		transcriptStore.setSession(
			isAlive && viewMode === 'transcript' ? (currentSession?.id ?? null) : null
		);
	});

	// New target: forget any scrolled-up state from the previous session so the
	// view always opens pinned to the latest output.
	$effect(() => {
		target;
		viewMode;
		untrack(() => {
			userScrolledUp = false;
			seenAppended = 0;
			terminalStore.atBottom = true;
			// Re-pin after a view switch: content height changes completely.
			tick().then(() => {
				if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
			});
		});
	});

	onDestroy(() => {
		terminalStore.setTarget(null);
		transcriptStore.setSession(null);
	});

	// The page has been seen showing one session while the URL named another,
	// and only sometimes. A beat after every navigation, compare the two and
	// write what the page believed to the server log, so the next report
	// comes with the state that produced it.
	afterNavigate(() => {
		setTimeout(() => {
			const urlTarget = decodeURIComponent(location.pathname.split('/session/')[1] ?? '');
			const shown = currentSession?.tmux_target ?? target;
			if (urlTarget && shown && urlTarget !== shown) {
				reportClient('stale', {
					urlTarget,
					target,
					shown,
					currentSessionId: currentSession?.id ?? null,
					sessionsKnown: sessionStore.sessions.length,
					targetInStore: sessionStore.sessions.some((s) => s.tmux_target === urlTarget),
					viewMode,
					isAlive,
					transcriptAvailable: transcriptStore.available,
					transcriptEntries: transcriptStore.entries.length,
					connected: sessionStore.connected
				});
			}
		}, 800);
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
			// An edit belongs to its session: leaving it gives that session its
			// own draft back, and the queued message keeps its text.
			if (editing && editing.target !== t) {
				draftsStore.set(editing.target, editing.draft);
				editing = null;
			}
			editNotice = null;
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
			seenAppended = appendedNow;
			if (!nextScrolledUp) terminalStore.trimToBottom();
		}
		// Whatever the reader stopped on is what we hold them to if the content
		// above them grows while they read.
		if (nextScrolledUp) captureAnchor();

		// Near the top: fetch an older chunk and keep the viewport anchored on the
		// same content (history only ever grows at the ends, so the distance from
		// the bottom is a stable anchor).
		if (scrollTop < 200 && !hasSelection && !terminalStore.historyAtStart) {
			const pending = terminalStore.requestMoreHistory();
			if (pending) holdPlaceThrough(pending);
		}
	}

	/**
	 * Chrome and Firefox hold the reader's place natively (CSS scroll anchoring)
	 * when something above the viewport changes height — a tool result filling
	 * into a card the reader has already scrolled past. Safari, and therefore
	 * every browser on iOS, does not implement it, so there we keep the anchor
	 * ourselves: the topmost row still on screen, and how far below the top of
	 * the viewport it sat.
	 */
	const nativeScrollAnchoring = !browser || CSS.supports('overflow-anchor: auto');
	let anchorNode: HTMLElement | null = null;
	let anchorOffset = 0;

	/**
	 * The transcript rows, which are the only thing worth anchoring to: the
	 * terminal is a single <pre> with no per-row elements, and its one insertion
	 * from above goes through holdPlaceThrough instead.
	 */
	function anchorRows(): HTMLCollection | null {
		return outputElement?.querySelector('.transcript')?.children ?? null;
	}

	function captureAnchor() {
		anchorNode = null;
		const rows = nativeScrollAnchoring ? null : anchorRows();
		if (!rows || rows.length === 0 || !outputElement) return;
		// Rows are stacked in DOM order, so their edges are sorted: binary-search
		// for the topmost one still on screen rather than measuring every row
		// above the reader on every scroll event.
		const top = outputElement.getBoundingClientRect().top;
		let lo = 0;
		let hi = rows.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (rows[mid].getBoundingClientRect().bottom > top) hi = mid;
			else lo = mid + 1;
		}
		anchorNode = rows[lo] as HTMLElement;
		anchorOffset = anchorNode.getBoundingClientRect().top - top;
	}

	function restoreAnchor() {
		if (nativeScrollAnchoring || !outputElement || !anchorNode?.isConnected) return;
		const top = outputElement.getBoundingClientRect().top;
		const drift = anchorNode.getBoundingClientRect().top - top - anchorOffset;
		if (Math.abs(drift) >= 1) outputElement.scrollTop += drift;
	}

	/**
	 * Hold the reader's place across an insertion *above* them — older terminal
	 * history, or the transcript's "load earlier". Both only ever grow at the
	 * ends, so the distance to the bottom is a stable anchor; `pending` says
	 * when the new content has arrived, and rAF lets it lay out first.
	 */
	function holdPlaceThrough(pending: Promise<unknown>) {
		const el = outputElement;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop;
		pending.then(() =>
			requestAnimationFrame(() => {
				if (outputElement) outputElement.scrollTop = outputElement.scrollHeight - fromBottom;
			})
		);
	}

	function scrollToBottom() {
		if (!outputElement) return;
		userScrolledUp = false;
		terminalStore.atBottom = true;
		seenAppended = appendedNow;
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
		transcriptStore.entries.length;
		// A boolean, not the action text: the latter changes on every 500ms
		// broadcast and would force a layout read/write twice a second.
		liveRowVisible;
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
	// keyboard on mobile, fonts loading, a tool result filling in a card that is
	// already on screen): keep the view pinned through those too.
	//
	// The observed set has to be re-synced when .output swaps its content.
	// Switching between the transcript and the terminal — including the restore
	// of the view this session was last in — replaces the child we watch, and an
	// observer left on the detached node never fires again, so the swap point
	// (viewMode) is a dependency: effects run after the DOM update, so the new
	// child is in place by the time this re-observes.
	$effect(() => {
		viewMode;
		const el = outputElement;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (hasSelection) return;
			if (userScrolledUp) restoreAnchor();
			else el.scrollTop = el.scrollHeight;
		});
		ro.observe(el);
		for (const child of el.children) ro.observe(child);
		return () => ro.disconnect();
	});

	async function postToPane(body: Record<string, unknown>) {
		if (!target) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
	}

	const sendKeys = (keys: string) => postToPane({ keys });

	/** Types text into the pane as it is, with no Enter: a dialog's own text field. */
	const sendPaneText = (text: string) => postToPane({ text, raw: true });

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
		// The dialog's text field is open: a bare Enter would decline it.
		if (paneTyping) return focusDialogField();
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
		if (editing) {
			await saveEdit();
			return;
		}
		const paths = readyPaths;
		if (!textInput.trim() && paths.length === 0) {
			// Empty input: just send Enter key — unless the dialog's text field
			// is open, where an empty Enter declines the question.
			if (paneTyping) return focusDialogField();
			await sendKeys('Enter');
			return;
		}
		// An idle pane drawing a dialog (a local command's picker) would take
		// the text as keys and the Enter as a pick; the draft waits instead.
		if (isIdle && paneChoice) {
			editNotice = 'A dialog is open in the pane. Answer it in the card above, then send.';
			return;
		}
		// Busy, or a dialog open: the message waits in the queue for its own turn.
		if (!isIdle) {
			await queueText();
			return;
		}
		const sent = composed(target);
		const res = await fetch(`/api/sessions/${encodeURIComponent(sent.target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: sent.text, attachments: paths })
		});
		if (!res.ok) {
			// The draft stays put, so nothing typed is lost on a failed send.
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			alert(`Could not send: ${body.error ?? res.statusText}`);
			return;
		}
		clearSent(sent);
	}

	interface Composed {
		target: string;
		text: string;
		chipIds: string[];
	}

	/** What a send is about to deliver, taken before it awaits the server. */
	function composed(t: string): Composed {
		return { target: t, text: textInput, chipIds: attachments.map((a) => a.localId) };
	}

	/**
	 * Take a delivered message out of its session's composer. The send awaited
	 * the server, so the user may be on another session by now, or have added to
	 * this one: only the text and chips that went out are cleared, and in the
	 * session they went to.
	 */
	function clearSent(sent: Composed) {
		for (const id of sent.chipIds) attachmentsStore.remove(sent.target, id);
		if (sent.target !== target) {
			if (draftsStore.get(sent.target) === sent.text) draftsStore.set(sent.target, '');
			return;
		}
		if (textInput !== sent.text) return;
		textInput = '';
		if (textareaElement) textareaElement.style.height = 'auto';
	}

	/** A message composed elsewhere on the page — a grilling round's answers. */
	async function sendReply(text: string): Promise<boolean> {
		if (!target) return false;
		const res = await fetch(`/api/sessions/${encodeURIComponent(target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text })
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			alert(`Could not send: ${body.error ?? res.statusText}`);
			return false;
		}
		return true;
	}

	async function sendTextRaw() {
		if (!target) return;
		if (!canSend) return;
		const paths = readyPaths;
		if (!textInput && paths.length === 0) return;
		const sent = composed(target);
		const res = await fetch(`/api/sessions/${encodeURIComponent(sent.target)}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: sent.text, raw: true, attachments: paths })
		});
		if (res.ok) clearSent(sent);
	}

	/** Ask the session to turn Remote Control on; the poll picks up the URL. */
	async function connectRemoteControl() {
		if (!target) return;
		await fetch(`/api/sessions/${encodeURIComponent(target)}/rc`, { method: 'POST' });
	}

	async function acceptSuggestion() {
		await sendKeys('Tab Enter');
	}

	/** Post the draft to a route that delivers it; it leaves the composer only once taken. */
	async function deliver(route: 'queue' | 'steer') {
		if (!target || !canSend || !hasDraft) return;
		const sent = composed(target);
		const res = await fetch(`/api/sessions/${encodeURIComponent(sent.target)}/${route}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: sent.text, attachments: readyPaths })
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			alert(`Could not ${route}: ${body.error ?? res.statusText}`);
			return;
		}
		clearSent(sent);
	}
	const queueText = () => deliver('queue');
	const steerText = () => deliver('steer');

	// ─── Editing a queued message ───────────────────────────────────────────


	function startEdit(item: QueuedMessageInfo) {
		if (!target) return;
		if (editing) cancelEdit();
		editing = { target, id: item.id, draft: textInput };
		editNotice = null;
		textInput = item.text;
		void tick().then(() => {
			autoResize();
			textareaElement?.focus();
		});
	}

	function cancelEdit() {
		if (!editing) return;
		textInput = editing.draft;
		editing = null;
		void tick().then(autoResize);
	}

	/**
	 * The message left the queue while it was being edited — delivered, or
	 * removed elsewhere. The edited text stays in the composer as a draft of
	 * its own, ahead of whatever was put aside, so neither is lost.
	 */
	function orphanEdit() {
		if (!editing) return;
		const aside = editing.draft.trim();
		editing = null;
		if (aside) textInput = `${textInput}\n\n${aside}`;
		editNotice = 'That message was already sent, so your edit is kept here as a new draft.';
	}

	async function saveEdit() {
		if (!editing || !textInput.trim()) return;
		const { target: t, id } = editing;
		const res = await fetch(`/api/sessions/${encodeURIComponent(t)}/queue`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, text: textInput })
		});
		if (editing?.id !== id) return;
		if (res.ok) cancelEdit();
		else if (res.status === 404) orphanEdit();
		else {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			alert(`Could not save: ${body.error ?? res.statusText}`);
		}
	}

	// The broadcast drops an item the moment the drain sends it. A session
	// missing for a moment (a reconnect) says nothing about its queue.
	$effect(() => {
		if (
			editing &&
			editing.target === target &&
			currentSession &&
			!queue.some((m) => m.id === editing!.id)
		) {
			untrack(orphanEdit);
		}
	});

	const syncSteerHeld = (e: KeyboardEvent) => (steerHeld = e.ctrlKey || e.metaKey);


	// ─── Attachments ────────────────────────────────────────────────────────

	function makeLocalId(): string {
		return typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}

	async function doUpload(owner: string, localId: string, file: File, signal: AbortSignal) {
		const sessionId = currentSession?.id;
		if (!sessionId) {
			attachmentsStore.patch(owner, localId, { status: 'failed', error: 'No active session' });
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
			attachmentsStore.patch(owner, localId, { status: 'ready', path: data.path, abort: undefined });
		} catch (err) {
			if (signal.aborted) return;
			const msg = err instanceof Error ? err.message : String(err);
			attachmentsStore.patch(owner, localId, { status: 'failed', error: msg, abort: undefined });
		}
	}

	function uploadAttachment(file: File) {
		if (!target) return;
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
		attachmentsStore.add(target, chip);
		void doUpload(target, localId, file, abort.signal);
	}

	function uploadFiles(files: FileList | File[] | null | undefined) {
		if (!files) return;
		for (const f of Array.from(files)) uploadAttachment(f);
	}

	function retryAttachment(localId: string) {
		const chip = attachments.find((a) => a.localId === localId);
		if (!target || !chip || chip.status !== 'failed') return;
		const abort = new AbortController();
		attachmentsStore.patch(target, localId, { status: 'uploading', error: undefined, abort });
		void doUpload(target, localId, chip.file, abort.signal);
	}

	function removeAttachment(localId: string) {
		const chip = attachmentsStore.remove(target, localId);
		if (chip?.status === 'ready' && chip.path && currentSession?.id) {
			// Best-effort server cleanup; chip is gone either way.
			void fetch(
				`/api/sessions/${encodeURIComponent(currentSession.id)}/attach?path=${encodeURIComponent(chip.path)}`,
				{ method: 'DELETE' }
			);
		}
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
	/** Steer is offered as its own control whenever there is a turn to steer into. */
	const canSteer = $derived(isBusy && hasDraft && !editing && !modArmed);


	/** One line, and it never doubles: the most important thing right now. */
	const statusSay = $derived.by(() => {
		if (modArmed) {
			const mods = [
				ctrlCount > 0 ? `ctrl${ctrlCount > 1 ? ` ×${ctrlCount}` : ''}` : '',
				altCount > 0 ? `alt${altCount > 1 ? ` ×${altCount}` : ''}` : ''
			].filter(Boolean);
			return `${mods.join(' + ')} armed`;
		}
		const state = currentSession?.state ?? 'idle';
		const label = sessionStateVisual(state).label.toLowerCase();
		if (state === 'permission') return label;
		if (state === 'waiting') return paneChoice?.question ?? label;
		const parts: string[] = [];
		if (state === 'busy') parts.push(currentSession?.current_action || label);
		else parts.push(statusText || label);
		if (queueCount > 0) parts.push(`${queueCount} queued`);
		return parts.filter(Boolean).join(' · ');
	});
	const statusWants = $derived(modArmed || wantsKeypress);

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
			if (editing) {
				cancelEdit();
				return;
			}
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
		if (ARROW_KEYS[e.key] && textInput === '' && !modArmed) {
			e.preventDefault();
			sendKeys(ARROW_KEYS[e.key]);
			return;
		}
		if (e.key === 'Tab' && textInput === '' && !modArmed && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			sendKeys('Tab');
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (await finishVoiceIfRecording()) return;
			if (modArmed) {
				sendModSequence();
			} else if ((e.ctrlKey || e.metaKey) && canSteer) {
				steerText();
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

	/** One line of the composer's own type, and the ceiling its CSS allows. */
	const FIELD_MIN = 24;
	const FIELD_MAX = 112;

	function autoResize() {
		if (!textareaElement) return;
		// Reset to single row to measure actual content height
		textareaElement.style.height = '0';
		const newHeight = Math.max(FIELD_MIN, Math.min(textareaElement.scrollHeight, FIELD_MAX));
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

	/**
	 * Quits Claude Code and reopens this conversation in the same pane — the
	 * way to pick up an update or re-read skills without losing the session.
	 */
	async function restartSession() {
		if (!currentSession) return;
		const res = await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/restart`, {
			method: 'POST'
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			alert(`Could not restart Claude Code: ${body.error ?? res.statusText}`);
		}
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

	let renameId = $state<string | null>(null);

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

<svelte:window
	onkeydown={(e) => {
		syncSteerHeld(e);
		handleGlobalKeys(e);
	}}
	onkeyup={syncSteerHeld}
	onblur={() => (steerHeld = false)}
/>

<svelte:head>
	<title>{pageTitle}</title>
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

<RenameSessionDialog sessionId={renameId} onClose={() => (renameId = null)} />

{#snippet attachMenu()}
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
{/snippet}

{#snippet statusLine()}
	<div class="sl">
		<SessionSheet
			open={sheetOpen}
			currentTarget={target}
			actions={sheetActions}
			onKill={() => (showConfirmKill = true)}
			onClose={() => (sheetOpen = false)}
		/>
		<SessionStateIndicator state={indicatorState} size="sm" />
		<button
			type="button"
			class="nm"
			onclick={() => (sheetOpen = !sheetOpen)}
			title="Sessions, rename, and pane actions"
		>
			<b>{currentSession ? getSessionDisplayName(currentSession) : target}</b>
			<iconify-icon icon="mdi:chevron-down"></iconify-icon>
		</button>
		{#if embed && !paneLocal && machineName}
			<!-- A pane may be on another host; its composer says which. -->
			<span class="mach" title="Session runs on {machineName}">{machineName}</span>
		{/if}
		{#if embed && paneFocused}
			<span class="foc" title="The sidebar opens sessions here; ⌘/Ctrl 1 and 2 move the focus">focus</span>
		{/if}
		{#if statusSay}
			<span class="sep">·</span>
			<span class="say" class:amber={statusWants}>{statusSay}</span>
		{/if}
		<!-- The model, as the terminal's own status line names it. It is read
		     off the latest reply, so a /model change shows on the next one. -->
		{#if viewMode === 'transcript' && modelName}
			<span class="sep">·</span>
			<span class="say model" title="Model on the latest reply">{modelName}</span>
		{/if}
		<!-- Claude Code announces its own updates only in the terminal's footer,
		     so the transcript view says it here instead. -->
		{#if viewMode === 'transcript' && paneUpdate}
			<span class="sep">·</span>
			{#if paneUpdate.kind === 'installed' && isAlive && isClaudeSession}
				<!-- The update is on disk; restarting is all it needs. Straight away
				     when idle, behind the usual question when a turn would be cut off. -->
				<button
					type="button"
					class="say upd installed"
					title="{paneUpdate.text} — click to restart Claude Code now"
					onclick={() => (isBusy ? (showConfirmRestart = true) : void restartSession())}
				>
					<iconify-icon icon="mdi:restart"></iconify-icon>
					{UPDATE_LABEL.installed}
				</button>
			{:else}
				<span class="say upd {paneUpdate.kind}" title={paneUpdate.text}>
					<iconify-icon icon="mdi:update"></iconify-icon>
					{UPDATE_LABEL[paneUpdate.kind]}
				</span>
			{/if}
		{/if}
		<span class="sl-sp"></span>
		<!-- The old header's rare actions, back where they were, once there is
		     room across for them. On a phone they stay in the sheet. -->
		{#each sheetActions as action (action.label)}
			<span class="wide-only">
				<Hint icon={action.icon} label={action.label} class="mini" onclick={action.run} />
			</span>
		{/each}
		{#if !embed}
			<Hint
				icon="mdi:menu"
				label="Sessions and panels"
				keys={MOD_LABEL + ' B'}
				class="mini menu-only"
				onclick={() => drawer.toggle()}
			/>
		{/if}
		{#if isAlive && canTranscript}
			<Hint
				icon={viewMode === 'transcript' ? 'mdi:console' : 'mdi:message-text-outline'}
				label={viewMode === 'transcript' ? 'Terminal view' : 'Transcript view'}
				keys={MOD_LABEL + ' E'}
				class="mini"
				onclick={() => toggleView()}
			/>
		{/if}
		{#if embed}
			<!-- The pane's own controls, asked of the page outside. Kept as one
			     group so that when the row wraps they land together, right-aligned. -->
			<span class="pane-ctl">
				<Hint icon="mdi:swap-horizontal" label="Swap panes" class="mini" onclick={() => tellPane('swap')} />
				<Hint icon="mdi:arrow-expand" label="Only this pane" class="mini" onclick={() => tellPane('zoom')} />
				<Hint icon="mdi:close" label="Close this pane" class="mini pane-close" onclick={() => tellPane('close')} />
			</span>
		{/if}
	</div>
{/snippet}

{#snippet composerField()}
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
{/snippet}

<Tooltip.Provider delayDuration={250}>
<div class="session-container">

	<div class="output-wrap" class:has-rail={railShowing}>
			<div
				class="output"
				bind:this={outputElement}
				onscroll={handleScroll}
				use:swipe={{
					enabled: () => isTouchDevice,
					threshold: 64,
					onRight: () => drawer.toggle(),
					onLeft: () => { if (canTranscript) toggleView(); }
				}}
			>
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
		{#if viewMode === 'transcript'}
				<!-- Keyed by session: what a card saw of one pane's dialog says nothing about the next. -->
				{#key target}
					<TranscriptView
						entries={transcriptStore.entries}
						onLoadSubagent={(id) => transcriptStore.loadSubagent(id)}
						available={transcriptStore.available}
						loaded={transcriptStore.receivedData}
						sessionState={currentSession?.state ?? null}
						currentAction={currentSession?.current_action ?? null}
						activity={currentSession?.pane_activity ?? null}
						delivered={currentSession?.delivered ?? []}
						{suggestion}
						onAcceptSuggestion={() => void acceptSuggestion()}
						{paneChoice}
						subagents={transcriptStore.subagentsByTask}
						onSendKeys={sendKeys}
						onSendPaneText={sendPaneText}
						olderCount={transcriptStore.firstIndex}
						loadingEarlier={transcriptStore.loadingEarlier}
						onLoadEarlier={() => holdPlaceThrough(transcriptStore.loadEarlier())}
						onSendReply={sendReply}
					/>
				{/key}
				{:else}
					<TerminalView
						history={terminalStore.history}
						historyStart={terminalStore.historyStart}
						screen={terminalStore.screen}
						themed={preferences.terminalTheming}
						frozen={hasSelection}
					/>
				{/if}
			</div>
			<AgentRail agents={railAgents} onReveal={revealAgent} />
			{#if userScrolledUp}
				<button class="jump-bottom" onclick={scrollToBottom} title="Jump to bottom">
					<iconify-icon icon="mdi:arrow-down"></iconify-icon>
					{#if unseenLines > 0}<span>{unseenLines} new</span>{/if}
				</button>
			{/if}
		</div>

		{#if target}
		<QueueStrip
			{target}
			sessionId={currentSession?.id ?? null}
			{queue}
			paneQueue={currentSession?.pane_queue ?? []}
			busy={isBusy}
			editingId={editing?.target === target ? editing.id : null}
			onEdit={startEdit}
		/>
		{/if}

		{#if viewMode === 'transcript'}
			<PaneDraftBar
				text={currentSession?.draft_kind === 'typed' ? (currentSession?.draft_input ?? null) : null}
				composerHasText={textInput.trim().length > 0 || readyPaths.length > 0}
				onClear={() => void sendKeys(CLEAR_PROMPT_KEYS)}
				onSend={() => void sendKeys('Enter')}
			/>
		{/if}

			<div
				class="cx"
				class:focused={embed && paneFocused}
				class:embed
				use:swipe={{
					enabled: () => isTouchDevice,
					onUp: () => (trayOpen = true),
					onDown: () => (trayOpen = false)
				}}
			>
				<ContextGauge context={transcriptStore.context}>
					{#snippet notch()}
						<VoiceMeter
							{target}
							onConfirm={async () => {
								if (await finishVoiceIfRecording()) handleResize();
							}}
						/>
					{/snippet}
				</ContextGauge>

				<KeyTray
					open={trayOpen}
					{ctrlCount}
					{altCount}
					onKeys={(keys) => void sendKeys(keys)}
					onCycleCtrl={cycleCtrl}
					onCycleAlt={cycleAlt}
					onPutInPrompt={() => void sendTextRaw()}
					onAcceptSuggestion={() => void acceptSuggestion()}
					onClearPrompt={() => void sendKeys(CLEAR_PROMPT_KEYS)}
				/>

				{@render statusLine()}

				<!-- The field and the footer share the width the rail leaves them. -->
				<div class="body">
					<div class="lanes">

						<!-- lane 1 — the middle: the field, or what replaces it -->
						<div class="mid">
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
							{#if hasAttachments}
								<Popover.Root bind:open={attachStackOpen}>
									<Popover.Trigger
										class="tattach"
										title={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
									>
										<iconify-icon
											icon={anyUploading ? 'mdi:loading' : 'mdi:paperclip'}
											class={anyUploading ? 'attach-spin' : ''}
										></iconify-icon>
										<span class:attach-failed={anyFailed}>{attachments.length}</span>
									</Popover.Trigger>
									<Popover.Content
										side="top"
										align="start"
										class="w-72 p-2 bg-[#1a1a1a] border-[#333]"
									>
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
														<button
															type="button"
															class="attach-item-remove"
															title="Retry"
															aria-label={`Retry ${att.name}`}
															onclick={() => retryAttachment(att.localId)}
														>
															<iconify-icon icon="mdi:refresh"></iconify-icon>
														</button>
													{/if}
													<button
														type="button"
														class="attach-item-remove"
														title="Remove"
														aria-label={`Remove ${att.name}`}
														onclick={() => removeAttachment(att.localId)}
													>
														<iconify-icon icon="mdi:close"></iconify-icon>
													</button>
												</div>
											{/each}
										</div>
										{#if attachments.length > 1}
											<button type="button" class="attach-clear" onclick={() => attachmentsStore.clear(target)}>
												Remove all
											</button>
										{/if}
									</Popover.Content>
								</Popover.Root>
							{/if}
							{#if editing?.target === target}
								<div class="editbar">
									<iconify-icon icon="mdi:pencil-outline"></iconify-icon>
									<span>Editing a queued message. Enter saves it in place.</span>
									<button type="button" onclick={cancelEdit}>Cancel</button>
								</div>
							{:else if editNotice}
								<div class="editbar notice" role="status">
									<iconify-icon icon="mdi:information-outline"></iconify-icon>
									<span>{editNotice}</span>
									<button type="button" onclick={() => (editNotice = null)}>Dismiss</button>
								</div>
							{/if}
							{@render composerField()}
						</div>

						<!-- lane 2 — the footer, whose left edge never moves -->
						<div class="foot">
							{#if hasSelection}
								<button type="button" class="copy-sel" onclick={copySelection}>
									<iconify-icon
										icon={showSelectionCopied ? 'mdi:check' : 'mdi:content-copy'}
									></iconify-icon>
									{showSelectionCopied ? 'Copied' : 'Copy'}
								</button>
							{/if}
							{#if isBusy}
								<button
									type="button"
									class="interrupt"
									onclick={() => void sendKeys('Escape')}
									title="Interrupt what Claude is doing"
								>
									<iconify-icon icon="mdi:stop"></iconify-icon><span>interrupt</span>
								</button>
							{/if}
							<Popover.Root bind:open={attachPickerOpen}>
								<Popover.Trigger class="cx-g" aria-label="Attach">
									<iconify-icon icon="mdi:paperclip"></iconify-icon>
								</Popover.Trigger>
								{@render attachMenu()}
							</Popover.Root>
							<Hint
								icon="mdi:slash-forward"
								label="Commands"
								keys={MOD_LABEL + ' K'}
								class="cx-g"
								onclick={() => (commandsOpen = true)}
							/>
							<Popover.Root bind:open={moreOpen}>
								<Popover.Trigger class="cx-g" title="More keys">
									<iconify-icon icon="mdi:dots-horizontal"></iconify-icon>
								</Popover.Trigger>
								<Popover.Content
									side="top"
									class="w-auto max-w-[280px] p-2 bg-[#1a1a1a] border-[#333]"
								>
									<div class="popover-grid">
										{#each moreKeys as item (item.label)}
											<Button
												variant="secondary"
												size="toolbar"
												class="min-w-14 min-h-12"
												onclick={() => {
													sendKeys(item.keys);
													moreOpen = false;
												}}
											>
												<iconify-icon icon={item.icon}></iconify-icon>
												<span>{item.label}</span>
											</Button>
										{/each}
									</div>
								</Popover.Content>
							</Popover.Root>
							{#if !isBusy}
								<Hint
									icon="mdi:keyboard-esc"
									label="Escape"
									class="cx-g esc-key"
									onclick={() => void sendKeys('Escape')}
								/>
							{/if}
							<Hint
								icon="mdi:keyboard-outline"
								label={trayOpen ? 'Hide keys' : 'Show keys'}
								keys={MOD_LABEL + ' .'}
								class="cx-g kb-toggle{trayOpen ? ' lit' : ''}{wantsKeypress || modArmed ? ' warn' : ''}"
								onclick={() => (trayOpen = !trayOpen)}
							/>

							<span class="foot-sp"></span>

							<RailStats />
						</div>
					</div>

					<!-- the rail — the two controls a thumb reaches for, given the
					     height of both lanes rather than the footer's alone -->
					<div class="rail">
						{#if voiceEnabled}<VoiceButton {target} round />{/if}
						<div class="act-wrap">
							<button
								type="button"
								class="act"
								disabled={!canSend}
								aria-label={actionLabel}
								title={actionLabel}
								onclick={async () => {
									if (await finishVoiceIfRecording()) {
										handleResize();
										return;
									}
									if (modArmed) await sendModSequence();
									else if (actionKind === 'steer') await steerText();
									else await sendFromButton();
								}}
							>
								<iconify-icon icon={actionIcon}></iconify-icon>
							</button>
						</div>
						{#if canSteer}
							<!-- Its own button, so a phone has a way to steer that is not a
							     held key or a long press. -->
							<button
								type="button"
								class="act steer"
								disabled={!canSend}
								aria-label="Steer"
								title={`Steer: make Claude read this now (${MOD_LABEL}+Enter)`}
								onclick={() => void steerText()}
							>
								<iconify-icon icon={ACTIONS.steer.icon}></iconify-icon>
							</button>
						{/if}
					</div>
				</div>
			</div>
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

<AlertDialog.Root bind:open={showConfirmRestart}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Restart Claude Code?</AlertDialog.Title>
			<AlertDialog.Description>
				Quits Claude Code and reopens this conversation in the same pane with the same flags. Picks up a pending update and reloads skills and hooks.{#if isBusy} It is busy right now — what it is doing will be cut off.{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={restartSession}>Restart</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

{#if dropActive}
	<div class="drop-overlay">
		<iconify-icon icon="mdi:tray-arrow-down"></iconify-icon>
		<span>Drop files to attach</span>
	</div>
{/if}
</Tooltip.Provider>

<style>
	.chord-overlay {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		z-index: var(--z-overlay);
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


	.output-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		container-type: inline-size;
	}
	/* The agent rail sits on the transcript's right margin. When the column
	   has no margin to spare — a split pane, a narrow window — the rows keep
	   clear of it, the one bit of space the rail reserves. */
	@container (max-width: 960px) {
		.output-wrap.has-rail .output {
			padding-right: 52px;
		}
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
		z-index: var(--z-overlay);
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


	.popover-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}











	/* ── Transcript composer ─────────────────────────────────────────────
	   Three lanes and a rail. The status line and the footer are fixed
	   furniture — the footer's left edge in particular never moves, so a thumb
	   already travelling toward a control never has it swapped underneath.
	   Only the middle lane changes what it contains, and the rail down the
	   right holds the two controls that are worth a thumb's whole reach. */
	.cx {
		position: relative;
		background: #151516;
		border: 1px solid #2a2a2c;
		border-bottom: 0;
		border-radius: 16px 16px 0 0;
		display: flex;
		flex-direction: column;
		padding-bottom: 8px;
	}

	/* ── lane 0 · the status line ───────────────────────────────────── */
	.sl {
		display: flex;
		align-items: center;
		gap: 7px;
		/* The row is as tall as its tallest control, not as tall as its text:
		   the buttons on the right are what a person aims at, and a 22px row
		   caps them below the size a pointer can reliably land on. */
		min-height: 28px;
		/* clears the context rail's 10px hit band, so the two rows never
		   compete for the same click */
		padding: 9px 8px 0 12px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.04em;
		color: #78716c;
		min-width: 0;
	}
	.nm {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 0;
		background: none;
		padding: 0;
		color: #f5f5f4;
		font: inherit;
		cursor: pointer;
		min-width: 0;
		max-width: 52%;
	}
	.nm b {
		font-weight: 400;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nm iconify-icon {
		font-size: 12px;
		opacity: 0.45;
		flex: none;
	}
	.nm:hover iconify-icon {
		opacity: 0.9;
	}
	.sep {
		color: #3f3c39;
		flex: none;
	}
	.say {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.say.amber {
		color: #fbbf24;
	}
	.say.upd {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: #34d399;
	}
	button.say.upd {
		padding: 1px 6px;
		border: 1px solid #065f46;
		border-radius: 6px;
		background: #052e22;
		font: inherit;
		cursor: pointer;
	}
	button.say.upd:hover {
		background: #064e3b;
	}
	.say.upd.available {
		color: #a8a29e;
	}
	.say.upd.failed {
		color: #f87171;
	}
	.sl-sp {
		flex: 1;
		min-width: 8px;
	}
	/* One pane of a split: the row may wrap in a narrow pane, and the pane's
	   own controls travel as a group to the right of whichever line they land on. */
	.cx.embed .sl {
		flex-wrap: wrap;
		row-gap: 2px;
	}
	.pane-ctl {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
	}
	.pane-ctl :global(.pane-close:hover) {
		color: #fca5a5;
	}
	.mach {
		font-family: var(--font-mono);
		font-size: 10px;
		color: #818cf8;
		background: #1e1e3a;
		border-radius: 4px;
		padding: 0 5px;
		white-space: nowrap;
	}
	.foc {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #f59e0b;
	}
	/* The focused pane says so on its composer, not over the conversation. */
	.cx.focused {
		border-color: #5a4310;
		box-shadow: inset 0 0 0 1px #3a2d0d;
	}
	/* 24×22 with the context rail's own hit band directly above is a target you
	   aim at rather than one you hit — a miss high lands on the gauge. The
	   glyph keeps its size; the button grows around it. */
	.sl :global(.mini) {
		width: 30px;
		height: 28px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: #78716c;
		font-size: 15px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		cursor: pointer;
	}
	.sl :global(.mini:hover) {
		background: #202022;
		color: #f5f5f4;
	}
	/* A finger is not a cursor: it has no point to aim with and it covers the
	   thing it is pressing. Where the pointer is coarse the row gives these
	   controls the size a thumb actually lands on. */
	@media (pointer: coarse) {
		.sl {
			min-height: 40px;
			gap: 4px;
		}
		.sl :global(.mini) {
			width: 40px;
			height: 40px;
		}
	}

	/* The sidebar is always on screen once there is room for it. */
	@media (min-width: 769px) {
		/* `.sl .mini` sets display, so this has to match its specificity. */
		.sl :global(.menu-only) {
			display: none;
		}
	}

	/* The rail stands beside both lanes, so the field and the footer share a
	   narrower column than the card. That width is what buys the mic and the
	   action a thumb-sized target without the footer growing a second row. */
	.body {
		display: flex;
		align-items: stretch;
		gap: 8px;
		padding-right: 9px;
	}
	.lanes {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		/* The footer's controls answer to the width the rail leaves them, which
		   the viewport does not know: a sidebar sits between it and this card. */
		container-type: inline-size;
	}
	/* The rail is furniture, not content: it sits at the foot and keeps one
	   size whatever the middle lane grows into — a list of options, a field
	   four lines deep. A send button as tall as the card is not a better
	   target, only a stranger one. */
	.rail {
		flex: none;
		align-self: flex-end;
		display: flex;
		align-items: stretch;
		gap: 6px;
		padding: 8px 0 2px;
		height: 74px;
	}

	/* ── lane 1 · the middle ────────────────────────────────────────── */
	.mid {
		position: relative;
		padding: 8px 4px 0 13px;
		display: flex;
		gap: 9px;
		align-items: flex-start;
	}
	.mid :global(textarea) {
		flex: 1;
		min-width: 0;
		height: 24px;
		max-height: 112px;
		background: none;
		border: 0;
		padding: 0;
		color: #f5f5f4;
		font-size: 15.5px;
		font-family: inherit;
		line-height: 1.48;
		resize: none;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none;
	}
	.mid :global(textarea:focus) {
		outline: none;
	}
	.mid :global(textarea::placeholder) {
		color: #78716c;
	}

	.mid :global(.tattach) {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		padding: 0 9px;
		border: 0;
		border-radius: 13px;
		background: #202022;
		color: #a8a29e;
		font-family: var(--font-mono);
		font-size: 11.5px;
		cursor: pointer;
	}
	.mid :global(.tattach .attach-failed) {
		color: #f87171;
	}

	/* ── lane 2 · the footer ────────────────────────────────────────── */
	.foot {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 42px;
		padding: 2px 2px 0 11px;
		/* Every control on this row is `flex: none`, so a row too long for the
		   card ran on under the rail instead of stopping at it. */
		min-width: 0;
		overflow: hidden;
	}
	.foot-sp {
		flex: 1;
	}
	/* Controls are bare glyphs that earn a fill only on hover or when lit,
	   so exactly one thing on the composer is filled: the action. */
	.cx :global(.cx-g) {
		min-width: 32px;
		height: 32px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: #78716c;
		font-size: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		cursor: pointer;
		transition:
			background 0.12s,
			color 0.12s;
	}
	.cx :global(.cx-g:hover) {
		background: #202022;
		color: #f5f5f4;
	}
	.cx :global(.cx-g.lit) {
		background: #202022;
		color: #f5f5f4;
	}
	.cx :global(.cx-g.warn) {
		color: #fbbf24;
	}
	/* Thumb-sized where the pointer is coarse. It has to follow the base rule:
	   a media query carries no extra specificity, so written above it, it loses. */
	@media (pointer: coarse) {
		.cx :global(.cx-g) {
			min-width: 40px;
			height: 40px;
		}
	}

	/* A desktop keyboard has Escape, but the field it is typed into keeps it,
	   so the row carries the key itself. Only there: a phone reaches Escape
	   through the keys tray, and the row has no width to spare for it. */
	.cx :global(.esc-key) {
		display: none;
	}
	@media (min-width: 769px) {
		.cx :global(.esc-key) {
			display: inline-flex;
		}
		/* The keys toggle belongs with the usage bars on a wide row — the left
		   of the row is where the things you reach for while typing live. The
		   spacer keeps order 0 and stays where it sits in the markup. */
		.cx :global(.kb-toggle) {
			order: 1;
		}
		.foot :global(.usage) {
			order: 2;
		}
	}

	/* While Claude works, Escape is the only key that matters, so it stops
	   being the third tile in a row and says what it does. */
	.interrupt {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 11px;
		border: 0;
		border-radius: 8px;
		background: #3a2d0d;
		color: #fbbf24;
		font-family: var(--font-mono);
		font-size: 11.5px;
		flex: none;
		cursor: pointer;
	}
	.interrupt:hover {
		background: #4a3a12;
	}
	/* Interrupt is the one control that arrives mid-row, and it arrives at the
	   width where the spend readout has nowhere left to go. On a narrow card
	   the glyph carries it: a stop sign in amber, on a bar where nothing else
	   is amber, needs no caption. */
	@container (max-width: 420px) {
		.interrupt {
			padding: 0 8px;
		}
		.interrupt span {
			display: none;
		}
		/* The spend readout keeps its number and drops its sparkline, which is
		   the half of it that cannot be read at this size anyway. */
		.cx :global(.usage .bars) {
			display: none;
		}
	}

	/* Spend is information, not an action, so it reads as text on the footer's
	   own baseline rather than as another key. */
	.cx :global(.usage) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 5px;
		border-radius: 8px;
		background: none;
		color: #78716c;
		font-family: var(--font-mono);
		font-size: 11px;
		text-decoration: none;
		flex: none;
	}
	.cx :global(.usage:hover) {
		background: #202022;
		color: #a8a29e;
	}
	.cx :global(.usage .bars) {
		width: 20px;
	}

	/* The round mic was drawn to sit on the context rail, where it punches a
	   channel out of the panel behind it. On this rail it is one of two keys a
	   thumb aims at, so it drops the ring and takes the rail's full height —
	   a mic that is hard to hit is a mic that loses the sentence. */
	.rail :global(.voice-btn-wrapper.round),
	.rail :global(.voice-round) {
		width: 46px;
		height: auto;
		align-self: stretch;
	}
	/* Record is its own verb, so the mic is filled like the action button is —
	   red for record, green for send, and nothing else on the bar is filled. */
	.rail :global(.voice-round) {
		border: 0;
		border-radius: 12px;
		background: #b91c1c;
		color: #fff;
		font-size: 21px;
		box-shadow: none;
	}
	.rail :global(.voice-round:hover:not(:disabled)) {
		background: #dc2626;
	}
	.rail :global(.voice-round.recording),
	.rail :global(.voice-round.error) {
		background: #ef4444;
	}

	.act-wrap {
		position: relative;
		display: flex;
		align-items: stretch;
		flex: none;
	}
	/* The same rectangle in the same green as the tray's Enter, so the two
	   ways to submit read as one control that happens to have two homes. */
	.act {
		width: 46px;
		height: 100%;
		min-height: 56px;
		border: 1px solid transparent;
		border-radius: 12px;
		background: #15803d;
		color: #f0fdf4;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 22px;
		cursor: pointer;
		touch-action: manipulation;
		user-select: none;
		transition: background 0.12s;
	}
	.act:hover:not(:disabled) {
		background: #16a34a;
	}
	.act:disabled {
		opacity: 0.5;
		cursor: default;
	}
	/* Steer sits beside the green send in the card's own grey: the second way
	   in, not a rival to the first. */
	.act.steer {
		background: #292524;
		border-color: #3a3532;
		color: #e7e5e4;
	}
	.act.steer:hover:not(:disabled) {
		background: #3a3532;
	}

	.editbar {
		flex-basis: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: #86efac;
	}
	.editbar.notice {
		color: #a8a29e;
	}
	.editbar span {
		flex: 1;
		min-width: 0;
	}
	.editbar button {
		height: 26px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: #292524;
		color: #e7e5e4;
		font-size: 12px;
		cursor: pointer;
	}
	.editbar button:hover {
		background: #3a3532;
	}


	/* The header's rare actions return to the status line once there is room
	   across for them; a phone reaches them through the sheet instead. */
	.wide-only {
		display: none;
	}
	@media (min-width: 700px) {
		.wide-only {
			display: inline-flex;
		}
	}

	/* Terminal mode's one control the transcript never needed: the pane's
	   selection, which only exists while you are looking at the pane. */
	.copy-sel {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 11px;
		border: 0;
		border-radius: 8px;
		background: #14532d;
		color: #d6f5e0;
		font-family: var(--font-mono);
		font-size: 11.5px;
		flex: none;
		cursor: pointer;
	}
	.copy-sel:hover {
		background: #166534;
	}

	/* A composer that runs the full width is a worse composer. */
	@media (min-width: 900px) {
		.cx {
			width: 100%;
			max-width: 62rem;
			margin: 0 auto;
		}
	}
</style>
