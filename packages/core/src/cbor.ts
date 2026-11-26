/*
 * CBOR (RFC 8949) for what crosses to Q-AMP: its sidecar's socket messages and its delegation tokens (Q-AMP SPEC 4,
 * 9.3). The JSON data model plus byte strings, nothing else.
 *
 * Carried from Q-AMP's own browser client (bindings/web/src/cbor.ts, the owner's, MIT OR Apache-2.0), so the two
 * read the same bytes the same way, with no package added. Decoding is bounded before it allocates: a pass over the
 * bytes counts the items and the depth (SPEC 4's decode budget) before any value is built. Tags, `undefined`, other
 * simple values and non-finite floats are refused, as Q-AMP's Rust decoder refuses them. Maps take text keys only and
 * become plain objects with no prototype, so a key such as `__proto__` is only a key.
 */

export interface CborBudget {
  maxItems: number;
  maxDepth: number;
}

/** The budget for structured payloads (Q-AMP SPEC 4): what the sidecar holds a host's messages to as well. */
export const CBOR_BUDGET: CborBudget = { maxItems: 65_536, maxDepth: 64 };

/** Why bytes were refused: `trailing` bytes after the item, a `duplicate` map key, or anything else `malformed`. */
export class CborError extends Error {
  override name = "CborError";
  constructor(
    message: string,
    readonly code: "malformed" | "trailing" | "duplicate" = "malformed",
  ) {
    super(message);
  }
}

/** A value CBOR carries here. Integers beyond 2^53 decode to bigint. */
export type CborValue = null | boolean | number | bigint | string | Uint8Array | CborValue[] | { [key: string]: CborValue };

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

// ---- Encoding ----

class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number) {
    this.room(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  head(major: number, n: number | bigint): void {
    const m = major << 5;
    if (typeof n === "bigint") {
      if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new CborError("integer out of range");
      if (n <= 0xffff_ffffn) return this.head(major, Number(n));
      this.byte(m | 27);
      const v = new DataView(new ArrayBuffer(8));
      v.setBigUint64(0, n);
      return this.bytes(new Uint8Array(v.buffer));
    }
    if (n < 24) return this.byte(m | n);
    if (n < 0x100) {
      this.byte(m | 24);
      return this.byte(n);
    }
    if (n < 0x10000) {
      this.byte(m | 25);
      this.byte(n >> 8);
      return this.byte(n & 0xff);
    }
    if (n < 0x1_0000_0000) {
      this.byte(m | 26);
      const v = new DataView(new ArrayBuffer(4));
      v.setUint32(0, n);
      return this.bytes(new Uint8Array(v.buffer));
    }
    return this.head(major, BigInt(n));
  }

  done(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }
}

function put(w: Writer, v: unknown, depth: number): void {
  if (depth > CBOR_BUDGET.maxDepth) throw new CborError("nested too deeply");
  if (v === null || v === undefined) return w.byte(0xf6);
  if (v === false) return w.byte(0xf4);
  if (v === true) return w.byte(0xf5);
  if (typeof v === "number") {
    if (Number.isSafeInteger(v) && !Object.is(v, -0)) return v >= 0 ? w.head(0, v) : w.head(1, -1 - v);
    if (!Number.isFinite(v)) throw new CborError("non-finite numbers are outside the JSON data model");
    w.byte(0xfb);
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, v);
    return w.bytes(new Uint8Array(d.buffer));
  }
  if (typeof v === "bigint") return v >= 0n ? w.head(0, v) : w.head(1, -1n - v);
  if (typeof v === "string") {
    const b = utf8.encode(v);
    w.head(3, b.length);
    return w.bytes(b);
  }
  if (v instanceof Uint8Array) {
    w.head(2, v.length);
    return w.bytes(v);
  }
  if (Array.isArray(v)) {
    w.head(4, v.length);
    for (const item of v) put(w, item, depth + 1);
    return;
  }
  if (v instanceof Map) {
    w.head(5, v.size);
    for (const [k, item] of v) {
      if (typeof k !== "string") throw new CborError("map keys are text");
      put(w, k, depth + 1);
      put(w, item, depth + 1);
    }
    return;
  }
  if (typeof v === "object") {
    // Keys whose value is undefined are left out, as JSON.stringify leaves them out.
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    w.head(5, entries.length);
    for (const [k, item] of entries) {
      put(w, k, depth + 1);
      put(w, item, depth + 1);
    }
    return;
  }
  throw new CborError(`cannot encode a ${typeof v}`);
}

/** Encodes a value: integers that are safe become CBOR integers, other numbers doubles, a Map's entries in its order. */
export function cborEncode(v: unknown): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  put(w, v, 0);
  return w.done();
}

// ---- Decoding ----

export interface CborDecodeOptions {
  budget?: CborBudget;
  /** Refuse a map that holds a key twice (signed statements, as Q-AMP's Rust decoders of them do). */
  rejectDuplicateKeys?: boolean;
  /** Refuse floats: signed statements hold integers only, and a float is not one. */
  rejectFloats?: boolean;
}

class Reader {
  at = 0;
  constructor(readonly b: Uint8Array) {}

  need(n: number) {
    if (this.at + n > this.b.length) throw new CborError("truncated");
  }

  u8(): number {
    this.need(1);
    return this.b[this.at++]!;
  }

  /** The argument of a head with additional information `ai`. */
  arg(ai: number): number | bigint {
    if (ai < 24) return ai;
    const n = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0;
    if (n === 0) throw new CborError("reserved additional information");
    this.need(n);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, n);
    this.at += n;
    if (n === 1) return v.getUint8(0);
    if (n === 2) return v.getUint16(0);
    if (n === 4) return v.getUint32(0);
    const big = v.getBigUint64(0);
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  }

  /** A length or count, which must fit in the input. */
  count(ai: number, perItem: number): number {
    const n = this.arg(ai);
    const left = this.b.length - this.at;
    if (typeof n === "bigint" || n * perItem > left) throw new CborError("truncated");
    return n;
  }
}

/** The pass that allocates nothing: counts items and depth (SPEC 4), and checks the JSON data model. */
function walk(r: Reader, budget: CborBudget, state: { items: number; floats: boolean }, depth: number): void {
  if (depth > budget.maxDepth) throw new CborError("nested too deeply");
  if (++state.items > budget.maxItems) throw new CborError("too many items");
  const initial = r.u8();
  const major = initial >> 5;
  const ai = initial & 0x1f;
  if (ai === 31) {
    if (major === 2 || major === 3) {
      for (;;) {
        const c = r.u8();
        if (c === 0xff) return;
        if (c >> 5 !== major || (c & 0x1f) === 31) throw new CborError("malformed indefinite-length string");
        // Each chunk is an item of the budget: the build makes a view of each before it joins them.
        if (++state.items > budget.maxItems) throw new CborError("too many items");
        // count() moves past the length first: read it before adding.
        const n = r.count(c & 0x1f, 1);
        r.at += n;
      }
    }
    if (major === 4 || major === 5) {
      for (;;) {
        r.need(1);
        if (r.b[r.at] === 0xff) {
          r.at++;
          return;
        }
        walk(r, budget, state, depth + 1);
        if (major === 5) walk(r, budget, state, depth + 1);
      }
    }
    throw new CborError("reserved additional information");
  }
  switch (major) {
    case 0:
    case 1:
      r.arg(ai);
      return;
    case 2:
    case 3: {
      const n = r.count(ai, 1);
      r.at += n;
      return;
    }
    case 4: {
      const n = r.count(ai, 1);
      for (let i = 0; i < n; i++) walk(r, budget, state, depth + 1);
      return;
    }
    case 5: {
      const n = r.count(ai, 2);
      for (let i = 0; i < 2 * n; i++) walk(r, budget, state, depth + 1);
      return;
    }
    case 6:
      throw new CborError("tags are outside the JSON data model");
    default: {
      if (ai === 20 || ai === 21 || ai === 22) return;
      if (ai === 25 || ai === 26 || ai === 27) {
        if (!state.floats) throw new CborError("a float where only integers belong");
        const at = r.at;
        r.arg(ai);
        if (!Number.isFinite(float(r.b, at, ai))) throw new CborError("non-finite float");
        return;
      }
      throw new CborError(ai === 23 ? "undefined is outside the JSON data model" : "simple values are not supported");
    }
  }
}

function float(b: Uint8Array, at: number, ai: number): number {
  const v = new DataView(b.buffer, b.byteOffset + at);
  if (ai === 27) return v.getFloat64(0);
  if (ai === 26) return v.getFloat32(0);
  const h = v.getUint16(0);
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

function joined(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function build(r: Reader, opts: CborDecodeOptions): CborValue {
  const initial = r.u8();
  const major = initial >> 5;
  const ai = initial & 0x1f;
  if (ai === 31 && (major === 2 || major === 3)) {
    const parts: Uint8Array[] = [];
    for (;;) {
      const c = r.u8();
      if (c === 0xff) break;
      const n = r.count(c & 0x1f, 1);
      parts.push(r.b.subarray(r.at, r.at + n));
      r.at += n;
    }
    const whole = joined(parts);
    return major === 2 ? whole : text(whole);
  }
  if (ai === 31 && major === 4) {
    const out: CborValue[] = [];
    while (r.b[r.at] !== 0xff) out.push(build(r, opts));
    r.at++;
    return out;
  }
  if (ai === 31 && major === 5) {
    const out: { [k: string]: CborValue } = Object.create(null);
    while (r.b[r.at] !== 0xff) entry(r, opts, out);
    r.at++;
    return out;
  }
  switch (major) {
    case 0:
      return r.arg(ai);
    case 1: {
      const n = r.arg(ai);
      return typeof n === "bigint" ? -1n - n : n === Number.MAX_SAFE_INTEGER ? -1n - BigInt(n) : -1 - n;
    }
    case 2: {
      const n = r.count(ai, 1);
      const out = r.b.slice(r.at, r.at + n);
      r.at += n;
      return out;
    }
    case 3: {
      const n = r.count(ai, 1);
      const out = text(r.b.subarray(r.at, r.at + n));
      r.at += n;
      return out;
    }
    case 4: {
      const n = r.count(ai, 1);
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(build(r, opts));
      return out;
    }
    case 5: {
      const n = r.count(ai, 2);
      const out: { [k: string]: CborValue } = Object.create(null);
      for (let i = 0; i < n; i++) entry(r, opts, out);
      return out;
    }
    default: {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      const at = r.at;
      r.arg(ai);
      return float(r.b, at, ai);
    }
  }
}

function entry(r: Reader, opts: CborDecodeOptions, out: { [k: string]: CborValue }) {
  const k = build(r, opts);
  if (typeof k !== "string") throw new CborError("map keys must be text");
  const v = build(r, opts);
  if (opts.rejectDuplicateKeys && Object.prototype.hasOwnProperty.call(out, k)) throw new CborError(`duplicate map key ${JSON.stringify(k)}`, "duplicate");
  out[k] = v;
}

function text(b: Uint8Array): string {
  try {
    return utf8Strict.decode(b);
  } catch {
    throw new CborError("a text string is not valid UTF-8");
  }
}

/**
 * Decodes exactly one CBOR item from `bytes`: nothing may follow it. The budget is enforced by a pass that allocates
 * nothing, before any value is built.
 */
export function cborDecode(bytes: Uint8Array, opts: CborDecodeOptions = {}): CborValue {
  const budget = opts.budget ?? CBOR_BUDGET;
  const check = new Reader(bytes);
  walk(check, budget, { items: 0, floats: !opts.rejectFloats }, 0);
  if (check.at !== bytes.length) throw new CborError("trailing bytes after the CBOR item", "trailing");
  return build(new Reader(bytes), opts);
}
