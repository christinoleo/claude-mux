import { toast } from 'svelte-sonner';

/** Copy `text` and say so, or say that it could not be copied. */
export async function copyWithToast(text: string, done = 'Copied'): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(done, { description: text });
	} catch {
		toast.error('Could not copy');
	}
}
