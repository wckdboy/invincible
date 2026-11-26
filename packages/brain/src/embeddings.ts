import { redact } from "@galahad/core";
import type { BrainContext } from "./chat.ts";
import { keyHeaders, resolveProvider, whyNoKey } from "./providers.ts";
import { parseRef, roleModels } from "./roster.ts";

/*
 * The embedder: a roster role like any other, played by any provider with an
 * OpenAI-compatible `/embeddings` endpoint. Local runtimes serve one (Ollama and
 * llama.cpp's server, at /v1/embeddings), so the archive's contents never have to leave
 * your machines; that's the documented default (scripts/deploy.sh --embedder).
 *
 * Vectors from different models can't be compared, so there's no fallback here: the
 * role's first model is the archive's model. Change it and the archive embeds
 * everything again in the background (searching by words meanwhile).
 */

export class EmbedderError extends Error {}

/**
 * How a model wants to be asked. Several embedding models are trained with a prefix on
 * queries (and some on documents), and score worse without it. From each model's card.
 */
const PROMPTS: { match: RegExp; query: (q: string) => string; document: (d: string) => string }[] = [
  {
    match: /qwen3-embedding/i,
    query: (q) => `Instruct: Given a search query, retrieve passages from a personal archive of experiments, models, notes and conversations that answer it\nQuery: ${q}`,
    document: (d) => d,
  },
  { match: /nomic-embed/i, query: (q) => `search_query: ${q}`, document: (d) => `search_document: ${d}` },
  { match: /embeddinggemma/i, query: (q) => `task: search result | query: ${q}`, document: (d) => `title: none | text: ${d}` },
  { match: /(^|[/@-])e5-/i, query: (q) => `query: ${q}`, document: (d) => `passage: ${d}` },
  { match: /bge-(small|base|large)-(en|zh)/i, query: (q) => `Represent this sentence for searching relevant passages: ${q}`, document: (d) => d },
];

/** The text a model is given for a query or a document. */
export function embeddingInput(model: string, text: string, as: "query" | "document"): string {
  const prompt = PROMPTS.find((p) => p.match.test(model));
  return prompt ? prompt[as](text) : text;
}

/** A model that only embeds (never chats): left out when a role says `<provider>/*`. */
export const isEmbeddingModel = (model: string): boolean => /embed|(^|[/:-])bge-|(^|[/:-])e5-|(^|[/:-])gte-|minilm|mxbai/i.test(model);

/** The archive's embedding model: the embedder role's first model, or null when none is hired. */
export function embedderRef(ctx: Pick<BrainContext, "store">): string | null {
  return roleModels(ctx.store, "embedder")[0] ?? null;
}

export interface Embedding {
  ref: string;
  vectors: Float32Array[];
  dims: number;
  /** The provider runs on this node: nothing left it. */
  local: boolean;
}

/** Unit length, so cosine similarity is a dot product. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (!norm) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/**
 * Embed texts with the embedder role's model (or `ref`). Unit-length vectors, one per
 * text, in order. What's embedded goes to that provider exactly as chat goes to a model
 * provider, so callers scan it for secrets first.
 */
export async function embed(ctx: BrainContext, texts: string[], opts: { as: "query" | "document"; ref?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Embedding> {
  const ref = opts.ref ?? embedderRef(ctx);
  if (!ref) throw new EmbedderError("no embedder is hired (galahad roster set embedder <provider>/<model>)");
  const { provider: id, model } = parseRef(ref);
  if (model === "*") throw new EmbedderError(`name the embedding model (${id}/<model>): vectors from different models can't be mixed`);
  const provider = resolveProvider(ctx.store, ctx.vault, id);
  if (!provider) throw new EmbedderError(`provider "${id}" is not configured`);
  if (provider.kind !== "openai") throw new EmbedderError(`${id} has no embeddings endpoint (it speaks ${provider.kind})`);
  if (!provider.apiKey && !provider.local) throw new EmbedderError(whyNoKey(id));
  if (!texts.length) return { ref, vectors: [], dims: 0, local: provider.local };
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? (provider.local ? 120_000 : 60_000)), ...(opts.signal ? [opts.signal] : [])];
  let response: Response;
  try {
    response = await (ctx.fetch ?? fetch)(`${provider.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...keyHeaders(provider) },
      body: JSON.stringify({ model, input: texts.map((t) => embeddingInput(model, t, opts.as)), encoding_format: "float" }),
      // A key is pinned to one origin: never follow a redirect anywhere else.
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw new EmbedderError(`${ref}: ${redact(String((error as Error).message ?? error), [provider.apiKey]).slice(0, 300)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new EmbedderError(`${ref} /embeddings → ${response.status}${body ? `: ${redact(body, [provider.apiKey]).slice(0, 300)}` : ""}`);
  }
  const json = (await response.json().catch(() => null)) as { data?: { index?: number; embedding?: unknown }[] } | null;
  const data = json?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new EmbedderError(`${ref} answered with ${Array.isArray(data) ? data.length : "no"} vectors for ${texts.length} texts`);
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = ordered.map((d) => {
    if (!Array.isArray(d.embedding) || !d.embedding.length || d.embedding.length > 8192 || !d.embedding.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new EmbedderError(`${ref} answered with something that isn't a vector`);
    }
    return normalize(Float32Array.from(d.embedding as number[]));
  });
  const dims = vectors[0]!.length;
  if (vectors.some((v) => v.length !== dims)) throw new EmbedderError(`${ref} answered with vectors of different lengths`);
  return { ref, vectors, dims, local: provider.local };
}
