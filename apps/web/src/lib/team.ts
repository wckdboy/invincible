import type { TeamDelivery, TeamEngramStatus, TeamHarness, TeamMessage, TeamSnapshot, TeamTask, Teammate } from "@galahad/core/team";

/** What a knight's page shows: its timeline, or its Workspace panel. (A room has only its timeline.) */
export type TeamTab = "chat" | "workspace";
export interface TeamLocation { room?: string; teamTab?: TeamTab; task?: string }

/** A knight's coding harness, as it is named to you: his own, or a tool that does the engineer's part in the VM
 * (the vendors' own tools by their own names, in plain text; any other that speaks ACP, by the command you give it). */
export const HARNESS: Record<TeamHarness, string> = { native: "Galahad", opencode: "OpenCode", hermes: "Hermes Agent", claude: "Claude Code", codex: "Codex", acp: "Any ACP agent" };

/** What the node found of one harness in a knight's VM: `on`, what it would run on there; `reason`, why it can't yet. */
export interface HarnessStatus { id: string; ready: boolean; on?: string; reason?: string }

/** The line under a harness's name: what to do so that it can work, or what it would run on. */
export const harnessNote = (harness: HarnessStatus): string | null => harness.reason ?? (harness.on ? `Runs on ${harness.on}` : null);

/** A roster role, as far as a knight's editor needs it (`forKnights` is absent from an older node). */
export interface KnightRoleSpec { models: string[]; forKnights?: boolean }

const BUILT_IN_ROLES = ["engineer", "planner", "reviewer", "swift"];

/**
 * The roles a knight may be given, engineer first: the roster's that are for knights (the planner, engineer and swift
 * roles, then the ones you made by name; never the reviewer, which checks its work, or a tool's), and the one it has
 * now, whatever that is. An older node says nothing of which are for knights: then the usual four and every other.
 * (In an order of its own, not the roster's: the iPhone app's twin, Knights.roles, reads the roster unordered.)
 */
export function knightRoles(roster: Record<string, KnightRoleSpec>, current?: string): string[] {
  const told = Object.values(roster).some((spec) => spec.forKnights !== undefined);
  const theirs = (role: string): boolean => !told || Boolean(roster[role]?.forKnights);
  const builtIn = told ? ["engineer", "planner", "swift"].filter((role) => role === "engineer" || theirs(role)) : BUILT_IN_ROLES;
  const others = Object.keys(roster).filter((role) => !BUILT_IN_ROLES.includes(role) && theirs(role)).sort();
  return [...new Set([...builtIn, ...others, ...(current ? [current] : [])])];
}

/** What a knight on this role works on, in a line: the first model and how many follow it, or that none answers. */
export function knightRoleLine(role: string, spec: KnightRoleSpec | undefined): string {
  // (A role the roster doesn't have answers with the engineer's models: brain's roleModels.)
  if (!spec) return `${role} isn't on your roster: the engineer's models do its work`;
  // (The reviewer's role, or a tool's, never does a task's work: brain's workRole.)
  if (spec.forKnights === false) return `It talks on the ${role}'s models; its tasks' work runs on the engineer's, since the reviewer never does the work it checks`;
  const models = spec.models;
  const first = models[0];
  if (!first) return `${role} has no model yet: put one on it on the Models page`;
  return `Its work runs on ${first}${models.length > 1 ? ` (then ${models.length - 1} more)` : ""}; its plan and the independent review stay the planner's and the reviewer's`;
}

/** A model you may set a knight to work on (core's TeamModelChoice): its ref, and the nodes that serve it, when a local runtime does. */
export interface KnightModelChoice {
  ref: string;
  on: string[];
}

/** The most models of its own a knight works on (core's TeammateModels). */
export const KNIGHT_MODELS_MAX = 8;

/**
 * The models offered in a knight's editor, as toggles: the ones it works on now first, in their order (any the node no
 * longer offers included, so turning one off is possible), then the rest as the node lists them.
 */
export function knightModelChoices(choices: KnightModelChoice[], own: readonly string[] = []): KnightModelChoice[] {
  const byRef = new Map(choices.map((c) => [c.ref, c]));
  return [...own.map((ref) => byRef.get(ref) ?? { ref, on: [] }), ...choices.filter((c) => !own.includes(c.ref))];
}

/** A knight's own models with one turned on (last, as it is tried after the others; eight at most) or off. */
export function toggleKnightModel(own: readonly string[], ref: string, on: boolean): string[] {
  if (!on) return own.filter((m) => m !== ref);
  return own.includes(ref) || own.length >= KNIGHT_MODELS_MAX ? [...own] : [...own, ref];
}

/** What a knight works on, in a word or two: its role, and its own first model when it has some ("engineer · on mimo-v2.6:9b +1"). */
export function knightWorksOn(person: Pick<Teammate, "role" | "models" | "sensitive">): string {
  const own = person.models ?? [];
  if (!own.length) return person.role;
  return `${person.role} · on ${own[0]!.slice(own[0]!.indexOf("/") + 1)}${own.length > 1 ? ` +${own.length - 1}` : ""}${person.sensitive ? " · sensitive mode" : ""}`;
}

/** One toggle's words: the model, and where it runs when a node of yours serves it. */
export const knightModelLabel = (choice: KnightModelChoice): string => (choice.on.length ? `${choice.ref} · on ${choice.on.join(", ")}` : choice.ref);

/** What a knight with models of its own works on, in a line; none: its role's, as `knightRoleLine` says. */
export function knightModelsLine(own: readonly string[], role: string, spec: KnightRoleSpec | undefined, sensitive = false): string {
  const first = own[0];
  if (!first) return `None chosen: it works on its role's models. ${knightRoleLine(role, spec)}`;
  const more = own.length > 1 ? ` (then ${own.length - 1} more, in the order you turned them on)` : "";
  // Sensitive mode (core's heldModels): every call of its work on them, and none elsewhere.
  if (sensitive) return `Sensitive mode: every call of its work (its plan, its review, its conversations, its coding tool) runs on ${first}${more} and nothing else, never a fallback`;
  return `Its work runs on ${first}${more}, in place of its role's; its plan and the independent review stay the planner's and the reviewer's`;
}

/**
 * The notes store (Engram) in a knight's Workspace, in a line: the node's switch, and whether this VM has the
 * pinned binary. A store that isn't in the VM is never called on for it. Null: the node says nothing of one.
 */
export function engramLine(status: TeamEngramStatus | undefined): { badge: string; tone: "ok" | "warn" | "neutral"; text: string } | null {
  if (!status) return null;
  const engram = `Engram ${status.pinned}`;
  if (!status.on) {
    const here = status.present === true ? ` ${engram} is in this VM, should you turn it on.` : status.present === false ? ` Turned on, it would not reach this knight: ${status.reason}.` : "";
    return { badge: "Off", tone: "neutral", text: `Off: tasks are given no notes store.${here}` };
  }
  if (status.present === true) return { badge: "On", tone: "ok", text: `${engram} is in this VM, and this knight's tasks are given it. Notes are a task's own leads, kept in this VM and checked before they are trusted.` };
  if (status.present === false) return { badge: "Not in this VM", tone: "warn", text: `On, but ${status.reason}. This knight's tasks run without it and say so.` };
  return { badge: "On", tone: "neutral", text: `On. Whether this VM has ${engram} is asked when the knight is idle and its VM is running.` };
}

/** Team addresses keep the room when the page is reloaded or shared (the Roundtable's: #/team, or #/roundtable). */
export function teamLocation(hash: string): TeamLocation {
  if (!/^#\/(?:team|roundtable)(?:\?|$)/.test(hash)) return {};
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const room = params.get("room");
  const tab = params.get("tab");
  const task = params.get("task");
  return {
    ...(room && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(room) ? { room } : {}),
    ...(task && /^task-[A-Za-z0-9_-]{12}$/.test(task) ? { task } : {}),
    // (The Work tab's address, tab=work, opens the timeline: a task is a card in it now.)
    ...(tab === "workspace" ? { teamTab: tab } : {}),
  };
}

export function teamHash(location: TeamLocation): string {
  const params = new URLSearchParams();
  if (location.room) params.set("room", location.room);
  if (location.teamTab && location.teamTab !== "chat") params.set("tab", location.teamTab);
  if (location.task) params.set("task", location.task);
  return `#/team${params.size ? `?${params}` : ""}`;
}

/** The address the app settles on when it opens at a page: the page's own, and for Team its room and tab as well
 * (in teamHash's own form), so a reload or a link comes back to the same conversation. */
export const landingHash = (route: string, hash: string): string => (route === "team" ? teamHash(teamLocation(hash)) : `#/${route}`);

/** A handle as its form field checks it. A browser compiles a field's pattern with the v flag, where a hyphen
 * inside a class must be escaped: unescaped, the field is never checked at all. */
export const HANDLE_PATTERN = "[a-z][a-z0-9\\-]{0,31}";

/** A profile ID is stable after a rename; reserved speakers are never assigned. */
export function teammateId(name: string, taken: string[]): string {
  const cleaned = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = (/^[a-z]/.test(cleaned) ? cleaned : `knight-${cleaned}`).slice(0, 28).replace(/-+$/, "") || "knight";
  const used = new Set([...taken, "owner", "system", "galahad"]);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export const activeTeamWork = (work: Pick<TeamTask | TeamDelivery, "status">): boolean => work.status === "queued" || work.status === "running";

export function teammateState(person: Teammate, snapshot: Pick<TeamSnapshot, "tasks" | "deliveries">): { text: string; tone: "neutral" | "warn" | "accent"; live: boolean } {
  const work = [...snapshot.tasks.filter((task) => task.assignee === person.id), ...snapshot.deliveries.filter((delivery) => delivery.teammate === person.id)];
  if (work.some((item) => item.status === "running")) return { text: "Working", tone: "accent", live: true };
  if (!person.enabled) return { text: "Paused", tone: "warn", live: false };
  if (person.turnsToday >= person.dailyTurns) return { text: "Daily limit reached", tone: "warn", live: false };
  if (work.some((item) => item.status === "queued")) return { text: "Queued", tone: "neutral", live: false };
  return { text: "Ready", tone: "neutral", live: false };
}

/** Who made a worker, when it wasn't you: Galahad himself in your conversation with him, or one of his workers
 * (named still when you have since removed that one). */
export function teammateMaker(person: Pick<Teammate, "createdBy">, teammates: Teammate[], removed: NonNullable<TeamSnapshot["removed"]> = []): string | null {
  if (!person.createdBy || person.createdBy === "owner") return null;
  const maker = [...teammates, ...removed].find((other) => other.id === person.createdBy);
  return person.createdBy === "galahad" ? "Galahad" : (maker?.name ?? person.createdBy);
}

/** Every handle that is spoken for: the workers here, and the ones you removed, whose handles are never used again. */
export const takenHandles = (snapshot: Pick<TeamSnapshot, "teammates" | "removed"> | null): string[] =>
  [...(snapshot?.teammates ?? []), ...(snapshot?.removed ?? [])].map((person) => person.id);

/** What removing a worker means, said before it is done: what goes, what stays, and whether this device may do it
 * (`blocked` says why not). A worker's VM goes with it, which takes a device that may manage sandboxes. */
export function removalPlan(person: Pick<Teammate, "id" | "name" | "workspace" | "workspaceNode">, may: { sandbox: boolean }): { blocked: string | null; lines: string[]; destroyWorkspace: boolean } {
  const lines = [
    `${person.name} leaves every room and does no more work. What ${person.name} said stays where it was said, and its direct conversations are kept.`,
    `The handle ${person.id} is never used again, so nothing new inherits its history.`,
  ];
  // A VM that was being made when the node last stopped may exist without ever having been bound: the node looks for itself.
  if (!person.workspace && !person.workspaceNode) return { blocked: null, lines: [...lines, "This can't be undone."], destroyWorkspace: false };
  if (!may.sandbox) return { blocked: `${person.name} has a VM, and removing ${person.name} destroys it. That takes a device that may manage sandboxes; this one may not.`, lines, destroyWorkspace: true };
  const vm = person.workspace ? `${person.name}'s VM is destroyed with it, and everything in its /work.` : `A VM was being made for ${person.name}: if there is one, it is destroyed with it, and everything in its /work.`;
  return { blocked: null, lines: [...lines, `${vm} This can't be undone.`], destroyWorkspace: true };
}

/** Historical attribution survives a profile rename or removal. */
export function teamSpeaker(message: Pick<TeamMessage, "speaker" | "speakerName">, teammates: Teammate[]): string {
  if (message.speaker === "owner") return "You";
  if (message.speaker === "galahad") return "Galahad";
  if (message.speaker === "system") return "The Roundtable";
  return message.speakerName || teammates.find((person) => person.id === message.speaker)?.name || message.speaker;
}

/** A queued task cannot run until every predecessor completed and passed its checks. */
export function taskDependencies(task: Pick<TeamTask, "dependsOn">, all: TeamTask[]): { id: string; title: string; satisfied: boolean }[] {
  return task.dependsOn.map((id) => {
    const parent = all.find((candidate) => candidate.id === id);
    return { id, title: parent?.title ?? id, satisfied: parent?.status === "done" && parent.verified };
  });
}
