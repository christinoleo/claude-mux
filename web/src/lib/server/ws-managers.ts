import { SessionsWsManager, TerminalWsManager } from '../../../../src/server/ws-handlers.js';

type GlobalWithManagers = typeof globalThis & {
	__claudeMuxSessionsWsManager?: SessionsWsManager;
	__claudeMuxTerminalWsManager?: TerminalWsManager;
};

const g = globalThis as GlobalWithManagers;

export const sessionsWsManager: SessionsWsManager =
	g.__claudeMuxSessionsWsManager ??
	(g.__claudeMuxSessionsWsManager = new SessionsWsManager({ debug: true }));

export const terminalWsManager: TerminalWsManager =
	g.__claudeMuxTerminalWsManager ??
	(g.__claudeMuxTerminalWsManager = new TerminalWsManager({ debug: true }));

/** Trigger a fresh sessions broadcast to all connected WS clients. */
export function broadcastSessions(): void {
	sessionsWsManager.broadcastNow();
}
