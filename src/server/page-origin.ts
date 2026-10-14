/**
 * Whether a request from a page at `origin` may reach this server's sockets
 * and relay. Only the page this server served: the page reaches every other
 * machine through this one's relay (ADR 0004), so no other origin has a
 * reason to, a tailnet one included. A WebSocket is not held to CORS, which
 * is why every upgrade asks this. A client that sends no Origin is not a
 * browser page (a peer machine, curl), and is let through.
 */
export function pageOriginAllowed(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin) return true;
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
