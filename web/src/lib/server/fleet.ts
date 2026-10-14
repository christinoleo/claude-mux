import { join } from 'node:path';
import { FleetState } from '$shared/server/fleet-state.js';
import { FleetPrefsStore } from '$shared/server/fleet-prefs.js';
import { CLAUDE_MUX_DIR } from '$shared/utils/paths.js';
import { MACHINE_ID } from '$lib/server/instance';
import { discoverServers, rememberMachines } from '$lib/server/discover';
import { sessionsWsManager } from '$lib/server/ws-managers.js';

/** How often the tailnet is asked again for machines that came up since. */
const REDISCOVER_MS = 60_000;

type GlobalWithFleet = typeof globalThis & {
	__claudeMuxFleetState?: FleetState;
	__claudeMuxFleetPrefs?: FleetPrefsStore;
};

/**
 * This machine's copy of the fleet preferences (`src/server/fleet-prefs.ts`),
 * kept in `~/.claude-mux/fleet-prefs.json`. Every client of the sessions
 * socket, page or peer, is sent it on connect and after each change.
 */
export function ensureFleetPrefs(): FleetPrefsStore {
	const g = globalThis as GlobalWithFleet;
	if (g.__claudeMuxFleetPrefs) return g.__claudeMuxFleetPrefs;
	const prefs = new FleetPrefsStore({ selfId: MACHINE_ID, path: join(CLAUDE_MUX_DIR, 'fleet-prefs.json') });
	g.__claudeMuxFleetPrefs = prefs;
	sessionsWsManager.setPrefsSource(prefs);
	return prefs;
}

/**
 * This machine's fleet state (`src/server/fleet-state.ts`), kept in
 * `~/.claude-mux/fleet.json`, started once per process and fed by discovery.
 * The pages read it on their sessions socket. The preferences each peer sends
 * on its socket are merged into this machine's.
 */
export function ensureFleetState(): FleetState {
	const g = globalThis as GlobalWithFleet;
	if (g.__claudeMuxFleetState) return g.__claudeMuxFleetState;
	const prefs = ensureFleetPrefs();
	const state = new FleetState({
		selfId: MACHINE_ID,
		path: join(CLAUDE_MUX_DIR, 'fleet.json'),
		prefs: (incoming) => prefs.merge(incoming)
	});
	g.__claudeMuxFleetState = state;
	rememberMachines(state.addresses());
	sessionsWsManager.setFleetSource(state);
	const discover = () =>
		discoverServers()
			.then((found) => state.update(found.servers))
			.catch((err) => console.error('[fleet] discovery failed:', err));
	void discover();
	setInterval(discover, REDISCOVER_MS).unref?.();
	return state;
}
