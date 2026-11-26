/*
 * Small pure text helpers: search highlighting, command-line splitting,
 * provider detection from a key prefix. No DOM, so they are unit-tested.
 */

/** Ranges [start, end) where any query term occurs (case-insensitive), merged and sorted. */
export function matchRanges(text: string, query: string): [number, number][] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2 || (t.length === 1 && query.trim().length === 1)))];
  if (!terms.length) return [];
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + term.length)) ranges.push([i, i + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export interface ParsedCommand {
  argv: string[];
  /** True when the line used shell syntax (pipes, redirects, &&, $vars) and is run through `sh -c`. */
  viaShell: boolean;
}

const SHELL_SYNTAX = /[|&;<>()$`*?~]|\\\n/;

/**
 * Split a console line into argv, honouring 'single' and "double" quotes and
 * backslash escapes. Lines that need a shell (pipes, globs, $VARS…) are run as
 * `sh -c <line>`, and the console says so, rather than silently guessing.
 */
export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (!trimmed) return { argv: [], viaShell: false };
  const argv: string[] = [];
  let current = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  let unquotedShell = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < trimmed.length && /["\\$`]/.test(trimmed[i + 1]!)) current += trimmed[++i]!;
      else {
        if (ch === "$" || ch === "`") unquotedShell = true;
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < trimmed.length) {
      current += trimmed[++i]!;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) argv.push(current);
      current = "";
      has = false;
    } else {
      if (SHELL_SYNTAX.test(ch)) unquotedShell = true;
      current += ch;
      has = true;
    }
  }
  if (quote) unquotedShell = true; // unbalanced quotes: let the shell report it
  if (has) argv.push(current);
  return unquotedShell ? { argv: ["sh", "-c", trimmed], viaShell: true } : { argv, viaShell: false };
}

export interface KeyPreset {
  id: string;
  keyPrefixes?: string[];
  /** A coding plan, when the preset is one (the node says so), and what its vendor's terms let Galahad do with it. */
  plan?: { name: string; says: string; terms: string; models: string[]; allows: { native: boolean; tools: "unattended" | "interactive" } };
}

/** A subscription's sign-in, as the node describes the ones it knows: not an API key, and never sealed as one. */
export interface SignInForm {
  prefix: string;
  signIn: { vendor: string; tool: string; why: string };
}

/** What a pasted value is, when it is a subscription's sign-in and not a key (an older node names none). */
export function detectSignIn(key: string, signIns: readonly SignInForm[] | undefined): SignInForm["signIn"] | null {
  return signIns?.find(({ prefix }) => key.startsWith(prefix))?.signIn ?? null;
}

/** A coding plan in a line: who uses it, as its vendor's terms allow (the CLI's planAdvice says the same). Null for a preset that isn't one. */
export function planLine(preset: KeyPreset | undefined): string | null {
  const plan = preset?.plan;
  if (!plan) return null;
  if (plan.allows.native) return `${plan.name} is a coding plan: Galahad and the other knights code on it, and their coding tools use it. His talk with you never does.`;
  if (plan.allows.tools === "unattended") return `${plan.name} is a coding plan its terms allow only inside the coding tools they name: a knight's coding tool runs on it, and so does one you run yourself (galahad run). Galahad never calls it himself.`;
  return `${plan.name} is a coding plan for interactive use only, by its terms: it is lent to a coding tool you run yourself (galahad run), and never to Galahad or a knight's work.`;
}

/** A role's models as he uses them: his own in the roster's order (the first answers), and the coding plans' models, which do coding and answer nothing else. */
export function roleParts(models: readonly string[], presets: readonly KeyPreset[]): { own: string[]; plans: string[] } {
  const onPlan = (ref: string): boolean => presets.some((p) => p.plan && ref.startsWith(`${p.id}/`));
  return { own: models.filter((ref) => !onPlan(ref)), plans: models.filter(onPlan) };
}

/** What a provider needs once a key for it is sealed under `secretName`: the request that points it at the key (null:
 * nothing, or nothing this device may do), and what to say of it (null: nothing to say). A known preset is configured
 * from its own settings, and one with no address of its own (a Cloudflare AI Gateway) at the `baseUrl` given with the
 * key, if one was; one already configured is pointed at the new key (and at that address, when one was given). */
export function providerSetup(
  data: { providers: readonly { id: string; kind: string; baseUrl: string; secret: string | null }[]; presets: readonly (KeyPreset & { baseUrl?: string; note?: string })[] },
  providerId: string,
  secretName: string,
  mayConfigure: boolean,
  baseUrl?: string,
): { request: { id: string; kind?: string; baseUrl?: string; secret: string } | null; say: string | null } {
  if (!mayConfigure) return { request: null, say: null };
  const existing = data.providers.find((p) => p.id === providerId);
  const at = baseUrl || existing?.baseUrl;
  if (existing?.secret === secretName && at === existing.baseUrl) return { request: null, say: null };
  if (existing) return { request: { id: providerId, kind: existing.kind, baseUrl: at, secret: secretName }, say: `${providerId} now uses this key.` };
  const preset = data.presets.find((p) => p.id === providerId);
  if (!preset) return { request: null, say: null };
  if (!preset.baseUrl && baseUrl) return { request: { id: providerId, baseUrl, secret: secretName }, say: planLine(preset) ?? `${providerId} is configured and ready.` };
  if (!preset.baseUrl) return { request: null, say: preset.note ?? `Add ${providerId}'s base URL on the Models page to start using it.` };
  // Another address given for one that has its own (another region's): it is set up there, where its key is pinned.
  return { request: { id: providerId, ...(baseUrl && baseUrl !== preset.baseUrl ? { baseUrl } : {}), secret: secretName }, say: planLine(preset) ?? `${providerId} is configured and ready.` };
}

/** Longest matching key prefix wins (sk-orca- beats sk-). A subscription's sign-in is no provider's key. */
export function detectProvider(key: string, presets: KeyPreset[], signIns?: readonly SignInForm[]): string | null {
  if (detectSignIn(key, signIns)) return null;
  let best: { id: string; length: number } | null = null;
  for (const preset of presets) {
    for (const prefix of preset.keyPrefixes ?? []) {
      if (key.startsWith(prefix) && (!best || prefix.length > best.length)) best = { id: preset.id, length: prefix.length };
    }
  }
  return best?.id ?? null;
}

/** "…3456"-style hint is all the UI ever shows of a key; this only formats what the server sends. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export const shortId = (id: string, n = 8): string => (id.length > n + 2 ? id.slice(2, 2 + n) : id);

/** Bytes → "1.2 GB"-style; inputs are already GB in our API, so this formats GB numbers. */
export function gb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} TB`;
  if (value < 1) return `${Math.round(value * 1024)} MB`;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;
}
