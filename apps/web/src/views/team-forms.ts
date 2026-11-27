import type { SandboxView, SecretView } from "@invincible/core";
import { agentFromFile, type AgentFile, agentToFile } from "@invincible/core/agents";
import { findSecrets } from "@invincible/core/secret-scan";
import type { TeamControlInput, TeamKeyGrant, TeamRoom, TeamSnapshot, TeamTask, TeamTaskInput, Agent } from "@invincible/core/team";
import { TEAM_LIMITS } from "@invincible/core/team-limits";
import { isAbort } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { hasDesktop, hasHardware } from "../lib/desktop.ts";
import { budgetFrom, gatesFrom, type Given, giveInput, givenTo } from "../lib/give.ts";
import { growWords } from "../lib/sandbox.ts";
import { STEER_WORDS } from "../lib/steer.ts";
import { HANDLE_PATTERN, HARNESS, type AgentModelChoice, agentModelChoices, agentModelsLine, agentRoleLine, agentRoles, removalPlan, takenHandles, agentId, toggleAgentModel } from "../lib/team.ts";
import { asCaps, type RoleSpec } from "../types.ts";
import { badge, busy, button, callout, field } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace, type Child } from "../ui/dom.ts";
import { avatarEditor, workerAvatar } from "../ui/avatar.ts";
import { toast } from "../ui/toast.ts";

/*
 * What you change among the agents, as sheets: an agent, a room, a task, working notes, a VM.
 * The roster and every timeline open the same ones. Each reads the team as the app last has it
 * (ctx.live.team) and asks for it again once the node has taken the change.
 */

export const WORK_TONE = { proposed: "accent", queued: "neutral", running: "accent", done: "ok", failed: "danger", stopped: "neutral", interrupted: "warn" } as const;

/** Shared editor mechanics: validation/errors stay in the sheet, and duplicate submits are blocked. */
function editor(ctx: Ctx, title: string, description: string, fields: Child[], saveLabel: string, save: () => Promise<void>): { close: () => void } {
  const error = h("div", { role: "status" });
  const submit = button(saveLabel, { variant: "primary", type: "submit" });
  const form = h("form", { class: "stack" }, ...fields, error);
  let saving = false;
  const finish = async () => {
    if (saving || !form.reportValidity()) return;
    saving = true;
    await busy(submit, async () => {
      try { await save(); sheet.close(); void ctx.live.refreshTeam(); }
      catch (failure) { if (!sheet.scope.disposed) replace(error, callout("danger", errorMessage(failure), { title: "Couldn't save it" })); }
      finally { saving = false; }
    });
  };
  form.addEventListener("submit", (event) => { event.preventDefault(); void finish(); });
  submit.addEventListener("click", () => void finish());
  const sheet = openSheet({ title, description, size: "wide", body: form, footer: [button("Cancel", { onClick: () => sheet.close() }), submit] });
  return { close: () => sheet.close() };
}

const goRoom = (ctx: Ctx, room: string): void => ctx.navigate("team", { room });

/** The roles your Models page has, asked for each time an agent is edited, so a role you just made is there (a device that
 * may not read them is offered the usual four; the last answer stands in when the node can't be asked). */
let roster: Record<string, RoleSpec> | null = null;
async function roles(ctx: Ctx): Promise<Record<string, RoleSpec>> {
  if (ctx.can("mind:read")) roster = await ctx.api.get<{ roster: Record<string, RoleSpec> }>("/api/roster").then((result) => result.roster, () => roster);
  return roster ?? {};
}

/** The models an agent may be set to work on: the roster's, and each local one a node of the fleet serves, and where. */
async function modelChoices(ctx: Ctx): Promise<AgentModelChoice[]> {
  if (!ctx.can("mind:read")) return [];
  return ctx.api.get<{ models: AgentModelChoice[] }>("/api/team/models").then((result) => result.models, () => []);
}

/** Your secrets an agent may be given (PLAN #17): pinned to an https address, and no model provider's or connector's. */
async function givableKeys(ctx: Ctx): Promise<SecretView[]> {
  if (!ctx.can("vault:read")) return [];
  const all = await ctx.api.get<{ secrets: SecretView[] }>("/api/secrets").then((result) => result.secrets, () => []);
  return all.filter((secret) => !secret.provider && secret.origin?.startsWith("https://"));
}

/** What the agent form starts from: an agent you have, or one an agent file holds. */
type Seed = Pick<Agent, "id" | "name" | "instructions" | "harness" | "role" | "repository"> & Partial<Pick<Agent, "acp" | "models" | "sensitive" | "dailyTurns" | "avatar">>;

/** An agent file's agent as a new one here: a free handle (its own, when no agent here has it), and none of the keys it had. */
function seedOf(draft: AgentFile, snapshot: TeamSnapshot | null): Seed {
  const taken = takenHandles(snapshot);
  return {
    id: taken.includes(draft.id) ? agentId(draft.name, taken) : draft.id,
    name: draft.name,
    instructions: draft.instructions,
    harness: (draft.harness ?? "native") as Agent["harness"],
    role: draft.role ?? "engineer",
    repository: draft.repository ?? null,
    ...(draft.acp ? { acp: draft.acp } : {}),
    ...(draft.models?.length ? { models: draft.models } : {}),
    ...(draft.sensitive ? { sensitive: true } : {}),
    ...(draft.dailyTurns !== undefined ? { dailyTurns: draft.dailyTurns } : {}),
    ...(draft.avatar ? { avatar: draft.avatar as Agent["avatar"] } : {}),
  };
}

/** An agent as a file you carry (PLAN #20), downloaded: its job and how it works, never its memory, its record or a key. */
export function exportAgent(person: Agent): void {
  const { text, scrubbed } = agentToFile({ ...person, repository: person.repository ?? undefined, keys: person.keys?.map((key) => key.secret) });
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = h("a", { href: url, download: `${person.id}.md`, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  const taken = scrubbed ? ` ${scrubbed} thing${scrubbed === 1 ? "" : "s"} in its job that looked like a key ${scrubbed === 1 ? "was" : "were"} taken out.` : "";
  toast(`${person.name}, as ${person.id}.md`, { tone: "ok", description: `Its job and how it works, never its memory or a key.${taken} Another node takes it in from New agent.` });
}

/** An agent file of yours (PLAN #20), read here and shown in the New agent form, to check and create like any agent. */
function takeInAgent(ctx: Ctx, close: () => void): void {
  const input = h("input", { type: "file", accept: ".md,text/markdown,text/plain", hidden: true });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 64 * 1024) return void toast("That file is too large to be an agent", { tone: "warn" });
    const read = agentFromFile(await file.text());
    if (!read.ok) return void toast("That isn't an agent file", { tone: "warn", description: `It ${read.why.replace(/^it /, "")}.` });
    close();
    void editAgent(ctx, undefined, read.agent);
  });
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
}

export async function editAgent(ctx: Ctx, existing?: Agent, draft?: AgentFile): Promise<void> {
  // (An agent that has keys says how often its scripts used each, these last days: PLAN #17.)
  const [known, offered, givable, counted] = await Promise.all([
    roles(ctx),
    modelChoices(ctx),
    givableKeys(ctx),
    existing?.keys?.length ? ctx.api.post<{ days: number; uses: Record<string, number> }>("/api/team/key-uses", { id: existing.id }).catch(() => null) : null,
  ]);
  const usedLine = (secret: string): string => {
    if (!counted || !keys.some((key) => key.secret === secret)) return "";
    const n = counted.uses[secret] ?? 0;
    return ` · used ${n} time${n === 1 ? "" : "s"} in ${counted.days} days`;
  };
  const snapshot = ctx.live.team.value;
  // An agent taken in from a file fills the form as a new agent: you check it, and create it as any other.
  const seed: Seed | undefined = existing ?? (draft ? seedOf(draft, snapshot) : undefined);
  const name = h("input", { class: "input", required: true, maxlength: 80, value: seed?.name ?? "", placeholder: "e.g. Ada", autocomplete: "off" });
  const id = h("input", { class: "input mono", required: true, maxlength: 32, pattern: HANDLE_PATTERN, value: seed?.id ?? "", readonly: Boolean(existing), autocomplete: "off", autocorrect: "off", spellcheck: "false" });
  let idEdited = Boolean(seed);
  id.addEventListener("input", () => { idEdited = true; });
  name.addEventListener("input", () => { if (!idEdited) id.value = agentId(name.value, takenHandles(snapshot)); });
  const instructions = h("textarea", { class: "input", rows: 6, maxlength: 8000, placeholder: "Their job, how they work, and when to ask you." }, seed?.instructions ?? "");
  const repository = h("input", { class: "input mono", type: "url", maxlength: 300, value: seed?.repository ?? "", placeholder: "https://github.com/owner/repository", autocomplete: "off" });
  const harness = h("select", { class: "select" }, ...Object.entries(HARNESS).map(([value, label]) => h("option", { value, selected: value === (seed?.harness ?? "native") }, label)));
  // Any agent that speaks the Agent Client Protocol: the command that starts it in its ACP mode, in the agent's VM.
  const acp = h("input", { class: "input mono", maxlength: 300, value: seed?.acp ?? "", placeholder: "goose acp", autocomplete: "off", autocorrect: "off", spellcheck: "false" });
  const acpField = field("Its ACP agent's command", acp, { hint: "What starts it in its ACP mode in the VM, e.g. goose acp, gemini --acp or opencode acp. It runs as you set it up there (its own sign-in or configuration), with the role's model offered through the gateway as OPENAI_BASE_URL." });
  const showAcp = () => { acpField.hidden = harness.value !== "acp"; };
  harness.addEventListener("change", showAcp);
  showAcp();
  const names = agentRoles(known, seed?.role);
  const role = h("select", { class: "select" }, ...names.map((value) => h("option", { value, selected: value === (seed?.role ?? "engineer") }, `${value}${known[value] && !known[value]?.models.length ? " · no model configured" : ""}`)));
  // What the chosen role's models are, under it, as it changes.
  const roleHint = h("span", {}, agentRoleLine(seed?.role ?? "engineer", known[seed?.role ?? "engineer"]));
  role.addEventListener("change", () => { roleHint.textContent = agentRoleLine(role.value, known[role.value]); });
  // Models of its own, in place of its role's: toggled on in the order they are to be tried, a local one where it runs.
  let own = [...(seed?.models ?? [])];
  // Sensitive mode: these models alone, for every call of its work (core's heldModels).
  const sensitive = h("input", { type: "checkbox", checked: seed?.sensitive ?? false });
  const modelsHint = h("span", {}, agentModelsLine(own, seed?.role ?? "engineer", known[seed?.role ?? "engineer"], seed?.sensitive ?? false));
  const sayModels = () => { modelsHint.textContent = agentModelsLine(own, role.value, known[role.value], sensitive.checked); };
  sensitive.addEventListener("change", sayModels);
  role.addEventListener("change", sayModels);
  const modelList = h("div", { class: "scope-list" }, ...agentModelChoices(offered, own).map((choice) => {
    const box = h("input", { type: "checkbox", checked: own.includes(choice.ref) });
    box.addEventListener("change", () => {
      own = toggleAgentModel(own, choice.ref, box.checked);
      // (Past eight it stays off.)
      box.checked = own.includes(choice.ref);
      sayModels();
    });
    return h("label", { class: "scope" }, box, h("span", {}, h("div", { class: "scope-name mono" }, choice.ref), h("div", { class: "tiny subtle" }, choice.on.length ? `Runs on ${choice.on.join(", ")}` : "Through its provider")));
  }));
  // Keys of yours it may use but never see (PLAN #17): given, in the header its API reads, for reads or writes too.
  let keys: TeamKeyGrant[] = [...(existing?.keys ?? [])];
  const keyRows = givable.map((secret) => {
    const given = keys.find((key) => key.secret === secret.name);
    const box = h("input", { type: "checkbox", checked: Boolean(given) });
    const write = h("input", { type: "checkbox", checked: given?.write ?? false, disabled: !given });
    const headers = [...new Set(["authorization", "x-api-key", "api-key", ...(given ? [given.header] : [])])];
    const header = h("select", { class: "select", disabled: !given }, ...headers.map((value) => h("option", { value, selected: value === (given?.header ?? "authorization") }, value === "authorization" ? "Authorization: Bearer" : value)));
    const sync = () => {
      keys = keys.filter((key) => key.secret !== secret.name);
      if (box.checked) keys.push({ secret: secret.name, header: header.value, write: write.checked });
      write.disabled = header.disabled = !box.checked;
    };
    for (const control of [box, write, header]) control.addEventListener("change", sync);
    return h("div", { class: "row" }, box, h("span", { class: "grow" }, h("div", { class: "scope-name mono" }, secret.name), h("div", { class: "tiny subtle" }, `${secret.origin}${usedLine(secret.name)}`)), header, h("label", { class: "row tiny" }, write, h("span", {}, "Writes too")));
  });
  const dailyTurns = h("input", { class: "input", type: "number", min: 0, max: 1000, step: 1, required: true, value: seed?.dailyTurns ?? 40 });
  const enabled = h("input", { type: "checkbox", checked: existing?.enabled ?? true });
  const appearance = avatarEditor({ id: () => id.value, name: () => name.value, profile: seed?.avatar });
  name.addEventListener("input", () => appearance.refreshIdentity());
  id.addEventListener("input", () => appearance.refreshIdentity());
  // A job the primary wrote is its brief to this worker, and is told to it as its. Changing it here makes it yours.
  const author = existing?.instructionsBy && existing.instructionsBy !== "owner" ? (existing.instructionsBy === "primary" ? "Your agent" : (snapshot?.agents.find((person) => person.id === existing.instructionsBy)?.name ?? existing.instructionsBy)) : null;
  const form = editor(ctx, existing ? `Edit ${existing.name}` : "New agent", "An agent at your Agents, beside your agent: a name, a lasting job and a workspace of its own.", [
    // A new agent may start from an agent file of yours (invincible agents export, or an agent's page): shown here to check.
    !existing && !draft ? h("div", { class: "row" }, button("From an agent file", { size: "sm", variant: "ghost", icon: "folder", onClick: () => takeInAgent(ctx, () => form.close()) })) : null,
    draft ? callout("info", `From an agent file: check it, then create it here.${draft.keys?.length ? ` Where it came from it was given ${draft.keys.join(", ")}; none is given here unless you tick it below.` : ""}`, { title: `${draft.name}, taken in` }) : null,
    appearance.element,
    existing && author ? callout("info", `${author} wrote this job when making ${existing.name}, and it is told to ${existing.name} as ${author === "Your agent" ? "your agent" : author}'s brief. Change its words here and the instructions are yours.`, { title: `Made by ${author}` }) : null,
    field("Name", name), field("Handle", id, { hint: "Used to address this agent. It stays the same after a rename." }),
    field("Job and instructions", instructions, { hint: "No keys or passwords. Those belong in the vault." }),
    field("Repository (optional)", repository, { hint: "An HTTPS GitHub repository. Tasks get their own worktrees in the VM." }),
    h("div", { class: "team-form-grid" }, field("Coding harness", harness, { hint: "Selecting a harness doesn't install it or sign it in: that is yours to do, in the agent's VM. Workspace checks show what's ready." }), field("Model role", role, { hint: roleHint })),
    acpField,
    offered.length || own.length ? h("fieldset", { class: "team-fieldset" }, h("legend", {}, "Models"), modelList, h("label", { class: "row" }, sensitive, h("span", {}, "Sensitive mode: only these models, for everything it does")), h("p", { class: "tiny subtle" }, modelsHint, ". A local model runs on the node that serves it, for an agent on your agent's own harness: a vendor's coding tool can't use one.")) : null,
    keyRows.length || keys.length ? h("fieldset", { class: "team-fieldset" }, h("legend", {}, "Keys it may use"), ...keyRows, h("p", { class: "tiny subtle" }, "Its scripts call $INVINCIBLE_KEYS/<name>/… with $INVINCIBLE_TOKEN where the key would go: the gateway puts the key in, at its own address alone, and the key never enters its VM. Reads only, unless Writes too. A secret of yours is offered here once it is pinned to its API's https address (invincible secret set <name> --base-url https://…); a model's or a connector's key never is.")) : null,
    field("Daily turn and job budget", dailyTurns, { hint: "Maximum reply turns and jobs per day, not a money limit. Zero holds new work." }),
    h("label", { class: "row" }, enabled, h("span", {}, "Enabled")),
  ], existing ? "Save agent" : "Create agent", async () => {
    if (findSecrets(instructions.value).length) throw new Error("Instructions contain something that looks like a secret. Keep it in the vault.");
    if (sensitive.checked && !own.length) throw new Error("Sensitive mode holds an agent to models of its own: choose them first.");
    if (harness.value === "acp" && !acp.value.trim()) throw new Error("Name the command that starts its ACP agent, e.g. goose acp.");
    await ctx.api.post("/api/team/agents", { id: id.value, name: name.value.trim(), avatar: appearance.value(), instructions: instructions.value, repository: repository.value.trim() || null, harness: harness.value, ...(harness.value === "acp" ? { acp: acp.value.trim() } : {}), keys: keys.length ? keys : null, role: role.value, models: own.length ? own : null, sensitive: sensitive.checked, enabled: enabled.checked, dailyTurns: Number(dailyTurns.value) });
    toast(existing ? "Agent saved" : "Agent created");
  });
}

export function editRoom(ctx: Ctx, existing?: TeamRoom): void {
  const agents = ctx.live.team.value?.agents ?? [];
  if (!agents.length) return void editAgent(ctx);
  const name = h("input", { class: "input", required: true, maxlength: 100, value: existing?.name ?? "", placeholder: "e.g. Product studio" });
  const budget = h("input", { class: "input", type: "number", min: 1, max: 64, step: 1, required: true, value: existing?.turnBudget ?? 8 });
  const selected = new Set(existing?.members ?? []);
  const choices = h("div", { class: "team-member-choices" }, ...agents.map((person) => {
    const box = h("input", { type: "checkbox", checked: selected.has(person.id), disabled: Boolean(existing?.direct) });
    box.addEventListener("change", () => box.checked ? selected.add(person.id) : selected.delete(person.id));
    return h("label", { class: "team-member-choice" }, box, workerAvatar({ id: person.id, name: person.name, profile: person.avatar, still: true }), h("span", {}, person.name, h("span", { class: "meta" }, person.role)));
  }));
  editor(ctx, existing ? "Room settings" : "New room", "These agents share this conversation and coordinate within its reply budget.", [
    field("Name", name), h("fieldset", { class: "team-fieldset" }, h("legend", {}, "Agents"), choices),
    field("Reply budget per conversation chain", budget, { hint: "Includes autonomous handoffs. A new message from you starts a new chain." }),
  ], existing ? "Save room" : "Create room", async () => {
    if (!selected.size) throw new Error("Choose at least one agent.");
    const result = await ctx.api.post<{ room: TeamRoom }>("/api/team/rooms", { ...(existing ? { id: existing.id, direct: existing.direct } : {}), name: name.value.trim(), members: [...selected], turnBudget: Number(budget.value) });
    goRoom(ctx, result.room.id);
  });
}

/** An agent's own conversation with you: the one there is, or (from a device that may) a new one. */
export async function openDirect(ctx: Ctx, person: Pick<Agent, "id">): Promise<void> {
  const existing = ctx.live.team.value?.rooms.find((item) => item.direct && item.members.length === 1 && item.members[0] === person.id);
  if (existing) return goRoom(ctx, existing.id);
  if (!ctx.can("fleet:admin")) return void toast("This device can read existing conversations", { description: "Creating a direct chat needs fleet:admin access on an owner device." });
  try {
    const result = await ctx.api.post<{ room: TeamRoom }>("/api/team/direct", { id: person.id });
    await ctx.live.refreshTeam();
    goRoom(ctx, result.room.id);
  } catch (error) { if (!isAbort(error)) toast("Couldn't open the conversation", { tone: "error", description: errorMessage(error) }); }
}

/** Pause, resume or stop a room, an agent or a task. Resolves to whether the node took it. */
export async function controlTeam(ctx: Ctx, change: TeamControlInput): Promise<boolean> {
  try {
    await ctx.api.post("/api/team/control", change);
    await ctx.live.refreshTeam();
    return true;
  } catch (error) { if (!isAbort(error)) toast("Couldn't change the work", { tone: "error", description: errorMessage(error) }); return false; }
}

export function editNotes(ctx: Ctx, person: Agent): void {
  const text = h("textarea", { class: "input", rows: 14, maxlength: TEAM_LIMITS.memory }, person.memory);
  editor(ctx, `${person.name}'s working notes`, "Local working context for this agent. Knowledge the agents share belongs in Memory.", [field("Working notes", text, { hint: "Keep task context here. No credentials." })], "Save notes", async () => {
    if (findSecrets(text.value).length) throw new Error("This looks like it contains a secret. Keep it in the vault.");
    await ctx.api.post("/api/team/memory", { id: person.id, text: text.value });
  });
}

/** An agent's verified work as a pull request, on your word: its title yours to change, then opened with the connector's key. */
export function shipTask(ctx: Ctx, task: TeamTask): void {
  const title = h("input", { class: "input", required: true, maxlength: 120, value: task.title.slice(0, 120) });
  const files = task.changes ? `${task.changes.files} file${task.changes.files === 1 ? "" : "s"}` : "Its changes";
  editor(ctx, "Ship it as a pull request?", `${files}, on a new invincible/… branch of its repository, as it was verified. Its checks are followed after.`, [field("Pull request title", title)], "Open pull request", async () => {
    const shipped = await ctx.api.post<{ url: string | null; pr: number | null }>("/api/team/ship", { task: task.id, title: title.value.trim() });
    toast(shipped.pr ? `Pull request #${shipped.pr} opened` : "Pull request opened", { tone: "info", ...(shipped.url ? { action: { label: "Open", run: () => window.open(shipped.url!, "_blank", "noopener") } } : {}) });
  });
}

/**
 * Words for a running task (a steer, POST /api/team/steer): its run takes them at its next safe point, and its reviewer
 * judges the work against them. Refused in the node's words when it has ended meanwhile; nothing secret-shaped is sent.
 */
export function steerTask(ctx: Ctx, task: TeamTask, name: string): void {
  const words = h("textarea", { class: "input", required: true, rows: 4, maxlength: TEAM_LIMITS.steer, placeholder: "Use the new schema." });
  editor(ctx, `Steer “${task.title}”`, `${name} takes your words at the task's next safe point: a command it's running finishes first. The task's reviewer judges the work against them.`, [field("What it should take up", words)], STEER_WORDS.steer, async () => {
    const text = words.value.trim();
    if (findSecrets(text).length) throw new Error("That looks like a secret. Remove it before sending; keys belong in the vault.");
    await ctx.api.post("/api/team/steer", { task: task.id, text });
    toast(`Steered: ${name} takes it at its next safe point`, { tone: "info" });
  });
}

/** Removing a worker is for good: said plainly first, with its handle typed to confirm. Its VM goes with it. */
export async function removeAgent(ctx: Ctx, person: Agent): Promise<void> {
  const plan = removalPlan(person, { sandbox: ctx.can("sandbox") });
  if (plan.blocked) { toast("This device can't remove it", { tone: "error", description: plan.blocked }); return; }
  const ok = await confirmAction({ title: `Remove ${person.name}?`, body: plan.lines.map((line) => h("p", {}, line)), confirmLabel: plan.destroyWorkspace ? "Remove and destroy its VM" : "Remove", tone: "danger", typeToConfirm: person.id });
  if (!ok) return;
  try {
    await ctx.api.post("/api/team/remove", { id: person.id, ...(plan.destroyWorkspace ? { destroyWorkspace: true } : {}) });
    toast(`${person.name} was removed`, { tone: "info" });
    await ctx.live.refreshTeam();
    // Its own conversation is no longer one of the open ones: back to the roster.
    ctx.navigate("team");
  } catch (error) { if (!isAbort(error)) toast("Couldn't remove it", { tone: "error", description: errorMessage(error) }); }
}

/**
 * A task for one of a conversation's agents: its goal and the commands that prove it. `copy`: what was asked of one
 * before (lib/timeline.ts' giveAgain), to give again as it was or revised.
 */
export function giveTask(ctx: Ctx, room: TeamRoom, copy?: TeamTaskInput): void {
  const snapshot = ctx.live.team.value;
  const members = room.members.flatMap((id) => snapshot?.agents.find((person) => person.id === id) ?? []);
  const title = h("input", { class: "input", required: true, maxlength: 200, value: copy?.title ?? "", placeholder: "A concrete result" });
  const goal = h("textarea", { class: "input", required: true, rows: 6, maxlength: 8000, placeholder: "What should be built or investigated, and what proves it is complete?" }, copy?.goal ?? "");
  const assignee = h("select", { class: "select", required: true }, ...members.map((person) => h("option", { value: person.id, selected: person.id === copy?.assignee }, `${person.name} · ${HARNESS[person.harness]}`)));
  const gates = h("textarea", { class: "input mono", rows: 3, placeholder: "bun run check\nbun test path/to/test.ts" }, copy?.gates?.join("\n") ?? "");
  const budget = h("input", { class: "input tnum", inputmode: "decimal", maxlength: 10, placeholder: "0.50", autocomplete: "off" });
  if (copy?.budgetUsd) budget.value = String(copy.budgetUsd);
  const dependencies = new Set(copy?.dependsOn ?? []);
  const candidates = snapshot?.tasks.filter((task) => task.room === room.id) ?? [];
  const choices = h("div", { class: "team-dependency-choices" }, ...candidates.map((task) => {
    const box = h("input", { type: "checkbox", checked: dependencies.has(task.id) });
    box.addEventListener("change", () => box.checked ? dependencies.add(task.id) : dependencies.delete(task.id));
    return h("label", { class: "row" }, box, h("span", {}, task.title), badge(task.status, WORK_TONE[task.status]));
  }));
  const agent = room.direct && members.length === 1 ? members[0]!.name : null;
  // Sensitive mode for this task alone: on its agent's own models, or (given again) the ones it was held to. An agent in
  // sensitive mode holds every task of its so already.
  const held = h("input", { type: "checkbox", checked: Boolean(copy?.models?.length) });
  const heldWords = h("span", {});
  const heldRow = h("label", { class: "row" }, held, heldWords);
  const heldModelsOf = (): readonly string[] | null => copy?.models?.length ? copy.models : (members.find((person) => person.id === assignee.value)?.models ?? []).length ? members.find((person) => person.id === assignee.value)!.models! : null;
  const sayHeld = () => {
    const person = members.find((each) => each.id === assignee.value);
    const models = heldModelsOf();
    held.disabled = Boolean(person?.sensitive) || !models;
    if (person?.sensitive) held.checked = false;
    heldWords.textContent = person?.sensitive ? `${person.name} is in sensitive mode: this task is too, on its own models.` : models ? `Sensitive mode for this task: on ${models.join(", ")} alone, for every call of its work.` : `Sensitive mode for this task needs models of ${person?.name ?? "its agent"}'s own: choose them in its settings.`;
  };
  assignee.addEventListener("change", sayHeld);
  sayHeld();
  // Given again from a step of it (PLAN #15): its workspace as it stood after that step.
  const fromStep = copy?.from ? callout("info", `It starts from step ${copy.from.step} of the task it gives again: its workspace as it stood after that step. What came after is set aside, and stays that task's.`) : null;
  editor(ctx, copy ? (copy.from ? `Give this task again from step ${copy.from.step}` : "Give this task again") : agent ? `Give ${agent} a task` : "Give a task", "Its goal, and the commands that prove it is done. An agent works in its own workspace; the commands and an independent reviewer decide whether the work is verified.", [
    fromStep,
    field("Title", title), members.length > 1 && !copy?.from ? field("Assigned to", assignee) : null, field("Goal", goal),
    candidates.length ? h("fieldset", { class: "team-fieldset" }, h("legend", {}, "Wait for these tasks"), choices) : null,
    field("Done when these pass", gates, { hint: "One shell command a line, up to 16. They run in the agent's workspace." }),
    field("Budget in US dollars (optional)", budget, { hint: "US dollars at your prices: what its model calls may spend. It is told what it has spent, and stops with what it has when it is spent." }),
    heldRow,
  ], "Give task", async () => {
    if (findSecrets(goal.value).length) throw new Error("The goal contains something that looks like a secret.");
    const checks = gatesFrom(gates.value);
    if ("error" in checks) throw new Error(checks.error);
    const money = budgetFrom(budget.value);
    if ("error" in money) throw new Error(money.error);
    const models = held.checked && !held.disabled ? heldModelsOf() : null;
    await ctx.api.post("/api/team/tasks", { room: room.id, assignee: assignee.value, title: title.value.trim(), goal: goal.value.trim(), dependsOn: [...dependencies], gates: checks.gates, ...(money.usd ? { budgetUsd: money.usd } : {}), ...(models ? { models: [...models] } : {}), ...(copy?.from ? { from: copy.from } : {}), ...(copy?.again ? { again: copy.again } : {}) });
  });
}

/**
 * A task given to the agents: the agent best suited to it takes it (POST /api/team/give), and the sheet then says
 * who and why, and how each of the others stood. Beside that, the same task to one agent by name, in its own
 * conversation with you. What it needs of the agent (a desktop, a repository) is the agents' to weigh.
 */
export function giveToAgents(ctx: Ctx): void {
  const agents = ctx.live.team.value?.agents ?? [];
  if (!agents.length) return void editAgent(ctx);
  const goal = h("textarea", { class: "input", name: "goal", required: true, rows: 5, maxlength: 8000, placeholder: "What should be done, and what shows it is done?" });
  const title = h("input", { class: "input", name: "title", maxlength: 200, placeholder: "A short name for it", autocomplete: "off" });
  const gates = h("textarea", { class: "input mono", name: "gates", rows: 3, placeholder: "bun test\ntest -s export.csv" });
  const budget = h("input", { class: "input tnum", inputmode: "decimal", maxlength: 10, placeholder: "0.50", autocomplete: "off" });
  const who = h("select", { class: "select", name: "who" }, h("option", { value: "" }, "The agents: the agent best suited to it"), ...agents.map((person) => h("option", { value: person.id }, `${person.name}${person.enabled ? "" : " (paused)"}`)));
  const desktop = h("input", { type: "checkbox", name: "desktop" });
  const repository = h("input", { class: "input mono", name: "repository", type: "url", maxlength: 300, placeholder: "https://github.com/owner/repository", autocomplete: "off" });
  const needs = h("div", { class: "stack" }, h("label", { class: "row" }, desktop, h("span", {}, "It needs a desktop: a screen and a browser")), field("Only on this repository (optional)", repository, { hint: "Only an agent that works on it can take the task." }));
  who.addEventListener("change", () => (needs.hidden = who.value !== ""));
  const error = h("div", { role: "status" });
  const submit = button("Give task", { variant: "primary", type: "submit" });
  const form = h(
    "form",
    { class: "stack" },
    field("Goal", goal),
    field("Title (optional)", title),
    field("Done when these pass", gates, { hint: "One shell command a line, up to 16. They run in the agent's workspace, and a reviewer who did not do the work checks it." }),
    field("Budget in US dollars (optional)", budget, { hint: "US dollars at your prices: what its model calls may spend. It is told what it has spent, and stops with what it has when it is spent." }),
    field("Who takes it", who),
    needs,
    error,
  );
  const sheet = openSheet({ title: "Give a task", description: "The agent best suited to a task takes it, and says why.", size: "wide", body: form, footer: [button("Cancel", { onClick: () => sheet.close() }), submit] });
  const face = (id: string, name: string, size: number) => workerAvatar({ id, name, profile: agents.find((person) => person.id === id)?.avatar, still: true, size });

  function answered(answer: Given): void {
    const given = givenTo(answer);
    replace(
      sheet.body,
      h(
        "div",
        { class: "give-result stack loose", role: "status" },
        h("div", { class: "give-choice" }, face(given.id, given.name, 48), h("div", { class: "grow" }, h("h3", {}, `${given.name} takes it`), h("p", { class: "muted" }, given.why))),
        given.others.length
          ? h("div", { class: "stack" }, h("strong", { class: "small" }, "How the others stood"), h("div", { class: "card rows" }, ...given.others.map((other) => h("div", { class: "item", "data-could": String(other.could) }, face(other.id, other.name, 28), h("div", { class: "grow" }, h("strong", { class: "small" }, other.name), h("p", { class: "meta" }, other.line))))))
          : null,
        h("p", { class: "small subtle" }, `It is queued in ${given.name}'s own conversation with you. Its commands and an independent reviewer decide whether the work is verified.`),
      ),
    );
    replace(sheet.foot, button("Done", { onClick: () => sheet.close() }), button(`Open ${given.name}`, { variant: "primary", onClick: () => (sheet.close(), ctx.navigate("team", { room: given.room })) }));
  }

  async function give(): Promise<void> {
    // (Enter while it is being given gives it once.)
    if (submit.getAttribute("aria-busy") === "true") return;
    replace(error);
    if (!form.reportValidity()) return;
    if (findSecrets(goal.value).length) return void replace(error, callout("danger", "The goal contains something that looks like a secret. Keep it in the vault."));
    const checks = gatesFrom(gates.value);
    if ("error" in checks) return void replace(error, callout("danger", checks.error));
    const money = budgetFrom(budget.value);
    if ("error" in money) return void replace(error, callout("danger", money.error));
    await busy(submit, async () => {
      try {
        if (who.value) {
          // By name: in that agent's own conversation with you.
          const { room } = await ctx.api.post<{ room: TeamRoom }>("/api/team/direct", { id: who.value });
          await ctx.api.post("/api/team/tasks", { room: room.id, assignee: who.value, title: title.value.trim() || goal.value.trim().slice(0, 200), goal: goal.value.trim(), gates: checks.gates, ...(money.usd ? { budgetUsd: money.usd } : {}) });
          sheet.close();
          void ctx.live.refreshTeam();
          ctx.navigate("team", { room: room.id });
          return;
        }
        const answer = await ctx.api.post<Given>("/api/team/give", giveInput({ goal: goal.value, title: title.value, gates: checks.gates, desktop: desktop.checked, repository: repository.value, budgetUsd: money.usd }));
        void ctx.live.refreshTeam();
        answered(answer);
      } catch (failure) {
        if (!sheet.scope.disposed && !isAbort(failure)) replace(error, callout("danger", errorMessage(failure), { title: "It wasn't given" }));
      }
    });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void give();
  });
  submit.addEventListener("click", (event) => {
    event.preventDefault();
    void give();
  });
}

/** What an agent's VM can reach: chosen when it is made, or made again (a microVM's network can't be changed afterwards). */
const networkChoice = (online: boolean): HTMLSelectElement =>
  h("select", { class: "select" }, h("option", { value: "online", selected: online }, "The internet, and your agent's model gateway"), h("option", { value: "gateway", selected: !online }, "Your agent's model gateway only"));

export function provisionVm(ctx: Ctx, person: Agent, done: (workspace: SandboxView | null) => void): void {
  const nodes = (ctx.live.fleet.value?.devices ?? []).filter((node) => node.kind === "node" && !node.revokedAt && asCaps(node.caps)?.sandbox?.vm);
  const host = h("select", { class: "select" }, h("option", { value: "" }, "Let your agent choose a VM host"), ...nodes.map((node) => h("option", { value: node.name }, node.name)));
  const cpus = h("input", { class: "input", type: "number", min: 1, max: 64, step: 1, value: 2, required: true });
  const memory = h("input", { class: "input", type: "number", min: 1, max: 256, step: 1, value: 4, required: true });
  const disk = h("input", { class: "input", type: "number", min: 1, max: 2048, step: 1, value: 20, required: true });
  const network = networkChoice(true);
  const desktop = desktopChoice(true);
  editor(ctx, `Workspace for ${person.name}`, "Provision a persistent microVM on a capable fleet node. Provisioning fails if a VM isn't available.", [
    field("Machine", host), h("div", { class: "team-form-grid" }, field("CPUs", cpus), field("Memory (GB)", memory), field("Disk (GB)", disk, { hint: "Requires the host's workspace helper. Otherwise disk is unlimited." })),
    field("It can reach", network, { hint: "Set when the VM is made. Online, it can fetch packages and sign a coding tool in to its own account; whatever is kept in the VM can then leave it." }),
    desktop.el,
    callout("info", "The workspace keeps its files between tasks. Model access goes through the gateway; keys stay outside the VM."),
  ], person.workspace ? "Check / provision VM" : "Provision VM", async () => {
    const result = await ctx.api.post<{ agent: Agent; workspace: SandboxView | null }>("/api/team/provision", { id: person.id, ...(host.value ? { on: host.value } : {}), cpus: Number(cpus.value), memoryGb: Number(memory.value), diskGb: Number(disk.value), network: network.value, ...(desktop.box.checked ? {} : { desktop: false }), ...(desktop.hardware.checked ? { hardware: true } : {}) });
    toast(result.workspace ? "Workspace ready" : "Workspace saved; checking status", result.workspace && desktop.box.checked && !hasDesktop(result.workspace) ? { description: "Made without a desktop: its host makes none (a Mac). The ledger says why." } : undefined);
    done(result.workspace);
  });
}

/** Its VM made again from its image as it is now: the same VM and /work, a new container. `want`: a desktop chosen already. */
export function remakeVm(ctx: Ctx, person: Pick<Agent, "id" | "name">, workspace: SandboxView, done: (workspace: SandboxView) => void, want: { desktop?: boolean } = {}): void {
  const network = networkChoice(workspace.network === "online");
  const desktop = desktopChoice(want.desktop ?? hasDesktop(workspace), hasHardware(workspace));
  editor(ctx, `Make ${person.name}'s VM again`, "The same VM, made again from its image as it is now. A fix to the image, or a newer tool in it, reaches an agent only this way.", [
    field("It can reach", network, { hint: "May be chosen again here: nothing else changes it once a VM is made." }),
    desktop.el,
    callout("info", "Everything in /work is kept: its repository, its files, a coding tool's own sign-in. Whatever is running in the VM ends, so this is refused while the agent is working."),
  ], "Make VM again", async () => {
    const result = await ctx.api.post<{ agent: Agent; workspace: SandboxView }>("/api/team/remake", { id: person.id, network: network.value, desktop: desktop.box.checked, hardware: desktop.hardware.checked });
    toast(desktop.hardware.checked ? "VM made again, with a desktop and the hardware tools" : desktop.box.checked ? "VM made again, with a desktop" : "VM made again, with no desktop");
    done(result.workspace);
  });
}

/**
 * More for its VM while it runs: threads and memory given as it runs, its disk grown where it is mounted. Never less.
 * On a Mac (Apple's container) it pauses to take more threads or memory, and its disk can't grow: the form says so.
 */
export function growVm(ctx: Ctx, person: Pick<Agent, "id" | "name">, workspace: SandboxView, done: (workspace: SandboxView) => void): void {
  const host = (ctx.live.fleet.value?.devices ?? []).find((node) => node.id === workspace.node);
  const words = growWords(asCaps(host?.caps ?? null)?.sandbox?.grows === false);
  const more = (now: number, max: number, step: number) => h("input", { class: "input", type: "number", min: now, max, step, value: now, required: true });
  const cpus = more(workspace.cpus, 64, 1);
  const memory = more(workspace.memoryGb, 512, 1);
  const disk = workspace.disk && words.disk ? more(workspace.disk.limitGb, 4096, 1) : null;
  editor(ctx, `Give ${person.name}'s VM more`, words.intro, [
    h("div", { class: "team-form-grid" }, field("CPUs", cpus), field("Memory (GB)", memory), disk ? field("Disk (GB)", disk) : null),
    callout("info", `More only. What it adds must fit this node's ceiling. A smaller size takes effect when the VM is made again.${disk || !words.disk ? "" : " Its disk has no size of its own to grow: it was made before workspaces had one."}`),
  ], "Give it more", async () => {
    const asked = {
      ...(Number(cpus.value) !== workspace.cpus ? { cpus: Number(cpus.value) } : {}),
      ...(Number(memory.value) !== workspace.memoryGb ? { memoryGb: Number(memory.value) } : {}),
      ...(disk && Number(disk.value) !== workspace.disk!.limitGb ? { diskGb: Number(disk.value) } : {}),
    };
    if (!Object.keys(asked).length) return;
    const result = await ctx.api.post<{ agent: Agent; workspace: SandboxView; paused?: boolean }>("/api/team/resize", { id: person.id, ...asked });
    const now = result.workspace;
    toast(`${person.name}'s VM has more`, { description: `${now.cpus} CPUs · ${now.memoryGb} GB memory${now.disk ? ` · ${now.disk.limitGb} GB disk` : ""}, ${growWords(result.paused === true).done}` });
    done(now);
  });
}

/**
 * Whether an agent's VM has a desktop: every one does unless you say otherwise (the owner's standard, 26 November 2026),
 * chosen when it is made or made again. `box` is checked for a desktop; what you tick is "No desktop". And whether its
 * desktop has the hardware tools (C1 step 11), a choice per agent: they come with a desktop, so without one they can't
 * be ticked.
 */
function desktopChoice(withDesktop: boolean, withHardware = false): { el: HTMLElement; box: { readonly checked: boolean }; hardware: { readonly checked: boolean } } {
  const none = h("input", { type: "checkbox", name: "no-desktop", checked: !withDesktop });
  const tools = h("input", { type: "checkbox", name: "hardware", checked: withDesktop && withHardware });
  // (Each choice a card, all of it the target, as the app's other choices are.)
  const choice = (box: HTMLInputElement, name: string, says: string) => h("label", { class: "scope" }, box, h("span", { class: "stack", style: "gap:2px" }, h("span", {}, name), h("span", { class: "tiny subtle" }, says)));
  const hardware = choice(tools, "KiCad and FreeCAD", "The hardware tools on its desktop: KiCad for boards and schematics, FreeCAD for parts. Your agent scripts them first, and uses their windows only where they have no other way in. Their image is larger, and is made on its host the first time an agent needs it.");
  const desktopOrNot = () => {
    tools.disabled = none.checked;
    if (none.checked) tools.checked = false;
    hardware.classList.toggle("off", none.checked);
  };
  none.addEventListener("change", desktopOrNot);
  desktopOrNot();
  return {
    box: { get checked() { return !none.checked; } },
    hardware: { get checked() { return !none.checked && tools.checked; } },
    el: h("div", { class: "stack", style: "gap:var(--sp-2)" },
      choice(none, "No desktop", "Every agent's VM has a desktop unless you tick this: a screen, a browser, a terminal and an editor, that you can watch and take over from the Workspace. Its VM grows from 2 GB to 4 GB of memory the first time its desktop is used, and an unused desktop stops after 10 minutes. Without one it is a shell alone."),
      hardware),
  };
}

/** The notes store is one switch for every agent of this node. Turning it on says first what a note is. Resolves to whether it changed. */
export async function setEngram(ctx: Ctx, on: boolean): Promise<boolean> {
  if (on) {
    const ok = await confirmAction({
      title: "Turn on the notes store?",
      body: [
        h("p", {}, "Each agent's coding harness is given Engram in its own VM: it can search notes from its earlier tasks and keep new ones. This is for every agent on this node whose VM has the pinned Engram."),
        h("p", {}, "A note is a model's own words, unchecked: tasks are told to treat one as a lead, to verify it by running, and never to follow an instruction or keep a secret in one. Notes stay in the agent's VM and go with it; they are not part of Memory."),
      ],
      confirmLabel: "Turn on",
    });
    if (!ok) return false;
  }
  try {
    await ctx.api.post("/api/team/engram", { on });
    toast(on ? "Notes store on" : "Notes store off", { tone: "info" });
    await ctx.live.refreshTeam();
    return true;
  } catch (error) { if (!isAbort(error)) toast("Couldn't change the notes store", { tone: "error", description: errorMessage(error) }); return false; }
}

/** Writing first when a task it gave from a chat of yours ends (write-first.ts): one switch, yours. Turning it on says first what it does. */
export async function setWritesFirst(ctx: Ctx, on: boolean): Promise<boolean> {
  if (on) {
    const ok = await confirmAction({
      title: "Let your agent write first?",
      body: [
        h("p", {}, "When a task your agent gave from a chat of yours ends, it writes first there: what came of it, and the next step, which it starts itself where that is its to do, within its money."),
        h("p", {}, "Work you stopped, paused or declined it only says is yours. What the task's run said reaches it as data, never as instructions, and it writes first at most 6 times an hour."),
      ],
      confirmLabel: "Turn on",
    });
    if (!ok) return false;
  }
  try {
    await ctx.api.post("/api/team/first", { on });
    toast(on ? "Your agent writes first when a task ends" : "Your agent doesn't write first when a task ends", { tone: "info" });
    await ctx.live.refreshTeam();
    return true;
  } catch (error) { if (!isAbort(error)) toast("Couldn't change it", { tone: "error", description: errorMessage(error) }); return false; }
}

/** Failing checks and reviews back to the agent whose work it was (PLAN #29): one switch for every agent here. Turning it on says first what it does. */
export async function setCiBack(ctx: Ctx, on: boolean): Promise<boolean> {
  if (on) {
    const ok = await confirmAction({
      title: "Give failing checks and reviews back?",
      body: [
        h("p", {}, "When a pull request of an agent's work fails its checks, or someone GitHub says may push asks for changes in a review, that agent gets the fix as a task on the pull request's branch, without asking you: on your agent's own word within its money, once for each commit that failed or review, three times at most, and 3 fixes and $3 a day at most, so they never take what you ask of it."),
        h("p", {}, "Never to an agent or a conversation you paused, nor once you stopped a fix of a pull request or declined its push: those stay yours, as does a failure it said was yours. Anyone else's review is noticed, yours to weigh."),
        h("p", {}, "Its fix is checked by its gates and an independent reviewer, and pushed onto the branch on your agent's own approval (never forced), as it may in a repository you gave an agent, unless it changes what the repository's CI runs or the branch moved since it last pushed it."),
      ],
      confirmLabel: "Turn on",
    });
    if (!ok) return false;
  }
  try {
    await ctx.api.post("/api/team/ci", { on });
    toast(on ? "Failing checks and reviews go back to the agent" : "Failing checks and reviews stay yours", { tone: "info" });
    await ctx.live.refreshTeam();
    return true;
  } catch (error) { if (!isAbort(error)) toast("Couldn't change it", { tone: "error", description: errorMessage(error) }); return false; }
}
