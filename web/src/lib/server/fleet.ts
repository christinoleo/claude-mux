import { join } from 'node:path';
import { FleetState } from '$shared/server/fleet-state.js';
import { CLAUDE_MUX_DIR } from '$shared/utils/paths.js';
import { MACHINE_ID } from '$lib/server/instance';
import { discoverServers, rememberMachines } from '$lib/server/discover';
import { sessionsWsManager } from '$lib/server/ws-managers.js';

/** How often the tailnet is asked again for machines that came up since. */
const REDISCOVER_MS = 60_000;

type GlobalWithFleet = typeof globalThis & { __claudeMuxFleetState?: FleetState };

/**
 * This machine's fleet state (`src/server/fleet-state.ts`), kept in
 * `~/.claude-mux/fleet.json`, started once per process and fed by discovery.
 * The pages read it on their sessions socket.
 */
export function ensureFleetState(): FleetState {
	const g = globalThis as GlobalWithFleet;
	if (g.__claudeMuxFleetState) return g.__claudeMuxFleetState;
	const state = new FleetState({ selfId: MACHINE_ID, path: join(CLAUDE_MUX_DIR, 'fleet.json') });
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
