<!--
	Turns session changes into alerts: a system notification while the window
	is in the background, a toast while it is in front, an optional sound, and
	a count on the favicon. Draws nothing itself. Adapted from t3code's
	ThreadNotificationCoordinator (MIT, © T3 Tools Inc.).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import {
		detectNotifications,
		NOTIFICATION_TITLES,
		type SeenSession,
		type SessionNotification
	} from '$shared/session-notifications.js';
	import {
		sessionStore,
		asking,
		getSessionDisplayName,
		wantsHuman,
		type Session
	} from '$lib/stores/sessions.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import {
		hasDesktopNotifications,
		hasNotificationSound,
		playNotificationSound,
		setFaviconBadge,
		unlockNotificationAudio
	} from '$lib/notifications';

	/** The tmux targets of the sessions on screen; a split shows two. */
	let { viewing }: { viewing: string[] } = $props();

	const mode = $derived(preferences.notificationMode);

	/** Open notifications by session id, so focus can close them and a newer one replaces the older. */
	const open = new Map<string, Notification>();

	function closeAll(): void {
		for (const n of open.values()) n.close();
		open.clear();
	}

	function windowInFront(): boolean {
		return document.visibilityState === 'visible' && document.hasFocus();
	}

	function openSession(target: string): void {
		void goto(`/session/${encodeURIComponent(target)}`);
	}

	function alert({ session: s, kind }: SessionNotification<Session>): void {
		const inFront = windowInFront();
		// The session you are looking at needs no alert: you can see it.
		if (inFront && viewing.some((t) => t === s.tmux_target || t === s.id)) return;

		if (hasNotificationSound(mode)) playNotificationSound(kind === 'completion' ? 'completion' : 'needs-you');

		const title = NOTIFICATION_TITLES[kind];
		const name = getSessionDisplayName(s);
		const more = kind === 'completion' ? null : asking(s);
		const target = s.tmux_target ?? s.id;

		if (inFront) {
			if (!preferences.inAppToasts) return;
			const show = kind === 'completion' ? toast.success : toast.warning;
			show(title, {
				id: `session-${s.id}`,
				description: more ? `${name} · ${more}` : name,
				action: { label: 'Open', onClick: () => openSession(target) }
			});
			return;
		}

		if (
			!hasDesktopNotifications(mode) ||
			typeof Notification === 'undefined' ||
			Notification.permission !== 'granted'
		)
			return;
		try {
			open.get(s.id)?.close();
			const n = new Notification(title, {
				body: more ? `${name}\n${more}` : name,
				tag: s.id,
				icon: '/icon-192.png'
			});
			open.set(s.id, n);
			n.addEventListener('click', () => {
				n.close();
				window.focus();
				openSession(target);
			});
			n.addEventListener('close', () => {
				if (open.get(s.id) === n) open.delete(s.id);
			});
		} catch {
			// Some browsers expose Notification but refuse to show one from a page.
		}
	}

	let seen = new Map<string, SeenSession>();
	$effect(() => {
		const out = detectNotifications(seen, sessionStore.sessions);
		seen = out.seen;
		// Only a new broadcast should re-run detection, not a preference or a navigation.
		untrack(() => {
			for (const event of out.events) alert(event);
		});
	});

	// Coming back to the window is reading what the notifications said.
	$effect(() => {
		window.addEventListener('focus', closeAll);
		return () => {
			window.removeEventListener('focus', closeAll);
			closeAll();
		};
	});

	$effect(() => {
		if (!hasNotificationSound(mode)) return;
		document.addEventListener('pointerdown', unlockNotificationAudio);
		document.addEventListener('keydown', unlockNotificationAudio);
		return () => {
			document.removeEventListener('pointerdown', unlockNotificationAudio);
			document.removeEventListener('keydown', unlockNotificationAudio);
		};
	});

	const needingYou = $derived(sessionStore.sessions.filter((s) => s.pane_alive !== false && wantsHuman(s)).length);
	$effect(() => setFaviconBadge(needingYou));
</script>
