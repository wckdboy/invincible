import type { ArchiveStatusView } from "@galahad/core";

/*
 * The Archive page's logic: what each kind is called, the smart selector's summary in
 * plain words, the search request it makes, and the status in words. Pure functions
 * (no DOM), unit-tested. Any other kind (a newer node's, or one no longer archived) is shown as it is.
 */

export interface KindInfo {
  label: string;
  plural: string;
  icon: "layers" | "memory" | "lightbulb" | "archive" | "chat" | "sparkle" | "file";
}

export const KIND_INFO: Record<string, KindInfo> = {
  model: { label: "Model", plural: "Models", icon: "layers" },
  teaching: { label: "Teaching", plural: "Teachings", icon: "memory" },
  idea: { label: "Idea", plural: "Ideas", icon: "lightbulb" },
  artifact: { label: "Artifact", plural: "Artifacts", icon: "archive" },
  chat: { label: "Chat", plural: "Chats", icon: "chat" },
  lesson: { label: "Lesson", plural: "Lessons", icon: "sparkle" },
};

export const kindInfo = (kind: string): KindInfo => KIND_INFO[kind] ?? { label: kind[0]!.toUpperCase() + kind.slice(1), plural: `${kind[0]!.toUpperCase()}${kind.slice(1)}s`, icon: "file" };

export type Trust = "owner" | "agent" | "untrusted";
export const TRUST_LABEL: Record<Trust, string> = { owner: "Yours", agent: "Galahad's", untrusted: "Untrusted" };

export type Span = "any" | "day" | "week" | "month" | "year";
export const SPANS: { value: Span; label: string; ms: number }[] = [
  { value: "any", label: "Any time", ms: 0 },
  { value: "day", label: "Today", ms: 86_400_000 },
  { value: "week", label: "This week", ms: 7 * 86_400_000 },
  { value: "month", label: "This month", ms: 30 * 86_400_000 },
  { value: "year", label: "This year", ms: 365 * 86_400_000 },
];

export interface ArchiveFilter {
  kinds: Set<string>;
  trust: Set<Trust>;
  span: Span;
}

export const emptyFilter = (): ArchiveFilter => ({ kinds: new Set(), trust: new Set(), span: "any" });
export const filtering = (f: ArchiveFilter): boolean => f.kinds.size > 0 || f.trust.size > 0 || f.span !== "any";

/** What the selector says: "Everything", or what's on ("Ideas, models · this week · yours"). */
export function filterSummary(f: ArchiveFilter): string {
  const parts: string[] = [];
  if (f.kinds.size) {
    const names = [...f.kinds].map((k) => kindInfo(k).plural);
    parts.push(names.length > 2 ? `${names.length} kinds` : names.map((n, i) => (i ? n.toLowerCase() : n)).join(", "));
  }
  if (f.span !== "any") parts.push(SPANS.find((s) => s.value === f.span)!.label.toLowerCase());
  if (f.trust.size && f.trust.size < 3) parts.push([...f.trust].map((t) => TRUST_LABEL[t].toLowerCase()).join(" and "));
  if (!parts.length) return "Everything";
  const text = parts.join(" · ");
  return text[0]!.toUpperCase() + text.slice(1);
}

/** The search request for a query and a filter (what /api/archive/search takes). */
export function searchBody(query: string, f: ArchiveFilter, limit: number, now = Date.now()): Record<string, unknown> {
  const span = SPANS.find((s) => s.value === f.span)!;
  return {
    q: query.trim(),
    limit,
    ...(f.kinds.size ? { kinds: [...f.kinds] } : {}),
    ...(f.trust.size && f.trust.size < 3 ? { trust: [...f.trust] } : {}),
    ...(span.ms ? { since: now - span.ms } : {}),
  };
}

export function bytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 2 ** 20) return `${Math.round(n / 1024)} KB`;
  if (n < 2 ** 30) return `${(n / 2 ** 20).toFixed(1)} MB`;
  return `${(n / 2 ** 30).toFixed(2)} GB`;
}

/** The embedder in words, and the tone of its state. */
export function embedderLine(s: ArchiveStatusView): { text: string; tone: "ok" | "warn" | "neutral"; hint: string | null } {
  if (!s.embedder.model) return { text: "None: searching by words", tone: "neutral", hint: "Hire one to search by meaning too: deploy with --embedder, or `galahad roster set embedder ollama/qwen3-embedding:0.6b`." };
  const where = s.embedder.local ? "on this machine" : s.embedder.local === false ? "a remote provider: passages go to it" : "";
  if (s.embedder.state === "failing") return { text: `${s.embedder.model}: not answering`, tone: "warn", hint: s.embedder.error };
  return { text: `${s.embedder.model}${where ? `, ${where}` : ""}`, tone: s.embedder.local === false ? "warn" : "ok", hint: null };
}

/** How much of the archive is embedded, as a fraction (1 with nothing to embed). */
export const embeddedShare = (s: ArchiveStatusView): number => (s.embedded + s.backlog ? s.embedded / (s.embedded + s.backlog) : 1);

/** A delete's confirmation word: the title when it's short, else a piece of the id. */
export const deleteName = (e: { id: string; title: string }): string => (e.title.length <= 40 ? e.title : e.id.slice(4, 12));
