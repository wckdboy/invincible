/*
 * QR codes (ISO/IEC 18004), so an invite can be scanned rather than typed: the
 * terminal prints one for `galahad invite --client`, and the PWA shows one when
 * it pairs a device. Byte mode only (an invite link is ASCII), all four error
 * correction levels, versions 1 to 40, the mask chosen by the standard's
 * penalty rules. No dependencies; the algorithm follows the standard (and the
 * shape of Project Nayuki's reference implementation). Pure, so unit-tested;
 * an independent decoder confirms it in the tests' notes.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrCode {
  /** Modules a side (21 for version 1, 4 more each version). */
  size: number;
  version: number;
  ecc: QrEcc;
  mask: number;
  /** Row-major, `size * size`: true is dark. */
  modules: boolean[];
}

const ECC_ORDER: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two bits each level is written as in the format information. */
const ECC_FORMAT: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Per level (L, M, Q, H) and version (index 0 unused): error correction codewords per block, and the number of blocks.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Data and error-correction modules a version holds (everything but its function patterns and format and version information). */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords a version holds at a level. */
export function dataCodewords(version: number, ecc: QrEcc): number {
  const e = ECC_ORDER[ecc];
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[e]![version]! * BLOCKS[e]![version]!;
}

/** Bytes a byte-mode code of this version and level can carry. */
export function byteCapacity(version: number, ecc: QrEcc): number {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version, ecc) * 8 - 4 - countBits) / 8);
}

// ---------- Reed-Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ----------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i]! ^= gfMul(divisor[i]!, factor);
  }
  return result;
}

/** The data codewords split into blocks, each given its error correction, then interleaved as the symbol stores them. */
function withEcc(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const e = ECC_ORDER[ecc];
  const blocks = BLOCKS[e]![version]!;
  const eccLen = ECC_PER_BLOCK[e]![version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += block.length;
    const tail = rsRemainder(block, divisor);
    if (i < short) block.push(0);
    all.push(block.concat(tail));
  }
  const out: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) {
    for (let j = 0; j < all.length; j++) if (i !== shortLen - eccLen || j >= short) out.push(all[j]![i]!);
  }
  return out;
}

// ---------- the symbol ----------

class Grid {
  readonly modules: boolean[];
  readonly fixed: boolean[];
  constructor(readonly size: number) {
    this.modules = new Array<boolean>(size * size).fill(false);
    this.fixed = new Array<boolean>(size * size).fill(false);
  }
  get(x: number, y: number): boolean {
    return this.modules[y * this.size + x]!;
  }
  set(x: number, y: number, dark: boolean): void {
    this.modules[y * this.size + x] = dark;
    this.fixed[y * this.size + x] = true;
  }
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);
  const align = alignmentPositions(version, n);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      // (Not over the three finders.)
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(g, "L", 0); // reserved now, written for real once the mask is chosen
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

/** The 15 format bits: the level and the mask, BCH-protected and masked. */
export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, ecc: QrEcc, mask: number): void {
  const bits = formatBits(ecc, mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true); // the dark module
}

function drawCodewords(g: Grid, codewords: readonly number[]): void {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (g.fixed[y * n + x] || i >= codewords.length * 8) continue;
        g.modules[y * n + x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  const f = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fixed[y * g.size + x] && f(x, y)) g.modules[y * g.size + x] = !g.modules[y * g.size + x];
}

/** The standard's penalty: long runs, 2×2 blocks, finder-like patterns, and an uneven share of dark. Lower reads better. */
export function penalty(modules: readonly boolean[], size: number): number {
  let score = 0;
  const at = (x: number, y: number) => modules[y * size + x]!;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let bits = 0;
      for (let b = 0; b < size; b++) {
        const dark = pass === 0 ? at(b, a) : at(a, b);
        if (b > 0) {
          const prev = pass === 0 ? at(b - 1, a) : at(a, b - 1);
          if (dark === prev) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score++;
          } else run = 1;
        }
        bits = ((bits << 1) | (dark ? 1 : 0)) & 0x7ff;
        // 1:1:3:1:1 with four light either side (1011101 0000, or 0000 1011101).
        if (b >= 10 && (bits === 0b10111010000 || bits === 0b00001011101)) score += 40;
      }
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
  }
  let dark = 0;
  for (const m of modules) if (m) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/**
 * A QR code for `text` (UTF-8, byte mode): the smallest version that holds it
 * at `ecc` (from `minVersion`), the mask with the lowest penalty. Throws when
 * even version 40 can't hold it.
 */
export function encodeQr(text: string, ecc: QrEcc = "M", minVersion = 1): QrCode {
  const bytes = [...new TextEncoder().encode(text)];
  let version = Math.max(1, Math.min(40, minVersion));
  while (version <= 40 && byteCapacity(version, ecc) < bytes.length) version++;
  if (version > 40) throw new Error("too long for a QR code");

  // The bit stream: mode (byte), length, the bytes, a terminator, then pad to whole codewords and fill.
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    data.push(b);
  }

  const size = version * 4 + 17;
  const base = new Grid(size);
  drawFunctionPatterns(base, version);
  drawCodewords(base, withEcc(data, version, ecc));
  let best: { mask: number; modules: boolean[]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(size);
    g.modules.splice(0, g.modules.length, ...base.modules);
    g.fixed.splice(0, g.fixed.length, ...base.fixed);
    applyMask(g, mask);
    drawFormat(g, ecc, mask);
    const score = penalty(g.modules, size);
    if (!best || score < best.score) best = { mask, modules: g.modules, score };
  }
  return { size, version, ecc, mask: best!.mask, modules: best!.modules };
}

/**
 * The code as text for a terminal: two rows of modules to a line in half blocks,
 * black on white set explicitly (so it reads the same in a dark terminal), with
 * the standard's four-module quiet zone.
 */
export function qrToTerminal(code: QrCode, quiet = 4): string {
  const n = code.size;
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && code.modules[y * n + x]!;
  const lines: string[] = [];
  for (let y = -quiet; y < n + quiet; y += 2) {
    let line = "\x1b[30;107m";
    for (let x = -quiet; x < n + quiet; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

/** The dark modules as one SVG path (a rectangle per run along a row), in module units, offset by the quiet zone. */
export function qrPath(code: QrCode, quiet = 4): string {
  const n = code.size;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!code.modules[y * n + x]) continue;
      let w = 1;
      while (x + w < n && code.modules[y * n + x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return d;
}

/** The code as an SVG (one path of dark squares on white, with the quiet zone), `px` pixels a side. */
export function qrToSvg(code: QrCode, px = 240, quiet = 4): string {
  const side = code.size + quiet * 2;
  const d = qrPath(code, quiet);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
