/** A hostname or bound address that only this machine can reach. */
export function isLoopback(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, '').toLowerCase();
	return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^(::ffff:)?127\./.test(h);
}
