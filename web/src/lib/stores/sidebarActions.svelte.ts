export type ChordAction = {
	label: string;
	icon: string;
	run: () => void;
	danger?: boolean;
	flashing?: boolean;
	variant?: 'destructive' | 'secondary';
};

function sameShape(a: ChordAction[], b: ChordAction[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (
			x.label !== y.label ||
			x.icon !== y.icon ||
			x.danger !== y.danger ||
			x.variant !== y.variant ||
			x.flashing !== y.flashing
		) {
			return false;
		}
	}
	return true;
}

class SidebarActionsStore {
	actions: ChordAction[] = $state([]);

	set(actions: ChordAction[]): void {
		if (sameShape(this.actions, actions)) return;
		this.actions = actions;
	}

	clear(): void {
		if (this.actions.length === 0) return;
		this.actions = [];
	}
}

export const sidebarActionsStore = new SidebarActionsStore();
