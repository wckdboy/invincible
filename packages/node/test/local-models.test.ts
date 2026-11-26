import { describe, expect, test } from "bun:test";
import { type LocalModels, localModelsOf, type ModelPeer, serves, viaFleet } from "../src/local-models.ts";

/*
 * The fleet's local models (local-models.ts): a chat call to one of this node's local runtimes, for a model it doesn't
 * serve and a peer does, goes to that peer; anything else goes as it would. Stand-ins play the runtimes and the peers.
 */

const OLLAMA = "http://127.0.0.1:11434/v1";
const call = (model: unknown, url = `${OLLAMA}/chat/completions`, init: RequestInit = {}) => ({ url, init: { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }), ...init } });

function fleet(here: LocalModels, peers: ModelPeer[]) {
  const based: string[] = [];
  const sent: { endpoint: string; payload: { provider: string; request: Record<string, unknown> }; signal?: AbortSignal }[] = [];
  const fetch = viaFleet({
    base: (async (input: RequestInfo | URL) => {
      based.push(String(input));
      return new Response("here");
    }) as typeof globalThis.fetch,
    runtimes: () => new Map([[`${OLLAMA}/chat/completions`, "ollama"]]),
    here: () => here,
    peers: () => peers,
    send: async (endpoint, payload, signal) => {
      sent.push({ endpoint, payload, ...(signal ? { signal } : {}) });
      return new Response("there");
    },
  });
  return { fetch, based, sent };
}

const MINI: ModelPeer = { name: "mini", endpoint: "http://mini.test:7777", models: [{ runtime: "ollama", models: ["mimo-v2.6:9b", "qwen3.8:27b"] }] };

describe("a model call over the fleet", () => {
  test("a local model only a peer serves is asked of that peer, as it was sent, with the caller's signal", async () => {
    const f = fleet([{ runtime: "ollama", models: ["qwen3-embedding:0.6b"] }], [MINI]);
    const stop = new AbortController();
    const c = call("mimo-v2.6:9b", undefined, { signal: stop.signal });
    expect(await (await f.fetch(c.url, c.init)).text()).toBe("there");
    expect(f.sent).toEqual([{ endpoint: "http://mini.test:7777", payload: { provider: "ollama", request: { model: "mimo-v2.6:9b", messages: [{ role: "user", content: "hi" }], stream: true } }, signal: stop.signal }]);
    expect(f.based).toEqual([]);
  });

  test("one this node serves is asked here, though a peer serves it too; one nobody serves is asked here and fails as before", async () => {
    const f = fleet([{ runtime: "ollama", models: ["mimo-v2.6:9b"] }], [MINI]);
    const mine = call("mimo-v2.6:9b");
    expect(await (await f.fetch(mine.url, mine.init)).text()).toBe("here");
    const nobody = call("gemma4:26b");
    expect(await (await f.fetch(nobody.url, nobody.init)).text()).toBe("here");
    expect(f.sent).toEqual([]);
  });

  test("what isn't a chat call to a local runtime goes as it would: a provider's, a list of models, a body it can't read", async () => {
    const f = fleet([], [MINI]);
    const cloud = call("mimo-v2.6:9b", "https://api.example.com/v1/chat/completions");
    await f.fetch(cloud.url, cloud.init);
    await f.fetch(`${OLLAMA}/models`);
    await f.fetch(`${OLLAMA}/chat/completions`, { method: "POST", body: "not json" });
    await f.fetch(`${OLLAMA}/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [] }) });
    expect(f.sent).toEqual([]);
    expect(f.based).toHaveLength(4);
  });
});

describe("a node's local models, as its capabilities say", () => {
  test("read as far as they can be; anything else is none", () => {
    expect(localModelsOf({ localModels: [{ runtime: "ollama", models: ["a", 1, "b"] }, { runtime: 2 }, "x"] })).toEqual([{ runtime: "ollama", models: ["a", "b"] }]);
    for (const caps of [null, undefined, "caps", { localModels: "none" }, {}]) expect(localModelsOf(caps)).toEqual([]);
    expect(serves(MINI.models, "ollama", "qwen3.8:27b")).toBe(true);
    expect(serves(MINI.models, "llamacpp", "qwen3.8:27b")).toBe(false);
  });
});
