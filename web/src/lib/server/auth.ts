import { createHmac } from 'crypto';

const COOKIE_NAME = 'claude-mux-session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days in seconds

/**
 * Check if authentication is enabled (CLAUDE_WATCH_PASSWORD env var is set)
 */
export function isAuthEnabled(): boolean {
	return !!process.env.CLAUDE_WATCH_PASSWORD;
}

/**
 * Get the configured password (empty string if not set)
 */
function getPassword(): string {
	return process.env.CLAUDE_WATCH_PASSWORD || '';
}

/**
 * Validate a password against the configured password
 */
export function validatePassword(password: string): boolean {
	const expected = getPassword();
	if (!expected) return false;

	// Constant-time comparison to prevent timing attacks
	if (password.length !== expected.length) return false;

	let result = 0;
	for (let i = 0; i < password.length; i++) {
		result |= password.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return result === 0;
}

/**
 * Create a signed auth token
 * Format: timestamp:signature
 */
export function createAuthToken(): string {
	const timestamp = Date.now().toString();
	const signature = createHmac('sha256', getPassword()).update(timestamp).digest('hex');
	return `${timestamp}:${signature}`;
}

/**
 * Validate an auth token
 */
export function validateAuthToken(token: string | undefined): boolean {
	if (!token || !isAuthEnabled()) return false;

	const parts = token.split(':');
	if (parts.length !== 2) return false;

	const [timestamp, signature] = parts;

	// Check token age (reject if older than MAX_AGE)
	const tokenAge = Date.now() - parseInt(timestamp, 10);
	if (isNaN(tokenAge) || tokenAge > MAX_AGE * 1000 || tokenAge < 0) {
		return false;
	}

	// Verify signature
	const expectedSignature = createHmac('sha256', getPassword()).update(timestamp).digest('hex');

	// Constant-time comparison
	if (signature.length !== expectedSignature.length) return false;

	let result = 0;
	for (let i = 0; i < signature.length; i++) {
		result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
	}
	return result === 0;
}

/**
 * Cookie configuration
 */
export const AUTH_COOKIE = {
	name: COOKIE_NAME,
	maxAge: MAX_AGE,
	options: (isSecure: boolean) => ({
		httpOnly: true,
		sameSite: 'lax' as const,
		path: '/',
		maxAge: MAX_AGE,
		secure: isSecure
	})
};
