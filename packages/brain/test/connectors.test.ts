import { describe, expect, test } from "bun:test";
import { buildRequest, ConnectorManifest, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { CATALOG, type DiscoveredTool, excerpt, keyState, MAX_RESPONSE_BYTES, mergeMcpTools, sendConnectorRequest, transferConnectorBytes } from "../src/index.ts";

function vault() {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  return new Vault(store, identity);
}

const forge = ConnectorManifest.parse({
  id: "forge",
  label: "Forge",
  origin: "https://api.forge.test",
  auth: { secret: "forge", scheme: "bearer" },
  tools: { me: { description: "me", method: "GET", path: "/user", class: "read" } },
});
const KEY = "forge_test_key_0123456789";

function recorder(respond: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    seen.push(req);
    return respond(req);
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

describe("the connector catalog", () => {
  test("every built-in connector is a valid manifest", () => {
    for (const [id, entry] of Object.entries(CATALOG)) {
      const parsed = ConnectorManifest.safeParse({ ...entry.manifest, origin: entry.manifest.origin ?? "http://homeassistant.local:8123" });
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
      expect(parsed.data!.id).toBe(id);
    }
  });

  test("Cloudflare: creating buckets is Galahad's to do; deleting one asks", () => {
    const cf = CATALOG.cloudflare!.manifest.tools;
    expect(cf["r2.bucket.create"]!.class).toBe("create");
    expect(cf["r2.bucket.delete"]!.class).toBe("delete");
    const outward = Object.values(CATALOG.github!.manifest.tools).filter((t) => t.class === "outward");
    expect(outward.length).toBeGreaterThan(0);
    expect(CATALOG["home-assistant"]!.manifest.tools.service!.class).toBe("outward"); // the physical world always asks
  });
});

describe("GitHub: pull requests and CI", () => {
  const github = ConnectorManifest.parse(CATALOG.github!.manifest);
  const url = (tool: string, args: Record<string, string | number>) => buildRequest(github, tool, args).url;

  test("a pull request, its files, reviews and line comments, and a commit's checks with what they reported, are his to read", () => {
    const pr = { owner: "amiriteorg", repo: "galahad", number: 12 };
    expect(url("pull", pr)).toBe("https://api.github.com/repos/amiriteorg/galahad/pulls/12");
    expect(url("pull.files", { ...pr, per_page: 100 })).toBe("https://api.github.com/repos/amiriteorg/galahad/pulls/12/files?per_page=100");
    expect(url("pull.reviews", pr)).toBe("https://api.github.com/repos/amiriteorg/galahad/pulls/12/reviews");
    expect(url("pull.comments", pr)).toBe("https://api.github.com/repos/amiriteorg/galahad/pulls/12/comments");
    // A branch with a slash in it is one path segment.
    expect(url("checks", { owner: "amiriteorg", repo: "galahad", ref: "galahad/units" })).toBe("https://api.github.com/repos/amiriteorg/galahad/commits/galahad%2Funits/check-runs");
    expect(url("check.annotations", { owner: "amiriteorg", repo: "galahad", check_run_id: 4242 })).toBe("https://api.github.com/repos/amiriteorg/galahad/check-runs/4242/annotations");
    expect(url("run.jobs", { owner: "amiriteorg", repo: "galahad", run_id: 99 })).toBe("https://api.github.com/repos/amiriteorg/galahad/actions/runs/99/jobs");
    for (const tool of ["pull", "pull.files", "pull.reviews", "pull.comments", "checks", "check.annotations", "run.jobs"]) expect([tool, github.tools[tool]!.class]).toEqual([tool, "read"]);
  });

  test("a review others see asks first, and never approves: that stays yours", () => {
    const review = github.tools["pull.review"]!;
    expect(review.class).toBe("outward");
    expect(() => buildRequest(github, "pull.review", { owner: "o", repo: "r", number: 1, event: "APPROVE", body: "fine" })).toThrow();
    const built = buildRequest(github, "pull.review", { owner: "o", repo: "r", number: 1, event: "REQUEST_CHANGES", body: "The migration drops a column the importer still reads." });
    expect(built).toMatchObject({ method: "POST", url: "https://api.github.com/repos/o/r/pulls/1/reviews" });
    expect(JSON.parse(built.body!)).toEqual({ event: "REQUEST_CHANGES", body: "The migration drops a column the importer still reads." });
  });
});

describe("moving a file's bytes (the node's own work, which no model sees)", () => {
  test("with the key where it was pinned, on the connector's origin alone, the bytes as they are, and an answer read whole", async () => {
    const v = vault();
    v.set("forge", KEY, { provider: "forge", origin: "https://api.forge.test" });
    const body = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const { seen, fetch } = recorder(async (req) => new Response(new Uint8Array(await req.arrayBuffer()), { status: 201, headers: { "content-type": "application/pdf", location: "https://api.forge.test/next" } }));
    const moved = await transferConnectorBytes({ vault: v, fetch }, forge, { method: "POST", url: "https://api.forge.test/upload", headers: { "content-type": "application/pdf" }, body, max: 1024 });
    expect(moved).toMatchObject({ ok: true, status: 201, contentType: "application/pdf", location: "https://api.forge.test/next" });
    expect([...moved.bytes]).toEqual([...body]);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.redirect).toBe("manual");
  });

  test("never off the connector's origin, never with a key pinned elsewhere; an answer over its limit is refused, not cut", async () => {
    const v = vault();
    v.set("forge", KEY, { provider: "forge", origin: "https://api.forge.test" });
    const { seen, fetch } = recorder(() => new Response(new Uint8Array(4096)));
    await expect(transferConnectorBytes({ vault: v, fetch }, forge, { method: "GET", url: "https://evil.test/steal", max: 1 << 20 })).rejects.toThrow(/off Forge's origin/);
    await expect(transferConnectorBytes({ vault: v, fetch }, forge, { method: "GET", url: "https://api.forge.test/big", max: 1000 })).rejects.toThrow(/over 0 MB: not taken/);
    expect(seen.map((r) => r.url)).toEqual(["https://api.forge.test/big"]);
    const elsewhere = vault();
    elsewhere.set("forge", KEY, { provider: "forge", origin: "https://api.other.test" });
    await expect(transferConnectorBytes({ vault: elsewhere, fetch }, forge, { method: "GET", url: "https://api.forge.test/x", max: 1000 })).rejects.toThrow(/pinned to another origin/);
  });
});

describe("sending a request", () => {
  test("the key is injected only when it was pinned to this origin, for this connector", async () => {
    const v = vault();
    expect(keyState(v, forge)).toBe("missing");
    v.set("forge", KEY, { provider: "forge", origin: "https://api.forge.test" });
    expect(keyState(v, forge)).toBe("ready");
    const { seen, fetch } = recorder(() => Response.json({ login: "galahad" }));
    const result = await sendConnectorRequest({ vault: v, fetch }, forge, buildRequest(forge, "me"));
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.url).toBe("https://api.forge.test/user");
  });

  test("a key pinned elsewhere, or entered for another service, is never sent", async () => {
    const v = vault();
    v.set("forge", KEY, { provider: "forge", origin: "https://api.other.test" });
    expect(keyState(v, forge)).toBe("wrong-origin");
    const { seen, fetch } = recorder(() => Response.json({}));
    await expect(sendConnectorRequest({ vault: v, fetch }, forge, buildRequest(forge, "me"))).rejects.toThrow(/pinned to another origin/);
    v.set("forge", KEY, { provider: "deepseek", origin: "https://api.forge.test" });
    expect(keyState(v, forge)).toBe("wrong-origin");
    expect(seen).toHaveLength(0);
  });

  test("an optional key that isn't there means a call without one", async () => {
    const open = ConnectorManifest.parse({ ...forge, auth: { ...forge.auth!, optional: true } });
    const { seen, fetch } = recorder(() => Response.json({}));
    await sendConnectorRequest({ vault: vault(), fetch }, open, buildRequest(open, "me"));
    expect(seen[0]!.headers.get("authorization")).toBeNull();
  });

  test("redirects aren't followed, and an echoed key comes back redacted", async () => {
    const v = vault();
    v.set("forge", KEY, { provider: "forge", origin: "https://api.forge.test" });
    const { seen, fetch } = recorder((req) =>
      req.url.endsWith("/user") ? new Response(`you sent ${KEY}`, { status: 302, headers: { location: "https://evil.test/steal" } }) : Response.json({}),
    );
    const result = await sendConnectorRequest({ vault: v, fetch }, forge, buildRequest(forge, "me"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
    expect(result.status).toBe(302);
    expect(result.body).not.toContain(KEY);
    expect(result.body).toContain("[redacted]");
  });

  test("a service's own ids are its own, not keys: Drive's file ids and Graph's mail ids come back whole; a key never does, nor another service's ids", async () => {
    const driveId = "1wvUWlyaIe7610BS3JpoTY7JC7UIdxi1U";
    const mailId = "AAMkADVhYzM0NjQ3LTVmYzYtNDQ4Yi1hNGQ0LTFiYzBkZjQxMmQ4NQBGAAAAAACxFakeMessageId=";
    const leaked = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const { fetch } = recorder(() => Response.json({ files: [{ id: driveId }], messages: [{ id: mailId }], echoed: leaked }));
    const answer = async (manifest: ConnectorManifest) =>
      (await sendConnectorRequest({ vault: vault(), fetch }, manifest, { kind: "http", method: "GET", url: `${manifest.origin}/x`, headers: {}, class: "read", target: "GET /x" })).body;
    const shipped = (id: string, over: Partial<ConnectorManifest> = {}) => ConnectorManifest.parse({ ...CATALOG[id]!.manifest, auth: undefined, ...over });
    const drive = await answer(shipped("gdrive"));
    expect(drive).toContain(driveId);
    expect(drive).not.toContain(mailId);
    expect(drive).not.toContain(leaked);
    const mail = await answer(shipped("outlook"));
    expect(mail).toContain(mailId);
    expect(mail).not.toContain(driveId);
    expect(mail).not.toContain(leaked);
    // One of yours by the same name, somewhere else, is held to every rule.
    expect(await answer(shipped("gdrive", { origin: "https://drive.example.test" }))).not.toContain(driveId);
  });

  test("answers are size-capped", async () => {
    const { fetch } = recorder(() => new Response("x".repeat(MAX_RESPONSE_BYTES + 10_000)));
    const open = ConnectorManifest.parse({ ...forge, auth: undefined });
    const result = await sendConnectorRequest({ vault: vault(), fetch }, open, buildRequest(open, "me"));
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(60_000);
  });
});

describe("excerpts", () => {
  const result = (body: string, contentType: string) => ({ ok: false, status: 503, contentType, body, truncated: false, durationMs: 5 });
  test("HTML becomes its text on one line; JSON is compacted", () => {
    const page = "<html><head><title>x</title><style>h1{}</style></head><body>\n<h1>503 Service&nbsp;Unavailable</h1>\n<script>var a = 1;</script></body></html>";
    expect(excerpt(result(page, "text/html; charset=utf-8"))).toBe("503 503 Service Unavailable");
    expect(excerpt(result('{\n  "a": 1\n}', "application/json"))).toBe('503 {"a":1}');
    expect(excerpt(result("line one\n\nline two", "text/plain"), 8)).toBe("503 line one…");
  });
});

describe("merging an MCP server's tools", () => {
  const tool = (remote: string, hints: DiscoveredTool["hints"] = {}, schema = `s-${remote}`): DiscoveredTool => ({
    remote,
    description: `${remote} does things`,
    params: {},
    hints,
    schema,
  });

  test("new tools start from the hints; your classes win; what you chose before stays", () => {
    const first = mergeMcpTools([tool("search", { readOnly: true }), tool("sendMail"), tool("dropTable", { destructive: true })], {}, { classes: { sendMail: "modify" } });
    expect(Object.fromEntries(Object.entries(first.tools).map(([k, t]) => [k, t.class]))).toEqual({ search: "read", send_mail: "modify", drop_table: "delete" });
    expect(first.report).toEqual({ added: ["search", "send_mail", "drop_table"], changed: [], removed: [], skipped: 0 });

    // Later: the server changed sendMail and dropped dropTable; your class for send_mail stays.
    const again = mergeMcpTools([tool("search", { readOnly: true }), tool("sendMail", {}, "s-new"), tool("newThing")], first.tools);
    expect(again.tools.send_mail!.class).toBe("modify");
    expect(again.tools.new_thing!.class).toBe("outward");
    expect(again.report).toEqual({ added: ["new_thing"], changed: ["send_mail"], removed: ["drop_table"], skipped: 0 });
  });

  test("the reviewed library's proposal comes after your choices and before the server's hints", () => {
    const proposed = [["book*", "outward"], ["create*", "create"], ["get*", "read"]] as const;
    const merged = mergeMcpTools([tool("BookVoucher", { readOnly: true }), tool("create_invoice"), tool("get_report", { destructive: true }), tool("other", { readOnly: true }), tool("create_contact")], {}, { proposed, classes: { create_contact: "outward" } });
    expect(Object.fromEntries(Object.entries(merged.tools).map(([k, t]) => [k, t.class]))).toEqual({ book_voucher: "outward", create_invoice: "create", get_report: "read", other: "read", create_contact: "outward" });
    // What you changed later stays, whatever the library proposes.
    const yours = { ...merged.tools, create_invoice: { ...merged.tools.create_invoice!, class: "outward" as const } };
    expect(mergeMcpTools([tool("create_invoice")], yours, { proposed }).tools.create_invoice!.class).toBe("outward");
  });

  test("* sets the class of tools you don't name; only narrows what's installed", () => {
    const all = mergeMcpTools([tool("a"), tool("b"), tool("c")], {}, { classes: { "*": "read", c: "outward" }, only: ["a", "c"] });
    expect(Object.fromEntries(Object.entries(all.tools).map(([k, t]) => [k, t.class]))).toEqual({ a: "read", c: "outward" });
    expect(all.report.skipped).toBe(1);
  });

  test("on a refresh, * you give now applies to every tool you don't name, old ones too", () => {
    const first = mergeMcpTools([tool("a"), tool("b"), tool("c")], {});
    const again = mergeMcpTools([tool("a"), tool("b"), tool("c")], first.tools, { classes: { "*": "read", c: "outward" } });
    expect(Object.fromEntries(Object.entries(again.tools).map(([k, t]) => [k, t.class]))).toEqual({ a: "read", b: "read", c: "outward" });
  });

  test("a description that looks like a key never enters the log", () => {
    const leaky = { ...tool("leak"), description: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to call" };
    expect(mergeMcpTools([leaky], {}).tools.leak!.description).toMatch(/withheld/);
  });
});
