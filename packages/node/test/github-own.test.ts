import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG } from "@invincible/models";
import { ConnectorService } from "../src/connectors.ts";

/*
 * What GitHub says before your agent may answer its own call (connectors.ts githubFacts; your word, 27 November 2026, as
 * the reviews of 27 November drew it): whose your key is by its account's id, the repository the call names, who opened
 * the thread it answers, and where the branch a push or a pull request is judged on stands. Asked with the key at
 * GitHub's own origin by fixed reads (never a tool of the manifest's), before the call is filed, each said in the ledger;
 * whose the key is kept ten minutes per connector and key, everything else asked afresh before each act; and only what a
 * call that could be its own needs.
 */

const ORIGIN = "https://api.github.com";
const KEYS = { one: "github_pat_FAKEFAKEFAKEFAKE0000_one", two: "github_pat_FAKEFAKEFAKEFAKE0000_two" };
const person = (id: number, login = "lin-example") => ({ login, id, type: "User" });
const repository = (name: string, ownerId: number, over: object = {}) => ({ full_name: name, private: true, fork: false, default_branch: "main", owner: { login: name.split("/")[0], id: ownerId, type: "User" }, ...over });
/** GitHub as the stand-in answers it: by path, and for /user by the key it was asked with. */
type Answers = {
  users?: Record<string, object> | ((key: string) => object | null);
  paths?: Record<string, object | (() => Response | Promise<Response>)>;
  /** The repositories you gave an agent, and what a kept shipment changes and is built on. */
  given?: string[];
  shipment?: (artifact: string) => { files: string[]; base: string } | null;
};

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
  const service = new ConnectorService({ store, vault, identity, local: new Database(":memory:"), ledger: (e) => ledgered.push(e), log: () => {}, fetch, now: () => now, ...(answers.given ? { repositories: () => answers.given! } : {}), ...(answers.shipment ? { shipment: answers.shipment } : {}) });
  const reads = () => asked.filter((a) => a.startsWith("GET "));
  return { service, store, identity, vault, asked, reads, ledgered, later: (ms: number) => void (now += ms) };
}

const primary = { kind: "agent" as const, by: "arm:primary" };
const issue = (owner: string, repo: string) => ({ connector: "github", tool: "issue.create", args: { owner, repo, title: "Units in the docs" } });
const comment = (owner: string, repo: string, number: number) => ({ connector: "github", tool: "issue.comment", args: { owner, repo, number, body: "Done in #5." } });
const MINE = { users: { [KEYS.one]: person(501) }, paths: { "/repos/lin-example/notes": repository("lin-example/notes", 501), "/repos/lin-example/notes/issues/4": { number: 4, user: { id: 501 } }, "/repos/lin-example/notes/issues/5": { number: 5, user: { id: 777 } } } };

describe("your agent's own words in a private repository of yours", () => {
  test("its issue, and its comment on its own thread, go at once: GitHub was asked whose the key is, the repository and the thread, before anything was filed; the repository afresh for each", async () => {
    const w = world(MINE);
    const done = await w.service.call(issue("lin-example", "notes"), primary);
    expect(done.status === "done" && done.own).toBe("an issue in lin-example/notes, a private repository of yours");
    const again = await w.service.call(comment("lin-example", "notes", 4), primary);
    expect(again.status === "done" && again.own).toBe("a comment on its own thread #4 in lin-example/notes, a private repository of yours");
    expect(w.asked).toEqual(["GET /user", "GET /repos/lin-example/notes", "POST /repos/lin-example/notes/issues", "GET /repos/lin-example/notes", "GET /repos/lin-example/notes/issues/4", "POST /repos/lin-example/notes/issues/4/comments"]);
    expect(w.service.actions().map((a) => [a.state, a.self, a.note])).toEqual([
      ["done", true, "Your agent approved it itself: a comment on its own thread #4 in lin-example/notes, a private repository of yours"],
      ["done", true, "Your agent approved it itself: an issue in lin-example/notes, a private repository of yours"],
    ]);
    // Each read is in the ledger, with what GitHub said.
    expect(w.ledgered.filter((e) => e.target.startsWith("GET ")).map((e) => e.target)).toEqual(["GET /user", "GET /repos/lin-example/notes", "GET /repos/lin-example/notes", "GET /repos/lin-example/notes/issues/4"]);
  });

  // The re-review of 27 November (R4b, R8): a repository made public, or a name renamed and taken, is seen at once.
  test("a repository made public, or its name taken by another account, is said before the next act: that act waits for you", async () => {
    let notes: object = repository("lin-example/notes", 501);
    const w = world({ ...MINE, paths: { ...MINE.paths, "/repos/lin-example/notes": () => Response.json(notes) } });
    expect((await w.service.call(comment("lin-example", "notes", 4), primary)).status).toBe("done");
    // You make it public: a minute on, it waits.
    notes = repository("lin-example/notes", 501, { private: false });
    w.later(60_000);
    expect((await w.service.call(comment("lin-example", "notes", 4), primary)).status).toBe("asked");
    // You rename your account and someone takes the name, with a repository and a thread #4 of theirs: it waits.
    notes = repository("lin-example/notes", 999);
    expect((await w.service.call(comment("lin-example", "notes", 4), primary)).status).toBe("asked");
    expect((await w.service.call(issue("lin-example", "notes"), primary)).status).toBe("asked");
    expect(w.asked.filter((a) => !a.startsWith("GET "))).toEqual(["POST /repos/lin-example/notes/issues/4/comments"]);
    // Whose the key is was asked once; the repository before each act.
    expect(w.reads().filter((a) => a === "GET /user")).toHaveLength(1);
    expect(w.reads().filter((a) => a === "GET /repos/lin-example/notes")).toHaveLength(4);
  });

  // The re-review of 27 November (R4): a merge bot or ChatOps acts on such a line as your word, on its own thread too.
  test("a line a bot reads as a command waits for you, even on its own thread in a private repository of yours, and GitHub isn't asked for it", async () => {
    const w = world(MINE);
    // (The merge bot that takes a command by its bare name is one of the old theme's words, so written backwards.)
    for (const body of [`${[..."srob"].reverse().join("")} r+`, "@mergifyio queue", "/deploy production", "/release v2.0.0", "Merged.\n@dependabot rebase"]) {
      expect([body, (await w.service.call({ ...comment("lin-example", "notes", 4), args: { owner: "lin-example", repo: "notes", number: 4, body } }, primary)).status]).toEqual([body, "asked"]);
    }
    expect((await w.service.call({ ...issue("lin-example", "notes"), args: { owner: "lin-example", repo: "notes", title: "/deploy staging" } }, primary)).status).toBe("asked");
    expect(w.asked).toEqual([]);
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

  test("whose your key is, as GitHub said it, is kept ten minutes, said or not, then asked again; and a new key is asked at once", async () => {
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

  test("nothing waits in Needs you while GitHub is asked: the call is filed after it has answered, and answered at once", async () => {
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

// The re-review of 27 November (R1, R2, R7): a push is its own only where GitHub says what it lands on, a branch never,
// and in a repository you gave an agent its words only on its own threads.
describe("its pushes and its words in a repository you gave an agent", () => {
  const GIVEN = ["https://github.com/lin-example/site"];
  const site = (over: object = {}) => repository("lin-example/site", 600, { private: false, owner: { login: "lin-example", id: 600, type: "Organization" }, ...over });
  const head = (branch: string, sha: string) => ({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
  const MAIN = "a".repeat(40);
  /** A stranger's pull request's head (GitHub keeps it as refs/pull/7/head), and the commit your agent pushed. */
  const THEIRS = "7".repeat(40);
  const PUSHED = "c".repeat(40);
  const vm = { kind: "agent" as const, by: "arm:team.0123456789.ada" };
  /** A shipment of yours this node sent before (or a fix onto it): in the log, done, its receipt naming the commit it pushed. */
  let sent = 0;
  function shipped(w: ReturnType<typeof world>, branch: string, sha = PUSHED, { repo = "site", fix = false } = {}) {
    const id = `a_${"S".repeat(20)}${String(++sent).padStart(2, "0")}`;
    const tool = fix ? "ship.update" : "ship";
    w.store.emit(w.identity, "action.requested", { id, connector: "github", tool, args: { owner: "lin-example", repo, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch, title: "Units" }, class: "outward", target: `POST /repos/lin-example/${repo}/pulls (${tool})`, by: "team.0123456789.ada", expires: Date.UTC(2026, 10, 28) });
    w.store.emit(w.identity, "action.decided", { id, verdict: "approved" }, { trust: "owner" });
    const receipt = fix ? `200 1 file pushed onto ${branch}, commit ${sha.slice(0, 12)}: pull request #9 updated, https://github.com/lin-example/${repo}/pull/9` : `201 pull request #9: https://github.com/lin-example/${repo}/pull/9 (1 file on ${branch} into main, commit ${sha.slice(0, 12)})`;
    w.store.emit(w.identity, "action.done", { id, ok: true, status: fix ? 200 : 201, receipt });
  }

  test("a branch waits for you, whoever asks and wherever: it runs its commit's own workflows with the repository's secrets; and so does one a connector installed while branches were free makes", async () => {
    const w = world({ users: { [KEYS.one]: person(501) }, given: GIVEN });
    const branch = (owner: string, repo: string, ref: string) => ({ connector: "github", tool: "branch.create", args: { owner, repo, ref, sha: THEIRS } });
    expect((await w.service.call(branch("lin-example", "site", "refs/heads/invincible/pr-7"), vm)).status).toBe("asked");
    expect((await w.service.call(branch("amiriteorg", "infra", "refs/heads/release/v9"), { kind: "agent", by: "loop:triage" })).status).toBe("asked");
    expect((await w.service.call(branch("amiriteorg", "infra", "refs/heads/deploy/prod"), { kind: "agent", by: "arm:coder" })).status).toBe("asked");
    expect((await w.service.call(branch("lin-example", "site", "refs/heads/invincible/x"), primary)).status).toBe("asked");
    // A GitHub connector added while branch.create was free keeps that definition; it is held to asking all the same.
    const old = { ...CATALOG.github!.manifest.tools["branch.create"]!, description: "Create a branch at a commit (ref is refs/heads/<name>).", class: "create" as const };
    w.store.emit(w.identity, "connector.set", { id: "github", manifest: { ...CATALOG.github!.manifest, tools: { ...CATALOG.github!.manifest.tools, "branch.create": old } } });
    const before = w.service.actions().length;
    expect((await w.service.call(branch("lin-example", "site", "refs/heads/invincible/pr-7"), vm)).status).toBe("asked");
    expect(w.service.actions()).toHaveLength(before + 1);
    // Nothing was sent, nothing asked of GitHub, every one is in Needs you; your own call is yours and goes.
    expect(w.asked).toEqual([]);
    expect(w.service.actions().map((a) => [a.tool, a.state, a.class])).toEqual(Array(5).fill(["branch.create", "waiting", "outward"]));
    expect((await w.service.call(branch("lin-example", "site", "refs/heads/invincible/mine"), { kind: "owner", device: "d_laptop" })).status).toBe("done");
    expect(w.asked).toEqual(["POST /repos/lin-example/site/git/refs"]);
  });

  test("a shipment built on a contributor's pull request's head, or on an older commit, waits for you: GitHub says where your default branch stands as it goes", async () => {
    for (const base of [THEIRS, "b".repeat(40)]) {
      const w = world({ given: GIVEN, shipment: () => ({ files: ["src/units.ts"], base }), paths: { "/repos/lin-example/site": site(), "/repos/lin-example/site/git/ref/heads/main": head("main", MAIN) } });
      const out = await w.service.call({ connector: "github", tool: "ship", args: { owner: "lin-example", repo: "site", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Parse SI units" } }, vm);
      expect([base, out.status]).toEqual([base, "asked"]);
      // Asked of GitHub just before: the repository's default branch, and where it stands; nothing written.
      expect(w.asked).toEqual(["GET /repos/lin-example/site", "GET /repos/lin-example/site/git/ref/heads/main"]);
    }
    // Into a branch that isn't your default one: GitHub isn't even asked.
    const w = world({ given: GIVEN, shipment: () => ({ files: ["src/units.ts"], base: MAIN }), paths: { "/repos/lin-example/site": site(), "/repos/lin-example/site/git/ref/heads/release/v9": head("release/v9", MAIN) } });
    expect((await w.service.call({ connector: "github", tool: "ship", args: { owner: "lin-example", repo: "site", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", base: "release/v9", title: "Parse SI units" } }, vm)).status).toBe("asked");
    expect(w.asked.filter((a) => !a.startsWith("GET "))).toEqual([]);
  });

  test("a pull request goes from a branch it shipped, still where it last pushed it, into your default branch; from any other branch, one moved since, or into another, it waits for you", async () => {
    let units = head("invincible/units", PUSHED);
    const w = world({ given: GIVEN, paths: { "/repos/lin-example/site": site(), "/repos/lin-example/site/git/ref/heads/invincible/units": () => Response.json(units), "/repos/lin-example/site/git/ref/heads/invincible/pr-7": head("invincible/pr-7", THEIRS) } });
    shipped(w, "invincible/units");
    const pull = (head: string, base = "main") => ({ connector: "github", tool: "pr.create", args: { owner: "lin-example", repo: "site", head, base, title: "Run the full CI" } });
    const done = await w.service.call(pull("invincible/units"), vm);
    expect(done.status === "done" && done.own).toBe("a pull request from invincible/units, a branch it shipped, into main, in lin-example/site, a repository you gave an agent");
    expect(w.asked).toEqual(["GET /repos/lin-example/site", "GET /repos/lin-example/site/git/ref/heads/invincible/units", "POST /repos/lin-example/site/pulls"]);
    // A branch it never shipped (one a branch.create you approved gave a stranger's commit): GitHub isn't even asked.
    const before = w.asked.length;
    expect((await w.service.call(pull("invincible/pr-7"), vm)).status).toBe("asked");
    expect(w.asked.slice(before)).toEqual([]);
    // Into another branch than your default one.
    expect((await w.service.call(pull("invincible/units", "release/v9"), vm)).status).toBe("asked");
    // Moved since it last pushed there, by anyone.
    units = head("invincible/units", THEIRS);
    expect((await w.service.call(pull("invincible/units"), vm)).status).toBe("asked");
    expect(w.asked.filter((a) => !a.startsWith("GET "))).toEqual(["POST /repos/lin-example/site/pulls"]);
  });

  test("where it last pushed is its latest push there: a fix's commit after its shipment's; a branch of the same name in another repository is another branch", async () => {
    const FIXED = "d".repeat(40);
    let units = head("invincible/units", FIXED);
    // (lin-example/docs has an invincible/units of its own, where your agent's latest push in lin-example/site stands.)
    const w = world({ given: [...GIVEN, "https://github.com/lin-example/docs"], paths: { "/repos/lin-example/site": site(), "/repos/lin-example/site/git/ref/heads/invincible/units": () => Response.json(units), "/repos/lin-example/docs": site({ full_name: "lin-example/docs" }), "/repos/lin-example/docs/git/ref/heads/invincible/units": head("invincible/units", FIXED) } });
    shipped(w, "invincible/units");
    shipped(w, "invincible/units", FIXED, { fix: true });
    const pull = (repo: string) => ({ connector: "github", tool: "pr.create", args: { owner: "lin-example", repo, head: "invincible/units", base: "main", title: "Units" } });
    expect((await w.service.call(pull("site"), vm)).status).toBe("done");
    // Back where its shipment left it, it isn't where it last pushed.
    units = head("invincible/units", PUSHED);
    expect((await w.service.call(pull("site"), vm)).status).toBe("asked");
    // It never pushed onto invincible/units in lin-example/docs.
    expect((await w.service.call(pull("docs"), vm)).status).toBe("asked");
  });

  test("only its done shipments and fixes say where it pushed: a failed one, or another tool's receipt that names a commit, never does", async () => {
    const w = world({ given: GIVEN, paths: { "/repos/lin-example/site": site(), "/repos/lin-example/site/git/ref/heads/invincible/units": head("invincible/units", PUSHED) } });
    const pull = { connector: "github", tool: "pr.create", args: { owner: "lin-example", repo: "site", head: "invincible/units", base: "main", title: "Units" } };
    const file = (id: string, tool: string, ok: boolean, receipt: string) => {
      w.store.emit(w.identity, "action.requested", { id, connector: "github", tool, args: { owner: "lin-example", repo: "site", branch: "invincible/units", title: "Units" }, class: "outward", target: `POST /repos/lin-example/site/issues (${tool})`, by: "team.0123456789.ada", expires: Date.UTC(2026, 10, 28) });
      w.store.emit(w.identity, "action.decided", { id, verdict: "approved" }, { trust: "owner" });
      w.store.emit(w.identity, "action.done", { id, ok, status: ok ? 201 : 502, receipt });
    };
    // A shipment that failed, its receipt quoting a commit; an issue whose answer happens to name one.
    file(`a_${"F".repeat(22)}`, "ship", false, `502 GitHub said: commit ${PUSHED.slice(0, 12)} is unknown`);
    file(`a_${"I".repeat(22)}`, "issue.create", true, `201 {"title":"Units","body":"commit ${PUSHED.slice(0, 12)}"}`);
    expect((await w.service.call(pull, vm)).status).toBe("asked");
    // (Once it has shipped there, it is.)
    shipped(w, "invincible/units");
    expect((await w.service.call(pull, vm)).status).toBe("done");
  });

  test("a tool you run with a token of its own is never its, there either: its issue and its words on your own thread wait for you", async () => {
    const w = world({ users: { [KEYS.one]: person(501) }, given: GIVEN, paths: { "/repos/lin-example/site/issues/4": { number: 4, user: { id: 501 } } } });
    const coder = { kind: "agent" as const, by: "arm:coder" };
    expect((await w.service.call(issue("lin-example", "site"), coder)).status).toBe("asked");
    expect((await w.service.call({ connector: "github", tool: "issue.comment", args: { owner: "lin-example", repo: "site", number: 4, body: "Done." } }, coder)).status).toBe("asked");
    expect(w.asked).toEqual([]);
  });

  test("a shipment its kept work doesn't hold, or holds unreadably, waits for you, and GitHub isn't asked", async () => {
    const w = world({ given: GIVEN, shipment: () => null, paths: { "/repos/lin-example/site": site(), "/repos/lin-example/site/git/ref/heads/main": head("main", MAIN) } });
    expect((await w.service.call({ connector: "github", tool: "ship", args: { owner: "lin-example", repo: "site", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Parse SI units" } }, vm)).status).toBe("asked");
    expect((await w.service.call({ connector: "github", tool: "ship.update", args: { owner: "lin-example", repo: "site", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Fix" } }, vm)).status).toBe("asked");
    expect(w.asked).toEqual([]);
  });

  test("a fix onto a branch it never shipped waits for you, and GitHub isn't asked; nor one that began elsewhere than it last pushed", async () => {
    const w = world({ given: GIVEN, shipment: () => ({ files: ["src/units.ts"], base: THEIRS }), paths: { "/repos/lin-example/site/git/ref/heads/invincible/pr-7": head("invincible/pr-7", THEIRS) } });
    const fix = (branch: string) => ({ connector: "github", tool: "ship.update", args: { owner: "lin-example", repo: "site", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch, title: "Fix the test" } });
    expect((await w.service.call(fix("invincible/pr-7"), vm)).status).toBe("asked");
    shipped(w, "invincible/units");
    expect((await w.service.call(fix("invincible/units"), vm)).status).toBe("asked");
    expect(w.asked).toEqual([]);
  });

  test("its words go on its own threads there (one opened under your account); on a contributor's issue or pull request they wait for you", async () => {
    const w = world({ users: { [KEYS.one]: person(501) }, given: GIVEN, paths: { "/repos/lin-example/site/issues/4": { number: 4, user: { id: 501 } }, "/repos/lin-example/site/issues/7": { number: 7, user: { id: 777 } } } });
    const say = (number: number, tool = "issue.comment") => ({ connector: "github", tool, args: { owner: "lin-example", repo: "site", number, body: "One test fails here.", ...(tool === "pull.review" ? { event: "REQUEST_CHANGES" } : {}) } });
    const mine = await w.service.call(say(4), vm);
    expect(mine.status === "done" && mine.own).toBe("a comment on its own thread #4 in lin-example/site, a repository you gave an agent");
    expect((await w.service.call(say(7), vm)).status).toBe("asked");
    expect((await w.service.call(say(7, "pull.review"), { kind: "agent", by: "loop:triage" })).status).toBe("asked");
    expect((await w.service.call(say(7), primary)).status).toBe("asked");
    // Whose the key is (once), then each thread afresh; never the repository, which you gave.
    expect(w.reads()).toEqual(["GET /user", "GET /repos/lin-example/site/issues/4", "GET /repos/lin-example/site/issues/7", "GET /repos/lin-example/site/issues/7", "GET /repos/lin-example/site/issues/7"]);
    // An issue there is its own as before: nothing to ask.
    const before = w.reads().length;
    expect((await w.service.call(issue("lin-example", "site"), vm)).status).toBe("done");
    expect(w.reads().length).toBe(before);
  });
});
