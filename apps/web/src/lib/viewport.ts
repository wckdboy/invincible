/*
 * The on-screen keyboard, as far as a page can tell. iOS (Safari and Home Screen
 * apps) keeps the page its full height and shrinks only the visual viewport, so
 * anything pinned to the bottom (the tab bar, the chat composer's place above it)
 * would sit behind the keyboard. Pure, so unit-tested.
 */

/** More than this much of the page hidden while typing is a keyboard, not a browser bar sliding away. */
const KEYBOARD_PX = 150;

export function keyboardOpen(view: { coarse: boolean; typing: boolean; fullHeight: number; visibleHeight: number }): boolean {
  return view.coarse && view.typing && view.fullHeight - view.visibleHeight > KEYBOARD_PX;
}

/** A tap moves less than this far, and is over sooner than this: more is a drag (a scroll), or a press that selects. */
const TAP_PX = 10;
const TAP_MS = 500;

/**
 * Whether a tap closes the on-screen keyboard (your word, 23 November 2026: it can always be closed, so you never get
 * stuck under it): a short, still tap with a finger, on what takes no tap itself (a field, a button, a link, the message
 * box's form), while something is typed in. iOS leaves its keyboard up after such a tap; the page puts it away.
 */
export function closesKeyboard(tap: { coarse: boolean; typing: boolean; takesTap: boolean; from: readonly [number, number]; to: readonly [number, number]; ms: number }): boolean {
  const moved = Math.hypot(tap.to[0] - tap.from[0], tap.to[1] - tap.from[1]);
  return tap.coarse && tap.typing && !tap.takesTap && moved < TAP_PX && tap.ms < TAP_MS;
}
