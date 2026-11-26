/*
 * How invincible.sh reads what it says from the repository, as pure functions of the files' text: the installer
 * (scripts/install.sh) and its Bun pin, the apps' update feeds (public/mac/appcast.xml, public/android/latest.json), the
 * apps' requirements (apps/apple/project.yml, apps/android/app/build.gradle.kts), the plan (docs/PLAN.md) and the README.
 * facts.ts hands them the files when the site is built; the tests hand them examples. A file that doesn't say what the
 * page needs fails the build, rather than a page that says something else.
 */

/** What the page says of the installer, from the script itself. */
export interface Installer {
  /** The one line, as its own header gives it. */
  command: string;
  /** The repository it installs from (owner/name), and the ref it takes by default. */
  repo: string;
  ref: string;
  /** Its steps, in order: the headings of its sections. */
  steps: string[];
  /** Its options, as its header lists them. */
  options: { flag: string; what: string }[];
  /** Where things go, and the variable that moves each. */
  places: { variable: string; path: string }[];
}

export function readInstaller(script: string): Installer {
  // Its header: the comment block after the shebang, as one text (a sentence may run over a line).
  const header = script.split("\n").slice(1).filter((line, i, lines) => lines.slice(0, i + 1).every((l) => l.startsWith("#"))).map((line) => line.replace(/^# ?/, ""));
  const prose = header.join(" ").replace(/\s+/g, " ");
  const command = /^\s*(curl -fsSL https:\/\/\S+ \| bash)\s*$/m.exec(header.join("\n"))?.[1];
  if (!command) throw new Error("the installer's header gives no `curl -fsSL https://… | bash` line");
  const repo = /^REPO=([\w.-]+\/[\w.-]+)$/m.exec(script)?.[1];
  const ref = /^REF=(\S+)/m.exec(script)?.[1];
  if (!repo || !ref) throw new Error("the installer names no REPO= or REF=");
  const steps = [...script.matchAll(/^# ─── (.+?) ─+$/gm)].map((m) => m[1]!.trim());
  if (steps.length < 3) throw new Error("the installer's sections (# ─── … ───) weren't found");
  const options = header.flatMap((line) => {
    const m = /^\s+(--[a-z][a-z-]*(?: <[^>]+>)?)\s{2,}(\S.*)$/.exec(line);
    return m ? [{ flag: m[1]!, what: m[2]!.trim() }] : [];
  });
  if (!options.some((o) => o.flag === "--plan")) throw new Error("the installer's header lists no --plan");
  const places = [...prose.matchAll(/\b(INVINCIBLE_[A-Z_]+) \((?:default )?(~\/[^)\s]*)\)/g)].map((m) => ({ variable: m[1]!, path: m[2]! }));
  if (!places.some((p) => p.variable === "INVINCIBLE_HOME")) throw new Error("the installer's header doesn't say where the node's home is (INVINCIBLE_HOME)");
  return { command, repo, ref, steps, options, places };
}

/** The Bun the installer pins (scripts/bun-pin.sh). */
export function readBunPin(pin: string): string {
  const version = /^BUN_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(pin)?.[1];
  if (!version) throw new Error("scripts/bun-pin.sh pins no BUN_VERSION");
  return version;
}

/** A release of an app, as its feed says it. */
export interface Release {
  version: string;
  build: string;
  url: string;
  bytes: number;
  /** When it was published: an ISO date (UTC). */
  date: string;
}

/**
 * The Mac app's feed (apps/apple/scripts/mac-release.sh writes it with each release): its newest build, or null while it
 * offers none (an empty channel, until the first release). It must link to the repository's own releases.
 */
export function readAppcast(xml: string, repo: string): (Release & { macOS: string }) | null {
  if (!/<rss\b[^>]*>[\s\S]*<channel>[\s\S]*<\/channel>[\s\S]*<\/rss>/.test(xml)) throw new Error("the Mac's feed isn't an RSS channel");
  const item = /<item>([\s\S]*?)<\/item>/.exec(xml)?.[1];
  if (item === undefined) return null;
  const field = (pattern: RegExp): string => {
    const found = pattern.exec(item)?.[1];
    if (!found) throw new Error(`the Mac's feed has no ${pattern.source}`);
    return found;
  };
  const url = field(/<enclosure\b[^>]*\burl="([^"]+)"/);
  if (!url.startsWith(`https://github.com/${repo}/releases/download/`)) throw new Error(`the Mac's feed links outside the repository's releases: ${url}`);
  const date = new Date(field(/<pubDate>([^<]+)<\/pubDate>/));
  if (Number.isNaN(date.getTime())) throw new Error("the Mac's feed has a date it can't read");
  return {
    version: field(/<sparkle:shortVersionString>([^<]+)</),
    build: field(/<sparkle:version>([^<]+)</),
    macOS: field(/<sparkle:minimumSystemVersion>([^<]+)</).replace(/\.0$/, ""),
    url,
    bytes: Number(field(/<enclosure\b[^>]*\blength="(\d+)"/)),
    date: date.toISOString(),
  };
}

/**
 * Android's record (apps/android/scripts/publish.sh writes it with each release, and the app reads it for updates): its
 * newest signed APK, or null while there is none (an empty object, until the first release). It must link to the
 * repository's own releases.
 */
export function readAndroid(json: string, repo: string): (Release & { sha256: string; certificate: string; minSdk: number }) | null {
  const a = JSON.parse(json) as Record<string, unknown>;
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("Android's record isn't an object");
  if (Object.keys(a).length === 0) return null;
  const text = (key: string): string => {
    if (typeof a[key] !== "string" || !a[key]) throw new Error(`Android's record has no ${key}`);
    return a[key] as string;
  };
  const url = text("url");
  if (!url.startsWith(`https://github.com/${repo}/releases/download/`)) throw new Error(`Android's record links outside the repository's releases: ${url}`);
  if (typeof a.size !== "number" || typeof a.minSdk !== "number") throw new Error("Android's record has no size or minSdk");
  const date = new Date(text("date"));
  if (Number.isNaN(date.getTime())) throw new Error("Android's record has a date it can't read");
  if (!/^[0-9a-f]{64}$/.test(text("sha256"))) throw new Error("Android's record has no SHA-256 of its APK");
  return { version: text("version"), build: text("build"), url, bytes: a.size, date: date.toISOString(), sha256: text("sha256"), certificate: text("certificate"), minSdk: a.minSdk };
}

/** The oldest systems the Apple apps run on (apps/apple/project.yml's deployment targets). */
export function readAppleTargets(yml: string): { iOS: string; macOS: string } {
  const iOS = /^\s+iOS: "([0-9.]+)"/m.exec(yml)?.[1];
  const macOS = /^\s+macOS: "([0-9.]+)"/m.exec(yml)?.[1];
  if (!iOS || !macOS) throw new Error("apps/apple/project.yml names no iOS or macOS deployment target");
  return { iOS: iOS.replace(/\.0$/, ""), macOS: macOS.replace(/\.0$/, "") };
}

/** The oldest Android the app runs on (its build's minSdk). */
export function readAndroidMinSdk(gradle: string): number {
  const sdk = Number(/^\s*minSdk = (\d+)$/m.exec(gradle)?.[1]);
  if (!Number.isInteger(sdk) || sdk < 21) throw new Error("the Android app's build names no minSdk");
  return sdk;
}

/** Android's version for an API level, as a phone's settings say it (Android 10 is level 29). */
export function androidVersion(sdk: number): string {
  const names: Record<number, string> = { 26: "8", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17" };
  const name = names[sdk];
  if (!name) throw new Error(`no Android version is known here for API level ${sdk}`);
  return name;
}

/** A phase of the plan: its number, its title, and where it stands (✅ done, 🔨 being built, 🔜 next). */
export interface Phase {
  n: number;
  title: string;
  state: "done" | "building" | "next";
}

export function readPlan(plan: string): Phase[] {
  const states = { "✅": "done", "🔨": "building", "🔜": "next" } as const;
  const phases = [...plan.matchAll(/^## Phase (\d+): (.+?) (✅|🔨|🔜)\s*$/gmu)].map((m) => ({ n: Number(m[1]), title: m[2]!.trim(), state: states[m[3] as keyof typeof states] }));
  if (phases.length === 0) throw new Error("docs/PLAN.md has no phases (## Phase n: title ✅|🔨|🔜)");
  return phases;
}

/** The README's line under its title: what Invincible is, in its own words. */
export function readTagline(readme: string): string {
  const line = /^# Invincible\s*\n+\*\*(.+?)\*\*\s*$/m.exec(readme)?.[1];
  if (!line) throw new Error("the README has no **line** under its title");
  return line;
}

/** A size in megabytes, as a download says it. */
export const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;

/** A date as the page says one: 26 November 2026. */
export const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
