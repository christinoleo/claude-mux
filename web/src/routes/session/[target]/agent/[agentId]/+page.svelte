<script lang="ts">
	/**
	 * A subagent opened as a window of its own, in the main view beside the
	 * app's sidebar. It reads like a session — the same transcript, the same
	 * tool-run grouping — but takes no input: the composer gives way to a bar
	 * that sends the reader back to the session that spawned it.
	 *
	 * The entries come over the parent session's transcript socket, which
	 * already tails every subagent for the Task cards; this page asks it for
	 * one agent's (see TranscriptWsManager.addClient).
	 */
	import { page } from '$app/stores';
	import { onDestroy, tick, untrack } from 'svelte';
	import { sessionStore, getSessionDisplayName } from '$lib/stores/sessions.svelte';
	import { TranscriptStore } from '$lib/stores/transcript.svelte';
	import TranscriptView from '$lib/components/TranscriptView.svelte';
	import { Button } from '$lib/components/ui/button';
	import { agentTypeLabel } from '$shared/subagents.js';
	import { compact, formatElapsed } from '$lib/format';
	import { clock } from '$lib/stores/clock.svelte';
	import { drawer } from '$lib/stores/drawer.svelte';

	const target = $derived(decodeURIComponent($page.params.target ?? ''));
	const agentId = $derived(decodeURIComponent($page.params.agentId ?? ''));

	const session = $derived(
		sessionStore.sessionByTarget.get(target) ?? sessionStore.sessionById.get(target)
	);
	const parentName = $derived(session ? getSessionDisplayName(session) : target);
	const parentHref = $derived(`/session/${encodeURIComponent(target)}`);

	/** What the hooks recorded of the agent; gone an hour after it finished. */
	const hooked = $derived(session?.subagents?.find((a) => a.id === agentId) ?? null);

	const store = new TranscriptStore();
	$effect(() => {
		store.setSession(session?.id ?? null, agentId);
	});
	onDestroy(() => store.setSession(null));

	/** What the transcript knows of it: the type, the brief, the tools it ran. */
	const payload = $derived(store.subagents[agentId] ?? null);

	const agentState = $derived<'running' | 'done' | 'failed'>(
		hooked?.state ?? (payload?.running ? 'running' : 'done')
	);
	const running = $derived(agentState === 'running');
	const description = $derived(hooked?.description ?? payload?.description ?? null);
	const type = $derived(hooked?.type ?? payload?.agentType ?? null);
	const title = $derived(description ?? (type ? agentTypeLabel(type) : 'Subagent'));

	/** The brief is the agent's first line; it is pinned above rather than drawn as a prompt. */
	const entries = $derived(
		store.firstIndex === 0 && store.entries[0]?.kind === 'user' ? store.entries.slice(1) : store.entries
	);
	const brief = $derived(
		payload?.prompt ??
			(store.firstIndex === 0 && store.entries[0]?.kind === 'user' ? store.entries[0].text : null)
	);

	$effect(() => {
		if (running) return clock.fine();
	});

	const status = $derived.by(() => {
		const first = store.firstIndex === 0 ? store.entries[0]?.ts : undefined;
		const started = hooked?.started_at ?? first ?? null;
		const ended = running ? clock.now : (hooked?.ended_at ?? store.entries.at(-1)?.ts ?? null);
		const parts: string[] = [agentState];
		if (started !== null && ended !== null) parts.push(formatElapsed((ended - started) / 1000));
		if (payload) {
			const tools = payload.activity.length + payload.trimmed;
			parts.push(`${tools} tool${tools === 1 ? '' : 's'}`);
		}
		if (store.context) parts.push(`${compact(store.context.tokens)} tok`);
		return parts.join(' · ');
	});

	/** Neither the hooks nor the files have heard of it. */
	const unknown = $derived(
		store.receivedData && !store.available && !hooked && sessionStore.sessions.length > 0
	);
	const noSession = $derived(sessionStore.sessions.length > 0 && !session);

	// ── keep to the newest line while the reader is at the bottom ─────────
	let scroller: HTMLDivElement | null = $state(null);
	let pinned = true;
	function onScroll() {
		if (!scroller) return;
		pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
	}
	$effect(() => {
		void store.entries.length;
		void store.appended;
		untrack(() => {
			if (!pinned) return;
			void tick().then(() => {
				if (scroller) scroller.scrollTop = scroller.scrollHeight;
			});
		});
	});
	$effect(() => {
		void agentId;
		pinned = true;
	});

	async function loadEarlier() {
		if (!scroller) return void store.loadEarlier();
		const fromBottom = scroller.scrollHeight - scroller.scrollTop;
		await store.loadEarlier();
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight - fromBottom;
	}
</script>

<svelte:head>
	<title>◆ {title} · {parentName}</title>
</svelte:head>

<div class="window">
	<header>
		<button type="button" class="menu" onclick={() => drawer.toggle()} aria-label="Sessions">
			<iconify-icon icon="mdi:menu"></iconify-icon>
		</button>
		<a class="crumb" href={parentHref}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
			{parentName}
		</a>
		<span class="slash" aria-hidden="true">/</span>
		<span class="dia" class:failed={agentState === 'failed'} aria-hidden="true">
			<svg viewBox="0 0 24 24"><path d="M12 3l9 9-9 9-9-9z" /></svg>
		</span>
		<h1>{title}</h1>
		{#if type}<span class="chip">{agentTypeLabel(type)}</span>{/if}
		<span class="grow"></span>
		{#if !unknown && !noSession}
			<span class="status" class:failed={agentState === 'failed'}>
				<span class="dot" class:live={running}></span>{status}
			</span>
		{/if}
	</header>

	{#if unknown || noSession}
		<div class="empty">
			<span class="dia big" aria-hidden="true">
				<svg viewBox="0 0 24 24"><path d="M12 3l9 9-9 9-9-9z" /></svg>
			</span>
			<p class="empty-title">
				{noSession ? 'This session is no longer running' : 'No subagent with this id'}
			</p>
			<p class="empty-body">
				{noSession
					? 'Its subagents went with it.'
					: `${parentName} has no record of agent ${agentId}. It may have been spawned by another session, or its transcript was removed.`}
			</p>
			{#if !noSession}
				<Button variant="outline" href={parentHref}>Back to {parentName}</Button>
			{:else}
				<Button variant="outline" href="/">See all sessions</Button>
			{/if}
		</div>
	{:else}
		<div class="scroll" bind:this={scroller} onscroll={onScroll}>
			<div class="column">
				{#if brief}
					<section class="brief" aria-label="Brief">
						<span class="brief-from">Brief from {parentName}</span>
						<p>{brief}</p>
					</section>
				{/if}
				{#if store.receivedData && !store.available}
					<p class="waiting">Waiting for the agent to write its first line…</p>
				{:else}
					{#key agentId}
						<TranscriptView
							{entries}
							available={store.available}
							loaded={store.receivedData}
							sessionState={running ? 'busy' : 'idle'}
							currentAction={hooked?.current_tool ?? null}
							olderCount={store.firstIndex}
							loadingEarlier={store.loadingEarlier}
							onLoadEarlier={() => void loadEarlier()}
						/>
					{/key}
				{/if}
			</div>
		</div>

		<footer>
			<div class="readonly">
				<iconify-icon icon="mdi:eye-outline" aria-hidden="true"></iconify-icon>
				<span>Subagents take no input. To steer, talk to the session that spawned it.</span>
				<Button variant="outline" class="message" href="{parentHref}?compose">Message {parentName}</Button>
			</div>
		</footer>
	{/if}
</div>

<style>
	.window {
		--teal: #5eead4;
		--teal-deep: #155e63;
		height: 100%;
		display: flex;
		flex-direction: column;
		background: #000;
		color: #e7e5e4;
		min-width: 0;
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 24px;
		border-bottom: 1px solid #1f1f1f;
		min-width: 0;
	}
	.menu {
		display: none;
		place-items: center;
		width: 36px;
		height: 36px;
		margin-left: -8px;
		border: 0;
		background: none;
		color: #a8a29e;
		font-size: 20px;
	}
	.crumb {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 12.5px;
		color: #a8a29e;
		text-decoration: none;
		white-space: nowrap;
		max-width: 30%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.crumb:hover {
		color: #f5f5f4;
	}
	.crumb svg,
	.dia svg {
		width: 13px;
		height: 13px;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.slash {
		color: #44403c;
	}
	.dia {
		display: flex;
		color: var(--teal);
	}
	.dia.failed {
		color: #f87171;
	}
	h1 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chip {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--teal);
		border: 1px solid var(--teal-deep);
		border-radius: 4px;
		padding: 1px 6px;
		white-space: nowrap;
	}
	.grow {
		flex: 1;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: #a8a29e;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.status.failed {
		color: #f87171;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #57534e;
	}
	.dot.live {
		background: #22c55e;
	}
	.status.failed .dot {
		background: #f87171;
	}

	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 24px 16px;
	}
	.column {
		max-width: 860px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.brief {
		border-left: 3px solid var(--teal-deep);
		background: #0a1c1d;
		border-radius: 0 10px 10px 0;
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.brief-from {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--teal);
	}
	.brief p {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 14em;
		overflow-y: auto;
	}
	.waiting {
		color: #78716c;
		font-size: 13px;
	}

	footer {
		padding: 12px 16px 18px;
	}
	.readonly {
		max-width: 860px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		gap: 14px;
		border: 1px dashed #2f3b3b;
		border-radius: 12px;
		padding: 10px 12px 10px 16px;
		background: #0f1414;
		font-size: 13px;
		color: #a8a29e;
	}
	.readonly iconify-icon {
		color: #78716c;
		font-size: 16px;
		flex: none;
	}
	.readonly span {
		flex: 1;
	}
	.readonly :global(.message) {
		border-color: var(--teal-deep);
		color: var(--teal);
		min-height: 40px;
	}

	.empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 24px 16px;
		text-align: center;
	}
	.dia.big svg {
		width: 28px;
		height: 28px;
		color: #44403c;
	}
	.empty-title {
		margin: 6px 0 0;
		font-size: 15px;
		font-weight: 600;
	}
	.empty-body {
		margin: 0 0 8px;
		max-width: 46ch;
		font-size: 13px;
		line-height: 1.5;
		color: #a8a29e;
	}

	@media (max-width: 767px) {
		header {
			padding: 8px 16px;
			flex-wrap: wrap;
		}
		.menu {
			display: grid;
		}
		.status {
			flex-basis: 100%;
		}
		.grow {
			display: none;
		}
		.readonly {
			flex-wrap: wrap;
		}
		.readonly :global(.message) {
			width: 100%;
		}
	}
</style>
