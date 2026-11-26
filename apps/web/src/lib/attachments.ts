import type { AttachmentRef, AttachmentType } from "@galahad/core";
import { ATTACHMENT_LIMITS, pictureType, textOf } from "@galahad/core/attachments";
import type { Api } from "../api.ts";
import { imageDataUrl } from "./artifacts.ts";

/*
 * Files you attach to a message (the node keeps them: packages/node/src/uploads.ts). A picture is drawn again before it
 * goes, at most so many pixels on its long side and as a JPEG (a PNG stays a PNG while it fits), which leaves its
 * metadata behind (where a photo was taken, the camera); a GIF goes as it is. Anything else must be text (UTF-8).
 * What a file is, is read from its bytes by the node's own rule (@galahad/core/attachments), never from its name.
 */

/** What the file picker offers: pictures, and the kinds of text one attaches (logs, notes, code, data). */
export const ATTACH_ACCEPT = [
  "image/*",
  "text/*",
  "application/json",
  ...".md .log .txt .csv .tsv .json .yaml .yml .toml .ini .xml .html .css .sql .diff .patch .sh .ts .tsx .js .jsx .mjs .py .go .rs .swift .kt .java .c .h .cpp .rb .php".split(" "),
].join(",");

/** A picture's long side, at most: what Claude scales a picture down to anyway, so more would only cost more. */
export const PICTURE_SIDE = 1568;

type Picture = Exclude<AttachmentType, "text/plain">;

/** Bytes as base64, a chunk at a time (a picture of megabytes is too many arguments for one call). */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A file's name as the node takes it: no folders, no control characters, at most 200 characters. */
export function nameOf(name: string): string {
  const clean = (name.split(/[/\\]/).at(-1) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean || "file";
}

/** A file ready to go up: its bytes, what they are, and (a picture) how it looks, to show. */
export interface Prepared {
  name: string;
  type: AttachmentType;
  bytes: Uint8Array;
  preview: string | null;
}

/** Why a file can't go with a message, in words; null when it can (what `prepare` would take). */
export function refusal(name: string, type: AttachmentType | null, size: number): string | null {
  if (!type) return `${name} isn't a picture or text: only those go with a message.`;
  if (size === 0) return `${name} is empty.`;
  const limit = type === "text/plain" ? ATTACHMENT_LIMITS.textBytes : ATTACHMENT_LIMITS.imageBytes;
  return size > limit ? `${name} is too big: ${type === "text/plain" ? "a text" : "a picture"} goes with a message up to ${Math.round(limit / 1024) >= 1024 ? `${limit / 1024 ** 2} MB` : `${limit / 1024} KB`}.` : null;
}

/** A picture drawn again, at most PICTURE_SIDE on its long side, as a PNG (where it was one and still fits) or a JPEG. */
async function redrawn(file: Blob, was: Picture | null): Promise<{ bytes: Uint8Array; type: "image/png" | "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext("2d");
    if (!g) throw new Error("this browser can't draw the picture");
    if (was !== "image/png") {
      // A JPEG has no transparency: what was clear is drawn on white.
      g.fillStyle = "#fff";
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const as = async (type: "image/png" | "image/jpeg") => {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.86));
      if (!blob) throw new Error("this browser couldn't make the picture smaller");
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type };
    };
    if (was === "image/png") {
      const png = await as("image/png");
      if (png.bytes.length <= ATTACHMENT_LIMITS.imageBytes) return png;
    }
    return as("image/jpeg");
  } finally {
    bitmap.close();
  }
}

/** A file you chose (or pasted, or dropped), made ready to go up, or why it can't. */
export async function prepare(file: File): Promise<Prepared | { problem: string }> {
  const name = nameOf(file.name || (file.type.startsWith("image/") ? "picture" : "file"));
  const original = new Uint8Array(await file.arrayBuffer());
  const was = pictureType(original);
  // A GIF goes as it is (drawn again, it would lose its frames); every other picture, and one this browser reads that
  // isn't one of the four (HEIC), is drawn again.
  if (was === "image/gif") {
    const why = refusal(name, was, original.length);
    return why ? { problem: why } : { name, type: was, bytes: original, preview: imageDataUrl(original, was) };
  }
  if (was || file.type.startsWith("image/")) {
    try {
      const { bytes, type } = await redrawn(file, was);
      const why = refusal(name, type, bytes.length);
      return why ? { problem: why } : { name: type === "image/jpeg" ? name.replace(/\.(png|webp|heic|heif|jpeg|tiff?|bmp|avif)$/i, ".jpg") : name, type, bytes, preview: imageDataUrl(bytes, type) };
    } catch {
      return { problem: `${name} is a picture this browser can't read: save it as a JPEG or PNG first.` };
    }
  }
  const why = refusal(name, textOf(original) !== null ? "text/plain" : null, original.length);
  return why ? { problem: why } : { name, type: "text/plain", bytes: original, preview: null };
}

/** Sent up to the node: what the message then carries. */
export async function upload(api: Api, file: Prepared): Promise<AttachmentRef> {
  const { attachment } = await api.post<{ attachment: AttachmentRef }>("/api/uploads", { name: file.name, type: file.type, data: base64Of(file.bytes) });
  return attachment;
}

/** What each picture looks like, by its id: shown in a chat once, from here after (a page's own memory, never kept). */
const looks = new Map<string, Promise<string | null>>();

/** A picture's look, to show it: from what was sent from here, or asked of the node once. */
export function lookOf(api: Api, ref: AttachmentRef): Promise<string | null> {
  if (ref.type === "text/plain") return Promise.resolve(null);
  let look = looks.get(ref.id);
  if (!look) {
    look = api
      .bytes("/api/uploads/get", { id: ref.id })
      .then(({ data }) => imageDataUrl(data, ref.type))
      .catch(() => {
        looks.delete(ref.id);
        return null;
      });
    looks.set(ref.id, look);
  }
  return look;
}

/** A picture sent from here: its look is known already, so the chat shows it without asking the node. */
export function knownLook(ref: AttachmentRef, preview: string | null): void {
  if (preview) looks.set(ref.id, Promise.resolve(preview));
}
