<script lang="ts">
	/**
	 * The project's site in a frame: the prod or dev URL `.claude-mux.json`
	 * names, a dev server found running inside the project, or a URL typed into
	 * the bar. The URL holds the choice (`?url=prod|dev|<url>`), and the last
	 * one persists per session.
	 *
	 * A URL on this machine is framed through its tailscale serve mapping when
	 * it has one, so the phone reaches it too; one that cannot be framed from
	 * here (mixed content, X-Frame-Options, CSP frame-ancestors) gets a card
	 * that opens it in a tab of its own instead of a blank frame. Discovery is
	 * polled only while the pane is showing.
	 */
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { PaneBodyProps } from '$lib/side-panel/panes';
	import { Toggle } from '$lib/components/ui/toggle';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import {
		choiceUrl,
		normalizeTyped,
		resolveEmbed,
		type FrameCheck,
		type WebChoice,
		type WebInfo
	} from '$lib/side-panel/web';
	import { webPaneStore } from '$lib/stores/webPane.svelte';

	let { session, params, setParams, setActions, active }: PaneBodyProps = $props();

	/** How often discovery runs while the pane is showing. */
	const POLL_MS = 5_000;
	const CONFIG_SAMPLE = `{ "urls": { "prod": "https://…", "dev": "http://localhost:5173" } }`;

	const sessionId = $derived(session?.id ?? null);

	// ── discovery ────────────────────────────────────────────────────────

	let info = $state<WebInfo | null>(null);
	let infoError = $state<string | null>(null);
	let infoSeq = 0;

	async function loadInfo(id: string) {
		const mine = ++infoSeq;
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/web`);
			const body = await res.json();
			if (mine !== infoSeq) return;
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			info = body as WebInfo;
			infoError = null;
		} catch (err) {
			if (mine === infoSeq) infoError = err instanceof Error ? err.message : String(err);
		}
	}

	$effect(() => {
		const id = sessionId;
		if (!id || !active) return;
		untrack(() => void loadInfo(id));
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void loadInfo(id);
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	// ── the choice ───────────────────────────────────────────────────────

	const devConfigured = $derived(!!info?.urls.dev);
	/** What to show when neither the URL nor this browser names anything. */
	const fallback = $derived<WebChoice | null>(
		devConfigured || info?.detected.length ? 'dev' : info?.urls.prod ? 'prod' : null
	);
	const choice = $derived(params.url ?? fallback);
	const target = $derived(choice ? choiceUrl(choice, info) : null);

	// No URL in the address: put the one last shown here back.
	let restored = false;
	$effect(() => {
		if (!active || restored) return;
		restored = true;
		const last = untrack(() => webPaneStore.get(sessionId));
		if (!params.url && last) setParams({ url: last });
	});

	$effect(() => {
		if (params.url) webPaneStore.set(sessionId, params.url);
	});

	/** In-frame navigations and choices pushed from here, which Back may undo. */
	let backSteps = $state(0);

	function choose(next: string) {
		if (next === choice) return;
		setParams({ url: next }, { push: true });
		backSteps++;
	}

	function goBack() {
		if (backSteps === 0) return;
		backSteps--;
		history.back();
	}

	// ── the bar ──────────────────────────────────────────────────────────

	let typed = $state('');
	$effect(() => {
		typed = target ?? '';
	});

	function submitTyped(e: SubmitEvent) {
		e.preventDefault();
		const url = normalizeTyped(typed);
		if (!url) {
			toast.error('Not an http(s) URL', { description: typed });
			return;
		}
		const named = (['prod', 'dev'] as const).find((c) => choiceUrl(c, info) === url);
		choose(named ?? url);
	}

	// ── what is drawn ────────────────────────────────────────────────────

	const embed = $derived.by(() => {
		if (!target || !info) return null;
		try {
			return resolveEmbed(target, { page: location, tailnet: info.tailnet, detected: info.detected });
		} catch {
			return null;
		}
	});
	const frameSrc = $derived(embed?.kind === 'frame' ? embed.src : null);
	const openUrl = $derived(embed ? (embed.kind === 'frame' ? embed.src : embed.open) : target);

	/** The frame check for the frame's URL; until it lands the frame is not drawn. */
	let check = $state<{ src: string; result: FrameCheck } | null>(null);
	$effect(() => {
		const src = frameSrc;
		if (!src) return;
		let stale = false;
		const q = new URLSearchParams({ url: src, origin: location.origin });
		fetch(`/api/web/frame?${q}`)
			.then((res) => res.json() as Promise<FrameCheck>)
			.catch((err): FrameCheck => ({ embeddable: null, reason: String(err) }))
			.then((result) => {
				if (!stale) check = { src, result };
			});
		return () => (stale = true);
	});
	const verdict = $derived(check && check.src === frameSrc ? check.result : null);
	/** Why the target is shown as a card rather than framed, or null to frame it. */
	const blocked = $derived.by((): { reason: string; open: string; command?: string } | null => {
		if (embed?.kind === 'card') return embed;
		if (embed && verdict?.embeddable === false) {
			return { reason: `The site forbids framing. ${verdict.reason}`, open: embed.src };
		}
		return null;
	});

	let reloads = $state(0);
	/** Loads of the current frame; every one after the first is a navigation inside it. */
	let frameLoads = 0;
	$effect(() => {
		void frameSrc;
		void reloads;
		frameLoads = 0;
	});

	function onFrameLoad() {
		if (frameLoads++ > 0) backSteps++;
	}

	function reload() {
		if (frameSrc) reloads++;
		if (sessionId) void loadInfo(sessionId);
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied', { description: text });
		} catch {
			toast.error('Could not copy');
		}
	}

	$effect(() => {
		setActions([
			{ icon: 'mdi:arrow-left', label: 'Back', disabled: backSteps === 0, run: goBack },
			{ icon: 'mdi:refresh', label: 'Reload', disabled: !sessionId, run: reload },
			{
				icon: 'mdi:open-in-new',
				label: 'Open in new tab',
				disabled: !openUrl,
				run: () => openUrl && window.open(openUrl, '_blank', 'noopener,noreferrer')
			}
		]);
	});

	function hostLabel(url: string): string {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	}
</script>

<div class="web">
	<form class="bar" onsubmit={submitTyped}>
		<div class="seg" role="group" aria-label="Site">
			<Toggle
				size="sm"
				disabled={!info?.urls.prod}
				title={info?.urls.prod ?? 'No prod URL in .claude-mux.json'}
				bind:pressed={() => choice === 'prod', (on) => on && choose('prod')}>Prod</Toggle
			>
			<Toggle
				size="sm"
				disabled={!devConfigured && !info?.detected.length}
				title={info?.urls.dev ?? (info?.detected.length ? 'A dev server found running in the project' : 'No dev server found')}
				bind:pressed={() =>
					choice === 'dev' || (!devConfigured && !!info?.detected.some((d) => d.url === choice)),
				(on) => on && choose('dev')}>Dev</Toggle
			>
		</div>
		<Input
			bind:value={typed}
			class="url"
			type="text"
			inputmode="url"
			placeholder="Type a URL…"
			aria-label="URL"
			autocomplete="off"
			spellcheck={false}
		/>
	</form>

	{#if info && !devConfigured && info.detected.length > 0}
		<div class="detected">
			<span class="label">Detected dev servers</span>
			{#each info.detected as server, i (server.port)}
				<Toggle
					variant="outline"
					size="sm"
					class="chip"
					title={`${server.process} (pid ${server.pid}) · ${server.url}`}
					bind:pressed={() => target === server.url, (on) => on && choose(i === 0 ? 'dev' : server.url)}
				>
					<span class="dot"></span>:{server.port}
					<span class="proc">{server.process}</span>
					{#if server.loopbackOnly}<iconify-icon icon="mdi:lock-outline" title="127.0.0.1 only"></iconify-icon>{/if}
				</Toggle>
			{/each}
		</div>
	{/if}

	<div class="view">
		{#if infoError && !info}
			<p class="msg err">{infoError}</p>
		{:else if !info && !params.url}
			<p class="msg dim">Looking for the project's URLs…</p>
		{:else if !target}
			<div class="empty">
				<iconify-icon icon="mdi:web-off"></iconify-icon>
				{#if choice === 'prod'}
					<h3>No prod URL</h3>
					<p>Name one as <code>urls.prod</code> in <code>.claude-mux.json</code> at the repo root.</p>
				{:else if choice === 'dev'}
					<h3>No dev server running</h3>
					<p>
						Nothing inside <code>{info?.root}</code> is serving HTML. Start the dev server, or name one as
						<code>urls.dev</code> in <code>.claude-mux.json</code>.
					</p>
				{:else}
					<h3>Nothing to show yet</h3>
					<p>Type a URL above, start a dev server in the project, or commit a <code>.claude-mux.json</code>:</p>
					<pre>{CONFIG_SAMPLE}</pre>
				{/if}
				{#if info?.configError}<p class="err">.claude-mux.json: {info.configError}</p>{/if}
			</div>
		{:else if !embed}
			<p class="msg dim">Resolving {target}…</p>
		{:else if blocked}
			{@const command = blocked.command}
			<div class="empty card">
				<iconify-icon icon="mdi:application-brackets-outline"></iconify-icon>
				<h3>Can't show {hostLabel(blocked.open)} here</h3>
				<p>{blocked.reason}</p>
				<Button href={blocked.open} target="_blank" rel="noopener noreferrer" size="sm">
					<iconify-icon icon="mdi:open-in-new"></iconify-icon> Open in new tab
				</Button>
				{#if command}
					<p class="dim">To show it here, map the port over HTTPS on this machine:</p>
					<div class="cmd">
						<code>{command}</code>
						<button type="button" class="icon" title="Copy command" aria-label="Copy command" onclick={() => copy(command)}>
							<iconify-icon icon="mdi:content-copy"></iconify-icon>
						</button>
					</div>
				{/if}
			</div>
		{:else if frameSrc && !verdict}
			<p class="msg dim">Checking {hostLabel(frameSrc)}…</p>
		{:else if frameSrc}
			{#key `${frameSrc}\0${reloads}`}
				<iframe src={frameSrc} title="Web preview" allow="clipboard-read; clipboard-write; fullscreen" onload={onFrameLoad}></iframe>
			{/key}
		{/if}
	</div>
</div>

<style>
	.web {
		height: 100%;
		display: flex;
		flex-direction: column;
		min-width: 0;
		color: #d6d3d1;
		font-size: 13px;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-bottom: 1px solid #222;
		flex: none;
	}
	.seg {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		border-radius: 8px;
		border: 1px solid #2a2a2a;
		background: #1a1a1a;
		flex: none;
	}
	.seg :global([data-slot='toggle']) {
		color: #a8a29e;
		height: 28px;
	}
	.seg :global([data-slot='toggle'][data-state='on']) {
		background: #e7e5e4;
		color: #0b0b0b;
	}
	.bar :global(.url) {
		flex: 1;
		min-width: 0;
		height: 34px;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.detected {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border-bottom: 1px solid #222;
		overflow-x: auto;
		flex: none;
		font-size: 11.5px;
		scrollbar-width: thin;
	}
	.label {
		color: #78716c;
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
		margin-right: 2px;
	}
	.detected :global(.chip) {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 9px;
		border-radius: 6px;
		border: 1px solid #2a2a2a;
		background: transparent;
		color: #a8a29e;
		font-family: var(--font-mono);
		font-size: 11.5px;
	}
	.detected :global(.chip[data-state='on']) {
		border-color: #3f3f46;
		background: #232326;
		color: #f5f5f4;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #34d399;
	}
	.proc {
		color: #78716c;
	}
	.view {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
	}
	iframe {
		flex: 1;
		width: 100%;
		height: 100%;
		border: 0;
		background: #fff;
	}
	.msg {
		margin: 0;
		padding: 16px 18px;
	}
	.empty {
		margin: auto;
		max-width: 420px;
		padding: 24px 20px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		text-align: center;
		line-height: 1.5;
	}
	.empty > iconify-icon {
		font-size: 30px;
		color: #57534e;
	}
	.empty h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: #e7e5e4;
		overflow-wrap: anywhere;
	}
	.empty p {
		margin: 0;
		color: #a8a29e;
	}
	code,
	pre {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	pre {
		margin: 0;
		padding: 8px 10px;
		border-radius: 6px;
		background: #1a1a1a;
		white-space: pre-wrap;
		color: #a8a29e;
		text-align: left;
	}
	.cmd {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		padding: 6px 6px 6px 10px;
		border-radius: 6px;
		border: 1px solid #2a2a2a;
		background: #1a1a1a;
		text-align: left;
	}
	.cmd code {
		color: #e7e5e4;
		overflow-wrap: anywhere;
	}
	.icon {
		flex: none;
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #a8a29e;
		cursor: pointer;
	}
	.icon:hover {
		background: #262626;
		color: #f5f5f4;
	}
	.dim {
		color: #78716c;
	}
	.err {
		color: #f87171;
	}
</style>
