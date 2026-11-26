import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressedJson, pickEncoding } from "../src/compress.ts";

/*
 * What the PWA reads (the ledger, every 10 s on Activity) goes compressed: a phone on
 * cellular pays a tenth of the bytes. Small answers aren't worth it and stay as they are.
 */

const big = { entries: Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, resource: "connector.site", target: "GET /status", verdict: "allow", reason: "read is within Galahad's freedom (logged)" })) };
const request = (accept: string | null) => new Request("https://node.test/api/ledger", { headers: accept ? { "accept-encoding": accept } : {} });

describe("compressed answers", () => {
  test("the browser's preference: brotli, else gzip, never what it refused", () => {
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(pickEncoding("gzip, deflate")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("identity")).toBeNull();
    expect(pickEncoding(null)).toBeNull();
  });

  test("a large answer goes compressed and comes back the same", async () => {
    const text = JSON.stringify(big);
    const br = compressedJson(big, request("gzip, br"), {});
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    const bytes = new Uint8Array(await br.arrayBuffer());
    expect(bytes.length).toBeLessThan(text.length / 5);
    expect(brotliDecompressSync(bytes).toString("utf8")).toBe(text);
    const gz = compressedJson(big, request("gzip"), { "x-frame-options": "DENY" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("x-frame-options")).toBe("DENY");
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString("utf8")).toBe(text);
  });

  test("a small answer, or a browser that takes none, gets plain JSON", async () => {
    expect(compressedJson({ ok: true }, request("br"), {}).headers.get("content-encoding")).toBeNull();
    const plain = compressedJson(big, request(null), {});
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.json()).toEqual(big);
  });
});
