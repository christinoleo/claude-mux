/**
 * Shared WebSocket message schemas for the sessions stream.
 * Used by both server (ws-handlers) and client (session store).
 *
 * All messages over the sessions WebSocket are discriminated by `type`.
 * Each message type has its own broadcast cadence on the server.
 */

import { z } from 'zod/v4';

// ============================================================================
// Session data schemas
// ============================================================================

const SessionStateSchema = z.enum(['busy', 'idle', 'waiting', 'permission']);

const ScreenshotSchema = z.object({
	path: z.string(),
	timestamp: z.number()
});

const EnrichedSessionSchema = z.object({
	v: z.number(),
	id: z.string(),
	pid: z.number(),
	cwd: z.string(),
	git_root: z.string().nullable(),
	beads_enabled: z.boolean(),
	tmux_target: z.string().nullable(),
	state: SessionStateSchema,
	current_action: z.string().nullable(),
	prompt_text: z.string().nullable(),
	last_update: z.number(),
	screenshots: z.array(ScreenshotSchema).optional(),
	chrome_active: z.boolean().optional(),
	linked_to: z.string().nullable().optional(),
	rc_url: z.string().nullable().optional(),
	display_name: z.string().nullable().optional(),
	pane_title: z.string().nullable(),
	pane_alive: z.boolean(),
	queue_count: z.number().optional()
});

// ============================================================================
// Message schemas (discriminated by `type`)
// ============================================================================

const SessionsMessageSchema = z.object({
	type: z.literal('sessions'),
	sessions: z.array(EnrichedSessionSchema),
	count: z.number(),
	timestamp: z.number()
});

const ConnectedMessageSchema = z.object({
	type: z.literal('connected'),
	sessions: z.array(EnrichedSessionSchema),
	count: z.number(),
	timestamp: z.number()
});

const SystemStatsMessageSchema = z.object({
	type: z.literal('systemStats'),
	cpu: z.number(),
	ram: z.number(),
	swap: z.number(),
	ramTotal: z.number(),
	swapTotal: z.number(),
	timestamp: z.number()
});

// ============================================================================
// Union + exports
// ============================================================================

export const SessionsWsMessageSchema = z.discriminatedUnion('type', [
	SessionsMessageSchema,
	ConnectedMessageSchema,
	SystemStatsMessageSchema
]);

export type SessionsWsMessage = z.infer<typeof SessionsWsMessageSchema>;
export type SessionsMessage = z.infer<typeof SessionsMessageSchema>;
export type ConnectedMessage = z.infer<typeof ConnectedMessageSchema>;
export type SystemStatsMessage = z.infer<typeof SystemStatsMessageSchema>;
export type EnrichedSession = z.infer<typeof EnrichedSessionSchema>;
