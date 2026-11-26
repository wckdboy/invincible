export type Bytes = Uint8Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** ArrayBuffer-backed, so it can go straight into fetch bodies and WebCrypto. */
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);
export const fromUtf8 = (bytes: Bytes): string => decoder.decode(bytes);

const B64U = /^[A-Za-z0-9_-]*$/;

export function b64u(bytes: Bytes): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(text: string): Bytes {
  if (!B64U.test(text) || text.length % 4 === 1) throw new Error("invalid base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time comparison for secrets and MACs. */
export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

export const randomId = (bytes = 16): string => b64u(randomBytes(bytes));
