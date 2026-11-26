/*
 * Artifacts as people read them: sizes, a file list grouped by folder, what can
 * be previewed and how, the SHA-256 check, and "Download all" as one tar file.
 * The node decides how it serves each file (packages/node/src/artifacts.ts); this
 * mirrors it and never trusts more than it says. Pure, so unit-tested.
 */

export interface ArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

/** "0 B", "812 B", "4.2 KB", "1.3 MB", "2.1 GB". */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

/** The first 12 hex digits, enough to tell files apart at a glance. */
export const shortSha = (sha256: string): string => sha256.slice(0, 12);

/** A file's name without its folders. */
export const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** Files grouped by folder: top level first, then folders in order; names in order within each. */
export function groupFiles<T extends ArtifactFile>(files: T[]): { dir: string; files: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const at = file.path.lastIndexOf("/");
    const dir = at > 0 ? file.path.slice(0, at) : "";
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, files: list.sort((x, y) => x.path.localeCompare(y.path)) }));
}

/** The node's own lists: text and raster images are shown inline; HTML and SVG only ever as source. */
const TEXT = new Set(["txt", "md", "csv", "tsv", "json", "log", "py", "ts", "js", "rs", "c", "h", "cpp", "hpp", "f90", "m", "jl", "toml", "yaml", "yml", "xml", "ini", "cfg", "tex", "sh", "svg", "html", "dat", "out", "cir", "geo", "step", "stp", "obj"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
/** The only image types ever put in an <img>. Never SVG: it can carry script. */
export const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type FileKind = "markdown" | "source" | "text" | "image" | "download";

/** How a file can be shown, from its name: Markdown rendered, HTML and SVG as source, text as text, raster images inline; the rest downloads. */
export function fileKind(path: string): FileKind {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (IMAGES.has(ext)) return "image";
  if (ext === "md") return "markdown";
  if (ext === "html" || ext === "svg") return "source";
  if (TEXT.has(ext) || !ext) return "text";
  return "download";
}

/**
 * What the node actually sent decides, whatever the name says: text/plain is
 * shown as text, the four raster types as an image, anything else is only saved.
 */
export function shownAs(kind: FileKind, contentType: string): FileKind {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "text/plain") return kind === "markdown" || kind === "source" ? kind : "text";
  if (RASTER.has(type)) return "image";
  return "download";
}

/** Text to show, clipped so a huge log can't stall the page. */
export function previewText(bytes: Uint8Array, max = 512 * 1024): { text: string; clipped: boolean } {
  const clipped = bytes.length > max;
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(clipped ? bytes.subarray(0, max) : bytes), clipped };
}

/** The SHA-256 of these bytes, as lowercase hex (WebCrypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An image's bytes as a data: URL (the app's CSP allows data: images, not blob:). Raster types only. */
export function imageDataUrl(bytes: Uint8Array, type: string): string | null {
  const clean = type.split(";")[0]!.trim().toLowerCase();
  if (!RASTER.has(clean)) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${clean};base64,${btoa(binary)}`;
}

/** "Download all" builds the archive here, in memory: up to this much, and only when every file is listed. */
export const DOWNLOAD_ALL_MAX = 200 * 2 ** 20;
export const canDownloadAll = (a: { bytes: number; count: number; files: unknown[] }): boolean => a.files.length === a.count && a.count > 0 && a.bytes <= DOWNLOAD_ALL_MAX;

/** What to type before removing kept work: its label when short enough to type, else its short id. */
export const removeName = (a: { id: string; label: string }): string => (a.label.length <= 48 ? a.label : a.id.slice(4, 12));

const enc = new TextEncoder();

/** A ustar name: the path whole (≤ 100 bytes), or split at a "/" into prefix (≤ 155) and name (≤ 100); null when it can't fit. */
export function tarName(path: string): { name: Uint8Array; prefix: Uint8Array } | null {
  const whole = enc.encode(path);
  if (whole.length <= 100) return { name: whole, prefix: new Uint8Array() };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = enc.encode(path.slice(0, i));
    const name = enc.encode(path.slice(i + 1));
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
  }
  return null;
}

/**
 * A tar archive (ustar) of these files, opened natively on Linux, macOS and
 * Windows. Paths that don't fit ustar are left out and named, never truncated.
 */
export function tarArchive(entries: { path: string; bytes: Uint8Array }[], mtime = Math.floor(Date.now() / 1000)): { tar: Uint8Array; skipped: string[] } {
  const blocks: Uint8Array[] = [];
  const skipped: string[] = [];
  const octal = (value: number, width: number) => enc.encode(value.toString(8).padStart(width - 1, "0") + "\0");
  for (const entry of entries) {
    const name = tarName(entry.path);
    if (!name) {
      skipped.push(entry.path);
      continue;
    }
    const header = new Uint8Array(512);
    header.set(name.name, 0);
    header.set(octal(0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(entry.bytes.length, 12), 124);
    header.set(octal(mtime, 12), 136);
    header.set(enc.encode("        "), 148); // the checksum counts its own field as spaces
    header[156] = "0".charCodeAt(0);
    header.set(enc.encode("ustar\0"), 257);
    header.set(enc.encode("00"), 263);
    header.set(name.prefix, 345);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header, entry.bytes, new Uint8Array((512 - (entry.bytes.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    tar.set(block, at);
    at += block.length;
  }
  return { tar, skipped };
}

/** A file name for the archive: the label, made safe for any file system. */
export function archiveName(label: string): string {
  const safe = label
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe || "artifact"}.tar`;
}
