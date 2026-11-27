import { capLabel, TEAM_LIMITS, interventionWords, agentFromFile, agentToFile, plainLine, plainText, type Prices, type TeamChangesView, type TeamFilesView, type TeamFileView, type RouteName, taskRecordFacts, type TeamModelChoice, type TeamSnapshot, type TeamRoomView, type TeamRoom, type TeamTask, type Agent, type TeamCheckpoint, mergeRepository } from "@invincible/core";
import { MARK_PALETTE, markForm, markOf } from "@invincible/core/agent-mark";

/** An agent's mark as the CLI says it (agent-mark.ts): its hue's name and both its forms (light page, dark page), and its
 * form: its number, how many slots, at what angle. */
function markJson(id: string, avatar: unknown): string {
  const mark = markOf(id, avatar);
  const hue = MARK_PALETTE[mark.color]!;
  return JSON.stringify({ name: hue.name, light: hue.light, dark: hue.dark, form: mark.form, ...markForm(mark.form) });
}

interface Api { call<T>(name: RouteName, input?: unknown): Promise<T> }
type Flags = Record<string, unknown>;
/* A terminal acts on what it is sent, and names, titles, notes and messages are a model's words or anyone's:
 * they are printed as plain text (plain.ts). A message keeps its lines, each later one indented, so a line
 * that starts at the margin is always a new speaker and never something a message said. A terminal folds a
 * line wider than itself back to the margin, so at one (`columns`) every line is folded here first, inside its
 * width and indented; where the output goes elsewhere there is no width to fold to, and lines are left whole. */
const spoken = (who: string, text: string) => `${plainLine(who)}: ${plainText(text).trimEnd().split("\n").join("\n  ")}`;

/** One line as a terminal `width` columns wide shows it without folding any itself: its start, then the rest indented, each cut at a space where there is one. */
export function foldLine(line: string, width: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let room = width; Bun.stringWidth(rest) > room; room = width - 2) {
    let cut = 0;
    let wide = 0;
    for (const ch of rest) {
      const w = Bun.stringWidth(ch);
      if (cut && wide + w > room) break;
      wide += w;
      cut += ch.length;
    }
    // At its last space, unless that would leave most of the line empty (a long word, or writing without spaces).
    const space = rest.lastIndexOf(" ", cut);
    const at = space >= cut / 2 ? space : cut;
    out.push(`${out.length ? "  " : ""}${rest.slice(0, at).trimEnd()}`);
    rest = rest.slice(at).trimStart();
  }
  out.push(`${out.length ? "  " : ""}${rest}`);
  return out;
}
/** What a task's run came to, for its line in the listing (taskRecordFacts). Empty for a task with no record (not run, or from before them). */
export const taskRecordLine = (task: Pick<TeamTask, "record">, prices: Prices): string => (task.record ? taskRecordFacts(task.record, prices).map((fact) => ` · ${fact}`).join("") : "");
/** What a task changed in its repository and where that is kept (`invincible ship <artifact>` opens a pull request from it). Empty when it kept nothing. */
export const taskChangesLine = (task: Pick<TeamTask, "changes">): string => (task.changes ? ` · ${task.changes.files} file${task.changes.files === 1 ? "" : "s"} changed, kept as ${task.changes.artifact}` : "");

const usage = "invincible agents [add <id> | avatar <id> | models <id> [provider/model…] | sensitive <id> [on|off] [provider/model…] | dm <id> [message] | room <name> <member…> | chat <room> [message] | task <room> <assignee> <goal> [--sensitive] [--models provider/model,…] | steps <task-id> | again <task-id> [--from <step>] [goal] | keys <id> [add <secret> [--write] | rm <secret>] | export <id> [--out file.md] | import <file.md> [--id <new id>] [-y] | give <goal> | trail <task-id> [--follow] | provision <id> | memory <id> [text] | engram [on|off] | ci [on|off] | daily [<usd>] | merge <owner/repo> [on|off] | pause|resume|stop <room|agent|task> <id> | approve|decline <task-id> | remove <id> [--destroy-workspace] [--yes]]";

/** What an agent works on, in a sentence: its own models or its role's, and whether it is in sensitive mode. */
const agentModels = (m: Agent): string =>
  m.sensitive && m.models?.length
    ? `${m.id} is in sensitive mode: every call of its work (its plan, its review, its conversations, its coding tool) goes to ${m.models.join(", ")}, in that order, and to nothing else.`
    : m.models?.length ? `${m.id} works on ${m.models.join(", ")}, in that order.` : `${m.id} works on its role's models (${m.role}).`;

/** A size as a person says one. */
const bytesWord = (bytes: number) => (bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

export async function teamCommand(api: Api, sub: string | undefined, args: string[], flags: Flags, write: (s: string) => void = console.log, confirm: (question: string) => boolean = () => false, columns?: number): Promise<void> {
  // (Never narrower than twenty columns: below that there is no room to fold into.)
  const print = columns && columns >= 20 ? (text: string) => write(text.split("\n").flatMap((line) => foldLine(line, columns)).join("\n")) : write;
  const string = (key: string) => typeof flags[key] === "string" ? flags[key] as string : undefined;
  if (!sub || sub === "ls") {
    const state = await api.call<TeamSnapshot>("team");
    // (One the primary made for itself says so: in your conversation with it, or by the worker that asked for it.)
    const maker = (m: Agent) => (!m.createdBy || m.createdBy === "owner" ? "" : ` · made by ${m.createdBy === "primary" ? "your agent" : m.createdBy}`);
    for (const m of state.agents) print(`${m.id} · ${plainLine(m.name)}${m.sensitive ? " · sensitive mode" : ""} · ${m.harness} · ${m.enabled ? "enabled" : "paused"} · ${m.turnsToday}/${m.dailyTurns} turns today · ${m.workspace ? `VM ${m.workspace.id} on ${m.workspace.node}` : "VM not provisioned"}${maker(m)}`);
    // (One you removed is named still: its handle stays taken.)
    for (const m of state.removed ?? []) print(`${m.id} · ${plainLine(m.name)} · removed${m.conversations?.length ? ` · its conversations, kept to read: ${m.conversations.map((room) => `invincible agents chat ${room}`).join(", ")}` : ""}`);
    for (const r of state.rooms) print(`${r.id} · ${plainLine(r.name)} · ${r.members.join(", ")}${r.paused ? " · paused" : ""}`);
    // (Money is at your prices, asked for only when a task here has a record to price.)
    const prices: Prices = state.tasks.some((t) => t.record) ? (await api.call<{ prices: Prices }>("prices").catch(() => ({ prices: {} }))).prices : {};
    for (const t of state.tasks) print(`${t.id} · ${t.status}${t.verified ? " (verified)" : ""} · ${t.assignee} · ${plainLine(t.title)}${taskRecordLine(t, prices)}${taskChangesLine(t)}${t.status === "proposed" && t.proposedBy ? ` · proposed by ${t.proposedBy}: invincible agents approve ${t.id}` : ""}${interventionWords(t.interventions) ? ` · you stepped in: ${interventionWords(t.interventions)}` : ""}`);
    // The mandate's north star (#28): how often you stepped in, per task done and verified.
    const star = state.northStar;
    if (star?.ended) print(`You stepped in ${star.interventions} time${star.interventions === 1 ? "" : "s"} on the ${star.ended} task${star.ended === 1 ? "" : "s"} that ended in the last 30 days${star.perCompleted === null ? ", and none was done and verified." : `: ${star.perCompleted.toFixed(1)} a task done and verified (${star.completed}).`}`);
    if (!state.agents.length) print("Create an agent with invincible agents add <id> --name <name>, or open the agents in the app.");
    return;
  }
  if (sub === "add") {
    const id = args[0];
    const result = await api.call<{ agent: Agent }>("saveAgent", { id, name: string("name") ?? id, ...(string("instructions") ? { instructions: string("instructions") } : {}), ...(string("role") ? { role: string("role") } : {}), ...(string("harness") ? { harness: string("harness") } : {}), ...(string("acp") ? { acp: string("acp") } : {}), ...(string("repo") ? { repository: string("repo") } : {}), ...(string("limit") ? { dailyTurns: Number(string("limit")) } : {}) });
    print(`${plainLine(result.agent.name)} is ready to chat. Its VM is made on a node that makes VMs (KVM with Kata, or a Mac with Apple's container) when it is first needed.`); return;
  }
  if (sub === "models") {
    // An agent's own models, in place of its role's: shown with what you may choose, set in order, or given back (--role).
    const id = args[0];
    if (!id) throw new Error("usage: invincible agents models <agent> [provider/model…] [--role]");
    const agent = (await api.call<TeamSnapshot>("team")).agents.find((m) => m.id === id);
    if (!agent) throw new Error(`no agent ${id}`);
    const says = agentModels;
    const refs = args.slice(1).flatMap((arg) => arg.split(",")).map((ref) => ref.trim()).filter(Boolean);
    if (refs.length || flags.role === true) {
      const saved = await api.call<{ agent: Agent }>("saveAgent", { id, name: agent.name, models: flags.role === true ? null : refs });
      print(says(saved.agent)); return;
    }
    const { models } = await api.call<{ models: TeamModelChoice[] }>("teamModels");
    print(says(agent));
    print("To choose, in order: invincible agents models <agent> provider/model…; --role gives it its role's again. You may choose:");
    for (const m of models) print(`  ${m.ref}${m.on.length ? ` · on ${m.on.join(", ")}` : ""}`);
    return;
  }
  if (sub === "keys") {
    // Keys of yours it may use but never see (PLAN #17): listed, given (reads only unless --write), or taken back.
    const [id, verb, secret] = args;
    if (!id || (verb !== undefined && !((verb === "add" || verb === "rm") && secret))) throw new Error("usage: invincible agents keys <agent> [add <secret> [--header x-api-key] [--write] | rm <secret>]");
    const agent = (await api.call<TeamSnapshot>("team")).agents.find((m) => m.id === id);
    if (!agent) throw new Error(`no agent ${id}`);
    let keys = agent.keys ?? [];
    if (verb === "add") keys = [...keys.filter((k) => k.secret !== secret), { secret: secret!, header: string("header") ?? "authorization", write: flags.write === true }];
    if (verb === "rm") keys = keys.filter((k) => k.secret !== secret);
    if (verb) keys = (await api.call<{ agent: Agent }>("saveAgent", { id, name: agent.name, keys: keys.length ? keys : null })).agent.keys ?? [];
    if (!keys.length) { print(`${id} has no keys of yours to use. Give it one: invincible agents keys ${id} add <secret> (the secret pinned to its API's address: invincible secret set <secret> --base-url https://…)`); return; }
    // How often its scripts used each these last days (a node from before the count says nothing of it).
    const counted = await api.call<{ days?: number; uses?: Record<string, number> }>("teamKeyUses", { id }).catch(() => null);
    const uses = counted && typeof counted.uses === "object" && typeof counted.days === "number" ? { ...counted, uses: counted.uses } : null;
    const used = (secret: string) => (uses ? ` · used ${uses.uses[secret] ?? 0} time${(uses.uses[secret] ?? 0) === 1 ? "" : "s"} in ${uses.days} days` : "");
    for (const k of keys) print(`${k.secret} · ${k.write ? "reads and writes" : "reads only"} · in ${k.header === "authorization" ? "Authorization: Bearer" : k.header}${used(k.secret)}`);
    print(`Its scripts call $INVINCIBLE_KEYS/<secret>/<path> with $INVINCIBLE_TOKEN where the key would go; from its next task.`);
    return;
  }
  if (sub === "sensitive") {
    // Sensitive mode: every call of its work on its own models alone (heldModels). On with models names them its own.
    const id = args[0];
    const turn = args[1];
    if (!id || (turn !== undefined && turn !== "on" && turn !== "off")) throw new Error("usage: invincible agents sensitive <agent> [on [provider/model…] | off]");
    const agent = (await api.call<TeamSnapshot>("team")).agents.find((m) => m.id === id);
    if (!agent) throw new Error(`no agent ${id}`);
    if (turn === undefined) {
      print(agentModels(agent));
      if (!agent.sensitive) print(`To hold it to models of its own and nothing else: invincible agents sensitive ${id} on${agent.models?.length ? "" : " provider/model…"}`);
      return;
    }
    const refs = args.slice(2).flatMap((arg) => arg.split(",")).map((ref) => ref.trim()).filter(Boolean);
    if (turn === "off" && refs.length) throw new Error("Turning sensitive mode off names no models: invincible agents models chooses them.");
    const saved = await api.call<{ agent: Agent }>("saveAgent", { id, name: agent.name, sensitive: turn === "on", ...(refs.length ? { models: refs } : {}) });
    print(agentModels(saved.agent));
    return;
  }
  if (sub === "export") {
    // An agent as a file you carry (PLAN #20): who it is, its job and how it works; never its memory, its record or a key.
    const id = args[0];
    if (!id) throw new Error("usage: invincible agents export <agent> [--out file.md]");
    const agent = (await api.call<TeamSnapshot>("team")).agents.find((m) => m.id === id);
    if (!agent) throw new Error(`no agent ${id}`);
    const { text, scrubbed } = agentToFile({ ...agent, ...(agent.acp ? { acp: agent.acp } : {}), repository: agent.repository ?? undefined, keys: agent.keys?.map((k) => k.secret) });
    const out = string("out");
    if (!out) return void write(text.trimEnd());
    await Bun.write(out, text);
    print(`${plainLine(agent.name)} is in ${out}: its job and how it works, never its memory, its record or a key${agent.keys?.length ? ` (the names of the ${agent.keys.length} it was given, to give again where it goes)` : ""}.${scrubbed ? ` ${scrubbed} thing${scrubbed === 1 ? "" : "s"} in its job that looked like a key ${scrubbed === 1 ? "was" : "were"} taken out.` : ""} invincible agents import ${out} brings it in on another node.`);
    return;
  }
  if (sub === "import") {
    // An agent file in as a new agent here: shown first, then made by the same route as any agent you add.
    const path = args[0];
    if (!path) throw new Error("usage: invincible agents import <file.md> [--id <new id>] [-y]");
    const read = agentFromFile(path === "-" ? await Bun.stdin.text() : await Bun.file(path).text().catch(() => { throw new Error(`can't read ${path}`); }));
    if (!read.ok) throw new Error(`That isn't an agent file: ${read.why}.`);
    const k = read.agent;
    const id = string("id") ?? k.id;
    const state = await api.call<TeamSnapshot>("team");
    // (A handle is never anyone else's: an agent's here, or one you removed.)
    if ([...state.agents, ...(state.removed ?? [])].some((m) => m.id === id)) throw new Error(`There is an agent ${id} here already: invincible agents import ${path} --id <another id>`);
    print(`${plainLine(k.name)} (${id}) · ${k.harness ?? "native"}${k.acp ? ` running ${plainLine(k.acp)} in its VM` : ""} · ${k.sensitive && k.models?.length ? `sensitive mode, held to ${k.models.join(", ")}` : k.models?.length ? `works on ${k.models.join(", ")}` : `on its role's models (${k.role ?? "default"})`}${k.repository ? ` · ${k.repository}` : ""}`);
    if (k.instructions) print(`Its job: ${plainText(k.instructions).split("\n").find((line) => line.trim()) ?? ""}${k.instructions.includes("\n") ? " …" : ""}`);
    if (!flags.yes && !confirm(`Bring ${plainLine(k.name)} in as ${id}?`)) return;
    const saved = await api.call<{ agent: Agent }>("saveAgent", {
      id,
      name: k.name,
      ...(k.instructions ? { instructions: k.instructions } : {}),
      ...(k.role ? { role: k.role } : {}),
      ...(k.models?.length ? { models: k.models } : {}),
      ...(k.sensitive ? { sensitive: true } : {}),
      ...(k.harness ? { harness: k.harness } : {}),
      ...(k.acp ? { acp: k.acp } : {}),
      ...(k.repository ? { repository: k.repository } : {}),
      ...(k.dailyTurns !== undefined ? { dailyTurns: k.dailyTurns } : {}),
      ...(k.avatar ? { avatar: k.avatar } : {}),
    });
    print(`${plainLine(saved.agent.name)} is here as ${saved.agent.id}. Its VM is made when it is first needed.`);
    if (k.keys?.length) print(`Where it came from it was given ${k.keys.join(", ")}: none is given here unless you say so (invincible agents keys ${saved.agent.id} add <secret>).`);
    if (read.ignored.length) print(`Left out, not an agent's: ${read.ignored.join(", ")}.`);
    return;
  }
  if (sub === "avatar") {
    const state = await api.call<TeamSnapshot>("team");
    const member = state.agents.find((m) => m.id === args[0]);
    if (!member) throw new Error("No such agent");
    const color = string("color");
    if (flags.reset || color !== undefined) {
      // What isn't a colour is the node's to refuse: nothing here guesses at it.
      const { agent } = await api.call<{ agent: Agent }>("saveAgent", { id: member.id, name: member.name, avatar: flags.reset ? null : { v: 2, color: color!.trim().toLowerCase() } });
      print(markJson(agent.id, agent.avatar));
    } else print(markJson(member.id, member.avatar));
    return;
  }
  if (sub === "room") {
    const { room } = await api.call<{ room: TeamRoom }>("saveTeamRoom", { name: args[0], members: args.slice(1), ...(string("limit") ? { turnBudget: Number(string("limit")) } : {}) });
    print(`${room.id} · ${plainLine(room.name)}`); return;
  }
  if (sub === "dm" || sub === "chat") {
    const room = sub === "dm" ? (await api.call<{ room: TeamRoom }>("directAgent", { id: args[0] })).room.id : args[0];
    const text = args.slice(1).join(" ");
    if (text) { await api.call("postTeamMessage", { room, text }); print(`Sent to ${room}; replies continue on the node. Read with invincible agents chat ${room}.`); }
    else { const view = await api.call<TeamRoomView>("teamRoom", { id: room }); for (const m of view.messages) print(spoken(plainLine(m.speakerName) ? m.speakerName : m.speaker, m.text)); }
    return;
  }
  /** `--budget-usd 0.5`: money the task's model calls may spend, at your prices (none: no envelope). */
  const budget = (): { budgetUsd?: number } => {
    const raw = string("budget-usd");
    if (raw === undefined) return {};
    const usd = Number(raw);
    if (!Number.isFinite(usd) || usd <= 0 || usd > 100) throw new Error("--budget-usd takes an amount in US dollars above 0 and at most 100, e.g. --budget-usd 0.5");
    return { budgetUsd: usd };
  };
  if (sub === "task") {
    const goal = args.slice(2).join(" ");
    const gates = typeof flags.gate === "string" ? [flags.gate] : Array.isArray(flags.gate) ? flags.gate : [];
    // Sensitive mode for this task alone: on the models named (--models), or with none named its agent's own.
    let models = string("models")?.split(",").map((ref) => ref.trim()).filter(Boolean);
    if (flags.sensitive === true && !models?.length) {
      const agent = (await api.call<TeamSnapshot>("team")).agents.find((m) => m.id === args[1]);
      if (!agent?.models?.length) throw new Error(`${args[1]} has no models of its own to hold the task to: name them (--models provider/model,…), or choose its own with invincible agents models ${args[1]}`);
      models = [...agent.models];
    }
    if (!models?.length) models = undefined;
    const { task } = await api.call<{ task: { id: string } }>("createTeamTask", { room: args[0], assignee: args[1], title: string("title") ?? goal.slice(0, 200), goal, gates, ...(string("after") ? { dependsOn: string("after")!.split(",") } : {}), ...budget(), ...(models ? { models } : {}) });
    print(`${task.id} queued; completion requires its gates and independent review.${models ? ` In sensitive mode: every call of its work on ${models.join(", ")} alone.` : ""}`); return;
  }
  if (sub === "give") {
    // To the agents, not to an agent by name: the one best suited takes it, and says why.
    const goal = args.join(" ").trim();
    if (!goal) throw new Error('usage: invincible agents give "<goal>" [--gate command]... [--title text] [--desktop] [--repo https://github.com/owner/repo]');
    const gates = typeof flags.gate === "string" ? [flags.gate] : Array.isArray(flags.gate) ? (flags.gate as string[]) : [];
    const needs = { ...(flags.desktop ? { desktop: true } : {}), ...(string("repo") ? { repository: string("repo") } : {}) };
    const given = await api.call<{ task: { id: string }; choice: { id: string; name: string; reasons: string[] }; considered: { id: string; name: string; eligible: boolean; why: string[] }[] }>("giveTeamTask", {
      goal, ...(string("title") ? { title: string("title") } : {}), ...(gates.length ? { gates } : {}), ...(Object.keys(needs).length ? { needs } : {}), ...budget(),
    });
    print(`${plainLine(given.choice.name)} takes it: ${given.choice.reasons.join("; ")}.`);
    for (const other of given.considered.filter((c) => c.id !== given.choice.id)) print(`  ${plainLine(other.name)}${other.eligible ? "" : " (can't take it)"}: ${other.why.join("; ")}`);
    print(`${given.task.id} queued in ${plainLine(given.choice.name)}'s own conversation; completion requires its gates and independent review.`);
    return;
  }
  if (sub === "files") {
    // A folder of an agent's workspace (its VM's /work; `primary`: its computer's), folders first.
    if (!args[0]) throw new Error("usage: invincible agents files <agent> [/work/path]");
    const view = await api.call<TeamFilesView>("teamFiles", { id: args[0], ...(args[1] ? { path: args[1] } : {}) });
    for (const entry of view.entries) print(`${entry.kind === "dir" ? `${plainLine(entry.name)}/` : plainLine(entry.name)}${entry.kind === "file" ? `  ${bytesWord(entry.size)}` : entry.kind === "link" ? "  (a link)" : ""}`);
    if (!view.entries.length) print(`(${view.path} is empty)`);
    if (view.more) print(`(only its first ${view.entries.length} entries)`);
    return;
  }
  if (sub === "read") {
    // One file of an agent's workspace: its text (anything like a key redacted), or what it is.
    if (!args[0] || !args[1]) throw new Error("usage: invincible agents read <agent> </work/path>");
    const file = await api.call<TeamFileView>("teamFile", { id: args[0], path: args[1] });
    if (file.kind === "text") {
      print(plainText(file.text ?? "").trimEnd());
      if (file.cut) print(`(only its beginning: it is ${bytesWord(file.size)})`);
      if (file.redacted) print("(something that looked like a key was redacted)");
    } else print(file.kind === "image" ? `(a picture, ${file.type}, ${bytesWord(file.size)}: open it in the app)` : file.kind === "large" ? `(a picture too big to show here: ${bytesWord(file.size)})` : `(not text: ${bytesWord(file.size)})`);
    return;
  }
  if (sub === "changes") {
    // What an agent's task changed: its latest task, or --task <id>; the files with their lines, then the diff.
    if (!args[0]) throw new Error("usage: invincible agents changes <agent> [--task <task-id>] [--files]");
    const view = await api.call<TeamChangesView>("teamChanges", { id: args[0], ...(string("task") ? { task: string("task") } : {}) });
    print(`${view.task ? `${view.task} in ${view.path}` : view.path ?? "its repository"}${view.base ? `, from ${view.base.slice(0, 12)}` : ", from HEAD"}`);
    for (const file of view.files) print(`${file.status} ${plainLine(file.path)}${file.added === null ? "  (binary)" : `  +${file.added} -${file.removed}`}`);
    for (const file of view.untracked) print(`? ${plainLine(file)}`);
    if (!view.files.length && !view.untracked.length) print("(nothing changed)");
    if (flags.files !== true && view.diff) print(`\n${plainText(view.diff).trimEnd()}`);
    if (view.cut) print("(the diff is cut: only its beginning is here)");
    if (view.redacted) print("(something that looked like a key was redacted)");
    return;
  }
  if (sub === "trail") {
    // What a task did, as it happened: once, or with --follow until the task has ended.
    if (!args[0]) throw new Error("usage: invincible agents trail <task-id> [--follow]");
    const wait = Math.max(1, Number(string("poll-ms") ?? 1000));
    let after = 0;
    for (;;) {
      const page = await api.call<{ task: { id: string; status: string }; entries: { n: number; at: number; text: string }[]; more: boolean }>("teamTrail", { task: args[0], after });
      for (const entry of page.entries) print(`${new Date(entry.at).toTimeString().slice(0, 8)}  ${plainText(entry.text).trimEnd().split("\n").join("\n          ")}`);
      after = page.entries.at(-1)?.n ?? after;
      if (page.more) continue;
      const working = page.task.status === "running" || page.task.status === "queued";
      if (!working) { if (flags.follow) print(`(ended: ${page.task.status})`); return; }
      if (!flags.follow) { print(`(still ${page.task.status}: invincible agents trail ${page.task.id} --follow)`); return; }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  if (sub === "steps") {
    // The steps of a task another can be given from (PLAN #15): each command, and when it ended.
    if (!args[0]) throw new Error("usage: invincible agents steps <task-id>");
    const { steps } = await api.call<{ steps: TeamCheckpoint[] }>("teamSteps", { task: args[0] });
    if (!steps.length) { print(`${args[0]} has no steps kept: they are kept for an agent's task in a repository, on your agent's own harness.`); return; }
    for (const s of steps) print(`${String(s.step).padStart(4)}  ${new Date(s.at).toTimeString().slice(0, 8)}  ${plainLine(s.command).slice(0, 160)}`);
    print(`Give it again from one: invincible agents again ${args[0]} --from <step> ["<goal>"]`);
    return;
  }
  if (sub === "again") {
    // The same task given again, as its agent's new one (your stepping in, counted on it): from its start, or from a
    // step of it (--from), its workspace as it stood then. Your words, when you give them, are its goal.
    const id = args[0];
    if (!id) throw new Error('usage: invincible agents again <task-id> [--from <step>] ["<goal>"]');
    const old = (await api.call<TeamSnapshot>("team")).tasks.find((t) => t.id === id);
    if (!old) throw new Error(`no task ${id}`);
    const step = string("from") === undefined ? undefined : Number(string("from"));
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) throw new Error("--from names a step by its number: invincible agents steps " + id);
    const goal = args.slice(1).join(" ").trim() || old.goal;
    const { task } = await api.call<{ task: { id: string } }>("createTeamTask", { room: old.room, assignee: old.assignee, title: old.title, goal, gates: old.gates, ...(old.dependsOn.length ? { dependsOn: old.dependsOn } : {}), ...(old.budgetUsd !== undefined ? { budgetUsd: old.budgetUsd } : {}), ...(old.models?.length ? { models: old.models } : {}), again: old.id, ...(step !== undefined ? { from: { task: old.id, step } } : {}) });
    print(`${task.id} queued: ${old.id} given again${step !== undefined ? `, from its step ${step}` : ""}; completion requires its gates and independent review.`);
    return;
  }
  if (sub === "provision" && flags.remake) {
    // Its VM made again from the image as it is now: the same VM and /work, a new container. Its own route.
    const kept = ["on", "cpus", "mem", "disk"].filter((flag) => flags[flag] !== undefined);
    if (kept.length) throw new Error(`a VM is made again where and as large as it is: leave out --${kept.join(", --")} (only --network can be chosen again)`);
    const result = await api.call<{ workspace: { id: string; node: string; network?: string; image?: string } }>("remakeAgent", { id: args[0], ...(string("network") ? { network: string("network") } : {}), ...(flags.desktop ? { desktop: true } : flags["no-desktop"] ? { desktop: false } : {}) });
    print(`VM ${result.workspace.id} on ${result.workspace.node} made again from its image as it is now · /work kept${result.workspace.image?.includes("desktop") ? " · with a desktop" : ""}${result.workspace.network ? ` · ${result.workspace.network === "online" ? "it can reach the internet" : "it reaches the model gateway only"}` : ""}`); return;
  }
  if (sub === "resize") {
    // Bigger while it runs, nothing stopped: threads and memory hot-added, its disk grown where it is mounted. (On a Mac it pauses.)
    const sizes = { ...(string("cpus") ? { cpus: Number(string("cpus")) } : {}), ...(string("mem") ? { memoryGb: Number(string("mem")) } : {}), ...(string("disk") ? { diskGb: Number(string("disk")) } : {}) };
    if (!args[0] || !Object.keys(sizes).length) throw new Error("usage: invincible agents resize <id> [--cpus n] [--mem gb] [--disk gb]   (more only: a smaller size takes effect when its VM is made again)");
    const { workspace, paused } = await api.call<{ workspace: { id: string; node: string; cpus: number; memoryGb: number; disk: { limitGb: number } | null }; paused?: boolean }>("resizeAgent", { id: args[0], ...sizes });
    print(`VM ${workspace.id} on ${workspace.node} now has ${workspace.cpus} cpu · ${workspace.memoryGb} GB${workspace.disk ? ` · ${workspace.disk.limitGb} GB of disk` : ""}${paused ? ": it paused to take them (a Mac's VM can't grow while it runs), so what was running in it stopped" : ", and nothing in it stopped"}`); return;
  }
  if (sub === "provision") {
    // (Online unless you say `--network gateway`: what its VM can reach is set when it is made.)
    // (With a desktop unless --no-desktop: --desktop asks for one by name, and is refused where no host can make one.)
    if (flags.desktop && flags["no-desktop"]) throw new Error("--desktop or --no-desktop, not both");
    const result = await api.call<{ workspace: { id: string; node: string; network?: string; image?: string } }>("provisionAgent", { id: args[0], ...(string("on") ? { on: string("on") } : {}), ...(string("cpus") ? { cpus: Number(string("cpus")) } : {}), ...(string("mem") ? { memoryGb: Number(string("mem")) } : {}), ...(string("disk") ? { diskGb: Number(string("disk")) } : {}), ...(string("network") ? { network: string("network") } : {}), ...(flags.desktop ? { desktop: true } : flags["no-desktop"] ? { desktop: false } : {}) });
    const hasDesktop = result.workspace.image?.includes("desktop");
    print(`VM ${result.workspace.id} on ${result.workspace.node}${hasDesktop ? " · with a desktop" : flags["no-desktop"] ? " · no desktop" : " · no desktop: its host makes none (the ledger says why)"}${result.workspace.network ? ` · ${result.workspace.network === "online" ? "it can reach the internet" : "it reaches the model gateway only"}` : ""}`); return;
  }
  if (sub === "memory") {
    if (args.length > 1) await api.call("teamMemory", { id: args[0], text: args.slice(1).join(" ") });
    const state = await api.call<TeamSnapshot>("team");
    const m = state.agents.find((m) => m.id === args[0]); if (!m) throw new Error("No such agent"); print(plainText(m.memory).trim() || "No notes yet."); return;
  }
  // The VMs' notes store (Engram), for every agent of this node: said, or turned on or off (which is yours alone).
  if (sub === "engram") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) throw new Error("usage: invincible agents engram [on|off]");
    if (!args.length) {
      const on = (await api.call<TeamSnapshot>("team")).engram === true;
      print(on
        ? "The notes store (Engram) is on: an agent's task is given it where its VM has the pinned Engram (Workspace, in the app, says which). Turn it off with: invincible agents engram off"
        : "The notes store (Engram) is off: an agent's tasks are given none. Turn it on with: invincible agents engram on");
      return;
    }
    const { engram } = await api.call<{ engram: boolean }>("teamEngram", { on: args[0] === "on" });
    print(engram
      ? "The notes store (Engram) is on. An agent's task is given it when the agent's VM has the pinned Engram, and says which it was. Notes stay in that VM: they are leads a task checks, never its memory."
      : "The notes store (Engram) is off. What agents kept stays in each VM, unused, under /work/.memory/engram.");
    return;
  }
  // A pull request of an agent's work that fails its checks, or that a review asks changes of: given back to that agent, outside an outcome too (PLAN #29).
  if (sub === "ci") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) throw new Error("usage: invincible agents ci [on|off]");
    const on = args.length ? (await api.call<{ ci: boolean }>("teamCi", { on: args[0] === "on" })).ci : (await api.call<TeamSnapshot>("team")).ciBack === true;
    print(on
      ? "Failing checks, and reviews that ask for changes, go back to the agent whose work it was: a fix on the pull request's branch, once for each commit that failed or review, three times at most, within your agent's daily giving. A verified fix is pushed onto its branch on your agent's own approval (never forced), as it may in a repository you gave an agent, unless it changes what the repository's CI runs or the branch moved since it last pushed it. Turn it off with: invincible agents ci off"
      : "Failing checks and reviews stay yours, except in an outcome, which gives them back on its own within its budget. Turn it on with: invincible agents ci on");
    return;
  }
  // Work for idle agents from your backlog (backlog.ts): on until you turn it off.
  if (sub === "backlog") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) throw new Error("usage: invincible agents backlog [on|off]");
    const on = args.length ? (await api.call<{ backlog: boolean }>("teamBacklog", { on: args[0] === "on" })).backlog : (await api.call<TeamSnapshot>("team")).backlog === true;
    print(on
      ? "An agent with a repository and nothing to do is offered one task a day at most, the next step of its repository's own plan (docs/PLAN.md, PLAN.md, ROADMAP.md or TODO.md): a proposal in its conversation with you, which your agent approves itself and starts when its cost fits its rule (at most $3, within what it may commit on its own: invincible agents daily), and which otherwise waits for you. Turn it off with: invincible agents backlog off"
      : "Idle agents are offered nothing: their work is what you and its outcomes give them. Turn it on with: invincible agents backlog on");
    return;
  }
  // What your agent may commit on its own word in a day while you set no usage budget: said, or set (yours alone).
  if (sub === "daily") {
    if (args.length > 1 || (args.length === 1 && !(/^\d{1,4}(\.\d{1,2})?$/.test(args[0]!) && Number(args[0]) <= 1000))) throw new Error("usage: invincible agents daily [<usd>] (up to 1000, to the cent)");
    const usd = args.length ? (await api.call<{ usd: number }>("teamOwnDaily", { usd: Number(args[0]) })).usd : (await api.call<TeamSnapshot>("team")).ownDailyUsd ?? TEAM_LIMITS.ownDailyUsd;
    print(usd > 0
      ? `With no usage budget of yours, your agent may commit ${capLabel(usd)} a day on its own word: the budgets of the tasks it gives and of the proposals it approves itself, ${capLabel(TEAM_LIMITS.ownTaskUsd)} a task at most; past that they are yours. With a budget (invincible usage budget), what is left of it past what approved work holds is the bound instead. Change it with: invincible agents daily <usd>`
      : "With no usage budget of yours, your agent commits nothing on its own word: the tasks it would give are yours to give, and its proposals and its agents' wait for you. Change it with: invincible agents daily <usd>");
    return;
  }
  // Your agent's own merging of its agents' proven work, in a repository you gave an agent: said, or turned off or on there.
  if (sub === "merge") {
    // As GitHub names it (its case, no .git): one that can never match a repository is refused (core's mergeRepository).
    const named = args[0] === undefined ? null : mergeRepository(args[0]);
    if (args.length < 1 || args.length > 2 || !named || (args[1] !== undefined && args[1] !== "on" && args[1] !== "off")) throw new Error("usage: invincible agents merge <owner/repo> [on|off]");
    const repository = named;
    const on = args[1] ? (await api.call<{ on: boolean }>("teamMerge", { repository, on: args[1] === "on" })).on : !((await api.call<TeamSnapshot>("team")).mergeOff ?? []).includes(repository.toLowerCase());
    print(on
      ? `Your agent merges its agents' proven work in ${repository} itself, as it may in a repository you gave an agent: once GitHub says a pull request is clean (every check and review its rules require has passed), through GitHub's own merge, never forced, and never one that changes what the repository's CI runs. Turn it off there with: invincible agents merge ${repository} off`
      : `Merging in ${repository} is yours: your agent ships its agents' work there and leaves the merge to you. Turn its own merging on again with: invincible agents merge ${repository} on`);
    return;
  }
  // (An agent by either word: `agent` is what the command took before it was called agents.)
  // A task an agent proposed: it runs once you approve it; declined, it never runs.
  if ((sub === "approve" || sub === "decline") && args[0]) {
    await api.call("controlTeam", { action: sub === "approve" ? "approve" : "stop", task: args[0] }); print(`${sub === "approve" ? "approved" : "declined"}: task ${args[0]}`); return;
  }
  if (["pause", "resume", "stop"].includes(sub) && ["room", "agent", "task"].includes(args[0] ?? "")) {
    await api.call("controlTeam", { action: sub, [args[0]!]: args[1] }); print(`${sub}: ${args[0]} ${args[1]}`); return;
  }
  if (sub === "remove") {
    const state = await api.call<TeamSnapshot>("team");
    const member = state.agents.find((m) => m.id === args[0]);
    if (!member) throw new Error((state.removed ?? []).some((m) => m.id === args[0]) ? "That agent was already removed." : "No such agent");
    const who = `${plainLine(member.name)} (${member.id})`;
    // It has a VM, or one was being made for it when the node last stopped (and may exist, never bound). Either goes
    // with it or it stays: said here before anything is asked of the node, which looks for itself and has the last word.
    const vm = member.workspace ? `its VM ${member.workspace.id} on ${member.workspace.node}` : member.workspaceNode ? `the VM that was being made for it on ${member.workspaceNode}` : null;
    const destroy = flags["destroy-workspace"] === true;
    if (vm && !destroy) throw new Error(`${who} has a persistent workspace (${vm}). Removing it destroys that VM and everything in /work: add --destroy-workspace, or pause it instead (invincible agents pause agent ${member.id}).`);
    const kept = "Its conversations stay to read, and its handle can never be used again.";
    if (!flags.yes && !confirm(destroy ? `Remove ${who} for good, and destroy ${vm ?? "any VM it has"} with everything in /work? ${kept}` : `Remove ${who} for good? ${kept}`)) { print("Nothing was removed."); return; }
    const done = await api.call<{ workspace: "none" | "destroyed" | "gone" | "left" }>("removeAgent", { id: member.id, ...(destroy ? { destroyWorkspace: true } : {}) });
    // What became of its VM is the node's to say.
    const became = { none: ".", destroyed: " and destroyed its VM workspace.", gone: ". Its VM was already gone from its host.", left: ". Its VM was on a node that has left the fleet, so nothing there was touched." }[done.workspace] ?? ".";
    print(`Removed ${who}${became} What it said stays where it said it; its handle is retired.`);
    return;
  }
  throw new Error(usage);
}
