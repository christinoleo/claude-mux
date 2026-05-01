import { browser } from '$app/environment';

export interface Persisted<T> {
	load(): T;
	save(value: T): void;
}

function clone<T>(v: T): T {
	if (Array.isArray(v)) return [...v] as T;
	if (v && typeof v === 'object') return { ...(v as object) } as T;
	return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function createPersisted<T>(key: string, defaults: T): Persisted<T> {
	return {
		load(): T {
			if (!browser) return clone(defaults);
			try {
				const raw = localStorage.getItem(key);
				if (raw === null) return clone(defaults);
				const parsed = JSON.parse(raw) as T;
				if (isPlainObject(defaults) && isPlainObject(parsed)) {
					return { ...(defaults as object), ...(parsed as object) } as T;
				}
				return parsed;
			} catch {
				return clone(defaults);
			}
		},
		save(value: T): void {
			if (!browser) return;
			try {
				localStorage.setItem(key, JSON.stringify(value));
			} catch {
				// quota exceeded or private browsing — settings won't persist this session
			}
		}
	};
}
