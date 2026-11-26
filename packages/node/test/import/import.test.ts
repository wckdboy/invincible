import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABOUT_YOU_TAG, exportIdentity, newNodeIdentity, nodeIdentity, sha256Bytes, teamArmLabel, utf8 } from "@invincible/core";
import { LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG, resolveProvider } from "@invincible/models";
import { ChatStore } from "../../src/chats.ts";
import type { Home } from "../../src/home.ts";
import { importCommand } from "../../src/import/index.ts";
import { openReadOnly } from "../../src/import/sqlite.ts";
import { TeamStore } from "../../src/team-store.ts";
import { COMING, PHRASES, STAYING } from "./fixture-data.ts";
import { newHome, oldHome, runImport, snapshot } from "./homes.ts";

/** SQLite's open flags, read only and the name a URI: Linux's SQLite reads a `file:` name as a URI only when asked. */
const READ_ONLY_URI = 0x00000001 | 0x00000040;

/*
 * `invincible import galahad` against the fixture Galahad home, which Galahad's own code made (make-fixture.ts): each
 * kind comes as it should, nothing in that home is written, a second run changes nothing, and what can't come is said
 * by name and never by its value.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "import-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const setup = async () => ({ old: oldHome(join(root, "galahad")), home: await newHome(join(root, "invincible")) });

/** This node's stores, opened as the node opens them, to see what came. */
async function opened(home: Home) {
  const identity = await home.loadIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  return { identity, store, vault: new Vault(store, identity) };
}

/** The fixture's node, whose keys are derived from its phrases. */
const fromPhrase = (phrase: string) => sha256Bytes(utf8(phrase));
const OLD_NODE = nodeIdentity(fromPhrase(PHRASES.sign), fromPhrase(PHRASES.box));

/** The fixture's chats by their titles (their ids were made when it was). */
function chatIds(old: string): Record<string, string> {
  const db = new Database(`file:${join(old, "chats.db")}?mode=ro`, READ_ONLY_URI);
  try {
    return Object.fromEntries(db.query<{ id: string; title: string }, []>("SELECT id, title FROM conversations").all().map((r) => [r.title, r.id]));
  } finally {
    db.close();
  }
}

/** A database of the old home's copy, opened to break it (the test's own copy, never the fixture). */
function damage(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("a dry run", () => {
  test("says what would come, by name and count, and never a value; it writes nothing, there or here", async () => {
    const { old, home } = await setup();
    const before = { old: snapshot(old), here: snapshot(home.dir) };
    const { code, out } = await runImport(old, home, { dryRun: true });
    expect(code).toBe(0);
    expect(snapshot(old)).toEqual(before.old);
    expect(snapshot(home.dir)).toEqual(before.here);
    const ids = chatIds(old);
    for (const line of [
      "A dry run: nothing is written, here or there.",
      "  secrets      8 to bring, sealed anew in this node's vault and never shown: anthropic, deepseek, github, gmail, pin, search-api, weather, zai-coding",
      "  providers    4 to bring: anthropic, deepseek, ollama, zai-coding (a coding plan)",
      "  roster       4 roles to bring: chat, engineer, planner, reviewer",
      "  thinking     2 to bring: engineer (high), planner (auto)",
      "  prices       2 to bring: anthropic/claude-opus-5-5, deepseek/deepseek-v4-pro",
      "  about you    3 to bring: 2 kept, 1 proposed (it waits for you to keep it)",
      "  memory       6 notes to bring",
      "  projects     2 to bring: app, site",
      "  connectors   3 to bring: github (as Invincible ships it), gmail (as Invincible ships it), weather (as you made it)",
      "  agents       4 to bring: builder (engineer · native · example/app), goose (engineer · acp), quiet (engineer · opencode · sensitive), scout (researcher · native · made by your agent)",
      "  chats        none asked for; 4 chats there (--chats all, or --chats <id>,<id>):",
      `${ids["Plan the launch"]}  Plan the launch · 4 messages`,
      `${ids["What did I spend"]}  What did I spend · 2 messages · it read the bank, so it stays behind`,
      "Stays behind:",
      "  its identity, devices and fleet: your devices pair with this node anew",
      "  2 keys of its chat apps (Telegram, Slack): a bot answers one node at a time, and each gateway's device key is its fleet's; connect them here at the cutover",
      "  its Apple push key: it pushes to its own app; set the key for this node's app when you pair it",
      "  1 webhook key of its loops, which stay behind",
      "  1 memory you forgot there",
      "  its agents' looks, temperaments and seating, their rooms, their tasks and their VMs",
      "  1 agent you removed there",
      "  its 1 loop and 1 rule: add again here what you still want",
      "38 things would come. Run it without --dry-run, with this node stopped, to bring them.",
    ]) expect(out).toContain(line);
    // Not one value of its vault, nor a piece of one: every one of them is spelled FAKE.
    for (const value of [...Object.values(COMING), ...Object.values(STAYING)]) expect(out).not.toContain(value);
    expect(out).not.toContain("FAKE");
  });
});

describe("what comes, kind by kind", () => {
  test("the vault's secrets, opened there and sealed anew here, with what each was pinned to; the chat apps', the old app's push key and the loops' stay behind", async () => {
    const { old, home } = await setup();
    expect((await runImport(old, home)).code).toBe(0);
    const { store, vault } = await opened(home);
    for (const [name, value] of Object.entries(COMING)) expect([name, vault.reveal(name)]).toEqual([name, value]);
    const info = (name: string) => {
      const i = vault.info(name)!;
      return { provider: i.provider, origin: i.origin, label: i.label, hint: i.hint };
    };
    expect(info("anthropic")).toEqual({ provider: "anthropic", origin: "https://api.anthropic.com", label: null, hint: "…0000" });
    expect(info("github")).toEqual({ provider: "github", origin: "https://api.github.com", label: "GitHub", hint: "…-000" });
    expect(info("search-api")).toEqual({ provider: null, origin: "https://api.search.example", label: "A search API", hint: "…0000" });
    expect(info("pin").hint).toBeNull();
    for (const name of [...Object.keys(STAYING), "telegram:device"]) expect([name, vault.has(name)]).toEqual([name, false]);
    // Sealed under this node's own vault key: not the old ciphertext copied.
    const oldMind = new Database(`file:${join(old, "mind.db")}?immutable=1`, READ_ONLY_URI);
    const oldCt = JSON.parse(oldMind.query<{ v: string }, []>("SELECT v FROM v_lww WHERE k = 'secret:github'").get()!.v).ct;
    oldMind.close();
    expect(store.lww<{ ct: string; kid: string }>("secret:github")!.value!.ct).not.toBe(oldCt);
    store.close();
  });

  test("providers and their coding plans, the roster, how hard each role thinks, and prices, as they were; a provider answers on its key here", async () => {
    const { old, home } = await setup();
    await runImport(old, home);
    const { store, vault } = await opened(home);
    expect(store.lww("provider:zai-coding")!.value).toEqual({ id: "zai-coding", kind: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4", secret: "zai-coding" });
    expect(store.lww("provider:ollama")!.value).toEqual({ id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama on this node" });
    // One removed there has nothing to bring.
    expect(store.lww("provider:gone")).toBeNull();
    expect(store.lww("roster:engineer")!.value).toEqual(["zai-coding/glm-5.3", "deepseek/deepseek-v4-pro"]);
    expect(store.lww("roster:reviewer")!.value).toEqual(["anthropic/claude-opus-5-5"]);
    expect(store.lww("effort:engineer")!.value).toBe("high");
    expect(store.lww("effort:planner")!.value).toBe("auto");
    expect(store.lww("price:anthropic/claude-opus-5-5")!.value).toEqual({ input: 5, output: 25, cached: 0.5 });
    // Its key, under its provider and its pinned address, is the one this node sends (a plan's, to a coding tool alone).
    expect(resolveProvider(store, vault, "deepseek")!.apiKey).toBe(COMING.deepseek);
    expect(resolveProvider(store, vault, "zai-coding", "tool")!.apiKey).toBe(COMING["zai-coding"]);
    expect(resolveProvider(store, vault, "zai-coding")!.apiKey).toBeNull();
    store.close();
  });

  test("what it learned about you and its notes, each yours or an agent's as it was, from where it came; what you forgot there stays forgotten", async () => {
    const { old, home } = await setup();
    await runImport(old, home);
    const { store } = await opened(home);
    expect(store.memoriesTagged(ABOUT_YOU_TAG, 50, true).map((m) => m.text).sort()).toEqual(["Prefers short answers, the command first.", "Works in Copenhagen time."]);
    expect(store.memoriesTagged(ABOUT_YOU_TAG, 50, false).map((m) => [m.text, m.trust])).toEqual([["Never ships on a Friday.", "agent"]]);
    const all = store.recall(undefined, 100);
    const of = (text: string) => all.filter((m) => m.text === text);
    expect(of("The app's tests run with bun test.").map((m) => [m.trust, m.tags])).toEqual([["agent", ["project:app"]]]);
    expect(of("A page said the weather API moved to v2.").map((m) => m.trust)).toEqual(["untrusted"]);
    expect(of("Galahad keeps the knights' work in their VMs.")).toHaveLength(2);
    expect(of("An old note, since forgotten.")).toEqual([]);
    expect(all).toHaveLength(9);
    // None names a device of the old fleet; where each came from is kept.
    expect(all.every((m) => m.via === null)).toBe(true);
    const provs = store.db.query<{ raw: string }, []>("SELECT raw FROM events WHERE kind = 'memory.added'").all().map((r) => JSON.parse(r.raw).prov);
    expect(provs).toContainEqual({ trust: "untrusted", source: "https://docs.weather.example/api" });
    expect(provs).toContainEqual({ trust: "agent", source: teamArmLabel(OLD_NODE.id, "builder") });
    store.close();
  });

  test("projects, with their repositories and instructions", async () => {
    const { old, home } = await setup();
    await runImport(old, home);
    const { store } = await opened(home);
    expect(store.lww("project:app")!.value).toEqual({ id: "app", name: "The app", instructions: "Run bun test before you say done.", repo: "https://github.com/example/app" });
    expect(store.lww("project:site")!.value).toEqual({ id: "site", name: "The site", instructions: "" });
    store.close();
  });

  test("connectors: one Invincible ships comes as it ships it, one of yours as you made it; who may use one names this node's agents and the primary", async () => {
    const { old, home } = await setup();
    await runImport(old, home);
    const { identity, store } = await opened(home);
    const gmail = store.lww<Record<string, unknown>>("connector:gmail")!.value!;
    expect(gmail.access).toEqual({ only: "primary", allowed: [teamArmLabel(identity.id, "builder")] });
    expect(gmail.description).toBe(CATALOG.gmail!.manifest.description);
    expect(gmail.auth).toEqual(CATALOG.gmail!.manifest.auth);
    expect(gmail.private).toBe(true);
    expect(JSON.stringify(gmail)).not.toContain("Galahad");
    expect(store.lww("connector:github")!.value).toEqual(JSON.parse(JSON.stringify(CATALOG.github!.manifest)));
    const weather = store.lww<Record<string, unknown>>("connector:weather")!.value!;
    expect(weather.access).toEqual({ only: "primary", allowed: ["primary", "claude-laptop", teamArmLabel(identity.id, "scout")] });
    expect(weather.description).toBe("The weather, for Galahad to tell you.");
    expect(weather.auth).toEqual({ secret: "weather", scheme: "header", header: "x-api-key" });
    store.close();
  });

  test("its knights become agents' profiles: job, whose words it is, models, harness, keys, repository and notes; their looks, VMs and the removed stay behind", async () => {
    const { old, home } = await setup();
    await runImport(old, home);
    const team = new TeamStore(join(home.dir, "team.db"));
    const profile = (id: string) => {
      const { turnsToday: _t, ...rest } = team.agent(id)!;
      return rest;
    };
    expect(team.agents().map((a) => a.id)).toEqual(["builder", "goose", "quiet", "scout"]);
    const builder = profile("builder");
    expect(builder).toEqual({
      id: "builder",
      name: "Builder",
      instructions: "Builds and tests the app, and ships it as a pull request.",
      role: "engineer",
      harness: "native",
      keys: [{ secret: "search-api", header: "authorization", write: false }],
      enabled: true,
      dailyTurns: 40,
      repository: "https://github.com/example/app",
      workspaceNode: null,
      workspace: null,
      memory: "The app's CI runs on the forge; bun test is its gate.",
      avatar: undefined,
      createdBy: "owner",
      instructionsBy: "owner",
      createdAt: builder.createdAt,
      updatedAt: builder.updatedAt,
    });
    // When it was made there, not when it came: a worker your agent made long ago is no worker made today.
    const made = new Database(`file:${join(old, "team.db")}?mode=ro`, READ_ONLY_URI);
    const was = JSON.parse(made.query<{ value: string }, []>("SELECT value FROM team_teammates WHERE id = 'builder'").get()!.value);
    made.close();
    expect([builder.createdAt, builder.updatedAt]).toEqual([was.createdAt, was.updatedAt]);
    // Its job written by Galahad stays its primary's words, fenced as an agent's planning and never the owner's.
    expect([profile("scout").createdBy, profile("scout").instructionsBy]).toEqual(["primary", "primary"]);
    expect(profile("quiet")).toEqual(expect.objectContaining({ models: ["nearai/fake-private-model"], sensitive: true, harness: "opencode", enabled: false, dailyTurns: 12 }));
    expect(profile("goose")).toEqual(expect.objectContaining({ harness: "acp", acp: "goose acp" }));
    expect(team.agent("retired")).toBeNull();
    expect(team.removed()).toEqual([]);
    team.close();
  });

  test("chats only as --chats says: none by default; one by its id; all but the one that read the bank, with their files", async () => {
    const { old, home } = await setup();
    const ids = chatIds(old);
    await runImport(old, home);
    expect(existsSync(join(home.dir, "chats.db"))).toBe(false);

    const one = await runImport(old, home, { chats: ids["Plan the launch"] });
    expect(one.out).toContain(`  chats        1 brought: ${ids["Plan the launch"]} (Plan the launch · 4 messages)`);
    let chats = new ChatStore(join(home.dir, "chats.db"));
    const launch = chats.get(ids["Plan the launch"]!)!;
    expect([launch.title, launch.project, launch.pinned, launch.unread]).toEqual(["Plan the launch", "app", true, false]);
    expect(launch.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What's left before the launch?"],
      ["assistant", "Two things: the tests and the notes."],
      ["user", "Then the tests first."],
      ["assistant", "The tests first, then."],
    ]);
    expect(launch.messages[1]!.steps).toEqual([{ kind: "model", ref: "deepseek/deepseek-v4-pro" }, { kind: "tool", id: "t1", name: "recall", title: "Recall", input: "{}", ok: true, summary: "2 notes" }]);
    // Its story covers what it covered there: through its second message, as this node numbers it.
    expect(chats.told(launch.id).story).toEqual({ text: "They planned the launch: the tests, then the notes.", through: launch.messages[1]!.id });
    chats.close();

    const all = await runImport(old, home, { chats: "all" });
    expect(all.code).toBe(0);
    expect(all.out).toContain("  chats        2 brought: ");
    expect(all.out).toContain("1 here already");
    expect(all.out).toContain(`  the chat that read the bank (${ids["What did I spend"]}): Invincible keeps no bank`);
    chats = new ChatStore(join(home.dir, "chats.db"));
    expect(chats.list().map((c) => c.title).sort()).toEqual(["Plan the launch", "Read my notes", "Watch the build"]);
    const notes = chats.get(ids["Read my notes"]!)!;
    const file = notes.messages[0]!.attachments![0]!;
    expect([file.name, file.type, notes.unread]).toEqual(["notes.txt", "text/plain", true]);
    expect(readFileSync(join(home.dir, "uploads", file.id), "utf8")).toBe("Fixture notes: nothing here is real.\n");
    const watch = chats.get(ids["Watch the build"]!)!;
    expect(watch.messages.map((m) => [m.role, m.status, m.look?.note ?? null])).toEqual([["user", "done", "the build"], ["assistant", "stopped", null]]);
    chats.close();
  });

  test("a chat whose file is no longer there comes, saying so, its message still naming the file", async () => {
    const { old, home } = await setup();
    const ids = chatIds(old);
    for (const name of readdirSync(join(old, "uploads"))) rmSync(join(old, "uploads", name));
    const { code, out } = await runImport(old, home, { chats: ids["Read my notes"] });
    expect(code).toBe(0);
    expect(out).toContain(`  chats        1 brought: ${ids["Read my notes"]} (Read my notes · 2 messages · 1 file no longer there)`);
    const chats = new ChatStore(join(home.dir, "chats.db"));
    const file = chats.get(ids["Read my notes"]!)!.messages[0]!.attachments![0]!;
    expect(existsSync(join(home.dir, "uploads", file.id))).toBe(false);
    chats.close();
  });

  test("never its identity, devices or fleet: every event here is this node's own, and its keys are as they were", async () => {
    const { old, home } = await setup();
    const keys = readFileSync(home.keyFilePath);
    await runImport(old, home, { chats: "all" });
    expect(readFileSync(home.keyFilePath)).toEqual(keys);
    const { identity, store } = await opened(home);
    expect(store.devices(true).map((d) => d.id)).toEqual([identity.id]);
    expect(store.db.query<{ device: string }, []>("SELECT DISTINCT device FROM events").all().map((r) => r.device)).toEqual([identity.id]);
    const config = JSON.parse(readFileSync(join(old, "config.json"), "utf8")) as { fleet: string };
    expect(store.fleet).not.toBe(config.fleet);
    const mentions = store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE instr(raw, ?) > 0");
    expect(mentions.get(OLD_NODE.id)!.n).toBe(0);
    expect(mentions.get(config.fleet)!.n).toBe(0);
    expect(store.db.query("SELECT * FROM v_rejected").all()).toEqual([]);
    store.close();
  });

  test("the old home's bytes don't change: not a file made, removed or altered, whatever came", async () => {
    const { old, home } = await setup();
    const before = snapshot(old);
    expect(Object.keys(before)).toContain("mind.db");
    await runImport(old, home, { chats: "all" });
    expect(snapshot(old)).toEqual(before);
  });

  test("a second run changes nothing, here or there, and says so", async () => {
    const { old, home } = await setup();
    await runImport(old, home, { chats: "all" });
    const before = { old: snapshot(old), here: snapshot(home.dir) };
    const again = await runImport(old, home, { chats: "all" });
    expect(again.code).toBe(0);
    expect(snapshot(old)).toEqual(before.old);
    expect(snapshot(home.dir)).toEqual(before.here);
    for (const line of ["  secrets      8 here already", "  memory       6 here already", "  agents       4 here already", "  chats        3 here already", "Nothing to bring: everything that can come is here already."]) expect(again.out).toContain(line);
  });

  test("a run again opens no secret that is here already: one whose vault no longer opens has nothing to say", async () => {
    const { old, home } = await setup();
    await runImport(old, home);
    writeFileSync(join(old, "keys.json"), exportIdentity(newNodeIdentity()));
    const again = await runImport(old, home);
    expect(again.code).toBe(0);
    expect(again.out).toContain("  secrets      8 here already");
    expect(again.out).not.toContain("won't open");
  });

  test("what came replays to the same state: rebuilt from the log, and in any order on a replica of its own", async () => {
    const { old, home } = await setup();
    await runImport(old, home, { chats: "all" });
    const { store } = await opened(home);
    const digest = store.digest();
    store.rebuild();
    expect(store.digest()).toBe(digest);
    const events = store.db.query<{ raw: string }, []>("SELECT raw FROM events").all().map((r) => JSON.parse(r.raw));
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let round = 0; round < 3; round++) {
      const shuffled = [...events].sort(() => random() - 0.5);
      const replica = new LedgerStore(":memory:");
      replica.expectFleet(store.fleet!);
      expect(replica.ingest(shuffled).invalid).toEqual([]);
      expect(replica.digest()).toBe(digest);
      replica.close();
    }
    store.close();
  });
});

describe("what can't come is said by name, and the rest comes", () => {
  test("a home whose keys aren't its vault's node's, or don't open its key, or are in the OS keychain: every secret skipped by name, never shown", async () => {
    for (const [n, [why, change]] of ([
      ["its vault key isn't sealed to the node whose keys this home holds", (old: string) => writeFileSync(join(old, "keys.json"), exportIdentity(newNodeIdentity()))],
      ["its vault key doesn't open with this home's node key", (old: string) => writeFileSync(join(old, "keys.json"), exportIdentity(nodeIdentity(fromPhrase(PHRASES.sign), fromPhrase("another box key: not the one it was sealed to"))))],
      ["its node keeps its keys in the OS keychain, which this import doesn't open", (old: string) => {
        rmSync(join(old, "keys.json"));
        const config = JSON.parse(readFileSync(join(old, "config.json"), "utf8"));
        writeFileSync(join(old, "config.json"), JSON.stringify({ ...config, keystore: "os" }));
      }],
    ] as const).entries()) {
      const old = oldHome(join(root, `galahad-${n}`));
      change(old);
      const home = await newHome(join(root, `invincible-${n}`));
      const { code, out } = await runImport(old, home);
      expect([why, code]).toEqual([why, 2]);
      for (const name of Object.keys(COMING)) expect(out).toContain(`skipped ${name}: it won't open: ${why}`);
      expect(out).not.toContain("FAKE");
      // The rest comes, and says whose key isn't coming.
      expect(out).toContain("  providers    4 brought: anthropic (its key isn't coming), deepseek (its key isn't coming), ollama, zai-coding (a coding plan; its key isn't coming)");
      expect(out).toContain("  agents       4 brought: builder (engineer · native · example/app · its key search-api not coming)");
      const { store, vault } = await opened(home);
      expect(vault.list()).toEqual([]);
      expect(store.lww("provider:deepseek")).not.toBeNull();
      store.close();
    }
  });

  test("a damaged row is skipped by name, with why; the rest comes", async () => {
    const old = oldHome(join(root, "galahad"));
    const ids = chatIds(old);
    const mind = openReadOnly(join(old, "mind.db"));
    const memory = mind.query<{ id: string }, []>("SELECT id FROM v_memories WHERE text = 'Works in Copenhagen time.'").get()!.id;
    mind.close();
    damage(join(old, "mind.db"), `
      UPDATE v_lww SET v = '{not json' WHERE k = 'provider:deepseek';
      UPDATE v_lww SET v = json_set(v, '$.ct', 'AAAA' || substr(json_extract(v, '$.ct'), 5)) WHERE k = 'secret:github';
      UPDATE v_lww SET v = '"none"' WHERE k = 'roster:chat';
      UPDATE v_memories SET tags = 'not tags' WHERE text = 'Works in Copenhagen time.';`);
    damage(join(old, "team.db"), "UPDATE team_teammates SET value = '{' WHERE id = 'goose';");
    damage(join(old, "chats.db"), `UPDATE messages SET status = 'lost' WHERE conversation = '${ids["Read my notes"]}' AND role = 'assistant';`);
    const home = await newHome(join(root, "invincible"));
    const { code, out } = await runImport(old, home, { chats: "all" });
    expect(code).toBe(2);
    for (const line of [
      "skipped github: it won't open: its sealed value doesn't open with its vault key",
      "skipped deepseek: its row isn't JSON",
      "skipped chat: its row doesn't read (models: ",
      `skipped ${memory}: its tags aren't JSON`,
      "skipped goose: its record isn't JSON",
      `skipped ${ids["Read my notes"]}: its message 2 doesn't read`,
      "  secrets      7 brought",
      "  providers    3 brought: anthropic, ollama, zai-coding (a coding plan)",
      "  roster       3 roles brought: engineer, planner, reviewer",
      "  agents       3 brought: builder",
    ]) expect(out).toContain(line);
    expect(out).not.toContain("FAKE");
  });

  test("its node running beside: the latest of its log is read through its index, and not a byte of its files changes", async () => {
    const { old, home } = await setup();
    // Galahad's own connection, in a process of its own as a running node's is (SQLite shares one index between a
    // process's connections, so a writer in this one would hand the import its own, writable): its last write still in
    // the log, not yet in mind.db, and the node waiting.
    const mind = join(old, "mind.db");
    const row = ["provider:latest", "9999999999999-0000", "latest", OLD_NODE.id, JSON.stringify({ id: "latest", kind: "openai", baseUrl: "https://api.latest.example/v1" })];
    const live = Bun.spawn(
      ["bun", "-e", `import { Database } from "bun:sqlite";
        const db = new Database(${JSON.stringify(mind)});
        db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
        db.query("INSERT INTO v_lww (k, hlc, eid, device, v) VALUES (?, ?, ?, ?, ?)").run(...${JSON.stringify(row)});
        console.log("ready");
        await Bun.stdin.text();
        db.close();`],
      { stdin: "pipe", stdout: "pipe" },
    );
    try {
      const said = await live.stdout.getReader().read();
      expect(new TextDecoder().decode(said.value).trim()).toBe("ready");
      expect(readFileSync(`${mind}-wal`).length).toBeGreaterThan(0);
      const before = snapshot(old);
      const { out } = await runImport(old, home, { dryRun: true });
      expect(out).toContain("  providers    5 to bring: anthropic, deepseek, latest, ollama, zai-coding (a coding plan)");
      expect(snapshot(old)).toEqual(before);
    } finally {
      live.stdin.end();
      await live.exited;
    }
  }, 30_000);
});

describe("its node's rollback journals are never locked", () => {
  // A reader's shared lock on a rollback journal fails a writer without a busy timeout at once, as Galahad's stores of
  // knights and chats are: so what they hold is read from a copy taken when it held still, in memory.
  test("its knights' and chats' databases are read from a copy, its mind beside its log", async () => {
    const old = oldHome(join(root, "galahad"));
    for (const name of ["team.db", "chats.db"]) {
      const db = openReadOnly(join(old, name));
      expect([name, db.filename]).toEqual([name, ":memory:"]);
      db.close();
    }
    const mind = openReadOnly(join(old, "mind.db"));
    expect(mind.filename).not.toBe(":memory:");
    mind.close();
  });

  test("a write under way is waited for; one whose journal stays is said, and nothing is read", async () => {
    const { old, home } = await setup();
    const journal = join(old, "team.db-journal");
    writeFileSync(journal, "a write under way");
    // The writer ends its write in a while, from a process of its own as a node's is (this one waits, unable to).
    const done = Bun.spawn(["bun", "-e", `await Bun.sleep(300); require("node:fs").rmSync(${JSON.stringify(journal)});`]);
    expect((await runImport(old, home, { dryRun: true })).code).toBe(0);
    await done.exited;
    writeFileSync(journal, "a write a stopped node left");
    await expect(runImport(old, home, { dryRun: true })).rejects.toThrow("team.db can't be read: a write's journal stays beside it");
  }, 30_000);
});

describe("what it refuses", () => {
  test("writing while this node runs (a dry run beside it is fine), and nothing is written", async () => {
    const { old, home } = await setup();
    const server = Bun.serve({ hostname: "127.0.0.1", port: home.readConfig().port, fetch: () => new Response("") });
    try {
      const before = snapshot(home.dir);
      await expect(runImport(old, home)).rejects.toThrow(/this node is running \(it answers on 127\.0\.0\.1:\d+\): stop it first/);
      expect((await runImport(old, home, { dryRun: true })).code).toBe(0);
      expect(snapshot(home.dir)).toEqual(before);
    } finally {
      server.stop(true);
    }
  });

  test("writing as another user than the one whose home it is (what it made would be a file the node can't open)", async () => {
    const { old, home } = await setup();
    const before = snapshot(home.dir);
    const other = (process.getuid?.() ?? 0) + 1;
    await expect(runImport(old, home, { uid: other })).rejects.toThrow(/this node's home belongs to another user \(uid \d+\): run the import as that user/);
    expect((await runImport(old, home, { dryRun: true, uid: other })).code).toBe(0);
    expect(snapshot(home.dir)).toEqual(before);
  });

  // (Root reads whatever a file's mode says: there is nothing to see as root.)
  test.skipIf(process.getuid?.() === 0)("a home this user can't read is said to be one, not taken for one that isn't there", async () => {
    const { old, home } = await setup();
    chmodSync(old, 0o000);
    try {
      await expect(runImport(old, home, { dryRun: true })).rejects.toThrow(/this user \(.+\) can't read Galahad's home at .*: let it read it \(setfacl -R -m u:.+:rX /);
    } finally {
      chmodSync(old, 0o700);
    }
  });

  test("homes that aren't apart, a home that isn't one, a node that isn't there, a wrong word", async () => {
    const { old, home } = await setup();
    const nested = join(home.dir, "old-home");
    mkdirSync(nested);
    oldHome(nested);
    await expect(runImport(nested, home)).rejects.toThrow(/must be apart/);
    await expect(runImport(home.dir, home)).rejects.toThrow(/must be apart/);
    const empty = join(root, "empty");
    mkdirSync(empty);
    await expect(runImport(empty, home)).rejects.toThrow(/no Galahad home at .*: its mind\.db isn't there/);
    await expect(runImport(join(root, "nowhere"), home)).rejects.toThrow(/no Galahad home at/);
    const none = await newHome(join(root, "x")).then((h) => (rmSync(h.dir, { recursive: true }), h));
    await expect(runImport(old, none)).rejects.toThrow(/no node at .* to bring it into/);
    await expect(importCommand("elsewhere", [old], { home, dryRun: true, chats: undefined }, () => {})).rejects.toThrow(/^usage: invincible import galahad/);
    await expect(runImport(old, home, { chats: "yesterday" })).rejects.toThrow(/--chats takes all, none, or chats' ids \(cv_…\) joined by commas: yesterday isn't one/);
  });

  test("the command line reads --dry-run and --chats as they are said", async () => {
    const { old, home } = await setup();
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), "import", "galahad", old, "--home", home.dir, "--dry-run", "--chats", "all"], {
      env: { ...process.env, INVINCIBLE_KEYSTORE: "file" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect([code, err]).toEqual([0, ""]);
    expect(out).toContain("  chats        3 to bring: ");
    expect(out).toContain("A dry run: nothing is written, here or there.");
  }, 60_000);
});
