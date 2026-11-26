import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type RouteName, routes } from "@galahad/core";
import { ARM_DEFAULT_SCOPES } from "./arms.ts";
import { INSTRUCTIONS, type ToolApi, toolsFor } from "./tools.ts";

/*
 * Galahad's mind as an MCP server, for any agent harness: Claude Code, OpenCode,
 * Codex, Hermes, T3 Code. It runs on the same machine as a node, speaks to it over
 * loopback with an *arm token* (least privilege: memory, sandboxes, ledger, secret
 * requests; never the vault, devices or keys), and is launched by the harness. Its tools
 * are Galahad's own (tools.ts), the same ones his chat uses:
 *
 *   bun <repo>/packages/node/src/cli.ts mcp --arm claude-code
 */


class ArmClient implements ToolApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
    /** The call's own: a caller's cancel (MCP's notifications/cancelled) aborts its requests to the node. */
    private readonly signal?: AbortSignal,
  ) {}

  async call<T>(name: RouteName, input?: unknown): Promise<T> {
    const route = routes[name];
    let response: Response;
    try {
      response = await fetch(`${this.base}${route.path}`, {
        method: route.method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
        signal: this.signal,
      });
    } catch {
      if (this.signal?.aborted) throw new Error("the caller cancelled this call");
      throw new Error(`no Galahad node is running at ${this.base}; start it with \`galahad serve\``);
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string; status?: number };
    if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    // Long-running responses report late failures in the body.
    if (typeof body.error === "string" && typeof body.status === "number") throw new Error(body.error);
    return body as T;
  }

  /** A route that answers with bytes (an artifact's file). */
  async bytes(name: RouteName, input: unknown): Promise<{ bytes: Uint8Array; type: string }> {
    const route = routes[name];
    const response = await fetch(`${this.base}${route.path}`, {
      method: route.method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(input ?? {}),
      signal: this.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "" };
  }
}

export interface McpOptions {
  base: string;
  token: string;
  version: string;
  /** The arm's scopes (from whoami): tools that need more aren't offered at all. Unknown: an arm's defaults. */
  scopes?: string[];
  /**
   * These tools alone (`galahad mcp --tools a,b`), of those its scopes allow: a grant to an agent on another machine
   * (qamp-grants.ts), whose arm's mind:read would otherwise offer your memories too. Absent: every tool they allow.
   */
  only?: readonly string[];
}

export function createMcpServer(opts: McpOptions): McpServer {
  const api = new ArmClient(opts.base, opts.token);
  const server = new McpServer({ name: "galahad", title: "Galahad", version: opts.version }, { instructions: INSTRUCTIONS });

  for (const t of toolsFor(opts.scopes ?? ARM_DEFAULT_SCOPES).filter((t) => !opts.only || opts.only.includes(t.name))) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, ...(t.annotations ? { annotations: t.annotations } : {}) }, async (args: unknown, extra: { signal?: AbortSignal }) => {
      try {
        // Its requests to the node go with the call's signal, so a caller's cancel stops them there.
        const result = await t.run(extra?.signal ? new ArmClient(opts.base, opts.token, extra.signal) : api, args ?? {});
        if (typeof result === "string") return { content: [{ type: "text" as const, text: result }] };
        // A picture goes as MCP image content, after its words.
        return { content: [{ type: "text" as const, text: result.text }, ...(result.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }))] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Galahad: ${(error as Error).message}` }], isError: true };
      }
    });
  }

  const oathPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/OATH.md");
  server.registerResource(
    "oath",
    "galahad://oath",
    { title: "The Oath of Galahad", description: "Character, duties and hard limits every agent working for this user is bound by.", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: existsSync(oathPath) ? readFileSync(oathPath, "utf8") : "(the Oath is not available on this node)" }],
    }),
  );

  return server;
}

export async function runMcpServer(opts: McpOptions): Promise<void> {
  // What this arm may do decides which tools it's offered.
  const scopes = opts.scopes ?? (await new ArmClient(opts.base, opts.token).call<{ scopes: string[] }>("whoami").then((w) => w.scopes).catch(() => undefined));
  const server = createMcpServer({ ...opts, scopes });
  await server.connect(new StdioServerTransport());
}
