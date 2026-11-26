import type { ArchiveEntryView, ArchiveSearchView, ArchiveStatusView, RouteName } from "@galahad/core";

/*
 * The terminal side of the archive. Thin: every rule lives in the node; this only
 * shapes input and prints. The archive is node-local, so these speak to this node's.
 */

export interface ArchiveApi {
  call<T = any>(name: RouteName, input?: unknown): Promise<T>;
  bytes(name: RouteName, input: unknown): Promise<{ bytes: Uint8Array; type: string }>;
}

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const str = (flags: Flags, key: string) => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const csv = (flags: Flags, key: string): string[] | undefined => {
  const v = str(flags, key);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
};
const size = (bytes: number) => (bytes < 2 ** 20 ? `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB` : bytes < 2 ** 30 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : `${(bytes / 2 ** 30).toFixed(2)} GB`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TRUST: Record<string, string> = { owner: "yours", agent: "Galahad's", untrusted: "untrusted" };

/** "7d", "12h", "2026-11-01": a time, in ms. */
export function parseWhen(value: string, now = Date.now(), end = false): number {
  const rel = value.match(/^(\d+)([hdwmy])$/);
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 }[rel[2] as "h" | "d" | "w" | "m" | "y"];
    return now - Number(rel[1]) * unit;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T${end ? "23:59:59" : "00:00:00"}Z`);
  throw new Error(`"${value}" isn't a time: use 7d, 12h, 4w or a date like 2026-11-01`);
}

function printStatus(s: ArchiveStatusView): void {
  console.log(`${bold("The archive")} on ${s.node}${s.paused ? dim(" (paused: answers streaming or the machine is busy)") : ""}`);
  const kinds = Object.entries(s.byKind).map(([k, n]) => `${n} ${k}`).join(", ");
  console.log(`  ${s.entries} entries${kinds ? ` (${kinds})` : ""}${s.deleted ? dim(` · ${s.deleted} deleted by you`) : ""}`);
  const embedder = s.embedder.model
    ? `${s.embedder.model}${s.embedder.local ? " (local)" : s.embedder.local === false ? " (remote)" : ""}${s.embedder.dims ? `, ${s.embedder.dims} dims` : ""}${s.embedder.state === "failing" ? ` · failing: ${s.embedder.error}` : ""}`
    : "none (searching by words; hire one: galahad roster set embedder ollama/qwen3-embedding:0.6b)";
  console.log(`  ${s.chunks} passages, ${s.embedded} embedded, ${s.backlog} waiting · embedder ${embedder}`);
  const u = s.understanding;
  console.log(`  summaries: ${u.usedToday} of ${u.perDay} today${u.localOnly ? " (local model only, until you set a budget)" : ""}, ${u.backlog} waiting${u.lastError ? dim(` · ${u.lastError}`) : ""}`);
  const i = s.integrity;
  console.log(`  integrity: ${i.lastAt === null ? "not checked yet" : `${i.ok ? "✓" : "✗"} ${i.checked} file(s) re-hashed ${new Date(i.lastAt).toLocaleString()}`}`);
  for (const p of i.problems.slice(0, 5)) console.log(`      ${p}`);
  console.log(`  disk: ${size(s.disk.blobBytes)} in ${s.disk.blobs} file(s) (${s.disk.backend}: ${s.disk.root}), index ${size(s.disk.indexBytes)}`);
  console.log(`  sources:`);
  for (const src of s.sources) {
    const state = src.waiting ? dim("not hooked up on this node yet") : src.lastError ? `✗ ${src.lastError}` : src.lastRun ? `${src.pulled} pulled, last ${new Date(src.lastRun).toLocaleString()}` : dim("not yet");
    console.log(`    ${src.name.padEnd(15)} ${state}`);
  }
}

function printEntry(e: ArchiveEntryView): void {
  console.log(`${bold(e.title)}`);
  console.log(dim(`  ${e.id} · ${e.kind} · ${TRUST[e.trust] ?? e.trust} · from ${e.source} · made ${new Date(e.createdAt).toLocaleString()} · ${e.chunks} passage(s), ${e.embedded} embedded`));
  if (e.tags.length) console.log(dim(`  #${e.tags.join(" #")}`));
  const u = e.understanding;
  if (u) {
    console.log(`\n  ${u.summary} ${dim(`(${u.model})`)}`);
    for (const f of u.facts) console.log(`  · ${f}`);
    if (u.lessons) {
      for (const [title, items] of [["worked", u.lessons.worked], ["failed", u.lessons.failed], ["next", u.lessons.next]] as const) for (const item of items) console.log(`  ${title.padEnd(7)} ${item}`);
    }
  }
  console.log(`\n${e.description.length > 4000 ? `${e.description.slice(0, 4000)}\n${dim(`… ${e.description.length - 4000} more characters`)}` : e.description}`);
  if (e.files.length) {
    console.log(`\n  files:`);
    for (const f of e.files) console.log(`    ${f.path.padEnd(48)} ${size(f.size).padStart(9)}  ${dim(f.sha256.slice(0, 12))}`);
  }
  if (e.links.length) {
    console.log(`\n  linked:`);
    for (const l of e.links) console.log(`    ${l.rel.padEnd(13)} ${l.id}  ${l.title}${l.score !== null ? dim(` ${l.score.toFixed(2)}`) : ""}`);
  }
  for (const r of e.redactions) console.log(dim(`  redacted a ${r.kind} in ${r.where}`));
  for (const r of e.refused) console.log(dim(`  not kept: ${r.path} (${r.why})`));
}

export async function archiveCommand(api: ArchiveApi, sub: string | undefined, rest: string[], flags: Flags, io: { confirm(question: string): boolean; readStdin(): Promise<string> }): Promise<void> {
  switch (sub) {
    case undefined:
    case "status": {
      printStatus(await api.call<ArchiveStatusView>("archiveStatus"));
      console.log(dim("\n  galahad archive search <words> · show <id> · idea \"<title>\" · reindex · verify · budget <n>"));
      return;
    }
    case "search": {
      const q = rest.join(" ");
      const view = await api.call<ArchiveSearchView>("archiveSearch", {
        q,
        ...(csv(flags, "kind") ? { kinds: csv(flags, "kind") } : {}),
        ...(csv(flags, "trust") ? { trust: csv(flags, "trust") } : {}),
        ...(csv(flags, "source") ? { sources: csv(flags, "source") } : {}),
        ...(str(flags, "since") ? { since: parseWhen(str(flags, "since")!) } : {}),
        ...(str(flags, "until") ? { until: parseWhen(str(flags, "until")!, Date.now(), true) } : {}),
        limit: Number(str(flags, "limit") ?? 10),
      });
      if (!view.hits.length) {
        console.log(q ? `Nothing in the archive about "${q}".` : "The archive is empty.");
        return;
      }
      const how = view.mode === "hybrid" ? `words and meaning (${view.embedder})` : view.mode === "text" ? "words only" : "newest first";
      console.log(dim(`${view.hits.length} result(s) · ${how} · ${view.tookMs} ms`));
      for (const h of view.hits) {
        const found = h.matched.length ? dim(` · ${h.matched.join("+")}${h.similarity !== null ? ` ${h.similarity.toFixed(2)}` : ""}`) : "";
        console.log(`\n  ${bold(h.title)}  ${dim(`${h.kind} · ${TRUST[h.trust] ?? h.trust} · ${day(h.createdAt)}`)}${found}`);
        console.log(`  ${dim(h.id)}${h.from !== "description" ? dim(` · ${h.from}`) : ""}`);
        console.log(`    ${h.summary ?? h.snippet}`);
      }
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("usage: galahad archive show <id> [file]");
      if (rest[1]) {
        // One file to stdout, as it is (checked against its SHA-256 by the node before it's sent).
        const { bytes } = await api.bytes("archiveFile", { id, path: rest[1] });
        process.stdout.write(bytes);
        return;
      }
      const { entry } = await api.call<{ entry: ArchiveEntryView }>("archiveEntry", { id });
      printEntry(entry);
      return;
    }
    case "idea": {
      const title = rest.join(" ").trim();
      if (!title) throw new Error('usage: galahad archive idea "<title>" [--text "…"] [--tag t] (or the text on stdin)');
      const text = str(flags, "text") ?? (process.stdin.isTTY ? "" : (await io.readStdin()).trim());
      const tags = (Array.isArray(flags.tag) ? flags.tag : flags.tag ? [flags.tag] : []).filter((t): t is string => typeof t === "string");
      const noted = await api.call<{ id: string; created: boolean; node: string }>("noteIdea", { title, text: text || title, ...(tags.length ? { tags } : {}) });
      console.log(noted.created ? `Kept for good, as ${noted.id}, in the archive on ${noted.node}.` : `Already noted: ${noted.id}.`);
      return;
    }
    case "rm":
    case "delete": {
      const id = rest[0];
      const reason = str(flags, "reason");
      if (!id || !reason) throw new Error('usage: galahad archive rm <id> --reason "why" (the archive keeps a tombstone, so it never comes back)');
      const { entry } = await api.call<{ entry: ArchiveEntryView }>("archiveEntry", { id });
      if (!flags.yes && !io.confirm(`Delete "${entry.title}" (${entry.kind}, ${entry.files.length} file(s)) from the archive for good?`)) {
        console.log("Kept.");
        return;
      }
      const result = await api.call<{ deleted: string[]; blobs: number }>("deleteArchived", { id, reason });
      console.log(`Deleted${result.deleted.length > 1 ? `, with ${result.deleted.length - 1} lesson(s) drawn from it` : ""}; ${result.blobs} file(s) no other entry held are gone. A tombstone keeps it from being archived again.`);
      return;
    }
    case "reindex": {
      const r = await api.call<{ backlog: number; understanding: number }>("reindexArchive", { embeddings: true, ...(flags.summaries ? { understanding: true } : {}) });
      console.log(`Embedding ${r.backlog} passage(s) again in the background${flags.summaries ? `, and summarising ${r.understanding} entries within the daily budget` : ""}. \`galahad archive\` shows how far it is.`);
      return;
    }
    case "verify": {
      const r = await api.call<{ checked: number; problems: string[] }>("verifyArchive", {});
      if (!r.problems.length) console.log(`✓ ${r.checked} file(s) re-hashed: every one matches its SHA-256.`);
      else {
        console.log(`✗ ${r.problems.length} problem(s) in ${r.checked} file(s) (nothing was deleted; it's in your inbox too):`);
        for (const p of r.problems) console.log(`  ${p}`);
      }
      return;
    }
    case "budget": {
      if (rest[0] === undefined) {
        const { understanding: u } = await api.call<ArchiveStatusView>("archiveStatus");
        console.log(`${u.perDay} summaries a day (${u.usedToday} used today)${u.localOnly ? "; a local swift model only, until you set a budget" : ""}.`);
        return;
      }
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 0) throw new Error("usage: galahad archive budget <summaries per day, 0 to stop>");
      await api.call("setArchiveBudget", { summariesPerDay: n });
      console.log(n ? `Up to ${n} summaries a day, by the swift role's models in order (a cloud model among them gets the entries' text).` : "No more summaries until you set a budget again.");
      return;
    }
    default:
      throw new Error(`unknown archive command "${sub}" (status, search, show, idea, rm, reindex, verify, budget)`);
  }
}
