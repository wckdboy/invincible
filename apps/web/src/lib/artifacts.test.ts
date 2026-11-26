import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  archiveName,
  bytesLabel,
  canDownloadAll,
  fileKind,
  groupFiles,
  imageDataUrl,
  previewText,
  removeName,
  sha256Hex,
  shortSha,
  shownAs,
  tarArchive,
  tarName,
} from "./artifacts.ts";

const enc = new TextEncoder();
const file = (path: string, size = 1) => ({ path, size, sha256: "ab".repeat(32) });

/** A minimal ustar reader, to check what the writer wrote. */
function untar(tar: Uint8Array): { path: string; text: string; checksumOk: boolean }[] {
  const dec = new TextDecoder();
  const field = (h: Uint8Array, at: number, len: number) => dec.decode(h.subarray(at, at + len)).replace(/\0.*$/s, "");
  const out: { path: string; text: string; checksumOk: boolean }[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = parseInt(field(header, 124, 12), 8);
    const stored = parseInt(field(header, 148, 8), 8);
    const copy = header.slice();
    copy.fill(32, 148, 156);
    const sum = copy.reduce((n, b) => n + b, 0);
    out.push({ path: prefix ? `${prefix}/${name}` : name, text: dec.decode(tar.subarray(at + 512, at + 512 + size)), checksumOk: sum === stored });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("artifacts as people read them", () => {
  test("sizes and short hashes", () => {
    expect(bytesLabel(0)).toBe("0 B");
    expect(bytesLabel(812)).toBe("812 B");
    expect(bytesLabel(4300)).toBe("4.2 KB");
    expect(bytesLabel(1024 * 1024)).toBe("1 MB");
    expect(bytesLabel(1.34 * 2 ** 30)).toBe("1.3 GB");
    expect(bytesLabel(250 * 2 ** 20)).toBe("250 MB");
    expect(shortSha("0123456789abcdef".repeat(4))).toBe("0123456789ab");
  });

  test("files group by folder: top level first, folders and names in order", () => {
    const groups = groupFiles([file("plots/b.png"), file("report.md"), file("data/u.csv"), file("plots/a.png"), file("README")]);
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.path)])).toEqual([
      ["", ["README", "report.md"]],
      ["data", ["data/u.csv"]],
      ["plots", ["plots/a.png", "plots/b.png"]],
    ]);
  });

  test("what can be shown: Markdown rendered, HTML and SVG as source, raster images inline, the rest saved", () => {
    expect(fileKind("report.md")).toBe("markdown");
    expect(fileKind("index.html")).toBe("source");
    expect(fileKind("figure.svg")).toBe("source");
    expect(fileKind("data/u.csv")).toBe("text");
    expect(fileKind("README")).toBe("text");
    expect(fileKind("plots/mode1.PNG")).toBe("image");
    expect(fileKind("bracket.stl")).toBe("download");
    expect(fileKind("paper.pdf")).toBe("download");
    expect(fileKind("notes.markdown")).toBe("download");
  });

  test("what the node sent decides: never an image it didn't call raster, never HTML rendered", () => {
    expect(shownAs("markdown", "text/plain; charset=utf-8")).toBe("markdown");
    expect(shownAs("source", "text/plain; charset=utf-8")).toBe("source");
    expect(shownAs("image", "image/png")).toBe("image");
    expect(shownAs("image", "image/svg+xml")).toBe("download");
    expect(shownAs("source", "text/html")).toBe("download");
    expect(shownAs("text", "application/octet-stream")).toBe("download");
    expect(shownAs("download", "image/jpeg")).toBe("image");
  });

  test("text previews are clipped, and bad UTF-8 never throws", () => {
    expect(previewText(enc.encode("x".repeat(10)), 4)).toEqual({ text: "xxxx", clipped: true });
    expect(previewText(new Uint8Array([0x68, 0xff, 0x69])).text).toBe("h�i");
  });

  test("SHA-256 matches the node's (hex)", async () => {
    const bytes = enc.encode("# Beam\nδ = 1.67 mm\n");
    expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("images become data: URLs, raster types only", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(imageDataUrl(png, "image/png")).toBe("data:image/png;base64,iVBORw==");
    expect(imageDataUrl(png, "image/svg+xml")).toBeNull();
    expect(imageDataUrl(png, "text/html")).toBeNull();
    // Large images are encoded in chunks (no call-stack limit).
    expect(imageDataUrl(new Uint8Array(300_000), "image/png")!.length).toBeGreaterThan(400_000);
  });

  test("Download all only when every file is listed and it fits in memory", () => {
    expect(canDownloadAll({ bytes: 1000, count: 2, files: [1, 2] })).toBe(true);
    expect(canDownloadAll({ bytes: 1000, count: 300, files: new Array(200) })).toBe(false);
    expect(canDownloadAll({ bytes: 300 * 2 ** 20, count: 1, files: [1] })).toBe(false);
    expect(canDownloadAll({ bytes: 0, count: 0, files: [] })).toBe(false);
  });

  test("removing asks you to type the label, or the short id when the label is long", () => {
    expect(removeName({ id: "art_abcdefghijklmnopqrstuv", label: "Cantilever check" })).toBe("Cantilever check");
    expect(removeName({ id: "art_abcdefghijklmnopqrstuv", label: "x".repeat(60) })).toBe("abcdefgh");
  });
});

describe("Download all: a tar file", () => {
  test("files round-trip with valid checksums and padding", () => {
    const { tar, skipped } = tarArchive(
      [
        { path: "report.md", bytes: enc.encode("# Beam\n") },
        { path: "plots/mode1.png", bytes: new Uint8Array(513) },
        { path: "empty.txt", bytes: new Uint8Array() },
      ],
      1_700_000_000,
    );
    expect(skipped).toEqual([]);
    expect(tar.length % 512).toBe(0);
    const entries = untar(tar);
    expect(entries.map((e) => e.path)).toEqual(["report.md", "plots/mode1.png", "empty.txt"]);
    expect(entries[0]!.text).toBe("# Beam\n");
    expect(entries.every((e) => e.checksumOk)).toBe(true);
  });

  test("long paths split into prefix and name; ones that can't fit are left out and named", () => {
    const deep = `${"d".repeat(120)}/${"f".repeat(90)}.txt`;
    expect(tarName(deep)).not.toBeNull();
    const { tar, skipped } = tarArchive([
      { path: deep, bytes: enc.encode("ok") },
      { path: "x".repeat(300), bytes: enc.encode("no") },
    ]);
    expect(skipped).toEqual(["x".repeat(300)]);
    expect(untar(tar).map((e) => e.path)).toEqual([deep]);
  });

  test("archive names are safe on any file system", () => {
    expect(archiveName("Cantilever check: δ/L")).toBe("Cantilever-check-L.tar");
    expect(archiveName("***")).toBe("artifact.tar");
  });
});
