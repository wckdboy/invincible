import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTar, safePath } from "../src/tar.ts";

/*
 * Taking files out of a sandbox: the archive is the sandbox's to shape, so these
 * archives are hostile on purpose. Only regular files and directories may land,
 * inside the destination, within the limits.
 */

type Entry = { name: string; type?: string; data?: string; link?: string; pax?: string };

function header(name: string, size: number, type: string, link = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (text: string, at: number, len: number) => h.set(new TextEncoder().encode(text).subarray(0, len), at);
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0001750\0", 108, 8);
  put("0001750\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(link, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

function tar(entries: Entry[], end = true): Uint8Array {
  const parts: Uint8Array[] = [];
  const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);
  for (const e of entries) {
    if (e.pax) {
      const record = ` path=${e.pax}\n`;
      let len = record.length + 2;
      len = record.length + String(len).length;
      const body = new TextEncoder().encode(`${len}${record}`);
      parts.push(header("PaxHeader", body.length, "x"), body, pad(body.length));
    }
    const data = new TextEncoder().encode(e.data ?? "");
    parts.push(header(e.name, e.type === "0" || e.type === undefined ? data.length : 0, e.type ?? "0", e.link ?? ""));
    if (e.type === "0" || e.type === undefined) parts.push(data, pad(data.length));
  }
  if (end) parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Delivered in odd-sized chunks, as a pipe would.
const stream = (bytes: Uint8Array, chunk = 333) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.subarray(i, i + chunk));
      c.close();
    },
  });

const dirs: string[] = [];
const dest = () => {
  const d = mkdtempSync(join(tmpdir(), "galahad-tar-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const limits = { maxBytes: 1 << 20, maxFiles: 100 };

describe("taking files out of a sandbox", () => {
  test("regular files and folders land under the destination, hashed; docker cp's source folder is dropped", async () => {
    const d = dest();
    const result = await extractTar(
      stream(tar([{ name: "out/", type: "5" }, { name: "out/report.md", data: "# Result\n" }, { name: "out/plots/", type: "5" }, { name: "out/plots/a.csv", data: "x,y\n1,2\n" }])),
      d,
      limits,
    );
    expect(result.files.map((f) => f.path)).toEqual(["report.md", "plots/a.csv"]);
    expect(readFileSync(join(d, "plots", "a.csv"), "utf8")).toBe("x,y\n1,2\n");
    expect(result.files[0]!.sha256).toBe(createHash("sha256").update("# Result\n").digest("hex"));
    expect(result.bytes).toBe(17);
    expect(result.skipped).toEqual([]);
  });

  test("links, devices and escapes never land", async () => {
    const d = dest();
    const result = await extractTar(
      stream(
        tar([
          { name: "out/passwd", type: "2", link: "/etc/passwd" },
          { name: "out/hard", type: "1", link: "/etc/shadow" },
          { name: "out/null", type: "3" },
          { name: "out/../../escape.txt", data: "pwned" },
          { name: "/etc/cron.d/evil", data: "pwned" },
          { name: "out/ok.txt", data: "fine" },
        ]),
      ),
      d,
      limits,
    );
    expect(result.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["entry type 3", "link", "link", "unsafe path", "unsafe path"]);
    expect(existsSync(join(d, "passwd"))).toBe(false);
    expect(existsSync(join(d, "..", "escape.txt"))).toBe(false);
    expect(lstatSync(join(d, "ok.txt")).isFile()).toBe(true);
  });

  test("long names come through PAX headers, still checked", async () => {
    const d = dest();
    const long = `out/${"deep/".repeat(30)}file.txt`;
    const result = await extractTar(stream(tar([{ name: "short", pax: long, data: "deep" }, { name: "x", pax: "out/../../up.txt", data: "no" }])), d, limits);
    expect(result.files.map((f) => f.path)).toEqual([`${"deep/".repeat(30)}file.txt`]);
    expect(result.skipped).toEqual([{ path: "out/../../up.txt", reason: "unsafe path" }]);
  });

  test("limits hold while streaming: bytes and file count", async () => {
    await expect(extractTar(stream(tar([{ name: "out/big", data: "x".repeat(2000) }])), dest(), { maxBytes: 1000, maxFiles: 10 })).rejects.toThrow(/more than 0 MB/);
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `out/f${i}`, data: "x" }));
    await expect(extractTar(stream(tar(many)), dest(), { maxBytes: 1 << 20, maxFiles: 3 })).rejects.toThrow(/more than 3 files/);
  });

  test("a truncated archive is an error, not a silent partial result", async () => {
    const whole = tar([{ name: "out/a", data: "y".repeat(3000) }], false);
    await expect(extractTar(stream(whole.subarray(0, 1200)), dest(), limits)).rejects.toThrow(/ends early/);
  });

  test("paths: relative, normalized, never climbing", () => {
    expect(safePath("out/a/./b.txt", 1)).toBe("a/b.txt");
    expect(safePath("out//a", 1)).toBe("a");
    expect(safePath("out/../a", 1)).toBeNull();
    expect(safePath("/abs", 0)).toBeNull();
    expect(safePath("out/a\\b", 1)).toBeNull();
    expect(safePath("out", 1)).toBeNull();
    expect(safePath(`out/${"a/".repeat(40)}x`, 1)).toBeNull();
  });
});
