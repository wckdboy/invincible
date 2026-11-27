import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteName } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { desktopCommand } from "../../src/inv/desktop.ts";
import { CliError, EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { run } from "../../src/inv/run.ts";
import { agent, snapshot, T0, testIo } from "./fixtures.ts";

/*
 * inv desktop <agent> (docs/CLI.md): an agent's screen, looked at and never touched. It exits 0 once it has looked, 1 when
 * the node refuses (a VM with no desktop, in its words) or there is no such agent, 2 for bad usage, 30 when this device
 * may not, 31 when nothing answers.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });

/** A picture's bytes, as a node sends them (base64): not a real JPEG, only bytes to carry. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const HELD = { since: T0 - 30_000, idleSec: 120, mostSec: 900, endsInSec: 90 };

/** A node with Rio, whose look answers with that picture (and `held`), or refuses; what it was asked, in order. */
function node(over: { held?: typeof HELD | null; refuse?: CliError } = {}) {
  const asked: { name: RouteName; input: unknown }[] = [];
  const client: NodeClient = {
    label: "a stand-in node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "team") return snapshot([], [agent(), agent({ id: "rio", name: "Rio" })]) as T;
      if (name === "teamDesktop") {
        if (over.refuse) throw over.refuse;
        return { shot: { mediaType: "image/jpeg", data: Buffer.from(PICTURE).toString("base64") }, width: 1280, height: 800, ...(over.held !== undefined ? { held: over.held } : {}) } as T;
      }
      throw new Error(`asked ${name}`);
    },
  } as NodeClient;
  return { conn: async (): Promise<Connection> => ({ client, how: "paired", pairing: null }), asked };
}

describe("inv desktop <agent>", () => {
  test("a look: its size and that no one has it; the node is asked to look and nothing more, so nothing is taken over", async () => {
    const n = node({ held: null });
    const io = testIo({});
    expect(await desktopCommand(n.conn, ["rio"], flags(), io)).toBe(EXIT.ok);
    expect(n.asked).toEqual([
      { name: "team", input: undefined },
      { name: "teamDesktop", input: { id: "rio" } },
    ]);
    expect(io.stdout()).toBe("Rio's screen · 1280×800 · seen just now\nNo one has it: Rio's own desktop commands run.\nWatch it live, and take it over, in an app.\n");
  });

  test("by its name too; while you have it, until when, by the node's word, in UTC", async () => {
    const io = { ...testIo({}), now: () => Date.UTC(2026, 10, 27, 14, 3, 30) };
    const out: string[] = [];
    io.out = (text: string) => void out.push(text);
    expect(await desktopCommand(node({ held: HELD }).conn, ["Rio"], flags(), io)).toBe(EXIT.ok);
    expect(out.join("").split("\n")[1]).toBe("You have it until 14:05 UTC. Rio's desktop commands wait.");
  });

  test("--out writes its picture, yours alone (0600), replacing whole a file there before, and leaves nothing beside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-desktop-"));
    try {
      const file = join(dir, "rio.jpg");
      writeFileSync(file, "an older picture, readable by all", { mode: 0o644 });
      const io = testIo({});
      expect(await desktopCommand(node().conn, ["rio"], flags({ out: file }), io)).toBe(EXIT.ok);
      expect(new Uint8Array(readFileSync(file))).toEqual(PICTURE);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["rio.jpg"]);
      expect(io.stdout()).toContain(`Its picture: ${file}\n`);
      // A folder that isn't there: said, and 1, with nothing left behind.
      const nowhere = join(dir, "no-such-folder", "rio.jpg");
      const error = await desktopCommand(node().conn, ["rio"], flags({ out: nowhere }), testIo({})).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exit).toBe(EXIT.error);
      expect(existsSync(nowhere)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json: one object, the node's own held (null when no one has it, and from an older node too)", async () => {
    const io = testIo({});
    expect(await desktopCommand(node({ held: HELD }).conn, ["rio"], flags({ json: true }), io)).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout())).toEqual({ agent: "rio", width: 1280, height: 800, mediaType: "image/jpeg", held: HELD, out: null });
    const older = testIo({});
    expect(await desktopCommand(node().conn, ["rio"], flags({ json: true }), older)).toBe(EXIT.ok);
    expect(JSON.parse(older.stdout()).held).toBeNull();
  });

  test("no such agent, and a VM with no desktop (the node's refusal, in its words), are 1; this device may not, 30", async () => {
    const none = await desktopCommand(node().conn, ["noa"], flags(), testIo({})).catch((e: unknown) => e);
    expect((none as CliError).exit).toBe(EXIT.error);
    expect((none as CliError).message).toBe("no agent noa (ada, rio)");
    const refusal = new CliError("Rio's VM has no desktop just now");
    expect(await desktopCommand(node({ refuse: refusal }).conn, ["rio"], flags(), testIo({})).catch((e: unknown) => e)).toBe(refusal);
    const scope = new CliError("this device may not: sandbox", EXIT.refused);
    expect(((await desktopCommand(node({ refuse: scope }).conn, ["rio"], flags(), testIo({})).catch((e: unknown) => e)) as CliError).exit).toBe(EXIT.refused);
  });

  test("bad usage is 2: no agent, two, or a flag it doesn't take; a word a letter from it is a typo, not words to your agent", async () => {
    for (const argv of [["desktop"], ["desktop", "rio", "ada"], ["desktop", "rio", "--week"], ["desktops"]]) {
      const io = testIo({});
      expect(await run(argv, io)).toBe(EXIT.usage);
      if (argv[0] === "desktops") expect(io.stderr()).toContain("did you mean inv desktop?");
    }
  });
});
