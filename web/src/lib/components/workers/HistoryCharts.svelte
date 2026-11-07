<script lang="ts">
	import type { RunResult } from '$shared/server/worker-queue.js';
	import { RESULTS, minutes, type HistoryDay } from '$lib/workers';

	/**
	 * Workers finished per day, stacked by how they ended, and the median wait
	 * in the queue per day. One scale each; a hover names the day's numbers.
	 */
	interface Props {
		days: HistoryDay[];
	}
	let { days }: Props = $props();

	const COLOR: Record<RunResult, string> = {
		merged: 'var(--w-bar-ok)',
		help: 'var(--w-bar-want)',
		lost: 'var(--w-bar-bad)',
		stopped: 'var(--w-bar-other)',
		closed: 'var(--w-bar-other)'
	};
	/** Stopped and closed share one grey: both are a person's choice, not the worker's result. */
	const STACK: RunResult[] = ['merged', 'help', 'lost', 'stopped', 'closed'];
	const LEGEND = RESULTS.filter((r) => r.result !== 'closed');

	const H = 170;
	const L = 26;
	const B = 22;
	let barsWidth = $state(0);
	let lineWidth = $state(0);
	let barTip = $state<number | null>(null);
	let lineTip = $state<number | null>(null);

	const label = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	const total = (d: HistoryDay) => STACK.reduce((a, k) => a + d.counts[k], 0);

	function niceTop(max: number, unit: number): number {
		return Math.max(unit, Math.ceil(max / unit) * unit);
	}
	function ticks(top: number): number[] {
		const stepBy = top <= 10 ? 5 : top <= 20 ? 10 : top <= 60 ? 20 : Math.ceil(top / 3 / 10) * 10;
		const out: number[] = [];
		for (let v = 0; v <= top; v += stepBy) out.push(v);
		return out;
	}

	const barTop = $derived(niceTop(Math.max(0, ...days.map(total)), 5));
	const step = $derived(days.length ? (barsWidth - L) / days.length : 0);
	const bw = $derived(Math.max(2, step - 2));
	const barY = (v: number) => (v / barTop) * (H - B - 8);

	const bars = $derived(
		days.map((d, i) => {
			let base = H - B;
			const x = L + i * step + 1;
			const rects: { y: number; h: number; color: string }[] = [];
			for (const k of STACK) {
				const n = d.counts[k];
				if (!n) continue;
				const h = barY(n);
				// A 2px gap of surface between stacked parts.
				rects.push({ y: base - h, h: Math.max(1, h - 2), color: COLOR[k] });
				base -= h;
			}
			return { x, rects };
		})
	);

	const waits = $derived(days.map((d) => d.medianWait));
	const lineTop = $derived(niceTop(Math.max(0, ...waits.map((w) => w ?? 0)), 10));
	const lineX = (i: number) => L + (days.length > 1 ? (i / (days.length - 1)) * (lineWidth - L - 8) : 0);
	const lineY = (v: number) => H - B - (v / lineTop) * (H - B - 8);
	/** Runs of days with a wait; a day nobody started breaks the line rather than drawing it to zero. */
	const segments = $derived.by(() => {
		const out: string[] = [];
		let cur: string[] = [];
		waits.forEach((w, i) => {
			if (w === null) {
				if (cur.length) out.push(cur.join(' '));
				cur = [];
			} else cur.push(`${lineX(i)},${lineY(w)}`);
		});
		if (cur.length) out.push(cur.join(' '));
		return out;
	});
	const lastWait = $derived(waits.findLastIndex((w) => w !== null));
	/** A day with a wait between two without: a line of one point draws nothing, so it gets a dot. */
	const lonely = (i: number) => waits[i] !== null && (waits[i - 1] ?? null) === null && (waits[i + 1] ?? null) === null;
	const dayTicks = $derived(days.length ? [0, Math.floor(days.length / 2), days.length - 1] : []);

	function nearest(ev: PointerEvent, xs: number[]): number {
		const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
		const x = ev.clientX - r.left;
		let best = 0;
		xs.forEach((v, i) => {
			if (Math.abs(v - x) < Math.abs(xs[best] - x)) best = i;
		});
		return best;
	}
	const tipLeft = (x: number, width: number) => Math.max(0, Math.min(width - 150, x - 75));
</script>

<div class="charts">
	<figure>
		<figcaption>Workers finished per day</figcaption>
		<div class="legend">
			{#each LEGEND as r (r.result)}
				<span><i style:background={COLOR[r.result]}></i>{r.mark} {r.result === 'stopped' ? 'Stopped or closed' : r.label}</span>
			{/each}
		</div>
		<div
			class="chart"
			role="presentation"
			bind:clientWidth={barsWidth}
			onpointermove={(ev) => (barTip = nearest(ev, bars.map((b) => b.x + bw / 2)))}
			onpointerleave={() => (barTip = null)}
		>
			{#if barsWidth > 0}
				<svg role="img" aria-label="Workers finished per day, last {days.length} days" width={barsWidth} height={H}>
					{#each ticks(barTop) as v (v)}
						<line x1={L} x2={barsWidth} y1={H - B - barY(v)} y2={H - B - barY(v)} stroke="var(--w-line)" />
						<text x={L - 6} y={H - B - barY(v) + 4} text-anchor="end">{v}</text>
					{/each}
					{#each bars as b, i (i)}
						{#each b.rects as r, j (j)}
							<rect x={b.x} y={r.y} width={bw} height={r.h} rx="1.5" fill={r.color} opacity={barTip === null || barTip === i ? 1 : 0.55} />
						{/each}
					{/each}
					{#each dayTicks as i (i)}
						<text x={Math.min(barsWidth - 40, L + i * step)} y={H - 6}>{label(days[i].start)}</text>
					{/each}
				</svg>
			{/if}
			{#if barTip !== null && days[barTip]}
				{@const d = days[barTip]}
				<div class="tip" style:left="{tipLeft(bars[barTip].x, barsWidth)}px">
					<b>{label(d.start)}</b>
					{#each RESULTS as r (r.result)}
						{#if r.result === 'merged' || r.result === 'help' || r.result === 'lost' || d.counts[r.result]}
							<br />{r.mark} {d.counts[r.result]} {r.label.toLowerCase()}
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</figure>
	<figure>
		<figcaption>Median wait in the queue, minutes</figcaption>
		<div class="legend"><span>Time from ready to started</span></div>
		<div
			class="chart"
			role="presentation"
			bind:clientWidth={lineWidth}
			onpointermove={(ev) => (lineTip = nearest(ev, days.map((_, i) => lineX(i))))}
			onpointerleave={() => (lineTip = null)}
		>
			{#if lineWidth > 0}
				<svg role="img" aria-label="Median queue wait in minutes, last {days.length} days" width={lineWidth} height={H}>
					{#each ticks(lineTop) as v (v)}
						<line x1={L} x2={lineWidth} y1={lineY(v)} y2={lineY(v)} stroke="var(--w-line)" />
						<text x={L - 6} y={lineY(v) + 4} text-anchor="end">{v}</text>
					{/each}
					{#each segments as pts, i (i)}
						<polyline points={pts} fill="none" stroke="var(--w-ink-2)" stroke-width="2" stroke-linejoin="round" />
					{/each}
					{#each waits as w, i (i)}
						{#if w !== null && (lineTip === i || i === lastWait || lonely(i))}
							<circle cx={lineX(i)} cy={lineY(w)} r="4" fill="var(--w-ink)" stroke="var(--w-raised)" stroke-width="2" />
						{/if}
					{/each}
					{#if lineTip !== null}
						<line x1={lineX(lineTip)} x2={lineX(lineTip)} y1="8" y2={H - B} stroke="var(--w-ink-3)" stroke-dasharray="2 3" />
					{/if}
					{#each dayTicks as i (i)}
						<text x={Math.min(lineWidth - 40, lineX(i))} y={H - 6}>{label(days[i].start)}</text>
					{/each}
				</svg>
			{/if}
			{#if lineTip !== null && days[lineTip]}
				{@const d = days[lineTip]}
				<div class="tip" style:left="{tipLeft(lineX(lineTip), lineWidth)}px">
					<b>{label(d.start)}</b><br />
					{d.medianWait === null ? 'Nothing started' : `${minutes(d.medianWait)} median wait`}
				</div>
			{/if}
		</div>
	</figure>
</div>

<style>
	.charts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
	}
	figure {
		min-width: 0;
		margin: 0;
		padding: 12px;
		border: 1px solid var(--w-line);
		border-radius: 8px;
	}
	figcaption {
		margin-bottom: 2px;
		font-weight: 500;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin-bottom: 6px;
		color: var(--w-ink-2);
		font-size: 12px;
	}
	.legend i {
		display: inline-block;
		width: 10px;
		height: 10px;
		margin-right: 5px;
		border-radius: 2px;
		vertical-align: -1px;
	}
	.chart {
		position: relative;
		height: 170px;
		touch-action: pan-y;
	}
	svg {
		display: block;
	}
	svg text {
		fill: var(--w-ink-3);
		font-size: 11px;
	}
	.tip {
		position: absolute;
		top: 0;
		z-index: 2;
		width: 150px;
		padding: 6px 8px;
		background: var(--w-ground);
		border: 1px solid var(--w-ink-3);
		border-radius: 6px;
		font-size: 12px;
		pointer-events: none;
	}
	@media (max-width: 760px) {
		.charts {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
