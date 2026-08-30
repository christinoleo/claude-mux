import { browser } from '$app/environment';

interface WakeLockSentinelLike {
	released: boolean;
	release(): Promise<void>;
	addEventListener(type: 'release', listener: () => void): void;
}

let sentinel: WakeLockSentinelLike | null = null;

export function wakeLockSupported(): boolean {
	return browser && 'wakeLock' in navigator;
}

export async function acquireWakeLock(): Promise<void> {
	if (!wakeLockSupported() || sentinel) return;
	try {
		const s: WakeLockSentinelLike = await navigator.wakeLock.request('screen');
		sentinel = s;
		s.addEventListener('release', () => {
			sentinel = null;
		});
	} catch {
		sentinel = null;
	}
}

export async function releaseWakeLock(): Promise<void> {
	if (!sentinel) return;
	try {
		await sentinel.release();
	} catch {
		// ignore
	}
	sentinel = null;
}

export function hasWakeLock(): boolean {
	return sentinel !== null;
}
