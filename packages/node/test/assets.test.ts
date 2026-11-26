import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAssets } from "../src/assets.ts";

const STATIC_IMPORT = /\bimport\s*[{*"']|\bimport\s+[\w$]/;

describe("the PWA bundle", () => {
  test("a page he made runs its code in a frame of its own: sandboxed, nothing from the network, framed by the app alone", async () => {
    const assets = await buildAssets();
    const frame = assets.serve("/frame.html");
    const policy = frame.headers.get("content-security-policy") ?? "";
    for (const rule of ["sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'", "img-src data: blob:", "form-action 'none'", "frame-ancestors 'self'"]) expect([rule, policy.includes(rule)]).toEqual([rule, true]);
    // Nothing it may load from, the app's own address included: only the app may frame it.
    expect(policy.replace("frame-ancestors 'self'", "")).not.toMatch(/'self'|https?:/);
    expect(frame.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    // It takes a page only from the app that framed it.
    expect(await frame.text()).toContain("event.source !== parent");
    // Everything else stays unframeable, under the app's own policy.
    expect(assets.serve("/").headers.get("x-frame-options")).toBe("DENY");
    expect(assets.serve("/app.js").headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("builds and is served with a strict CSP", async () => {
    const assets = await buildAssets();

    const index = assets.serve("/");
    const html = await index.text();
    expect(html).not.toContain("failed to build");
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('<script src="/boot.js"></script>');
    expect(html).toContain('rel="manifest"');
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(index.headers.get("x-frame-options")).toBe("DENY");
    // No inline scripts or inline event handlers: the CSP would block them anyway.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);

    // Five bundles and no more (the 3D world's own bundle and its models went with it).
    expect(assets.has("/world.js")).toBe(false);
    for (const path of ["/app.js", "/boot.js", "/pair.js", "/sw.js", "/term.js"]) {
      expect(assets.has(path)).toBe(true);
      const response = assets.serve(path);
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(response.headers.get("content-security-policy")).toBeTruthy();
      expect((await response.text()).length).toBeGreaterThan(path === "/app.js" ? 5_000 : 200);
    }

    const manifest = JSON.parse(await assets.serve("/manifest.webmanifest").text());
    expect(manifest.name).toBe("Galahad");
    expect(manifest.display).toBe("standalone");
    // One app however its address is written later: its identity is its own, not derived from where it starts.
    expect(manifest.id).toBe("/");
    // Holding the icon (Android) offers the three places.
    expect(manifest.shortcuts.map((shortcut: { url: string }) => shortcut.url)).toEqual(["/#/chat", "/#/team", "/#/inbox"]);
    // Its icon is Galahad's field, rendered (scripts/field-icon.ts): pictures at the sizes installers take.
    expect(manifest.icons[0].src).toBe("/icon-192.png");
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons as { src: string }[]) expect(assets.has(icon.src)).toBe(true);
  });

  test("the page goes without its stylesheet's comments, and with every one of its rules", async () => {
    const source = readFileSync(join(import.meta.dir, "../../../apps/web/src/index.html"), "utf8");
    const sent = await (await buildAssets()).serve("/").text();
    const style = (html: string) => html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
    expect(style(source)).toContain("/*");
    expect(style(sent)).not.toContain("/*");
    expect(rules(style(sent))).toBe(rules(style(source)));
    // Outside the stylesheet, the page is as it is written.
    expect(sent.slice(sent.indexOf("</style>"))).toBe(source.slice(source.indexOf("</style>")));
    expect(sent.slice(0, sent.indexOf("<style>"))).toBe(source.slice(0, source.indexOf("<style>")));
  });

  test("raster icons are real PNGs, and iOS gets one", async () => {
    const assets = await buildAssets();
    const html = await assets.serve("/").text();
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const path of ["/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/icon-mono-96.png"]) {
      const response = assets.serve(path);
      expect(response.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual(PNG);
      // Width and height live in the IHDR chunk; a render that went wrong would not be square.
      const view = new DataView(bytes.buffer);
      expect(view.getUint32(16)).toBe(view.getUint32(20));
    }
    // The notification badge is a silhouette: colour and alpha (type 6), so Android can draw it from the alpha alone.
    expect(new Uint8Array(await assets.serve("/icon-mono-96.png").arrayBuffer())[25]).toBe(6);
  });

  test("the knights' drawings are served as WebP, every one the app can show, and nothing beside them", async () => {
    const assets = await buildAssets();
    for (const name of ["galahad", "galahad@2x", "black-knight", "black-knight@2x", "kay", "gaheris", "percival", "palamedes", "gawain", "tristan", "lancelot", "bedivere", "bors", "gareth"]) {
      expect(assets.has(`/knights/${name}.webp`)).toBe(true);
      const response = assets.serve(`/knights/${name}.webp`);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("content-encoding")).toBeNull();
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(new TextDecoder("latin1").decode(bytes.slice(0, 4)) + new TextDecoder("latin1").decode(bytes.slice(8, 12))).toBe("RIFFWEBP");
    }
    for (const path of ["/knights/", "/knights/merlin.webp", "/knights/../index.html", "/knights/galahad.png"]) expect(assets.has(path)).toBe(false);
  });

  test("the app's typeface is its own: Geist, served from the node with its licence beside it, never fetched elsewhere", async () => {
    const assets = await buildAssets();
    const html = await assets.serve("/").text();
    const faces = [...html.matchAll(/url\("([^"]+)"\) format\("woff2"\)/g)].map((match) => match[1]!);
    expect(faces).toEqual(["/fonts/geist.woff2"]);
    expect(html).toContain('<link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin />');
    const font = assets.serve("/fonts/geist.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(new TextDecoder("latin1").decode(new Uint8Array(await font.arrayBuffer()).slice(0, 4))).toBe("wOF2");
    expect(readFileSync(join(import.meta.dir, "../../../apps/web/src/fonts/OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
    // Nothing from another origin: the CSP would refuse it anyway.
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  test("every entry is self-contained, so the service worker can cache the shell by name", async () => {
    const assets = await buildAssets();
    for (const path of ["/app.js", "/boot.js", "/pair.js", "/sw.js", "/term.js"]) {
      expect(await assets.serve(path).text()).not.toMatch(STATIC_IMPORT);
    }
    // boot.js runs as a classic script before first paint: no module syntax at all.
    expect(await assets.serve("/boot.js").text()).not.toMatch(/\bexport\b/);
  });

  test("the browser bundles carry no server-only code and no HTML-string sinks", async () => {
    const assets = await buildAssets();
    // (The terminal's too: what a sandbox prints is drawn by the emulator, never parsed as HTML.)
    for (const path of ["/app.js", "/pair.js", "/term.js"]) {
      const code = await assets.serve(path).text();
      expect(code).not.toContain("bun:sqlite");
      expect(code).not.toContain("@anthropic-ai/sdk");
      // Model output, memories and device names are only ever set as text.
      expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/);
      expect(code).not.toMatch(/localStorage\.setItem\([^)]*(secret|key-value|chat)/i);
      expect(code).not.toMatch(/sessionStorage|indexedDB\.open\([^)]*chat/i);
    }
  });

  test("daily use doesn't load the terminal emulator; a terminal does", async () => {
    const assets = await buildAssets();
    const app = await assets.serve("/app.js").text();
    const term = await assets.serve("/term.js").text();
    expect(app).toContain("/term.js");
    expect(term).toContain("xterm-helper-textarea");
    expect(app).not.toContain("xterm-helper-textarea");
    expect(term).not.toMatch(/\beval\(|new Function\(/);
  });

  test("daily use doesn't load the pairing schema; the pairing bundle does", async () => {
    const assets = await buildAssets();
    const app = await assets.serve("/app.js").text();
    const pair = await assets.serve("/pair.js").text();
    expect(app).toContain("/pair.js");
    expect(pair).toContain("invalid_type"); // zod, for the invite schema
    expect(app).not.toContain("invalid_type");
  });

  test("the shell goes compressed to a browser that takes it, and a copy it already has costs a 304", async () => {
    const assets = await buildAssets();
    const plain = assets.serve("/app.js");
    const body = await plain.text();
    const etag = plain.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(plain.headers.get("vary")).toBe("Accept-Encoding");

    const br = assets.serve("/app.js", new Request("https://node.test/app.js", { headers: { "accept-encoding": "gzip, deflate, br" } }));
    expect(br.headers.get("content-encoding")).toBe("br");
    const brBytes = new Uint8Array(await br.arrayBuffer());
    expect(brBytes.length).toBeLessThan(body.length / 2);
    const { brotliDecompressSync, gunzipSync } = await import("node:zlib");
    expect(brotliDecompressSync(brBytes).toString("utf8")).toBe(body);
    expect(br.headers.get("content-security-policy")).toContain("script-src 'self'");

    const gz = assets.serve("/app.js", new Request("https://node.test/app.js", { headers: { "accept-encoding": "gzip" } }));
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString("utf8")).toBe(body);

    // Revalidating what it has: nothing comes back but the headers.
    const again = assets.serve("/app.js", new Request("https://node.test/app.js", { headers: { "if-none-match": etag!, "accept-encoding": "br" } }));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    // The page itself too (it carries all the CSS), and a changed file has another tag.
    const page = assets.serve("/");
    expect(assets.serve("/", new Request("https://node.test/", { headers: { "if-none-match": page.headers.get("etag")! } })).status).toBe(304);
    expect(assets.serve("/pair.js").headers.get("etag")).not.toBe(etag);
    // Images are already compressed: they're sent as they are.
    expect(assets.serve("/icon-192.png", new Request("https://node.test/icon-192.png", { headers: { "accept-encoding": "br" } })).headers.get("content-encoding")).toBeNull();
  });
});
