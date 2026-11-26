import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { HandedView } from "@invincible/core";
import { handCommand, handedVerdict } from "../src/fabric-cli.ts";

/*
 * `invincible hand` and `invincible handed`, against a stand-in node: what you type becomes the hand-off's input, its
 * trail is printed as it comes, and the verdict (in the apps' words) is the exit code.
 */

const base: HandedView = {
  id: "h_AAAAAAAAAAAAAAAAAAAAAA",
  node: { id: "n_b", name: "beta" },
  task: "task-abcdefghijkl",
  agent: { id: "ada", name: "Ada" },
  title: "Write the file",
  goal: "Write the file",
  gates: ["test -f out.txt"],
  tools: [],
  phase: "ended",
  status: "done",
  path: "qamp",
  proof: { state: "checked", verified: true, ended: "done", proof: { before: [1], after: [0], review: "pass", sameModel: false } },
  output: "",
  error: null,
  createdAt: 1,
  firstOutputAt: 2,
  endedAt: 3,
  trail: [],
};

afterEach(() => {
  process.exitCode = 0;
});

describe("a handed task's verdict, from the proof the node that ran it signed", () => {
  test("Proven: its gate failed before the work and passes after, and another model's reviewer passed it", () => {
    expect(handedVerdict(base)).toEqual({ word: "Proven", proven: true });
  });

  test("reviewed, but its gate passed before any work: not proven", () => {
    expect(handedVerdict({ ...base, proof: { state: "checked", verified: true, ended: "done", proof: { before: [0], after: [0], review: "pass", sameModel: false } } })).toEqual({ word: "Reviewed, not proven", proven: false });
  });

  test("a proof that didn't check is never proven, and says why", () => {
    expect(handedVerdict({ ...base, proof: { state: "refused", why: "its signature doesn't check" } })).toEqual({ word: "Not proven: its proof didn't check (its signature doesn't check)", proven: false });
  });

  test("stopped there, or still under way", () => {
    expect(handedVerdict({ ...base, status: "stopped", proof: { state: "checked", verified: false, ended: "stopped", proof: null } })?.word).toBe("Stopped");
    expect(handedVerdict({ ...base, phase: "following", status: "running" })).toBeNull();
  });
});

describe("the commands", () => {
  test("hand: what you typed is the hand-off, checked as the node checks it; --follow prints its trail and exits with its verdict", async () => {
    const asked: { name: string; input: unknown }[] = [];
    let polls = 0;
    const api = {
      call: async <T,>(name: string, input?: unknown): Promise<T> => {
        asked.push({ name, input });
        if (name === "handTask") return { ...base, phase: "handing", status: "handing", proof: { state: "none" }, tools: ["fleet"] } as T;
        polls++;
        return (polls < 2 ? { ...base, phase: "following", status: "running", trail: [{ at: 5, text: "Gates · 1 of yours" }] } : { ...base, trail: [{ at: 6, text: "Review · pass" }] }) as T;
      },
    };
    const printed: string[] = [];
    const out = spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
    try {
      await handCommand(api, "hand", ["beta", "Write", "the", "file"], { gate: ["test -f out.txt"], agent: "ada", tools: "fleet", follow: true });
    } finally {
      out.mockRestore();
    }
    expect(asked[0]).toEqual({ name: "handTask", input: { node: "beta", goal: "Write the file", gates: ["test -f out.txt"], agent: "ada", tools: ["fleet"] } });
    expect(printed.some((l) => l.includes("Gates · 1 of yours"))).toBe(true);
    expect(printed.some((l) => l.includes("Proven"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("a tool no run may be given is refused before anything is sent", async () => {
    const api = { call: async () => ({}) as never };
    await expect(handCommand(api, "hand", ["beta", "Do it"], { tools: "remember" })).rejects.toThrow(/tools/);
  });

  test("handed <id>, not proven: the exit code says so", async () => {
    const api = { call: async <T,>(): Promise<T> => ({ ...base, proof: { state: "refused", why: "it is the proof of another hand-off" } }) as T };
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      await handCommand(api, "handed", [base.id], {});
    } finally {
      out.mockRestore();
    }
    expect(process.exitCode).toBe(1);
  });
});
