import { browser } from '$app/environment';

export type GamepadButton =
	| 'A'
	| 'B'
	| 'X'
	| 'Y'
	| 'L1'
	| 'R1'
	| 'L2'
	| 'R2'
	| 'Back'
	| 'Start'
	| 'L3'
	| 'R3'
	| 'DpadUp'
	| 'DpadDown'
	| 'DpadLeft'
	| 'DpadRight'
	| 'Home';

export type GamepadHandler =
	| (() => void)
	| { press?: () => void; release?: () => void; repeat?: boolean };
export type GamepadHandlers = Partial<Record<GamepadButton, GamepadHandler>>;
export type GamepadAxesCallback = (axes: readonly number[]) => void;

export const STICK_DEADZONE = 0.15;

const BUTTON_INDEX: Record<number, GamepadButton> = {
	0: 'A',
	1: 'B',
	2: 'X',
	3: 'Y',
	4: 'L1',
	5: 'R1',
	6: 'L2',
	7: 'R2',
	8: 'Back',
	9: 'Start',
	10: 'L3',
	11: 'R3',
	12: 'DpadUp',
	13: 'DpadDown',
	14: 'DpadLeft',
	15: 'DpadRight',
	16: 'Home'
};

const DEFAULT_REPEAT = new Set<GamepadButton>([
	'DpadUp',
	'DpadDown',
	'DpadLeft',
	'DpadRight'
]);

const REPEAT_INITIAL_MS = 400;
const REPEAT_INTERVAL_MS = 80;

function pressFn(h: GamepadHandler | undefined): (() => void) | undefined {
	if (!h) return undefined;
	return typeof h === 'function' ? h : h.press;
}

function releaseFn(h: GamepadHandler | undefined): (() => void) | undefined {
	if (!h || typeof h === 'function') return undefined;
	return h.release;
}

function shouldRepeat(name: GamepadButton, h: GamepadHandler | undefined): boolean {
	if (h && typeof h !== 'function' && typeof h.repeat === 'boolean') return h.repeat;
	return DEFAULT_REPEAT.has(name);
}

export type UseGamepadOpts = {
	buttons?: () => GamepadHandlers;
	axes?: () => GamepadAxesCallback;
	enabled?: () => boolean;
};

export function useGamepad(opts: UseGamepadOpts) {
	if (!browser) return;
	const buttons = opts.buttons;
	const axes = opts.axes;
	const enabled = opts.enabled ?? (() => true);

	$effect(() => {
		let raf = 0;
		let active = false;
		const pressed = new Set<number>();
		const repeatStartTimers = new Map<number, ReturnType<typeof setTimeout>>();
		const repeatIntervals = new Map<number, ReturnType<typeof setInterval>>();

		function clearRepeat(idx: number) {
			const s = repeatStartTimers.get(idx);
			if (s) {
				clearTimeout(s);
				repeatStartTimers.delete(idx);
			}
			const i = repeatIntervals.get(idx);
			if (i) {
				clearInterval(i);
				repeatIntervals.delete(idx);
			}
		}

		function scheduleRepeat(idx: number, name: GamepadButton) {
			const start = setTimeout(() => {
				repeatStartTimers.delete(idx);
				if (!pressed.has(idx)) return;
				const tick = setInterval(() => {
					if (!enabled()) return;
					pressFn(buttons?.()[name])?.();
				}, REPEAT_INTERVAL_MS);
				repeatIntervals.set(idx, tick);
			}, REPEAT_INITIAL_MS);
			repeatStartTimers.set(idx, start);
		}

		function poll() {
			raf = requestAnimationFrame(poll);
			if (!enabled()) return;
			const pads = navigator.getGamepads?.();
			if (!pads) return;
			const pad = Array.from(pads).find((p) => p && p.connected);
			if (!pad) return;

			if (buttons) {
				const map = buttons();
				pad.buttons.forEach((btn, idx) => {
					const name = BUTTON_INDEX[idx];
					if (!name) return;
					const isDown = btn.pressed;
					const wasDown = pressed.has(idx);
					const handler = map[name];
					if (isDown && !wasDown) {
						pressed.add(idx);
						pressFn(handler)?.();
						if (shouldRepeat(name, handler)) scheduleRepeat(idx, name);
					} else if (!isDown && wasDown) {
						pressed.delete(idx);
						clearRepeat(idx);
						releaseFn(handler)?.();
					}
				});
			}
			if (axes) axes()(pad.axes);
		}

		function start() {
			if (active) return;
			active = true;
			raf = requestAnimationFrame(poll);
		}
		function stop() {
			if (!active) return;
			active = false;
			cancelAnimationFrame(raf);
			repeatStartTimers.forEach(clearTimeout);
			repeatStartTimers.clear();
			repeatIntervals.forEach(clearInterval);
			repeatIntervals.clear();
			pressed.clear();
		}

		const onConnect = () => start();
		const onDisconnect = () => {
			if (navigator.getGamepads?.().some((p) => p && p.connected)) return;
			stop();
		};

		window.addEventListener('gamepadconnected', onConnect);
		window.addEventListener('gamepaddisconnected', onDisconnect);
		if (navigator.getGamepads?.().some((p) => p && p.connected)) start();

		return () => {
			window.removeEventListener('gamepadconnected', onConnect);
			window.removeEventListener('gamepaddisconnected', onDisconnect);
			stop();
		};
	});
}
