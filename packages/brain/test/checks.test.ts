import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { checkModel } from "../src/checks.ts";

/*
 * Checking what a model can do, before it is given work that needs it: the quest loop's format (one command a
 * reply), reading a screen, and placing a click on one. On 14 November 2026 kimi-k3.1-pro sent a reply with no
 * command in two turns of three, and qwen3.8-max read a screen but answered places on its own 0 to 1000 scale:
 * neither was known until a task failed. The test screen is a page drawn once by Chrome, its targets measured by
 * the page itself (assets/check-card).
 */

const card = JSON.parse(readFileSync(new URL("../assets/check-card/card.json", import.meta.url), "utf8")) as { heading: string; targets: Record<string, { centre: [number, number]; box: [number, number, number, number] }> };

/** A stand-in model at a local address: `answer` decides each reply from what it was sent. */
function model(answer: (body: { messages: { role: string; content: unknown }[] }, picture: boolean) => Response | string) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "stand-in", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  const asked: { picture: boolean }[] = [];
  const spent: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const picture = JSON.stringify(body.messages).includes('"image_url"');
    asked.push({ picture });
    const reply = answer(body, picture);
    if (reply instanceof Response) return reply;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { ctx: { store, vault, fetch, spent: (call: { role: string; ref: string }) => void spent.push(`${call.role} ${call.ref}`) }, asked, spent };
}

const sh = (command: string) => `Next.\n\`\`\`sh\n${command}\n\`\`\``;
const exact = JSON.stringify(Object.fromEntries(Object.entries(card.targets).map(([id, t]) => [id, t.centre])));
const thousandths = JSON.stringify(Object.fromEntries(Object.entries(card.targets).map(([id, t]) => [id, [Math.round((t.centre[0] * 1000) / 1280), Math.round((t.centre[1] * 1000) / 800)]])));
/** A model that answers each part well: a command a turn (then DONE), the heading, and the places in pixels. */
const able = (body: { messages: { role: string; content: unknown }[] }, picture: boolean) => {
  if (!picture) return body.messages.filter((m) => m.role === "assistant").length < 2 ? sh("ls -la") : "DONE\nIt is there.";
  return JSON.stringify(body.messages).includes("largest heading") ? card.heading : `\`\`\`json\n${exact}\n\`\`\``;
};

describe("checking a model", () => {
  test("one that does each part well: every reply a command, the heading read, every click on its target", async () => {
    const m = model(able);
    const check = await checkModel(m.ctx, "stand-in/able", { version: "abc1234" });
    expect(check).toMatchObject({ version: "abc1234", format: { replies: 6, good: 6 }, reads: { ok: true, said: card.heading }, places: { targets: 8, landed: 8, meanErrorPx: 0 } });
    expect(check.errors).toBeUndefined();
    // The screen went to it as a picture, though nothing was known of it seeing (that is what was checked).
    expect(m.asked.filter((a) => a.picture)).toHaveLength(2);
    // What each call cost is counted, under its own role.
    expect(m.spent.length).toBe(8);
    expect(new Set(m.spent)).toEqual(new Set(["check stand-in/able"]));
  });

  test("one that answers in prose with no command, as kimi did: few replies with a command, and the loop stops it after three in a row", async () => {
    const m = model((body, picture) => (picture ? card.heading : "I'll inspect the workspace first, then write the module."));
    const check = await checkModel(m.ctx, "stand-in/prose", { parts: ["format"] });
    expect(check.format).toEqual({ replies: 6, good: 0 });
    expect(check.reads).toBeUndefined();
  });

  test("one that answers places on its own scale, as qwen3.8-max did: it reads the screen, and its clicks miss", async () => {
    const m = model((body, picture) => (picture && !JSON.stringify(body.messages).includes("largest heading") ? thousandths : able(body, picture)));
    const check = await checkModel(m.ctx, "stand-in/scaled", { parts: ["reads", "places"] });
    expect(check.reads?.ok).toBe(true);
    expect(check.places!.landed).toBeLessThan(4);
    expect(check.places!.meanErrorPx).toBeGreaterThan(50);
  });

  test("one that misreads the heading, or refuses a picture: said, and the rest is still checked", async () => {
    const misreads = await checkModel(model((body, picture) => (picture && JSON.stringify(body.messages).includes("largest heading") ? "Harbour" : able(body, picture))).ctx, "stand-in/misreads", { parts: ["reads"] });
    expect(misreads.reads).toEqual({ ok: false, said: "Harbour" });
    const blind = model((body, picture) => (picture ? new Response('{"error":{"message":"Invalid image or video input"}}', { status: 400 }) : able(body, picture)));
    const check = await checkModel(blind.ctx, "stand-in/blind");
    expect(check.format).toEqual({ replies: 6, good: 6 });
    expect(check.reads).toBeUndefined();
    expect(check.places).toBeUndefined();
    expect(check.errors).toEqual([expect.stringMatching(/^reads: .*400.*Invalid image/), expect.stringMatching(/^places: .*400.*Invalid image/)]);
  });

  test("a model with no provider is no check at all: it says why", async () => {
    await expect(checkModel(model(able).ctx, "nowhere/x")).rejects.toThrow(/provider "nowhere" is not configured/);
  });
});

import { chat, type ChatTools } from "../src/index.ts";

describe("choosing by what a model was seen to do", () => {
  /** Two stand-in models on one roster: `odd` was checked and found not to follow the loop's format, `able` was not checked. */
  function roster(role: string, models: string[], checked: Record<string, Record<string, unknown>>) {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    store.emit(identity, "provider.set", { id: "odd", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
    store.emit(identity, "provider.set", { id: "able", kind: "openai", baseUrl: "http://localhost:9/v1" });
    store.emit(identity, "roster.set", { role, models });
    for (const [model, check] of Object.entries(checked)) store.emit(identity, "model.checked", { model, check });
    const asked: string[] = [];
    const bodies: any[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(new URL(String(url)).host === "127.0.0.1:9" ? "odd" : "able");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "```sh\nls\n```" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    return { ctx: { store, vault, fetch }, asked, bodies };
  }
  const NOT_FORMAT = { at: Date.UTC(2026, 10, 14), format: { replies: 25, good: 8 } };
  const run = async (r: ReturnType<typeof roster>, request: Parameters<typeof chat>[1]) => {
    const events: any[] = [];
    for await (const event of chat(r.ctx, request)) events.push(event);
    return events;
  };

  test("the quest loop's engineer passes over a model checked as not following its format, and says why; another role, a pinned model, or the only one is still asked", async () => {
    const loop = { role: "engineer", coding: true, messages: [{ role: "user" as const, content: "Quest: make it so" }] };
    const r = roster("engineer", ["odd/m", "able/m"], { "odd/m": NOT_FORMAT });
    const events = await run(r, loop);
    expect(r.asked).toEqual(["able"]);
    expect(events.find((e) => e.type === "fallback")).toEqual({ type: "fallback", from: "odd/m", error: "it doesn't follow the quest loop's command format (commands in 8 of 25 replies when it was checked): passed over for this loop" });
    // Asked for its own answer in another role, or held to that model by name, it is asked as ever.
    const planner = roster("planner", ["odd/m", "able/m"], { "odd/m": NOT_FORMAT });
    await run(planner, { role: "planner", messages: [{ role: "user", content: "Plan it" }] });
    expect(planner.asked).toEqual(["odd"]);
    // Another role's models doing the loop's turns (a quest that escalated: loop) are held to its format all the same.
    const escalated = roster("planner", ["odd/m", "able/m"], { "odd/m": NOT_FORMAT });
    await run(escalated, { role: "planner", coding: true, loop: true, messages: [{ role: "user", content: "Quest: make it so" }] });
    expect(escalated.asked).toEqual(["able"]);
    const pinned = roster("engineer", ["able/m"], { "odd/m": NOT_FORMAT });
    await run(pinned, { ...loop, model: "odd/m" });
    expect(pinned.asked).toEqual(["odd"]);
    // The only model the role has is asked anyway: passing it over would leave nobody.
    const alone = roster("engineer", ["odd/m"], { "odd/m": NOT_FORMAT });
    await run(alone, loop);
    expect(alone.asked).toEqual(["odd"]);
  });

  test("a picture goes to a model checked as reading screens, though nothing else says it sees; one that isn't gets the picture's words", async () => {
    const picture = { mediaType: "image/png" as const, data: "iVBORw0KGgo=", alt: "a screenshot of the build page" };
    const tools: ChatTools = {
      specs: [{ name: "look", description: "Look at the screen.", inputSchema: { type: "object", properties: {} } }],
      describe: () => ({ title: "Look", input: "" }),
      run: async () => ({ content: "Here is the screen.", summary: "looked", images: [picture] }),
    };
    let calls = 0;
    const sees = roster("planner", ["able/m"], { "able/m": { at: 1, reads: { ok: true, said: "Quarterly harbour ledger" } } });
    sees.ctx.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sees.bodies.push(JSON.parse(String(init?.body)));
      const delta = calls++ === 0 ? { tool_calls: [{ index: 0, id: "look", function: { name: "look", arguments: "{}" } }] } : { content: "It shows the build page." };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    await run(sees, { role: "planner", messages: [{ role: "user", content: "What is on the screen?" }], tools });
    expect(JSON.stringify(sees.bodies.at(-1))).toContain('"image_url"');
    // The same model with no check, and the same with a check that says it misreads: the words, not the picture.
    for (const check of [null, { at: 1, reads: { ok: false, said: "Harbour" } }]) {
      calls = 0;
      const blind = roster("planner", ["able/m"], check ? { "able/m": check } : {});
      blind.ctx.fetch = sees.ctx.fetch;
      sees.bodies.length = 0;
      await run(blind, { role: "planner", messages: [{ role: "user", content: "What is on the screen?" }], tools });
      expect(JSON.stringify(sees.bodies.at(-1))).not.toContain('"image_url"');
      expect(JSON.stringify(sees.bodies.at(-1))).toContain("a screenshot of the build page");
    }
  });
});
