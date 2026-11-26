import { expect, spyOn, test } from "bun:test";
import type { LoopDraftView, RouteName } from "@galahad/core";
import { describeTask, loopCommand, parseWake } from "../src/loop-cli.ts";

/* `galahad loop drafts`, `loop add --draft` and `loop dismiss` at a terminal, against what the node would answer. */

const draft: LoopDraftView = {
  id: "ld_AAAAAAAAAAAAAAAAAAAAAA",
  name: "pr-check",
  schedule: "0 8 * * 1-5",
  tz: "Europe/Copenhagen",
  on: null,
  task: { kind: "call", connector: "github", tool: "pulls", args: { owner: "amiriteorg", repo: "galahad" } },
  wakes: [],
  cooldownMs: null,
  label: "Open pull requests, each weekday",
  why: "You asked to see the open pull requests every weekday at 8.",
  by: "galahad",
  at: 1,
  expires: 2,
  replaces: false,
};

function node(drafts: LoopDraftView[] = [draft], hookSecret?: string) {
  const asked: { name: RouteName; input: unknown }[] = [];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "loopDrafts") return { drafts } as T;
      if (name === "setLoop") {
        const given = input as { name: string; schedule?: string; wakes?: unknown[]; cooldownMs?: number };
        const wakes = given.wakes ?? [];
        const loop = { name: given.name, schedule: given.schedule ?? draft.schedule, tz: draft.tz, onName: "keep", task: draft.task, next: null, wakes, cooldownMs: given.cooldownMs ?? 600_000, hook: wakes.some((w) => (w as { kind: string }).kind === "webhook") ? `/hooks/${given.name}` : null };
        return { loop, ...(hookSecret ? { hookSecret } : {}) } as T;
      }
      if (name === "loopHook") return { path: "/hooks/deploys", node: "ultra", secret: "f".repeat(64) } as T;
      return { ok: true } as T;
    },
  };
  return { api, asked };
}

async function printed(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => void lines.push(parts.join(" ")));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

test("the drafts are listed with what each would do and why, and how to add or dismiss one", async () => {
  const lines = await printed(() => loopCommand(node().api, "drafts", [], {}));
  expect(lines.join("\n")).toContain("ld_AAAAAAAAAAAAAAAAAAAAAA  pr-check: 0 8 * * 1-5 (Europe/Copenhagen)");
  expect(lines.join("\n")).toContain("call github.pulls owner=amiriteorg repo=galahad");
  expect(lines.join("\n")).toContain("why: You asked to see the open pull requests every weekday at 8.");
  expect(lines.at(-1)).toContain("galahad loop add --draft <id>");
  expect(await printed(() => loopCommand(node([]).api, "drafts", [], {}))).toEqual(["No drafts. Ask Galahad in chat for something on a schedule, and his draft waits here for you."]);
});

test("a draft is added as he drafted it, naming the draft so it leaves the Inbox; where it runs may still be given", async () => {
  const { api, asked } = node();
  await printed(() => loopCommand(api, "add", [], { draft: draft.id, on: "ultra" }));
  expect(asked.at(-1)).toEqual({
    name: "setLoop",
    input: { name: "pr-check", schedule: "0 8 * * 1-5", tz: "Europe/Copenhagen", task: draft.task, on: "ultra", label: "Open pull requests, each weekday", draft: draft.id },
  });
});

test("a draft that's gone says so, and adds nothing; dismissing one asks the node to drop it", async () => {
  const { api, asked } = node([]);
  await expect(loopCommand(api, "add", [], { draft: draft.id })).rejects.toThrow(/no draft ld_A+ \(it was added, dismissed, or a week went by\)/);
  expect(asked.map((a) => a.name)).toEqual(["loopDrafts"]);
  await printed(() => loopCommand(api, "dismiss", [draft.id], {}));
  expect(asked.at(-1)).toEqual({ name: "dismissLoopDraft", input: { id: draft.id } });
});

test("what wakes a loop, as you'd say it at a terminal", () => {
  expect(parseWake("webhook")).toEqual({ kind: "webhook" });
  expect(parseWake("gmail from:boss@example.com is:unread")).toEqual({ kind: "mail", connector: "gmail", query: "from:boss@example.com is:unread" });
  expect(parseWake("outlook")).toEqual({ kind: "mail", connector: "outlook" });
  // A GitHub wake with no events named wakes on a failed CI run; a branch narrows that to its own runs.
  expect(parseWake("github amiriteorg/galahad")).toEqual({ kind: "github", owner: "amiriteorg", repo: "galahad", on: ["ci.failed"] });
  expect(parseWake("github amiriteorg/galahad ci.failed,pushed main")).toEqual({ kind: "github", owner: "amiriteorg", repo: "galahad", on: ["ci.failed", "pushed"], branch: "main" });
  expect(() => parseWake("github amiriteorg")).toThrow(/--wake "github <owner>\/<repo>/);
  expect(parseWake("github amiriteorg/galahad issue.opened,pr.opened")).toEqual({ kind: "github", owner: "amiriteorg", repo: "galahad", on: ["issue.opened", "pr.opened"] });
  expect(() => parseWake("github amiriteorg/galahad merged")).toThrow(/ci.failed or pushed or issue.opened or pr.opened, not "merged"/);
  expect(() => parseWake("slack #general")).toThrow(/--wake webhook/);
  expect(() => parseWake("webhook please")).toThrow(/--wake webhook/);
});

test("a loop with something to wake it and no schedule runs only when woken; its webhook's secret is shown once, with how to sign", async () => {
  const { api, asked } = node([draft], "a".repeat(64));
  const lines = await printed(() => loopCommand(api, "add", ["deploys"], { wake: ["webhook"], quest: "Read what the deploy said and tell me if it failed", cooldown: "15m" }));
  expect(asked.at(-1)).toEqual({
    name: "setLoop",
    input: { name: "deploys", schedule: "never", task: { kind: "quest", goal: "Read what the deploy said and tell me if it failed", network: "isolated" }, wakes: [{ kind: "webhook" }], cooldownMs: 15 * 60_000 },
  });
  const out = lines.join("\n");
  expect(out).toContain("deploys: only when woken on keep");
  expect(out).toContain("wakes on a webhook (a burst within 15 min wakes it once)");
  expect(out).toContain("POST /hooks/deploys");
  expect(out).toContain(`Secret, shown this once (galahad loop hook <name> makes a new one): ${"a".repeat(64)}`);
  expect(out).toContain("X-Hub-Signature-256: sha256=");
  await expect(loopCommand(api, "set", ["deploys"], { cooldown: "soon" })).rejects.toThrow(/--cooldown takes minutes or hours/);
});

test("set leaves what wakes a loop alone unless given; --no-wakes clears it; hook makes a new secret", async () => {
  const { api, asked } = node();
  await printed(() => loopCommand(api, "set", ["deploys"], { every: "1h" }));
  expect(asked.at(-1)!.input).toEqual({ name: "deploys", schedule: "every 1h" });
  await printed(() => loopCommand(api, "set", ["deploys"], { "no-wakes": true }));
  expect(asked.at(-1)!.input).toEqual({ name: "deploys", wakes: [] });
  const lines = await printed(() => loopCommand(api, "hook", ["deploys"], {}));
  expect(asked.at(-1)).toEqual({ name: "loopHook", input: { name: "deploys" } });
  expect(lines.join("\n")).toContain("f".repeat(64));
});

test("a draft with something to wake it is listed with it, and added with it", async () => {
  const woken: LoopDraftView = { ...draft, schedule: "never", wakes: [{ kind: "mail", connector: "gmail", query: "from:boss@example.com" }], cooldownMs: 30 * 60_000 };
  const lines = await printed(() => loopCommand(node([woken]).api, "drafts", [], {}));
  expect(lines.join("\n")).toContain('wakes on new Gmail mail matching "from:boss@example.com" (a burst within 30 min wakes it once)');
  const { api, asked } = node([woken]);
  await printed(() => loopCommand(api, "add", [], { draft: woken.id }));
  expect(asked.at(-1)!.input).toMatchObject({ schedule: "never", wakes: woken.wakes, cooldownMs: 30 * 60_000, draft: woken.id });
});

test("a loop that copies bilag to Drive: --bilag, into --folder when you give one", async () => {
  const { api, asked } = node();
  await printed(() => loopCommand(api, "add", ["books"], { wake: ["gmail has:attachment faktura", "outlook faktura"], bilag: true }));
  expect(asked.at(-1)!.input).toMatchObject({ name: "books", schedule: "never", task: { kind: "bilag" }, wakes: [{ kind: "mail", connector: "gmail" }, { kind: "mail", connector: "outlook" }] });
  await printed(() => loopCommand(api, "add", ["books2"], { wake: ["gmail faktura"], bilag: true, folder: "Regnskab" }));
  expect(asked.at(-1)!.input).toMatchObject({ task: { kind: "bilag", folder: "Regnskab" } });
  expect(describeTask({ kind: "bilag", folder: "Regnskab" })).toBe("copy the bilag in the mail that wakes it to Google Drive (Regnskab/<year>/<month>)");
});

test("a loop that tells you: --tell, and your words with --say", async () => {
  const { api, asked } = node();
  await printed(() => loopCommand(api, "add", ["boss-mail"], { wake: ["gmail from:boss@example.com"], say: "Your boss wrote" }));
  expect(asked.at(-1)!.input).toMatchObject({ name: "boss-mail", schedule: "never", task: { kind: "tell", text: "Your boss wrote" }, wakes: [{ kind: "mail", connector: "gmail", query: "from:boss@example.com" }] });
  await printed(() => loopCommand(api, "add", ["plants"], { cron: "0 9 * * 1", tell: true }));
  expect(asked.at(-1)!.input).toMatchObject({ name: "plants", schedule: "0 9 * * 1", task: { kind: "tell" } });
  await expect(loopCommand(api, "add", ["both"], { every: "1h", tell: true, heartbeat: true })).rejects.toThrow(/give one of --heartbeat, --quest, --call, --tell or --bilag/);
});

test("a reminder once: --at a time in your zone (this terminal's unless --tz), or --in a while from now", async () => {
  const { api, asked } = node();
  await printed(() => loopCommand(api, "add", ["call-mum"], { at: "2026-11-25 17:30", tz: "Europe/Copenhagen", say: "Call mum" }));
  expect(asked.at(-1)!.input).toMatchObject({ name: "call-mum", schedule: "at 2026-11-25 17:30", tz: "Europe/Copenhagen", task: { kind: "tell", text: "Call mum" } });
  await printed(() => loopCommand(api, "add", ["no-zone"], { at: "2026-11-25 17:30", tell: true }));
  expect((asked.at(-1)!.input as { tz?: string }).tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  // In two hours, to the minute, written as the time it will be there.
  const now = Date.parse("2026-11-24T20:07:31Z");
  await printed(() => loopCommand(api, "add", ["look"], { in: "2h", tz: "Europe/Copenhagen", tell: true }, { now: () => now }));
  expect(asked.at(-1)!.input).toMatchObject({ schedule: "at 2026-11-24 23:08", tz: "Europe/Copenhagen" });
  await printed(() => loopCommand(api, "add", ["soon"], { in: "45m", tz: "UTC", tell: true }, { now: () => now }));
  expect(asked.at(-1)!.input).toMatchObject({ schedule: "at 2026-11-24 20:53", tz: "UTC" });
  await expect(loopCommand(api, "add", ["two"], { at: "2026-11-25 17:30", every: "1h", tell: true })).rejects.toThrow(/one of --every, --cron, --at or --in/);
  await expect(loopCommand(api, "add", ["bad"], { in: "soon", tell: true })).rejects.toThrow(/--in takes minutes, hours or days/);
});
