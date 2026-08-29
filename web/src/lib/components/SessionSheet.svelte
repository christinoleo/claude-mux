<script lang="ts">
	/**
	 * What the page header used to be: the other live sessions, the four rare
	 * pane actions, and the kill.
	 *
	 * It lives above the composer's status line rather than at the top of the
	 * screen, because switching session is a thing you do with a thumb like
	 * everything else here. The terminal toggle keeps a glyph of its own on
	 * the status line — it is the one header action used often enough to
	 * deserve one.
	 */
	import { clickOutside } from '$lib/actions/clickOutside';
	import SessionStateIndicator from './SessionStateIndicator.svelte';
	import {
		sessionStore,
		getSessionDisplayName,
		type Session
	} from '$lib/stores/sessions.svelte';
	import { goto } from '$app/navigation';

	interface Action {
		label: string;
		icon: string;
		run: () => void;
	}

	interface Props {
		open: boolean;
		/** The session this composer belongs to, so it can mark itself current. */
		currentTarget: string | null;
		actions: Action[];
		onKill: () => void;
		onClose: () => void;
	}

	let { open, currentTarget, actions, onKill, onClose }: Props = $props();

	/** Live Claude sessions, the current one first. */
	const siblings = $derived(
		sessionStore.sessions
			.filter((s: Session) => s.pane_alive !== false && s.tmux_target)
			.slice()
			.sort((a: Session, b: Session) =>
				a.tmux_target === currentTarget ? -1 : b.tmux_target === currentTarget ? 1 : 0
			)
			.slice(0, 8)
	);

	function open_(session: Session) {
		onClose();
		if (session.tmux_target) void goto(`/session/${encodeURIComponent(session.tmux_target)}`);
	}
</script>

{#if open}
	<div
		class="sheet"
		role="dialog"
		aria-label="Session"
		use:clickOutside={{ enabled: open, onOutside: onClose }}
	>
		<span class="cap">sessions</span>
		{#each siblings as session (session.id)}
			<button
				type="button"
				class="row"
				class:cur={session.tmux_target === currentTarget}
				onclick={() => open_(session)}
			>
				<SessionStateIndicator state={session.state} size="sm" />
				<span class="name">{getSessionDisplayName(session)}</span>
				<span class="sub">{session.state}</span>
			</button>
		{/each}

		{#if actions.length > 0}
			<div class="div"></div>
			<div class="acts">
				{#each actions as action (action.label)}
					<button
						type="button"
						class="act"
						title={action.label}
						aria-label={action.label}
						onclick={() => {
							action.run();
							onClose();
						}}
					>
						<iconify-icon icon={action.icon}></iconify-icon>
					</button>
				{/each}
			</div>
		{/if}

		<div class="div"></div>
		<button
			type="button"
			class="row kill"
			onclick={() => {
				onKill();
				onClose();
			}}
		>
			<iconify-icon icon="mdi:power"></iconify-icon>
			<span class="name">Kill pane</span>
		</button>
	</div>
{/if}

<style>
	.sheet {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: calc(100% + 8px);
		max-width: 330px;
		background: #1a1a1c;
		border: 1px solid #313135;
		border-radius: 14px;
		box-shadow: 0 20px 44px rgba(0, 0, 0, 0.62);
		padding: 7px;
		z-index: 9;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.cap {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: #57534e;
		padding: 7px 9px 5px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 9px;
		border: 0;
		border-radius: 9px;
		background: none;
		width: 100%;
		justify-content: flex-start;
		text-align: left;
		color: #a8a29e;
		font-size: 13.5px;
		cursor: pointer;
	}
	.row:hover {
		background: #232326;
		color: #f5f5f4;
	}
	.row.cur {
		background: #202024;
		color: #f5f5f4;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: 10px;
		color: #57534e;
		flex: none;
	}
	/* Kill sits alone below a rule, where a mis-tap can't reach it. */
	.row.kill {
		color: #c98080;
	}
	.row.kill:hover {
		background: #2c1b1b;
		color: #f2b8b8;
	}
	.div {
		height: 1px;
		background: #2a2a2e;
		margin: 5px 2px;
	}
	.acts {
		display: flex;
		gap: 3px;
		padding: 2px;
	}
	.act {
		flex: 1;
		min-width: 0;
		height: 38px;
		border: 0;
		border-radius: 9px;
		background: #202024;
		color: #a8a29e;
		font-size: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.act:hover {
		background: #292930;
		color: #f5f5f4;
	}
</style>
