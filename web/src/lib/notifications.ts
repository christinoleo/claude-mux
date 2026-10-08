/**
 * The browser's side of session alerts: the favicon badge and the two sounds.
 * Adapted from t3code's threadNotifications.ts (MIT, © T3 Tools Inc.).
 */

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

/** Swap the favicon for a red count while any session needs someone, and put it back after. */
export function setFaviconBadge(count: number): void {
	if (count <= 0) {
		if (!badgeFavicon) return;
		badgeFavicon.remove();
		badgeFavicon = undefined;
		if (originalFavicon) document.head.append(originalFavicon);
		originalFavicon = undefined;
		return;
	}
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 64;
	const context = canvas.getContext('2d');
	if (!context) return;
	context.fillStyle = '#e5484d';
	context.beginPath();
	context.arc(32, 32, 30, 0, Math.PI * 2);
	context.fill();
	context.fillStyle = 'white';
	context.font = `700 ${count > 9 ? 32 : 42}px system-ui, sans-serif`;
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText(count > 9 ? '9+' : String(count), 32, 35);
	if (!badgeFavicon) {
		originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
		originalFavicon?.remove();
		badgeFavicon = document.createElement('link');
		badgeFavicon.rel = 'icon';
		badgeFavicon.type = 'image/png';
		document.head.append(badgeFavicon);
	}
	badgeFavicon.href = canvas.toDataURL('image/png');
}

let audio: AudioContext | undefined;

/**
 * Browsers only let a page make sound after someone has interacted with it,
 * so this runs on the first gesture; later alerts reuse the running context.
 */
export function unlockNotificationAudio(): void {
	if (typeof AudioContext === 'undefined') return;
	audio ??= new AudioContext();
	void audio.resume().catch(() => {});
}

/**
 * The sounds are synthesised rather than shipped, so there is no asset or
 * licence to carry: a rising two-note chime for a finished turn, and a pair
 * of brighter, repeated pings for a session that is waiting on someone.
 */
const TONES: Record<'completion' | 'needs-you', Array<[freq: number, at: number]>> = {
	completion: [
		[659.25, 0],
		[987.77, 0.12]
	],
	'needs-you': [
		[880, 0],
		[1174.66, 0.1],
		[880, 0.32],
		[1174.66, 0.42]
	]
};

export function playNotificationSound(kind: 'completion' | 'needs-you'): void {
	if (!audio || audio.state !== 'running') return;
	const now = audio.currentTime;
	for (const [freq, at] of TONES[kind]) {
		const osc = audio.createOscillator();
		const gain = audio.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;
		gain.gain.setValueAtTime(0, now + at);
		gain.gain.linearRampToValueAtTime(0.18, now + at + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.001, now + at + 0.35);
		osc.connect(gain).connect(audio.destination);
		osc.start(now + at);
		osc.stop(now + at + 0.4);
	}
}
