/*
 * T3 Code's keys, where Invincible has what they do (the owner's word, 28 November 2026: the Mac app "a near copy of
 * t3code", its keyboard included), and Invincible's own where T3 Code leaves a key free: ⌘0 your agent, ⌘⇧I Needs you.
 * ⌘ on a Mac, Ctrl elsewhere. A bracket or a digit is also read by where it lies on the keyboard (its code), so the key a
 * US keyboard has [ on is ⌘[ on any keyboard: on the owner's Danish one, Å. A letter is the letter it types. ⌥ with any
 * of them is no key here (a Mac types characters with it). In a browser, its own keys stay its own (its tabs, its zoom,
 * its history: ⌘1–⌘9, ⌘⇧[ ⌘⇧], ⌘0, ⌘[ ⌘]); the Mac app's window has none of those, so there they are the app's.
 * Pure: the shell hands what a key does to the app (shell.ts), and a task's details and terminal, or an agent's side
 * panel, to the view on screen (views/view-keys.ts).
 */

export type KeyAction =
  | "palette"
  | "new-chat"
  | "give"
  | "sidebar"
  | "panel"
  | "terminal"
  | "primary"
  | "needs"
  | "back"
  | "forward"
  | "previous"
  | "next"
  | { thread: number };

/** A key pressed, as a KeyboardEvent says it. */
export interface Press {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const LETTERS: Record<string, KeyAction> = { k: "palette", n: "new-chat", b: "sidebar", d: "panel", j: "terminal" };
const SHIFTED: Record<string, KeyAction> = { n: "give", i: "needs" };

/** Whether a key is a browser's own (its tabs, its zoom, its history): the app's only in the Mac app's window. */
export const browsersOwn = (action: KeyAction): boolean => typeof action === "object" || action === "previous" || action === "next" || action === "primary" || action === "back" || action === "forward";

/**
 * What a key does (null: nothing of the app's, so the browser's or the field's own). `mac`: ⌘ is the key, not Ctrl;
 * `app`: the page is the Mac app's window (data-shell="mac"), not a browser's tab.
 */
export function keyAction(press: Press, where: { mac: boolean; app: boolean }): KeyAction | null {
  const mod = where.mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (!mod || press.altKey) return null;
  const action = actionOf(press);
  return action && (where.app || !browsersOwn(action)) ? action : null;
}

function actionOf(press: Press): KeyAction | null {
  const key = press.key.toLowerCase();
  const bracket = press.code === "BracketLeft" || key === "[" || key === "{" ? "[" : press.code === "BracketRight" || key === "]" || key === "}" ? "]" : null;
  if (bracket) return press.shiftKey ? (bracket === "[" ? "previous" : "next") : bracket === "[" ? "back" : "forward";
  const digit = /^Digit([0-9])$/.exec(press.code)?.[1] ?? (/^[0-9]$/.test(key) ? key : null);
  if (digit !== null) return press.shiftKey ? null : digit === "0" ? "primary" : { thread: Number(digit) };
  return (press.shiftKey ? SHIFTED[key] : LETTERS[key]) ?? null;
}

/** The keys as the shortcuts sheet lists them: what each does, its keys ("mod" is ⌘ or Ctrl), and whether it is the
 * Mac app's window's alone (a browser keeps it). */
export const KEY_ROWS: readonly { label: string; keys: readonly string[]; app?: true }[] = [
  { label: "Search and commands", keys: ["mod", "K"] },
  { label: "New chat with your agent", keys: ["mod", "N"] },
  { label: "Give a task to the agents", keys: ["mod", "Shift", "N"] },
  { label: "Your agent", keys: ["mod", "0"], app: true },
  { label: "Needs you", keys: ["mod", "Shift", "I"] },
  { label: "Show or hide the sidebar", keys: ["mod", "B"] },
  { label: "A task's details, an agent's side panel", keys: ["mod", "D"] },
  { label: "A task's terminal", keys: ["mod", "J"] },
  { label: "The first nine threads in the sidebar", keys: ["mod", "1–9"], app: true },
  { label: "The thread above, below", keys: ["mod", "Shift", "[ ]"], app: true },
  { label: "Back, forward", keys: ["mod", "[ ]"], app: true },
];

/** Keys in a title's words: ⌘⇧N on a Mac, Ctrl+Shift+N elsewhere. */
export function keyWords(keys: readonly string[], mac: boolean): string {
  if (!mac) return keys.map((key) => (key === "mod" ? "Ctrl" : key)).join("+");
  const glyph: Record<string, string> = { mod: "⌘", Shift: "⇧" };
  return keys.map((key) => glyph[key] ?? key).join("");
}
