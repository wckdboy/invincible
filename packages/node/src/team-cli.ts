import { interventionWords, knightFromFile, knightToFile, plainLine, plainText, type Prices, type TeamChangesView, type TeamFilesView, type TeamFileView, type RouteName, taskRecordFacts, type TeamModelChoice, type TeamSnapshot, type TeamRoomView, type TeamRoom, type TeamTask, type Teammate, type TeamCheckpoint } from "@galahad/core";
import { knightColors } from "@galahad/core/avatar";

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
/** What a task changed in its repository and where that is kept (`galahad ship <artifact>` opens a pull request from it). Empty when it kept nothing. */
export const taskChangesLine = (task: Pick<TeamTask, "changes">): string => (task.changes ? ` · ${task.changes.files} file${task.changes.files === 1 ? "" : "s"} changed, kept as ${task.changes.artifact}` : "");

const usage = "galahad roundtable [add <id> | avatar <id> | models <id> [provider/model…] | sensitive <id> [on|off] [provider/model…] | dm <id> [message] | room <name> <member…> | chat <room> [message] | task <room> <assignee> <goal> [--sensitive] [--models provider/model,…] | steps <task-id> | again <task-id> [--from <step>] [goal] | keys <id> [add <secret> [--write] | rm <secret>] | export <id> [--out file.md] | import <file.md> [--id <new id>] [-y] | give <goal> | trail <task-id> [--follow] | provision <id> | memory <id> [text] | engram [on|off] | ci [on|off] | pause|resume|stop <room|knight|task> <id> | approve|decline <task-id> | remove <id> [--destroy-workspace] [--yes]]";

/** What a knight works on, in a sentence: its own models or its role's, and whether it is in sensitive mode. */
const knightModels = (m: Teammate): string =>
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
    // (One Galahad made for himself says so: in your conversation with him, or by the worker that asked for it.)
    const maker = (m: Teammate) => (!m.createdBy || m.createdBy === "owner" ? "" : ` · made by ${m.createdBy === "galahad" ? "Galahad" : m.createdBy}`);
    for (const m of state.teammates) print(`${m.id} · ${plainLine(m.name)}${state.primary === m.id ? " · leads the Roundtable" : ""}${m.sensitive ? " · sensitive mode" : ""} · ${m.harness} · ${m.enabled ? "enabled" : "paused"} · ${m.turnsToday}/${m.dailyTurns} turns today · ${m.workspace ? `VM ${m.workspace.id} on ${m.workspace.node}` : "VM not provisioned"}${maker(m)}`);
    // (One you removed is named still: its handle stays taken.)
    for (const m of state.removed ?? []) print(`${m.id} · ${plainLine(m.name)} · removed${m.conversations?.length ? ` · its conversations, kept to read: ${m.conversations.map((room) => `galahad roundtable chat ${room}`).join(", ")}` : ""}`);
    for (const r of state.rooms) print(`${r.id} · ${plainLine(r.name)} · ${r.members.join(", ")}${r.paused ? " · paused" : ""}`);
    // (Money is at your prices, asked for only when a task here has a record to price.)
    const prices: Prices = state.tasks.some((t) => t.record) ? (await api.call<{ prices: Prices }>("prices").catch(() => ({ prices: {} }))).prices : {};
    for (const t of state.tasks) print(`${t.id} · ${t.status}${t.verified ? " (verified)" : ""} · ${t.assignee} · ${plainLine(t.title)}${taskRecordLine(t, prices)}${taskChangesLine(t)}${t.status === "proposed" && t.proposedBy ? ` · proposed by ${t.proposedBy}: galahad roundtable approve ${t.id}` : ""}${interventionWords(t.interventions) ? ` · you stepped in: ${interventionWords(t.interventions)}` : ""}`);
    // The mandate's north star (#28): how often you stepped in, per task done and verified.
    const star = state.northStar;
    if (star?.ended) print(`You stepped in ${star.interventions} time${star.interventions === 1 ? "" : "s"} on the ${star.ended} task${star.ended === 1 ? "" : "s"} that ended in the last 30 days${star.perCompleted === null ? ", and none was done and verified." : `: ${star.perCompleted.toFixed(1)} a task done and verified (${star.completed}).`}`);
    if (!state.teammates.length) print("Create a knight with galahad roundtable add <id> --name <name>, or open the Roundtable in the app.");
    return;
  }
  if (sub === "add") {
    const id = args[0];
    const result = await api.call<{ teammate: Teammate }>("saveTeammate", { id, name: string("name") ?? id, ...(string("instructions") ? { instructions: string("instructions") } : {}), ...(string("role") ? { role: string("role") } : {}), ...(string("agent") ? { harness: string("agent") } : {}), ...(string("acp") ? { acp: string("acp") } : {}), ...(string("repo") ? { repository: string("repo") } : {}), ...(string("limit") ? { dailyTurns: Number(string("limit")) } : {}) });
    print(`${plainLine(result.teammate.name)} is ready to chat. Its VM is made on a node that makes VMs (KVM with Kata, or a Mac with Apple's container) when it is first needed.`); return;
  }
  if (sub === "models") {
    // A knight's own models, in place of its role's: shown with what you may choose, set in order, or given back (--role).
    const id = args[0];
    if (!id) throw new Error("usage: galahad roundtable models <knight> [provider/model…] [--role]");
    const knight = (await api.call<TeamSnapshot>("team")).teammates.find((m) => m.id === id);
    if (!knight) throw new Error(`no knight ${id}`);
    const says = knightModels;
    const refs = args.slice(1).flatMap((arg) => arg.split(",")).map((ref) => ref.trim()).filter(Boolean);
    if (refs.length || flags.role === true) {
      const saved = await api.call<{ teammate: Teammate }>("saveTeammate", { id, name: knight.name, models: flags.role === true ? null : refs });
      print(says(saved.teammate)); return;
    }
    const { models } = await api.call<{ models: TeamModelChoice[] }>("teamModels");
    print(says(knight));
    print("To choose, in order: galahad roundtable models <knight> provider/model…; --role gives it its role's again. You may choose:");
    for (const m of models) print(`  ${m.ref}${m.on.length ? ` · on ${m.on.join(", ")}` : ""}`);
    return;
  }
  if (sub === "keys") {
    // Keys of yours it may use but never see (PLAN #17): listed, given (reads only unless --write), or taken back.
    const [id, verb, secret] = args;
    if (!id || (verb !== undefined && !((verb === "add" || verb === "rm") && secret))) throw new Error("usage: galahad roundtable keys <knight> [add <secret> [--header x-api-key] [--write] | rm <secret>]");
    const knight = (await api.call<TeamSnapshot>("team")).teammates.find((m) => m.id === id);
    if (!knight) throw new Error(`no knight ${id}`);
    let keys = knight.keys ?? [];
    if (verb === "add") keys = [...keys.filter((k) => k.secret !== secret), { secret: secret!, header: string("header") ?? "authorization", write: flags.write === true }];
    if (verb === "rm") keys = keys.filter((k) => k.secret !== secret);
    if (verb) keys = (await api.call<{ teammate: Teammate }>("saveTeammate", { id, name: knight.name, keys: keys.length ? keys : null })).teammate.keys ?? [];
    if (!keys.length) { print(`${id} has no keys of yours to use. Give it one: galahad roundtable keys ${id} add <secret> (the secret pinned to its API's address: galahad secret set <secret> --base-url https://…)`); return; }
    // How often its scripts used each these last days (a node from before the count says nothing of it).
    const counted = await api.call<{ days?: number; uses?: Record<string, number> }>("teamKeyUses", { id }).catch(() => null);
    const uses = counted && typeof counted.uses === "object" && typeof counted.days === "number" ? { ...counted, uses: counted.uses } : null;
    const used = (secret: string) => (uses ? ` · used ${uses.uses[secret] ?? 0} time${(uses.uses[secret] ?? 0) === 1 ? "" : "s"} in ${uses.days} days` : "");
    for (const k of keys) print(`${k.secret} · ${k.write ? "reads and writes" : "reads only"} · in ${k.header === "authorization" ? "Authorization: Bearer" : k.header}${used(k.secret)}`);
    print(`Its scripts call $GALAHAD_KEYS/<secret>/<path> with $GALAHAD_TOKEN where the key would go; from its next task.`);
    return;
  }
  if (sub === "sensitive") {
    // Sensitive mode: every call of its work on its own models alone (heldModels). On with models names them its own.
    const id = args[0];
    const turn = args[1];
    if (!id || (turn !== undefined && turn !== "on" && turn !== "off")) throw new Error("usage: galahad roundtable sensitive <knight> [on [provider/model…] | off]");
    const knight = (await api.call<TeamSnapshot>("team")).teammates.find((m) => m.id === id);
    if (!knight) throw new Error(`no knight ${id}`);
    if (turn === undefined) {
      print(knightModels(knight));
      if (!knight.sensitive) print(`To hold it to models of its own and nothing else: galahad roundtable sensitive ${id} on${knight.models?.length ? "" : " provider/model…"}`);
      return;
    }
    const refs = args.slice(2).flatMap((arg) => arg.split(",")).map((ref) => ref.trim()).filter(Boolean);
    if (turn === "off" && refs.length) throw new Error("Turning sensitive mode off names no models: galahad roundtable models chooses them.");
    const saved = await api.call<{ teammate: Teammate }>("saveTeammate", { id, name: knight.name, sensitive: turn === "on", ...(refs.length ? { models: refs } : {}) });
    print(knightModels(saved.teammate));
    return;
  }
  if (sub === "export") {
    // A knight as a file you carry (PLAN #20): who it is, its job and how it works; never its memory, its record or a key.
    const id = args[0];
    if (!id) throw new Error("usage: galahad roundtable export <knight> [--out file.md]");
    const knight = (await api.call<TeamSnapshot>("team")).teammates.find((m) => m.id === id);
    if (!knight) throw new Error(`no knight ${id}`);
    const { text, scrubbed } = knightToFile({ ...knight, ...(knight.acp ? { acp: knight.acp } : {}), repository: knight.repository ?? undefined, keys: knight.keys?.map((k) => k.secret) });
    const out = string("out");
    if (!out) return void write(text.trimEnd());
    await Bun.write(out, text);
    print(`${plainLine(knight.name)} is in ${out}: its job and how it works, never its memory, its record or a key${knight.keys?.length ? ` (the names of the ${knight.keys.length} it was given, to give again where it goes)` : ""}.${scrubbed ? ` ${scrubbed} thing${scrubbed === 1 ? "" : "s"} in its job that looked like a key ${scrubbed === 1 ? "was" : "were"} taken out.` : ""} galahad roundtable import ${out} brings it in on another node.`);
    return;
  }
  if (sub === "import") {
    // A knight file in as a new knight here: shown first, then made by the same route as any knight you add.
    const path = args[0];
    if (!path) throw new Error("usage: galahad roundtable import <file.md> [--id <new id>] [-y]");
    const read = knightFromFile(path === "-" ? await Bun.stdin.text() : await Bun.file(path).text().catch(() => { throw new Error(`can't read ${path}`); }));
    if (!read.ok) throw new Error(`That isn't a knight file: ${read.why}.`);
    const k = read.knight;
    const id = string("id") ?? k.id;
    const state = await api.call<TeamSnapshot>("team");
    // (A handle is never anyone else's: a knight's here, or one you removed.)
    if ([...state.teammates, ...(state.removed ?? [])].some((m) => m.id === id)) throw new Error(`There is a knight ${id} here already: galahad roundtable import ${path} --id <another id>`);
    print(`${plainLine(k.name)} (${id}) · ${k.harness ?? "native"}${k.acp ? ` running ${plainLine(k.acp)} in its VM` : ""} · ${k.sensitive && k.models?.length ? `sensitive mode, held to ${k.models.join(", ")}` : k.models?.length ? `works on ${k.models.join(", ")}` : `on its role's models (${k.role ?? "default"})`}${k.repository ? ` · ${k.repository}` : ""}`);
    if (k.instructions) print(`Its job: ${plainText(k.instructions).split("\n").find((line) => line.trim()) ?? ""}${k.instructions.includes("\n") ? " …" : ""}`);
    if (!flags.yes && !confirm(`Bring ${plainLine(k.name)} in as ${id}?`)) return;
    const saved = await api.call<{ teammate: Teammate }>("saveTeammate", {
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
    print(`${plainLine(saved.teammate.name)} is here as ${saved.teammate.id}. Its VM is made when it is first needed.`);
    if (k.keys?.length) print(`Where it came from it was given ${k.keys.join(", ")}: none is given here unless you say so (galahad roundtable keys ${saved.teammate.id} add <secret>).`);
    if (read.ignored.length) print(`Left out, not a knight's: ${read.ignored.join(", ")}.`);
    return;
  }
  if (sub === "order") {
    // Your order of the knights: every device shows them so. Those not named come after, by handle.
    const ids = args.flatMap((arg) => arg.split(",")).map((id) => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error("usage: galahad roundtable order <knight,knight,...>");
    const { order } = await api.call<{ order: string[] }>("arrangeTeam", { order: ids });
    print(`In this order now: ${order.join(", ")}.`); return;
  }
  if (sub === "primary") {
    // Who leads the Roundtable: what you say to a room without naming anyone is theirs to answer, and they come first.
    if (args.length !== 1) throw new Error("usage: galahad roundtable primary <knight|galahad>");
    const { primary } = await api.call<{ primary: string }>("arrangeTeam", { primary: args[0] });
    print(primary === "galahad" ? "Galahad leads the Roundtable." : `${primary} leads the Roundtable: what you say to a room it sits in without naming anyone is its to answer.`); return;
  }
  if (sub === "avatar") {
    const state = await api.call<TeamSnapshot>("team");
    const member = state.teammates.find((m) => m.id === args[0]);
    if (!member) throw new Error("No such knight");
    // The drawings are gone (25 November 2026): a knight is an orb, and its colour is all there is to choose.
    if (["look", "form", "accent", "eyes", "accessory", "temperament"].some((key) => flags[key] !== undefined)) {
      throw new Error("A knight is an orb now, and its colour is all there is to choose: give --color #rrggbb, or --reset for the one its handle gives it.");
    }
    const color = string("color");
    if (flags.reset || color !== undefined) {
      // What isn't a colour is the node's to refuse: nothing here guesses at it.
      const { teammate } = await api.call<{ teammate: Teammate }>("saveTeammate", { id: member.id, name: member.name, avatar: flags.reset ? null : { v: 2, color: color!.trim().toLowerCase() } });
      print(JSON.stringify(knightColors(teammate.id, teammate.avatar)));
    } else print(JSON.stringify(knightColors(member.id, member.avatar)));
    return;
  }
  if (sub === "room") {
    const { room } = await api.call<{ room: TeamRoom }>("saveTeamRoom", { name: args[0], members: args.slice(1), ...(string("limit") ? { turnBudget: Number(string("limit")) } : {}) });
    print(`${room.id} · ${plainLine(room.name)}`); return;
  }
  if (sub === "dm" || sub === "chat") {
    const room = sub === "dm" ? (await api.call<{ room: TeamRoom }>("directTeammate", { id: args[0] })).room.id : args[0];
    const text = args.slice(1).join(" ");
    if (text) { await api.call("postTeamMessage", { room, text }); print(`Sent to ${room}; replies continue on the node. Read with galahad roundtable chat ${room}.`); }
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
    // Sensitive mode for this task alone: on the models named (--models), or with none named its knight's own.
    let models = string("models")?.split(",").map((ref) => ref.trim()).filter(Boolean);
    if (flags.sensitive === true && !models?.length) {
      const knight = (await api.call<TeamSnapshot>("team")).teammates.find((m) => m.id === args[1]);
      if (!knight?.models?.length) throw new Error(`${args[1]} has no models of its own to hold the task to: name them (--models provider/model,…), or choose its own with galahad roundtable models ${args[1]}`);
      models = [...knight.models];
    }
    if (!models?.length) models = undefined;
    const { task } = await api.call<{ task: { id: string } }>("createTeamTask", { room: args[0], assignee: args[1], title: string("title") ?? goal.slice(0, 200), goal, gates, ...(string("after") ? { dependsOn: string("after")!.split(",") } : {}), ...budget(), ...(models ? { models } : {}) });
    print(`${task.id} queued; completion requires its gates and independent review.${models ? ` In sensitive mode: every call of its work on ${models.join(", ")} alone.` : ""}`); return;
  }
  if (sub === "give") {
    // To the Roundtable, not to a knight by name: the one best suited takes it, and says why.
    const goal = args.join(" ").trim();
    if (!goal) throw new Error('usage: galahad roundtable give "<goal>" [--gate command]... [--title text] [--desktop] [--repo https://github.com/owner/repo]');
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
    // A folder of a knight's workspace (its VM's /work; `galahad`: his computer's), folders first.
    if (!args[0]) throw new Error("usage: galahad roundtable files <knight> [/work/path]");
    const view = await api.call<TeamFilesView>("teamFiles", { id: args[0], ...(args[1] ? { path: args[1] } : {}) });
    for (const entry of view.entries) print(`${entry.kind === "dir" ? `${plainLine(entry.name)}/` : plainLine(entry.name)}${entry.kind === "file" ? `  ${bytesWord(entry.size)}` : entry.kind === "link" ? "  (a link)" : ""}`);
    if (!view.entries.length) print(`(${view.path} is empty)`);
    if (view.more) print(`(only its first ${view.entries.length} entries)`);
    return;
  }
  if (sub === "read") {
    // One file of a knight's workspace: its text (anything like a key redacted), or what it is.
    if (!args[0] || !args[1]) throw new Error("usage: galahad roundtable read <knight> </work/path>");
    const file = await api.call<TeamFileView>("teamFile", { id: args[0], path: args[1] });
    if (file.kind === "text") {
      print(plainText(file.text ?? "").trimEnd());
      if (file.cut) print(`(only its beginning: it is ${bytesWord(file.size)})`);
      if (file.redacted) print("(something that looked like a key was redacted)");
    } else print(file.kind === "image" ? `(a picture, ${file.type}, ${bytesWord(file.size)}: open it in the app)` : file.kind === "large" ? `(a picture too big to show here: ${bytesWord(file.size)})` : `(not text: ${bytesWord(file.size)})`);
    return;
  }
  if (sub === "changes") {
    // What a knight's task changed: its latest task, or --task <id>; the files with their lines, then the diff.
    if (!args[0]) throw new Error("usage: galahad roundtable changes <knight> [--task <task-id>] [--files]");
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
    if (!args[0]) throw new Error("usage: galahad roundtable trail <task-id> [--follow]");
    const wait = Math.max(1, Number(string("poll-ms") ?? 1000));
    let after = 0;
    for (;;) {
      const page = await api.call<{ task: { id: string; status: string }; entries: { n: number; at: number; text: string }[]; more: boolean }>("teamTrail", { task: args[0], after });
      for (const entry of page.entries) print(`${new Date(entry.at).toTimeString().slice(0, 8)}  ${plainText(entry.text).trimEnd().split("\n").join("\n          ")}`);
      after = page.entries.at(-1)?.n ?? after;
      if (page.more) continue;
      const working = page.task.status === "running" || page.task.status === "queued";
      if (!working) { if (flags.follow) print(`(ended: ${page.task.status})`); return; }
      if (!flags.follow) { print(`(still ${page.task.status}: galahad roundtable trail ${page.task.id} --follow)`); return; }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  if (sub === "steps") {
    // The steps of a task another can be given from (PLAN #15): each command, and when it ended.
    if (!args[0]) throw new Error("usage: galahad roundtable steps <task-id>");
    const { steps } = await api.call<{ steps: TeamCheckpoint[] }>("teamSteps", { task: args[0] });
    if (!steps.length) { print(`${args[0]} has no steps kept: they are kept for a knight's task in a repository, on Galahad's own harness.`); return; }
    for (const s of steps) print(`${String(s.step).padStart(4)}  ${new Date(s.at).toTimeString().slice(0, 8)}  ${plainLine(s.command).slice(0, 160)}`);
    print(`Give it again from one: galahad roundtable again ${args[0]} --from <step> ["<goal>"]`);
    return;
  }
  if (sub === "again") {
    // The same task given again, as its knight's new one (your stepping in, counted on it): from its start, or from a
    // step of it (--from), its workspace as it stood then. Your words, when you give them, are its goal.
    const id = args[0];
    if (!id) throw new Error('usage: galahad roundtable again <task-id> [--from <step>] ["<goal>"]');
    const old = (await api.call<TeamSnapshot>("team")).tasks.find((t) => t.id === id);
    if (!old) throw new Error(`no task ${id}`);
    const step = string("from") === undefined ? undefined : Number(string("from"));
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) throw new Error("--from names a step by its number: galahad roundtable steps " + id);
    const goal = args.slice(1).join(" ").trim() || old.goal;
    const { task } = await api.call<{ task: { id: string } }>("createTeamTask", { room: old.room, assignee: old.assignee, title: old.title, goal, gates: old.gates, ...(old.dependsOn.length ? { dependsOn: old.dependsOn } : {}), ...(old.budgetUsd !== undefined ? { budgetUsd: old.budgetUsd } : {}), ...(old.models?.length ? { models: old.models } : {}), again: old.id, ...(step !== undefined ? { from: { task: old.id, step } } : {}) });
    print(`${task.id} queued: ${old.id} given again${step !== undefined ? `, from its step ${step}` : ""}; completion requires its gates and independent review.`);
    return;
  }
  if (sub === "provision" && flags.remake) {
    // Its VM made again from the image as it is now: the same VM and /work, a new container. Its own route.
    const kept = ["on", "cpus", "mem", "disk"].filter((flag) => flags[flag] !== undefined);
    if (kept.length) throw new Error(`a VM is made again where and as large as it is: leave out --${kept.join(", --")} (only --network can be chosen again)`);
    const result = await api.call<{ workspace: { id: string; node: string; network?: string; image?: string } }>("remakeTeammate", { id: args[0], ...(string("network") ? { network: string("network") } : {}), ...(flags.desktop ? { desktop: true } : flags["no-desktop"] ? { desktop: false } : {}) });
    print(`VM ${result.workspace.id} on ${result.workspace.node} made again from its image as it is now · /work kept${result.workspace.image?.includes("desktop") ? " · with a desktop" : ""}${result.workspace.network ? ` · ${result.workspace.network === "online" ? "it can reach the internet" : "it reaches the model gateway only"}` : ""}`); return;
  }
  if (sub === "resize") {
    // Bigger while it runs, nothing stopped: threads and memory hot-added, its disk grown where it is mounted. (On a Mac it pauses.)
    const sizes = { ...(string("cpus") ? { cpus: Number(string("cpus")) } : {}), ...(string("mem") ? { memoryGb: Number(string("mem")) } : {}), ...(string("disk") ? { diskGb: Number(string("disk")) } : {}) };
    if (!args[0] || !Object.keys(sizes).length) throw new Error("usage: galahad roundtable resize <id> [--cpus n] [--mem gb] [--disk gb]   (more only: a smaller size takes effect when its VM is made again)");
    const { workspace, paused } = await api.call<{ workspace: { id: string; node: string; cpus: number; memoryGb: number; disk: { limitGb: number } | null }; paused?: boolean }>("resizeTeammate", { id: args[0], ...sizes });
    print(`VM ${workspace.id} on ${workspace.node} now has ${workspace.cpus} cpu · ${workspace.memoryGb} GB${workspace.disk ? ` · ${workspace.disk.limitGb} GB of disk` : ""}${paused ? ": it paused to take them (a Mac's VM can't grow while it runs), so what was running in it stopped" : ", and nothing in it stopped"}`); return;
  }
  if (sub === "provision") {
    // (Online unless you say `--network gateway`: what its VM can reach is set when it is made.)
    const result = await api.call<{ workspace: { id: string; node: string; network?: string } }>("provisionTeammate", { id: args[0], ...(string("on") ? { on: string("on") } : {}), ...(string("cpus") ? { cpus: Number(string("cpus")) } : {}), ...(string("mem") ? { memoryGb: Number(string("mem")) } : {}), ...(string("disk") ? { diskGb: Number(string("disk")) } : {}), ...(string("network") ? { network: string("network") } : {}), ...(flags.desktop ? { desktop: true } : {}) });
    print(`VM ${result.workspace.id} on ${result.workspace.node}${flags.desktop ? " · with a desktop" : ""}${result.workspace.network ? ` · ${result.workspace.network === "online" ? "it can reach the internet" : "it reaches the model gateway only"}` : ""}`); return;
  }
  if (sub === "memory") {
    if (args.length > 1) await api.call("teamMemory", { id: args[0], text: args.slice(1).join(" ") });
    const state = await api.call<TeamSnapshot>("team");
    const m = state.teammates.find((m) => m.id === args[0]); if (!m) throw new Error("No such knight"); print(plainText(m.memory).trim() || "No notes yet."); return;
  }
  // The VMs' notes store (Engram), for every knight of this node: said, or turned on or off (which is yours alone).
  if (sub === "engram") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) throw new Error("usage: galahad roundtable engram [on|off]");
    if (!args.length) {
      const on = (await api.call<TeamSnapshot>("team")).engram === true;
      print(on
        ? "The notes store (Engram) is on: a knight's task is given it where its VM has the pinned Engram (Workspace, in the app, says which). Turn it off with: galahad roundtable engram off"
        : "The notes store (Engram) is off: a knight's tasks are given none. Turn it on with: galahad roundtable engram on");
      return;
    }
    const { engram } = await api.call<{ engram: boolean }>("teamEngram", { on: args[0] === "on" });
    print(engram
      ? "The notes store (Engram) is on. A knight's task is given it when the knight's VM has the pinned Engram, and says which it was. Notes stay in that VM: they are leads a task checks, never his memory."
      : "The notes store (Engram) is off. What knights kept stays in each VM, unused, under /work/.memory/engram.");
    return;
  }
  // A pull request of a knight's work that fails its checks, or that a review asks changes of: given back to that knight, outside an outcome too (PLAN #29).
  if (sub === "ci") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) throw new Error("usage: galahad roundtable ci [on|off]");
    const on = args.length ? (await api.call<{ ci: boolean }>("teamCi", { on: args[0] === "on" })).ci : (await api.call<TeamSnapshot>("team")).ciBack === true;
    print(on
      ? "Failing checks, and reviews that ask for changes, go back to the knight whose work it was: a fix on the pull request's branch, once for each commit that failed or review, three times at most, within Galahad's daily giving. Pushing a fix still waits for your approval. Turn it off with: galahad roundtable ci off"
      : "Failing checks and reviews stay yours, except in an outcome, which gives them back on its own within its budget. Turn it on with: galahad roundtable ci on");
    return;
  }
  // Work for idle knights from your backlog (backlog.ts): on until you turn it off.
  if (sub === "backlog") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "on" && args[0] !== "off")) throw new Error("usage: galahad roundtable backlog [on|off]");
    const on = args.length ? (await api.call<{ backlog: boolean }>("teamBacklog", { on: args[0] === "on" })).backlog : (await api.call<TeamSnapshot>("team")).backlog === true;
    print(on
      ? "A knight with a repository and nothing to do is offered one task a day at most, the next step of its repository's own plan (docs/PLAN.md, PLAN.md, ROADMAP.md or TODO.md): a proposal in its conversation with you, which starts when you approve it. Turn it off with: galahad roundtable backlog off"
      : "Idle knights are offered nothing: their work is what you and his outcomes give them. Turn it on with: galahad roundtable backlog on");
    return;
  }
  // (A knight by either word: `teammate` is what the command took before it was called knights.)
  // A task a knight proposed: it runs once you approve it; declined, it never runs.
  if ((sub === "approve" || sub === "decline") && args[0]) {
    await api.call("controlTeam", { action: sub === "approve" ? "approve" : "stop", task: args[0] }); print(`${sub === "approve" ? "approved" : "declined"}: task ${args[0]}`); return;
  }
  if (["pause", "resume", "stop"].includes(sub) && ["room", "knight", "squire", "teammate", "task"].includes(args[0] ?? "")) {
    await api.call("controlTeam", { action: sub, [args[0] === "knight" || args[0] === "squire" ? "teammate" : args[0]!]: args[1] }); print(`${sub}: ${args[0]} ${args[1]}`); return;
  }
  if (sub === "remove") {
    const state = await api.call<TeamSnapshot>("team");
    const member = state.teammates.find((m) => m.id === args[0]);
    if (!member) throw new Error((state.removed ?? []).some((m) => m.id === args[0]) ? "That knight was already removed." : "No such knight");
    const who = `${plainLine(member.name)} (${member.id})`;
    // It has a VM, or one was being made for it when the node last stopped (and may exist, never bound). Either goes
    // with it or it stays: said here before anything is asked of the node, which looks for itself and has the last word.
    const vm = member.workspace ? `its VM ${member.workspace.id} on ${member.workspace.node}` : member.workspaceNode ? `the VM that was being made for it on ${member.workspaceNode}` : null;
    const destroy = flags["destroy-workspace"] === true;
    if (vm && !destroy) throw new Error(`${who} has a persistent workspace (${vm}). Removing it destroys that VM and everything in /work: add --destroy-workspace, or pause it instead (galahad roundtable pause knight ${member.id}).`);
    const kept = "Its conversations stay to read, and its handle can never be used again.";
    if (!flags.yes && !confirm(destroy ? `Remove ${who} for good, and destroy ${vm ?? "any VM it has"} with everything in /work? ${kept}` : `Remove ${who} for good? ${kept}`)) { print("Nothing was removed."); return; }
    const done = await api.call<{ workspace: "none" | "destroyed" | "gone" | "left" }>("removeTeammate", { id: member.id, ...(destroy ? { destroyWorkspace: true } : {}) });
    // What became of its VM is the node's to say.
    const became = { none: ".", destroyed: " and destroyed its VM workspace.", gone: ". Its VM was already gone from its host.", left: ". Its VM was on a node that has left the fleet, so nothing there was touched." }[done.workspace] ?? ".";
    print(`Removed ${who}${became} What it said stays where it said it; its handle is retired.`);
    return;
  }
  throw new Error(usage);
}
