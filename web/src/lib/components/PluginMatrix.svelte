<script lang="ts">
	import { Checkbox } from '$lib/components/ui/checkbox';
	import type { PluginComparison } from '$shared/fleet-plugins.js';
	import { shortHash } from '$lib/side-panel/history';

	/**
	 * The fleet's plugins side by side (`comparePlugins()` in
	 * `src/fleet-plugins.ts`): a column per machine, the marketplaces with the
	 * commit each machine is at and the plugins with the version each has.
	 * A cell a machine should fill and does not is drawn as a gap; a plugin can
	 * be marked "only here", a fleet preference, so its gaps stop counting.
	 * Rows where the machines agree are folded away until asked for.
	 */
	interface Props {
		comparison: PluginComparison;
		/** The columns, in the Machines view's order; a machine with no report shows as unknown. */
		machines: { id: string; name: string }[];
		onOnlyHere: (key: string, value: boolean) => void;
	}

	let { comparison, machines, onOnlyHere }: Props = $props();

	let showAll = $state(false);

	const known = $derived(machines.filter((m) => comparison.machines[m.id]));
	const differs = (on: Record<string, unknown>) => {
		const values = known.map((m) => JSON.stringify(on[m.id] ?? null));
		return new Set(values).size > 1;
	};
	const marketplaces = $derived(
		comparison.marketplaces.filter((r) => showAll || r.behind.length > 0 || differs(r.on))
	);
	const plugins = $derived(
		comparison.plugins.filter((r) => showAll || r.lacking.length > 0 || r.onlyHere || differs(r.on))
	);
	const hidden = $derived(
		comparison.marketplaces.length + comparison.plugins.length - marketplaces.length - plugins.length
	);

	const short = (sha: string | null) => (sha ? shortHash(sha) : '?');
</script>

<section class="plugins" aria-labelledby="plugins-h">
	<div class="head">
		<h2 id="plugins-h">Plugins</h2>
		{#if hidden > 0 || showAll}
			<button class="fold" onclick={() => (showAll = !showAll)}>
				{showAll ? 'Show only differences' : `Show ${hidden} that match`}
			</button>
		{/if}
	</div>

	{#if known.length === 0}
		<p class="empty">No machine has reported its plugins yet.</p>
	{:else if marketplaces.length === 0 && plugins.length === 0}
		<p class="empty">Every machine has the same plugins, and every marketplace is current.</p>
	{:else}
		<div class="scroll">
			<table style:--cols={machines.length}>
				<thead>
					<tr>
						<th class="label" scope="col"></th>
						{#each machines as m (m.id)}
							<th scope="col" class:unknown={!comparison.machines[m.id]}>{m.name}</th>
						{/each}
						<th class="only" scope="col">Only here</th>
					</tr>
				</thead>
				{#if marketplaces.length > 0}
					<tbody>
						<tr class="group"><th colspan={machines.length + 2} scope="rowgroup">Marketplaces</th></tr>
						{#each marketplaces as r (r.key)}
							<tr>
								<th class="label" scope="row">
									<span class="name">{r.name}</span>
									{#if r.repo}<span class="sub">{r.repo}</span>{/if}
								</th>
								{#each machines as m (m.id)}
									{@const at = r.on[m.id]}
									{@const unknown = !comparison.machines[m.id]}
									{@const behind = r.behind.includes(m.id)}
									<td class:behind class:unknown>
										{#if unknown}
											<span class="na">unknown</span>
										{:else if at}
											<code title={at.commit ?? 'Commit unknown'}>{short(at.commit)}</code>
											{#if behind}<span class="flag">behind {short(r.latest)}</span>{/if}
										{:else}
											<span class="na">not added</span>
										{/if}
									</td>
								{/each}
								<td></td>
							</tr>
						{/each}
					</tbody>
				{/if}
				{#if plugins.length > 0}
					<tbody>
						<tr class="group"><th colspan={machines.length + 2} scope="rowgroup">Plugins</th></tr>
						{#each plugins as r (r.key)}
							<tr class:quiet={r.onlyHere}>
								<th class="label" scope="row">
									<span class="name">{r.name}</span>
									<span class="sub">{r.marketplace}</span>
								</th>
								{#each machines as m (m.id)}
									{@const have = r.on[m.id]}
									{@const unknown = !comparison.machines[m.id]}
									{@const lacking = r.lacking.includes(m.id)}
									<td class:lacking class:unknown>
										{#if unknown}
											<span class="na">unknown</span>
										{:else if have}
											<code>{have.version ?? '?'}</code>
											{#if !have.enabled}<span class="flag">off</span>{/if}
										{:else if lacking}
											<span class="flag">missing</span>
										{:else}
											<span class="na">—</span>
										{/if}
									</td>
								{/each}
								<td class="only">
									<Checkbox
										checked={r.onlyHere}
										aria-label={`Only where ${r.name} is installed`}
										title="Wanted only where it is installed: its gaps stop counting"
										onCheckedChange={(v) => onOnlyHere(r.key, !!v)}
									/>
								</td>
							</tr>
						{/each}
					</tbody>
				{/if}
			</table>
		</div>
	{/if}
</section>

<style>
	.plugins {
		margin-top: 28px;
		padding-top: 16px;
		border-top: 1px solid var(--rail);
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 10px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.fold {
		margin-left: auto;
		background: none;
		border: 0;
		padding: 0;
		color: var(--ink-muted);
		font-size: 12px;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.fold:hover {
		color: var(--ink);
	}
	.empty {
		margin: 0;
		color: var(--ink-muted);
	}
	.scroll {
		overflow-x: auto;
		margin: 0 -4px;
	}
	table {
		border-collapse: collapse;
		min-width: 100%;
		font-size: 12.5px;
	}
	th,
	td {
		padding: 6px 10px;
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}
	thead th {
		color: var(--ink-muted);
		font-weight: 500;
		border-bottom: 1px solid var(--rail);
	}
	thead th.unknown {
		color: var(--ink-dim);
	}
	.group th {
		padding-top: 14px;
		color: var(--ink-dim);
		font-weight: 500;
		font-size: 12px;
	}
	.label {
		position: sticky;
		left: 0;
		background: var(--bg, #1c1b1a);
		min-width: 150px;
	}
	.label .name {
		display: block;
		color: var(--ink);
		font-weight: 500;
	}
	.label .sub {
		display: block;
		color: var(--ink-dim);
		font-size: 11.5px;
	}
	tbody tr:not(.group) {
		border-top: 1px solid color-mix(in oklch, var(--rail) 60%, transparent);
	}
	code {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink-muted);
	}
	.na {
		color: var(--ink-dim);
	}
	/* A gap the fleet wants filled: the cell itself is drawn hollow, so the
	   differences read across the table without reading every value. */
	td.lacking,
	td.behind {
		box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--bad) 55%, transparent);
		border-radius: 5px;
	}
	.flag {
		display: block;
		color: var(--bad);
		font-size: 11.5px;
	}
	td.lacking .flag:only-child {
		display: inline;
	}
	tr.quiet .label .name,
	tr.quiet code {
		color: var(--ink-dim);
	}
	.only {
		text-align: center;
		color: var(--ink-dim);
		font-weight: 400;
	}
</style>
