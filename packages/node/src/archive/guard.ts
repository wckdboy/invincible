import { findSecrets } from "@galahad/core/secret-scan";

/*
 * What never enters the archive. Everything the archive keeps may one day be embedded
 * (sent to the embedder), summarised (sent to the swift role) and replicated (to R2),
 * so it is checked here first, every text and every file:
 *
 *   - secret-shaped text is redacted (and the entry says what, and where);
 *   - key material and session files are refused outright (and the entry says so);
 *   - the bank never gets here: its chats are skipped at the source.
 */

export interface Redaction {
  where: string;
  kind: string;
}

/** Text with anything secret-shaped replaced by a marker, and what was taken out. */
export function scrub(text: string, where: string): { text: string; redactions: Redaction[] } {
  // One key can match several patterns (an Anthropic key is also an sk-… key): one redaction per span.
  const spans: { index: number; end: number; kind: string }[] = [];
  for (const f of findSecrets(text)) {
    const last = spans.at(-1);
    if (last && f.index < last.end) last.end = Math.max(last.end, f.index + f.length);
    else spans.push({ index: f.index, end: f.index + f.length, kind: f.kind });
  }
  if (!spans.length) return { text, redactions: [] };
  let out = text;
  for (const s of [...spans].reverse()) out = `${out.slice(0, s.index)}[redacted ${s.kind}]${out.slice(s.end)}`;
  return { text: out, redactions: spans.map((s) => ({ where, kind: s.kind })) };
}

/** Names that hold keys, credentials or sessions: never stored, whatever they contain. */
const KEY_FILES = [
  /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ppk|gpg|pgp|age)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.?env(\.[\w.-]+)?$/i,
  /\.env$/i,
  /(^|\/)\.(netrc|npmrc|pypirc|pgpass|git-credentials)$/i,
  /(^|\/)(credentials|secrets?|tokens?|keys|keychain|wallet)(\.[\w-]+)?\.(json|ya?ml|toml|txt|ini|db)$/i,
  /(^|\/)(cookies|sessions?)(\.[\w-]+)?\.(json|txt|sqlite|db)$/i,
  /(^|\/)(admin|auth|access|refresh|bearer)[._-]?token(\.\w+)?$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.galahad\//i,
];

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|PuTTY-User-Key-File-/;

/** Why a file must never be stored, or null when it may be. */
export function refuseFile(path: string, bytes: Uint8Array): string | null {
  if (KEY_FILES.some((re) => re.test(path))) return "key material or a session file (by its name)";
  // A private key in any file at all, text or not (a key pasted into a notebook, a keystore).
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256 * 1024));
  if (PRIVATE_KEY.test(head)) return "it holds a private key";
  return null;
}
