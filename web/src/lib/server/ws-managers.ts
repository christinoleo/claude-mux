import {
	SessionsWsManager,
	TerminalWsManager,
	TranscriptWsManager
} from '../../../../src/server/ws-handlers.js';
import { BrowserWsManager } from '../../../../src/server/browser-view.js';

type GlobalWithManagers = typeof globalThis & {
	__claudeMuxSessionsWsManager?: SessionsWsManager;
	__claudeMuxTerminalWsManager?: TerminalWsManager;
	__claudeMuxTranscriptWsManager?: TranscriptWsManager;
	__claudeMuxBrowserWsManager?: BrowserWsManager;
};

const g = globalThis as GlobalWithManagers;

export const sessionsWsManager: SessionsWsManager =
	g.__claudeMuxSessionsWsManager ??
	(g.__claudeMuxSessionsWsManager = new SessionsWsManager({ debug: true }));

export const terminalWsManager: TerminalWsManager =
	g.__claudeMuxTerminalWsManager ??
	(g.__claudeMuxTerminalWsManager = new TerminalWsManager({ debug: true }));

export const transcriptWsManager: TranscriptWsManager =
	g.__claudeMuxTranscriptWsManager ??
	(g.__claudeMuxTranscriptWsManager = new TranscriptWsManager({ debug: true }));

export const browserWsManager: BrowserWsManager =
	g.__claudeMuxBrowserWsManager ?? (g.__claudeMuxBrowserWsManager = new BrowserWsManager());

/** Trigger a fresh sessions broadcast to all connected WS clients. */
export function broadcastSessions(): void {
	sessionsWsManager.broadcastNow();
}
