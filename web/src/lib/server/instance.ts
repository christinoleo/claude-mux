import { join } from 'node:path';
import { CLAUDE_MUX_DIR, DEFAULT_SERVER_PORT } from '$shared/utils/paths.js';
import { loadMachineId } from '$shared/server/machine-id.js';

/**
 * Who this machine is on the tailnet: a stable id, kept in
 * `~/.claude-mux/machine-id`. Every answer to /api/health carries it, so two
 * tailnet names that lead to the same process are recognised as one machine,
 * and the relay addresses a machine by it (`/fleet/<id>/api/...`). The
 * hostname is only for display.
 */
export const MACHINE_ID = loadMachineId(join(CLAUDE_MUX_DIR, 'machine-id'));

/**
 * The port this server listens on, which `serve` and the dev server publish
 * in `CLAUDE_MUX_PORT`. It is the machine's own port, not the one a page was
 * opened on: tailscale serve may front it on another (omarchy answers on 8443
 * as well as 3456).
 */
export function listenPort(): number {
	return Number(process.env.CLAUDE_MUX_PORT) || DEFAULT_SERVER_PORT;
}
