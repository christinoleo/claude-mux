<script lang="ts">
	/**
	 * A past session (GLOSSARY.md): a conversation whose transcript is on its
	 * machine's disk with no pane. Its transcript reads here as a session's
	 * does, and nothing starts until Resume, which continues it on that
	 * machine, in its folder (`resumePast()`). A session already running is
	 * opened instead, and a machine that is off keeps Resume until it is back.
	 *
	 * The entries come over the same transcript socket a live session uses,
	 * which finds a transcript by its id when no session JSON names it.
	 */
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onDestroy, tick } from 'svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';
	import { TranscriptStore } from '$lib/stores/transcript.svelte';
	import TranscriptView from '$lib/components/TranscriptView.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { clock } from '$lib/stores/clock.svelte';
	import { drawer } from '$lib/stores/drawer.svelte';
	import { blockedReason, fleetStore, routeMachine } from '$lib/stores/fleet.svelte';
	import { sessionPath } from '$lib/session-route';
	import { formatAgo } from '$lib/format';
	import { pastLabel } from '$shared/past-session.js';
	import { resumePast } from '$lib/past-resume';

	const id = $derived(decodeURIComponent($page.params.id ?? ''));
	const route = routeMachine(() => $page.params.machine ?? null);
	const base = $derived(route.base);
	const remoteHost = $derived(route.remoteHost);
	const machine = $derived(remoteHost ? route.machine : (fleetStore.machines[0] ?? null));
	const past = $derived(machine?.past.find((p) => p.id === id) ?? null);
	const live = $derived(machine?.sessions.find((s) => s.id === id && s.pane_alive !== false && s.tmux_target) ?? null);
	const blocked = $derived(machine ? blockedReason(machine, clock.now) : null);
	const title = $derived(past ? pastLabel(past) : 'Past session');

	const store = new TranscriptStore();
	$effect(() => {
		store.setSession(id || null, null, base);
	});
	onDestroy(() => store.setSession(null));

	let scroller: HTMLDivElement | null = $state(null);
	// A past conversation opens at its end, where it was left.
	let placed = false;
	$effect(() => {
		if (placed || !store.receivedData || store.entries.length === 0) return;
		placed = true;
		void tick().then(() => {
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});
	async function loadEarlier() {
		if (!scroller) return void store.loadEarlier();
		const fromBottom = scroller.scrollHeight - scroller.scrollTop;
		await store.loadEarlier();
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight - fromBottom;
	}

	let busy = $state(false);
	let error = $state<string | null>(null);
	/** The folder it ran in is gone: the project's root, offered in its place. */
	let gone = $state<{ cwd: string | null; root: string } | null>(null);

	async function resume(cwd?: string) {
		busy = true;
		error = null;
		const result = await resumePast(machine, base, id, cwd);
		busy = false;
		if (result.kind === 'offer-root') {
			gone = { cwd: result.cwd, root: result.root };
			return;
		}
		if (result.kind === 'error') {
			error = result.message;
			return;
		}
		void goto(sessionPath({ host: remoteHost, target: result.tmuxTarget }));
	}

	const unknown = $derived(store.receivedData && !store.available && !past && sessionStore.connected);
</script>

<svelte:head>
	<title>{title} · past session</title>
</svelte:head>

<div class="window">
	<header>
		<Button variant="ghost" size="icon" class="menu" onclick={() => drawer.toggle()} aria-label="Sessions">
			<iconify-icon icon="mdi:menu"></iconify-icon>
		</Button>
		<iconify-icon class="glyph" icon="mdi:history" aria-hidden="true"></iconify-icon>
		<div class="what">
			<h1 title={past?.prompt ?? undefined}>{title}</h1>
			{#if past}
				{@const ago = formatAgo(past.lastActivity, clock.now)}
				<p class="sub">
					{past.cwd ?? 'folder unknown'}{#if past.branch}<span class="branch">{past.branch}</span>{/if}
					{#if machine && (remoteHost || fleetStore.fleet)}<span>on {machine.server.hostname}</span>{/if}
					<span>{ago === 'now' ? 'active just now' : `last active ${ago} ago`}</span>
				</p>
			{/if}
		</div>
		{#if live?.tmux_target}
			<Button class="resume" href={sessionPath({ host: remoteHost, target: live.tmux_target })}>
				<iconify-icon icon="mdi:console-line"></iconify-icon>Open running session
			</Button>
		{:else}
			<Button class="resume" disabled={busy || !!blocked || unknown} title={blocked ?? undefined} onclick={() => void resume()}>
				<iconify-icon icon="mdi:play"></iconify-icon>{busy ? 'Resuming…' : 'Resume'}
			</Button>
		{/if}
	</header>
	{#if blocked && !live}
		<p class="notice" role="status">{blocked}. Resume when it's back.</p>
	{/if}
	{#if error}
		<p class="notice err" role="alert">{error}</p>
	{/if}

	{#if unknown}
		<div class="empty">
			<p class="empty-title">No conversation with this id</p>
			<p class="empty-body">Its transcript is not on this machine. Claude Code removes transcripts after 30 days.</p>
			<Button variant="outline" href="/">See all sessions</Button>
		</div>
	{:else}
		<div class="scroll" bind:this={scroller}>
			<div class="column">
				<TranscriptView
					entries={store.entries}
					available={store.available}
					loaded={store.receivedData}
					sessionState="idle"
					olderCount={store.firstIndex}
					loadingEarlier={store.loadingEarlier}
					onLoadEarlier={() => void loadEarlier()}
					{base}
				/>
			</div>
		</div>
	{/if}
</div>

<AlertDialog.Root open={gone !== null} onOpenChange={(o) => { if (!o) gone = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>The folder is gone</AlertDialog.Title>
			<AlertDialog.Description>
				{gone?.cwd} no longer exists. Resume the conversation in the project's folder, {gone?.root}, instead?
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					const root = gone?.root;
					gone = null;
					if (root) void resume(root);
				}}>Resume in {gone?.root.split('/').pop()}</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.window {
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
		gap: 12px;
		padding: 12px 24px;
		border-bottom: 1px solid #1f1f1f;
		min-width: 0;
	}
	header :global(.menu) {
		display: none;
		flex: none;
		width: 36px;
		margin-left: -8px;
		color: #a8a29e;
		font-size: 20px;
	}
	.glyph {
		flex: none;
		font-size: 18px;
		color: #78716c;
	}
	.what {
		flex: 1;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		margin: 2px 0 0;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: #78716c;
		overflow-wrap: anywhere;
	}
	.branch {
		color: #a8a29e;
	}
	header :global(.resume) {
		flex: none;
		gap: 6px;
	}
	.notice {
		margin: 0;
		padding: 8px 24px;
		font-size: 12.5px;
		color: #a8a29e;
		background: #0f0f0f;
		border-bottom: 1px solid #1f1f1f;
	}
	.notice.err {
		color: #f87171;
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
	.empty-title {
		margin: 0;
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
		header :global(.menu) {
			display: inline-flex;
		}
		header :global(.resume) {
			width: 100%;
		}
		.notice {
			padding: 8px 16px;
		}
	}
</style>
