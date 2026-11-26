import { describe, expect, test } from "bun:test";
import { artifactTitle, BLOCK_LIMITS, compactNumber, isBlockKind, readArtifact, readChart, readChoices, readStats, readSteps } from "../src/blocks.ts";

/*
 * What an agent may show beyond words (blocks.ts): a model writes it, so every reader checks every field and caps
 * every size, and says why it won't draw what it can't.
 */

const why = (read: { ok: boolean; why?: string }) => (read.ok ? "drawn" : read.why);

describe("a chart", () => {
  const spend = { type: "bar" as const, title: "Spend by month", unit: "DKK", labels: ["Aug", "Sep", "Oct"], series: [{ name: "Groceries", values: [3200, 2900, 3400] }, { name: "Transport", values: [800, null, 700] }] };

  test("is drawn as written: its type, title, unit, labels and series; a null is a gap", () => {
    expect(readChart(JSON.stringify(spend))).toEqual({ ok: true, value: spend });
  });

  test("with no type it's a line; one series with no name takes the title's; labels may be numbers (years)", () => {
    const read = readChart(JSON.stringify({ title: "Stars", labels: [2024, 2025], series: [{ values: [10, 42] }] }));
    expect(read).toEqual({ ok: true, value: { type: "line", title: "Stars", unit: null, labels: ["2024", "2025"], series: [{ name: "Stars", values: [10, 42] }] } });
  });

  test("anything it can't draw honestly is refused, with why", () => {
    expect(why(readChart("{not json"))).toBe("it isn't valid JSON");
    expect(why(readChart(JSON.stringify({ ...spend, type: "pie" })))).toBe("its type is one of line, area, bar, stacked");
    expect(why(readChart(JSON.stringify({ ...spend, labels: [] })))).toBe("it needs labels: what each value is for (a month, a name)");
    expect(why(readChart(JSON.stringify({ ...spend, series: [{ name: "A", values: [1, 2] }] })))).toBe("series 1 has 2 values for 3 labels");
    expect(why(readChart(JSON.stringify({ ...spend, series: [{ name: "A", values: [1, "2", 3] }] })))).toBe("series 1 has a value that isn't a number (null leaves a gap)");
    expect(why(readChart(JSON.stringify({ ...spend, type: "stacked", series: [{ name: "A", values: [1, -2, 3] }] })))).toBe("a stacked chart's values are parts of a whole: none below zero");
    expect(why(readChart(JSON.stringify({ ...spend, series: [spend.series[0], { ...spend.series[0] }] })))).toBe("two series are called Groceries");
    expect(why(readChart(JSON.stringify({ ...spend, series: [{ name: "A", values: [null, null, null] }] })))).toBe("it has no values");
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, values: [1, 2, 3] }));
    expect(why(readChart(JSON.stringify({ ...spend, series: seven })))).toBe(`at most ${BLOCK_LIMITS.series} series: fold the rest into one called Other`);
    expect(why(readChart(JSON.stringify({ ...spend, labels: Array.from({ length: 61 }, (_, i) => `d${i}`) })))).toBe("at most 60 labels: more is a table");
  });

  test("its words are one line each, cut to size, with nothing a terminal would act on", () => {
    const read = readChart(JSON.stringify({ ...spend, title: `A\u001b[31m title\n${"x".repeat(100)}`, series: [{ name: "  Groceries\t ", values: [1, 2, 3] }] }));
    expect(read.ok && read.value.title).toBe(`A [31m title ${"x".repeat(66)}…`);
    expect(read.ok && read.value.title!.length).toBe(BLOCK_LIMITS.title);
    expect(read.ok && read.value.series[0]!.name).toBe("Groceries");
  });
});

describe("figures, choices, steps and a page", () => {
  test("figures: a label and a value each, a change and which way is good if given; at most six", () => {
    const read = readStats(JSON.stringify([{ label: "Open pull requests", value: 12, delta: -3, note: "since Monday", good: "down" }, { label: "Uptime", value: "99.98%", good: "sideways" }]));
    expect(read).toEqual({
      ok: true,
      value: [
        { label: "Open pull requests", value: 12, unit: null, delta: -3, note: "since Monday", good: "down" },
        { label: "Uptime", value: "99.98%", unit: null, delta: null, note: null, good: null },
      ],
    });
    expect(why(readStats(JSON.stringify([{ label: "No value" }])))).toBe("figure 1 needs a label and a value");
    expect(why(readStats(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ label: `F${i}`, value: i })))))).toBe("at most 6 figures");
  });

  test("choices: short answers, each once, two to six", () => {
    expect(readChoices(JSON.stringify(["Ship it", "ship it", "Hold until Monday"]))).toEqual({ ok: true, value: ["Ship it", "Hold until Monday"] });
    expect(readChoices(JSON.stringify({ options: ["Yes", "No"] }))).toEqual({ ok: true, value: ["Yes", "No"] });
    expect(why(readChoices(JSON.stringify(["Only one"])))).toBe("at least two choices");
    expect(why(readChoices(JSON.stringify(["a", "b", "c", "d", "e", "f", "g"])))).toBe("at most 6 choices");
  });

  test("steps: each with where it stands; a bare line is still to do", () => {
    expect(readSteps(JSON.stringify([{ text: "Read the failing test", state: "done" }, "Fix the parser", { text: "Run the suite", state: "running" }]))).toEqual({
      ok: true,
      value: [
        { text: "Read the failing test", state: "done" },
        { text: "Fix the parser", state: "todo" },
        { text: "Run the suite", state: "todo" },
      ],
    });
    expect(why(readSteps("[]"))).toBe("steps are a list of {text, state}");
  });

  test("a page: HTML, not too big; its title is read as text", () => {
    const page = "<!doctype html><title>Budget &amp; plan</title><p>Hi</p>";
    expect(readArtifact(page)).toEqual({ ok: true, value: page });
    expect(artifactTitle(page)).toBe("Budget & plan");
    expect(artifactTitle("<p>no title</p>")).toBeNull();
    expect(why(readArtifact("just words"))).toBe("a page is HTML");
    expect(why(readArtifact(`<p>${"x".repeat(BLOCK_LIMITS.artifactChars)}</p>`))).toBe("a page is at most 200K characters");
  });

  test("only these names are blocks: any other code stays code", () => {
    expect(["chart", "stats", "choices", "steps", "artifact"].every(isBlockKind)).toBe(true);
    expect(["json", "html", "ts", ""].some(isBlockKind)).toBe(false);
  });
});

test("a figure reads as people read one: grouped under ten thousand, compact above, never 1,000K", () => {
  expect([1284, 7, 3.14159, 45.67, 10_000, 12_900, 123_456, 999_999, 4_200_000, -15_300].map(compactNumber)).toEqual(["1,284", "7", "3.14", "45.7", "10K", "12.9K", "123K", "1M", "4.2M", "-15.3K"]);
});
