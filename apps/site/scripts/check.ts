/**
 * The gate before invincible.sh goes out, run on the built site (dist/, from `astro build`). Fails (non-zero) if it
 * would:
 *  - run an inline script, or use an inline style or handler, that the CSP forbids, or load anything from elsewhere;
 *  - link to a page or file that does not exist;
 *  - say something private: a tailnet's name or address, a private address, an email address, a path on the machine
 *    that built it (the owner's own list is the forge's secret sweep, in CI);
 *  - hand `curl … | bash` anything but scripts/install.sh as the repository has it, or show another script's SHA-256;
 *  - serve feeds other than the ones committed, or an orb that could run or fetch anything;
 *  - weigh more than its budget: what a first visit fetches, as brotli (BUDGET).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../dist");
const repo = resolve(here, "../../..");
/** Paths the Worker answers (src/worker.ts), which no file in dist/ stands for. */
const WORKER_ROUTES = new Set(["/install"]);
/** What a first visit to the home page may fetch, for either theme, as brotli (a font and a PNG as they are). Measured
 * at 46 KB on 26 November 2026; a page that grows past this says so here, on purpose, in its own change. */
const BUDGET = 64 * 1024;

if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("site check: no dist/ to check: run `astro build` first");
  process.exit(1);
}

const files = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
})(root);

const problems: string[] = [];
const PRIVATE = [
  [/\btail[0-9a-f]{4,}\b/i, "a tailnet's name"],
  [/\.ts\.net\b/i, "a tailnet's DNS name"],
  [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "a tailnet address"],
  [/\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(\.\d{1,3})?\b/, "a private address"],
  [/[A-Za-z0-9._%+-]+@(?!\d+x\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/(\/Users\/|\/home\/)[A-Za-z0-9._-]+\//, "a path on the machine that built it"],
] as const;

for (const file of files) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (!/\.(html|css|js|txt|svg|sh|xml|json)$/.test(file) && !rel.endsWith("_headers")) continue;
  const text = readFileSync(file, "utf8");
  for (const [pattern, what] of PRIVATE) if (pattern.test(text)) problems.push(`${rel}: contains ${what} (${text.match(pattern)![0]})`);
  if (rel.startsWith("orbs/") && /<script|<foreignObject|\bhref=|url\((?!#)|@import/i.test(text)) problems.push(`${rel}: an orb may draw and nothing else (no script, no link, nothing fetched)`);
  if (!file.endsWith(".html")) continue;
  for (const [tag, attrs] of text.matchAll(/<script\b([^>]*)>/gi)) {
    const src = /\ssrc="([^"]*)"/i.exec(attrs!)?.[1];
    if (!src) problems.push(`${rel}: an inline <script> is not allowed (CSP: script-src 'self')`);
    else if (!src.startsWith("/")) problems.push(`${rel}: a script from elsewhere (${src}) is not allowed: ${tag}`);
  }
  if (/<style\b/i.test(text)) problems.push(`${rel}: an inline <style> is blocked by the CSP`);
  if (/\sstyle=/i.test(text)) problems.push(`${rel}: inline style attributes are blocked by the CSP`);
  if (/\son[a-z]+=/i.test(text)) problems.push(`${rel}: inline event handlers are not allowed`);
  if (/\s(?:src|srcset)="data:/i.test(text)) problems.push(`${rel}: a data: image is blocked by the CSP (img-src 'self')`);
  for (const [, link] of text.matchAll(/<link\b[^>]*\shref="(https?:)?\/\/(?!invincible\.sh\/)[^"]*"[^>]*>/gi)) problems.push(`${rel}: a stylesheet, font or icon from elsewhere (${link})`);
  for (const [, href] of text.matchAll(/\s(?:href|src|srcset)="(\/[^"#?\s]*)/g)) {
    if (WORKER_ROUTES.has(href!)) continue;
    const target = join(root, href!);
    const candidates = [target, join(target, "index.html"), `${target}.html`];
    if (!candidates.some((c) => statSync(c, { throwIfNoEntry: false })?.isFile())) problems.push(`${rel}: broken link ${href}`);
  }
}

// What `curl -fsSL https://invincible.sh | bash` runs: the repository's installer, exactly, and the hash the page shows.
const served = statSync(join(root, "install.sh"), { throwIfNoEntry: false }) ? readFileSync(join(root, "install.sh")) : null;
const source = readFileSync(join(repo, "scripts/install.sh"));
if (!served) problems.push("install.sh: missing (src/pages/install.sh.ts)");
else if (!served.equals(source)) problems.push("install.sh: differs from scripts/install.sh");
const sha = createHash("sha256").update(source).digest("hex");
const home = readFileSync(join(root, "index.html"), "utf8");
if (!home.includes(sha)) problems.push(`index.html: doesn't show the installer's SHA-256 (${sha})`);

// The apps' feeds, served as committed: the Mac app and the Android app read them for updates.
for (const feed of ["mac/appcast.xml", "android/latest.json"]) {
  const built = statSync(join(root, feed), { throwIfNoEntry: false }) ? readFileSync(join(root, feed)) : null;
  if (!built || !built.equals(readFileSync(resolve(here, "../public", feed)))) problems.push(`${feed}: not served as public/${feed} has it`);
}
const headers = readFileSync(join(root, "_headers"), "utf8");
if (!/^\/\*\n(?:[ \t]+.*\n)*?[ \t]+Content-Security-Policy: default-src 'none';/m.test(headers)) problems.push("_headers: the site's Content-Security-Policy is missing");

// Its weight: what a first visit fetches, in each theme (the orbs a theme doesn't show aren't fetched).
const referenced = (pattern: RegExp) => [...home.matchAll(pattern)].map((m) => m[1]!);
const shared = [...referenced(/<link\b[^>]*\brel="(?:stylesheet|preload)"[^>]*\bhref="(\/[^"]+)"/g), ...referenced(/<script\b[^>]*\bsrc="(\/[^"]+)"/g)];
const themed = { light: referenced(/<img\b[^>]*\bsrc="(\/orbs\/[^"]+)"/g), dark: referenced(/<source\b[^>]*\bsrcset="(\/orbs\/[^"]+)"/g) };
const weigh = (path: string) => {
  const bytes = readFileSync(path === "/" ? join(root, "index.html") : join(root, path));
  return /\.(woff2|png)$/.test(path) ? bytes.length : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
};
const weights: string[] = [];
for (const [theme, orbs] of Object.entries(themed)) {
  if (orbs.length === 0) problems.push(`index.html: no orbs for a ${theme} page`);
  const total = ["/", ...new Set([...shared, ...orbs])].reduce((sum, path) => sum + weigh(path), 0);
  weights.push(`${theme} ${(total / 1024).toFixed(1)} KB`);
  if (total > BUDGET) problems.push(`index.html: a first visit, ${theme}, is ${(total / 1024).toFixed(1)} KB as brotli, over its budget of ${BUDGET / 1024} KB`);
}

if (problems.length) {
  console.error(`site check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`site check passed (${files.length} files; the installer is scripts/install.sh, ${sha.slice(0, 12)}…; a first visit: ${weights.join(", ")} as brotli)`);
