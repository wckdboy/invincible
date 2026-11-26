import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { markGeometry } from "../../../packages/core/src/agent-mark.ts";
import { handleSeed } from "../../../packages/core/src/avatar.ts";
import { markParts } from "../../web/src/ui/mark.ts";
import { agentMarkSvg } from "../src/lib/mark-svg.ts";
import { FAVICON_SVG, icon64, ogImage, touchIcon } from "../src/lib/icons.ts";
import { MARK_POLYGON } from "../../../scripts/mark.ts";
import { MARK, markCorners } from "../src/lib/mark.ts";
import { AGENTS, agentOrb, MARKS, orbFiles } from "../src/lib/orbs.ts";

/*
 * What invincible.sh draws when it is built: the agents' marks (the app's own drawing of the Grille, written as SVG),
 * and the I-beam and the icons made from it. Each is the same every build.
 */

const SITE = resolve(import.meta.dir, "..");

/** A PNG's width, height and colour type, and its pixels' bytes (each row's filter byte first). */
function readPng(bytes: Uint8Array): { width: number; height: number; type: number; raw: Uint8Array } {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const chunks: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at), type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return { width: view.getUint32(16), height: view.getUint32(20), type: bytes[25]!, raw: new Uint8Array(inflateSync(Buffer.concat(chunks))) };
}

describe("the agents' marks: the app's own Grille, as SVG", () => {
  test("each job's, the same every time, drawn for a dark page and a light one: its slats, core's geometry", () => {
    for (const job of AGENTS) {
      const a = agentMarkSvg(job, MARKS[job], 72), b = agentMarkSvg(job, MARKS[job], 72);
      expect(a).toEqual(b);
      expect(a.dark).not.toBe(a.light);
      const parts = markParts(markGeometry({ mark: MARKS[job], seed: handleSeed(job), state: "idle", size: 72, t: null, since: null }));
      for (const svg of [a.dark, a.light]) {
        expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="72" height="72">');
        expect(svg).not.toMatch(/NaN|Infinity|undefined|<script|<foreignObject|<style|href=|url\(/);
        // One path a slat: three or four, each the app's band of the disc, turned to its angle.
        expect((svg.match(/<path /g) ?? []).length).toBe(parts.length);
        for (const part of parts) expect(svg).toContain(`<g transform="${part.turned}"><path d="${part.d}" transform="${part.slid}"`);
      }
    }
  });

  test("each in its own colour, as a node gives them: no two jobs' marks are the same drawing", () => {
    expect(new Set(AGENTS.map((job) => MARKS[job].color)).size).toBe(AGENTS.length);
    const drawings = AGENTS.map((job) => agentMarkSvg(job, MARKS[job], 72).light);
    expect(new Set(drawings).size).toBe(AGENTS.length);
  });

  test("their files are named by what is in them, so a browser may keep each for good", () => {
    const files = orbFiles();
    expect(files).toHaveLength(AGENTS.length * 2);
    for (const { href, svg } of files) {
      expect(href).toMatch(/^\/orbs\/[a-z]+-72-(light|ink)-[0-9a-f]{10}\.svg$/);
      const job = href.split("/")[2]!.split("-")[0]! as (typeof AGENTS)[number];
      expect(svg).toBe(href.includes("-light-") ? agentMarkSvg(job, MARKS[job], 72).dark : agentMarkSvg(job, MARKS[job], 72).light);
    }
    expect(agentOrb("coder", 72)).toBe(agentOrb("coder", 72));
  });
});

describe("the mark and the icons made from it", () => {
  test("the I-beam: one shape, twelve corners, in its square, symmetric about its middle", () => {
    const corners = markCorners();
    expect(corners).toHaveLength(12);
    for (const [x, y] of corners) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(MARK.box);
      expect(corners.some(([x2, y2]) => x2 === MARK.box - x && y2 === y)).toBe(true);
    }
  });

  test("the mark's shape is the repository's (scripts/mark.ts, the app icons' too): nothing on the site spells it out", () => {
    expect(MARK.points).toBe(MARK_POLYGON);
    const corner = MARK.points.split(" ").slice(0, 3).join(" ");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    const spelled = [...walk(join(SITE, "src")), ...walk(join(SITE, "public")), ...walk(join(SITE, "scripts"))].filter((path) => readFileSync(path, "utf8").includes(corner));
    expect(spelled.map((path) => relative(SITE, path))).toEqual([]);
  });

  test("a tab's icon: the mark in white on a black tile", () => {
    expect(FAVICON_SVG).toContain(`<polygon points="${MARK.points}" fill="#ffffff"/>`);
    expect(FAVICON_SVG).toContain('fill="#000000"');
  });

  test("the PNGs: their sizes, the same bytes every build, black with the mark in white", () => {
    expect(icon64()).toEqual(icon64());
    const small = readPng(icon64());
    expect([small.width, small.height, small.type]).toEqual([64, 64, 6]);
    const touch = readPng(touchIcon());
    expect([touch.width, touch.height, touch.type]).toEqual([180, 180, 2]);
    const og = readPng(ogImage());
    expect([og.width, og.height, og.type]).toEqual([1200, 630, 2]);
    // The touch icon's corner is its black ground, and its middle the mark's white web.
    const pixel = (png: ReturnType<typeof readPng>, x: number, y: number) => {
      const at = y * (png.width * 3 + 1) + 1 + x * 3;
      return [...png.raw.subarray(at, at + 3)];
    };
    expect(pixel(touch, 2, 2)).toEqual([0, 0, 0]);
    expect(pixel(touch, 90, 90)).toEqual([255, 255, 255]);
    expect(pixel(og, 600, 315)).toEqual([255, 255, 255]);
    expect(pixel(og, 20, 20)).toEqual([0, 0, 0]);
  });
});
