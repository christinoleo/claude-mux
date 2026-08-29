/**
 * Whether the sidebar drawer is open on narrow viewports.
 *
 * The session page's composer carries the toggle now that the page header is
 * gone, and the layout owns the drawer itself — so the two talk through this
 * rather than through a floating button drawn over the transcript.
 */
class DrawerStore {
  open = $state(false);

  toggle() {
    this.open = !this.open;
  }

  close() {
    this.open = false;
  }
}

export const drawer = new DrawerStore();
