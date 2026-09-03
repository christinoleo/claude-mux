<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { SubagentPayload } from '$lib/stores/transcript.svelte';
	import { createPersisted } from '$lib/stores/persisted';
	import { toolIcon } from '$lib/tool-icons';

	let {
		agents,
		onReveal
	}: {
		/** Every subagent the transcript knows about, running or not. */
		agents: SubagentPayload[];
		/** Brings the agent's Task card into view, loading history if it has to. */
		onReveal?: (toolUseId: string) => void | Promise<void>;
	} = $props();

	/**
	 * The rail is the always-on signal: one tile per agent on the right
	 * margin, over nothing. The panel borrows the text's space only while it
	 * is looked at — it opens on hover or a tap, closes when the pointer
	 * leaves, and a pin turns it into the column that stays.
	 */
	const pinnedStore = createPersisted<boolean>('claude-mux-agent-panel-pinned', false);
	let pinned = $state(false);
	let open = $state(false);
	$effect(() => {
		pinned = pinnedStore.load();
		if (pinned) open = true;
	});

	/** Cards expanded to their full log inside the panel. */
	let expanded = $state<Record<string, boolean>>({});

	/**
	 * A finished agent keeps its tile for a while, so a report that just
	 * landed has somewhere to be found. Keyed by agent id; the value is when
	 * it may go.
	 */
	const LINGER_MS = 60_000;
	let leaving = $state<Record<string, number>>({});
	let seenRunning = new Set<string>();
	let lingerTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const now = Date.now();
		const next = { ...leaving };
		let changed = false;
		for (const a of agents) {
			if (a.running) {
				seenRunning.add(a.agentId);
				if (next[a.agentId]) {
					delete next[a.agentId];
					changed = true;
				}
			} else if (seenRunning.has(a.agentId) && !next[a.agentId]) {
				next[a.agentId] = now + LINGER_MS;
				changed = true;
			}
		}
		if (changed) leaving = next;
		scheduleSweep();
	});

	function scheduleSweep(): void {
		if (lingerTimer) clearTimeout(lingerTimer);
		const due = Object.values(leaving);
		if (due.length === 0) return;
		const wait = Math.max(0, Math.min(...due) - Date.now()) + 50;
		lingerTimer = setTimeout(() => {
			lingerTimer = null;
			const now = Date.now();
			const kept: Record<string, number> = {};
			for (const [id, at] of Object.entries(leaving)) if (at > now) kept[id] = at;
			for (const id of Object.keys(leaving)) if (!kept[id]) seenRunning.delete(id);
			leaving = kept;
			scheduleSweep();
		}, wait);
	}

	const shown = $derived(agents.filter((a) => a.running || leaving[a.agentId]));
	const runningCount = $derived(shown.filter((a) => a.running).length);
	const doneCount = $derived(shown.length - runningCount);

	/** Three hues, one per lane; a fourth agent starts over. */
	const HUES = ['teal', 'violet', 'amber'] as const;
	function hueOf(index: number): (typeof HUES)[number] {
		return HUES[index % HUES.length];
	}

	function nameOf(a: SubagentPayload): string {
		return a.description ?? a.agentType ?? 'agent';
	}

	function doing(a: SubagentPayload): string | null {
		const last = a.activity[a.activity.length - 1];
		return a.running && last ? last.summary : null;
	}

	// Hover opens after a beat, so a pointer crossing the rail on its way to
	// the scrollbar does not flash the panel; leaving closes after a longer
	// one, so the gap between rail and panel is not a trap.
	let openTimer: ReturnType<typeof setTimeout> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimers(): void {
		if (openTimer) clearTimeout(openTimer);
		if (closeTimer) clearTimeout(closeTimer);
		openTimer = closeTimer = null;
	}

	function enter(): void {
		clearTimers();
		if (open) return;
		openTimer = setTimeout(() => {
			openTimer = null;
			open = true;
		}, 120);
	}

	function leave(): void {
		clearTimers();
		if (pinned) return;
		closeTimer = setTimeout(() => {
			closeTimer = null;
			open = false;
		}, 260);
	}

	function toggle(): void {
		clearTimers();
		open = !open;
	}

	function close(): void {
		clearTimers();
		open = false;
	}

	function togglePin(): void {
		pinned = !pinned;
		pinnedStore.save(pinned);
		if (pinned) open = true;
	}

	/**
	 * Esc closes an unpinned panel — and only that. Caught in the capture
	 * phase so the composer's own Escape, which interrupts Claude, does not
	 * fire for a key meant for the panel.
	 */
	function onWindowKey(e: KeyboardEvent): void {
		if (e.key !== 'Escape' || !open || pinned) return;
		e.preventDefault();
		e.stopPropagation();
		close();
	}

	$effect(() => {
		window.addEventListener('keydown', onWindowKey, { capture: true });
		return () => window.removeEventListener('keydown', onWindowKey, { capture: true });
	});

	onDestroy(() => {
		clearTimers();
		if (lingerTimer) clearTimeout(lingerTimer);
	});

	/** The activity a card shows closed: the newest few, oldest first. */
	const TAIL = 3;
</script>

{#if shown.length > 0}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="rail" class:open onmouseenter={enter} onmouseleave={leave}>
		{#each shown as agent, i (agent.agentId)}
			{@const d = doing(agent)}
			<button
				type="button"
				class="tile {hueOf(i)}"
				class:done={!agent.running}
				onclick={toggle}
				aria-label={nameOf(agent)}
				aria-expanded={open}
			>
				<span class="dia" class:pulse={agent.running}></span>
				<span class="badge">
					{#if agent.running}
						{agent.activity.length + agent.trimmed}
					{:else}
						<iconify-icon icon="mdi:check"></iconify-icon>
					{/if}
				</span>
				<span class="tip">
					<span class="dia small"></span>
					<span class="tip-name">{nameOf(agent)}</span>
					{#if d}<span class="tip-doing">{d}</span>{/if}
				</span>
			</button>
		{/each}
		<span class="rail-label" aria-hidden="true">agents</span>
	</div>

	{#if open}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<section class="panel" onmouseenter={enter} onmouseleave={leave} aria-label="Running agents">
			<header>
				<span>Agents</span>
				{#if runningCount > 0}<span class="n-running">{runningCount} running</span>{/if}
				{#if doneCount > 0}<span class="sep">·</span><span>{doneCount} done</span>{/if}
				<span class="grow"></span>
				<button type="button" class="hbtn" class:on={pinned} onclick={togglePin} title={pinned ? 'Let the panel close on its own' : 'Keep the panel open'}>
					<iconify-icon icon="mdi:pin"></iconify-icon>{pinned ? 'pinned' : 'pin'}
				</button>
				<button type="button" class="hbtn icon" onclick={close} title="Close (Esc)">
					<iconify-icon icon="mdi:close"></iconify-icon>
				</button>
			</header>
			<div class="cards">
				{#each shown as agent, i (agent.agentId)}
					{@const full = expanded[agent.agentId] === true}
					{@const tail = full ? agent.activity : agent.activity.slice(-TAIL)}
					<article class="card {hueOf(i)}" class:done={!agent.running}>
						<div class="card-h">
							<span class="dia" class:pulse={agent.running}></span>
							<span class="name">{nameOf(agent)}</span>
							{#if agent.agentType}<span class="chip">{agent.agentType}</span>{/if}
						</div>
						<div class="meta mono">
							{#if agent.model}{agent.model} · {/if}{agent.activity.length + agent.trimmed} tools
							{#if !agent.running} · {agent.report ? 'reported' : 'stopped'}{/if}
						</div>
						{#if tail.length > 0}
							<ol class="tail mono" class:full>
								{#if full && agent.trimmed > 0}
									<li class="trimmed">{agent.trimmed} earlier calls not shown</li>
								{/if}
								{#each tail as act (act.id)}
									<li class:pending={act.ok === null} class:failed={act.ok === false}>
										<iconify-icon icon={toolIcon(act.name)}></iconify-icon>
										<span>{act.summary}</span>
									</li>
								{/each}
							</ol>
						{/if}
						{#if full && agent.report}
							<div class="report">{agent.report}</div>
						{/if}
						<div class="actions">
							{#if agent.toolUseId}
								<button type="button" class="btn" onclick={() => void onReveal?.(agent.toolUseId!)}>
									<iconify-icon icon="mdi:arrow-up-thin"></iconify-icon>Go to its card
								</button>
							{/if}
							<button type="button" class="btn" onclick={() => (expanded = { ...expanded, [agent.agentId]: !full })}>
								{full ? 'Less' : agent.running ? 'Full log' : 'Report'}
							</button>
						</div>
					</article>
				{/each}
			</div>
			{#if !pinned}
				<footer>Closes when the pointer leaves · Esc</footer>
			{/if}
		</section>
	{/if}
{/if}

<style>
	/* ── the rail ─────────────────────────────────────────── */
	.rail {
		position: absolute;
		top: 12px;
		right: 14px;
		z-index: 6;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}
	.tile {
		position: relative;
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 1px solid #262220;
		border-radius: 9px;
		background: #121110;
		cursor: pointer;
		color: inherit;
	}
	.tile.done {
		opacity: 0.6;
	}
	.tile:hover {
		background: #1b1816;
	}
	.dia {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		transform: rotate(45deg);
		background: var(--hue);
		flex: none;
	}
	.dia.small {
		width: 8px;
		height: 8px;
	}
	.done .dia {
		background: transparent;
		border: 1.5px solid var(--hue-dim);
		box-sizing: border-box;
	}
	.pulse {
		animation: rail-pulse 1.6s ease-in-out infinite;
	}
	@keyframes rail-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}
	.badge {
		position: absolute;
		right: -5px;
		bottom: -5px;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		box-sizing: border-box;
		border-radius: 7px;
		background: #262220;
		color: var(--hue);
		font-size: 9px;
		font-weight: 600;
		display: grid;
		place-items: center;
		line-height: 1;
	}
	.done .badge {
		color: #34d399;
		background: #14251d;
	}
	.rail-label {
		writing-mode: vertical-rl;
		font-size: 10px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #57534e;
		margin-top: 4px;
	}
	/* Hovering a tile names it; the panel is one more step. */
	.tip {
		position: absolute;
		right: 46px;
		top: 2px;
		display: none;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
		padding: 5px 10px;
		border: 1px solid #2a2725;
		border-radius: 7px;
		background: rgba(12, 11, 10, 0.94);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
		font-size: 12px;
		color: #e7e5e4;
		pointer-events: none;
	}
	.tile:hover .tip {
		display: flex;
	}
	.rail.open .tip {
		display: none;
	}
	.tip-name {
		font-weight: 600;
	}
	.tip-doing {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: #a8a29e;
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* ── the panel ────────────────────────────────────────── */
	.panel {
		position: absolute;
		top: 8px;
		right: 12px;
		z-index: 7;
		width: min(372px, calc(100% - 24px));
		max-height: calc(100% - 16px);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid #2a2725;
		border-radius: 12px;
		background: rgba(12, 11, 10, 0.88);
		backdrop-filter: blur(10px);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
		color: #d6d3d1;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
		white-space: normal;
	}
	.panel header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid #262220;
		font-size: 11px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #78716c;
	}
	.n-running {
		color: #2dd4bf;
	}
	.sep {
		color: #57534e;
	}
	.grow {
		flex: 1;
	}
	.hbtn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border: 1px solid #2c2926;
		border-radius: 5px;
		background: #171512;
		color: #a8a29e;
		font-size: 11px;
		letter-spacing: 0;
		text-transform: none;
		cursor: pointer;
	}
	.hbtn.icon {
		padding: 3px 5px;
	}
	.hbtn:hover {
		color: #e7e5e4;
		border-color: #3a3632;
	}
	.hbtn.on {
		color: #fbbf24;
		border-color: #4a3b12;
		background: #2a2210;
	}
	.cards {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 10px 12px;
		border: 1px solid var(--hue-line);
		border-radius: 8px;
		background: rgba(18, 17, 16, 0.9);
	}
	.card.done {
		opacity: 0.75;
		border-color: #262220;
	}
	.card-h {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.card .dia {
		width: 8px;
		height: 8px;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
		color: #e7e5e4;
	}
	.chip {
		flex: none;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--hue);
		background: var(--hue-bg);
		border-radius: 4px;
		padding: 1px 6px;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.meta {
		font-size: 11px;
		color: #78716c;
	}
	.tail {
		list-style: none;
		margin: 0;
		padding: 0 0 0 10px;
		border-left: 2px solid var(--hue-line);
		font-size: 11.5px;
		color: #a8a29e;
	}
	.tail.full {
		max-height: 260px;
		overflow-y: auto;
	}
	.tail li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 1px 0;
		min-width: 0;
	}
	.tail li span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tail li:last-child.pending {
		color: #e7e5e4;
	}
	.tail li.failed {
		color: #fb7185;
	}
	.tail li.trimmed {
		color: #57534e;
		font-style: italic;
	}
	.tail iconify-icon {
		flex: none;
		font-size: 12px;
		color: #57534e;
	}
	.report {
		max-height: 240px;
		overflow-y: auto;
		padding: 8px 10px;
		border-radius: 6px;
		background: #0e0d0c;
		font-size: 12px;
		line-height: 1.5;
		color: #c7c2bd;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.actions {
		display: flex;
		gap: 6px;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 2px 8px;
		border: 1px solid #2c2926;
		border-radius: 5px;
		background: #171512;
		color: #a8a29e;
		font-size: 11px;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn:hover {
		color: #e7e5e4;
		border-color: #3a3632;
	}
	.panel footer {
		padding: 6px 12px 8px;
		border-top: 1px solid #262220;
		font-size: 11px;
		color: #57534e;
	}

	/* ── hues ─────────────────────────────────────────────── */
	.teal {
		--hue: #2dd4bf;
		--hue-dim: #1c7a6e;
		--hue-line: #1c3a36;
		--hue-bg: #0f2926;
	}
	.violet {
		--hue: #9b8fd4;
		--hue-dim: #5b4f8a;
		--hue-line: #2c2740;
		--hue-bg: #221f2e;
	}
	.amber {
		--hue: #d4b36a;
		--hue-dim: #8a7a55;
		--hue-line: #3a342c;
		--hue-bg: #241d12;
	}
</style>
