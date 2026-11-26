import { ATTACHMENT_LIMITS, type AttachmentRef, type ClientIdentity, pictureType, signRequest } from "@galahad/core";

/*
 * A file you sent Galahad through a chat app (a photo, a screenshot, a log), kept on your node as an attachment of your
 * message, the way the apps keep one (uploadAttachment): by what its bytes are, never by what it says it is. A picture
 * in one of the four kinds a model is shown, or text; anything else stays in the chat app, and you're told why.
 */

/** A file's name as a message carries it: no folders, nothing hidden, not too long. */
const nameOf = (name: string): string => name.replace(/[/\\\u0000-\u001f\u007f]+/g, "-").trim().slice(0, 200) || "file";

/** What a file is, by its bytes: a picture's kind, or text; null for anything else (a HEIC photo, a PDF, a zip). */
export function fileKind(bytes: Uint8Array): AttachmentRef["type"] | null {
  const picture = pictureType(bytes);
  if (picture) return picture;
  if (bytes.byteLength > ATTACHMENT_LIMITS.textBytes) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : "text/plain";
  } catch {
    return null;
  }
}

/** Why a file can't go with your message, in a line; null when it can. */
export function refusedFile(bytes: Uint8Array): string | null {
  const kind = fileKind(bytes);
  if (!kind) return "it isn't a picture Galahad is shown (PNG, JPEG, WebP or GIF) or text";
  if (kind === "text/plain" ? bytes.byteLength > ATTACHMENT_LIMITS.textBytes : bytes.byteLength > ATTACHMENT_LIMITS.imageBytes) return `it's over ${kind === "text/plain" ? "256 KB" : "5 MB"}`;
  return null;
}

/** A body read no further than `max` bytes: past it, nothing is kept. */
export async function cappedBytes(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Keep a file you sent on your node, as the chat app's device: the attachment your message then carries, or why not. */
export async function keepFile(o: { apiBase: string; fetch: typeof fetch; device: ClientIdentity }, name: string, bytes: Uint8Array): Promise<{ attachment: AttachmentRef } | { refused: string }> {
  const refused = refusedFile(bytes);
  if (refused) return { refused };
  const path = "/api/uploads";
  const body = new TextEncoder().encode(JSON.stringify({ name: nameOf(name), type: fileKind(bytes), data: Buffer.from(bytes).toString("base64") }));
  const headers = await signRequest(o.device.id, (m) => o.device.sign(m), "POST", path, body);
  const response = await o.fetch(`${o.apiBase}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
  const answer = (await response.json().catch(() => ({}))) as { attachment?: AttachmentRef; error?: string };
  if (!response.ok || !answer.attachment) return { refused: answer.error ?? `your node answered ${response.status}` };
  return { attachment: answer.attachment };
}
