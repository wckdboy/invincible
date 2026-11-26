/*
 * Names that read alike. A model chooses the name of a worker it makes, and people read that name beside
 * yours, his and every other worker's: so a name must not pass for one of those by being spelled with
 * letters that are only drawn the same (a Cyrillic "а" for "a", a capital "I" for "l", small capitals).
 *
 * Two checks, both pure and small on purpose:
 *   - `oneScript`: the letters of a name belong to one writing system, and one this file knows. Most
 *     look-alikes need a mix, and a script that isn't listed here can't be vouched for.
 *   - `readAlike`: two names would be taken for one another. They are compared twice: as words (every
 *     look-alike as its Latin letter, case set aside) and as shapes (a capital I, a 1 and a bar drawn as a
 *     lowercase l, which a capital L is not).
 *
 * This is not Unicode's whole table of confusables (thousands of entries): it covers the scripts whose
 * letters are drawn like Latin ones, which is what the reserved names and most workers' names are in.
 * A look-alike within some other script is not found by it. No schema library here.
 */

const pairs = (from: string, to: string): [string, string][] => [...from].map((ch, i) => [ch, to[i]!]);

/** Letters drawn like a Latin letter, each by its code point (typed here they could not be told apart), and the
 * letter it reads as. A letter's other case is looked up too, so each is listed once. */
export const LOOKALIKES: ReadonlyMap<string, string> = new Map([
  // Cyrillic: а е о р с у х ѕ і ј һ ԁ ԛ ԝ ӏ к г п т м ү, then А В Е К М Н О Р С Т У Х Ѕ І Ј Ү Ԁ Ԛ Ԝ Ӏ Ԍ
  ...pairs("\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u04bb\u0501\u051b\u051d\u04cf\u043a\u0433\u043f\u0442\u043c\u04af", "aeopcyxsijhdqwlkrntmy"),
  ...pairs("\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0423\u0425\u0405\u0406\u0408\u04ae\u0500\u051a\u051c\u04c0\u050c", "ABEKMHOPCTYXSIJYDQWIG"),
  // Greek: α ο ν ρ υ ι κ χ ς γ η ω ε τ, then Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ
  ...pairs("\u03b1\u03bf\u03bd\u03c1\u03c5\u03b9\u03ba\u03c7\u03c2\u03b3\u03b7\u03c9\u03b5\u03c4", "aovpuikxcynwet"),
  ...pairs("\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7", "ABEZHIKMNOPTYX"),
  // Armenian: ո ս օ հ, then Ս Օ Տ Լ
  ...pairs("\u0578\u057d\u0585\u0570", "nuoh"),
  ...pairs("\u054d\u0555\u054f\u053c", "UOSL"),
  // Cherokee: Ꭰ Ꭱ Ꭲ Ꭺ Ꭻ Ꭼ Ꮃ Ꮇ Ꮋ Ꮍ Ꮐ Ꮓ Ꮢ Ꮤ Ꮩ Ꮪ Ꮮ Ꮯ Ꮲ Ꮶ Ᏼ
  ...pairs("\u13a0\u13a1\u13a2\u13aa\u13ab\u13ac\u13b3\u13b7\u13bb\u13bd\u13c0\u13c3\u13d2\u13d4\u13d9\u13da\u13de\u13df\u13e2\u13e6\u13f4", "DRTAJEWMHYGZRWVSLCPKB"),
  // Latin small capitals: ᴀ ʙ ᴄ ᴅ ᴇ ꜰ ɢ ʜ ɪ ᴊ ᴋ ʟ ᴍ ɴ ᴏ ᴘ ʀ ꜱ ᴛ ᴜ ᴠ ᴡ ʏ ᴢ
  ...pairs("\u1d00\u0299\u1d04\u1d05\u1d07\ua730\u0262\u029c\u026a\u1d0a\u1d0b\u029f\u1d0d\u0274\u1d0f\u1d18\u0280\ua731\u1d1b\u1d1c\u1d20\u1d21\u028f\u1d22", "abcdefghijklmnoprstuvwyz"),
  // Other Latin letters that pass for plain ones: ɑ ɡ ı ɩ ǀ ɛ ɣ ʋ ʉ, and letters with a stroke, bar or hook: ł ø đ ħ ŧ ǥ ƚ ɗ
  ...pairs("\u0251\u0261\u0131\u0269\u01c0\u025b\u0263\u028b\u0289", "agiileyuu"),
  ...pairs("\u0142\u00f8\u0111\u0127\u0167\u01e5\u019a\u0257", "lodhtgld"),
]);

/** The Latin letter a character reads as, in its own case or the other; itself when it is nobody's look-alike. */
const latin = (ch: string): string => LOOKALIKES.get(ch) ?? LOOKALIKES.get(ch.toLowerCase()) ?? LOOKALIKES.get(ch.toUpperCase()) ?? ch;

/** Set aside before two names are compared: accents, and what is written but hardly drawn (modifier letters such as
 * a raised apostrophe, the long-vowel mark, a tatweel, the saltillo) or not drawn at all. */
const UNDRAWN = /[\p{M}\p{Lm}\p{Default_Ignorable_Code_Point}\ua78b\ua78c]/gu;
/** Capital L, kept apart while everything else loses its case: it is not drawn like a capital I, a 1 or a bar. */
const CAPITAL_L = "\u0000";

function reading(name: string, shapes: boolean): string {
  let text = "";
  for (const ch of name.normalize("NFKC").normalize("NFD").replace(UNDRAWN, "")) text += latin(ch);
  if (shapes) text = text.replace(/L/g, CAPITAL_L).replace(/[I1|]/g, "l");
  return text.toLowerCase().replace(/0/g, "o").replace(/[^\p{L}\p{N}\u0000]/gu, "").replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
}

/**
 * What a name is drawn as: every look-alike as its Latin letter, a capital I, a 1 and a bar as a lowercase l, a
 * 0 as o, "rn" as m, "vv" as w and "cl" as d, with accents, case (but a capital L's), hyphens and apostrophes set aside.
 */
export const skeleton = (name: string): string => reading(name, true);

/** Whether two names would be taken for one another: the same word once look-alikes are their Latin letters and
 * case is set aside, or the same shapes. */
export const readAlike = (a: string, b: string): boolean => reading(a, false) === reading(b, false) || skeleton(a) === skeleton(b);

/* The writing systems a made worker's name may be in, each on its own; Chinese, Japanese and Korean names use
 * several scripts together, so those count as one. A letter of a script that isn't here is refused: this file
 * can't say what it might be taken for (Lisu and Coptic, for two, are drawn almost wholly like Latin capitals). */
const SCRIPTS = [
  /\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u, /\p{Script=Georgian}/u,
  /\p{Script=Hebrew}/u, /\p{Script=Arabic}/u, /\p{Script=Devanagari}/u, /\p{Script=Bengali}/u, /\p{Script=Gurmukhi}/u, /\p{Script=Gujarati}/u,
  /\p{Script=Tamil}/u, /\p{Script=Telugu}/u, /\p{Script=Kannada}/u, /\p{Script=Malayalam}/u, /\p{Script=Sinhala}/u, /\p{Script=Thai}/u,
  /\p{Script=Lao}/u, /\p{Script=Khmer}/u, /\p{Script=Myanmar}/u, /\p{Script=Tibetan}/u, /\p{Script=Ethiopic}/u,
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u,
];
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u;

/** Whether a name's letters (and any digits that belong to a script) are all of one writing system, and one known here. */
export function oneScript(name: string): boolean {
  let script: number | null = null;
  for (const ch of name) {
    if (!/[\p{L}\p{N}]/u.test(ch) || SHARED.test(ch)) continue;
    const at = SCRIPTS.findIndex((letters) => letters.test(ch));
    if (at < 0) return false;
    if (script === null) script = at;
    else if (script !== at) return false;
  }
  return true;
}

/** Whether anything in a name is written but never drawn (a filler, a joiner, a tag): such a name is not plain. */
export const hasUndrawn = (name: string): boolean => /\p{Default_Ignorable_Code_Point}/u.test(name);
