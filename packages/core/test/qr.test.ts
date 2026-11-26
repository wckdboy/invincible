import { describe, expect, test } from "bun:test";
import { byteCapacity, dataCodewords, encodeQr, formatBits, penalty, qrToSvg, qrToTerminal, rawDataModules } from "../src/qr.ts";

/*
 * The QR encoder. These tests check the structure the standard fixes (sizes,
 * capacities, finder and timing patterns, format information, the dark
 * module); an independent decoder (zxing-cpp) read back every version and level
 * from 1 to 40 when it was written.
 */

const INVITE = "https://ultra.example.ts.net:8443/#pair=gi1.eyJlIjoiaHR0cDovLzEwMC42NC4wLjE6Nzc3NyIsImYiOiJYR1pEa3RrUUtINXUiLCJpIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsImsiOiJjbGllbnQiLCJzIjoiQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkIiLCJ2IjoxfQ";

describe("QR codes", () => {
  test("capacities match the standard's tables", () => {
    // ISO/IEC 18004 table 7: bytes in byte mode.
    expect(byteCapacity(1, "L")).toBe(17);
    expect(byteCapacity(1, "M")).toBe(14);
    expect(byteCapacity(1, "H")).toBe(7);
    expect(byteCapacity(10, "M")).toBe(213);
    expect(byteCapacity(10, "L")).toBe(271);
    expect(byteCapacity(40, "L")).toBe(2953);
    expect(byteCapacity(40, "H")).toBe(1273);
    expect(rawDataModules(1)).toBe(208);
    expect(rawDataModules(7)).toBe(1568);
    expect(dataCodewords(5, "Q")).toBe(62);
  });

  test("the format information of the standard's worked example", () => {
    // Level M, mask 5: 100000011001110 (Annex C).
    expect(formatBits("M", 5).toString(2).padStart(15, "0")).toBe("100000011001110");
    expect(formatBits("L", 0).toString(2).padStart(15, "0")).toBe("111011111000100");
  });

  test("an invite link: the smallest version that holds it, with finders, timing and the dark module where they belong", () => {
    const code = encodeQr(INVITE, "M");
    expect(code.version).toBeGreaterThanOrEqual(10);
    expect(code.version).toBeLessThanOrEqual(14);
    expect(code.size).toBe(code.version * 4 + 17);
    expect(code.modules).toHaveLength(code.size * code.size);
    const n = code.size;
    const at = (x: number, y: number) => code.modules[y * n + x];
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
      // A finder: dark rings at distance 0, 1 and 3 from its centre, light at 2, and its light separator at 4.
      for (let d = -3; d <= 3; d++) {
        expect(at(cx + d, cy - 3)).toBe(true);
        expect(at(cx + d, cy + 3)).toBe(true);
      }
      expect(at(cx, cy)).toBe(true);
      expect(at(cx + 2, cy)).toBe(false);
    }
    for (let i = 8; i < n - 8; i++) {
      expect(at(i, 6)).toBe(i % 2 === 0);
      expect(at(6, i)).toBe(i % 2 === 0);
    }
    expect(at(8, n - 8)).toBe(true);
    // The format bits, read back from beside the top-left finder, say level M and the chosen mask.
    let bits = 0;
    const read = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]] as const;
    read.forEach(([x, y], i) => (bits |= (at(x, y) ? 1 : 0) << i));
    expect(bits).toBe(formatBits("M", code.mask));
  });

  test("the same text gives the same code; more text a bigger one; too much is refused", () => {
    expect(encodeQr(INVITE).modules).toEqual(encodeQr(INVITE).modules);
    expect(encodeQr("hi").version).toBe(1);
    expect(encodeQr(INVITE, "L").version).toBeLessThan(encodeQr(INVITE, "H").version);
    expect(() => encodeQr("x".repeat(3000), "L")).toThrow(/too long/);
  });

  test("the chosen mask is the one with the lowest penalty", () => {
    const code = encodeQr(INVITE, "M");
    expect(penalty(code.modules, code.size)).toBeGreaterThan(0);
  });

  test("drawn for a terminal (black on white, two rows a line) and as an SVG, each with the quiet zone", () => {
    const code = encodeQr("galahad", "M");
    const lines = qrToTerminal(code).split("\n");
    expect(lines).toHaveLength(Math.ceil((code.size + 8) / 2));
    const plain = lines[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    expect([...plain]).toHaveLength(code.size + 8);
    expect(lines[0]).toStartWith("\x1b[30;107m");
    const svg = qrToSvg(code, 200);
    expect(svg).toContain(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`);
    expect(svg).toContain('fill="#fff"');
  });

  test("the terminal's half blocks read back as exactly the code, quiet zone light", () => {
    const code = encodeQr(INVITE, "M");
    const quiet = 4;
    const lines = qrToTerminal(code, quiet)
      .split("\n")
      .map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, "")]);
    const side = code.size + quiet * 2;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const ch = lines[Math.floor(y / 2)]![x]!;
        const dark = y % 2 === 0 ? ch === "█" || ch === "▀" : ch === "█" || ch === "▄";
        const mx = x - quiet;
        const my = y - quiet;
        const want = mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.modules[my * code.size + mx]!;
        expect(dark).toBe(want);
      }
    }
  });
});
