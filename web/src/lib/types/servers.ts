export interface ServerInfo {
	hostname: string;
	url: string;
}

export interface DiscoverResponse {
	servers: ServerInfo[];
	self: string;
	error?: string;
}
