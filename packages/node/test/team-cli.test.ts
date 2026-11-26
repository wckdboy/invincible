import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeammateInput, type RouteName, type Teammate, type TeamMessage, type TeamRoom, type TeamRoomView, type TeamSnapshot } from "@galahad/core";
import { defaultAvatar, knightColors } from "@galahad/core/avatar";
import { teamCommand } from "../src/team-cli.ts";

/* `galahad roundtable` at a terminal, against what the node would answer. */

const member = (id: string, over: Partial<Teammate> = {}): Teammate => ({ id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "", role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 0, repository: null, workspaceNode: null, workspace: null, memory: "", avatar: defaultAvatar(id), createdBy: "owner", instructionsBy: "owner", createdAt: 1, updatedAt: 1, ...over });
function node(teammates: Teammate[]) {
  const saved: { name: RouteName; input: any }[] = [];
  const state: TeamSnapshot = { teammates, rooms: [], tasks: [], deliveries: [] };
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      if (name === "team") return state as T;
      saved.push({ name, input });
      const asked = input as { id: string; avatar: Teammate["avatar"] | null };
      return { teammate: { ...teammates.find((t) => t.id === asked.id)!, avatar: asked.avatar ?? defaultAvatar(asked.id) } } as T;
    },
  };
  return { api, saved };
}

test("the listing says which knights Galahad made for himself, and yours read as they always did", async () => {
  const lines: string[] = [];
  const { api } = node([member("ada"), member("scout", { createdBy: "galahad" }), member("rev", { createdBy: "ada", enabled: false }), member("old", { createdBy: undefined })]);
  await teamCommand(api, undefined, [], {}, (line) => lines.push(line));
  expect(lines).toEqual([
    "ada · Ada · native · enabled · 0/40 turns today · VM not provisioned",
    "scout · Scout · native · enabled · 0/40 turns today · VM not provisioned · made by Galahad",
    "rev · Rev · native · paused · 0/40 turns today · VM not provisioned · made by ada",
    "old · Old · native · enabled · 0/40 turns today · VM not provisioned",
  ]);
});

test("a task that has run says what it came to: how it ended, its time, its commands, and its model calls in tokens and, where you stated prices, money", async () => {
  const lines: string[] = [];
  const task = (id: string, over: object) => ({ id, room: "forge", assignee: "ada", title: `Task ${id}`, goal: "g", dependsOn: [], gates: [], status: "done", verified: true, progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2, ...over });
  const spent = [{ role: "engineer", model: "plan/m", calls: 9, unknown: 0, input: 90_000, output: 4000, cached: 70_000, reasoning: 1500 }, { role: "reviewer", model: "plan/r", calls: 1, unknown: 0, input: 6000, output: 500, cached: 0, reasoning: 0 }];
  const state = { teammates: [member("ada")], rooms: [], deliveries: [], tasks: [
    task("task-one", { record: { startedAt: 0, endedAt: 724_000, ended: "done", commands: 8, revisions: 1, spent } }),
    task("task-two", { status: "failed", verified: false, error: "unverified", record: { startedAt: 0, endedAt: 59_000, ended: "unverified", commands: 3, revisions: 2, spent: [{ ...spent[1]!, model: "other/unpriced" }] } }),
    task("task-old", {}),
  ] };
  const api = { async call<T>(name: RouteName): Promise<T> { return (name === "prices" ? { prices: { "plan/m": { input: 1, output: 4, cached: 0.2 }, "plan/r": { input: 0.5, output: 2 } } } : state) as T; } };
  await teamCommand(api, undefined, [], {}, (line) => lines.push(line));
  expect(lines.slice(1)).toEqual([
    "task-one · done (verified) · ada · Task task-one · 12m04s · 8 commands, sent back once · 101k tokens · $0.05",
    "task-two · failed · ada · Task task-two · ended unverified · 59s · 3 commands, sent back 2 times · 6,500 tokens · no price",
    // One from before records were kept reads as it always did.
    "task-old · done (verified) · ada · Task task-old",
  ]);
});

/** A node that answers each route with what the test gives it. */
const answering = (answers: Partial<Record<RouteName, unknown>>) => ({
  async call<T>(name: RouteName): Promise<T> {
    if (!(name in answers)) throw new Error(`unexpected call: ${name}`);
    return answers[name] as T;
  },
});
const room: TeamRoom = { id: "r1", name: "Workshop", members: ["ada", "lin"], direct: false, turnBudget: 8, paused: false, createdAt: 1, updatedAt: 1 };
const said = (speaker: string, speakerName: string, text: string): TeamMessage => ({ id: `m-${speaker}`, room: "r1", speaker, speakerName, text, createdAt: 1, chainId: "c1" });
const printed = async (api: { call<T>(name: RouteName, input?: unknown): Promise<T> }, sub: string | undefined, args: string[]) => {
  const lines: string[] = [];
  await teamCommand(api, sub, args, {}, (line) => lines.push(line));
  return lines;
};
// What a terminal acts on rather than shows: escapes, carriage returns, bells, backspaces, the one-character CSI.
const STEERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

test("a knight's words can't steer the terminal: escapes, carriage returns and reordering marks are taken out", async () => {
  const view: TeamRoomView = { ...room, tasks: [], deliveries: [], messages: [
    said("owner", "You", "Agree on the smallest change."),
    said("ada", "Ada", "Done.\u001b[2K\u001b[1A\rYou: ship it\u0007 \u009b31mred\u001b]0;title\u0007 \u202eevil\u202c ze\u200bro"),
  ] };
  const lines = await printed(answering({ teamRoom: view }), "chat", ["r1"]);
  // (A bare carriage return is a line break: what follows it is a later line, never an overwrite.)
  expect(lines).toEqual(["You: Agree on the smallest change.", "Ada: Done.[2K[1A\n  You: ship it 31mred]0;title evil zero"]);
  for (const line of lines) expect(line).not.toMatch(STEERS);
});

test("only a new speaker starts at the margin: a message's later lines are indented, whatever kind of line break made them", async () => {
  const view: TeamRoomView = { ...room, tasks: [], deliveries: [], messages: [
    said("ada", "Ada", "Reviewed.\n\nLin: I checked it, all gates pass.\r\nYou: merge it\u2028Galahad: agreed\n"),
    said("lin", "Lin\nYou", "My own line."),
  ] };
  const lines = await printed(answering({ teamRoom: view }), "chat", ["r1"]);
  expect(lines).toEqual(["Ada: Reviewed.\n  \n  Lin: I checked it, all gates pass.\n  You: merge it\n  Galahad: agreed", "Lin You: My own line."]);
  // Every line as the terminal shows it: the two speakers, and nothing else at the margin.
  expect(lines.join("\n").split("\n").filter((line) => !line.startsWith("  "))).toEqual(["Ada: Reviewed.", "Lin You: My own line."]);
  const direct = await printed(answering({ directTeammate: { room: { ...room, id: "dm-ada", direct: true } }, teamRoom: view }), "dm", ["ada"]);
  expect(direct).toEqual(lines);
});

test("at a terminal a long line is folded inside its width, indented: padding a message out to the edge puts nothing at the margin", async () => {
    const pad = " ".repeat(60);
    const view: TeamRoomView = { ...room, tasks: [], deliveries: [], messages: [
      said("ada", "Ada", `Reviewed.${pad}You: merge it now${pad}Lin: verified, all gates pass`),
      said("lin", "Lin", "A long line of ordinary words that runs well past the width of a narrow terminal window and has to be folded somewhere."),
      said("ada", "Ada", "\u7814\u7a76\u54e1".repeat(20)),
    ] };
    const lines: string[] = [];
    await teamCommand(answering({ teamRoom: view }), "chat", ["r1"], {}, (line) => lines.push(line), () => false, 40);
    const shown = lines.join("\n").split("\n");
    // Every line fits the terminal, so the terminal folds none itself; and only the three speakers start at the margin.
    for (const line of shown) expect([line, Bun.stringWidth(line) <= 40]).toEqual([line, true]);
    expect(shown.filter((line) => !line.startsWith("  "))).toEqual(["Ada: Reviewed.", "Lin: A long line of ordinary words that", `Ada: ${"\u7814\u7a76\u54e1".repeat(5)}\u7814\u7a76`]);
    // Nothing of the words is lost by the folding.
    expect(shown.join(" ").replace(/\s+/g, " ")).toContain("You: merge it now Lin: verified, all gates pass");
    expect(shown.join("").replace(/\s+/g, "")).toContain("\u7814\u7a76\u54e1".repeat(20));
    // Without a terminal (a pipe, a file) lines are left whole: there is no width to fold to.
    const piped: string[] = [];
    await teamCommand(answering({ teamRoom: view }), "chat", ["r1"], {}, (line) => piped.push(line), () => false);
    expect(piped[1]).toBe("Lin: A long line of ordinary words that runs well past the width of a narrow terminal window and has to be folded somewhere.");
});

test("names, titles and notes a model can write are shown as plain text too", async () => {
  const state: TeamSnapshot = {
    teammates: [member("ada", { name: "Ada\u001b[31m\nroot", memory: "Pick up at /work/tasks/t1.\u001b[2J\r\nRecheck the failing case\u0007." })],
    rooms: [{ ...room, name: "Work\u001b[0mshop\nr9 · Fake · ada" }],
    tasks: [{ id: "task-abcdefghijkl", room: "r1", assignee: "ada", title: "Fix parser\n\u001b[1Atask-zzzzzzzzzzzz · done (verified) · lin · Review", goal: "", dependsOn: [], gates: [], status: "queued", verified: false, progress: "", output: "", error: null, chainId: "c1", createdAt: 1, updatedAt: 1 }],
    deliveries: [],
  };
  const lines = await printed(answering({ team: state }), undefined, []);
  expect(lines).toEqual([
    "ada · Ada[31m root · native · enabled · 0/40 turns today · VM not provisioned",
    "r1 · Work[0mshop r9 · Fake · ada · ada, lin",
    "task-abcdefghijkl · queued · ada · Fix parser [1Atask-zzzzzzzzzzzz · done (verified) · lin · Review",
  ]);
  const notes = await printed(answering({ team: state }), "memory", ["ada"]);
  expect(notes).toEqual(["Pick up at /work/tasks/t1.[2J\nRecheck the failing case."]);
  for (const line of [...lines, ...notes]) expect(line).not.toMatch(STEERS);
});

test("a knight's orb is the colour you choose for it, or its handle's: --color saves it, --reset lets it go, reading saves nothing", async () => {
  const { api, saved } = node([member("ada")]);
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);
  await teamCommand(api, "avatar", ["ada"], { color: "#A8C9DB" }, say);
  expect(saved.at(-1)).toEqual({ name: "saveTeammate", input: { id: "ada", name: "Ada", avatar: { v: 2, color: "#a8c9db" } } });
  expect(JSON.parse(lines.at(-1)!)).toEqual(knightColors("ada", { v: 2, color: "#a8c9db" }));
  // What isn't a colour is the node's to refuse, as it was: nothing here guesses at it.
  await teamCommand(api, "avatar", ["ada"], { color: "blue" }, say);
  expect(saved.at(-1)!.input.avatar).toEqual({ v: 2, color: "blue" });
  await teamCommand(api, "avatar", ["ada"], { reset: true }, say);
  expect(saved.at(-1)!.input.avatar).toBeNull();
  // Reading it changes nothing, and says its colours: here, the ones its handle gives it.
  const before = saved.length;
  const read = node([member("ada")]);
  const shown: string[] = [];
  await teamCommand(read.api, "avatar", ["ada"], {}, (line) => shown.push(line));
  expect(read.saved).toHaveLength(0);
  expect(saved).toHaveLength(before);
  expect(JSON.parse(shown[0]!)).toEqual({ ...knightColors("ada"), chosen: false });
});

test("the drawings are gone: a look, a shape, eyes or a temperament is refused, saying what to give instead", async () => {
  const { api, saved } = node([member("ada")]);
  for (const flags of [{ look: "percival" }, { form: "round" }, { accent: "#112233" }, { eyes: "visor" }, { accessory: "crown" }, { temperament: "lively" }, { look: "bors", color: "#112233" }]) {
    await expect(teamCommand(api, "avatar", ["ada"], flags, () => {})).rejects.toThrow(/an orb now.*--color/);
  }
  expect(saved).toHaveLength(0);
});

test("removing a knight asks first and says what goes with it; a no, or a VM nobody said may go, removes nothing", async () => {
  const sent: { name: RouteName; input: unknown }[] = [];
  const state: TeamSnapshot = {
    teammates: [member("ada"), member("lin", { workspace: { node: "host", id: "0123456789" } }), member("sam", { workspaceNode: "host" }), member("ned", { workspace: { node: "old-host", id: "9876543210" } })], rooms: [], tasks: [], deliveries: [],
    removed: [{ id: "old", name: "Old\u001b[31m", removedAt: 1 }, { id: "gone", name: "Gone", removedAt: 2, conversations: ["room-abc", "room-def"] }],
  };
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      if (name === "team") return state as T;
      sent.push({ name, input });
      const asked = input as { id: string; destroyWorkspace?: boolean };
      // What became of its VM is the node's to say: destroyed, already gone (ned's), or none.
      return { removed: { id: asked.id, name: "" }, workspace: asked.id === "ned" ? "gone" : asked.destroyWorkspace ? "destroyed" : "none" } as T;
    },
  };
  const asked: string[] = [];
  const run = async (args: string[], flags: Record<string, unknown>, answer: boolean) => {
    const lines: string[] = [];
    await teamCommand(api, "remove", args, flags, (line) => lines.push(line), (question) => { asked.push(question); return answer; });
    return lines;
  };
  expect(await run(["ada"], {}, false)).toEqual(["Nothing was removed."]);
  expect(asked).toEqual(["Remove Ada (ada) for good? Its conversations stay to read, and its handle can never be used again."]);
  expect(sent).toEqual([]);
  expect(await run(["ada"], {}, true)).toEqual(["Removed Ada (ada). What it said stays where it said it; its handle is retired."]);
  expect(sent).toEqual([{ name: "removeTeammate", input: { id: "ada" } }]);
  // One with a VM: nothing is asked or sent until you say its workspace may go, and then the question says so.
  await expect(run(["lin"], {}, true)).rejects.toThrow(/--destroy-workspace/);
  expect(asked).toHaveLength(2);
  expect(sent).toHaveLength(1);
  expect(await run(["lin"], { "destroy-workspace": true }, true)).toEqual(["Removed Lin (lin) and destroyed its VM workspace. What it said stays where it said it; its handle is retired."]);
  expect(asked.at(-1)).toBe("Remove Lin (lin) for good, and destroy its VM 0123456789 on host with everything in /work? Its conversations stay to read, and its handle can never be used again.");
  expect(sent.at(-1)).toEqual({ name: "removeTeammate", input: { id: "lin", destroyWorkspace: true } });
  // One a VM was being made for when the node stopped may have one nobody bound: the same word is needed, and sent.
  await expect(run(["sam"], {}, true)).rejects.toThrow(/--destroy-workspace/);
  await run(["sam"], { "destroy-workspace": true }, true);
  expect(asked.at(-1)).toBe("Remove Sam (sam) for good, and destroy the VM that was being made for it on host with everything in /work? Its conversations stay to read, and its handle can never be used again.");
  expect(sent.at(-1)).toEqual({ name: "removeTeammate", input: { id: "sam", destroyWorkspace: true } });
  // What is printed is what the node says became of the VM, not what was expected of it.
  expect(await run(["ned"], { "destroy-workspace": true }, true)).toEqual(["Removed Ned (ned). Its VM was already gone from its host. What it said stays where it said it; its handle is retired."]);
  asked.length = 3; sent.length = 2;
  // --yes is the answer already.
  await run(["ada"], { yes: true }, false);
  expect(asked).toHaveLength(3);
  expect(sent).toHaveLength(3);
  await expect(run(["nobody"], {}, true)).rejects.toThrow(/No such knight/);
  await expect(run(["old"], {}, true)).rejects.toThrow(/already removed/);
  // The listing still names the ones that were removed: their handles are taken.
  const lines = await printed(api, undefined, []);
  expect(lines).toContain("old · Old[31m · removed");
  expect(lines).toContain("gone · Gone · removed · its conversations, kept to read: galahad roundtable chat room-abc, galahad roundtable chat room-def");
});

test("knights add --agent claude (or codex) asks the node for that harness, in a form its contract takes; the listing names it", async () => {
  for (const agent of ["claude", "codex"] as const) {
    const { api, saved } = node([member("ada", { harness: agent })]);
    const lines: string[] = [];
    await teamCommand(api, "add", ["ada"], { name: "Ada", agent }, (line) => lines.push(line));
    expect(saved).toEqual([{ name: "saveTeammate", input: { id: "ada", name: "Ada", harness: agent } }]);
    expect(TeammateInput.parse(saved[0]!.input).harness).toBe(agent);
    await teamCommand(api, undefined, [], {}, (line) => lines.push(line));
    expect(lines.at(-1)).toBe(`ada · Ada · ${agent} · enabled · 0/40 turns today · VM not provisioned`);
  }
});

test("knights engram says whether the notes store is on, and turns it on or off by the one route for it", async () => {
  const lines: string[] = [];
  const asked: { name: RouteName; input: unknown }[] = [];
  let on = false;
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "team") return { teammates: [], rooms: [], tasks: [], deliveries: [], ...(on ? { engram: true } : {}) } as T;
      if (name === "teamEngram") { on = (input as { on: boolean }).on; return { engram: on } as T; }
      throw new Error(`unexpected call: ${name}`);
    },
  };
  const say = (line: string) => lines.push(line);
  await teamCommand(api, "engram", [], {}, say);
  expect(lines.at(-1)).toBe("The notes store (Engram) is off: a knight's tasks are given none. Turn it on with: galahad roundtable engram on");
  await teamCommand(api, "engram", ["on"], {}, say);
  expect(asked.at(-1)).toEqual({ name: "teamEngram", input: { on: true } });
  expect(lines.at(-1)).toBe("The notes store (Engram) is on. A knight's task is given it when the knight's VM has the pinned Engram, and says which it was. Notes stay in that VM: they are leads a task checks, never his memory.");
  await teamCommand(api, "engram", [], {}, say);
  expect(lines.at(-1)).toBe("The notes store (Engram) is on: a knight's task is given it where its VM has the pinned Engram (Workspace, in the app, says which). Turn it off with: galahad roundtable engram off");
  await teamCommand(api, "engram", ["off"], {}, say);
  expect(asked.at(-1)).toEqual({ name: "teamEngram", input: { on: false } });
  expect(lines.at(-1)).toBe("The notes store (Engram) is off. What knights kept stays in each VM, unused, under /work/.memory/engram.");
  // Anything but on or off is not sent anywhere.
  const before = asked.length;
  await expect(teamCommand(api, "engram", ["maybe"], {}, say)).rejects.toThrow(/galahad roundtable engram \[on\|off\]/);
  await expect(teamCommand(api, "engram", ["on", "--tools=agent"], {}, say)).rejects.toThrow(/galahad roundtable engram \[on\|off\]/);
  expect(asked).toHaveLength(before);
});

test("roundtable ci says whether failing checks and reviews go back to the knight, and turns it on or off by the one route for it", async () => {
  const lines: string[] = [];
  const asked: { name: RouteName; input: unknown }[] = [];
  let on = false;
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "team") return { teammates: [], rooms: [], tasks: [], deliveries: [], ...(on ? { ciBack: true } : {}) } as T;
      if (name === "teamCi") { on = (input as { on: boolean }).on; return { ci: on } as T; }
      throw new Error(`unexpected call: ${name}`);
    },
  };
  const say = (line: string) => lines.push(line);
  await teamCommand(api, "ci", [], {}, say);
  expect(lines.at(-1)).toBe("Failing checks and reviews stay yours, except in an outcome, which gives them back on its own within its budget. Turn it on with: galahad roundtable ci on");
  await teamCommand(api, "ci", ["on"], {}, say);
  expect(asked.at(-1)).toEqual({ name: "teamCi", input: { on: true } });
  expect(lines.at(-1)).toStartWith("Failing checks, and reviews that ask for changes, go back to the knight whose work it was: a fix on the pull request's branch");
  expect(lines.at(-1)).toContain("Pushing a fix still waits for your approval.");
  await teamCommand(api, "ci", ["off"], {}, say);
  expect(asked.at(-1)).toEqual({ name: "teamCi", input: { on: false } });
  expect(lines.at(-1)).toStartWith("Failing checks and reviews stay yours");
  const before = asked.length;
  await expect(teamCommand(api, "ci", ["maybe"], {}, say)).rejects.toThrow(/galahad roundtable ci \[on\|off\]/);
  expect(asked).toHaveLength(before);
});

test("knights provision --remake has a knight's VM made again from its image as it is now, by its own route, and says what was kept", async () => {
  const lines: string[] = [];
  const asked: { name: RouteName; input: unknown }[] = [];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "remakeTeammate") return { workspace: { id: "6f4c603eb4", node: "ultra", network: (input as { network?: string }).network ?? "online" } } as T;
      throw new Error(`unexpected call: ${name}`);
    },
  };
  const say = (line: string) => lines.push(line);
  await teamCommand(api, "provision", ["gareth"], { remake: true }, say);
  expect(asked).toEqual([{ name: "remakeTeammate", input: { id: "gareth" } }]);
  expect(lines).toEqual(["VM 6f4c603eb4 on ultra made again from its image as it is now · /work kept · it can reach the internet"]);
  // What it can reach may be chosen again with it.
  await teamCommand(api, "provision", ["gareth"], { remake: true, network: "gateway" }, say);
  expect(asked.at(-1)).toEqual({ name: "remakeTeammate", input: { id: "gareth", network: "gateway" } });
  expect(lines.at(-1)).toBe("VM 6f4c603eb4 on ultra made again from its image as it is now · /work kept · it reaches the model gateway only");
  // Its host and its sizes are kept as they were made: asking for others is refused, never quietly ignored.
  for (const flag of ["on", "cpus", "mem", "disk"]) {
    await expect(teamCommand(api, "provision", ["gareth"], { remake: true, [flag]: "4" }, say)).rejects.toThrow(/made again where and as large as it is/);
  }
  expect(asked).toHaveLength(2);
});

test("a task that changed its repository says how many files and where they are kept, on its line", async () => {
  const lines: string[] = [];
  const changed = { id: "task-abcdefghijkl", room: "forge", assignee: "ada", title: "Fix the importer", goal: "g", dependsOn: [], gates: [], status: "done", verified: true, progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2, changes: { artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", files: 3, base: "0123456789abcdef0123456789abcdef01234567" } };
  const api = {
    async call<T>(name: RouteName): Promise<T> {
      if (name === "team") return { teammates: [member("ada")], rooms: [], tasks: [changed, { ...changed, id: "task-bbbbbbbbbbbb", title: "One line", changes: { ...changed.changes, files: 1 } }, { ...changed, id: "task-cccccccccccc", title: "No repository", changes: undefined }], deliveries: [] } as T;
      if (name === "prices") return { prices: {} } as T;
      throw new Error(`unexpected call: ${name}`);
    },
  };
  await teamCommand(api, undefined, [], {}, (line) => lines.push(line));
  expect(lines.find((line) => line.includes("Fix the importer"))).toBe("task-abcdefghijkl · done (verified) · ada · Fix the importer · 3 files changed, kept as art_AAAAAAAAAAAAAAAAAAAAAA");
  expect(lines.find((line) => line.includes("One line"))).toEndWith(" · 1 file changed, kept as art_AAAAAAAAAAAAAAAAAAAAAA");
  expect(lines.find((line) => line.includes("No repository"))).toBe("task-cccccccccccc · done (verified) · ada · No repository");
});

test("knights trail prints what a task did as it happened, and --follow keeps reading until the task has ended", async () => {
  const lines: string[] = [];
  const asked: { name: RouteName; input: any }[] = [];
  // The node's answers, in turn: a task at work with two lines, then a third, then ended with nothing new.
  const answers = [
    { task: { id: "task-abcdefghijkl", status: "running" }, entries: [{ n: 1, at: Date.UTC(2026, 10, 14, 13, 5, 9), text: "Plan · 1. Look." }, { n: 2, at: Date.UTC(2026, 10, 14, 13, 5, 12), text: "Running · ls\x1b[31m\nsecond line" }], more: false },
    { task: { id: "task-abcdefghijkl", status: "running" }, entries: [{ n: 3, at: Date.UTC(2026, 10, 14, 13, 5, 20), text: "Exit 0 · exit 0 · 3 ms" }], more: false },
    { task: { id: "task-abcdefghijkl", status: "failed" }, entries: [], more: false },
  ];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name !== "teamTrail") throw new Error(`unexpected call: ${name}`);
      return answers.shift() as T;
    },
  };
  await teamCommand(api, "trail", ["task-abcdefghijkl"], {}, (line) => lines.push(line));
  // Once, without --follow: what there is. A line of several lines is indented under its first; an escape character is taken out, so it can't steer the terminal.
  expect(asked).toEqual([{ name: "teamTrail", input: { task: "task-abcdefghijkl", after: 0 } }]);
  // (Times are the terminal's own: this machine's zone.)
  const at = (h: number, m: number, sec: number) => new Date(Date.UTC(2026, 10, 14, h, m, sec)).toTimeString().slice(0, 8);
  expect(lines).toEqual([`${at(13, 5, 9)}  Plan · 1. Look.`, `${at(13, 5, 12)}  Running · ls[31m\n          second line`, "(still running: galahad roundtable trail task-abcdefghijkl --follow)"]);
  lines.length = 0;
  await teamCommand(api, "trail", ["task-abcdefghijkl"], { follow: true, "poll-ms": "1" }, (line) => lines.push(line));
  expect(asked.slice(1).map((a) => a.input.after)).toEqual([0, 3]);
  expect(lines).toEqual([`${at(13, 5, 20)}  Exit 0 · exit 0 · 3 ms`, "(ended: failed)"]);
});

test("roundtable give puts a task to the Roundtable: it says who takes it and why, then how the others stood", async () => {
  const lines: string[] = [];
  const asked: { name: RouteName; input: unknown }[] = [];
  const api = {
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name !== "giveTeamTask") throw new Error(`unexpected call: ${name}`);
      return {
        task: { id: "task-abcdefghijkl" },
        choice: { id: "bedivere", name: "Bedivere", reasons: ["free now", "3 of 3 tasks verified", "has a desktop"] },
        considered: [
          { id: "bedivere", name: "Bedivere", eligible: true, score: 3.6, why: ["free now", "3 of 3 tasks verified", "has a desktop"] },
          { id: "gawain", name: "Gawain", eligible: true, score: 1.6, why: ["busy: 1 task running", "1 of 1 task verified", "has a desktop"] },
          { id: "gareth", name: "Gareth", eligible: false, score: 0, why: ["its VM has no desktop"] },
        ],
      } as T;
    },
  };
  await teamCommand(api, "give", ["Open", "the", "dashboard", "and", "click", "Export."], { gate: ["test -s export.csv"], desktop: true }, (line) => lines.push(line));
  expect(asked).toEqual([{ name: "giveTeamTask", input: { goal: "Open the dashboard and click Export.", gates: ["test -s export.csv"], needs: { desktop: true } } }]);
  expect(lines).toEqual([
    "Bedivere takes it: free now; 3 of 3 tasks verified; has a desktop.",
    "  Gawain: busy: 1 task running; 1 of 1 task verified; has a desktop",
    "  Gareth (can't take it): its VM has no desktop",
    "task-abcdefghijkl queued in Bedivere's own conversation; completion requires its gates and independent review.",
  ]);
  await expect(teamCommand(api, "give", [], {}, () => {})).rejects.toThrow(/usage: galahad roundtable give/);
});


test("a task a knight proposed is said to be waiting for you, and approved or declined by its id", async () => {
  const lines: string[] = [];
  const calls: { name: RouteName; input: unknown }[] = [];
  const proposed = { id: "task-abcdefghijkl", room: "forge", assignee: "ada", title: "Draft the notes", goal: "g", dependsOn: [], gates: [], status: "proposed", verified: false, progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2, proposedBy: "ada" };
  const api = { async call<T>(name: RouteName, input?: unknown): Promise<T> { if (name === "team") return { teammates: [member("ada")], rooms: [], tasks: [proposed], deliveries: [] } as T; calls.push({ name, input }); return {} as T; } };
  await teamCommand(api, undefined, [], {}, (line) => lines.push(line));
  expect(lines).toContain("task-abcdefghijkl · proposed · ada · Draft the notes · proposed by ada: galahad roundtable approve task-abcdefghijkl");
  await teamCommand(api, "approve", ["task-abcdefghijkl"], {}, (line) => lines.push(line));
  await teamCommand(api, "decline", ["task-abcdefghijkl"], {}, (line) => lines.push(line));
  expect(calls).toEqual([{ name: "controlTeam", input: { action: "approve", task: "task-abcdefghijkl" } }, { name: "controlTeam", input: { action: "stop", task: "task-abcdefghijkl" } }]);
  expect(lines.slice(-2)).toEqual(["approved: task task-abcdefghijkl", "declined: task task-abcdefghijkl"]);
});

test("a knight's own models: what it works on and what you may choose; set in order; given back to its role", async () => {
  const lines: string[] = [];
  const saved: { name: RouteName; input: any }[] = [];
  const knights = [member("ada"), member("rev", { models: ["ollama/mimo-v2.6:9b"] })];
  const api = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      if (name === "team") return { teammates: knights, rooms: [], tasks: [], deliveries: [] } as T;
      if (name === "teamModels") return { models: [{ ref: "deepseek/deepseek-v4-pro", on: [] }, { ref: "ollama/mimo-v2.6:9b", on: ["mini"] }] } as T;
      saved.push({ name, input });
      return { teammate: { ...knights.find((t) => t.id === input.id)!, ...(input.models ? { models: input.models } : { models: undefined }) } } as T;
    },
  };
  await teamCommand(api, "models", ["ada"], {}, (line) => lines.push(line));
  expect(lines).toEqual([
    "ada works on its role's models (engineer).",
    "To choose, in order: galahad roundtable models <knight> provider/model…; --role gives it its role's again. You may choose:",
    "  deepseek/deepseek-v4-pro",
    "  ollama/mimo-v2.6:9b · on mini",
  ]);
  lines.length = 0;
  await teamCommand(api, "models", ["ada", "ollama/mimo-v2.6:9b,deepseek/deepseek-v4-pro"], {}, (line) => lines.push(line));
  await teamCommand(api, "models", ["rev"], { role: true }, (line) => lines.push(line));
  expect(saved).toEqual([
    { name: "saveTeammate", input: { id: "ada", name: "Ada", models: ["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"] } },
    { name: "saveTeammate", input: { id: "rev", name: "Rev", models: null } },
  ]);
  expect(lines).toEqual(["ada works on ollama/mimo-v2.6:9b, deepseek/deepseek-v4-pro, in that order.", "rev works on its role's models (engineer)."]);
});

test("a knight in any ACP agent: the command that starts it is sent as you typed it", async () => {
  const { api, saved } = node([member("ada")]);
  await teamCommand(api, "add", ["ada"], { name: "Ada", agent: "acp", acp: "gemini --acp" }, () => {});
  expect(saved).toEqual([{ name: "saveTeammate", input: { id: "ada", name: "Ada", harness: "acp", acp: "gemini --acp" } }]);
});

test("sensitive mode at a terminal: whether a knight is in it, on and off, and a task in it alone, on the models named or its knight's own", async () => {
  const lines: string[] = [];
  const calls: { name: RouteName; input: any }[] = [];
  const knights = [member("ada", { models: ["nearai/Qwen/Qwen3.8-27B-abliterated"] }), member("lin")];
  const api = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      if (name === "team") return { teammates: knights, rooms: [], tasks: [], deliveries: [] } as T;
      calls.push({ name, input });
      if (name === "createTeamTask") return { task: { id: "task-abcdefghijkl" } } as T;
      const was = knights.find((t) => t.id === input.id)!;
      return { teammate: { ...was, ...(input.models ? { models: input.models } : {}), ...(input.sensitive ? { sensitive: true } : { sensitive: undefined }) } } as T;
    },
  };
  await teamCommand(api, "sensitive", ["ada"], {}, (line) => lines.push(line));
  await teamCommand(api, "sensitive", ["ada", "on"], {}, (line) => lines.push(line));
  await teamCommand(api, "sensitive", ["lin", "on", "heabsy/heabsy/cyberheabsy"], {}, (line) => lines.push(line));
  await teamCommand(api, "sensitive", ["ada", "off"], {}, (line) => lines.push(line));
  expect(lines).toEqual([
    "ada works on nearai/Qwen/Qwen3.8-27B-abliterated, in that order.",
    "To hold it to models of its own and nothing else: galahad roundtable sensitive ada on",
    "ada is in sensitive mode: every call of its work (its plan, its review, its conversations, its coding tool) goes to nearai/Qwen/Qwen3.8-27B-abliterated, in that order, and to nothing else.",
    "lin is in sensitive mode: every call of its work (its plan, its review, its conversations, its coding tool) goes to heabsy/heabsy/cyberheabsy, in that order, and to nothing else.",
    "ada works on nearai/Qwen/Qwen3.8-27B-abliterated, in that order.",
  ]);
  expect(calls.map((c) => c.input)).toEqual([
    { id: "ada", name: "Ada", sensitive: true },
    { id: "lin", name: "Lin", sensitive: true, models: ["heabsy/heabsy/cyberheabsy"] },
    { id: "ada", name: "Ada", sensitive: false },
  ]);
  await expect(teamCommand(api, "sensitive", ["ada", "maybe"], {}, () => {})).rejects.toThrow("usage: galahad roundtable sensitive <knight>");
  // A task in sensitive mode alone: on the models named, or with none named its knight's own; a knight with none is told what to do.
  lines.length = 0;
  calls.length = 0;
  await teamCommand(api, "task", ["dm-ada", "ada", "Read", "the", "leak"], { sensitive: true, models: "nearai/Qwen/Qwen3.8-27B-abliterated" }, (line) => lines.push(line));
  await teamCommand(api, "task", ["dm-ada", "ada", "Again"], { sensitive: true }, (line) => lines.push(line));
  expect(calls.map((c) => c.input.models)).toEqual([["nearai/Qwen/Qwen3.8-27B-abliterated"], ["nearai/Qwen/Qwen3.8-27B-abliterated"]]);
  expect(lines[0]).toBe("task-abcdefghijkl queued; completion requires its gates and independent review. In sensitive mode: every call of its work on nearai/Qwen/Qwen3.8-27B-abliterated alone.");
  await expect(teamCommand(api, "task", ["dm-lin", "lin", "Work"], { sensitive: true }, () => {})).rejects.toThrow("lin has no models of its own to hold the task to");
});

test("the listing says how you stepped in on each task, and the north star over the last thirty days (#28)", async () => {
  const lines: string[] = [];
  const task = (id: string, over: object) => ({ id, room: "forge", assignee: "ada", title: `Task ${id}`, goal: "g", dependsOn: [], gates: [], status: "done", verified: true, progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2, ...over });
  const state = { teammates: [], rooms: [], deliveries: [], tasks: [
    task("task-one", { interventions: { approval: 1, message: 2 } }),
    task("task-two", {}),
  ], northStar: { since: 0, completed: 2, ended: 3, interventions: 3, perCompleted: 1.5 as number | null, byKind: { approval: 1, message: 2 } as Record<string, number> } };
  const api = { async call<T>(): Promise<T> { return state as T; } };
  await teamCommand(api, undefined, [], {}, (line) => lines.push(line));
  expect(lines).toContain("task-one · done (verified) · ada · Task task-one · you stepped in: an approval and two messages");
  expect(lines).toContain("task-two · done (verified) · ada · Task task-two");
  expect(lines).toContain("You stepped in 3 times on the 3 tasks that ended in the last 30 days: 1.5 a task done and verified (2).");
  // None done and verified: the count alone.
  const none: string[] = [];
  state.northStar = { since: 0, completed: 0, ended: 1, interventions: 1, perCompleted: null, byKind: {} };
  await teamCommand(api, undefined, [], {}, (line) => none.push(line));
  expect(none).toContain("You stepped in 1 time on the 1 task that ended in the last 30 days, and none was done and verified.");
});

test("a knight's workspace from a terminal: a folder, a file, and what its task changed", async () => {
  const answers: Record<string, unknown> = {
    teamFiles: { id: "ada", path: "/work", entries: [{ name: "src", kind: "dir", size: 4096, modified: 1 }, { name: "README.md", kind: "file", size: 2048, modified: 1 }, { name: "latest", kind: "link", size: 9, modified: 1 }], more: false },
    teamFile: { id: "ada", path: "/work/a.ts", size: 900_000, modified: 1, kind: "text", text: "export const ok = true;\n", cut: true, redacted: true },
    teamChanges: { id: "ada", task: "task-abcdefghijkl", path: "/work/tasks/task-abcdefghijkl", base: "a".repeat(40), head: "b".repeat(40), files: [{ path: "sync.ts", status: "M", added: 2, removed: 1 }, { path: "logo.png", status: "A", added: null, removed: null }], untracked: ["notes.md"], diff: "+export const retries = 3;\n", cut: false },
  };
  const asked: [string, unknown][] = [];
  const api = { async call<T>(name: RouteName, input?: unknown): Promise<T> { asked.push([name, input]); return answers[name] as T; } };
  const lines: string[] = [];
  await teamCommand(api, "files", ["ada"], {}, (line) => lines.push(line));
  await teamCommand(api, "read", ["ada", "/work/a.ts"], {}, (line) => lines.push(line));
  await teamCommand(api, "changes", ["ada"], {}, (line) => lines.push(line));
  expect(lines).toEqual([
    "src/", "README.md  2 KB", "latest  (a link)",
    "export const ok = true;", "(only its beginning: it is 879 KB)", "(something that looked like a key was redacted)",
    `task-abcdefghijkl in /work/tasks/task-abcdefghijkl, from ${"a".repeat(12)}`, "M sync.ts  +2 -1", "A logo.png  (binary)", "? notes.md", "\n+export const retries = 3;",
  ]);
  expect(asked).toEqual([["teamFiles", { id: "ada" }], ["teamFile", { id: "ada", path: "/work/a.ts" }], ["teamChanges", { id: "ada" }]]);
  await expect(teamCommand(api, "read", ["ada"], {}, () => {})).rejects.toThrow("usage: galahad roundtable read <knight> </work/path>");
});

test("a task's steps at a terminal, and the task given again from one of them, or from its start", async () => {
  const lines: string[] = [];
  const calls: { name: RouteName; input: any }[] = [];
  const old = { id: "task-abcdefghijkl", room: "dm-ada", assignee: "ada", title: "Build", goal: "Build it.", dependsOn: [], gates: ["bun test"], status: "failed", verified: false, progress: "", output: "", error: null, chainId: "c", createdAt: 1, updatedAt: 2 };
  const api = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      calls.push({ name, input });
      if (name === "team") return { teammates: [member("ada")], rooms: [], tasks: [old], deliveries: [] } as T;
      if (name === "teamSteps") return { steps: [{ step: 1, commit: "3".repeat(40), command: "npm run build", at: Date.UTC(2026, 10, 19, 21, 4, 5) }] } as T;
      return { task: { id: "task-newnewnewnew" } } as T;
    },
  };
  await teamCommand(api, "steps", ["task-abcdefghijkl"], {}, (line) => lines.push(line));
  expect(lines[0]).toMatch(/^ {3}1 {2}\d\d:\d\d:\d\d {2}npm run build$/);
  expect(lines[1]).toBe('Give it again from one: galahad roundtable again task-abcdefghijkl --from <step> ["<goal>"]');
  lines.length = 0;
  await teamCommand(api, "again", ["task-abcdefghijkl", "Build", "it", "the", "other", "way."], { from: "1" }, (line) => lines.push(line));
  await teamCommand(api, "again", ["task-abcdefghijkl"], {}, (line) => lines.push(line));
  const given = calls.filter((c) => c.name === "createTeamTask").map((c) => c.input);
  expect(given).toEqual([
    { room: "dm-ada", assignee: "ada", title: "Build", goal: "Build it the other way.", gates: ["bun test"], again: "task-abcdefghijkl", from: { task: "task-abcdefghijkl", step: 1 } },
    { room: "dm-ada", assignee: "ada", title: "Build", goal: "Build it.", gates: ["bun test"], again: "task-abcdefghijkl" },
  ]);
  expect(lines).toEqual(["task-newnewnewnew queued: task-abcdefghijkl given again, from its step 1; completion requires its gates and independent review.", "task-newnewnewnew queued: task-abcdefghijkl given again; completion requires its gates and independent review."]);
  await expect(teamCommand(api, "again", ["task-abcdefghijkl"], { from: "0" }, () => {})).rejects.toThrow("--from names a step by its number");
});

test("keys of yours a knight may use, at a terminal: given (reads only unless --write), listed, taken back", async () => {
  const lines: string[] = [];
  const saved: any[] = [];
  let keys: any[] | undefined;
  const api = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      if (name === "team") return { teammates: [member("ada", keys ? { keys } : {})], rooms: [], tasks: [], deliveries: [] } as T;
      // How often its scripts used each, as the node counts them from the ledger.
      if (name === "teamKeyUses") return { days: 30, uses: { stripe: 1, acme: 12 } } as T;
      saved.push(input);
      keys = input.keys ?? undefined;
      return { teammate: member("ada", keys ? { keys } : {}) } as T;
    },
  };
  await teamCommand(api, "keys", ["ada"], {}, (line) => lines.push(line));
  await teamCommand(api, "keys", ["ada", "add", "stripe"], {}, (line) => lines.push(line));
  await teamCommand(api, "keys", ["ada", "add", "acme"], { header: "x-api-key", write: true }, (line) => lines.push(line));
  await teamCommand(api, "keys", ["ada", "rm", "stripe"], {}, (line) => lines.push(line));
  expect(saved.map((s) => s.keys)).toEqual([
    [{ secret: "stripe", header: "authorization", write: false }],
    [{ secret: "stripe", header: "authorization", write: false }, { secret: "acme", header: "x-api-key", write: true }],
    [{ secret: "acme", header: "x-api-key", write: true }],
  ]);
  expect(lines[0]).toContain("ada has no keys of yours to use");
  expect(lines).toContain("stripe · reads only · in Authorization: Bearer · used 1 time in 30 days");
  expect(lines).toContain("acme · reads and writes · in x-api-key · used 12 times in 30 days");
  await expect(teamCommand(api, "keys", ["ada", "add"], {}, () => {})).rejects.toThrow("usage: galahad roundtable keys");
});

test("export writes a knight as a file you carry; import shows it, then makes it a new knight here, never over one that's here", async () => {
  const dir = mkdtempSync(join(tmpdir(), "galahad-knight-file-"));
  try {
    const ada = member("ada", { instructions: "Reviews pull requests.\n\nAsks before merging.", harness: "codex", keys: [{ secret: "stripe", header: "authorization", write: false }], memory: "the owner's private notes" });
    const lines: string[] = [];
    await teamCommand(node([ada]).api, "export", ["ada"], {}, (line) => lines.push(line));
    const file = lines.join("\n");
    expect(file).toContain('id: "ada"');
    expect(file).toContain('harness: "codex"');
    expect(file).toContain('keys: ["stripe"]');
    expect(file).not.toContain("private notes");
    const path = join(dir, "ada.md");
    await Bun.write(path, file);

    const saved: unknown[] = [];
    const elsewhere = (teammates: Teammate[], removed: { id: string; name: string }[] = []) => ({
      async call<T>(name: RouteName, input?: unknown): Promise<T> {
        if (name === "team") return { teammates, removed, rooms: [], tasks: [], deliveries: [] } as T;
        if (name !== "saveTeammate") throw new Error(`unexpected call: ${name}`);
        saved.push(input);
        return { teammate: { ...member((input as { id: string }).id), ...(input as object) } } as T;
      },
    });
    // A handle that's taken here, by a knight or by one you removed, is never written over.
    await expect(teamCommand(elsewhere([member("ada")]), "import", [path], { yes: true }, () => {})).rejects.toThrow("There is a knight ada here already");
    await expect(teamCommand(elsewhere([], [{ id: "ada", name: "Ada" }]), "import", [path], { yes: true }, () => {})).rejects.toThrow("--id <another id>");
    // Shown first; not made without your yes.
    const shown: string[] = [];
    await teamCommand(elsewhere([]), "import", [path], {}, (line) => shown.push(line), () => false);
    expect(shown[0]).toBe("Ada (ada) · codex · on its role's models (engineer)");
    expect(shown[1]).toBe("Its job: Reviews pull requests. …");
    expect(saved).toEqual([]);
    // Made as a new knight under another handle; the keys it had are named, and none is given.
    const made: string[] = [];
    await teamCommand(elsewhere([member("ada")]), "import", [path], { id: "ada2", yes: true }, (line) => made.push(line));
    expect(saved).toEqual([expect.objectContaining({ id: "ada2", name: "Ada", instructions: "Reviews pull requests.\n\nAsks before merging.", role: "engineer", harness: "codex", dailyTurns: 40 })]);
    expect(saved[0]).not.toHaveProperty("keys");
    expect(made.at(-1)).toBe("Where it came from it was given stripe: none is given here unless you say so (galahad roundtable keys ada2 add <secret>).");
    // Not a knight file: said, and nothing made.
    await Bun.write(join(dir, "notes.md"), "# Notes\n");
    await expect(teamCommand(elsewhere([]), "import", [join(dir, "notes.md")], { yes: true }, () => {})).rejects.toThrow("That isn't a knight file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
