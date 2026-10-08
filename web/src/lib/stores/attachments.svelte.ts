// File attachments staged for the next send, kept per target the way drafts
// are (see docs/adr/0001, 0002). In memory only: a chip holds the File and a
// blob URL, neither of which survives a reload.
export type AttachmentStatus = 'uploading' | 'ready' | 'failed';
export interface Attachment {
	localId: string;
	file: File;
	name: string;
	size: number;
	mime: string;
	status: AttachmentStatus;
	path?: string;
	error?: string;
	thumb?: string;
	abort?: AbortController;
}

const NONE: Attachment[] = [];

function release(chip: Attachment): void {
	chip.abort?.abort();
	if (chip.thumb) URL.revokeObjectURL(chip.thumb);
}

class AttachmentsStore {
	private state = $state<Record<string, Attachment[]>>({});

	get(target: string | null): Attachment[] {
		if (!target) return NONE;
		return this.state[target] ?? NONE;
	}

	count(target: string | null): number {
		return this.get(target).length;
	}

	add(target: string | null, chip: Attachment): void {
		if (!target) return;
		this.state[target] = [...this.get(target), chip];
	}

	/** Patch a chip in its own target's list; a no-op once it has been removed. */
	patch(target: string, localId: string, changes: Partial<Attachment>): void {
		const list = this.state[target];
		if (!list?.some((a) => a.localId === localId)) return;
		this.state[target] = list.map((a) => (a.localId === localId ? { ...a, ...changes } : a));
	}

	/** Drop one chip, aborting its upload and revoking its blob URL. */
	remove(target: string | null, localId: string): Attachment | undefined {
		const list = target ? this.state[target] : undefined;
		const chip = list?.find((a) => a.localId === localId);
		if (!target || !list || !chip) return undefined;
		release(chip);
		const rest = list.filter((a) => a.localId !== localId);
		if (rest.length) this.state[target] = rest;
		else delete this.state[target];
		return chip;
	}

	clear(target: string | null): void {
		const list = target ? this.state[target] : undefined;
		if (!target || !list) return;
		list.forEach(release);
		delete this.state[target];
	}
}

export const attachmentsStore = new AttachmentsStore();
