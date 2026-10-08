<script lang="ts">
	/**
	 * The side panel's header and its panes. One pane shows at a time, but a
	 * pane stays mounted once opened (hidden, not destroyed), so its scroll
	 * and selection survive switching to another and back. Whether this sits
	 * in a column beside the session or in a sheet over it is the page's call.
	 */
	import type { Session } from '$lib/stores/sessions.svelte';
	import { PANES, paneDef, MAXIMIZE_KEYS, CLOSE_KEYS, type PaneAction } from '$lib/side-panel/panes';
	import { readPaneParams } from '$lib/side-panel/url';
	import Hint from '$lib/components/Hint.svelte';

	let {
		kind,
		open,
		target,
		session,
		query,
		maximized,
		canMaximize,
		onSetParams,
		onToggleMaximize,
		onClose,
		onMention
	}: {
		/** The pane showing. */
		kind: string;
		/** False while the column is closed but kept mounted: no pane is active then. */
		open: boolean;
		target: string;
		session: Session | null;
		/** The page's query, for the params each pane owns. */
		query: URLSearchParams;
		maximized: boolean;
		/** Maximize applies to the inline column; a sheet has nothing to grow into. */
		canMaximize: boolean;
		onSetParams: (kind: string, own: Record<string, string | null>, opts?: { push?: boolean }) => void;
		onToggleMaximize: () => void;
		onClose: () => void;
		onMention: (text: string) => void;
	} = $props();

	let mounted = $state<string[]>([]);
	$effect(() => {
		if (!mounted.includes(kind)) mounted = [...mounted, kind];
	});

	let actions = $state<Record<string, PaneAction[]>>({});

	const def = $derived(paneDef(kind));
</script>

<div class="panel">
	<header>
		{#if def}
			<iconify-icon icon={def.icon}></iconify-icon>
			<h2>{def.label}</h2>
		{/if}
		<span class="sp"></span>
		{#each actions[kind] ?? [] as action (action.label)}
			<button
				type="button"
				class="act"
				class:on={action.pressed}
				aria-pressed={action.pressed}
				disabled={action.disabled}
				title={action.label}
				aria-label={action.label}
				onclick={action.run}
			>
				<iconify-icon icon={action.icon}></iconify-icon>
			</button>
		{/each}
		{#if canMaximize}
			<Hint
				icon={maximized ? 'mdi:arrow-collapse' : 'mdi:arrow-expand'}
				label={maximized ? 'Restore' : 'Maximize'}
				keys={MAXIMIZE_KEYS}
				class="act"
				onclick={onToggleMaximize}
			/>
		{/if}
		<Hint icon="mdi:close" label="Close panel" keys={CLOSE_KEYS} class="act" onclick={onClose} />
	</header>
	<div class="bodies">
		{#each PANES.filter((p) => mounted.includes(p.kind)) as pane (pane.kind)}
			<!-- Hidden by visibility rather than display, which would lose its scroll. -->
			<div class="body" class:off={pane.kind !== kind} inert={pane.kind !== kind}>
				<pane.body
					{session}
					{target}
					params={readPaneParams(query, pane.params)}
					setParams={(own, opts) => onSetParams(pane.kind, own, opts)}
					setActions={(list) => (actions[pane.kind] = list)}
					active={open && pane.kind === kind}
					mention={onMention}
				/>
			</div>
		{/each}
	</div>
</div>

<style>
	.panel {
		height: 100%;
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: #111111;
		color: #e7e5e4;
	}
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 6px 8px 6px 14px;
		border-bottom: 1px solid #222;
		flex: none;
	}
	header > iconify-icon {
		font-size: 16px;
		color: #a8a29e;
	}
	h2 {
		margin: 0;
		font-size: 13.5px;
		font-weight: 600;
	}
	.sp {
		flex: 1;
	}
	header :global(.act) {
		width: 30px;
		height: 30px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: #a8a29e;
		font-size: 16px;
		cursor: pointer;
	}
	header :global(.act:hover:not(:disabled)) {
		background: #1f1f1f;
		color: #f5f5f4;
	}
	header :global(.act:disabled) {
		opacity: 0.4;
		cursor: default;
	}
	header :global(.act.on) {
		background: #232326;
		color: #f5f5f4;
	}
	.bodies {
		flex: 1;
		min-height: 0;
		position: relative;
	}
	.body {
		position: absolute;
		inset: 0;
		overflow: auto;
	}
	.body.off {
		visibility: hidden;
	}
</style>
