import type { NativeTool } from "./connectors.ts";

/*
 * Merging a pull request of its agents' proven work, as this node's connectors run it (github.merge; your word, 27
 * November 2026: merging is its, on by default, in the repositories you gave your agents). Through GitHub's own merge,
 * and only once GitHub says the pull request is clean: every check and review its rules require has passed. A key that
 * could pass a protection doesn't change that: "blocked" is refused whoever holds the key. Its head must still be the
 * commit that was proven, and GitHub is told that head, so nothing pushed since lands with it. It merges by a method
 * the repository allows, and is never forced, nor tried again another way. Each request goes through `send`: the
 * connector's pinned origin and key.
 */

type Json = Record<string, any> | null;
/** GitHub's order of its methods, the one its merge button offers first first. */
const METHODS = ["merge", "squash", "rebase"] as const;
const ALLOWS: Record<(typeof METHODS)[number], string> = { merge: "allow_merge_commit", squash: "allow_squash_merge", rebase: "allow_rebase_merge" };

export function mergeNative(): NativeTool {
  return async (manifest, args, send) => {
    const started = performance.now();
    const origin = new URL(manifest.origin).origin;
    const at = `/repos/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.repo))}`;
    const number = Number(args.number);
    const proven = String(args.sha).toLowerCase();
    const said = (ok: boolean, status: number, body: string) => ({ ok, status, contentType: "text/plain", body, truncated: false, durationMs: Math.round(performance.now() - started) });
    const ask = async (method: "GET" | "PUT", path: string, body?: object): Promise<{ status: number; json: Json }> => {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new Error("refusing a request off the connector's origin");
      const result = await send({ kind: "http", method, url: url.toString(), headers: { ...(manifest.headers ?? {}) }, ...(body ? { body: JSON.stringify(body) } : {}), class: method === "GET" ? "read" : "outward", target: `${method} ${url.pathname}` });
      let json: Json = null;
      try {
        json = JSON.parse(result.body);
      } catch {
        /* not JSON: its status says enough */
      }
      return { status: result.status, json };
    };

    const pull = await ask("GET", `${at}/pulls/${number}`);
    const p = pull.json;
    if (pull.status !== 200 || !p) return said(false, pull.status, `not merged: GitHub didn't say what #${number} is (${pull.status})`);
    if (p.merged === true) return said(false, 409, `not merged: #${number} is merged already`);
    if (p.state !== "open") return said(false, 409, `not merged: #${number} is ${String(p.state)}`);
    const head = typeof p.head?.sha === "string" ? p.head.sha.toLowerCase() : "";
    if (!/^[0-9a-f]{40}$/.test(head) || !head.startsWith(proven)) return said(false, 409, `not merged: #${number}'s head is ${head.slice(0, 12) || "unknown"}, not the ${proven.slice(0, 12)} that was proven: something was pushed onto it since`);
    if (p.mergeable !== true || p.mergeable_state !== "clean") return said(false, 409, `not merged: GitHub says #${number} is ${String(p.mergeable_state ?? "unknown")}, and it merges only once every check and review its rules require has passed (clean)`);

    // A method the repository allows: the one asked for, else the only one, else in GitHub's own order.
    const repo = await ask("GET", at);
    const allowed = METHODS.filter((method) => repo.json?.[ALLOWS[method]] === true);
    const asked = typeof args.method === "string" ? (args.method as (typeof METHODS)[number]) : null;
    const method = asked ? (allowed.includes(asked) ? asked : null) : (allowed[0] ?? null);
    if (!method) return said(false, 409, `not merged: ${String(args.owner)}/${String(args.repo)} allows ${allowed.join(", ") || "no method GitHub said"}${asked ? `, not ${asked}` : ""}`);

    const merged = await ask("PUT", `${at}/pulls/${number}/merge`, { sha: head, merge_method: method });
    if (merged.status !== 200 || merged.json?.merged !== true) return said(false, merged.status, `not merged: GitHub said ${merged.status}${typeof merged.json?.message === "string" ? `: ${merged.json.message}` : ""}`);
    const sha = typeof merged.json.sha === "string" ? merged.json.sha.slice(0, 12) : "?";
    return said(true, 200, `merged #${number} into ${String(p.base?.ref ?? "its base")} (${method}) at ${sha}: ${String(p.html_url ?? "")}`.trim());
  };
}
