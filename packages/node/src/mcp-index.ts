/*
 * The library of hosted MCP servers on this node: Galahad's reviewed list (core mcp-library.ts) and the index at
 * mcp.galahad.sh (apps/mcp-index). The index is read when the library is asked for and the last read is more than twelve
 * hours old (the answer doesn't wait for it), and kept on disk, so a node that is offline, or just started, still has
 * the last one. Every entry the index gives is checked again here (core indexEntry): one that fails is dropped, never
 * the rest. Reading it sends nothing about you: a GET of a public file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { indexEntry, MCP_INDEX_URL, McpIndexSnapshot, type McpIndexEntry, reviewedEntries } from "@galahad/core";

const STALE_MS = 12 * 3600_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** Where the index is read from: the default, another (GALAHAD_MCP_INDEX: https, or plain http on this machine), or none ("off"). */
export function indexUrl(setting: string | undefined): string | null {
  if (setting === undefined || setting === "") return MCP_INDEX_URL;
  if (setting === "off") return null;
  const url = new URL(setting);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("GALAHAD_MCP_INDEX must be https (plain http only on this machine), or off");
  return url.toString();
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export class McpIndex {
  private fromIndex: McpIndexEntry[] = [];
  private fetched: number | null = null;
  private problem: string | null = null;
  private reading: Promise<void> | null = null;
  private merged: McpIndexEntry[] | null = null;
  /** When the last read failed: tried again a quarter of an hour later, not on every ask. */
  private failedAt: number | null = null;

  constructor(
    private readonly o: {
      /** The last index read, kept here. */
      file: string;
      url: string | null;
      fetch?: typeof fetch;
      now?: () => number;
      /** Ids the node's own connectors use: an indexed server never takes one. */
      reserved?: readonly string[];
      log?: (message: string) => void;
    },
  ) {
    this.load();
  }

  /** The library: the reviewed list, then the index's servers (one that is a reviewed server by its address is that one), each id its own. */
  entries(): McpIndexEntry[] {
    this.readIfStale();
    if (this.merged) return this.merged;
    const reviewed = reviewedEntries();
    // A reviewed server takes its site's place among the most visited from the index.
    const rankOfSite = new Map<string, number>();
    for (const e of this.fromIndex) if (e.rank !== null && e.rank < (rankOfSite.get(e.site) ?? Infinity)) rankOfSite.set(e.site, e.rank);
    for (const e of reviewed) e.rank = rankOfSite.get(e.site) ?? null;
    const taken = new Set([...reviewed.map((e) => e.id), ...(this.o.reserved ?? [])]);
    const out = [...reviewed];
    for (const e of this.fromIndex) {
      if (reviewed.some((r) => sameUrl(r.url, e.url))) continue;
      let id = e.id;
      for (let n = 2; taken.has(id); n++) id = `${e.id.slice(0, 36)}-${n}`;
      taken.add(id);
      out.push(id === e.id ? e : { ...e, id });
    }
    this.merged = out;
    return out;
  }

  /** A server of the library by its id, or null. */
  find(id: string): McpIndexEntry | null {
    return this.entries().find((e) => e.id === id) ?? null;
  }

  /** Where the index stands on this node. */
  status(): { url: string | null; fetched: number | null; count: number; problem: string | null } {
    return { url: this.o.url, fetched: this.fetched, count: this.fromIndex.length, problem: this.problem };
  }

  /** Reads the index now (the CLI's refresh; and in the background when it is stale). */
  async refresh(): Promise<void> {
    if (!this.o.url) return;
    this.reading ??= this.read().finally(() => (this.reading = null));
    return this.reading;
  }

  private readIfStale(): void {
    const now = (this.o.now ?? Date.now)();
    if (this.o.url && !this.reading && (this.fetched === null || now - this.fetched > STALE_MS) && (this.problem === null || now - (this.failedAt ?? 0) > 15 * 60_000)) void this.refresh();
  }

  private async read(): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    try {
      const response = await (this.o.fetch ?? fetch)(this.o.url!, { headers: { accept: "application/json", "user-agent": "galahad-node (+https://galahad.sh)" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`the index answered ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error("the index is larger than any library this node takes");
      const taken = this.take(JSON.parse(text), now);
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeFileSync(`${this.o.file}.tmp`, JSON.stringify({ fetched: now, snapshot: JSON.parse(text) }));
      renameSync(`${this.o.file}.tmp`, this.o.file);
      this.problem = null;
      this.o.log?.(`mcp library: ${taken} servers from the index`);
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error);
      this.failedAt = now;
      this.o.log?.(`mcp library: the index couldn't be read: ${this.problem}`);
    }
  }

  /** A snapshot checked and taken in: how many of its entries passed. */
  private take(raw: unknown, fetched: number): number {
    const snapshot = McpIndexSnapshot.parse(raw);
    const seen = new Set<string>();
    this.fromIndex = snapshot.entries.map(indexEntry).filter((e): e is McpIndexEntry => e !== null && !seen.has(e.id) && Boolean(seen.add(e.id)));
    this.fetched = fetched;
    this.merged = null;
    return this.fromIndex.length;
  }

  /** The last index read, from disk. */
  private load(): void {
    if (!existsSync(this.o.file)) return;
    try {
      const kept = JSON.parse(readFileSync(this.o.file, "utf8")) as { fetched: number; snapshot: unknown };
      this.take(kept.snapshot, kept.fetched);
    } catch {
      /* a kept index that won't read is read again from the source */
    }
  }
}
