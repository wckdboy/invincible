/*
 * Plain text: words as they were written, with nothing in them that hides, reorders or
 * steers. What a model, an agent or another device wrote is shown through these wherever
 * the surface itself gives no protection: a terminal acts on escape sequences and
 * carriage returns, and any surface can be made to read other than it is by
 * bidirectional overrides and zero-width characters.
 *
 * No schema library here (the app imports this directly).
 */

/** Characters that can hide or reorder text, or steer a terminal: controls (C0 but tab and newline, DEL, C1), bidirectional
 * overrides and isolates, and what is written but never drawn (zero-width characters and joiners, the soft hyphen,
 * fillers, deprecated format characters, tags). */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
/** Every kind of line break: CRLF, a bare carriage return, NEL, the line and paragraph separators. */
const BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;

/** Its lines kept, each kind of line break as a newline, nothing hidden in it. */
export const plainText = (text: string): string => text.replace(BREAKS, "\n").replace(HIDDEN, "");

/** One line, nothing hidden in it: every run of whitespace (line breaks of every kind included) is one space. */
export const plainLine = (text: string): string => plainText(text).replace(/\s+/g, " ").trim();

/** What can't be seen as it is: everything HIDDEN takes out, every other kind of line break (a carriage return, NEL, the
 * line and paragraph separators), and every space that isn't a plain one (a tab, a no-break space, the other widths). */
const UNSEEN = /[\t\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00a0\u00ad\u061c\u115f\u1160\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

/** A character as it is shown in its place when it can't be seen: ⟨U+202E⟩. */
export const codePointLabel = (char: string): string => `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`;

/**
 * Text a person must see exactly (an operation that waits for their approval): every character that can't be seen as it
 * is (UNSEEN) is shown in its place as ⟨U+XXXX⟩, never taken out, and its lines are kept. `hidden`: those characters,
 * each once, in the order they first came. A terminal acts on none of what is left.
 */
export function visibleText(text: string): { text: string; hidden: string[] } {
  const hidden: string[] = [];
  const shown = text.replace(UNSEEN, (char) => {
    if (!hidden.includes(char)) hidden.push(char);
    return codePointLabel(char);
  });
  return { text: shown, hidden };
}

/** Text that arrives in pieces (an answer as it is written), each piece made plain as it comes: a line break split
 * between two pieces is still one line break. */
export function plainStream(): (piece: string) => string {
  let afterCarriageReturn = false;
  return (piece) => {
    if (!piece) return "";
    const rest = afterCarriageReturn && piece.startsWith("\n") ? piece.slice(1) : piece;
    afterCarriageReturn = piece.endsWith("\r");
    return plainText(rest);
  };
}
