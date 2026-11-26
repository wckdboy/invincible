/*
 * Secrets never travel through chat or memory. Chat goes to model providers and
 * memory replicates in plaintext to every device, so anything that looks like a
 * credential is stopped at the door and redirected to the vault.
 */

export interface SecretFinding {
  kind: string;
  index: number;
  length: number;
}

const PATTERNS: [kind: string, pattern: RegExp][] = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["OrcaRouter API key", /sk-orca-[A-Za-z0-9_-]{16,}/g],
  ["OpenRouter API key", /sk-or-[A-Za-z0-9_-]{20,}/g],
  ["API key (sk-…)", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  // Zhipu's and Z.ai's keys (the GLM Coding Plan's too): an id of 32 hex digits, a dot, a secret of 16 letters and digits.
  ["Zhipu / Z.ai API key", /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g],
  // Xiaomi MiMo's Token Plan keys (tp-, ttp- for a team): their docs say no more of the form, so any long body is one.
  ["Xiaomi MiMo Token Plan key", /\btt?p-[A-Za-z0-9]{24,}/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}/g],
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["Galahad gateway token", /\bgw_[A-Za-z0-9_-]{43}\b/g],
  ["Galahad admin token", /\badm_[A-Za-z0-9_-]{43}\b/g],
  ["Galahad invite", /\bgi1\.[A-Za-z0-9_-]{40,}/g],
];

/**
 * A credential's name (`password`, `DB_PASSWORD`, `api-key`, `access_token`…), `:` or `=`, and
 * its value: quoted, what redact() leaves (`[redacted …]`, with whatever is stuck to it), or up
 * to the next space.
 */
const ASSIGNMENT =
  /\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret|api[_-]?key|access[_-]?key|token)\b["']?\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\[redacted[^\]\n]*\]\S*|\S+)/gi;

const NAME = String.raw`[A-Za-z_$][\w$]*`;
/** Words a value is named after when it's a variable, not the thing itself. */
const CREDENTIAL_WORD = /(?:password|passwd|secret|key|token|credential|auth)s?$/i;
/** Where a value comes from when it's read in code: the environment, configuration, the caller. */
const CODE_ROOT = /^(?:process|os|env|environ|config|cfg|settings|options|opts|ctx|context|this|self|req|request|args|params|props|import)$/;
/** A call that looks a credential up by name: its first argument is that name, not the value. */
const GETTER = /^(?:get|read|fetch|load|lookup|require|resolve)|(?:env|environ|secret|token|password|credential|key)s?$/i;

/**
 * A name as code spells one: camelCase, snake_case, PascalCase or UPPER_CASE, with digits only at
 * the end of a word (`oauth2Token`, `S3_KEY`). `Tr0ub4dor3x` is a password with a dot before it.
 */
function conventional(name: string): boolean {
  const bare = name.replace(/^[$_]+|[$_]+$/g, "");
  return bare
    .split(/[_$]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .every((word) => /^(?:[A-Z]+|[A-Z]?[a-z]+)[0-9]*$/.test(word));
}

/**
 * What a value is, where a credential would sit. "harmless": a placeholder, a masked value, a
 * word too short to be a key. "reference": it names where the credential is kept, or calls
 * what fetches it (then the rest of its expression is checked for a literal: see literalAfter).
 * Deliberately narrow (when in doubt, it's a secret): a bare word, a number, a literal default,
 * a `$` before a lower-case word, a dotted value that isn't code, all stay "credential".
 */
function judge(value: string): "credential" | "harmless" | "reference" {
  if (value.length < 8) return "harmless"; // too short to be a key (as before)
  if (/^\$\{(?:[A-Za-z_]+[.:])?[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return "reference"; // ${DB_PASSWORD}, ${env:TOKEN}
  if (/^\$[A-Z_][A-Z0-9_]*$/.test(value)) return "reference"; // $GITHUB_TOKEN (environment style only: $uperman1234 is a password)
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value)) return "reference"; // %DB_PASSWORD%
  if (/^\{\{\s*[A-Za-z_][\w.]*\s*\}\}$/.test(value)) return "reference"; // {{ api_key }}
  if (/^<[A-Za-z][A-Za-z _-]*>$/.test(value)) return "harmless"; // <your-key-here>
  if (/^(?:\*{4,}|x{4,}|X{4,}|•{4,}|\.{3,}|…)$/.test(value)) return "harmless"; // masked
  if (/^\[redacted(?: [^\]]*)?\]$/i.test(value)) return "harmless"; // exactly what redact() leaves
  if (/^(?:undefined|null|none|nil|true|false)$/i.test(value)) return "harmless";
  if (/^your[-_]?(?:[a-z]+[-_]?)*(?:key|token|secret|password)(?:[-_]?here)?$/i.test(value)) return "harmless"; // your-key-here
  const path = new RegExp(`^(${NAME}(?:\\??\\.${NAME})*)(.*)$`).exec(value);
  if (path) {
    const [, dotted, rest] = path as unknown as [string, string, string];
    const parts = dotted.split(/\??\./);
    if (!parts.every(conventional)) return "credential";
    const root = parts[0]!;
    const leaf = parts.at(-1)!;
    // A call that fetches it: request.headers.get(…), os.getenv("TOKEN"), getToken(). Closed, with
    // nothing after it, or (a method, cut at a space) open.
    const call = /^\((?:[^()]|\([^()]*\))*(\))?[,;)]*$/.exec(rest);
    if (call && (call[1] ? parts.length > 1 || /^[a-z_$]/.test(dotted) : parts.length > 1)) return "reference";
    // Read from somewhere: process.env.API_KEY, config.token, creds.password, os.environ["TOKEN"]
    // (a variable is lower-case and has no digits: Summer2024.Secret is a password).
    const read = parts.length > 1 && (CODE_ROOT.test(root) || (CREDENTIAL_WORD.test(leaf) && /^[a-z_$][A-Za-z_$]*$/.test(root)));
    if (read && /^(?:\[\s*["'][A-Za-z0-9_]+["']\s*\])?[,;)]*$/.test(rest)) return "reference";
    if (CODE_ROOT.test(dotted) && /^\[\s*["'][A-Za-z0-9_]+["']\s*\][,;)]*$/.test(rest)) return "reference";
  }
  return "credential";
}

/**
 * Where a quoted literal of 8 or more characters ends in the expression starting at `from`, or
 * -1. A reference with a literal beside it (`os.getenv("PW", "…")`, `process.env.X || "…"`)
 * holds the credential itself. The expression ends at a line break, at a backtick (Markdown
 * around it) or an unclosed quote (prose), and at a `,`, `;` or closing bracket it didn't open.
 * A name being looked up is no literal: a getter's first argument
 * (`request.headers.get("authorization")`) and a key (`os.environ["TOKEN"]`). Looks at most
 * EXPRESSION characters ahead.
 */
const EXPRESSION = 1000;
function literalAfter(text: string, from: number): number {
  const open: { bracket: string; lookup: boolean }[] = [];
  let previous = ""; // the last character that isn't a space
  const stop = Math.min(text.length, from + EXPRESSION);
  for (let i = from; i < stop; i++) {
    const ch = text[i]!;
    if (ch === "\n" || ch === "`") return -1;
    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < stop && text[end] !== ch && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
      if (end >= stop || text[end] !== ch) return -1;
      const literal = text.slice(i + 1, end);
      let after = end + 1;
      while (after < stop && /\s/.test(text[after]!)) after++;
      const next = text[after] ?? "";
      const top = open.at(-1);
      const looksUp =
        !!top?.lookup &&
        ((top.bracket === "(" && previous === "(" && (next === ")" || next === ",")) || (top.bracket === "[" && previous === "[" && next === "]")) &&
        /^[\w.:/@-]+$/.test(literal);
      if (literal.length >= 8 && !looksUp) return end + 1;
      previous = ch;
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      let start = i;
      while (start > from && /[\w$.?]/.test(text[start - 1]!)) start--;
      const before = text.slice(start, i);
      const leaf = before.split(/\??\./).at(-1) ?? "";
      open.push({ bracket: ch, lookup: ch === "(" ? GETTER.test(leaf) : ch === "[" && (before !== "" || previous === "]" || previous === ")") });
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (!open.length) return -1;
      open.pop();
    } else if ((ch === "," || ch === ";") && !open.length) return -1;
    if (!/\s/.test(ch)) previous = ch;
  }
  return -1;
}

function assignments(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const match of text.matchAll(ASSIGNMENT)) {
    const raw = match[1]!;
    const quoted = /^(["'`]).*\1$/s.test(raw);
    // Unquoted, it ends where the sentence or the Markdown does: `export API_KEY=<key>`; …
    const value = quoted ? raw.slice(1, -1) : raw.replace(/[`'".,;:!?]+$/, "");
    const verdict = judge(value);
    if (verdict === "credential") {
      out.push({ kind: "password assignment", index: match.index!, length: match[0].length });
    } else if (verdict === "reference" && !quoted) {
      // The unquoted value was cut at a space: what follows it in the same expression counts too.
      const end = literalAfter(text, match.index! + match[0].length - raw.length);
      if (end > 0) out.push({ kind: "password assignment", index: match.index!, length: end - match.index! });
    }
  }
  return out;
}

/** Subresource integrity (npm's lockfiles, <script integrity>): a hash, exactly its length. */
const INTEGRITY: Record<string, number> = { sha256: 44, sha384: 64, sha512: 88 };
function isIntegrityHash(token: string): boolean {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
  return !!match && match[2]!.length === INTEGRITY[match[1]!];
}

export interface ScanOptions {
  /** Tokens the caller knows to be public, such as the ids of events in its mind. */
  isPublic?: (token: string) => boolean;
}

/** Shannon entropy in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Standalone, mixed-character, high-entropy tokens (catches keys without a known prefix). */
function highEntropyTokens(text: string, opts: ScanOptions): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9_+/=.-])[A-Za-z0-9_+/=-]{32,200}(?![A-Za-z0-9_+/=.-])/g)) {
    const token = match[0];
    if (/^[nc]_/.test(token)) continue; // Galahad device ids are public keys
    if (isIntegrityHash(token)) continue;
    if (opts.isPublic?.(token)) continue;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(token)).length;
    if (classes >= 3 && entropy(token) > 4.2) out.push({ kind: "high-entropy token", index: match.index!, length: token.length });
  }
  return out;
}

export function findSecrets(text: string, opts: ScanOptions = {}): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) findings.push({ kind, index: match.index!, length: match[0].length });
  }
  findings.push(...assignments(text));
  for (const finding of highEntropyTokens(text, opts)) {
    if (!findings.some((f) => finding.index < f.index + f.length && f.index < finding.index + finding.length)) {
      findings.push(finding);
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

/** Replace known secret values and anything secret-shaped with a marker (what `opts` says is public aside). */
export function redact(text: string, knownValues: (string | null | undefined)[] = [], opts: ScanOptions = {}): string {
  let out = text;
  for (const value of knownValues) if (value && value.length >= 6) out = out.split(value).join("[redacted]");
  // One key can match several patterns (an Anthropic key is also an sk-… key): one marker per span.
  const spans: { index: number; end: number; kind: string }[] = [];
  for (const f of findSecrets(out, opts)) {
    const last = spans.at(-1);
    if (last && f.index < last.end) last.end = Math.max(last.end, f.index + f.length);
    else spans.push({ index: f.index, end: f.index + f.length, kind: f.kind });
  }
  for (const s of [...spans].reverse()) out = `${out.slice(0, s.index)}[redacted ${s.kind}]${out.slice(s.end)}`;
  return out;
}

export const SECRET_REDIRECT =
  "Secrets never go into chat or memory. Add it to the vault instead: the PWA's Vault page, or `galahad key add` in a terminal.";
