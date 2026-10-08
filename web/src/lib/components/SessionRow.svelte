<script lang="ts" module>
	export interface RowMenuItem {
		label: string;
		icon: string;
		run: () => void;
	}
</script>

<script lang="ts">
	/**
	 * One session in the sidebar.
	 *
	 * Line 1 is the state, the title, and the meta: what asks for a person, or
	 * how long the turn has run, or how long ago anything happened — then the
	 * `meta` slot for whatever a later feature hangs there (a diff badge), and
	 * the context ring. Line 2 is what the session is doing. Rows that need
	 * nothing from anyone recede, so the eye lands on the ones that do.
	 * `children` draws under the row, for rows nested inside it.
	 *
	 * A maestro worker is a session too, but it reads as one of its master's
	 * children: a terminal tile where the state dot was, its issue as a chip,
	 * and the state moved down beside what it is doing.
	 */
	import type { Snippet } from 'svelte';
	import SessionStateIndicator from './SessionStateIndicator.svelte';
	import { indicatorStateOf, isUnread, recedes } from '$shared/session-state.js';
	import { wantsHuman, needsHelp, type Session } from '$lib/stores/sessions.svelte';
	import { longPress } from '$lib/actions/longPress';
	import { formatSpinnerElapsed, formatAgo } from '$lib/format';
	import { clock } from '$lib/stores/clock.svelte';
	import * as ContextMenu from '$lib/components/ui/context-menu';

	interface Props {
		session: Session;
		title: string;
		/** The path chip under the title; null when the title already says it. */
		where: string | null;
		href: string;
		hint: string;
		active: boolean;
		/** Which split pane the row is open in. */
		tag: 'A' | 'B' | null;
		orchestrator?: boolean;
		worker?: boolean;
		/** Unsent composer text for this session, already shortened. */
		draft?: string;
		staged?: number;
		draggable: boolean;
		/** Kill offered; null leaves the button off (compact sidebar, another machine). */
		onkill?: (() => void) | null;
		onmarkunread?: (() => void) | null;
		onclick: (e: MouseEvent) => void;
		onlongpress?: () => void;
		ondragstart?: (e: DragEvent) => void;
		ondragend?: () => void;
		/** What a right-click on the row offers; none leaves the browser's own menu. */
		menu?: RowMenuItem[];
		/** Trailing slot on line 1, after the time. */
		meta?: Snippet;
		children?: Snippet;
	}

	let {
		session: s,
		title,
		where,
		href,
		hint,
		active,
		tag,
		orchestrator = false,
		worker = false,
		draft = '',
		staged = 0,
		draggable,
		onkill = null,
		onmarkunread = null,
		onclick,
		onlongpress,
		ondragstart,
		ondragend,
		menu = [],
		meta,
		children
	}: Props = $props();

	const shown = $derived(indicatorStateOf(s));
	const wants = $derived(wantsHuman(s));
	const quiet = $derived(recedes(shown) && !wants && !active);
	const running = $derived(s.state === 'busy' && s.turn_started_at != null);
	const canMarkUnread = $derived(!!onmarkunread && s.state === 'idle' && !!s.turn_completed_at && !isUnread(s));

	// A working row counts its turn up every second; the rest say how long ago,
	// which only needs a look now and then.
	$effect(() => {
		if (running) return clock.fine();
	});
	/**
	 * A finger's hold is the rename here, so the menu answers only a right
	 * click: the hold's own contextmenu event (Android raises one) is dropped.
	 */
	let touched = false;
	const elapsed = $derived(
		running ? formatSpinnerElapsed(Math.max(0, Math.floor((clock.now - s.turn_started_at!) / 1000))) : null
	);
</script>

<ContextMenu.Root>
<ContextMenu.Trigger disabled={menu.length === 0}>
{#snippet child({ props })}
<a
	{...props}
	onpointerdown={(e) => (touched = e.pointerType === 'touch')}
	onpointermove={undefined}
	onpointerup={undefined}
	onpointercancel={undefined}
	oncontextmenu={(e) => {
		if (touched) e.preventDefault();
		else (props.oncontextmenu as ((e: MouseEvent) => void) | undefined)?.(e);
	}}
	tabindex={undefined}
	{href}
	class="row"
	class:cur={active || tag !== null}
	class:orch={orchestrator}
	class:worker
	class:quiet
	class:inA={tag === 'A'}
	class:inB={tag === 'B'}
	draggable={draggable ? 'true' : 'false'}
	{ondragstart}
	{ondragend}
	{onclick}
	use:longPress={{ onTrigger: () => onlongpress?.() }}
	title={hint}
>
	{#if worker}
		<span class="tile" aria-hidden="true">
			<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></svg>
		</span>
	{:else}
		<span class="st"><SessionStateIndicator state={shown} size="sm" title={s.current_action} /></span>
	{/if}
	<span class="name" title={s.cwd}>{title}</span>
	<span class="meta">
		{#if tag}<span class="ptag" title="Open in pane {tag}">{tag}</span>{/if}
		{#if s.rc_url}
			<iconify-icon icon="mdi:cellphone-link" class="rc" title="Remote Control active"></iconify-icon>
		{/if}
		{#if wants}
			<span class="pill">{needsHelp(s) ? 'needs help' : 'wants you'}</span>
		{:else if worker && s.maestro_issue}
			<span class="issue">#{s.maestro_issue}</span>
		{:else if elapsed}
			<span class="when run" title="Working for {elapsed}">{elapsed}</span>
		{:else}
			<span class="when">{formatAgo(shown === 'done' ? s.turn_completed_at : s.last_update, clock.now)}</span>
		{/if}
		{@render meta?.()}
	</span>
	{#if s.context_pct !== null && s.context_pct !== undefined}
		<span
			class="ctx"
			class:warn={s.context_pct >= 70 && s.context_pct < 90}
			class:hot={s.context_pct >= 90}
			style="--p: {Math.min(100, Math.max(0, s.context_pct))}"
			title="{s.context_pct}% of the context window"
		></span>
	{:else}
		<span class="ctx none"></span>
	{/if}
	{#if canMarkUnread || onkill}
		<span class="acts">
			{#if canMarkUnread}
				<button
					type="button"
					title="Mark unread"
					onclick={(e) => { e.preventDefault(); e.stopPropagation(); onmarkunread?.(); }}
				>
					<iconify-icon icon="mdi:email-mark-as-unread"></iconify-icon>
				</button>
			{/if}
			{#if onkill}
				<button
					type="button"
					class="kill"
					title="Kill session"
					onclick={(e) => { e.preventDefault(); e.stopPropagation(); onkill?.(); }}
				>
					<iconify-icon icon="mdi:power"></iconify-icon>
				</button>
			{/if}
		</span>
	{/if}
	<span class="sub" class:draft={!!draft} title={draft || s.current_action || s.state}>
		{#if staged}
			<span class="staged" title="{staged} attachment{staged === 1 ? '' : 's'} staged"
				><iconify-icon icon="mdi:paperclip"></iconify-icon>{staged}</span
			>
		{/if}
		{#if worker}
			<span class="wst"><SessionStateIndicator state={shown} size="sm" title={s.current_action} /></span>
		{/if}
		{#if draft}
			<iconify-icon icon="mdi:pencil-outline"></iconify-icon>{draft}
		{:else if worker}
			{['worker', shown, s.current_action].filter(Boolean).join(' · ')}
		{:else}
			{s.current_action || (shown === 'done' ? 'done' : s.state)}
		{/if}
		{#if !draft && where}<span class="path" title={s.cwd}>{where}</span>{/if}
	</span>
</a>
{/snippet}
</ContextMenu.Trigger>
{#if menu.length > 0}
	<ContextMenu.Content class="min-w-44">
		{#each menu as item (item.label)}
			<ContextMenu.Item onSelect={item.run}>
				<iconify-icon icon={item.icon}></iconify-icon>
				{item.label}
			</ContextMenu.Item>
		{/each}
	</ContextMenu.Content>
{/if}
</ContextMenu.Root>
{@render children?.()}

<style>
	.row {
		display: grid;
		grid-template-columns: 16px 1fr auto 14px;
		column-gap: 8px;
		align-items: center;
		padding: 6px 7px;
		border-radius: 9px;
		color: var(--text);
		text-decoration: none;
		position: relative;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.cur {
		background: var(--surface-3);
	}
	.st {
		display: grid;
		place-items: center;
		width: 16px;
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}
	.row.orch .name {
		color: var(--muted);
	}
	/* Needs nothing from anyone: the title steps back so the rows that do
	   (working, asking, done) are what the eye lands on. */
	.row.quiet .name {
		color: var(--muted);
		font-weight: 400;
	}
	/* A maestro worker: violet, the colour of a whole session working for
	   another. Its thread is drawn by the list that nests it. */
	.row.worker {
		grid-template-columns: 18px 1fr auto 14px;
		padding: 7px 8px;
	}
	.row.worker .name {
		font-family: var(--font-mono);
		font-size: 12.5px;
	}
	.tile {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
		background: #2e1f5e;
		color: #c4b5fd;
	}
	.tile svg {
		width: 11px;
		height: 11px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.issue {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: #c4b5fd;
		background: #2e1f5e;
		border-radius: 999px;
		padding: 1px 7px;
		white-space: nowrap;
	}
	.wst {
		display: inline-grid;
		place-items: center;
		vertical-align: 0;
		margin-right: 5px;
		transform: scale(0.85);
	}
	.path {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--dim);
		background: var(--surface-3);
		border-radius: 4px;
		padding: 0 5px;
		margin-left: 6px;
		flex-shrink: 0;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.when {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.when.run {
		color: var(--muted);
	}
	/* Remote Control: reachable from the account's other sessions and the
	   phone. Indigo, the colour the app keeps for "connected elsewhere". */
	.rc {
		font-size: 13px;
		color: #818cf8;
	}
	/* Which pane of a split the row is open in. A is amber, the focus colour;
	   B is indigo, the "elsewhere" colour, so the two never read alike. */
	.row.inA {
		box-shadow: inset 2px 0 0 var(--amber);
	}
	.row.inB {
		box-shadow: inset 2px 0 0 #818cf8;
	}
	.ptag {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 0 4px;
		color: var(--dim);
	}
	.row.inA .ptag {
		color: var(--amber);
		border-color: #5a4310;
	}
	.row.inB .ptag {
		color: #818cf8;
		border-color: #3a3a6a;
	}
	.pill {
		font-size: 10.5px;
		font-weight: 500;
		color: var(--amber);
		background: var(--amber-soft);
		border-radius: 999px;
		padding: 1px 7px;
		white-space: nowrap;
	}
	.sub {
		grid-column: 2 / 5;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--dim);
		margin-top: 1px;
	}
	.sub.draft {
		color: var(--amber);
	}
	.sub iconify-icon {
		font-size: 11px;
		vertical-align: -1px;
		margin-right: 3px;
	}
	.sub .staged {
		color: var(--amber);
		margin-right: 6px;
	}
	.sub .staged iconify-icon {
		margin-right: 1px;
	}
	/* The row's rare actions sit over its right edge, only when pointed at. */
	.acts {
		position: absolute;
		right: 6px;
		top: 4px;
		display: flex;
		gap: 2px;
		opacity: 0;
	}
	.row:hover .acts {
		opacity: 1;
	}
	.acts button {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: var(--surface-3);
		color: var(--dim);
		font-size: 13px;
		cursor: pointer;
	}
	.acts button:hover {
		color: var(--text);
	}
	.acts .kill:hover {
		color: #fca5a5;
	}
	@media (hover: none) {
		.acts {
			display: none;
		}
	}

	/* context ring */
	.ctx {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		position: relative;
		background: conic-gradient(var(--c, var(--green)) calc(var(--p) * 1%), var(--surface-3) 0);
	}
	.ctx::after {
		content: '';
		position: absolute;
		inset: 3.5px;
		border-radius: 50%;
		background: var(--surface);
	}
	.row:hover .ctx::after {
		background: var(--surface-2);
	}
	.row.cur .ctx::after {
		background: var(--surface-3);
	}
	.ctx.warn {
		--c: var(--amber);
	}
	.ctx.hot {
		--c: #ef4444;
	}
	.ctx.none {
		background: transparent;
	}
	.ctx.none::after {
		display: none;
	}
</style>
