import {
  ABOUT_YOU_TAG,
  AgentInput,
  AttachmentRef,
  Bodies,
  canonical,
  ConnectorManifest,
  ConversationId,
  findSecrets,
  type Json,
  type NodeIdentity,
  redact,
  type StoredStep,
  sha256Bytes,
  TEAM_OWNER,
  TEAM_PRIMARY,
  utf8,
} from "@invincible/core";
import type { LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG, planOf } from "@invincible/models";
import { z } from "zod";
import { APPLE_PUSH_SECRET } from "../apns-send.ts";
import type { AdoptedMessage, ChatStore } from "../chats.ts";
import { SLACK_APP_SECRET, SLACK_BOT_SECRET, SLACK_DEVICE_SECRET } from "../slack.ts";
import type { TeamStore } from "../team-store.ts";
import { TELEGRAM_DEVICE_SECRET, TELEGRAM_TOKEN_SECRET } from "../telegram.ts";
import type { Uploads } from "../uploads.ts";
import { hookSecretName } from "../wakes.ts";
import type { GalahadHome, OldMessage } from "./source.ts";
import { memoryKey, type TargetView } from "./target.ts";

/*
 * What comes across, kind by kind, measured against what this node holds already. Something it holds by the same name
 * is never written over, and something removed here is never brought back: so a second run brings nothing, and what you
 * changed here after the first stays as you left it. Nothing here holds a value where it could be shown: a secret's
 * is opened into the closure that writes it, and nowhere else.
 */

export const KINDS = ["secrets", "providers", "roster", "thinking", "prices", "about-you", "memory", "projects", "connectors", "agents", "chats"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * bring: it comes (a dry run's word); brought: it came; here: this node holds it already, the same; differs: this node
 * holds another by that name, kept; removed: it was removed here, and stays so; skip: it can't come, and `note` says why.
 */
export type State = "bring" | "brought" | "here" | "differs" | "removed" | "skip";

export interface Item {
  kind: Kind;
  /** What it is called: a name, an id, a role, a model. Never a value. */
  name: string;
  state: State;
  /** Why it is skipped, or what to know of it (a coding plan; a key that isn't coming). Never a value. */
  note?: string;
  /** A fact about you: kept (yours), or proposed (an agent's, which waits for you to keep it). */
  whose?: "kept" | "proposed";
  /** Writes it here (state bring); what it says, if anything, is added to its note. */
  write?: (into: Into) => string | void;
}

/** This node's stores, opened to be written: the node itself stopped. */
export interface Into {
  store: LedgerStore;
  identity: NodeIdentity;
  vault: Vault;
  team: () => TeamStore;
  chats: () => ChatStore;
  uploads: () => Uploads;
}

export type ChatChoice = "none" | "all" | string[];

export interface Plan {
  items: Item[];
  /** What stays behind, a line each. */
  behind: string[];
  /** The chats there, newest first, when none were asked for: what --chats chooses from. */
  chats: { id: string; title: string; count: number; bank: boolean }[] | null;
}

/** The names of what Invincible would act on as Galahad's chat apps (their bots and their gateways' device keys). */
const CHAT_APPS = new Set([TELEGRAM_TOKEN_SECRET, TELEGRAM_DEVICE_SECRET, SLACK_APP_SECRET, SLACK_BOT_SECRET, SLACK_DEVICE_SECRET]);
const LOOP_HOOK = hookSecretName("");

/** Who wrote a knight's job, as an agent's record here says it: Galahad himself is the primary now. */
const author = (by: string | undefined): string => (by === undefined || by === TEAM_OWNER ? TEAM_OWNER : by === "galahad" ? TEAM_PRIMARY : by);

/** An agent's label's tag, as core's teamArmLabel makes it from the node that runs it. */
const armTag = (node: string): string => [...sha256Bytes(utf8(node)).slice(0, 5)].map((b) => b.toString(16).padStart(2, "0")).join("");

const looksLikeKey = (texts: string[], isPublic?: (token: string) => boolean): boolean => findSecrets(texts.join("\n"), isPublic ? { isPublic } : {}).length > 0;

/** A chat's title as said here: anything like a key taken out, clipped. */
export const titleOf = (title: string): string => {
  const said = redact(title).replace(/\s+/g, " ").trim();
  return said.length > 60 ? `${said.slice(0, 59)}…` : said;
};

export function makePlan(source: GalahadHome, target: TargetView, opts: { node: string; chats: ChatChoice }): Plan {
  const items: Item[] = [];
  const behind: string[] = ["its identity, devices and fleet: your devices pair with this node anew"];
  const skip = (kind: Kind, name: string, note: string) => items.push({ kind, name, state: "skip", note });

  /** Bring `value` under `key` unless this node holds something there: the same (here), another (differs), or a removal. */
  const against = (key: string, value: unknown): State => {
    const held = target.lww(key);
    if (held === undefined) return "bring";
    if (held === null) return "removed";
    try {
      return canonical(JSON.parse(held) as Json) === canonical(value as Json) ? "here" : "differs";
    } catch {
      return "differs";
    }
  };

  // ---- the vault's secrets ----
  const lockedHere = target.vaultLocked(opts.node);
  let chatApps = 0;
  let pushKeys = 0;
  let hooks = 0;
  for (const row of source.secrets()) {
    if ("problem" in row) {
      skip("secrets", row.name, row.problem);
      continue;
    }
    const record = row.value;
    if (CHAT_APPS.has(record.name)) chatApps++;
    else if (record.name === APPLE_PUSH_SECRET) pushKeys++;
    else if (record.name.startsWith(LOOP_HOOK)) hooks++;
    else {
      const held = target.lww(`secret:${record.name}`);
      if (held !== undefined) {
        // Here already, or removed here: never opened. Whether it is the same is told by what it was sealed with and
        // its hint (its value's last four), never by opening this node's.
        const said = (m: { provider?: string; label?: string; origin?: string; hint?: string }) => canonical({ provider: m.provider ?? null, label: m.label ?? null, origin: m.origin ?? null, hint: m.hint ?? null });
        let state: State = "removed";
        if (held !== null) {
          try {
            state = said((JSON.parse(held) as { meta: { provider?: string; label?: string; origin?: string; hint?: string } }).meta) === said(record.meta) ? "here" : "differs";
          } catch {
            state = "differs";
          }
        }
        items.push({ kind: "secrets", name: record.name, state });
        continue;
      }
      if (lockedHere) {
        skip("secrets", record.name, lockedHere);
        continue;
      }
      const opened = source.open(record);
      if ("problem" in opened) {
        skip("secrets", record.name, opened.problem);
        continue;
      }
      const meta = { ...(record.meta.provider ? { provider: record.meta.provider } : {}), ...(record.meta.label ? { label: record.meta.label } : {}), ...(record.meta.origin ? { origin: record.meta.origin } : {}) };
      const value = opened.value;
      items.push({ kind: "secrets", name: record.name, state: "bring", write: (into: Into) => void into.vault.set(record.name, value, meta) });
    }
  }
  if (chatApps) behind.push(`${chatApps} key${chatApps === 1 ? "" : "s"} of its chat apps (Telegram, Slack): a bot answers one node at a time, and each gateway's device key is its fleet's; connect them here at the cutover`);
  if (pushKeys) behind.push("its Apple push key: it pushes to its own app; set the key for this node's app when you pair it");
  if (hooks) behind.push(`${hooks} webhook key${hooks === 1 ? "" : "s"} of its loops, which stay behind`);
  /** The keys this node will hold once the import is done: what a provider, a connector or an agent names should be among them. */
  const keysHere = new Set(items.filter((i) => i.kind === "secrets" && i.state !== "skip" && i.state !== "removed").map((i) => i.name));
  const keyHere = (name: string) => keysHere.has(name) || !!target.lww(`secret:${name}`);

  // ---- providers (and the coding plans among them), the roster, how hard each role thinks, prices ----
  for (const row of source.providers()) {
    if ("problem" in row) {
      skip("providers", row.name, row.problem);
      continue;
    }
    const provider = row.value;
    if (looksLikeKey([provider.baseUrl, provider.label ?? ""])) {
      skip("providers", provider.id, "its address or label looks like it holds a key");
      continue;
    }
    const notes = [planOf(provider.id) ? "a coding plan" : null, provider.secret && !keyHere(provider.secret) ? "its key isn't coming" : null].filter(Boolean);
    const state = against(`provider:${provider.id}`, provider);
    items.push({ kind: "providers", name: provider.id, state, ...(notes.length ? { note: notes.join("; ") } : {}), ...(state === "bring" ? { write: (into: Into) => void into.store.emit(into.identity, "provider.set", provider) } : {}) });
  }
  for (const row of source.roster()) {
    if ("problem" in row) {
      skip("roster", row.name, row.problem);
      continue;
    }
    const { role, models } = row.value;
    const state = against(`roster:${role}`, models);
    items.push({ kind: "roster", name: role, state, ...(state === "bring" ? { write: (into: Into) => void into.store.emit(into.identity, "roster.set", { role, models }) } : {}) });
  }
  for (const row of source.efforts()) {
    if ("problem" in row) {
      skip("thinking", row.name, row.problem);
      continue;
    }
    const { role, effort } = row.value;
    const state = against(`effort:${role}`, effort);
    items.push({ kind: "thinking", name: `${role} (${effort})`, state, ...(state === "bring" ? { write: (into: Into) => void into.store.emit(into.identity, "roster.effort", { role, effort }) } : {}) });
  }
  for (const row of source.prices()) {
    if ("problem" in row) {
      skip("prices", row.name, row.problem);
      continue;
    }
    const { model, price } = row.value;
    const state = against(`price:${model}`, price);
    items.push({ kind: "prices", name: model, state, ...(state === "bring" ? { write: (into: Into) => void into.store.emit(into.identity, "price.set", { model, price }) } : {}) });
  }

  // ---- what it learned about you, and its notes ----
  const held = target.memories();
  const forgotten = { "about-you": 0, memory: 0 };
  for (const row of source.memories()) {
    if ("problem" in row) {
      skip("memory", row.name, row.problem);
      continue;
    }
    const memory = row.value;
    const kind = memory.tags.includes(ABOUT_YOU_TAG) ? "about-you" : "memory";
    if (memory.forgotten) {
      forgotten[kind]++;
      continue;
    }
    const whose = kind === "about-you" ? { whose: memory.trust === "owner" ? ("kept" as const) : ("proposed" as const) } : {};
    const body = Bodies["memory.added"].safeParse({ text: memory.text, ...(memory.tags.length ? { tags: memory.tags } : {}) });
    if (!body.success) {
      skip(kind, memory.id, "it doesn't read as a memory here");
      continue;
    }
    if (looksLikeKey([memory.text, ...memory.tags], source.isEvent)) {
      skip(kind, memory.id, "it looks like it holds a key");
      continue;
    }
    const key = memoryKey(memory.text, memory.tags);
    const here = held.get(key) ?? 0;
    if (here > 0) {
      held.set(key, here - 1);
      items.push({ kind, name: memory.id, state: "here", ...whose });
      continue;
    }
    // Its trust as it was: yours stays yours, an agent's stays proposed; the device it came from isn't one of this fleet's.
    const prov = { trust: memory.trust, ...(memory.source ? { source: memory.source } : {}) };
    items.push({ kind, name: memory.id, state: "bring", ...whose, write: (into: Into) => void into.store.remember(into.identity, memory.text, { tags: memory.tags, prov }) });
  }
  const forgot = forgotten["about-you"] + forgotten.memory;
  if (forgot) behind.push(`${forgot} memor${forgot === 1 ? "y" : "ies"} you forgot there`);

  // ---- projects ----
  for (const row of source.projects()) {
    if ("problem" in row) {
      skip("projects", row.name, row.problem);
      continue;
    }
    const project = row.value;
    if (looksLikeKey([project.name, project.instructions, project.repo ?? ""])) {
      skip("projects", project.id, "its name, instructions or repository look like they hold a key");
      continue;
    }
    const state = against(`project:${project.id}`, project);
    items.push({ kind: "projects", name: project.id, state, ...(state === "bring" ? { write: (into: Into) => void into.store.emit(into.identity, "project.set", project) } : {}) });
  }

  // ---- connectors: who may use one names agents by their labels, made from the node that runs them ----
  const knights = source.knights();
  // Galahad's own label is the primary's here, as is the one of his computer; each knight's, the agent's of its handle.
  const labels = new Map<string, string>([["galahad", TEAM_PRIMARY]]);
  if (source.node) {
    labels.set(`team.${armTag(source.node)}.galahad`, `team.${armTag(opts.node)}.${TEAM_PRIMARY}`);
    for (const row of knights) labels.set(`team.${armTag(source.node)}.${row.name}`, `team.${armTag(opts.node)}.${row.name}`);
  }
  const OldAccess = z.object({ only: z.string(), allowed: z.array(z.string()) });
  for (const row of source.connectors()) {
    if ("problem" in row) {
      skip("connectors", row.name, row.problem);
      continue;
    }
    const { id, manifest: old } = row.value;
    const access = old.access === undefined ? undefined : OldAccess.safeParse(old.access);
    if (access && !access.success) {
      skip("connectors", id, "who may use it doesn't read");
      continue;
    }
    const mapped = access?.data ? { only: TEAM_PRIMARY, allowed: access.data.allowed.map((label) => labels.get(label) ?? label) } : undefined;
    // One Invincible ships (its catalog's, at the same address or one of yours) comes as it is shipped, in this
    // system's words, with what was yours kept: its address, its key's name, and who may use it.
    const shipped = Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
    const asShipped = !!shipped && typeof old.origin === "string" && (shipped.needsOrigin === true || shipped.manifest.origin === old.origin);
    const oldSecret = (old.auth as { secret?: unknown } | undefined)?.secret;
    const candidate = asShipped
      ? {
          ...shipped!.manifest,
          origin: old.origin,
          ...(shipped!.manifest.auth && typeof oldSecret === "string" ? { auth: { ...shipped!.manifest.auth, secret: oldSecret } } : {}),
          ...(mapped ? { access: mapped } : {}),
        }
      : { ...old, ...(mapped ? { access: mapped } : {}) };
    const manifest = ConnectorManifest.safeParse(candidate);
    if (!manifest.success) {
      const first = manifest.error.issues[0];
      skip("connectors", id, `it doesn't read as a connector here (${first ? `${first.path.join(".") || "manifest"}: ${first.message}` : "?"})`);
      continue;
    }
    const { auth, ...described } = manifest.data;
    // As the node checks one you add: a key pasted into a description or a header never lands in the mind.
    if (looksLikeKey([JSON.stringify({ ...described, ...(auth ? { auth: { ...auth, secret: undefined } } : {}), tools: Object.fromEntries(Object.entries(manifest.data.tools).map(([k, t]) => [k, t.description])) }), auth?.secret ?? ""])) {
      skip("connectors", id, "it looks like it holds a key");
      continue;
    }
    const notes = [asShipped ? "as Invincible ships it" : "as you made it", auth?.secret && !auth.optional && !keyHere(auth.secret) ? "its key isn't coming" : null].filter(Boolean);
    const state = against(`connector:${id}`, manifest.data);
    items.push({ kind: "connectors", name: id, state, note: notes.join("; "), ...(state === "bring" ? { write: (into: Into) => void into.store.emit(into.identity, "connector.set", { id, manifest: manifest.data as unknown as Record<string, unknown> }) } : {}) });
  }

  // ---- the knights, as agents' profiles ----
  let removedThere = 0;
  let personas = 0;
  for (const row of knights) {
    if ("problem" in row) {
      skip("agents", row.name, row.problem);
      continue;
    }
    const knight = row.value;
    if (knight.removedAt !== undefined) {
      removedThere++;
      continue;
    }
    personas++;
    const profile = AgentInput.safeParse({
      id: knight.id,
      name: knight.name,
      instructions: knight.instructions,
      role: knight.role,
      ...(knight.models?.length ? { models: knight.models } : {}),
      ...(knight.sensitive ? { sensitive: true } : {}),
      harness: knight.harness,
      ...(knight.acp ? { acp: knight.acp } : {}),
      ...(knight.keys?.length ? { keys: knight.keys } : {}),
      enabled: knight.enabled,
      dailyTurns: knight.dailyTurns,
      repository: knight.repository,
    });
    if (!profile.success) {
      const first = profile.error.issues[0];
      skip("agents", knight.id, `it doesn't read as an agent here (${first ? `${first.path.join(".") || "profile"}: ${first.message}` : "?"})`);
      continue;
    }
    if (looksLikeKey([knight.name, knight.instructions, knight.memory, knight.acp ?? "", knight.repository ?? ""])) {
      skip("agents", knight.id, "its job or its notes look like they hold a key");
      continue;
    }
    const adopted = { ...profile.data, memory: knight.memory, createdBy: author(knight.createdBy), instructionsBy: author(knight.instructionsBy), createdAt: knight.createdAt, updatedAt: knight.updatedAt };
    const missing = (knight.keys ?? []).map((k) => k.secret).filter((name) => !keyHere(name));
    const what = [profile.data.role, profile.data.harness, profile.data.sensitive ? "sensitive" : null, profile.data.repository ? profile.data.repository.replace(/^https:\/\/github\.com\//, "") : null, adopted.createdBy === TEAM_PRIMARY ? "made by your agent" : null, missing.length ? `its key${missing.length === 1 ? "" : "s"} ${missing.join(", ")} not coming` : null].filter(Boolean);
    const existing = target.agent(knight.id);
    let state: State = "bring";
    if (existing) {
      const fields = ["name", "instructions", "role", "models", "sensitive", "harness", "acp", "keys", "enabled", "dailyTurns", "repository", "memory", "instructionsBy"] as const;
      const said = (record: Record<string, unknown>) => canonical(Object.fromEntries(fields.map((f) => [f, (record[f] ?? null) as Json])) as Json);
      state = existing.removedAt !== undefined ? "removed" : said(existing) === said(adopted) ? "here" : "differs";
    }
    items.push({ kind: "agents", name: knight.id, state, note: what.join(" · "), ...(state === "bring" ? { write: (into: Into) => void into.team().adopt(adopted) } : {}) });
  }
  if (personas) behind.push("its agents' looks, temperaments and seating, their rooms, their tasks and their VMs");
  if (removedThere) behind.push(`${removedThere} agent${removedThere === 1 ? "" : "s"} you removed there`);

  // ---- chats, as you chose ----
  const listed = source.chatList();
  // All of them in the order they were begun, so their messages are numbered here as they were said.
  const asked = opts.chats === "all" ? [...listed].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map((c) => c.id) : opts.chats === "none" ? [] : opts.chats;
  const bankChats: string[] = [];
  for (const id of asked) {
    const chat = listed.find((c) => c.id === id);
    if (!chat) {
      skip("chats", id, "there is no chat by that id there");
      continue;
    }
    if (chat.bank) {
      bankChats.push(id);
      continue;
    }
    if (target.chat(id)) {
      items.push({ kind: "chats", name: id, state: "here", note: titleOf(chat.title) });
      continue;
    }
    const kept = chatOf(source, chat.id);
    if ("problem" in kept) {
      skip("chats", id, kept.problem);
      continue;
    }
    const files = kept.files;
    const absent = files.filter((f) => !f.here).length;
    const conversation = { id: chat.id, title: chat.title, project: chat.project, role: chat.role, pinned: chat.pinned, createdAt: chat.createdAt, updatedAt: chat.updatedAt, answeredAt: chat.answeredAt, seenAt: chat.seenAt };
    items.push({
      kind: "chats",
      name: id,
      state: "bring",
      note: `${titleOf(chat.title)} · ${chat.count} message${chat.count === 1 ? "" : "s"}${absent ? ` · ${absent} file${absent === 1 ? "" : "s"} no longer there` : ""}`,
      write: (into: Into) => {
        // Its files first, kept by their SHA-256 as there (the messages name them so), each read only now and checked
        // to be what its name says. One this node won't keep stays named in its message, as one gone is.
        let lost = 0;
        for (const file of files) {
          const bytes = file.here ? source.upload(file.ref.id) : null;
          if (!bytes) continue;
          try {
            into.uploads().put(file.ref.name, file.ref.type, bytes);
          } catch {
            lost++;
          }
        }
        into.chats().adopt(conversation, kept.messages, kept.story ?? undefined);
        return lost ? `${lost} file${lost === 1 ? "" : "s"} this node wouldn't keep` : undefined;
      },
    });
  }
  if (opts.chats === "none" && listed.length) behind.push(`its chats (${listed.length}) unless you ask for them: --chats all, or --chats <id>,<id>`);
  if (bankChats.length) behind.push(`${bankChats.length === 1 ? "the chat" : `${bankChats.length} chats`} that read the bank (${bankChats.join(", ")}): Invincible keeps no bank, nor the guard that showed such a chat only to the devices allowed to read the bank`);

  // ---- what else it holds, staying behind ----
  const rest = [
    [source.count("loop:"), "loop"],
    [source.count("rule:"), "rule"],
    [source.skills(), "skill"],
    [source.orders(), "standing order"],
  ] as const;
  const others = rest.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  if (others.length) behind.push(`its ${others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)}` : others[0]}: add again here what you still want`);

  return { items, behind, chats: opts.chats === "none" ? listed.map((c) => ({ id: c.id, title: titleOf(c.title), count: c.count, bank: c.bank })) : null };
}

/** A message's status as this node keeps it: one that was being written when that node stopped can't finish here. */
const Status = z.enum(["done", "error", "stopped", "steered", "streaming"]).transform((s) => (s === "streaming" ? ("stopped" as const) : s));

/** A chat's messages as this node's chat store takes them, its story's place among them, and the files they carry. */
function chatOf(source: GalahadHome, id: string): { problem: string } | { messages: AdoptedMessage[]; story: { text: string; through: number; updatedAt: number } | null; files: { ref: AttachmentRef; here: boolean }[] } {
  if (!ConversationId.safeParse(id).success) return { problem: "its id isn't a chat's" };
  const { messages, story } = source.chat(id);
  const out: AdoptedMessage[] = [];
  const files = new Map<string, { ref: AttachmentRef; here: boolean }>();
  for (const [i, m] of messages.entries()) {
    const role = z.enum(["user", "assistant"]).safeParse(m.role);
    const status = Status.safeParse(m.status);
    if (!role.success || !status.success) return { problem: `its message ${i + 1} doesn't read` };
    let attachments: AttachmentRef[] | undefined;
    if (m.attachments) {
      try {
        const read = z.array(AttachmentRef).safeParse(JSON.parse(m.attachments));
        if (!read.success) return { problem: `the files of its message ${i + 1} don't read` };
        attachments = read.data.length ? read.data : undefined;
      } catch {
        return { problem: `the files of its message ${i + 1} don't read` };
      }
    }
    for (const ref of attachments ?? []) if (!files.has(ref.id)) files.set(ref.id, { ref, here: source.hasUpload(ref.id) });
    out.push(adopted(m, role.data, status.data, attachments));
  }
  // Its story covers its messages through one of them: that one's place, as this node will number it.
  const through = story ? messages.findIndex((m) => m.id === story.through) : -1;
  return { messages: out, story: story && through >= 0 ? { text: story.text, through, updatedAt: story.updatedAt } : null, files: [...files.values()] };
}

function adopted(m: OldMessage, role: "user" | "assistant", status: AdoptedMessage["status"], attachments: AttachmentRef[] | undefined): AdoptedMessage {
  let steps: StoredStep[] = [];
  try {
    const parsed = JSON.parse(m.steps) as unknown;
    if (Array.isArray(parsed)) steps = parsed as StoredStep[];
  } catch {
    /* what it did isn't kept in a form that reads: its words still are */
  }
  return {
    role,
    content: m.content,
    ...(attachments ? { attachments } : {}),
    ...(m.lookSet !== null && m.lookNote !== null ? { look: { set: m.lookSet, note: m.lookNote } } : {}),
    model: m.model,
    steps,
    status,
    error: m.error,
    createdAt: m.createdAt,
    endedAt: m.endedAt,
  };
}
