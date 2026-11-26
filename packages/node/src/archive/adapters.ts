import { archiveId, type ConversationSummary, isTrialQuest, Preregistration, type StoredMessage, type StoredStep, TRIAL_ARCHIVE_KIND, type TrialRecord, type Trust } from "@galahad/core";
import type { MindStore } from "@galahad/mind";
import type { ArtifactStore } from "../artifacts.ts";
import { asText, extOf, mightBeModel, modelFacts, transcript } from "./chunk.ts";
import type { IncomingEntry, IncomingFile } from "./store.ts";
import { skillAuthor, skillInWords, versionUsable } from "@galahad/core";
import { skillVersions } from "../skills.ts";

/*
 * What goes into the archive, each source through an adapter that pulls by a cursor:
 * records after it, oldest first, a bounded batch at a time. The store's idempotence
 * (an entry's id is the hash of its source and source id) makes a pull safe to repeat,
 * so a node that was down catches up from its cursor, and a sweep from the start finds
 * what arrived late (a memory synced from a node that was offline).
 *
 * Adapters read only through public APIs: the mind's (recall, lww), the chat store's,
 * the artifact store's.
 */

export interface Pull {
  entries: IncomingEntry[];
  /** Where the next pull starts. */
  cursor: string | null;
  /** More are waiting right now (pull again soon). */
  more: boolean;
}

export interface ArchiveAdapter {
  readonly name: string;
  /** Not connected on this node yet (its source hasn't been hooked up). */
  readonly waiting?: boolean;
  pull(cursor: string | null, limit: number): Promise<Pull>;
  /** Sweep from the start this often (late arrivals a cursor can't see); idempotence makes it cheap. */
  readonly sweepEveryMs?: number;
}

/** What adapters may ask the archive itself. */
export interface ArchiveLookup {
  has(source: string, sourceId: string): boolean;
  /** Source ids beginning with a prefix (a chat's archived segments). */
  sourceIds(source: string, prefix: string): string[];
}

const DAY = 86_400_000;
const hlcMs = (hlc: string): number => Number(hlc.slice(0, 15));
/** "a:b" cursors compare as strings of fixed width. */
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(15, "0");
const firstLine = (text: string, max = 90) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line || "(empty)";
};

/** Records sorted by a key, after a cursor, a batch at a time: the shape every list-backed source shares. */
function after<T>(items: { key: string; item: T }[], cursor: string | null, limit: number): { batch: { key: string; item: T }[]; more: boolean } {
  const sorted = items.filter((i) => cursor === null || i.key > cursor).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { batch: sorted.slice(0, limit), more: sorted.length > limit };
}

// ---- Teachings: memories, investigations, trials --------------------------------------

/**
 * Memories, through recall: everything Galahad was told to remember and remembered on
 * his own, with its trust (your own words are `owner`). Newest first from the mind, so
 * the adapter reads back until it reaches its cursor; a daily sweep finds a memory that
 * synced in late with an older clock.
 */
export function memoriesAdapter(mind: Pick<MindStore, "recall">): ArchiveAdapter {
  return {
    name: "memories",
    sweepEveryMs: DAY,
    async pull(cursor, limit) {
      let n = 500;
      let memories = mind.recall(undefined, n);
      // Read further back until the cursor is reached (or the mind has no more).
      while (memories.length === n && (cursor === null || memories.at(-1)!.hlc > cursor) && n < 1_000_000) {
        n *= 4;
        memories = mind.recall(undefined, n);
      }
      const { batch, more } = after(
        memories.map((m) => ({ key: m.hlc, item: m })),
        cursor,
        limit,
      );
      return {
        entries: batch.map(({ item: m }) => ({
          kind: "teaching",
          source: "memories",
          sourceId: m.id,
          title: firstLine(m.text),
          description: m.text,
          trust: (["owner", "agent", "untrusted"].includes(m.trust) ? m.trust : "untrusted") as Trust,
          createdAt: hlcMs(m.hlc),
          tags: m.tags,
          // The memory's id is the source id (an event id is hash-shaped: kept out of scanned text).
          meta: m.via ? { via: m.via } : {},
        })),
        cursor: batch.at(-1)?.key ?? cursor,
        more,
      };
    },
  };
}

/**
 * Investigations, once concluded: the question, what was registered before anything
 * ran, and what was found. Model output shaped by what a sandbox computed, so it's
 * `untrusted`, as the mind already remembers it. Linked to its evidence.
 */
export function investigationsAdapter(mind: Pick<MindStore, "lwwPrefix" | "lww">): ArchiveAdapter {
  return {
    name: "investigations",
    sweepEveryMs: DAY,
    async pull(cursor, limit) {
      const concluded = mind
        .lwwPrefix<{ id: string; question: string; registration: unknown }>("investigation:")
        .flatMap((entry) => {
          const body = entry.value;
          if (!body) return [];
          const result = mind.lww<{ status: string; conclusion?: string; summary: string; review?: string; artifact?: string; predictions?: { id: string; verdict: string; value?: number | null; units?: string }[] }>(`investigation-result:${body.id}`);
          if (!result?.value) return [];
          return [{ key: `${result.hlc}:${body.id}`, item: { body, result: result.value, at: hlcMs(result.hlc) } }];
        });
      const { batch, more } = after(concluded, cursor, limit);
      return {
        entries: batch.map(({ item: { body, result, at } }) => {
          const reg = Preregistration.safeParse(body.registration);
          const outcomes = new Map((result.predictions ?? []).map((p) => [p.id, p]));
          const lines = [
            `Question: ${body.question}`,
            reg.success ? `Hypothesis: ${reg.data.hypothesis}\nAlternative: ${reg.data.alternative}` : null,
            reg.success
              ? `Predictions:\n${reg.data.predictions.map((p) => `- ${p.id}: ${p.statement} (expected ${p.expected}; refuted if ${p.refutedIf})${outcomes.get(p.id) ? ` → ${outcomes.get(p.id)!.verdict}${outcomes.get(p.id)!.value != null ? ` (${outcomes.get(p.id)!.value}${outcomes.get(p.id)!.units ? ` ${outcomes.get(p.id)!.units}` : ""})` : ""}` : ""}`).join("\n")}`
              : null,
            reg.success ? `Method: ${reg.data.method}` : null,
            `Outcome: ${result.status}${result.conclusion ? `, ${result.conclusion}` : ""}`,
            `What was found: ${result.summary}`,
            result.review ? `The reviewer, on the method: ${result.review}` : null,
          ];
          return {
            kind: "teaching",
            source: "investigations",
            sourceId: body.id,
            title: `Investigation: ${firstLine(body.question, 120)}`,
            description: lines.filter(Boolean).join("\n\n"),
            trust: "untrusted" as const,
            createdAt: at,
            tags: ["investigation", result.conclusion ?? result.status],
            meta: { investigation: body.id, status: result.status, ...(result.conclusion ? { conclusion: result.conclusion } : {}), ...(result.artifact ? { artifact: result.artifact } : {}) },
            links: result.artifact ? [{ rel: "evidence", to: archiveId("artifacts", result.artifact) }] : [],
          };
        }),
        cursor: batch.at(-1)?.key ?? cursor,
        more,
      };
    },
  };
}

/**
 * Trials: graded by a program against the exact answer, so the record itself is Galahad's (agent). Kept as kind
 * `trial`, which is never offered to a model as context: a record holds the answers of its seed and the names of
 * its hidden checks.
 */
export function trialsAdapter(mind: Pick<MindStore, "lwwPrefix">): ArchiveAdapter {
  return {
    name: "trials",
    sweepEveryMs: DAY,
    async pull(cursor, limit) {
      const trials = mind.lwwPrefix<TrialRecord & { id: string }>("trial:").flatMap((e) => (e.value ? [{ key: `${e.hlc}:${e.value.id}`, item: { t: e.value, at: hlcMs(e.hlc) } }] : []));
      const { batch, more } = after(trials, cursor, limit);
      return {
        entries: batch.map(({ item: { t, at } }) => ({
          kind: TRIAL_ARCHIVE_KIND,
          source: "trials",
          sourceId: t.id,
          title: `Trial: ${t.title} (${Math.round(t.score * 100)} %)`,
          description: [
            `${t.title} (${t.suite}/${t.problem}, ${t.domain}), seed ${t.seed}: ${t.status}, score ${t.score.toFixed(2)}.`,
            t.answers.map((a) => `- ${a.key}: got ${a.got ?? "nothing"} ${a.units}, exact ${a.expected} ± ${a.tolerance} → ${a.ok ? "within tolerance" : "off"}`).join("\n"),
            t.quest ? `Quest: ${t.quest.status} after ${t.quest.steps} steps and ${t.quest.revisions} revisions.` : null,
            t.models.length ? `Models: ${t.models.join(", ")}.` : null,
            t.note ? `Note: ${t.note}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          trust: "agent" as const,
          createdAt: at,
          tags: ["trial", t.domain, t.problem],
          meta: { trial: t.id, run: t.run, score: t.score, version: t.version, ...(t.artifact ? { artifact: t.artifact } : {}) },
          links: t.artifact ? [{ rel: "evidence", to: archiveId("artifacts", t.artifact) }] : [],
        })),
        cursor: batch.at(-1)?.key ?? cursor,
        more,
      };
    },
  };
}

// ---- Models and artifacts --------------------------------------------------------

/** Read enough of a model file to say what it is (a mesh's header, a URDF's links); never more than this. */
const FACTS_BYTES = 64 * 2 ** 20;

/**
 * Kept work: every artifact this node holds is copied in (its files streamed, by
 * SHA-256), and each model file in it (CAD, meshes, robots, notebooks, scripts that
 * build models) becomes a `model` entry of its own, part of the artifact. Galahad's own
 * quests and investigations are `agent`; an outside agent's sandbox work is `untrusted`.
 */
export function artifactsAdapter(artifacts: Pick<ArtifactStore, "list" | "filesOf" | "locate" | "read">, kept: (artifact: { id: string; label: string; sandbox?: string | null }) => boolean = () => true): ArchiveAdapter {
  return {
    name: "artifacts",
    sweepEveryMs: DAY,
    async pull(cursor, limit) {
      // (`kept`: what the archive may hold. A knight's work in sensitive mode it never does: daemon.ts.)
      const here = artifacts.list().filter((a) => a.here && kept(a));
      const { batch, more } = after(
        here.map((a) => ({ key: `${pad(a.savedAt)}:${a.id}`, item: a })),
        cursor,
        Math.max(1, Math.floor(limit / 4)),
      );
      const entries: IncomingEntry[] = [];
      for (const { item: a } of batch) {
        const files = artifacts.filesOf(a.id) ?? a.files;
        const trust: Trust = /^(q-|inv-|t-)/.test(a.quest ?? "") ? "agent" : "untrusted";
        // What a trial kept (its answers, its scripts, its report) is a trial's, whatever it is made of: never context for a model.
        const ofTrial = isTrialQuest(a.quest);
        const id = archiveId("artifacts", a.id);
        const incoming: IncomingFile[] = [];
        for (const f of files) {
          try {
            incoming.push({ path: f.path, fromPath: artifacts.locate(a.id, f.path) });
          } catch {
            /* listed but gone: the integrity of kept work is the artifact store's to report */
          }
        }
        entries.push({
          kind: ofTrial ? TRIAL_ARCHIVE_KIND : "artifact",
          source: "artifacts",
          sourceId: a.id,
          title: a.label,
          description: [
            `Work kept from sandbox ${a.sandbox ?? "?"}${a.quest ? ` (quest ${a.quest})` : ""} on ${a.nodeName}: ${a.count} file(s), ${a.bytes} bytes.`,
            `Files:\n${files.slice(0, 200).map((f) => `- ${f.path} (${f.size} bytes)`).join("\n")}${files.length > 200 ? `\n… ${files.length - 200} more` : ""}`,
          ].join("\n\n"),
          trust,
          createdAt: a.savedAt,
          tags: ["artifact", ...(a.quest ? [a.quest.replace(/[^\p{L}\p{N} ._:/-]/gu, "-")] : [])],
          meta: { artifact: a.id, quest: a.quest, sandbox: a.sandbox, bytes: a.bytes, count: a.count },
          files: incoming,
        });
        for (const f of files) {
          if (!mightBeModel(f.path)) continue;
          let bytes: Uint8Array;
          try {
            bytes = f.size <= FACTS_BYTES ? artifacts.read(a.id, f.path).bytes : new Uint8Array();
          } catch {
            continue;
          }
          const text = bytes.length ? asText(bytes) : null;
          const facts = modelFacts(f.path, bytes, text);
          if (!facts) continue;
          const name = f.path.split("/").at(-1)!;
          entries.push({
            kind: ofTrial ? TRIAL_ARCHIVE_KIND : "model",
            source: "artifacts",
            sourceId: `${a.id}/${f.path}`,
            title: `${name} (${facts.format})`,
            description: [`${name}: ${facts.facts.join("; ")}.`, `Part of "${a.label}" (${a.id}), at ${f.path}.`].join("\n"),
            trust,
            createdAt: a.savedAt,
            tags: ["model", facts.format.split(" ")[0]!.toLowerCase(), extOf(f.path).slice(1)].filter(Boolean),
            meta: { artifact: a.id, path: f.path, format: facts.format, facts: facts.facts },
            files: [{ path: f.path, fromPath: artifacts.locate(a.id, f.path) }],
            links: [{ rel: "part-of", to: id }],
          });
        }
      }
      return { entries, cursor: batch.at(-1)?.key ?? cursor, more };
    },
  };
}

// ---- Chats -------------------------------------------------------------------------

/** Tools whose results are strangers' words: an answer that used one carries them. */
const OUTSIDE_TOOLS = new Set(["web_search", "connector_tool", "connector_call", "sandbox_run", "sandbox_exec", "artifact_read", "archive_read", "archive_search", "recall", "decide"]);
/** The bank's tools: a chat that called one is never archived (it's flagged, too; this is the second lock). */
const BANK_TOOL = /^bank_/;

export interface ChatSource {
  list(): ConversationSummary[];
  get(id: string): (ConversationSummary & { messages: StoredMessage[] }) | null;
}

/**
 * Kept chats, once they've been quiet a while (an hour by default): each becomes an
 * entry, and if it goes on later, the new part becomes another, linked to the first.
 * A chat where Galahad read the bank is never archived, not any part of it from then
 * on (what was archived before he read it held no bank data).
 */
export function chatsAdapter(chats: ChatSource, archive: ArchiveLookup, opts: { quietMs?: number; now?: () => number } = {}): ArchiveAdapter {
  const quiet = opts.quietMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now;
  return {
    name: "chats",
    async pull(cursor, limit) {
      const settledBefore = now() - quiet;
      const candidates = chats
        .list()
        .filter((c) => !c.bank && c.updatedAt <= settledBefore)
        .map((c) => ({ key: `${pad(c.updatedAt)}:${c.id}`, item: c }));
      const { batch, more } = after(candidates, cursor, limit);
      const entries: IncomingEntry[] = [];
      for (const { item: summary } of batch) {
        const chat = chats.get(summary.id);
        if (!chat || chat.bank) continue;
        if (chat.messages.some((m) => m.steps.some((s) => s.kind === "tool" && BANK_TOOL.test(s.name)))) continue;
        const archived = archive.sourceIds("chats", `${chat.id}:`);
        const last = archived.map((s) => Number(s.split(":")[1])).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? 0;
        const fresh = chat.messages.filter((m) => m.id > last && m.content.trim() && m.status !== "streaming");
        // A segment starts with your question: an answer alone waits for its next turn.
        if (!fresh.some((m) => m.role === "user") || fresh.at(-1)!.role !== "assistant") continue;
        const steps = fresh.flatMap((m) => m.steps as StoredStep[]);
        const outside = steps.some((s) => (s.kind === "tool" && OUTSIDE_TOOLS.has(s.name)) || (s.kind === "archive" && s.entries.some((e) => e.trust === "untrusted")));
        const end = fresh.at(-1)!.id;
        const previous = archived.length ? archiveId("chats", archived.sort((a, b) => Number(b.split(":")[1]) - Number(a.split(":")[1]))[0]!) : null;
        entries.push({
          kind: "chat",
          source: "chats",
          sourceId: `${chat.id}:${end}`,
          title: previous ? `${chat.title} (continued)` : chat.title,
          description: transcript(fresh.map((m) => ({ role: m.role, content: m.content }))),
          // Galahad's record of a conversation; strangers' words in it when his tools read the outside.
          trust: outside ? "untrusted" : "agent",
          createdAt: fresh[0]!.createdAt,
          tags: ["chat", ...(chat.project ? [`project:${chat.project}`] : [])],
          meta: { conversation: chat.id, project: chat.project, role: chat.role, messages: fresh.length, models: [...new Set(fresh.flatMap((m) => (m.model ? [m.model] : [])))] },
          links: previous ? [{ rel: "continues", to: previous }] : [],
        });
      }
      return { entries, cursor: batch.at(-1)?.key ?? cursor, more };
    },
  };
}

// ---- Skills: how he did a kind of work, as the mind keeps them ---------------------------

/**
 * His skills (skills.ts), a version at a time, once a version is his to use: trusted as written (yours, or
 * his own from an isolated quest that passed review), or untrusted and approved by you. A version that waits
 * for you isn't archived: the archive is searched by models. Each as its words in plain text, with who wrote
 * it and from which quest; a later version is an entry of its own. The archive's own context never offers
 * them (he is given skills through their own fence, by where each stands now); a search finds them as records.
 */
export function skillsAdapter(mind: Pick<MindStore, "skills">): ArchiveAdapter {
  return {
    name: "skills",
    sweepEveryMs: DAY,
    async pull(cursor, limit) {
      const usable = mind.skills().flatMap((record) =>
        skillVersions(record).flatMap((v) => {
          if (!v.doc || !versionUsable(v)) return [];
          // Ordered by when it became his to use: your approval, for an untrusted one.
          return [{ key: `${pad(v.approvedAt ?? v.at)}:${v.id}`, item: { record, v, doc: v.doc } }];
        }),
      );
      const { batch, more } = after(usable, cursor, limit);
      return {
        entries: batch.map(({ item: { record, v, doc } }) => ({
          kind: "skill",
          source: "skills",
          sourceId: v.id,
          title: doc.title,
          description: [
            skillInWords(doc),
            `Written by ${skillAuthor(v.by)}${v.quest ? ` from quest ${v.quest}` : ""} (version ${v.n} of ${record.id})${v.trust === "untrusted" ? "; shaped by what was read from outside, and approved by you" : ""}.`,
          ].join("\n\n"),
          trust: v.trust,
          createdAt: v.at,
          tags: ["skill", ...(v.quest ? [v.quest] : [])],
          meta: { skill: record.id, version: v.n, by: v.by },
        })),
        cursor: batch.at(-1)?.key ?? cursor,
        more,
      };
    },
  };
}
