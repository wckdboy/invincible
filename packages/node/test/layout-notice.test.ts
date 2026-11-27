import { describe, expect, test } from "bun:test";
import type { LayoutEntry } from "@invincible/sandbox";
import { layoutNotice } from "../src/daemon.ts";

/*
 * What you are told once when an agent's VM is moved to layout 2 (the owner's decision of 27 November 2026): the agent
 * by name, and what changed, by names and sizes alone.
 */
describe("the notice of a VM moved to layout 2", () => {
  const entries: LayoutEntry[] = [
    { name: ".agent", to: "work", kind: "dir", bytes: 10 },
    { name: ".config", to: "home", kind: "dir", bytes: 2048 },
    { name: ".memory", to: "home", kind: "dir", bytes: 100 },
    { name: ".memory/engram", to: "notes", kind: "dir", bytes: 3 * 2 ** 20 },
    { name: ".invincible-gateway.json", to: "drop", kind: "file", bytes: 300 },
  ];

  test("names the agent, what went to its HOME, and its notes, moved to a place of their own", () => {
    const said = layoutNotice("Ada", entries);
    expect(said.title).toBe("Ada's VM has a HOME of its own");
    expect(said.body).toContain("Ada's VM was made again with a HOME of its own, apart from its workspace");
    expect(said.body).toContain("Moved to its HOME: .config (2 KB), .memory (1 KB).");
    expect(said.body).toContain("Its notes (3 MB) were moved to a place of their own.");
    // (Never the lease, which every prepare writes anew, nor the workspace's own entries.)
    expect(said.body).not.toContain(".invincible-gateway.json");
    expect(said.body).not.toContain(".agent");
  });

  /** Whether text holds a lone UTF-16 surrogate: what a reader that wants well-formed text (Swift's JSONDecoder) refuses. */
  const lone = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  test("is well-formed text whatever the names hold (R4-5): a lone surrogate, from a name or from its cut, said as U+FFFD", () => {
    // A name as a list before R4-5 gave it on Linux for one that wasn't UTF-8 (Python's surrogateescape): a lone surrogate.
    const old = JSON.parse('{"name": ".x\\udcff", "to": "home", "kind": "dir", "bytes": 1024}') as LayoutEntry;
    expect(lone(old.name)).toBe(true);
    const said = layoutNotice("Ada", [old]);
    expect(lone(said.body)).toBe(false);
    expect(said.body).toContain("Moved to its HOME: .x\uFFFD (1 KB).");
    // As the list says such a name now (\xNN for each byte that isn't UTF-8): as it is.
    expect(layoutNotice("Ada", [{ ...old, name: ".x\\xff" }]).body).toContain("Moved to its HOME: .x\\xff (1 KB).");
    // A body past a notice's limit is cut there, and a pair the cut falls in is not left half.
    const long = Array.from({ length: 400 }, (_, i) => ({ name: `.\u{1F6E1}${i}`, to: "home" as const, kind: "dir" as const, bytes: 1 }));
    // (Its cut made to fall in a pair: where it falls follows the words before the names, so the agent's name, which is
    // among them, is made one letter longer at a time until it does. A name's entry is 15 characters there.)
    const pair = Array.from({ length: 16 }, (_, n) => `Ada${"a".repeat(n)}`).find((name) => layoutNotice(name, long).body.endsWith("\uFFFD"));
    expect(pair).toBeDefined();
    const cut = layoutNotice(pair ?? "Ada", long);
    expect(cut.body.length).toBe(2000);
    expect(lone(cut.body)).toBe(false);
    // (Its cut falls in a pair: the half of it left is said as U+FFFD.)
    expect(cut.body.endsWith("\uFFFD")).toBe(true);
    // And well-formed text is as it was: a pair is kept.
    expect(layoutNotice("Ada", [{ ...old, name: ".\u{1F6E1}" }]).body).toContain("Moved to its HOME: .\u{1F6E1} (1 KB).");
  });

  test("one with no notes yet is told where they'll be kept", () => {
    const said = layoutNotice("Ada", entries.filter((e) => e.to !== "notes"));
    expect(said.body).toContain("It had no notes yet: they'll be kept in a place of their own.");
  });
});
