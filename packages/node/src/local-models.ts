/*
 * The fleet's local models (docs/ARCHITECTURE.md, the fleet as one computer): each node's own runtimes (Ollama,
 * llama.cpp), on its loopback alone, and the models each serves, as its capabilities say. A model call one node makes
 * for a model it doesn't serve, that another full node does, is answered by that node's runtime, through that node
 * (`localModelCall`, signed as the one that asks), and its answer comes back as it came.
 */

/** A node's local runtimes and the models each serves (its capabilities' `localModels`), as far as they can be read. */
export type LocalModels = { runtime: string; models: string[] }[];

export function localModelsOf(caps: unknown): LocalModels {
  const list = caps && typeof caps === "object" ? (caps as { localModels?: unknown }).localModels : undefined;
  return (Array.isArray(list) ? list : []).flatMap((r) =>
    r && typeof r === "object" && typeof r.runtime === "string" && Array.isArray(r.models)
      ? [{ runtime: r.runtime, models: (r.models as unknown[]).filter((m): m is string => typeof m === "string") }]
      : [],
  );
}

/** Whether a runtime's model is among these. */
export const serves = (models: LocalModels, runtime: string, model: string): boolean => models.some((r) => r.runtime === runtime && r.models.includes(model));

/** A node of the fleet that may answer for its local models: its name, where it is reached, and what it serves. */
export interface ModelPeer {
  name: string;
  endpoint: string;
  models: LocalModels;
}

/**
 * This node's model calls, over the fleet: a chat call to one of its local runtimes (`runtimes`: where a call to each
 * goes, `<baseUrl>/chat/completions`, and its provider id) for a model this node doesn't serve, that a peer does, is
 * sent to that peer (`send`), with the caller's signal. Anything else goes as it would (`base`): a model nobody serves
 * fails here as before, and the roster's next model is asked.
 */
export function viaFleet(opts: {
  base: typeof fetch;
  runtimes: () => Map<string, string>;
  here: () => LocalModels;
  peers: () => ModelPeer[];
  send: (endpoint: string, payload: { provider: string; request: Record<string, unknown> }, signal?: AbortSignal) => Promise<Response>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const provider = (init?.method ?? "GET").toUpperCase() === "POST" && typeof init?.body === "string" ? opts.runtimes().get(url) : undefined;
    if (provider) {
      let request: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(init!.body as string);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) request = parsed as Record<string, unknown>;
      } catch {
        /* not a request of ours to read: it goes as it would */
      }
      const model = typeof request?.model === "string" ? request.model : null;
      if (request && model && !serves(opts.here(), provider, model)) {
        const peer = opts.peers().find((p) => serves(p.models, provider, model));
        if (peer) return opts.send(peer.endpoint, { provider, request }, init?.signal ?? undefined);
      }
    }
    return opts.base(input, init);
  }) as typeof fetch;
}
