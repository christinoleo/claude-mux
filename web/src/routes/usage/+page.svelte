<script lang="ts">
	import { onMount } from 'svelte';
	import QuotaBars from '$lib/components/QuotaBars.svelte';
	import { compact, hostTimeZone, makeDayFormatter, money } from '$lib/format';
	import { totalTokens } from '../../../../src/usage/pricing.js';
	import type { FleetResponse, QuotaResult, UsageCell, UsageResponse } from '$lib/types/usage';

	/** What the API returns; `machines` only when the fleet route answered. */
	type UsagePayload = (UsageResponse | FleetResponse) & { windowDays: number };

	type Dimension = 'project' | 'model' | 'machine';
	type Split = Dimension | 'none';
	type Layout = 'stacked' | 'grouped';

	const RANGES = [
		{ label: '7d', days: 7 },
		{ label: '30d', days: 30 },
		{ label: '90d', days: 90 },
		{ label: 'All', days: 3650 }
	];

	/**
	 * Categorical slots in fixed order, stepped for the dark surface. A value
	 * takes its colour from its rank in the whole window, so filtering or
	 * changing the range never repaints the survivors.
	 */
	const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
	const OTHER_COLOR = '#6b6a63';
	const OTHER_KEY = '__other__';
	const ALL_KEY = '__all__';
	const TOP_SLOTS = SERIES.length;
	/** Beyond this the side-by-side bars are too thin to read. */
	const MAX_SPLIT_GROUPS = 4;

	let windowDays = $state(30);
	/** Fleet mode costs a discovery round trip, so it is opt-in. */
	let scope = $state<'local' | 'fleet'>('local');
	let colorBy = $state<Dimension>('project');
	let splitBy = $state<Split>('none');
	let layout = $state<Layout>('stacked');

	let data = $state<UsagePayload | null>(null);
	let quota = $state<QuotaResult | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let hovered = $state<string | null>(null);
	let scroller = $state<HTMLDivElement | null>(null);

	const zone = hostTimeZone();
	const dayOf = makeDayFormatter(zone);

	/**
	 * How each dimension is read off a cell and ranked.
	 *
	 * One table rather than a chain of `if`s per dimension: adding a fourth
	 * (session, git branch) means one entry here, and the selects, the colour
	 * assignment and the scope reset all pick it up.
	 */
	const DIMENSIONS: Record<
		Dimension,
		{
			label: string;
			keyOf: (cell: UsageCell) => string;
			rank: (data: UsagePayload) => { key: string; label: string }[];
		}
	> = {
		project: {
			label: 'Project',
			keyOf: (cell) => cell.project,
			rank: (d) => d.projects.map((p) => ({ key: p.key, label: p.label.split('/').pop() || p.label }))
		},
		model: {
			label: 'Model',
			keyOf: (cell) => cell.model,
			rank: (d) => d.models.map((m) => ({ key: m.model, label: m.model }))
		},
		machine: {
			label: 'Machine',
			keyOf: (cell) => cell.machine ?? '',
			rank: (d) => machinesOf(d).filter((m) => m.ok).map((m) => ({ key: m.hostname, label: m.hostname }))
		}
	};

	function machinesOf(payload: UsagePayload | null) {
		return payload && 'machines' in payload ? payload.machines : [];
	}

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			const path = scope === 'fleet' ? '/api/usage/all' : '/api/usage';
			const res = await fetch(`${path}?days=${windowDays}&tz=${encodeURIComponent(zone)}`);
			const body = (await res.json()) as UsagePayload & { error?: string };
			if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
			data = body;
		} catch (err) {
			error = err instanceof Error ? err.message : 'failed to load usage';
			data = null;
		} finally {
			loading = false;
		}
	}

	/** Account-level, so it is fetched and shown once — never summed. */
	async function loadQuota(): Promise<void> {
		try {
			const res = await fetch('/api/usage/quota');
			quota = res.ok
				? ((await res.json()) as QuotaResult)
				: { available: false, reason: 'unreachable' };
		} catch {
			quota = { available: false, reason: 'unreachable' };
		}
	}

	function refresh(): void {
		void load();
		void loadQuota();
	}

	onMount(refresh);

	function pick(days: number): void {
		windowDays = days;
		void load();
	}

	function pickScope(next: 'local' | 'fleet'): void {
		if (scope === next) return;
		scope = next;
		void load();
	}

	const machines = $derived(machinesOf(data));
	/** Dimensions that have values to show in the current report. */
	const available = $derived(
		(Object.keys(DIMENSIONS) as Dimension[]).filter(
			(dimension) => data !== null && DIMENSIONS[dimension].rank(data).length > 0
		)
	);

	/*
	 * A dimension can vanish when the report changes — machine disappears on
	 * leaving fleet mode. Falling back is generic rather than machine-specific.
	 */
	$effect(() => {
		if (data === null) return;
		if (!available.includes(colorBy)) colorBy = 'project';
		if (splitBy !== 'none' && !available.includes(splitBy)) splitBy = 'none';
	});

	/** Splitting by the dimension already carrying colour would say nothing. */
	const split = $derived<Split>(splitBy === colorBy ? 'none' : splitBy);

	function ranking(dimension: Dimension): { key: string; label: string }[] {
		return data === null ? [] : DIMENSIONS[dimension].rank(data);
	}

	/** The coloured values, in rank order, with the tail folded into one. */
	const legend = $derived.by(() => {
		const entries = ranking(colorBy);
		const shown = entries.slice(0, TOP_SLOTS).map((entry, i) => ({
			key: entry.key,
			label: entry.label,
			color: SERIES[i]
		}));
		if (entries.length > TOP_SLOTS) {
			shown.push({ key: OTHER_KEY, label: 'Other', color: OTHER_COLOR });
		}
		return shown;
	});

	/** Colour for every value, including the ones the legend folds away. */
	const colors = $derived.by(() => {
		const map = new Map<string, string>();
		ranking(colorBy).forEach((entry, i) => {
			map.set(entry.key, i < TOP_SLOTS ? SERIES[i] : OTHER_COLOR);
		});
		return map;
	});

	/** Split groups, in rank order so a bar's position always means the same thing. */
	const splitGroups = $derived.by(() => {
		if (split === 'none') return [{ key: ALL_KEY, label: '' }];
		const entries = ranking(split);
		const shown = entries.slice(0, MAX_SPLIT_GROUPS);
		return entries.length > MAX_SPLIT_GROUPS
			? [...shown, { key: OTHER_KEY, label: 'Other' }]
			: shown;
	});

	interface Segment {
		key: string;
		label: string;
		color: string;
		costUsd: number;
	}
	interface Bar {
		key: string;
		total: number;
		segments: Segment[];
	}
	interface Group {
		key: string;
		label: string;
		bars: Bar[];
	}
	interface Column {
		date: string;
		costUsd: number;
		groups: Group[];
	}

	/**
	 * Every day in the window, including the empty ones the server omits — the
	 * gaps are what make a week's rhythm readable.
	 */
	const columns = $derived.by((): Column[] => {
		if (!data) return [];
		const byDate = new Map(data.days.map((d) => [d.date, d]));
		const series = new Map(legend.map((entry) => [entry.key, entry]));
		const splitAllowed = new Set(splitGroups.map((group) => group.key));
		const colorOf = DIMENSIONS[colorBy].keyOf;
		const splitOf = split === 'none' ? null : DIMENSIONS[split].keyOf;

		const span = Math.min(windowDays, 180);
		const out: Column[] = [];
		for (let i = span - 1; i >= 0; i--) {
			const date = dayOf(Date.now() - i * 86_400_000);
			const day = byDate.get(date);

			// group key -> colour key -> cost
			const grid = new Map<string, Map<string, number>>();
			for (const cell of day?.cells ?? []) {
				const rawGroup = splitOf === null ? ALL_KEY : splitOf(cell);
				const groupKey = splitAllowed.has(rawGroup) ? rawGroup : OTHER_KEY;
				const rawColor = colorOf(cell);
				const colorKey = series.has(rawColor) ? rawColor : OTHER_KEY;
				let row = grid.get(groupKey);
				if (!row) {
					row = new Map();
					grid.set(groupKey, row);
				}
				row.set(colorKey, (row.get(colorKey) ?? 0) + cell.costUsd);
			}

			const groups: Group[] = splitGroups.map((group) => {
				const segments: Segment[] = [...(grid.get(group.key) ?? [])]
					.map(([key, costUsd]) => ({
						key,
						label: series.get(key)?.label ?? 'Other',
						color: series.get(key)?.color ?? OTHER_COLOR,
						costUsd
					}))
					.sort((a, b) => b.costUsd - a.costUsd);

				// Stacked puts every colour in one bar; grouped gives each its own.
				const stacks = layout === 'stacked' ? [segments] : segments.map((s) => [s]);
				return {
					key: group.key,
					label: group.label,
					bars: stacks
						.filter((stack) => stack.length > 0)
						.map((stack) => ({
							key: layout === 'stacked' ? group.key : stack[0].key,
							total: stack.reduce((sum, s) => sum + s.costUsd, 0),
							segments: stack
						}))
				};
			});
			out.push({ date, costUsd: day?.costUsd ?? 0, groups });
		}
		return out;
	});

	/** One shared scale across every bar drawn — never a second axis. */
	const peak = $derived(
		Math.max(1e-9, ...columns.flatMap((c) => c.groups.flatMap((g) => g.bars.map((b) => b.total))))
	);

	/**
	 * Bars in the busiest day. Two splits over a long range produce more bars
	 * than fit, so each column claims a floor width and the chart scrolls
	 * rather than shaving every bar down to an unreadable sliver.
	 */
	const barsPerColumn = $derived(
		Math.max(1, ...columns.map((c) => c.groups.reduce((n, g) => n + Math.max(1, g.bars.length), 0)))
	);
	const minColumnPx = $derived(Math.max(4, barsPerColumn * 6));

	/** Label roughly eight dates, whatever the range, and always the newest. */
	const labelStride = $derived(Math.max(1, Math.ceil(columns.length / 8)));

	/**
	 * The newest day is the one being asked about, so a chart wider than its
	 * container opens at the right edge rather than a month in the past.
	 */
	$effect(() => {
		void columns;
		void minColumnPx;
		const element = scroller;
		if (!element) return;
		requestAnimationFrame(() => {
			if (element.scrollWidth > element.clientWidth) element.scrollLeft = element.scrollWidth;
		});
	});

	const activeDays = $derived(columns.filter((c) => c.costUsd > 0).length);
	const hoveredColumn = $derived(columns.find((c) => c.date === hovered) ?? null);

	function shortDate(date: string): string {
		return date.slice(5).replace('-', '/');
	}

	/** A path's leading directories, kept as the part that may be elided. */
	function dirOf(path: string): string {
		const cut = path.lastIndexOf('/');
		return cut <= 0 ? '' : path.slice(0, cut + 1);
	}

	function baseOf(path: string): string {
		const cut = path.lastIndexOf('/');
		return cut < 0 ? path : path.slice(cut + 1);
	}

	const tokens = $derived(data ? totalTokens(data.totals) : 0);
</script>

<svelte:head><title>Usage · claude-mux</title></svelte:head>

<div class="usage">
	<header class="toolbar">
		<h1>Usage</h1>
		<div class="segmented">
			<button class:active={scope === 'local'} onclick={() => pickScope('local')}>
				This machine
			</button>
			<button class:active={scope === 'fleet'} onclick={() => pickScope('fleet')}>
				All machines
			</button>
		</div>
		<div class="segmented">
			{#each RANGES as range (range.days)}
				<button class:active={windowDays === range.days} onclick={() => pick(range.days)}>
					{range.label}
				</button>
			{/each}
		</div>
		<button class="refresh" onclick={refresh} aria-label="Refresh" disabled={loading}>
			<iconify-icon icon="mdi:refresh" class={loading ? 'spin' : ''}></iconify-icon>
		</button>
	</header>

	{#if error}
		<p class="notice error">{error}</p>
	{:else if !data && loading}
		<p class="notice">Reading transcripts…</p>
	{:else if data}
		<p class="caveat">
			API-equivalent cost of the tokens in your local transcripts. A subscription is not billed
			this way — use it to compare projects and models, not to reconcile an invoice.
		</p>

		{#if quota}
			<section class="panel quota-panel">
				<h2>
					Plan limits{#if quota.available && quota.subscriptionType}
						<span class="plan">{quota.subscriptionType}</span>
					{/if}
				</h2>
				<QuotaBars {quota} />
			</section>
		{/if}

		<section class="tiles">
			<div class="tile hero">
				<span class="tile-label">Total cost</span>
				<strong class="tile-value">{money(data.costUsd)}</strong>
				<span class="tile-note">{data.records.toLocaleString()} responses · {data.sessions} sessions</span>
			</div>
			<div class="tile">
				<span class="tile-label">Tokens</span>
				<strong class="tile-value">{compact(tokens)}</strong>
				<span class="tile-note">{compact(data.totals.cacheRead)} from cache</span>
			</div>
			<div class="tile">
				<span class="tile-label">Cache savings</span>
				<strong class="tile-value">{money(data.cacheSavingsUsd)}</strong>
				<span class="tile-note">vs. uncached input</span>
			</div>
			<div class="tile">
				<span class="tile-label">Active days</span>
				<strong class="tile-value">{activeDays}</strong>
				<span class="tile-note">of {columns.length}</span>
			</div>
		</section>

		<section class="panel">
			<div class="controls">
				<h2>Cost per day</h2>
				<label>
					<span>Colour</span>
					<select bind:value={colorBy}>
						{#each available as dimension (dimension)}
							<option value={dimension}>{DIMENSIONS[dimension].label}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Split</span>
					<select bind:value={splitBy}>
						<option value="none">None</option>
						{#each available as dimension (dimension)}
							<option value={dimension} disabled={colorBy === dimension}>
								{DIMENSIONS[dimension].label}
							</option>
						{/each}
					</select>
				</label>
				<div class="segmented">
					<button class:active={layout === 'stacked'} onclick={() => (layout = 'stacked')}>
						Stacked
					</button>
					<button class:active={layout === 'grouped'} onclick={() => (layout = 'grouped')}>
						Grouped
					</button>
				</div>
			</div>

			<ul class="legend">
				{#each legend as item (item.key)}
					<li><span class="swatch" style="background: {item.color}"></span>{item.label}</li>
				{/each}
			</ul>

			{#if split !== 'none'}
				<p class="hint">
					Each day holds one bar per {split}, always in this order:
					{#each splitGroups as group, i (group.key)}<span class="ord"
							>{i + 1}. {group.label}</span
						>{/each}
				</p>
			{/if}

			<div class="chart" role="img" aria-label="Cost per day">
				<div class="grid">
					{#each [1, 0.5] as fraction (fraction)}
						<div class="grid-line" style="bottom: {fraction * 100}%">
							<span>{money(peak * fraction)}</span>
						</div>
					{/each}
					<div class="grid-line" style="bottom: 0"></div>
				</div>
				<div class="scroller" bind:this={scroller}>
				<div class="plot" style="--min-column: {minColumnPx}px">
				<div class="bars">
					{#each columns as column (column.date)}
						<div
							class="column"
							class:dim={hovered !== null && hovered !== column.date}
							onmouseenter={() => (hovered = column.date)}
							onmouseleave={() => (hovered = null)}
							role="presentation"
						>
							{#each column.groups as group (group.key)}
								<div class="group">
									{#each group.bars as bar (bar.key)}
										<div class="bar" style="height: {(bar.total / peak) * 100}%">
											{#each bar.segments as segment (segment.key)}
												<div
													class="segment"
													style="flex-grow: {segment.costUsd}; background: {segment.color}"
												></div>
											{/each}
										</div>
									{/each}
								</div>
							{/each}
						</div>
					{/each}
				</div>
				<div class="axis">
					{#each columns as column, i (column.date)}
						<span class="axis-cell">
							{#if (columns.length - 1 - i) % labelStride === 0}
								<span class="tick">{shortDate(column.date)}</span>
							{/if}
						</span>
					{/each}
				</div>
				</div>
				</div>
			</div>

			{#if hoveredColumn}
				<div class="tooltip">
					<strong>{hoveredColumn.date}</strong>
					<span class="tooltip-total">{money(hoveredColumn.costUsd)}</span>
					{#each hoveredColumn.groups as group (group.key)}
						{#if group.bars.length > 0}
							{#if split !== 'none'}
								<span class="tooltip-group">{group.label || 'Other'}</span>
							{/if}
							{#each group.bars as bar (bar.key)}
								{#each bar.segments as segment (segment.key)}
									<span class="tooltip-row">
										<span class="swatch" style="background: {segment.color}"></span>
										{segment.label}
										<span class="tooltip-value">{money(segment.costUsd)}</span>
									</span>
								{/each}
							{/each}
						{/if}
					{/each}
				</div>
			{/if}
		</section>

		<div class="tables">
			<section class="panel">
				<h2>Projects</h2>
				<table>
					<colgroup><col /><col class="cost" /><col class="tokens" /></colgroup>
					<thead><tr><th>Project</th><th>Cost</th><th>Tokens</th></tr></thead>
					<tbody>
						{#each data.projects as project (project.key)}
							<tr>
								<td class="name">
									{#if colorBy === 'project'}
										<span class="swatch" style="background: {colors.get(project.key) ?? OTHER_COLOR}"></span>
									{/if}
									<span class="path" title={project.label}
										><span class="dir truncate">{dirOf(project.label)}</span><span class="base"
											>{baseOf(project.label)}</span
										></span
									>
								</td>
								<td class="num">{money(project.costUsd)}</td>
								<td class="num muted">{compact(project.tokens)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>

			<section class="panel">
				<h2>Models</h2>
				<table>
					<colgroup><col /><col class="cost" /><col class="tokens" /></colgroup>
					<thead><tr><th>Model</th><th>Cost</th><th>Tokens</th></tr></thead>
					<tbody>
						{#each data.models as model (model.model)}
							<tr>
								<td class="name">
									{#if colorBy === 'model'}
										<span class="swatch" style="background: {colors.get(model.model) ?? OTHER_COLOR}"></span>
									{/if}
									<span class="truncate" title={model.model}>{model.model}</span>
									{#if !model.priced}<span class="tag">unpriced</span>{/if}
								</td>
								<td class="num">{money(model.costUsd)}</td>
								<td class="num muted">{compact(model.tokens)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		</div>

		{#if machines.length > 0}
			<p class="machines">
				{#each machines as machine (machine.hostname)}
					<span class="machine" class:down={!machine.ok}>
						<iconify-icon icon={machine.ok ? 'mdi:check-circle-outline' : 'mdi:alert-outline'}
						></iconify-icon>
						{machine.hostname}
						{#if !machine.ok}<span class="why">{machine.error ?? 'unreachable'}</span>{/if}
					</span>
				{/each}
				{#if machines.some((m) => !m.ok)}
					<span class="why">— totals exclude the machines that did not answer</span>
				{/if}
			</p>
		{/if}

		<footer class="meta">
			<span>Rates: {data.rates.source}</span>
			<span>Zone: {data.timeZone}</span>
			<span>{data.scan.filesReused} cached · {data.scan.filesParsed} parsed</span>
			{#if data.scan.crossFileDuplicates > 0}
				<span class="warn">
					{data.scan.crossFileDuplicates} cross-file duplicates dropped — cost may be overstated
				</span>
			{/if}
		</footer>
	{/if}
</div>

<style>
	.usage {
		--surface: #1a1a19;
		--ink: #f5f5f4;
		--ink-muted: #a8a29e;
		--line: rgba(255, 255, 255, 0.09);
		padding: 16px 20px 40px;
		max-width: 1100px;
		margin: 0 auto;
		color: var(--ink);
		font-size: 13px;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 8px;
		/* Two segmented groups plus a title do not fit a phone on one line. */
		flex-wrap: wrap;
	}

	h1 {
		font-size: 18px;
		font-weight: 600;
		margin: 0;
		flex: 1;
	}

	h2 {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-muted);
		margin: 0;
	}

	.segmented {
		display: flex;
		gap: 2px;
		background: rgba(255, 255, 255, 0.05);
		border-radius: 6px;
		padding: 2px;
	}

	.segmented button {
		border: 0;
		background: transparent;
		color: var(--ink-muted);
		padding: 4px 10px;
		border-radius: 4px;
		font-size: 12px;
		cursor: pointer;
	}

	.segmented button.active {
		background: rgba(255, 255, 255, 0.12);
		color: var(--ink);
	}

	.refresh {
		border: 0;
		background: transparent;
		color: var(--ink-muted);
		cursor: pointer;
		display: flex;
		padding: 4px;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 10px;
	}

	.controls h2 {
		margin-right: auto;
	}

	.controls label {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--ink-muted);
	}

	.controls select {
		background: rgba(255, 255, 255, 0.06);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 3px 6px;
		font-size: 12px;
	}

	.caveat {
		color: var(--ink-muted);
		margin: 0 0 16px;
		max-width: 68ch;
		line-height: 1.5;
	}

	.notice {
		color: var(--ink-muted);
		padding: 24px 0;
	}

	.notice.error {
		color: #e66767;
	}

	.quota-panel h2 {
		margin-bottom: 10px;
	}

	.plan {
		margin-left: 6px;
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 3px;
		padding: 0 5px;
		font-size: 10px;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
		margin-bottom: 16px;
	}

	.tile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.tile-label {
		color: var(--ink-muted);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.tile-value {
		font-size: 22px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.tile.hero .tile-value {
		font-size: 32px;
	}

	.tile-note {
		color: var(--ink-muted);
		font-size: 11px;
	}

	.panel {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 14px;
		margin-bottom: 12px;
		position: relative;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		font-size: 11px;
		color: var(--ink-muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		display: inline-block;
		flex: none;
	}

	.hint {
		font-size: 11px;
		color: var(--ink-muted);
		margin: 0 0 8px;
	}

	.hint .ord {
		margin-left: 8px;
	}

	.chart {
		position: relative;
		height: 216px;
	}

	.grid {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 16px;
		pointer-events: none;
		z-index: 1;
	}

	.scroller {
		position: absolute;
		inset: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.grid-line {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid var(--line);
	}

	.grid-line span {
		position: absolute;
		right: 0;
		top: 2px;
		font-size: 10px;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
		background: var(--surface);
		padding-left: 4px;
	}

	.plot {
		height: 100%;
		min-width: 100%;
		display: flex;
		flex-direction: column;
	}

	.bars {
		flex: 1;
		display: flex;
		align-items: flex-end;
		gap: 3px;
		min-height: 0;
	}

	.column {
		flex: 1 0 var(--min-column, 4px);
		height: 100%;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		gap: 2px;
		min-width: 2px;
		transition: opacity 120ms;
	}

	.column.dim {
		opacity: 0.35;
	}

	.group {
		flex: 1;
		height: 100%;
		display: flex;
		align-items: flex-end;
		gap: 1px;
		min-width: 1px;
	}

	.bar {
		flex: 1;
		display: flex;
		flex-direction: column-reverse;
		gap: 2px;
		min-height: 1px;
		min-width: 1px;
		border-radius: 4px 4px 0 0;
		overflow: hidden;
	}

	.segment {
		width: 100%;
		flex-basis: 0;
		min-height: 1px;
	}

	.axis {
		display: flex;
		gap: 3px;
		height: 16px;
		/* Cells hold only an absolutely positioned tick, so they would collapse
		   to zero height and centre themselves — putting the label half below
		   the row, where the scroller clips it. */
		align-items: stretch;
		font-size: 10px;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	.axis-cell {
		flex: 1 0 var(--min-column, 4px);
		min-width: 0;
		position: relative;
	}

	/*
	 * Ticks are taken out of flow deliberately. A label is far wider than the
	 * day it marks, and in flow it both widens its own cell — pushing the axis
	 * out of step with the bars — and counts toward the scroller's scrollWidth,
	 * which manufactures a scrollbar on a chart that fits. Absolute keeps the
	 * axis exactly as wide as the bars above it.
	 */
	.tick {
		position: absolute;
		top: 0;
		left: 0;
		white-space: nowrap;
	}

	/* The newest day has nothing to its right to overhang into. */
	.axis-cell:last-child .tick {
		left: auto;
		right: 0;
	}

	.tooltip {
		position: absolute;
		top: 10px;
		left: 14px;
		background: #0b0b0a;
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 11px;
		pointer-events: none;
		min-width: 170px;
		max-height: 180px;
		overflow: hidden;
	}

	.tooltip-total {
		font-size: 15px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.tooltip-group {
		color: var(--ink);
		font-weight: 600;
		margin-top: 3px;
	}

	.tooltip-row {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--ink-muted);
	}

	.tooltip-value {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
	}

	.tables {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	table {
		width: 100%;
		table-layout: fixed;
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
	}

	/* Fixed layout keeps a long path from widening the page itself. */
	col.cost {
		width: 84px;
	}

	col.tokens {
		width: 64px;
	}

	th {
		text-align: left;
		font-weight: 500;
		font-size: 11px;
		color: var(--ink-muted);
		padding: 8px 0 6px;
		border-bottom: 1px solid var(--line);
	}

	th:not(:first-child) {
		text-align: right;
	}

	td {
		padding: 5px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.04);
	}

	td.name {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 99%;
	}

	.truncate {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	/*
	 * Paths share a long prefix and differ at the end, so the directories are
	 * what gets elided and the basename always survives. Splitting the two
	 * beats the `direction: rtl` trick, which reorders the leading slash and
	 * is undone by the `unicode-bidi` value needed to keep the text readable.
	 */
	.path {
		display: flex;
		min-width: 0;
	}

	.path .dir {
		color: var(--ink-muted);
	}

	.path .base {
		flex: none;
		white-space: nowrap;
	}

	td.num {
		text-align: right;
		white-space: nowrap;
		padding-left: 10px;
	}

	td.muted {
		color: var(--ink-muted);
	}

	.tag {
		font-size: 10px;
		color: var(--ink-muted);
		border: 1px solid var(--line);
		border-radius: 3px;
		padding: 0 4px;
		flex: none;
	}

	.machines {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		font-size: 11px;
		color: var(--ink-muted);
		margin: 0 0 6px;
	}

	.machine {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.machine.down {
		color: #fab219;
	}

	.why {
		color: var(--ink-muted);
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		font-size: 11px;
		color: var(--ink-muted);
		margin-top: 4px;
	}

	.meta .warn {
		color: #c98500;
	}

	@media (max-width: 720px) {
		.usage {
			padding: 12px 12px 32px;
		}

		/* The heading takes the first row on its own; the controls share the next. */
		h1 {
			flex: none;
		}

		.toolbar .segmented {
			flex: 1;
		}

		.toolbar .segmented button {
			flex: 1;
			white-space: nowrap;
		}

		.tables {
			grid-template-columns: 1fr;
		}

		.tile.hero .tile-value {
			font-size: 26px;
		}

		.controls h2 {
			width: 100%;
			margin-right: 0;
		}

		.tooltip {
			left: 14px;
			right: 14px;
		}
	}
</style>
