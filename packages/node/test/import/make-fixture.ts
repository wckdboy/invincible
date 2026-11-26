/*
 * Makes the fixture Galahad home the importer's tests read (fixture/), with Galahad's own code: run by hand, read only,
 * against a checkout of Galahad, never by the tests or CI.
 *
 *   bun packages/node/test/import/make-fixture.ts <galahad-checkout>
 *
 * It imports the checkout's modules (its mind's store and vault, its home, its team and chat stores, its connector
 * catalog) and has them make a home in a temporary folder, as `galahad init` and a node's use would leave one, then
 * copies what the importer reads into fixture/: config.json and keys.json as they are, each database gzipped, the
 * uploads as they are. Nothing is written in the checkout.
 *
 * Everything in it is made up. The node's keys are derived from the phrases below, so they are nobody's; every API key
 * and token is spelled FAKE; the addresses are example.com's or the real services' public API origins.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { COMING, PHRASES, STAYING } from "./fixture-data.ts";

const checkout = Bun.argv[2];
if (!checkout) {
  console.error("usage: bun packages/node/test/import/make-fixture.ts <galahad-checkout>");
  process.exit(1);
}
const from = (path: string): Promise<any> => import(join(resolve(checkout), path));
const core = await from("packages/core/src/index.ts");
const mind = await from("packages/mind/src/index.ts");
const { Home } = await from("packages/node/src/home.ts");
const { TeamStore } = await from("packages/node/src/team-store.ts");
const { ChatStore } = await from("packages/node/src/chats.ts");
const { CATALOG } = await from("packages/brain/src/connector-catalog.ts");

/** Each of the fixture's keys is the SHA-256 of one of its phrases, so none is anyone's secret. */
const fromPhrase = (phrase: string): Uint8Array => core.sha256Bytes(core.utf8(phrase));

const scratch = mkdtempSync(join(tmpdir(), "fixture-home-"));
const dir = join(scratch, "home");
try {
  const home = new Home(dir);
  home.ensureDir();
  const identity = core.nodeIdentity(fromPhrase(PHRASES.sign), fromPhrase(PHRASES.box));
  writeFileSync(home.keyFilePath, core.exportIdentity(identity), { mode: 0o600 });

  // ---- the mind: what `galahad init` founds, and what a node's use leaves in it ----
  const store = new mind.MindStore(home.mindPath);
  const fleet = mind.foundFleet(store, identity, { fleetName: "fixture-fleet", nodeName: "fixture-node" });
  home.writeConfig({ v: 1, name: "fixture-node", fleet, port: 7777, keystore: "file", advertise: null });
  const phone = core.clientIdFromKey(core.p256PublicKey(fromPhrase(PHRASES.phone)));
  mind.enrollDevice(store, identity, { device: phone, name: "fixture-phone", kind: "client" });

  const vault = new mind.Vault(store, identity);
  vault.set("anthropic", COMING.anthropic, { provider: "anthropic", origin: "https://api.anthropic.com" });
  vault.set("deepseek", COMING.deepseek, { provider: "deepseek", origin: "https://api.deepseek.com" });
  vault.set("zai-coding", COMING["zai-coding"], { provider: "zai-coding", origin: "https://api.z.ai" });
  vault.set("github", COMING.github, { provider: "github", origin: "https://api.github.com", label: "GitHub" });
  vault.set("gmail", COMING.gmail, { provider: "gmail", origin: "https://gmail.googleapis.com", label: "Gmail sign-in" });
  vault.set("weather", COMING.weather, { provider: "weather", origin: "https://api.weather.example" });
  vault.set("search-api", COMING["search-api"], { origin: "https://api.search.example", label: "A search API" });
  vault.set("pin", COMING.pin, { label: "A short one: no hint" });
  // What stays behind: the chat app's bot and its device key, the push key of the old app, a loop's webhook key.
  vault.set("telegram:bot", STAYING["telegram:bot"], { label: "Telegram bot @fixture_bot" });
  vault.set("telegram:device", core.b64u(fromPhrase(PHRASES.telegram)), { label: "The Telegram gateway's device key" });
  vault.set("apple-push", STAYING["apple-push"], { label: "Apple push key", origin: "https://api.push.apple.com" });
  vault.set("loop-hook:nightly", STAYING["loop-hook:nightly"], { label: "The webhook of loop nightly" });

  store.emit(identity, "provider.set", { id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", secret: "anthropic" });
  store.emit(identity, "provider.set", { id: "deepseek", kind: "openai", baseUrl: "https://api.deepseek.com", secret: "deepseek" });
  store.emit(identity, "provider.set", { id: "zai-coding", kind: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4", secret: "zai-coding" });
  store.emit(identity, "provider.set", { id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama on this node" });
  store.emit(identity, "provider.set", { id: "gone", kind: "openai", baseUrl: "https://api.gone.example/v1" });
  store.emit(identity, "provider.removed", { id: "gone" });

  store.emit(identity, "roster.set", { role: "chat", models: ["deepseek/deepseek-v4-flash"] });
  store.emit(identity, "roster.set", { role: "planner", models: ["deepseek/deepseek-v4-pro"] });
  store.emit(identity, "roster.set", { role: "engineer", models: ["zai-coding/glm-5.3", "deepseek/deepseek-v4-pro"] });
  store.emit(identity, "roster.set", { role: "reviewer", models: ["anthropic/claude-opus-5-5"] });
  store.emit(identity, "roster.effort", { role: "engineer", effort: "high" });
  store.emit(identity, "roster.effort", { role: "planner", effort: "auto" });
  store.emit(identity, "price.set", { model: "deepseek/deepseek-v4-pro", price: { input: 0.5, output: 2 } });
  store.emit(identity, "price.set", { model: "anthropic/claude-opus-5-5", price: { input: 5, output: 25, cached: 0.5 } });

  // Memory: notes, the facts about you (kept and proposed), an agent's note, a page's, a twice-kept one, a forgotten one.
  store.remember(identity, "The fixture's notes are made up: nothing in them is real.", { tags: ["notes"], prov: { trust: "owner", via: phone } });
  store.remember(identity, "Prefers short answers, the command first.", { tags: ["about-you"], prov: { trust: "owner", via: phone } });
  store.remember(identity, "Works in Copenhagen time.", { tags: ["about-you"], prov: { trust: "owner" } });
  store.remember(identity, "Never ships on a Friday.", { tags: ["about-you"], prov: { trust: "agent", source: "galahad" } });
  store.remember(identity, "The app's tests run with bun test.", { tags: ["project:app"], prov: { trust: "agent", source: core.teamArmLabel(identity.id, "builder") } });
  store.remember(identity, "A page said the weather API moved to v2.", { prov: { trust: "untrusted", source: "https://docs.weather.example/api" } });
  store.remember(identity, "Galahad keeps the knights' work in their VMs.", { tags: ["notes"], prov: { trust: "owner" } });
  store.remember(identity, "Galahad keeps the knights' work in their VMs.", { tags: ["notes"], prov: { trust: "owner" } });
  const forgotten = store.remember(identity, "An old note, since forgotten.", { tags: ["notes"], prov: { trust: "owner" } });
  store.emit(identity, "memory.forgotten", { memory: forgotten.id });
  store.remember(identity, `Forgot ${forgotten.id} on purpose.`, { tags: ["notes"], prov: { trust: "owner" } });

  store.emit(identity, "project.set", { id: "app", name: "The app", instructions: "Run bun test before you say done.", repo: "https://github.com/example/app" });
  store.emit(identity, "project.set", { id: "site", name: "The site", instructions: "" });

  // Connectors: two of the catalog's (one kept to Galahad and a knight), and one of the owner's own.
  const github = core.ConnectorManifest.parse(CATALOG.github.manifest);
  store.emit(identity, "connector.set", { id: "github", manifest: github });
  const gmail = core.ConnectorManifest.parse({ ...CATALOG.gmail.manifest, access: { only: "galahad", allowed: [core.teamArmLabel(identity.id, "builder")] } });
  store.emit(identity, "connector.set", { id: "gmail", manifest: gmail });
  const weather = core.ConnectorManifest.parse({
    id: "weather",
    label: "Weather",
    description: "The weather, for Galahad to tell you.",
    origin: "https://api.weather.example",
    auth: { secret: "weather", scheme: "header", header: "x-api-key" },
    tools: { now: { description: "The weather now in a city.", method: "GET", path: "/now", params: { city: { type: "string", required: true } }, class: "read" } },
    access: { only: "galahad", allowed: ["galahad", "claude-laptop", core.teamArmLabel(identity.id, "scout")] },
  });
  store.emit(identity, "connector.set", { id: "weather", manifest: weather });

  // What stays behind: a loop and a rule of the owner's.
  store.emit(identity, "loop.set", { name: "nightly", schedule: "0 3 * * *", on: identity.id, enabled: true, task: { kind: "ask", text: "Tidy the notes." } });
  store.emit(identity, "rule.set", { name: "no-force", rule: { does: "refuse", words: ["push", "--force"] } }, { trust: "owner" });
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();

  // ---- the knights (team.db) ----
  const team = new TeamStore(join(dir, "team.db"));
  team.saveTeammate({
    id: "builder",
    name: "Builder",
    instructions: "Builds and tests the app, and ships it as a pull request.",
    role: "engineer",
    harness: "native",
    repository: "https://github.com/example/app",
    keys: [{ secret: "search-api", header: "authorization", write: false }],
    avatar: { v: 1, form: core.AVATAR_FORMS[1], color: "#aa3300", accent: "#ffcc00", eyes: core.AVATAR_EYES[2], accessory: core.AVATAR_ACCESSORIES[1], temperament: core.AVATAR_TEMPERAMENTS[2] },
  });
  team.remember("builder", "The app's CI runs on the forge; bun test is its gate.");
  team.planWorkspace("builder", "fixture-node");
  team.setWorkspace("builder", { node: "fixture-node", id: "0123456789" });
  team.recruit({ id: "scout", name: "Scout", instructions: "Finds what a task needs before it starts.", role: "researcher" }, "galahad");
  team.saveTeammate({ id: "quiet", name: "Quiet", instructions: "Works on private material, on its own models alone.", role: "engineer", models: ["nearai/fake-private-model"], sensitive: true, harness: "opencode", avatar: { v: 2, color: "#336699" }, dailyTurns: 12, enabled: false });
  team.saveTeammate({ id: "goose", name: "Goose", instructions: "Runs goose, the owner's ACP agent.", role: "engineer", harness: "acp", acp: "goose acp" });
  team.saveTeammate({ id: "retired", name: "Retired", instructions: "Was here once." });
  team.remove("retired");
  team.arrange({ order: ["scout", "builder", "goose", "quiet"], primary: "builder" });
  team.close();

  // ---- chats (chats.db) and an upload ----
  const uploads = join(dir, "uploads");
  mkdirSync(uploads, { recursive: true, mode: 0o700 });
  const notes = new TextEncoder().encode("Fixture notes: nothing here is real.\n");
  const noteId = createHash("sha256").update(notes).digest("hex");
  writeFileSync(join(uploads, noteId), notes, { mode: 0o600 });
  const attachment = { id: noteId, name: "notes.txt", type: "text/plain", bytes: notes.length };

  const chats = new ChatStore(join(dir, "chats.db"));
  const answer = (id: string, content: string, opts: { bank?: boolean; model?: string } = {}) => {
    const message = chats.startAnswer(id);
    const model = opts.model ?? "deepseek/deepseek-v4-pro";
    chats.finishAnswer(id, message, { content, model, steps: [{ kind: "model", ref: model }, { kind: "tool", id: "t1", name: "recall", title: "Recall", input: "{}", ok: true, summary: "2 notes" }], status: "done", error: null, bank: opts.bank ?? false });
    return message;
  };
  const launch = chats.create({ title: "Plan the launch", project: "app", role: "chat" });
  chats.addUser(launch.id, "What's left before the launch?");
  const first = answer(launch.id, "Two things: the tests and the notes.");
  chats.addUser(launch.id, "Then the tests first.");
  answer(launch.id, "The tests first, then.");
  chats.keepStory(launch.id, "They planned the launch: the tests, then the notes.", first);
  chats.update(launch.id, { pinned: true });
  chats.see(launch.id);

  const read = chats.create({ title: "Read my notes", project: null, role: "chat" });
  chats.addUser(read.id, "Read this.", [attachment]);
  answer(read.id, "It says nothing here is real.");

  const bank = chats.create({ title: "What did I spend", project: null, role: "chat" });
  chats.addUser(bank.id, "What did I spend this month?");
  answer(bank.id, "Less than last month.", { bank: true });

  const look = chats.create({ title: "Watch the build", project: "app", role: "chat" });
  chats.addUser(look.id, "Look at the build again later.", undefined, { set: Date.now(), note: "the build" });
  chats.startAnswer(look.id);
  chats.close();

  // ---- into fixture/ ----
  const out = join(dirname(fileURLToPath(import.meta.url)), "fixture");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(dir, path));
    }
  };
  walk(dir);
  for (const file of files) {
    // What SQLite keeps beside a database while it is open, or after (a Mac keeps both), is not the home's content.
    if (/-(wal|shm|journal)$/.test(file)) continue;
    const bytes = readFileSync(join(dir, file));
    const target = join(out, file.endsWith(".db") ? `${file}.gz` : file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.endsWith(".db") ? Bun.gzipSync(bytes, { level: 9 }) : bytes);
    console.log(`${relative(process.cwd(), target)}  ${bytes.length} bytes`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
