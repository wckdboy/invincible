/*
 * What a message of yours may carry (api.ts's AttachmentRef), and what a file is by its bytes: one rule for the node,
 * which checks each file as it comes (packages/node/src/uploads.ts), and for the apps, which say so before it goes.
 * Nothing here depends on anything, so the PWA takes it alone (@galahad/core/attachments).
 */

/** Pictures (PNG, JPEG, WebP, GIF, as their bytes say), which a model that sees is shown; and text (UTF-8). */
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"] as const;

/** At most so many with a message; a picture up to 5 MB (the apps send photos smaller), a text up to 256 KB. */
export const ATTACHMENT_LIMITS = { perMessage: 8, imageBytes: 5 * 1024 * 1024, textBytes: 256 * 1024 } as const;

type Picture = Exclude<(typeof ATTACHMENT_TYPES)[number], "text/plain">;

/** What a picture is, by its first bytes (each format's own signature), or null when it is none of the four. */
export function pictureType(bytes: Uint8Array): Picture | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** A text's words, when its bytes are UTF-8 with no NUL; else null. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
