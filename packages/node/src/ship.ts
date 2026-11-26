import { createHash } from "node:crypto";
import { shipToGitHub } from "@invincible/agents";
import type { ArtifactStore } from "./artifacts.ts";
import type { NativeTool } from "./connectors.ts";

/*
 * Shipping as this node's connectors run it (the shipment and its pull request are the run loop's: agents' ship.ts):
 * GitHub through the connector's pinned origin and key, the work from this node's kept artifacts.
 */

/** github.ship (or, `update`, github.ship.update) as the connector service runs it: GitHub through `send` (the pinned origin and key), the work from this node's artifacts. */
export function shipNative(artifacts: ArtifactStore, update = false): NativeTool {
  return async (manifest, args, send) => {
    const started = performance.now();
    const origin = new URL(manifest.origin).origin;
    const result = await shipToGitHub(
      {
        github: async (method, path, body) => {
          const url = new URL(path, origin);
          if (url.origin !== origin) throw new Error("refusing a request off the connector's origin");
          const response = await send({
            kind: "http",
            method,
            url: url.toString(),
            headers: { ...(manifest.headers ?? {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            class: method === "GET" ? "read" : method === "PATCH" ? "modify" : "create",
            target: `${method} ${url.pathname}`,
          });
          let json: any = null;
          try {
            json = JSON.parse(response.body);
          } catch {
            /* not JSON: the status says enough */
          }
          return { status: response.status, json };
        },
        artifact: (id) => {
          const files = artifacts.filesOf(id);
          if (!files) return null;
          return {
            files,
            // What leaves for GitHub is exactly what was kept: each file is checked against its recorded SHA-256.
            read: (path) => {
              const bytes = artifacts.read(id, path).bytes;
              if (createHash("sha256").update(bytes).digest("hex") !== files.find((f) => f.path === path)?.sha256) throw new Error(`${path} isn't what was kept (its SHA-256 differs)`);
              return bytes;
            },
          };
        },
      },
      args,
      update,
    );
    return { ok: result.ok, status: result.status, contentType: "text/plain", body: result.receipt, truncated: false, durationMs: Math.round(performance.now() - started) };
  };
}
