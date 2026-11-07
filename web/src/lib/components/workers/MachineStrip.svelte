<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { QueueSettings, QueueStatus } from '$shared/server/worker-queue.js';
	import { issueKey, machineSay, memorySplit } from '$lib/workers';

	/**
	 * One machine as a strip of its memory (#201): other sessions and apps,
	 * then each worker as wide as the memory it holds, then what is free, and
	 * a line where the free memory to keep starts. Under it, the limit, the
	 * memory to keep and the machine's one switch, the same one the Machines
	 * view turns.
	 */
	interface Props {
		name: string;
		status: QueueStatus;
		/** The worker opened below, by `repo#n`. */
		open: string | null;
		busy: boolean;
		onOpen: (key: string) => void;
		onChange: (patch: Partial<QueueSettings>) => void;
		/** Turn the machine's switch: workers, Triggers, releases, live text and dashboard approvals. */
		onTurn: (on: boolean) => void;
	}
	let { name, status, open, busy, onOpen, onChange, onTurn }: Props = $props();

	const split = $derived(memorySplit(status));
	const say = $derived(machineSay(status));
	const wants = $derived(new Set(status.workers.filter((w) => w.wants).map(issueKey)));
	const titles = $derived(new Map(status.workers.map((w) => [issueKey(w), `#${w.number} ${w.title}`])));
	const reservePct = $derived(split ? Math.min(100, (status.settings.minFreeGiB / split.total) * 100) : null);

	const s = $derived(status.settings);
	const step = (field: 'limit' | 'minFreeGiB' | 'maxPressure', by: number, min: number, max: number) => {
		const next = Math.round((s[field] + by) * 10) / 10;
		onChange({ [field]: Math.max(min, Math.min(max, next)) });
	};
</script>

<article class="machine">
	<div class="head">
		<span class="name">{name}</span>
		<span class="say" class:held={say.held}>{say.text}</span>
	</div>
	{#if split}
		<div class="strip">
			<div class="seg other" style:flex-grow={split.other} title="Other sessions and apps: {split.other.toFixed(1)} GiB"></div>
			{#each split.workers as w (w.key)}
				{#if titles.has(w.key)}
					<button
						type="button"
						class="seg worker"
						class:wants={wants.has(w.key)}
						class:on={open === w.key}
						style:flex-grow={Math.max(w.gib, 0.05)}
						aria-label="{titles.get(w.key)}, {w.gib.toFixed(1)} GiB"
						title="{titles.get(w.key)}: {w.gib.toFixed(1)} GiB"
						onclick={() => onOpen(w.key)}
					></button>
				{:else}
					<div class="seg worker daemon" style:flex-grow={Math.max(w.gib, 0.05)} title="A daemon's worker: {w.gib.toFixed(1)} GiB"></div>
				{/if}
			{/each}
			{#if split.free > 0}
				<div class="seg free" style:flex-grow={split.free} title="Free: {split.free.toFixed(1)} GiB"></div>
			{/if}
			{#if reservePct !== null}
				<div class="reserve" style:right="{reservePct}%" title="Nothing new starts past this line"></div>
			{/if}
		</div>
	{/if}
	<div class="controls">
		<div class="ctl">
			<span id="limit-{name}">Worker limit</span>
			<span class="step" role="group" aria-labelledby="limit-{name}">
				<Button variant="ghost" size="icon" disabled={busy || s.limit <= 0} aria-label="Lower the limit on {name}" onclick={() => step('limit', -1, 0, 64)}>−</Button>
				<output>{s.limit}</output>
				<Button variant="ghost" size="icon" disabled={busy || s.limit >= 64} aria-label="Raise the limit on {name}" onclick={() => step('limit', 1, 0, 64)}>+</Button>
			</span>
		</div>
		<div class="ctl">
			<span id="free-{name}">Keep free</span>
			<span class="step" role="group" aria-labelledby="free-{name}">
				<Button variant="ghost" size="icon" disabled={busy || s.minFreeGiB <= 0} aria-label="Keep less memory free on {name}" onclick={() => step('minFreeGiB', -0.5, 0, 256)}>−</Button>
				<output>{s.minFreeGiB.toFixed(1)}</output>
				<Button variant="ghost" size="icon" disabled={busy} aria-label="Keep more memory free on {name}" onclick={() => step('minFreeGiB', 0.5, 0, 256)}>+</Button>
			</span>
			GiB
		</div>
		<div class="ctl">
			<span id="pressure-{name}">Hold over</span>
			<span class="step" role="group" aria-labelledby="pressure-{name}">
				<Button variant="ghost" size="icon" disabled={busy || s.maxPressure <= 0} aria-label="Hold starts at less memory pressure on {name}" onclick={() => step('maxPressure', -5, 0, 100)}>−</Button>
				<output>{s.maxPressure}</output>
				<Button variant="ghost" size="icon" disabled={busy || s.maxPressure >= 100} aria-label="Allow more memory pressure on {name}" onclick={() => step('maxPressure', 5, 0, 100)}>+</Button>
			</span>
			% pressure
		</div>
		<Button
			variant="outline"
			size="sm"
			class={status.on ? '' : 'paused'}
			aria-pressed={status.on}
			disabled={busy}
			title="Workers, Triggers, releases, live text and dashboard approvals on {name}. Nothing running is stopped."
			onclick={() => onTurn(!status.on)}
		>
			{status.on ? `Turn ${name} off` : `Turn ${name} on`}
		</Button>
	</div>
</article>

<style>
	.machine {
		display: grid;
		gap: 10px;
		padding: 14px;
		background: var(--w-raised);
		border: 1px solid var(--w-line);
		border-radius: 8px;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 14px;
	}
	.name {
		font-weight: 600;
	}
	.say {
		color: var(--w-ink-2);
		font-variant-numeric: tabular-nums;
	}
	.say.held {
		color: var(--w-want);
	}
	.strip {
		position: relative;
		display: flex;
		gap: 2px;
		height: 34px;
	}
	.seg {
		flex-basis: 0;
		min-width: 3px;
		padding: 0;
		border: 0;
		border-radius: 2px;
	}
	.seg.other {
		background: var(--w-other);
	}
	.seg.worker {
		background: var(--w-busy);
		cursor: pointer;
	}
	.seg.worker.wants {
		background: var(--w-want);
	}
	.seg.daemon {
		cursor: default;
		opacity: 0.6;
	}
	.seg.on {
		box-shadow: inset 0 0 0 2px var(--w-ink);
	}
	.seg.free {
		background: repeating-linear-gradient(135deg, transparent 0 5px, var(--w-line) 5px 6px);
		outline: 1px solid var(--w-line);
		outline-offset: -1px;
	}
	.reserve {
		position: absolute;
		top: -4px;
		bottom: -4px;
		width: 2px;
		background: var(--w-ink);
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 22px;
	}
	.ctl {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--w-ink-2);
		white-space: nowrap;
	}
	.step {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--w-line);
		border-radius: 6px;
	}
	.step output {
		min-width: 40px;
		text-align: center;
		color: var(--w-ink);
		font-variant-numeric: tabular-nums;
	}
	.controls :global(.paused) {
		border-color: var(--w-want);
		color: var(--w-want);
	}
</style>
