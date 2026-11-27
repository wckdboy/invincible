import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG } from "@invincible/models";
import { ConnectorService } from "../src/connectors.ts";

/*
 * What GitHub says before your agent may answer its own call in a private repository of yours (connectors.ts
 * githubFacts; your word, 27 November 2026, as the review of 27 November drew it): whose your key is by its account's id,
 * the repository the call names, and who opened the thread it answers. Asked with the key at GitHub's own origin by fixed
 * reads (never a tool of the manifest's), before the call is filed, kept ten minutes per connector, key and path, each
 * said in the ledger; and only for a call that could be the primary's itself there.
 */

const ORIGIN = "https://api.github.com";
const KEYS = { one: "github_pat_FAKEFAKEFAKEFAKE0000_one", two: "github_pat_FAKEFAKEFAKEFAKE0000_two" };
const person = (id: number, login = "lin-example") => ({ login, id, type: "User" });
const repository = (name: string, ownerId: number, over: object = {}) => ({ full_name: name, private: true, fork: false, owner: { login: name.split("/")[0], id: ownerId, type: "User" }, ...over });
/** GitHub as the stand-in answers it: by path, and for /user by the key it was asked with. */
type Answers = { users?: Record<string, object> | ((key: string) => object | null); paths?: Record<string, object | (() => Response | Promise<Response>)> };

function world(answers: Answers) {
  let now = Date.UTC(2026, 10, 27, 9);
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "solo" });
  const vault = new Vault(store, identity);
  vault.set("github", KEYS.one, { provider: "github", origin: ORIGIN });
  store.emit(identity, "connector.set", { id: "github", manifest: CATALOG.github!.manifest });
  const asked: string[] = [];
  const ledgered: { target: string; detail?: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    asked.push(`${method} ${url.origin === ORIGIN ? "" : url.origin}${url.pathname}`);
    if (method !== "GET") return Response.json({ number: 4 }, { status: 201 });
    if (url.pathname === "/user") {
      const user = typeof answers.users === "function" ? answers.users(key) : answers.users?.[key];
      return user ? Response.json(user) : Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const answer = answers.paths?.[url.pathname];
    return typeof answer === "function" ? answer() : answer ? Response.json(answer) : Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const service = new ConnectorService({ store, vault, identity, local: new Database(":memory:"), ledger: (e) => ledgered.push(e), log: () => {}, fetch, now: () => now });
  const reads = () => asked.filter((a) => a.startsWith("GET "));
  return { service, store, identity, vault, asked, reads, ledgered, later: (ms: number) => void (now += ms) };
}

const primary = { kind: "agent" as const, by: "arm:primary" };
const issue = (owner: string, repo: string) => ({ connector: "github", tool: "issue.create", args: { owner, repo, title: "Units in the docs" } });
const comment = (owner: string, repo: string, number: number) => ({ connector: "github", tool: "issue.comment", args: { owner, repo, number, body: "Done in #5." } });
const MINE = { users: { [KEYS.one]: person(501) }, paths: { "/repos/lin-example/notes": repository("lin-example/notes", 501), "/repos/lin-example/notes/issues/4": { number: 4, user: { id: 501 } }, "/repos/lin-example/notes/issues/5": { number: 5, user: { id: 777 } } } };

describe("your agent's own words in a private repository of yours", () => {
  test("its issue, and its comment on its own thread, go at once: GitHub was asked whose the key is, the repository and the thread, before anything was filed, and each once", async () => {
    const w = world(MINE);
    const done = await w.service.call(issue("lin-example", "notes"), primary);
    expect(done.status === "done" && done.own).toBe("an issue in lin-example/notes, a private repository of yours");
    const again = await w.service.call(comment("lin-example", "notes", 4), primary);
    expect(again.status === "done" && again.own).toBe("a comment on its own thread #4 in lin-example/notes, a private repository of yours");
    expect(w.asked).toEqual(["GET /user", "GET /repos/lin-example/notes", "POST /repos/lin-example/notes/issues", "GET /repos/lin-example/notes/issues/4", "POST /repos/lin-example/notes/issues/4/comments"]);
    expect(w.service.actions().map((a) => [a.state, a.self, a.note])).toEqual([
      ["done", true, "Your agent approved it itself: a comment on its own thread #4 in lin-example/notes, a private repository of yours"],
      ["done", true, "Your agent approved it itself: an issue in lin-example/notes, a private repository of yours"],
    ]);
    // Each read is in the ledger, with what GitHub said.
    expect(w.ledgered.filter((e) => e.target.startsWith("GET ")).map((e) => e.target)).toEqual(["GET /user", "GET /repos/lin-example/notes", "GET /repos/lin-example/notes/issues/4"]);
  });

  test("anyone else's thread, a public repository, a fork, a name whose owner isn't your key's account (a login renamed and taken), an organization's: each waits for you, and nothing is sent", async () => {
    const w = world({
      users: { [KEYS.one]: person(501, "lin-renamed") },
      paths: {
        ...MINE.paths,
        "/repos/lin-example/popular": repository("lin-example/popular", 501, { private: false }),
        "/repos/lin-example/forked": repository("lin-example/forked", 501, { fork: true }),
        "/repos/lin-taken/notes": repository("lin-taken/notes", 999),
        "/repos/amiriteorg/docs": repository("amiriteorg/docs", 600, { owner: { login: "amiriteorg", id: 600, type: "Organization" } }),
      },
    });
    const calls = [comment("lin-example", "notes", 5), issue("lin-example", "popular"), comment("lin-example", "popular", 4), issue("lin-example", "forked"), issue("lin-taken", "notes"), issue("amiriteorg", "docs"), issue("lin-example", "missing")];
    for (const call of calls) expect([call.args.repo, (await w.service.call(call, primary)).status]).toEqual([call.args.repo, "asked"]);
    expect(w.asked.filter((a) => !a.startsWith("GET "))).toEqual([]);
    // (A thread's author is asked only where it could matter: in a private repository of yours.)
    expect(w.reads().filter((a) => a.includes("/issues/"))).toEqual(["GET /repos/lin-example/notes/issues/5"]);
  });

  test("only the primary itself: its agents' work, their calls from their VMs and its loops ask there, and GitHub isn't asked for them", async () => {
    const w = world(MINE);
    for (const by of ["team.0123456789.ada", "arm:team.0123456789.ada", "loop:triage"]) {
      expect([by, (await w.service.call(issue("lin-example", "notes"), { kind: "agent", by })).status]).toEqual([by, "asked"]);
      expect([by, (await w.service.call(comment("lin-example", "notes", 4), { kind: "agent", by })).status]).toEqual([by, "asked"]);
    }
    expect(w.asked).toEqual([]);
  });

  test("a pull request, a shipment or a fix there waits for you (each runs the repository's CI with its secrets), and GitHub isn't asked for them", async () => {
    const w = world(MINE);
    const pr = { connector: "github", tool: "pr.create", args: { owner: "lin-example", repo: "notes", head: "invincible/units", base: "main", title: "Units" } };
    const ship = { connector: "github", tool: "ship", args: { owner: "lin-example", repo: "notes", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Units" } };
    for (const call of [pr, ship]) expect([call.tool, (await w.service.call(call, primary)).status]).toEqual([call.tool, "asked"]);
    expect(w.asked).toEqual([]);
  });

  test("whose your key is comes from GitHub's own /user, never from a tool of the connector's, and only at GitHub's own origin", async () => {
    const w = world({ users: { [KEYS.one]: person(501) }, paths: { "/users/torvalds": person(1024, "torvalds"), "/repos/torvalds/linux": repository("torvalds/linux", 1024) } });
    // A manifest whose `me` reads someone else's account changes nothing: the fixed read says the key is 501's.
    const tools = { ...CATALOG.github!.manifest.tools, me: { ...CATALOG.github!.manifest.tools.me!, path: "/users/torvalds" } };
    w.store.emit(w.identity, "connector.set", { id: "github", manifest: { ...CATALOG.github!.manifest, tools } });
    expect((await w.service.call(issue("torvalds", "linux"), primary)).status).toBe("asked");
    expect(w.reads()).toEqual(["GET /user", "GET /repos/torvalds/linux"]);
    // A GitHub-shaped connector at another origin is never asked, nor is anything there its.
    w.vault.set("forge", KEYS.two, { provider: "forge", origin: "https://forge.example.test" });
    const github = CATALOG.github!.manifest.tools;
    w.store.emit(w.identity, "connector.set", { id: "forge", manifest: { id: "forge", label: "Forge", origin: "https://forge.example.test", auth: { secret: "forge", scheme: "bearer" }, tools: { me: github.me!, "issue.create": github["issue.create"]! } } });
    const before = w.asked.length;
    expect((await w.service.call({ ...issue("lin-example", "notes"), connector: "forge" }, primary)).status).toBe("asked");
    // Nothing was asked anywhere with its key: not there, and never at GitHub's own address.
    expect(w.asked.slice(before)).toEqual([]);
  });

  test("only a person's account is yours: an organization's or a bot's answer to whose the key is never makes a repository yours", async () => {
    for (const type of ["Organization", "Bot"]) {
      const w = world({ users: { [KEYS.one]: { login: "lin-example", id: 501, type } }, paths: MINE.paths });
      expect([type, (await w.service.call(issue("lin-example", "notes"), primary)).status]).toEqual([type, "asked"]);
      expect([type, w.reads()]).toEqual([type, ["GET /user"]]);
    }
  });

  test("two GitHub connectors with keys of two accounts: what one key is never answers for the other", async () => {
    const w = world({ users: { [KEYS.one]: person(501), [KEYS.two]: person(777, "sam-example") }, paths: MINE.paths });
    w.vault.set("github-amiriteorg", KEYS.two, { provider: "github-amiriteorg", origin: ORIGIN });
    w.store.emit(w.identity, "connector.set", { id: "github-amiriteorg", manifest: { ...CATALOG.github!.manifest, id: "github-amiriteorg", auth: { secret: "github-amiriteorg", scheme: "bearer" } } });
    expect((await w.service.call(issue("lin-example", "notes"), primary)).status).toBe("done");
    expect((await w.service.call({ ...issue("lin-example", "notes"), connector: "github-amiriteorg" }, primary)).status).toBe("asked");
    expect(w.reads()).toEqual(["GET /user", "GET /repos/lin-example/notes", "GET /user", "GET /repos/lin-example/notes"]);
  });

  test("what GitHub said is kept ten minutes, said or not, then asked again; and a new key is asked at once", async () => {
    let user: object | null = null;
    const w = world({ users: () => user, paths: MINE.paths });
    const call = async () => (await w.service.call(issue("lin-example", "notes"), primary)).status;
    const whose = () => w.reads().filter((a) => a === "GET /user").length;
    // Not said: it waits for you, and isn't asked again at every call.
    expect([await call(), await call(), whose()]).toEqual(["asked", "asked", 1]);
    // Said since, but what was said is kept ten minutes: then asked again, and its.
    user = person(501);
    w.later(10 * 60_000 - 1);
    expect([await call(), whose()]).toEqual(["asked", 1]);
    w.later(1);
    expect([await call(), whose()]).toEqual(["done", 2]);
    expect([await call(), whose()]).toEqual(["done", 2]);
    // A new key is asked at once, whatever was kept of the old one.
    w.vault.set("github", KEYS.two, { provider: "github", origin: ORIGIN });
    user = null;
    expect([await call(), whose()]).toEqual(["asked", 3]);
  });

  test("nothing waits in your Inbox while GitHub is asked: the call is filed after it has answered, and answered at once", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = world({ ...MINE, paths: { ...MINE.paths, "/repos/lin-example/notes": async () => { await gate; return Response.json(repository("lin-example/notes", 501)); } } });
    const pending = w.service.call(issue("lin-example", "notes"), primary);
    await Bun.sleep(20);
    // Nothing is filed while it is asked, so there is nothing of it for you to answer half made.
    expect(w.service.actions()).toEqual([]);
    release();
    const done = await pending;
    expect(done.status === "done" && done.own).toBe("an issue in lin-example/notes, a private repository of yours");
    expect(w.service.actions().map((a) => a.state)).toEqual(["done"]);
  });
});
