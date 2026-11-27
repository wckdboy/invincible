// What a private connector reads stays in the answer that read it (PRIVATE_CONNECTORS; the lead's word of 27 November
// 2026: the ledger replicated each answer's first 300 characters, a loop's record held what its call answered, and an
// agent could read a waiting send's words). Against a real daemon (startDaemon) and its routes, with a stand-in Google
// (its sign-in and Gmail's API). Every name, address and message here is made up; the keys are obviously fake.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActionView, type RouteName, routes } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { writeKeep } from "@invincible/models";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

const root = mkdtempSync(join(tmpdir(), "invincible-private-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "private", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
let daemon: Daemon;
let agent: string;

/** The mail's words, and a send's: none of them may reach an agent's read of the node, nor any line in the ledger. */
const WORDS = ["Ingrid", "Vestergaard", "ingrid@example.test", "rent arrears", "18,400", "wire it", "lars@example.test", "pay on Thursday", "from:ingrid"];
const header = (name: string, value: string) => ({ name, value });
const message = (format: string) => ({
  id: "a1b2c3d4",
  threadId: "t-a1b2c3d4",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "The 18,400 in rent arrears: please wire it before Friday",
  payload: {
    mimeType: "text/plain",
    headers: [header("From", "Ingrid Vestergaard <ingrid@example.test>"), header("To", "you@example.test"), header("Subject", "Quarterly rent arrears"), header("Date", "Fri, 27 Nov 2026 08:00:00 +0100"), header("Message-ID", "<a1b2c3d4@mail.example.test>")],
    ...(format === "full" ? { body: { data: Buffer.from("The 18,400 in rent arrears: please wire it before Friday.").toString("base64url") } } : {}),
  },
});
const google = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") return Response.json({ access_token: "test-access-FAKE", expires_in: 3600, token_type: "Bearer" });
  if (url.origin !== "https://gmail.googleapis.com") return fetch(input, init);
  const method = init?.method ?? "GET";
  if (method === "GET" && url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [{ id: "a1b2c3d4" }] });
  if (method === "GET" && url.pathname === "/gmail/v1/users/me/messages/a1b2c3d4") return Response.json(message(url.searchParams.get("format") ?? "full"));
  if (method === "POST" && url.pathname === "/gmail/v1/users/me/messages/send") return Response.json({ id: "s1", threadId: "t-a1b2c3d4" });
  return Response.json({ error: { message: "no such route" } }, { status: 404 });
}) as unknown as typeof fetch;

const send = (token: string, name: RouteName, input?: unknown) =>
  fetch(`http://127.0.0.1:${port}${routes[name].path}`, {
    method: routes[name].method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const admin = (name: RouteName, input?: unknown) => send(home.adminToken(), name, input);
/** Which of the mail's words a text holds. */
const held = (text: string) => WORDS.filter((word) => text.includes(word));

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "private" });
  store.close();
  home.writeConfig({ v: 1, name: "private", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, fetch: google });
  expect((await admin("setConnector", { id: "gmail" })).status).toBe(200);
  const keep = writeKeep({ client: "client-id.apps.example.test", secret: "test-secret-FAKE", refresh: "test-refresh-FAKE", account: "you@example.test" });
  expect((await admin("setSecret", { name: "gmail", value: keep, provider: "gmail" })).status).toBe(200);
  agent = (await admin("mintArm", { label: "coder" })).body.token;
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("your agent reads your mail: nothing an agent reads of the node, and no line in the ledger, holds a word of it, nor of a send waiting for you", async () => {
  const primary = { kind: "agent" as const, by: "primary" };
  // It searches your mail and reads a message: the answers are its own, in full.
  const found = await daemon.connectors.call({ connector: "gmail", tool: "search", args: { query: "from:ingrid" } }, primary);
  const read = await daemon.connectors.call({ connector: "gmail", tool: "read", args: { id: "a1b2c3d4" } }, primary);
  expect([found.status, read.status]).toEqual(["done", "done"]);
  expect(read.status === "done" && [read.private, held(read.result.body)]).toEqual([true, ["Ingrid", "Vestergaard", "ingrid@example.test", "rent arrears", "18,400", "wire it"]]);
  // A reply it drafts to send waits for you.
  const reply = await daemon.connectors.call({ connector: "gmail", tool: "send", args: { to: "lars@example.test", subject: "Re: rent", body: "I will pay on Thursday." }, why: "Ingrid asked about the rent arrears" }, primary);
  expect(reply.status).toBe("asked");
  // An order of yours over its trash, in your words.
  expect((await admin("setOrder", { connector: "gmail", tool: "trash", args: { id: "a1b2c3d4" }, label: "Ingrid's reminders" })).status).toBe(200);
  // A loop of yours that searches your mail, run now.
  expect((await admin("setLoop", { name: "rent", schedule: "0 9 * * 1", task: { kind: "call", connector: "gmail", tool: "search", args: { query: "from:ingrid" } } })).status).toBe(200);
  expect((await admin("runLoop", { name: "rent" })).status).toBe(200);
  for (let n = 0; n < 200 && daemon.store.loopRuns("rent").length === 0; n++) await Bun.sleep(10);
  expect(daemon.store.loopRuns("rent")[0]!.body.summary).toMatch(/^gmail\.search → ok \(200\), \d+ bytes \(\d+ ms\)$/);

  // An agent of yours with mind:read reads the ledger, the loops and their runs, your notices, the runs in hand, the
  // actions, the questions and your orders: none of the mail's words, nor the send's. It sees that a send waits, and no more.
  const reads: Record<string, unknown> = {};
  for (const [name, input] of [["ledger"], ["loops"], ["loopRuns", { name: "rent" }], ["notices"], ["runs"], ["actions"], ["questions"], ["orders"]] as [RouteName, unknown?][]) {
    const answer = await send(agent, name, input);
    expect([name, answer.status]).toEqual([name, 200]);
    reads[name] = answer.body;
  }
  for (const [name, body] of Object.entries(reads)) expect([name, held(JSON.stringify(body))]).toEqual([name, []]);
  const waiting = (reads.actions as { actions: ActionView[] }).actions.find((a) => a.tool === "send")!;
  expect(waiting).toMatchObject({ connector: "gmail", tool: "send", state: "waiting", args: {}, target: "gmail.send" });
  // Of the ledger it reads only that you signed an order (which, and until when): none of the mail's lines.
  expect((reads.ledger as { entries: { resource: string; target: string; detail: string }[] }).entries.map((e) => [e.resource, e.target, e.detail.replace(/^o_[\w-]+ · until \d{4}-\d{2}-\d{2}$/, "an order · until its day")])).toEqual([["policy.order", "gmail.trash", "an order · until its day"]]);

  // You read it all: the send's words, so you can answer it.
  const yours = ((await admin("actions")).body.actions as ActionView[]).find((a) => a.tool === "send")!;
  expect(yours.args).toEqual({ to: "lars@example.test", subject: "Re: rent", body: "I will pay on Thursday." });
  expect(yours.why).toBe("Ingrid asked about the rent arrears");
  expect(((await admin("orders")).body.orders as { label: string; args: object }[]).map((o) => [o.label, o.args])).toEqual([["Ingrid's reminders", { id: "a1b2c3d4" }]]);
  // Every line in the ledger (the log every node of yours replicates) says what was done and how it went, in no word of the mail.
  const lines = daemon.store.ledger(200).filter((e) => e.body.resource === "connector.gmail");
  expect(lines.map((e) => [e.body.target, e.body.verdict])).toEqual([
    ["gmail.search", "allow"],
    ["gmail.send", "ask"],
    ["gmail.read", "allow"],
    ["gmail.search", "allow"],
  ]);
  for (const line of lines) expect(held(JSON.stringify(line.body))).toEqual([]);
  expect(lines[0]!.body.detail).toMatch(/^by loop:rent · ok \(200\), \d+ bytes$/);
});

test("a line written before this, with the mail's words in it, is kept in the log but never read by an agent", async () => {
  // As 0.x wrote a read's line: the first 300 characters of its answer.
  daemon.store.emit(daemon.identity, "ledger.recorded", { class: "read", resource: "connector.gmail", target: "GET /gmail/v1/users/me/messages/a1b2c3d4 (read)", verdict: "allow", reason: "reads are its to do", detail: 'by primary · 200 {"from":"Ingrid Vestergaard <ingrid@example.test>","subject":"Quarterly rent arrears"}' });
  const theirs = await send(agent, "ledger");
  expect(theirs.body.entries.filter((e: { resource: string }) => e.resource === "connector.gmail")).toEqual([]);
  expect(held(JSON.stringify(theirs.body))).toEqual([]);
  // The log is append-only: you still read it as it was written.
  const yours = await admin("ledger");
  expect(yours.body.entries.some((e: { detail: string | null }) => e.detail?.includes("Quarterly rent arrears"))).toBe(true);
});
