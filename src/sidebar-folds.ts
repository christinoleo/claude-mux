/**
 * What a person folded or opened in the sidebar, by key: a row's subagents
 * (`agentsFoldKey()`) and a group of workers (`workersFoldKey()`). A key
 * nobody touched takes the default its caller passes, so a choice only
 * records a departure from it.
 */

export type FoldChoices = Readonly<Record<string, boolean>>;

export function agentsFoldKey(sessionId: string): string {
  return `agents:${sessionId}`;
}

/** A master's workers by the master's session; the masterless ones by their place. */
export function workersFoldKey(owner: string): string {
  return `workers:${owner}`;
}

export function isOpen(choices: FoldChoices, key: string, byDefault: boolean): boolean {
  return choices[key] ?? byDefault;
}
