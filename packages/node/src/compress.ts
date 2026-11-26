import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/*
 * Compression for what the node sends the PWA: the app's files (assets.ts) and the
 * larger API answers it reads again and again (the ledger, the lists). Pure functions.
 */

/** The encoding to send, from the browser's Accept-Encoding: brotli, else gzip, else none. */
export function pickEncoding(accept: string | null): "br" | "gzip" | null {
  const offered = new Map(
    (accept ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => {
        const [name, ...params] = part.trim().split(";");
        const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        return [name!.trim(), q ? Number(q.slice(2)) : 1] as const;
      }),
  );
  if ((offered.get("br") ?? 0) > 0) return "br";
  if ((offered.get("gzip") ?? 0) > 0) return "gzip";
  return null;
}

export const brotli = (bytes: Uint8Array, quality: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
export const gzip = (bytes: Uint8Array, level: number): Uint8Array<ArrayBuffer> => new Uint8Array(gzipSync(bytes, { level }));

/** Below this an answer goes as it is: compressing would cost more than it saves. */
const MIN_BYTES = 1024;

/** A JSON answer, compressed (fast settings: it's made per request) when it's large and the browser takes it. */
export function compressedJson(body: unknown, request: Request, headers: Record<string, string>, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const base = { "content-type": "application/json", ...headers, vary: "Accept-Encoding" };
  const encoding = bytes.length >= MIN_BYTES ? pickEncoding(request.headers.get("accept-encoding")) : null;
  if (encoding === "br") return new Response(brotli(bytes, 5), { status, headers: { ...base, "content-encoding": "br" } });
  if (encoding === "gzip") return new Response(gzip(bytes, 6), { status, headers: { ...base, "content-encoding": "gzip" } });
  return new Response(bytes, { status, headers: base });
}
