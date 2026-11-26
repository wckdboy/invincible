import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { embed, EmbedderError, embeddingInput, embedderRef, isEmbeddingModel, roleModels, roster } from "../src/index.ts";

/*
 * The embedder role: any OpenAI-compatible /embeddings endpoint (Ollama and llama.cpp
 * serve one locally), one model for the whole archive, no fallback (vectors from
 * different models can't be compared), keys only to their pinned origin.
 */

const KEY = "fake_embedding_key_for_tests_0123456789";

function setup() {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1" });
  vault.set("remote", KEY, { provider: "remote", origin: "https://embed.example" });
  store.emit(identity, "provider.set", { id: "remote", kind: "openai", baseUrl: "https://embed.example/v1", secret: "remote" });
  store.emit(identity, "provider.set", { id: "claude", kind: "anthropic", baseUrl: "https://api.anthropic.com" });
  return { identity, store, vault };
}

const vectorsFor = (texts: string[]) => texts.map((_, i) => ({ index: i, embedding: [3, 4, 0].map((x) => x * (i + 1)) }));

describe("the embedder role", () => {
  test("is a role with no default: until you hire one, the archive searches by words", () => {
    const { store } = setup();
    expect(roster(store).embedder).toMatchObject({ models: [], configured: false });
    expect(roleModels(store, "embedder")).toEqual([]);
    expect(embedderRef({ store })).toBeNull();
  });

  test("a local model: the texts go to /embeddings, with the model's query prefix, and come back unit length", async () => {
    const { identity, store, vault } = setup();
    store.emit(identity, "roster.set", { role: "embedder", models: ["ollama/qwen3-embedding:0.6b"] });
    const asked: { url: string; body: any; headers: Record<string, string>; redirect: string | undefined }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      asked.push({ url: String(url), body, headers: init.headers as Record<string, string>, redirect: init.redirect });
      return Response.json({ data: vectorsFor(body.input).reverse() });
    }) as unknown as typeof globalThis.fetch;
    const result = await embed({ store, vault, fetch }, ["what did the cantilever do?"], { as: "query" });
    expect(asked[0]!.url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(asked[0]!.redirect).toBe("manual");
    expect(asked[0]!.body.model).toBe("qwen3-embedding:0.6b");
    expect(asked[0]!.body.input[0]).toStartWith("Instruct: ");
    expect(asked[0]!.body.input[0]).toEndWith("Query: what did the cantilever do?");
    expect(asked[0]!.headers.authorization).toBeUndefined();
    expect(result.ref).toBe("ollama/qwen3-embedding:0.6b");
    expect(result.local).toBe(true);
    expect(result.dims).toBe(3);
    expect([...result.vectors[0]!].map((x) => Math.round(x * 1000) / 1000)).toEqual([0.6, 0.8, 0]);

    // Documents go as they are; order follows the index the server gives.
    const docs = await embed({ store, vault, fetch }, ["a", "b"], { as: "document" });
    expect(asked[1]!.body.input).toEqual(["a", "b"]);
    expect(docs.vectors.length).toBe(2);
  });

  test("a remote provider gets its key, and only through its pinned origin; errors are redacted", async () => {
    const { identity, store, vault } = setup();
    store.emit(identity, "roster.set", { role: "embedder", models: ["remote/text-embed-1", "ollama/never-asked"] });
    const urls: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      return new Response(`{"error":"bad key ${KEY}"}`, { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    const error = await embed({ store, vault, fetch }, ["x"], { as: "document" }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbedderError);
    expect(error.message).toContain("401");
    expect(error.message).not.toContain(KEY);
    // No fallback: the second model would make vectors that can't be compared with the first's.
    expect(urls).toEqual(["https://embed.example/v1/embeddings"]);
  });

  test("refuses what can't embed: no role, a wildcard, an Anthropic provider, a provider without its key, a malformed answer", async () => {
    const { identity, store, vault } = setup();
    const fetch = (async () => Response.json({ data: [{ embedding: ["not", "numbers"] }] })) as unknown as typeof globalThis.fetch;
    expect(await embed({ store, vault, fetch }, ["x"], { as: "query" }).catch((e) => e.message)).toContain("galahad roster set embedder");
    expect(await embed({ store, vault, fetch }, ["x"], { as: "query", ref: "ollama/*" }).catch((e) => e.message)).toContain("name the embedding model");
    expect(await embed({ store, vault, fetch }, ["x"], { as: "query", ref: "claude/claude-haiku-5-5" }).catch((e) => e.message)).toContain("no embeddings endpoint");
    store.emit(identity, "provider.set", { id: "keyless", kind: "openai", baseUrl: "https://keyless.example/v1" });
    expect(await embed({ store, vault, fetch }, ["x"], { as: "query", ref: "keyless/m" }).catch((e) => e.message)).toContain("no key");
    expect(await embed({ store, vault, fetch }, ["x"], { as: "query", ref: "ollama/m" }).catch((e) => e.message)).toContain("isn't a vector");
    const short = (async () => Response.json({ data: [] })) as unknown as typeof globalThis.fetch;
    expect(await embed({ store, vault, fetch: short }, ["x", "y"], { as: "query", ref: "ollama/m" }).catch((e) => e.message)).toContain("0 vectors for 2 texts");
  });

  test("model prompts, from each model's card", () => {
    expect(embeddingInput("nomic-embed-text", "hi", "query")).toBe("search_query: hi");
    expect(embeddingInput("nomic-embed-text:v1.5", "hi", "document")).toBe("search_document: hi");
    expect(embeddingInput("embeddinggemma:300m", "hi", "query")).toBe("task: search result | query: hi");
    expect(embeddingInput("@cf/baai/bge-base-en-v1.5", "hi", "query")).toStartWith("Represent this sentence");
    expect(embeddingInput("bge-m3", "hi", "query")).toBe("hi");
    expect(embeddingInput("qwen3-embedding:0.6b", "hi", "document")).toBe("hi");
  });

  test("embedding models are never picked for a chat role's <provider>/*", () => {
    for (const m of ["qwen3-embedding:0.6b", "nomic-embed-text:latest", "embeddinggemma:300m", "bge-m3:567m", "mxbai-embed-large", "all-minilm"]) expect(isEmbeddingModel(m)).toBe(true);
    for (const m of ["qwen3:8b", "llama3.3:70b", "gemma3:27b", "deepseek-r1"]) expect(isEmbeddingModel(m)).toBe(false);
  });
});
