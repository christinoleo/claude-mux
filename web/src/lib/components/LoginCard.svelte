<script lang="ts">
	import type { LoginScreen } from '$shared/tmux/login.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	let {
		login,
		onKeys,
		onText
	}: {
		/** The sign-in screen as the pane draws it right now. */
		login: NonNullable<LoginScreen>;
		onKeys: (keys: string) => Promise<void> | void;
		onText: (text: string) => Promise<void> | void;
	} = $props();

	/** What the sign-in page hands back: the code, a `#`, and the request's state. */
	const CODE_SHAPE = /^[\w-]{8,}#[\w-]{8,}$/;

	let draft = $state('');
	let sending = $state(false);
	let copied = $state(false);
	let note = $state<string | null>(null);
	/** The link was opened from here, so coming back to this tab means the code is likely on the clipboard. */
	let awaitingCode = $state(false);

	const url = $derived(login.step === 'code' ? login.url : null);

	async function submit(code = draft) {
		const text = code.trim();
		if (!text || sending) return;
		sending = true;
		note = null;
		try {
			await onText(text);
			await onKeys('Enter');
			draft = '';
			awaitingCode = false;
		} finally {
			sending = false;
		}
	}

	/** The clipboard on a click: a code goes straight in, anything else lands in the field to look at. */
	async function pasteAndSubmit() {
		let text: string;
		try {
			text = (await navigator.clipboard.readText()).trim();
		} catch {
			note = 'This browser would not share the clipboard. Paste the code into the field.';
			return;
		}
		if (CODE_SHAPE.test(text)) await submit(text);
		else {
			draft = text;
			note = text ? 'That does not look like a sign-in code. Check it, then press Sign in.' : 'The clipboard is empty.';
		}
	}

	async function copyLink() {
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			note = 'Copying was refused. Open the page instead.';
		}
	}

	// Back from the sign-in tab: where the browser already lets this page read
	// the clipboard, a code waiting there fills the field without asking.
	$effect(() => {
		if (!awaitingCode) return;
		const onBack = async () => {
			if (document.visibilityState !== 'visible' || draft) return;
			try {
				const perm = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
				if (perm.state !== 'granted') return;
				const text = (await navigator.clipboard.readText()).trim();
				if (CODE_SHAPE.test(text)) draft = text;
			} catch {
				// No permission API or no clipboard: the buttons still work.
			}
		};
		document.addEventListener('visibilitychange', onBack);
		window.addEventListener('focus', onBack);
		return () => {
			document.removeEventListener('visibilitychange', onBack);
			window.removeEventListener('focus', onBack);
		};
	});
</script>

<section class="login-card" aria-label="Sign in to Claude Code">
	<header class="title">
		<iconify-icon icon="mdi:account-key-outline"></iconify-icon>
		<span>{login.step === 'done' ? 'Signed in' : 'Sign in to Claude Code'}</span>
	</header>

	{#if login.step === 'expired'}
		<p class="lead">This session's sign-in has expired, so its turns fail until it signs in again.</p>
		<Button
			variant="warning"
			size="sm"
			disabled={sending}
			onclick={async () => {
				sending = true;
				try {
					await onText('/login');
					await onKeys('Enter');
				} finally {
					sending = false;
				}
			}}
		>
			<iconify-icon icon="mdi:login"></iconify-icon>Sign in
		</Button>
	{:else if login.step === 'failed'}
		<p class="error">{login.error}</p>
		<p class="lead">A code works once and only for the link it came from. Try again for a fresh link.</p>
		<div class="link-row">
			<Button variant="warning" size="sm" onclick={() => void onKeys('Enter')}>
				<iconify-icon icon="mdi:refresh"></iconify-icon>Try again
			</Button>
			<Button variant="ghost" size="sm" onclick={() => void onKeys('Escape')}>Cancel</Button>
		</div>
	{:else if login.step === 'done'}
		<p class="lead">The code was accepted. Claude Code waits for Enter to carry on.</p>
		<Button variant="warning" size="sm" onclick={() => void onKeys('Enter')}>
			<iconify-icon icon="mdi:keyboard-return"></iconify-icon>Continue
		</Button>
	{:else}
		<p class="lead">Open the sign-in page, approve, and paste the code it shows you here.</p>
		{#if url}
			<div class="link-row">
				<Button
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					variant="warning"
					size="sm"
					onclick={() => (awaitingCode = true)}
				>
					<iconify-icon icon="mdi:open-in-new"></iconify-icon>Open sign-in page
				</Button>
				<Button variant="ghost" size="sm" onclick={() => void copyLink()}>
					<iconify-icon icon={copied ? 'mdi:check' : 'mdi:content-copy'}></iconify-icon>
					{copied ? 'Copied' : 'Copy link'}
				</Button>
			</div>
		{:else}
			<p class="muted">The link is not on screen. Open the terminal view to see it.</p>
		{/if}

		<form
			class="code-row"
			onsubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<Input
				bind:value={draft}
				class="code-input"
				placeholder="Code from the sign-in page"
				aria-label="Sign-in code"
				autocomplete="off"
				spellcheck={false}
			/>
			<Button type="button" variant="ghost" size="sm" disabled={sending} onclick={() => void pasteAndSubmit()}>
				<iconify-icon icon="mdi:clipboard-arrow-down-outline"></iconify-icon>Paste
			</Button>
			<Button type="submit" variant="warning" size="sm" disabled={sending || !draft.trim()}>
				<iconify-icon icon="mdi:send"></iconify-icon>Sign in
			</Button>
		</form>

		{#if login.error}<p class="error">{login.error}</p>{/if}
		{#if login.typed}<p class="muted">Already in the pane's field: <code>{login.typed}</code></p>{/if}
	{/if}
	{#if note}<p class="muted">{note}</p>{/if}
</section>

<style>
	/* Amber like a dialog: the session waits on a person until it signs in. */
	.login-card {
		margin: 14px 0 14px 12px;
		border: 1px solid #5c4410;
		border-left: 3px solid #fbbf24;
		border-radius: 8px;
		background: #1a1610;
		padding: 10px 12px 12px;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 8px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #fbbf24;
	}
	.lead {
		margin: 0 0 10px;
		color: #f5f0ee;
	}
	.link-row,
	.code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.code-row {
		margin-top: 10px;
	}
	.code-row :global(.code-input) {
		flex: 1 1 14rem;
		min-width: 0;
		font-family: ui-monospace, monospace;
	}
	.error {
		margin: 8px 0 0;
		color: #f87171;
		font-size: 12.5px;
	}
	.muted {
		margin: 8px 0 0;
		color: #a8a29e;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}
</style>
