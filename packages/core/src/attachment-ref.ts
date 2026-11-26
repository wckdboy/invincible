import { z } from "zod";
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES } from "./attachments.ts";

/**
 * What a message of yours may carry, in your chat or at the Roundtable (packages/node/src/uploads.ts): pictures (PNG,
 * JPEG, WebP, GIF, as their bytes say), which a model that sees is shown, and text (UTF-8: a log, a file of code,
 * notes), which goes with the message fenced as data, its name saying what it is. Each is kept on the node by the
 * SHA-256 of its bytes.
 */
export const AttachmentType = z.enum(ATTACHMENT_TYPES);
export type AttachmentType = z.infer<typeof AttachmentType>;
/** A file's name as you gave it: no folders, no control characters. */
export const AttachmentName = z.string().trim().min(1).max(200).regex(/^[^/\\\u0000-\u001f\u007f]+$/, "a file's name, without folders");
export const AttachmentId = z.string().regex(/^[a-f0-9]{64}$/);
export const AttachmentRef = z.strictObject({
  id: AttachmentId,
  name: AttachmentName,
  type: AttachmentType,
  bytes: z.number().int().min(1).max(ATTACHMENT_LIMITS.imageBytes),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;
