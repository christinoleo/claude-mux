/**
 * Whether the drawer's Ctrl+K switcher is open. The drawer owns it; a split's
 * pane, which has no drawer of its own, asks the page outside to open it.
 */
class QuickSwitchStore {
	open = $state(false);
}

export const quickSwitch = new QuickSwitchStore();
