/**
 * Shared WebSocket message schemas for the sessions stream.
 * Used by both server (ws-handlers) and client (session store).
 *
 * All messages over the sessions WebSocket are discriminated by `type`.
 * Each message type has its own broadcast cadence on the server.
 */

import { z } from 'zod/v4';
import { AGENT_IDS } from '../agents.js';

// ============================================================================
// Session data schemas
// ============================================================================

const SessionStateSchema = z.enum(['busy', 'idle', 'waiting', 'permission']);

const ScreenshotSchema = z.object({
	path: z.string(),
	timestamp: z.number()
});

const PaneChoiceSchema = z.object({
	question: z.string().nullable(),
	options: z.array(
		z.object({
			n: z.number(),
			label: z.string(),
			/** The line the dialog prints under the label, when it prints one. */
			hint: z.string().optional(),
			/** Whether a multi-select row's own checkbox is ticked. */
			checked: z.boolean().optional(),
			selected: z.boolean(),
		})
	),
	/** The rows are checkboxes: picking one ticks it, and leaves the dialog open. */
	multi: z.boolean().optional(),
});

/** The numbered options a pane dialog is offering, as they reach the browser. */
export type PaneChoice = z.infer<typeof PaneChoiceSchema>;

const EnrichedSessionSchema = z.object({
	v: z.number(),
	id: z.string(),
	pid: z.number(),
	cwd: z.string(),
	git_root: z.string().nullable(),
	tmux_target: z.string().nullable(),
	state: SessionStateSchema,
	current_action: z.string().nullable(),
	prompt_text: z.string().nullable(),
	last_update: z.number(),
	screenshots: z.array(ScreenshotSchema).optional(),
	chrome_active: z.boolean().optional(),
	linked_to: z.string().nullable().optional(),
	rc_url: z.string().nullable().optional(),
	/** Text sitting in the pane's prompt box right now — live, never persisted. */
	draft_input: z.string().nullable().optional(),
	/** Who put it there: the user, or Claude Code's own prompt suggestion. */
	draft_kind: z.enum(['typed', 'suggestion']).nullable().optional(),
	/** Messages waiting in Claude Code's own queue, oldest first — live only. */
	pane_queue: z.array(z.string()).optional(),
	/**
	 * The numbered options a permission or question dialog is offering in the
	 * pane right now — live only. Read off the pane, so the UI must still gate
	 * on `state`: the hooks are authoritative for whether a dialog is open.
	 */
	pane_choice: PaneChoiceSchema.nullable().optional(),
	display_name: z.string().nullable().optional(),
	pane_title: z.string().nullable(),
	pane_alive: z.boolean(),
	queue_count: z.number().optional(),
	/** The next message claude-mux will paste into the pane — live only. */
	queue_head_text: z.string().nullable().optional(),
	/** Whether that message is yours or one claude-mux queued for itself. */
	queue_head_kind: z.enum(['user', 'control']).nullable().optional(),
	agent: z.enum(AGENT_IDS).optional()
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
