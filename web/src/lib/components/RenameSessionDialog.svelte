<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { sessionStore } from '$lib/stores/sessions.svelte';

	interface Props {
		/** The session to rename; `null` keeps the dialog closed. */
		sessionId: string | null;
		onClose: () => void;
	}

	let { sessionId, onClose }: Props = $props();

	// Looked up rather than passed in, so the dialog reads the live session
	// instead of a snapshot frozen at the moment the row was clicked.
	const session = $derived(sessionId ? sessionStore.sessionById.get(sessionId) ?? null : null);

	let value = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);

	// Seed the field once per opening. The name is read untracked so a rename
	// arriving back over the WebSocket cannot overwrite what is being typed.
	$effect(() => {
		if (sessionId) value = untrack(() => session?.display_name ?? '');
	});

	const TOP_MARGIN_PX = 16;
	/** Below this share of the layout viewport, the shortfall is the keyboard. */
	const KEYBOARD_RATIO = 0.75;

	/**
	 * The dialog is `position: fixed`, which anchors it to the layout viewport —
	 * on a phone the on-screen keyboard then covers it, and the focused field
	 * sits behind the keys. Pinning it to the top of `visualViewport` instead
	 * keeps it in sight as the keyboard opens and closes.
	 *
	 * Android resizes the layout viewport along with the keyboard, so the default
	 * centring already lands above it and there is nothing to correct. iOS Safari
	 * does not, and supports neither `env(keyboard-inset-height)` nor
	 * `interactive-widget`, which is why this is done in script.
	 */
	let positionStyle = $state<string | undefined>(undefined);

	$effect(() => {
		const vv = window.visualViewport;
		if (!sessionId || !vv) return;
		// Assigning the same string is a no-op in Svelte, so the per-frame `scroll`
		// events an opening keyboard produces cost nothing extra. Reading
		// `positionStyle` here to compare would make this effect depend on its own
		// output and re-subscribe the listeners on every change.
		const sync = () => {
			// `translate` (not `transform`) is what centres the panel, so the vertical
			// half of it has to be cancelled here or the panel rides off the top.
			positionStyle =
				vv.height < window.innerHeight * KEYBOARD_RATIO
					? `top: ${vv.offsetTop + TOP_MARGIN_PX}px; translate: -50% 0;`
					: undefined;
		};
		sync();
		vv.addEventListener('resize', sync);
		vv.addEventListener('scroll', sync);
		return () => {
			vv.removeEventListener('resize', sync);
			vv.removeEventListener('scroll', sync);
			positionStyle = undefined;
		};
	});

	async function commit() {
		const target = session;
		const next = value.trim();
		onClose();
		if (!target || next === (target.display_name ?? '')) return;
		try {
			await fetch(`/api/sessions/${encodeURIComponent(target.id)}/rename`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: next || null })
			});
		} catch {
			// watcher will reconcile
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void commit();
		}
	}
</script>

<Dialog.Root open={session !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
	<Dialog.Content
		class="max-w-sm"
		style={positionStyle}
		onOpenAutoFocus={(e) => {
			// bits-ui focuses the panel itself; the point of this dialog is to type
			// straight away, so hand focus to the field instead.
			e.preventDefault();
			inputEl?.focus();
			inputEl?.select();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>Rename session</Dialog.Title>
			<Dialog.Description>
				Also sent to the agent as <code>/rename</code>, once its pane is back at a prompt. Leave
				blank to fall back to the tmux target.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			bind:ref={inputEl}
			bind:value
			onkeydown={onKeydown}
			class="font-mono"
			type="text"
			placeholder={session?.tmux_target ?? session?.id ?? 'session name'}
			aria-label="Session name"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			enterkeyhint="done"
			maxlength={120}
		/>
		<Dialog.Footer>
			<Button variant="ghost" class="min-h-11" onclick={onClose}>Cancel</Button>
			<Button class="min-h-11" onclick={commit}>Rename</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
