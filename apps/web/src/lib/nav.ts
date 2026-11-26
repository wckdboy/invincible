import type { AnyScope } from "../types.ts";
import type { IconName } from "../ui/icons.ts";
import { teamHash, teamLocation, type TeamLocation } from "./team.ts";

/*
 * The app's places, as one list (pure: no DOM; the shell gives each its view). Galahad comes first everywhere (your
 * words, 26 November 2026: "agent first (Galahad)", the knights "project/tasks/coding t3code style"): on a phone the app
 * opens on Home (his orb, what needs you, the work, his message box), on a wide screen on his own conversation beside the
 * work. Each task has an address of its own (#/task/<id>), opened from its row. Every other place is reached from the
 * index under "…" (a sheet; More is the same index as a page), and from the command palette. An address (`#/fleet`) is a
 * contract: a place is never renamed or dropped here (one that went keeps its address as a second name of another), and
 * what a device may see follows its scopes.
 */

const HEADINGS = { work: "Work", knowledge: "Knowledge", machines: "Machines", keys: "Keys and models", device: "This device" } as const;

interface PlaceSpec {
  id: string;
  label: string;
  icon: IconName;
  /** Where it's reached from: the top of the app (primary), a heading of the index, its row (a thread: a task's own
   * address, never listed), or (null) the index itself. */
  under: "primary" | "thread" | keyof typeof HEADINGS | null;
  scope: AnyScope | null;
  /** Also listed (read-only) for devices holding this scope. */
  alsoFor?: AnyScope;
  /** The key after G that goes there ("": none, for an address that is only ever opened from its row). */
  key: string;
  keywords: readonly string[];
  /** What's there, in a line (More's index). */
  about: string;
}

const LIST = [
  // Home: a phone's first screen, and Galahad's place (your words, 26 November 2026: "agent first (Galahad)"): his orb,
  // what needs you with its answers in place, the work by attention, and his message box. #/work (25 November 2026: "per
  // task/per project like t3code") is its second address: the work is here now, and in a wide screen's sidebar.
  { id: "home", label: "Home", icon: "layers", under: "primary", scope: "chat", key: "j", keywords: ["home", "work", "tasks", "projects", "threads", "repositories", "under way", "needs you", "jobs", "code", "today"], about: "Galahad, what needs you, and the work" },
  // Galahad himself, the one you talk to (your word, 23 November 2026): his address stays #/chat, and "chat" still finds him.
  { id: "chat", label: "Galahad", icon: "chat", under: "primary", scope: "chat", key: "c", keywords: ["galahad", "chat", "counsel", "ask", "talk", "history", "conversations", "orb"], about: "" },
  // (Its address stays #/team, and #/roundtable is the same page. Its older names still find it.)
  { id: "team", label: "Roundtable", icon: "roundtable", under: "primary", scope: "chat", key: "h", keywords: ["knights", "roundtable", "give", "rooms", "messages", "tasks", "coordination", "team", "squires", "hermes"], about: "The knights: who works on what, their rooms" },
  // A task's own thread (#/task/<id>): its brief, its work folded, what proves it, and its details. Opened from its row;
  // #/task alone opens the one that needs you most.
  { id: "task", label: "Task", icon: "layers", under: "thread", scope: "chat", key: "", keywords: [], about: "" },
  // (What needs you shows on the row it belongs to; the Inbox is where all of it is answered.)
  { id: "inbox", label: "Inbox", icon: "inbox", under: "work", scope: null, key: "i", keywords: ["approvals", "pairing", "requests", "actions", "notices", "oath"], about: "Everything that needs you, to answer" },
  { id: "more", label: "More", icon: "more", under: null, scope: null, key: ".", keywords: ["everything", "all", "index", "menu"], about: "" },
  { id: "overview", label: "Overview", icon: "overview", under: "work", scope: null, key: "o", keywords: ["dashboard", "health", "doctor"], about: "Health, what's in hand and recent activity" },
  { id: "projects", label: "Projects", icon: "folder", under: "work", scope: "mind:read", key: "p", keywords: ["workspaces", "instructions", "repositories", "folders"], about: "Instructions and chats, by project" },
  { id: "loops", label: "Loops", icon: "repeat", under: "work", scope: "mind:read", key: "r", keywords: ["schedule", "cron", "heartbeat", "routine", "recurring", "tripwires", "rules", "hooks", "guardrails"], about: "What he does on a schedule, and your tripwires" },
  { id: "activity", label: "Activity", icon: "activity", under: "work", scope: "mind:read", key: "a", keywords: ["ledger", "log", "audit", "history"], about: "Everything he did, and why it was allowed" },
  { id: "artifacts", label: "Artifacts", icon: "archive", under: "work", scope: "mind:read", key: "w", keywords: ["work", "results", "files", "outputs", "kept", "reports", "plots"], about: "Files his work kept" },
  { id: "trials", label: "Trials", icon: "gauge", under: "work", scope: "mind:read", key: "t", keywords: ["benchmarks", "evals", "galahad index", "score", "tests", "progress"], about: "Whether he is getting better" },
  { id: "memory", label: "Memory", icon: "memory", under: "knowledge", scope: "mind:read", key: "m", keywords: ["remember", "recall", "mind", "search", "find"], about: "What the fleet remembers" },
  { id: "skills", label: "Skills", icon: "scroll", under: "knowledge", scope: "mind:read", key: "u", keywords: ["learn", "learned", "how", "notes", "playbook", "procedures", "know-how", "approve", "proposed", "library"], about: "What he learned to do, for you to approve" },
  { id: "archive", label: "Archive", icon: "library", under: "knowledge", scope: "mind:read", key: "k", keywords: ["kept", "forever", "ideas", "lessons", "models", "teachings", "semantic", "search", "vector", "history"], about: "Everything kept for good, searchable" },
  { id: "findings", label: "Findings", icon: "flask", under: "knowledge", scope: "mind:read", key: "e", keywords: ["investigations", "experiments", "hypotheses", "science", "conclusions", "predictions"], about: "What his investigations concluded" },
  { id: "fleet", label: "Fleet", icon: "fleet", under: "machines", scope: "mind:read", key: "f", keywords: ["devices", "nodes", "machines", "compute", "agents"], about: "Your machines and devices" },
  // Owner devices see Sandboxes even before they hold the new scope, so the feature can be found;
  // the page explains what's missing instead of offering actions that would be refused.
  { id: "sandboxes", label: "Sandboxes", icon: "sandbox", under: "machines", scope: "sandbox", alsoFor: "fleet:admin", key: "s", keywords: ["containers", "vm", "console"], about: "Isolated places where work runs" },
  { id: "vault", label: "Vault", icon: "vault", under: "keys", scope: "vault:read", key: "v", keywords: ["keys", "secrets", "api key"], about: "Sealed keys; no model ever sees one" },
  { id: "models", label: "Models", icon: "models", under: "keys", scope: "mind:read", key: "l", keywords: ["providers", "roster", "llm"], about: "Who answers: roles, models, providers" },
  { id: "connectors", label: "Connectors", icon: "plug", under: "keys", scope: "mind:read", key: "n", keywords: ["github", "cloudflare", "home assistant", "integrations", "services", "tools", "mcp", "standing orders", "install"], about: "Services and MCP servers he may call" },
  { id: "bank", label: "Bank", icon: "bank", under: "keys", scope: "bank:read", key: "b", keywords: ["accounts", "balances", "transactions", "enable banking", "money", "finance"], about: "The bank connection, and who may read it" },
  { id: "settings", label: "Settings", icon: "settings", under: "device", scope: null, key: ",", keywords: ["preferences", "theme", "device", "notifications"], about: "Theme, notifications, this device" },
] as const satisfies readonly PlaceSpec[];

export type Route = (typeof LIST)[number]["id"];
export type Place = PlaceSpec & { id: Route };
export const PLACES: readonly Place[] = LIST;

/** The places a device may see: its scopes decide. */
export const placesFor = (can: (scope: AnyScope) => boolean): Place[] => PLACES.filter((place) => place.scope === null || can(place.scope) || (place.alsoFor !== undefined && can(place.alsoFor)));

/** A place's second address: the Roundtable is #/team, and #/roundtable as well; the work by project (25 November 2026)
 * is Home's now, so #/work opens Home. */
export const ALIASES: Readonly<Record<string, Route>> = { roundtable: "team", work: "home" };

/** The place an address is for, among those a device may see (null: none of them). */
export function routeOf(hash: string, visible: Place[]): Route | null {
  const name = hash.match(/^#\/([a-z]+)(?:[?/]|$)/)?.[1];
  if (!name) return null;
  const id = ALIASES[name] ?? name;
  return visible.find((place) => place.id === id)?.id ?? null;
}

/** A task's id as its address names it (core's TeamTaskId). */
const TASK_ID = /^task-[a-z0-9_-]{12}$/;

/** The task an address opens (#/task/<id>), or null: none named, or not a task's id. */
export function taskOf(hash: string): string | null {
  const id = /^#\/task\/([^/?#&]+)$/.exec(hash)?.[1];
  return id && TASK_ID.test(id) ? id : null;
}

/** Where a place is, with what it opens: a room (and its tab, and a task to bring into view) at the Roundtable; a task's
 * own thread; any other place by its name. */
export function hashOf(route: Route, opts: TeamLocation = {}): string {
  if (route === "team") return teamHash(opts);
  if (route === "task") return opts.task && TASK_ID.test(opts.task) ? `#/task/${opts.task}` : "#/task";
  return `#/${route}`;
}

/** The address the app settles on when it opens at a place: the place's own, in its own form, with what it opens (a
 * room, a task), so a reload or a link comes back to the same thing. (A kept chat's is read before, and the chat keeps it.) */
export function landingOf(route: Route, hash: string): string {
  if (route === "team") return teamHash(teamLocation(hash));
  if (route === "task") return hashOf("task", { task: taskOf(hash) ?? undefined });
  return `#/${route}`;
}

/** The places at the top of the app: Home, Galahad's own conversation, and the Roundtable. */
export const primaryOf = (visible: Place[]): Place[] => visible.filter((place) => place.under === "primary");

/**
 * The place the app opens on, and falls back to: on a phone, Home (Galahad's place, with what needs you and the work:
 * your words, 26 November 2026, "agent first"); on a wide screen, his own conversation, beside the work in the sidebar
 * (23 November 2026: he is the one you talk to). A device that may not chat opens on its Inbox.
 */
export function homeOf(visible: Place[], screen: { narrow: boolean }): Route {
  const want: Route = screen.narrow ? "home" : "chat";
  return visible.some((place) => place.id === want) ? want : (primaryOf(visible)[0]?.id ?? "inbox");
}

/** More's index: every other place this device may see, under its heading. */
export function moreIndex(visible: Place[]): { heading: string; places: Place[] }[] {
  return Object.entries(HEADINGS)
    .map(([under, heading]) => ({ heading, places: visible.filter((place) => place.under === under) }))
    .filter((group) => group.places.length > 0);
}

/**
 * The index under "…" (a sheet on every screen; the rail and the phone's tab bar went, 26 November 2026): the
 * Roundtable first, where the knights and their rooms are, then More's index. Everything this device may see but Home,
 * Galahad and a task's own thread, which are always a tap away.
 */
export function placesIndex(visible: Place[]): { heading: string | null; places: Place[] }[] {
  const top = visible.filter((place) => place.id === "team");
  return [...(top.length ? [{ heading: null, places: top }] : []), ...moreIndex(visible)];
}

/** The places a key after G goes to (a task's thread has none: it is opened from its row). */
export const keyedOf = (visible: Place[]): Place[] => visible.filter((place) => place.key !== "");

/** The places the palette's "Go to" offers: every one this device may see but a task's thread (its rows find tasks). */
export const goToOf = (visible: Place[]): Place[] => visible.filter((place) => place.under !== "thread");
