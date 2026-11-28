/*
 * What the view on screen does for a key the shell hands it (lib/keys.ts): ⌘D a task's details or an agent's side panel,
 * ⌘J a task's terminal. One view at a time: each says what it does while it shows, and stops as it goes. A view that can't
 * do it now (no VM for a terminal, a screen too narrow) says no, and the key stays the browser's.
 */

export type ViewKey = "panel" | "terminal";

const doers = new Map<ViewKey, () => boolean>();

/** `run` does it, and says whether it did; the returned function stops it (a view's scope ending). */
export function onViewKey(key: ViewKey, run: () => boolean): () => void {
  doers.set(key, run);
  return () => {
    if (doers.get(key) === run) doers.delete(key);
  };
}

/** Whether the view on screen did it. */
export function viewKey(key: ViewKey): boolean {
  return doers.get(key)?.() ?? false;
}
