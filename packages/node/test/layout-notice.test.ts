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

  test("one with no notes yet is told where they'll be kept", () => {
    const said = layoutNotice("Ada", entries.filter((e) => e.to !== "notes"));
    expect(said.body).toContain("It had no notes yet: they'll be kept in a place of their own.");
  });
});
