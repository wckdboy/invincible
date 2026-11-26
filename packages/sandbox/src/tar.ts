import { createHash } from "node:crypto";
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

/*
 * Taking files out of a sandbox safely. `docker cp <sandbox>:/work/out -` streams a
 * tar archive the sandbox's contents decide, so it's parsed here, by hand, with
 * the sandbox treated as hostile:
 *
 *   - only regular files and directories are written; symlinks, hard links,
 *     devices and FIFOs are skipped (a link could point at the host's files)
 *   - paths are relative, normalized, and never climb out (no "..", no "/")
 *   - total bytes and file count are capped while streaming, so an archive can't
 *     fill the host's disk before the check
 *   - every file is hashed as it's written
 */

export interface ExtractLimits {
  maxBytes: number;
  maxFiles: number;
}

export interface ExtractedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ExtractResult {
  files: ExtractedFile[];
  bytes: number;
  /** Entries refused (links, devices, unsafe paths), by reason. */
  skipped: { path: string; reason: string }[];
}

export class ExtractError extends Error {}

const BLOCK = 512;

function octal(field: Uint8Array): number {
  // GNU base-256 for large sizes: high bit set on the first byte.
  if (field[0]! & 0x80) {
    let n = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const text = new TextDecoder().decode(field).replace(/\0.*$/s, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

const cstring = (field: Uint8Array) => new TextDecoder().decode(field).replace(/\0.*$/s, "");

/** A safe relative path, or null. `strip` drops the leading components (docker cp's source directory name). */
export function safePath(raw: string, strip = 0): string | null {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) return null;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  const kept = parts.slice(strip);
  if (!kept.length || kept.length > 32) return null;
  const path = kept.join("/");
  if (path.length > 512 || /[\u0000-\u001f]/.test(path)) return null;
  return path;
}

function paxPath(data: Uint8Array): string | null {
  // "len key=value\n" records; only the path matters here.
  const text = new TextDecoder().decode(data);
  for (const record of text.split("\n")) {
    const m = record.match(/^\d+ path=(.*)$/s);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Extract a tar stream into `dest`. Throws ExtractError (after writing nothing further)
 * when a limit is crossed; what was already written stays for the caller to remove.
 */
export async function extractTar(stream: ReadableStream<Uint8Array>, dest: string, limits: ExtractLimits, strip = 1): Promise<ExtractResult> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let done = false;
  const result: ExtractResult = { files: [], bytes: 0, skipped: [] };

  const fill = async (need: number): Promise<boolean> => {
    while (buffer.length < need && !done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      const next = new Uint8Array(buffer.length + chunk.value.length);
      next.set(buffer);
      next.set(chunk.value, buffer.length);
      buffer = next;
    }
    return buffer.length >= need;
  };
  const take = (n: number): Uint8Array => {
    const out = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    return out;
  };

  let longName: string | null = null;
  try {
    for (;;) {
      if (!(await fill(BLOCK))) break;
      const header = take(BLOCK);
      if (header.every((b) => b === 0)) break; // end of archive
      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156]!) || "0";
      const magic = cstring(header.subarray(257, 263));
      const prefix = magic.startsWith("ustar") ? cstring(header.subarray(345, 500)) : "";
      let name = longName ?? (prefix ? `${prefix}/${cstring(header.subarray(0, 100))}` : cstring(header.subarray(0, 100)));
      longName = null;
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      if (type === "x" || type === "L") {
        if (size > 64 * 1024) throw new ExtractError("an extended header is too large");
        if (!(await fill(padded))) throw new ExtractError("the archive ends early");
        const data = take(padded).subarray(0, size);
        longName = type === "L" ? cstring(data) : paxPath(data);
        continue;
      }

      const path = safePath(name, strip);
      if (type === "0" || type === "\0" || type === "7") {
        if (!path) {
          if (name.split("/").filter(Boolean).length > strip) result.skipped.push({ path: name.slice(0, 200), reason: "unsafe path" });
          await discard(padded);
          continue;
        }
        if (result.files.length + 1 > limits.maxFiles) throw new ExtractError(`more than ${limits.maxFiles} files`);
        if (result.bytes + size > limits.maxBytes) throw new ExtractError(`more than ${Math.round(limits.maxBytes / 2 ** 20)} MB`);
        const parts = path.split("/");
        if (parts.length > 1) mkdirSync(join(dest, ...parts.slice(0, -1)), { recursive: true });
        const fd = openSync(join(dest, ...parts), "wx", 0o644);
        const hash = createHash("sha256");
        try {
          let left = size;
          while (left > 0) {
            // Whatever is buffered, else one more chunk: data streams through, never re-concatenated.
            if (!buffer.length && !(await fill(1))) throw new ExtractError("the archive ends early");
            const piece = take(Math.min(left, buffer.length));
            hash.update(piece);
            writeSync(fd, piece);
            left -= piece.length;
          }
        } finally {
          closeSync(fd);
        }
        await discard(padded - size);
        result.bytes += size;
        result.files.push({ path, size, sha256: hash.digest("hex") });
      } else if (type === "5") {
        if (path) mkdirSync(join(dest, ...path.split("/")), { recursive: true });
        await discard(padded);
      } else {
        // Links, devices, FIFOs, global headers: never written.
        if (type !== "g") result.skipped.push({ path: name.slice(0, 200), reason: type === "2" || type === "1" ? "link" : `entry type ${type}` });
        await discard(padded);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return result;

  async function discard(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (!buffer.length && !(await fill(1))) throw new ExtractError("the archive ends early");
      left -= take(Math.min(left, buffer.length)).length;
    }
  }
}
