<!--
	Turns session changes on every machine in the fleet into alerts: a system
	notification while the window is in the background, a toast while it is in
	front, an optional sound, and a count on the favicon. Each names its
	machine. Draws nothing itself. Adapted from t3code's
	ThreadNotificationCoordinator (MIT, © T3 Tools Inc.).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import type { PaneRef } from '$lib/split-refs';
	import { sessionPath } from '$lib/session-route';
	import { toast } from 'svelte-sonner';
	import {
		detectNotifications,
		notificationText,
		type SeenSession,
		type SessionNotification
	} from '$shared/session-notifications.js';
	import { wantsHuman, type Session } from '$lib/stores/sessions.svelte';
	import { fleetStore, machineName, sessionRef, type Machine } from '$lib/stores/fleet.svelte';
	import { keepSubscriptionCurrent } from '$lib/push';
	import { preferences } from '$lib/stores/preferences.svelte';
	import {
		hasDesktopNotifications,
		hasNotificationSound,
		playNotificationSound,
		setFaviconBadge,
		unlockNotificationAudio
	} from '$lib/notifications';

	/** The sessions on screen, on any machine; a split shows two. */
	let { viewing }: { viewing: PaneRef[] } = $props();

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

	function onScreen(machine: Machine, s: Session): boolean {
		const host = machine.local ? null : machine.server.hostname.toLowerCase();
		return viewing.some(
			(ref) => (ref.host?.toLowerCase() ?? null) === host && (ref.target === s.tmux_target || ref.target === s.id)
		);
	}

	function alert({ session: s, kind }: SessionNotification<Session>, machine: Machine): void {
		const inFront = windowInFront();
		// The session you are looking at needs no alert: you can see it.
		if (inFront && onScreen(machine, s)) return;

		if (hasNotificationSound(mode)) playNotificationSound(kind === 'completion' ? 'completion' : 'needs-you');

		const { title, body } = notificationText(s, kind, machineName(machine));
		const openSession = () => void goto(sessionPath(sessionRef(machine, s)));

		if (inFront) {
			if (!preferences.inAppToasts) return;
			const show = kind === 'completion' ? toast.success : toast.warning;
			show(title, {
				id: `session-${s.id}`,
				description: body.replace('\n', ' · '),
				action: { label: 'Open', onClick: openSession }
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
				body,
				tag: s.id,
				icon: '/icon-192.png'
			});
			open.set(s.id, n);
			n.addEventListener('click', () => {
				n.close();
				window.focus();
				openSession();
			});
			n.addEventListener('close', () => {
				if (open.get(s.id) === n) open.delete(s.id);
			});
		} catch {
			// Some browsers expose Notification but refuse to show one from a page.
		}
	}

	// Session ids are unique across machines, so one map holds the whole fleet.
	let seen = new Map<string, SeenSession>();
	$effect(() => {
		const machineOf = new Map<string, Machine>();
		for (const m of fleetStore.machines) for (const s of m.sessions) machineOf.set(s.id, m);
		const out = detectNotifications(
			seen,
			fleetStore.machines.flatMap((m) => m.sessions)
		);
		seen = out.seen;
		// Only a new broadcast should re-run detection, not a preference or a navigation.
		untrack(() => {
			for (const event of out.events) alert(event, machineOf.get(event.session.id)!);
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

	// A tapped push notification hands an open page the session to show (see service-worker.ts).
	$effect(() => {
		if (!('serviceWorker' in navigator)) return;
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string } | null;
			if (data?.type === 'open' && data.url) void goto(data.url);
		};
		navigator.serviceWorker.addEventListener('message', onMessage);
		return () => navigator.serviceWorker.removeEventListener('message', onMessage);
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

	// A device subscribed under a key the fleet has since replaced is moved to the new one.
	$effect(() => {
		const renew = () => {
			if (document.visibilityState === 'visible') void keepSubscriptionCurrent().catch(() => {});
		};
		renew();
		document.addEventListener('visibilitychange', renew);
		return () => document.removeEventListener('visibilitychange', renew);
	});

	const needingYou = $derived(fleetStore.answering.filter((s) => s.pane_alive !== false && wantsHuman(s)).length);
	$effect(() => setFaviconBadge(needingYou));
</script>
