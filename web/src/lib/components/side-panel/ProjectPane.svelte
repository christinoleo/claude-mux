<script lang="ts">
	/**
	 * The project the session works in: the repo root (else the cwd), the
	 * branch, and the URLs named in the repo's `.claude-mux.json`. The
	 * simplest pane there is, shipped with the panel so the container has
	 * something to hold before the Changes, Files and Web panes arrive.
	 */
	import type { PaneBodyProps } from '$lib/side-panel/panes';

	interface ProjectInfo {
		root: string;
		repo: boolean;
		branch: string | null;
		config: { urls: Record<string, string> } | null;
		configError: string | null;
	}

	let { session, setActions, active }: PaneBodyProps = $props();

	let info = $state<ProjectInfo | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function load(id: string) {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/project`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			info = body as ProjectInfo;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	const sessionId = $derived(session?.id ?? null);
	// Read when first shown, and again whenever the session moves to another directory.
	const cwd = $derived(session?.cwd ?? null);
	$effect(() => {
		if (sessionId && cwd && active) void load(sessionId);
	});

	$effect(() => {
		setActions([
			{
				icon: 'mdi:refresh',
				label: 'Reload',
				disabled: !sessionId || loading,
				run: () => sessionId && void load(sessionId)
			}
		]);
	});

	const urls = $derived(Object.entries(info?.config?.urls ?? {}));
</script>

<div class="project">
	{#if error}
		<p class="err">{error}</p>
	{:else if !info}
		<p class="dim">Loading…</p>
	{:else}
		<dl>
			<dt>{info.repo ? 'Repository' : 'Directory'}</dt>
			<dd class="mono" title={info.root}>{info.root}</dd>
			<dt>Branch</dt>
			<dd class="mono">
				{#if info.branch}{info.branch}{:else if info.repo}<span class="dim">detached HEAD</span>{:else}<span
						class="dim">not a git repository</span
					>{/if}
			</dd>
			<dt>URLs</dt>
			<dd>
				{#if urls.length > 0}
					<ul>
						{#each urls as [name, url] (name)}
							<li>
								<span class="name">{name}</span>
								<a class="mono" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
							</li>
						{/each}
					</ul>
				{:else if info.configError}
					<span class="err">.claude-mux.json: {info.configError}</span>
				{:else}
					<span class="dim">
						None. Commit a <code>.claude-mux.json</code> at the root to name them:
					</span>
					<pre>{`{ "urls": { "prod": "https://…", "dev": "http://localhost:5173" } }`}</pre>
				{/if}
			</dd>
		</dl>
	{/if}
</div>

<style>
	.project {
		padding: 16px 18px;
		font-size: 13px;
		color: #d6d3d1;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 10px 16px;
		margin: 0;
	}
	dt {
		color: #78716c;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding-top: 2px;
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mono,
	code,
	pre {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	li {
		display: flex;
		gap: 10px;
		align-items: baseline;
		min-width: 0;
	}
	.name {
		color: #a8a29e;
		min-width: 3.5em;
	}
	a {
		color: #93c5fd;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	a:hover {
		text-decoration: underline;
	}
	pre {
		margin: 8px 0 0;
		padding: 8px 10px;
		border-radius: 6px;
		background: #1a1a1a;
		white-space: pre-wrap;
		color: #a8a29e;
	}
	.dim {
		color: #78716c;
	}
	.err {
		color: #f87171;
	}
</style>
