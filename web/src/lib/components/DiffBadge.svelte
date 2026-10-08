<script lang="ts">
	/**
	 * "+42 −10": the lines a session has added and removed, for the trailing
	 * meta slot of its sidebar row. Muted and small, so the state indicator
	 * stays the loudest thing on the row; nothing at all when both are zero.
	 */
	import type { ChangesInfo } from '$shared/types/ws-messages.js';

	let { changes }: { changes: ChangesInfo | null | undefined } = $props();
</script>

{#if changes && (changes.additions > 0 || changes.deletions > 0)}
	<span
		class="diff"
		title="{changes.files} {changes.files === 1 ? 'file' : 'files'} changed ({changes.source === 'git' ? 'git' : 'this session'})"
	>
		<span class="add">+{changes.additions}</span>
		<span class="del">−{changes.deletions}</span>
	</span>
{/if}

<style>
	.diff {
		font-family: var(--font-mono);
		font-size: 10.5px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.add {
		color: #3f9d63;
	}
	.del {
		color: #b4565a;
	}
</style>
