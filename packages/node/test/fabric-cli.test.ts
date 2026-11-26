import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { HandedView } from "@invincible/core";
import { fabricCommand, handCommand, handedVerdict } from "../src/fabric-cli.ts";

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

describe("invincible fabric: the node's own switch", () => {
  const printed = async (work: () => Promise<void>): Promise<string> => {
    const out: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    try {
      await work();
    } finally {
      log.mockRestore();
    }
    return out.join("\n");
  };
  const kept = () => {
    let fabric: boolean | undefined;
    return { readConfig: () => ({ ...(fabric === undefined ? {} : { fabric }) }), writeConfig: (c: { fabric: boolean }) => void (fabric = c.fabric), get: () => fabric };
  };

  test("a running node applies it at once, and says its sidecar's state", async () => {
    const sent: unknown[] = [];
    const api = { call: async (_name: string, input: unknown) => (sent.push(input), { on: true, state: "up", why: null, did: "did:key:z6MkFAKEFAKEFAKEFAKEFAKEFAKE", address: "qamp://did:key:z6MkFAKE@192.0.2.10:7410" }) };
    const config = kept();
    const text = await printed(() => fabricCommand(api as never, "on", config));
    expect(sent).toEqual([{ on: true }]);
    expect(text).toContain("fabric: on · its sidecar is up as did:key:z6MkFAKEFAKEFA… on 192.0.2.10:7410");
    // The node wrote its own config: nothing here did.
    expect(config.get()).toBeUndefined();
  });

  test("a node that isn't running keeps it in its config for its next start; status reads it", async () => {
    const api = { call: async () => Promise.reject(new Error("no daemon on http://127.0.0.1:7400 — start it with `invincible serve`")) };
    const config = kept();
    expect(await printed(() => fabricCommand(api as never, "on", config))).toBe("fabric: on · the node isn't running: it applies this when it next starts");
    expect(config.get()).toBe(true);
    expect(await printed(() => fabricCommand(api as never, "status", config))).toBe("fabric: on · the node isn't running");
  });

  test("anything else is its usage, and a node's refusal is said as it is (nothing is written behind its back)", async () => {
    const config = kept();
    await expect(fabricCommand({ call: async () => ({}) } as never, "maybe", config)).rejects.toThrow("usage: invincible fabric on|off|status");
    await expect(fabricCommand({ call: async () => Promise.reject(new Error("chats are yours alone")) } as never, "on", config)).rejects.toThrow("chats are yours alone");
    expect(config.get()).toBeUndefined();
  });
});
