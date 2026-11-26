import type { ConversationSummary, StoredMessage } from "@galahad/core";

/*
 * Chat history and projects as the app shows them. Pure functions (no DOM), unit-tested.
 */

export interface ChatGroup {
  label: string;
  items: ConversationSummary[];
}

const DAY = 86_400_000;

/** Pinned first, then by when they were last active: today, yesterday, this week, earlier. */
export function groupConversations(list: ConversationSummary[], now = Date.now()): ChatGroup[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const groups: ChatGroup[] = ["Pinned", "Today", "Yesterday", "This week", "Earlier"].map((label) => ({ label, items: [] }));
  for (const c of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const at = c.updatedAt;
    groups[c.pinned ? 0 : at >= today ? 1 : at >= today - DAY ? 2 : at >= today - 6 * DAY ? 3 : 4]!.items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

/** Every word of the query in the title or the project, by its id or the name the row shows (any case). */
export function filterConversations(list: ConversationSummary[], query: string, projectName: (id: string) => string = (id) => id): ConversationSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((c) => {
    const text = `${c.title} ${c.project ?? ""} ${c.project ? projectName(c.project) : ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The conversation Galahad's row opens: the one last active (a pin does not make one more recent). Null: none kept yet. */
export const mostRecent = (list: readonly ConversationSummary[]): ConversationSummary | null =>
  list.reduce<ConversationSummary | null>((latest, c) => (!latest || c.updatedAt > latest.updatedAt ? c : latest), null);

/** What his menu offers before anything about the chat on screen: a new chat, and every kept one. */
export const CHATS_MENU = [
  { value: "new", label: "New chat" },
  { value: "history", label: "All chats…" },
] as const;

export interface ChatAction {
  value: "aside" | "rename" | "pin" | "delete";
  label: string;
  meta?: string;
}

/**
 * What a chat's one menu offers to do with the chat itself, in order: a side question when there is something to
 * ask about, and for a kept chat its name, its pin and its end. A new chat with nothing said has none.
 */
export function chatActions(chat: { kept: boolean; pinned: boolean; aside: boolean; node: string }): ChatAction[] {
  return [
    ...(chat.aside ? [{ value: "aside" as const, label: "Ask on the side…", meta: "Answered apart: what he's doing goes on" }] : []),
    ...(chat.kept
      ? [
          { value: "rename" as const, label: "Rename…" },
          { value: "pin" as const, label: chat.pinned ? "Unpin" : "Pin to the top of your chats" },
          { value: "delete" as const, label: "Delete…", meta: `For good, on ${chat.node}` },
        ]
      : []),
  ];
}

export interface KeptStep {
  kind: "asked" | "model" | "fallback" | "archive" | "tool" | "answer" | "error" | "stopped" | "steered";
  text: string;
  detail?: string;
  state: "done" | "warn" | "error";
  /** For tool steps: the tool's name (for its icon) and the call's id. */
  tool?: { name: string; id: string };
}

/** The archived entries an answer was given, as one step: how many, and each by its id and title. */
export function archiveStep(entries: { id: string; title: string; kind: string; trust: string }[]): { text: string; detail?: string } {
  // His skills go with an answer as their own step (kind "skill"): notes he had at hand, not archived entries he read.
  const skills = entries.length > 0 && entries.every((e) => e.kind === "skill");
  const text = skills ? `Had ${entries.length} skill${entries.length === 1 ? "" : "s"} at hand` : `Read ${entries.length} archived ${entries.length === 1 ? "entry" : "entries"}`;
  if (!entries.length) return { text };
  return { text, detail: entries.map((e) => `[${e.id}] ${e.title}${e.trust === "untrusted" ? " (untrusted)" : ""}`).join(" · ") };
}

/** A kept answer's steps, as the chat shows them while one streams. */
export function stepsOf(answer: StoredMessage, role: string): KeptStep[] {
  const steps: KeptStep[] = [{ kind: "asked", text: `Asked as ${role}`, state: "done" }];
  for (const s of answer.steps) {
    if (s.kind === "model") steps.push({ kind: "model", text: `Thinking with ${s.ref}`, state: "done" });
    else if (s.kind === "fallback") steps.push({ kind: "fallback", text: `${s.from} didn't answer`, detail: s.error, state: "warn" });
    else if (s.kind === "archive") steps.push({ kind: "archive", ...archiveStep(s.entries), state: "done" });
    else if (s.kind === "tool") {
      const detail = [s.input, s.summary].filter(Boolean).join(" → ");
      steps.push({ kind: "tool", text: s.title, ...(detail ? { detail } : {}), state: s.ok === false ? "warn" : "done", tool: { name: s.name, id: s.id } });
    }
  }
  if (answer.content) steps.push({ kind: "answer", text: "Answering", state: "done" });
  if (answer.status === "error") steps.push({ kind: "error", text: "Couldn't answer", ...(answer.error ? { detail: answer.error } : {}), state: "error" });
  if (answer.status === "stopped") steps.push({ kind: "stopped", text: "Stopped", state: "warn" });
  // You sent a message while he was answering: this answer stands as far as it got, and the turn went on after it.
  if (answer.status === "steered") steps.push({ kind: "steered", text: "Your message reached him here", state: "done" });
  return steps;
}

/** A project's id from its name: lowercase letters, digits and dashes, unique among those taken. */
export function projectIdFrom(name: string, taken: string[] = []): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/å/g, "a")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34) || "project";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}
