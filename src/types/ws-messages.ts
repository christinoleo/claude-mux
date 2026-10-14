/**
 * Shared WebSocket message schemas for the sessions stream.
 * Used by both server (ws-handlers) and client (session store).
 *
 * All messages over the sessions WebSocket are discriminated by `type`.
 * Each message type has its own broadcast cadence on the server.
 */

import { z } from 'zod/v4';
import { AGENT_IDS } from '../agents.js';
import { PrefEntrySchema } from '../fleet-prefs.js';
import { ProjectReportSchema } from '../fleet-projects.js';
import { PluginsReportSchema } from '../fleet-plugins.js';
import { PastSessionSchema } from '../past-session.js';

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
			/** The question's free-text row: opened by highlighting it, declined by an empty Enter. */
			text: z.literal(true).optional(),
		})
	),
	/** The rows are checkboxes: picking one ticks it, and leaves the dialog open. */
	multi: z.boolean().optional(),
	/** The highlighted row is a text field: keystrokes fill it rather than drive the list. */
	typing: z.boolean().optional(),
	/** That text field is the highlighted option's notes, closed with Escape. */
	noting: z.boolean().optional(),
	/** The dialog's own key hint, as drawn under it. */
	keys: z.string().optional(),
	/** Lines the dialog prints under its rows for itself — a setting, a warning. */
	notes: z.array(z.string()).optional()
});

/** The numbered options a pane dialog is offering, as they reach the browser. */
export type PaneChoice = z.infer<typeof PaneChoiceSchema>;

const IssueInfoSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.enum(['open', 'closed']),
	labels: z.array(z.string()),
	url: z.string()
});

/** A GitHub issue as the sidebar shows it next to the session working it. */
export type IssueInfo = z.infer<typeof IssueInfoSchema>;

const PaneActivitySchema = z.object({
	verb: z.string(),
	doing: z.string().nullable(),
	/** When the turn started, in the server's clock (epoch ms); see `timestamp` on the message. */
	started_at: z.number().nullable(),
	tokens: z.object({ dir: z.enum(['down', 'up']), count: z.string() }).nullable(),
	thinking: z.string().nullable()
});

/** Claude Code's spinner line, split into its parts (see `readActivity`), with the turn's start in place of its elapsed count. */
export type PaneActivity = z.infer<typeof PaneActivitySchema>;

const QueuedMessageSchema = z.object({
	/** Stable across reorders and drains, so an edit or steer names the item it meant. */
	id: z.string(),
	text: z.string(),
	queuedAt: z.number(),
	kind: z.enum(['user', 'control']),
	/** Attachment paths, folded into the text only when the message is delivered. */
	attachments: z.array(z.string()).optional(),
	/** It was spoken, so the turn it becomes is badged as dictated. */
	dictated: z.boolean().optional()
});
/** One message in claude-mux's send queue, as the broadcast carries it. */
export type QueuedMessageInfo = z.infer<typeof QueuedMessageSchema>;

const DeliverySchema = z.object({
	/** Exactly what was pasted into the pane, attachments folded in. */
	text: z.string(),
	/** The queue drained it on an idle pane, or a steer pushed it into the turn. */
	via: z.enum(['queue', 'steer']),
	at: z.number()
});
/** A message claude-mux handed the pane on the user's behalf, for labelling its turn. */
export type DeliveryInfo = z.infer<typeof DeliverySchema>;

const InboxTicketSchema = z.object({
	repo: z.string(),
	git_root: z.string(),
	number: z.number(),
	title: z.string(),
	url: z.string(),
	/** A maestro worker asking for a decision, or a wayfinder ticket only a person resolves. */
	kind: z.enum(['needs-help', 'grilling', 'prototype']),
	/** When it started waiting, as near as GitHub says: the last update, or when it was filed. */
	since: z.number(),
	/** The worker's latest comment, first paragraph — what it needs. */
	note: z.string().nullable()
});

/** A ticket on GitHub that is waiting on a person rather than an agent. */
export type InboxTicket = z.infer<typeof InboxTicketSchema>;

const SubagentSchema = z.object({
	id: z.string(),
	type: z.string(),
	description: z.string().nullable(),
	state: z.enum(['running', 'done', 'failed']),
	started_at: z.number(),
	ended_at: z.number().nullable(),
	transcript_path: z.string().nullable(),
	tool_use_id: z.string().nullable().optional(),
	current_tool: z.string().nullable().optional()
});

/** A subagent a session spawned, as the hook last recorded it. */
export type SubagentInfo = z.infer<typeof SubagentSchema>;

const ChangesInfoSchema = z.object({
	files: z.number(),
	additions: z.number(),
	deletions: z.number(),
	/** `git` counts the repo's working tree; `session` counts the edits in the session's log. */
	source: z.enum(['git', 'session'])
});

/** How much a session has changed, as the sidebar shows it. */
export type ChangesInfo = z.infer<typeof ChangesInfoSchema>;

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
	/** When the user's latest prompt started a turn; stamped by the hook. */
	turn_started_at: z.number().nullable().optional(),
	/** When the latest turn ended for good; stamped by the hook. */
	turn_completed_at: z.number().nullable().optional(),
	/** When anyone last had the session open (`visits.json`) — live only. */
	last_visited_at: z.number().nullable().optional(),
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
	/** Claude Code's footer notice about its own update — live only. */
	pane_update: z
		.object({
			kind: z.enum(['installed', 'available', 'failed']),
			text: z.string(),
			/** The upgrade command it names, when claude-mux can run it. */
			command: z.string().optional()
		})
		.nullable()
		.optional(),
	/** The spinner line while a turn runs, split into its parts — live only. */
	pane_activity: PaneActivitySchema.nullable().optional(),
	/** Share of the context window in use, read off the transcript's latest reply. */
	context_pct: z.number().nullable().optional(),
	display_name: z.string().nullable().optional(),
	pane_title: z.string().nullable(),
	pane_alive: z.boolean(),
	/** Every message claude-mux holds for the pane, next out first — live only. */
	queue: z.array(QueuedMessageSchema).optional(),
	/** What the queue and steers handed the pane lately, newest last — live only. */
	delivered: z.array(DeliverySchema).optional(),
	agent: z.enum(AGENT_IDS).optional(),
	/** Set when the maestro daemon started the session. */
	maestro_role: z.string().nullable().optional(),
	maestro_issue: z.number().nullable().optional(),
	/** Subagents running now, those done in the last hour, and those failed in the last day. */
	subagents: z.array(SubagentSchema).optional(),
	/** The issue that worker owns, as GitHub last described it — live only. */
	issue: IssueInfoSchema.nullable().optional(),
	/** Files changed, with line counts: git's when in a repo, else the session log's — live only. */
	changes: ChangesInfoSchema.nullable().optional()
});

// ============================================================================
// Message schemas (discriminated by `type`)
// ============================================================================

/**
 * The projects the server remembers, on every sessions broadcast. Optional
 * because a browser may be talking to a server from before the list moved
 * there, in which case it falls back to its own.
 */
const ProjectsField = z.array(z.string()).optional();

/** This machine's settings, likewise on every broadcast; absent on older servers. */
const SettingsField = z.object({ autoRemoteControl: z.boolean() }).partial().optional();

/** Tickets on GitHub waiting on a person, for the repos this machine's sessions are in. */
const InboxField = z.array(InboxTicketSchema).optional();

/** What each project is matched across machines by, and its icon (`src/fleet-projects.ts`); absent on older servers. */
const ProjectReportsField = z.array(ProjectReportSchema).optional();

/** This machine's Claude Code marketplaces and plugins (`src/fleet-plugins.ts`); null until read, absent on older servers. */
const PluginsField = PluginsReportSchema.nullable().optional();

const SessionsMessageSchema = z.object({
	type: z.literal('sessions'),
	sessions: z.array(EnrichedSessionSchema),
	count: z.number(),
	projects: ProjectsField,
	settings: SettingsField,
	inbox: InboxField,
	projectReports: ProjectReportsField,
	plugins: PluginsField,
	timestamp: z.number()
});

const ConnectedMessageSchema = z.object({
	type: z.literal('connected'),
	sessions: z.array(EnrichedSessionSchema),
	count: z.number(),
	projects: ProjectsField,
	settings: SettingsField,
	inbox: InboxField,
	projectReports: ProjectReportsField,
	plugins: PluginsField,
	timestamp: z.number()
});

/**
 * Every other machine, as this one last heard from it (`src/server/fleet-state.ts`).
 * Sent only to a page that asks for it (`?fleet=1`); `self` is this machine's id.
 * A peer's sessions are its own broadcast, read with the same schema.
 */
/**
 * A list read item by item: an item this schema cannot read is dropped and
 * the rest kept. Another machine may run another version, and one session it
 * describes differently must not cost the page that whole machine, or the fleet.
 */
export function eachOf<T extends z.ZodType>(item: T) {
	return z.array(z.unknown()).transform((items) =>
		items.flatMap((raw) => {
			const parsed = item.safeParse(raw);
			return parsed.success ? [parsed.data as z.infer<T>] : [];
		})
	);
}

const FleetMachineSchema = z.object({
	id: z.string(),
	hostname: z.string(),
	url: z.string(),
	online: z.boolean(),
	lastSeen: z.number().nullable(),
	retryAt: z.number().nullable(),
	version: z.string().nullable(),
	// Absent from an older machine's own fleet state.
	protocol: z.number().nullable().default(null),
	sessions: eachOf(EnrichedSessionSchema),
	projects: z.array(z.string()),
	inbox: eachOf(InboxTicketSchema),
	projectReports: eachOf(ProjectReportSchema).optional(),
	// A report this version cannot read counts as none.
	plugins: PluginsReportSchema.nullable().optional().catch(null)
});

const FleetMessageSchema = z.object({
	type: z.literal('fleet'),
	self: z.string(),
	machines: z.array(FleetMachineSchema),
	timestamp: z.number()
});

/**
 * The fleet preferences (`src/fleet-prefs.ts`), sent on connect and after
 * every change, to pages and peers alike.
 */
const PrefsMessageSchema = z.object({
	type: z.literal('prefs'),
	prefs: z.record(z.string(), PrefEntrySchema),
	timestamp: z.number()
});

/** This machine's past sessions (`src/transcript/past-sessions.ts`), sent on connect and when they change. */
const PastMessageSchema = z.object({
	type: z.literal('past'),
	sessions: eachOf(PastSessionSchema),
	timestamp: z.number()
});

/** Every other machine's past sessions by machine id, from the fleet state; to pages that asked for the fleet. */
const FleetPastMessageSchema = z.object({
	type: z.literal('fleet-past'),
	machines: z.record(z.string(), eachOf(PastSessionSchema)),
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
	FleetMessageSchema,
	PrefsMessageSchema,
	PastMessageSchema,
	FleetPastMessageSchema,
	SystemStatsMessageSchema
]);

export type SessionsWsMessage = z.infer<typeof SessionsWsMessageSchema>;
export type SessionsMessage = z.infer<typeof SessionsMessageSchema>;
export type ConnectedMessage = z.infer<typeof ConnectedMessageSchema>;
export type SystemStatsMessage = z.infer<typeof SystemStatsMessageSchema>;
export type FleetMachineInfo = z.infer<typeof FleetMachineSchema>;
export type EnrichedSession = z.infer<typeof EnrichedSessionSchema>;
