export interface ServerInfo {
	/** The machine's stable id, which the relay addresses it by (`/fleet/<id>`). */
	id: string;
	/** Its tailnet name, for display. */
	hostname: string;
	url: string;
}

export interface DiscoverResponse {
	servers: ServerInfo[];
	self: string;
	error?: string;
}
