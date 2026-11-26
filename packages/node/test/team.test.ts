import { afterEach, describe, expect, test } from "bun:test";
import { TEAM_LIMITS } from "../../core/src/team-limits.ts";
import { TeamStore } from "../src/team-store.ts";
import { TeamError, TeamService, type TeamServiceOptions } from "../src/team.ts";

const fixtures: { store: TeamStore; service: TeamService }[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.service.stop(); fixture.store.close(); } });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
async function until(ready: () => boolean): Promise<void> { for (let n = 0; n < 100 && !ready(); n++) await new Promise((resolve) => setTimeout(resolve, 1)); expect(ready()).toBe(true); }
function setup(options: Partial<Omit<TeamServiceOptions, "store">> = {}, budget = 8) {
  const store = new TeamStore(":memory:");
  for (const [id, name] of [["ada", "Ada"], ["lin", "Lin"], ["sam", "Sam"]] as const) store.saveTeammate({ id, name });
  store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada", "lin"], turnBudget: budget });
  const service = new TeamService({ store, respond: async () => "", executeTask: async () => ({ verified: true, output: "Verified" }), ...options });
  fixtures.push({ store, service });
  return { store, service };
}

describe("knights converse through the node", () => {
  test("an owner message reaches the knights it names; silence does not fan out", async () => {
    const heard: string[] = [];
    const { store, service } = setup({ respond: async (teammate, _room, history) => { heard.push(teammate.id); expect(history[0]?.speaker).toBe("owner"); return ""; } });
    service.post({ room: "workshop", text: "@ada, @lin: review this together." }); service.start(); await service.settled();
    expect(heard.sort()).toEqual(["ada", "lin"]);
    expect(store.messages("workshop")).toHaveLength(1);
    expect(store.deliveries().every((d) => d.status === "done")).toBe(true);
  });
  test("a message that names knights with @ reaches only them; yours that names none of them here is Galahad's (he names who takes it up)", async () => {
    const heard: string[] = [];
    const { service } = setup({ respond: async (teammate) => { heard.push(teammate.id); return ""; } });
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada", "lin", "sam"] });
    service.start();
    const expected: [string, string[]][] = [
      ["@lin, check the parser.", ["lin"]],
      ["@Ada and @SAM: the release?", ["ada", "sam"]],
      ["Everyone: the release?", []],
      ["@bors is not here: who takes it?", []],
      ["mail me at a@lin.example", []],
    ];
    for (const [text, hearers] of expected) {
      heard.length = 0;
      service.post({ room: "workshop", text }); await service.settled();
      expect([text, heard.sort()]).toEqual([text, hearers]);
    }
  });
  test("ordinary replies preserve identity and conversation ping-pong stops at the shared budget", async () => {
    const { store, service } = setup({ respond: async (teammate) => `I am ${teammate.name}.` }, 3);
    service.post({ room: "workshop", text: "@ada @lin: discuss." }); service.start(); await service.settled();
    const messages = store.messages("workshop");
    expect(messages).toHaveLength(4);
    expect(new Set(messages.map((m) => m.chainId)).size).toBe(1);
    expect(messages.slice(1).every((m) => m.speaker === "ada" || m.speaker === "lin")).toBe(true);
    expect(store.teammates().reduce((sum, t) => sum + t.turnsToday, 0)).toBe(3);
    expect(store.queued()).toHaveLength(0);
    expect(store.deliveries().some((d) => d.error?.includes("turn budget"))).toBe(true);
  });
  test("initiated DMs keep the same causal budget across rooms", async () => {
    let turns = 0;
    const { store, service } = setup({ respond: async (teammate, _room, _history, context) => { turns++; context.send({ teammate: teammate.id === "ada" ? "lin" : "ada" }, "Please discuss."); return ""; } }, 4);
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"] });
    service.post({ room: "workshop", text: "@ada, ask Lin." }); service.start(); await service.settled();
    expect(turns).toBe(4);
    const direct = store.rooms().find((r) => r.direct)!;
    expect(direct.members.sort()).toEqual(["ada", "lin"]);
    const all = [...store.messages("workshop"), ...store.messages(direct.id)];
    expect(new Set(all.map((m) => m.chainId)).size).toBe(1);
  });
  test("the callback cannot spoof a sender or post into a room it does not belong to", async () => {
    const { store, service } = setup({ respond: async (_teammate, _room, _history, context) => { context.send({ room: "private" }, "Intrusion"); return ""; } });
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"] });
    service.saveRoom({ id: "private", name: "Private", members: ["sam"] });
    service.post({ room: "workshop", text: "@ada, work." }); service.start(); await service.settled();
    expect(store.messages("private")).toHaveLength(0);
    expect(store.deliveries()[0]?.status).toBe("failed");
    expect(store.deliveries()[0]?.error).toContain("not a member");
  });
  test("model memory is private to the callback's identity and secret output never lands in history", async () => {
    const fake = "sk-ant-" + "obviouslyfaketest".repeat(3);
    const { store, service } = setup({ respond: async (teammate, _room, _history, context) => { context.remember(`${teammate.name}'s note.`); return fake; } }, 2);
    service.post({ room: "workshop", text: "@ada @lin, remember." }); service.start(); await service.settled();
    expect(store.teammate("ada")?.memory).toBe("Ada's note.");
    expect(store.teammate("lin")?.memory).toBe("Lin's note.");
    expect(store.teammate("sam")?.memory).toBe("");
    expect(JSON.stringify(store.messages("workshop"))).not.toContain(fake);
  });
});

describe("Galahad sits in rooms", () => {
  test("your word to a room that names no knight is his: he answers in the room, and only the knights he names hear it", async () => {
    const heard: string[] = [];
    const asked: unknown[] = [];
    const { store, service } = setup({
      respond: async (teammate) => { heard.push(teammate.id); return ""; },
      answer: async (room, history, ask) => { asked.push([room.id, ask.asker, ask.trigger?.text, history.length]); return "@lin, check the parser please."; },
    });
    service.post({ room: "workshop", text: "Is the parser right?" }, { kind: "client", device: "d_phone" }); service.start(); await service.settled();
    expect(asked).toEqual([["workshop", { kind: "client", device: "d_phone" }, "Is the parser right?", 1]]);
    expect(heard).toEqual(["lin"]);
    const said = store.messages("workshop");
    expect(said.map((m) => [m.speaker, m.speakerName])).toEqual([["owner", "You"], ["galahad", "Galahad"]]);
    expect(new Set(said.map((m) => m.chainId)).size).toBe(1);
    expect(store.roomView("workshop").deliveries.find((d) => d.teammate === "galahad")).toMatchObject({ status: "done", trigger: said[0]!.id });
  });
  test("@galahad reaches him and @knights reach them; in a knight's own conversation your words stay the knight's unless you name him", async () => {
    const heard: string[] = [];
    const { service } = setup({ respond: async (teammate) => { heard.push(teammate.id); return ""; }, answer: async () => { heard.push("galahad"); return ""; } });
    const own = service.direct("ada");
    service.start();
    const expected: [string, string, string[]][] = [
      ["workshop", "@galahad, what do you make of it?", ["galahad"]],
      ["workshop", "@lin, check the parser.", ["lin"]],
      ["workshop", "@Galahad and @ada: the release?", ["ada", "galahad"]],
      ["workshop", "Everyone: the release?", ["galahad"]],
      ["workshop", "mail me at a@galahad.example", ["galahad"]],
      [own.id, "How is the fixture?", ["ada"]],
      [own.id, "@galahad, is Ada right?", ["galahad"]],
    ];
    for (const [room, text, hearers] of expected) {
      heard.length = 0;
      service.post({ room, text }); await service.settled();
      expect([text, heard.sort()]).toEqual([text, hearers]);
    }
  });
  test("a knight that names him gets his answer with no hands: it is said to be a knight's asking, and his answer that names nobody reaches nobody", async () => {
    let turns = 0;
    const asks: unknown[] = [];
    const { store, service } = setup({
      respond: async (teammate) => { turns++; return teammate.id === "ada" ? "@galahad, which branch do I take?" : "Lin here."; },
      answer: async (_room, _history, ask) => { asks.push(ask.asker); return "Take main."; },
    });
    service.post({ room: "workshop", text: "@ada, start the release." }); service.start(); await service.settled();
    expect(asks).toEqual([{ kind: "knight", teammate: "ada" }]);
    expect(store.messages("workshop").map((m) => m.speaker)).toEqual(["owner", "ada", "galahad"]);
    expect(turns).toBe(1);
  });
  test("[SILENT] posts nothing; a knight's word to the room without @galahad never reaches him", async () => {
    const answers = ["Done: the parser is right.", "[SILENT]"];
    let asked = 0;
    const { store, service } = setup({ respond: async () => "", answer: async () => { asked++; return answers.shift()!; } });
    service.start();
    service.post({ room: "workshop", text: "Is the parser right?" }); await service.settled();
    service.post({ room: "workshop", text: "Thanks." }); await service.settled();
    expect(asked).toBe(2);
    expect(store.messages("workshop").map((m) => m.speaker)).toEqual(["owner", "galahad", "owner"]);
    expect(store.roomView("workshop").deliveries.filter((d) => d.teammate === "galahad").map((d) => d.status)).toEqual(["done", "done"]);
    const opened = service.post({ room: "workshop", text: "@ada, @lin: talk it over." }); await service.settled();
    store.post({ room: "workshop", text: "Lin, shall we?" }, { teammate: "ada", chainId: opened.chainId }); await service.settled();
    expect(asked).toBe(2);
  });
  test("one answer of his waits per room, for its newest words; when you asked as well as a knight, it is yours", () => {
    const store = new TeamStore(":memory:");
    for (const [id, name] of [["ada", "Ada"], ["lin", "Lin"]] as const) store.saveTeammate({ id, name });
    store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada", "lin"] });
    const go = store.post({ room: "workshop", text: "@ada, go." });
    store.post({ room: "workshop", text: "@galahad, which branch?" }, { teammate: "ada", chainId: go.chainId });
    expect(store.queuedAnswers()).toEqual([expect.objectContaining({ asker: { kind: "knight", teammate: "ada" } })]);
    const yours = store.post({ room: "workshop", text: "@galahad, and check the tests." }, { asker: { kind: "client", device: "d_phone" } });
    store.post({ room: "workshop", text: "@galahad, main?" }, { teammate: "ada", chainId: go.chainId });
    const [waiting, ...more] = store.queuedAnswers();
    expect(more).toEqual([]);
    expect(waiting).toMatchObject({ asker: { kind: "client", device: "d_phone" }, chainId: go.chainId, trigger: store.messages("workshop").at(-1)!.id });
    // One under way, and one waits behind it for what came after.
    expect(store.claimAnswer(waiting!.id)).toBe(true);
    store.post({ room: "workshop", text: "Anything else?" });
    expect(store.queuedAnswers()).toHaveLength(1);
    expect(store.claimAnswer(store.queuedAnswers()[0]!.id)).toBe(false);
    store.answered(waiting!.id, "Main, and the tests pass.");
    expect(store.claimAnswer(store.queuedAnswers()[0]!.id)).toBe(true);
    expect(yours.speaker).toBe("owner");
    store.close();
  });
  test("his answers spend the conversation's budget as any turn does", async () => {
    const { store, service } = setup({ respond: async (teammate) => `@galahad, ${teammate.name} here.`, answer: async () => "@ada @lin, carry on." }, 4);
    service.post({ room: "workshop", text: "Start." }); service.start(); await service.settled();
    const said = store.messages("workshop");
    expect(said.map((m) => m.speaker).filter((s) => s === "galahad")).toHaveLength(2);
    expect(said).toHaveLength(5);
    expect(new Set(said.map((m) => m.chainId)).size).toBe(1);
    expect(store.queuedAnswers()).toEqual([]);
    expect(store.deliveries().some((d) => d.error?.includes("turn budget"))).toBe(true);
  });
  test("an answer that fails says so in the room; one stopped by your pause says nothing and waits for nothing", async () => {
    const { store, service } = setup({ answer: async () => { throw new Error("no model in the planner role answered"); } });
    service.post({ room: "workshop", text: "Is the parser right?" }); service.start(); await service.settled();
    expect(store.messages("workshop").at(-1)).toMatchObject({ speaker: "galahad", text: "I couldn't answer: no model in the planner role answered" });
    expect(store.roomView("workshop").deliveries.find((d) => d.teammate === "galahad")).toMatchObject({ status: "failed", error: "no model in the planner role answered" });

    const started = deferred();
    const held = setup({ answer: (_room, _history, _ask, signal) => new Promise((_, reject) => { started.resolve(); signal.addEventListener("abort", () => reject(signal.reason)); }) });
    held.service.post({ room: "workshop", text: "Take your time." }); held.service.start();
    await started.promise;
    held.service.control({ room: "workshop", action: "pause" });
    await held.service.settled();
    expect(held.store.messages("workshop").map((m) => m.speaker)).toEqual(["owner"]);
    expect(held.store.roomView("workshop").deliveries.find((d) => d.teammate === "galahad")).toMatchObject({ status: "interrupted", error: "Paused by you." });
    // Asked while the room is paused, he waits for you to resume it.
    held.service.post({ room: "workshop", text: "Still there?" }); await held.service.settled();
    expect(held.store.queuedAnswers()).toHaveLength(1);
  });
  test("his answers are no part of his allowance: only what he says from his own conversation counts", () => {
    const store = new TeamStore(":memory:");
    for (const [id, name] of [["ada", "Ada"], ["lin", "Lin"]] as const) store.saveTeammate({ id, name });
    store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada", "lin"] });
    for (let n = 0; n < TEAM_LIMITS.saysPerDay; n++) {
      store.post({ room: "workshop", text: `Question ${n}?` });
      const [answer] = store.queuedAnswers();
      expect(store.claimAnswer(answer!.id)).toBe(true);
      store.answered(answer!.id, `Answer ${n}.`);
    }
    expect(store.post({ room: "workshop", text: "From my own conversation." }, { galahad: true }).speaker).toBe("galahad");
    store.close();
  });
  test("a crash leaves his answer under way interrupted, never given twice", () => {
    const store = new TeamStore(":memory:");
    store.saveTeammate({ id: "ada", name: "Ada" });
    store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"] });
    store.post({ room: "workshop", text: "Is the parser right?" });
    const [answer] = store.queuedAnswers();
    store.claimAnswer(answer!.id);
    store.recover();
    expect(store.answer(answer!.id)).toMatchObject({ status: "interrupted" });
    expect(store.queuedAnswers()).toEqual([]);
    expect(store.room("workshop")!.paused).toBe(false);
    store.close();
  });
});

describe("Galahad seats and briefs knights", () => {
  test("a knight that needs another makes one: it joins the room within the one bounded chain, and the work given it there waits for your approval", async () => {
    const heard: string[] = [];
    const recruited: string[] = [];
    const { store, service } = setup({
      onRecruit: (made) => { recruited.push(`${made.id} by ${made.createdBy}`); throw new Error("an observer cannot undo it"); },
      respond: async (teammate, _room, _history, context) => {
        heard.push(teammate.id);
        if (teammate.id !== "ada" || store.teammate("rev")) return "";
        const made = context.recruit({ id: "rev", name: "Rev", instructions: "Review Ada's diffs independently." });
        context.delegate({ assignee: made.id, title: "Review", goal: "Review the parser fix." });
        return "I made Rev to review this.";
      },
    }, 6);
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"] });
    const asked = service.post({ room: "workshop", text: "@ada, fix the parser, and have it reviewed." }); service.start(); await service.settled();
    expect(store.teammate("rev")).toMatchObject({ createdBy: "ada", instructionsBy: "ada", enabled: true, instructions: "Review Ada's diffs independently." });
    expect(recruited).toEqual(["rev by ada"]);
    expect(store.room("workshop")!.members).toEqual(["ada", "rev"]);
    expect(store.tasks("workshop").map((task) => [task.assignee, task.status, task.proposedBy, task.chainId])).toEqual([["rev", "proposed", "ada", asked.chainId]]);
    // Rev hears Ada's reply in the room it joined, in the same chain: nothing of this started a budget of its own.
    expect(heard).toContain("rev");
    expect(store.deliveries().every((delivery) => delivery.chainId === asked.chainId)).toBe(true);
    expect(store.teammates().reduce((sum, t) => sum + t.turnsToday, 0)).toBeLessThanOrEqual(6);
    // Approved, Rev does it.
    service.control({ task: store.tasks("workshop")[0]!.id, action: "approve" }); await service.settled();
    expect(store.tasks("workshop").map((task) => [task.assignee, task.status])).toEqual([["rev", "done"]]);
  });
  test("making knights is held to the day's allowance and to a turn's actions; one who may no longer act makes none", async () => {
    const outcomes: string[] = [];
    const { store, service } = setup({ respond: async (teammate, _room, _history, context) => {
      if (teammate.id !== "ada") return "";
      for (let n = 0; n < 70; n++) {
        try { context.recruit({ id: `helper-${n}`, name: `Helper-${n}`, instructions: "Help." }); outcomes.push("made"); }
        catch (error) { const message = (error as Error).message; outcomes.push(message.includes("allowance") ? "allowance" : message.includes("action limit") ? "actions" : message); }
      }
      return "";
    } });
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"] });
    service.post({ room: "workshop", text: "@ada, get help." }); service.start(); await service.settled();
    // Eight in a day; asking again is an action too, and a turn has sixty-four of those.
    expect(outcomes.slice(0, 8)).toEqual(Array(8).fill("made"));
    expect(outcomes.slice(8, 64)).toEqual(Array(56).fill("allowance"));
    expect(outcomes.slice(64)).toEqual(Array(6).fill("actions"));
    expect(store.teammates().filter((t) => t.createdBy === "ada")).toHaveLength(8);
  });
  test("a knight that was paused while it worked makes no one", async () => {
    let outcome = "";
    const { store, service } = setup({ respond: async (teammate, _room, _history, context) => {
      if (teammate.id !== "ada") return "";
      store.enable("ada", false);
      try { context.recruit({ id: "after-pause", name: "After", instructions: "Help." }); outcome = "made"; } catch (error) { outcome = (error as Error).message; }
      return "";
    } });
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"] });
    service.post({ room: "workshop", text: "@ada, get help." }); service.start(); await service.settled();
    expect(outcome).toContain("may no longer act");
    expect(store.teammate("after-pause")).toBeNull();
  });
  test("a knight made in a direct conversation stays out of it, and is reached by a message of its maker's", async () => {
    const { store, service } = setup({ respond: async (teammate, room, _history, context) => {
      if (teammate.id === "ada" && room.direct && room.members.length === 1 && !store.teammate("aide")) {
        const made = context.recruit({ id: "aide", name: "Aide", instructions: "Gather the references Ada asks for." });
        context.send({ teammate: made.id }, "Please gather the parser references.");
        return "I made Aide and asked for the references.";
      }
      return teammate.id === "aide" ? "Here they are." : "";
    } }, 5);
    const direct = service.direct("ada");
    const asked = service.post({ room: direct.id, text: "Find the references." }); service.start(); await service.settled();
    expect(store.room(direct.id)!.members).toEqual(["ada"]);
    const between = store.rooms().find((room) => room.direct && room.members.length === 2)!;
    expect(between.members).toEqual(["ada", "aide"]);
    expect(store.messages(between.id).map((message) => [message.speaker, message.chainId])).toEqual([["ada", asked.chainId], ["aide", asked.chainId]]);
  });
  test("Galahad's own message reaches a knight in its direct conversation with you, or a room, as his", async () => {
    const { store, service } = setup({ respond: async (teammate, _room, history) => `${teammate.name} heard ${history.at(-1)!.speakerName}.` }, 2);
    service.start();
    const toSam = service.say({ teammate: "sam", text: "Look into the flaky test." }); await service.settled();
    const direct = store.rooms().find((room) => room.direct)!;
    expect(direct.members).toEqual(["sam"]);
    expect(toSam.room).toBe(direct.id);
    expect(store.messages(direct.id).map((message) => [message.speaker, message.speakerName, message.text])).toEqual([["galahad", "Galahad", "Look into the flaky test."], ["sam", "Sam", "Sam heard Galahad."]]);
    // The same conversation you have with Sam: your own message lands beside his.
    expect(service.direct("sam").id).toBe(direct.id);
    const toRoom = service.say({ room: "workshop", text: "Compare notes." }); await service.settled();
    expect(toRoom).toMatchObject({ room: "workshop", speaker: "galahad" });
    expect(store.messages("workshop").filter((message) => message.chainId === toRoom.chainId).length).toBe(3);
    expect(() => service.say({ teammate: "nobody", text: "Anyone?" })).toThrow(/No such knight/);
    expect(() => service.say({ text: "Nobody." } as never)).toThrow(TeamError);
    expect(() => service.say({ teammate: "sam", room: "workshop", text: "Both." })).toThrow(TeamError);
  });
  test("he makes a knight himself: new, his by record, told to whoever keeps the ledger; a stopped controller makes none", async () => {
    const recruited: string[] = [];
    const { store, service } = setup({ onRecruit: (made) => { recruited.push(`${made.id} by ${made.createdBy}`); } });
    expect(service.recruit({ id: "scout", name: "Scout", instructions: "Watch the dependency updates." })).toMatchObject({ id: "scout", createdBy: "galahad", instructionsBy: "galahad" });
    expect(recruited).toEqual(["scout by galahad"]);
    expect(() => service.recruit({ id: "ada", name: "Impostor", instructions: "Replace her." })).toThrow(/already exists/);
    expect(service.overview().workers.map((worker) => [worker.id, worker.madeBy])).toEqual([["ada", "owner"], ["lin", "owner"], ["sam", "owner"], ["scout", "galahad"]]);
    await service.stop();
    expect(() => service.recruit({ id: "late", name: "Late", instructions: "Too late." })).toThrow(/stopped/);
    expect(() => service.say({ teammate: "scout", text: "Too late." })).toThrow(/stopped/);
    expect(store.teammate("late")).toBeNull();
    expect(recruited).toEqual(["scout by galahad"]);
  });
});

describe("task orchestration", () => {
  test("the first active task may bind its VM once, but can never replace an existing workspace", async () => {
    const { store, service } = setup({ executeTask: async (teammate) => {
      service.planWorkspace(teammate.id, "host");
      service.setWorkspace(teammate.id, { node: "host", id: "0123456789" });
      expect(() => service.setWorkspace(teammate.id, { node: "host", id: "9999999999" })).toThrow(/Stop/);
      return { verified: true, output: "Prepared" };
    } });
    service.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    service.start(); await service.settled();
    expect(store.teammate("ada")?.workspace).toEqual({ node: "host", id: "0123456789" });
    expect(() => store.setWorkspace("ada", { node: "host", id: "9999999999" })).toThrow(/already has/);
  });
  test("activeWork projects current identities without fetching a snapshot", async () => {
    const finish = deferred<{ verified: boolean; output: string }>();
    const { store, service } = setup({ executeTask: async () => finish.promise });
    service.createTask({ room: "workshop", assignee: "ada", title: "Work", goal: "Work" });
    service.start(); await until(() => store.tasks()[0]?.status === "running");
    const snapshot = store.snapshot;
    store.snapshot = () => { throw new Error("Telemetry must not query the database"); };
    try {
      const work = service.activeWork();
      expect(work).toEqual([{ teammate: "ada", room: "workshop", kind: "task" }]);
      (work[0] as { teammate: string }).teammate = "not-the-worker";
      expect(service.activeWork()[0]?.teammate).toBe("ada");
    } finally { store.snapshot = snapshot; finish.resolve({ verified: true, output: "Verified" }); }
    await service.settled();
    expect(service.activeWork()).toEqual([]);
  });
  test("each knight is serial across chat rooms and tasks while other knights run in parallel", async () => {
    const chat = deferred<string>(); const task = deferred<{ verified: boolean; output: string }>();
    const starts: string[] = [];
    const { store, service } = setup({ respond: async (teammate) => { starts.push(`chat:${teammate.id}`); return teammate.id === "ada" ? chat.promise : ""; }, executeTask: async (teammate) => { starts.push(`task:${teammate.id}`); return task.promise; } });
    service.post({ room: "workshop", text: "@ada @lin: discuss." });
    service.createTask({ room: "workshop", assignee: "ada", title: "Implement", goal: "Implement" });
    service.start(); await until(() => starts.length === 2);
    expect(starts.sort()).toEqual(["chat:ada", "chat:lin"]);
    const dm = service.direct("ada"); service.post({ room: dm.id, text: "More" });
    expect(starts).not.toContain("task:ada");
    chat.resolve(""); await until(() => starts.includes("task:ada"));
    expect(starts.filter((s) => s === "chat:ada")).toHaveLength(1);
    task.resolve({ verified: true, output: "Checked" }); await service.settled();
    expect(starts.filter((s) => s === "chat:ada")).toHaveLength(2);
    expect(store.tasks()[0]?.status).toBe("done");
  });
  test("independent tasks run together; a dependent starts only after both verified results", async () => {
    const first = deferred<{ verified: boolean; output: string }>(); const second = deferred<{ verified: boolean; output: string }>();
    const started: string[] = [];
    const { store, service } = setup({ executeTask: async (_teammate, task) => { started.push(task.title); return task.title === "First" ? first.promise : task.title === "Second" ? second.promise : { verified: true, output: "Joined" }; } });
    service.saveRoom({ id: "workshop", name: "Workshop", members: ["ada", "lin", "sam"] });
    const a = service.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    const b = service.createTask({ room: "workshop", assignee: "lin", title: "Second", goal: "Second" });
    const c = service.createTask({ room: "workshop", assignee: "sam", title: "Join", goal: "Join", dependsOn: [a.id, b.id] });
    service.start(); await until(() => started.length === 2);
    first.resolve({ verified: true, output: "One" }); await until(() => store.task(a.id)?.status === "done");
    expect(started).not.toContain("Join");
    second.resolve({ verified: true, output: "Two" }); await service.settled();
    expect(started).toEqual(["First", "Second", "Join"]);
    expect(store.task(c.id)).toMatchObject({ status: "done", verified: true });
  });
  test("delegated tasks inherit identity, room and conversation, and spend none of its budget while they wait for you", async () => {
    const { store, service } = setup({ respond: async (_teammate, _room, _history, context) => { context.delegate({ assignee: "lin", title: "Check", goal: "Check", gates: ["bun test"] }); return ""; } }, 1);
    const owner = service.post({ room: "workshop", text: "@ada @lin: delegate." });
    service.start(); await service.settled();
    expect(store.tasks()).toHaveLength(1);
    expect(store.tasks()[0]).toMatchObject({ room: "workshop", assignee: "lin", chainId: owner.chainId, status: "proposed", gates: ["bun test"] });
  });
  test("a task a knight writes from a conversation waits for your approval: it runs once you approve it, and declining stops it", async () => {
    const ran: string[] = [];
    const { store, service } = setup({
      respond: async (teammate, _room, _history, context) => {
        if (teammate.id === "ada") { context.delegate({ assignee: "ada", title: "Draft the notes", goal: "Draft the release notes.", gates: ["test -f notes.md"] }); context.delegate({ assignee: "lin", title: "Check migrations", goal: "Run every migration." }); }
        return "";
      },
      executeTask: async (_teammate, task) => { ran.push(task.title); return { verified: true, output: "Verified" }; },
    });
    const asked = service.post({ room: "workshop", text: "@ada @lin: get the release ready." });
    service.start(); await service.settled();
    const [lin, ada] = store.tasks("workshop");
    expect([ada, lin].map((task) => [task!.title, task!.status, task!.proposedBy, task!.chainId])).toEqual([["Draft the notes", "proposed", "ada", asked.chainId], ["Check migrations", "proposed", "ada", asked.chainId]]);
    // A proposal is work in sight, never work in hand: nothing ran.
    expect(ran).toEqual([]);
    expect(store.queued()).toHaveLength(0);
    service.control({ task: ada!.id, action: "approve" });
    service.control({ task: lin!.id, action: "stop" });
    await service.settled();
    expect(ran).toEqual(["Draft the notes"]);
    expect(store.task(ada!.id)).toMatchObject({ status: "done", verified: true, proposedBy: "ada" });
    // Approved, it is yours: it runs in a chain of its own, not on what was left of the conversation's.
    expect(store.task(ada!.id)!.chainId).not.toBe(asked.chainId);
    expect(store.task(lin!.id)).toMatchObject({ status: "stopped", error: "Declined by you." });
    // Only a proposal is approved, and only once.
    expect(() => service.control({ task: ada!.id, action: "approve" })).toThrow("isn't waiting for your approval");
  });
  // Your word, 23 November 2026: he approves his own decisions and his knights'; what is monetary asks you.
  test("a knight's proposal that names a budget within his cap, and within what is left of yours, is Galahad's to approve: it runs, its trail says whose yes it was", async () => {
    const ran: string[] = [];
    const left = { usd: null as number | null };
    const { store, service } = setup({
      respond: async (teammate, _room, _history, context) => {
        if (teammate.id !== "ada") return "";
        context.delegate({ assignee: "lin", title: "Check migrations", goal: "Run every migration.", budgetUsd: 2 });
        context.delegate({ assignee: "ada", title: "Big", goal: "A bigger piece of work.", budgetUsd: TEAM_LIMITS.ownTaskUsd + 1 });
        context.delegate({ assignee: "ada", title: "Uncapped", goal: "Work that names no budget." });
        return "";
      },
      executeTask: async (_teammate, task) => { ran.push(task.title); return { verified: true, output: "Verified" }; },
      budgetLeft: () => left.usd,
    });
    const asked = service.post({ room: "workshop", text: "@ada: get the release ready." });
    service.start(); await service.settled();
    const [check, big, uncapped] = ["Check migrations", "Big", "Uncapped"].map((title) => store.tasks("workshop").find((t) => t.title === title)!);
    expect(ran).toEqual(["Check migrations"]);
    expect(store.task(check!.id)).toMatchObject({ status: "done", verified: true, proposedBy: "ada" });
    expect(store.trail(check!.id).entries.map((e) => e.text)).toContain("Approved by Galahad himself: proposed by @ada in Workshop, within its budget of $2");
    // Money past his cap, or uncapped, is yours: those wait for you.
    expect([big!.status, uncapped!.status]).toEqual(["proposed", "proposed"]);
    // Past what is left of your budget it waits too; within it, he says how much was left.
    left.usd = 1;
    expect(service.approveOwn(store.createTask({ room: "workshop", assignee: "lin", title: "Small", goal: "A small piece.", budgetUsd: 2 }, { teammate: "ada", chainId: asked.chainId }).id, "proposed by @ada in Workshop")).toBeNull();
    left.usd = 4;
    const small = store.createTask({ room: "workshop", assignee: "lin", title: "Smaller", goal: "A smaller piece.", budgetUsd: 2 }, { teammate: "ada", chainId: asked.chainId });
    expect(service.approveOwn(small.id, "proposed by @ada in Workshop")?.status).toBe("queued");
    expect(store.trail(small.id).entries.map((e) => e.text)).toContain("Approved by Galahad himself: proposed by @ada in Workshop, within its budget of $2, and of the $4.00 left of yours");
  });
  test("tasks you give run at once: only a knight's waits for you", async () => {
    const { store, service } = setup();
    const given = service.createTask({ room: "workshop", assignee: "ada", title: "Yours", goal: "Yours" });
    expect(given.status).toBe("queued");
    expect(given.proposedBy).toBeUndefined();
    service.start(); await service.settled();
    expect(store.task(given.id)?.status).toBe("done");
  });
  test("an unverified result fails and never releases its dependents", async () => {
    const calls: string[] = [];
    const { store, service } = setup({ executeTask: async (_teammate, task) => { calls.push(task.id); return { verified: false, output: "I think it works" }; } });
    const a = service.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    const b = service.createTask({ room: "workshop", assignee: "lin", title: "Next", goal: "Next", dependsOn: [a.id] });
    service.start(); await service.settled();
    expect(calls).toEqual([a.id]); expect(store.task(a.id)?.status).toBe("failed"); expect(store.task(b.id)?.status).toBe("queued");
  });
});

describe("work a planned restart cuts off", () => {
  const MINUTE = 60_000;
  /** A store on a clock of the test's own, with Ada in the workshop, and a runner that ends only when it is cut off. */
  function restartable() {
    const clock = { now: 1_000_000 };
    const store = new TeamStore(":memory:", () => clock.now);
    store.saveTeammate({ id: "ada", name: "Ada" });
    store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"], turnBudget: 8 });
    const runs: string[] = [];
    const node = () => {
      const service = new TeamService({ store, respond: async () => "", restartWaitMs: 16 * MINUTE, shutdownGraceMs: 1, tickMs: 2, executeTask: async (_teammate, task, context) => {
        runs.push(task.id);
        return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ verified: false, output: "Cut off." }), { once: true }));
      } });
      fixtures.push({ store, service });
      return service;
    };
    return { clock, store, runs, node };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("waits out its VM command's deadline, holding the knight's other work, then is taken up again by itself, once", async () => {
    const { clock, store, runs, node } = restartable();
    const before = node();
    const task = before.createTask({ room: "workshop", assignee: "ada", title: "Long job", goal: "Long job" });
    const next = before.createTask({ room: "workshop", assignee: "ada", title: "Next", goal: "Next" });
    before.start(); await until(() => store.task(task.id)?.status === "running");
    await before.stop();
    expect(store.task(task.id)?.status).toBe("interrupted");
    expect(store.task(task.id)?.error).toMatch(/picks up again by itself .*at most 16 minutes after the restart/);
    expect(store.room("workshop")?.paused).toBe(false);

    // Back up a minute later: its last command may still be running in Ada's VM, so nothing of hers starts.
    clock.now += MINUTE;
    const after = node(); after.start(); await tick();
    expect([store.task(task.id)?.status, store.task(next.id)?.status, runs.length]).toEqual(["interrupted", "queued", 1]);

    // Its deadline passed: taken up again, ahead of what was given after it, with a line saying why.
    clock.now += 16 * MINUTE;
    await until(() => runs.length === 2);
    expect(runs).toEqual([task.id, task.id]);
    expect(store.trail(task.id).entries.map((entry) => entry.text)).toContain("Taken up again by itself after Galahad restarted.");

    // Cut off a second time: it waits for you now, its room held, however long the node is up.
    await after.stop();
    expect(store.task(task.id)?.error).toMatch(/again\. It was taken up once by itself already, so it waits for you/);
    expect(store.room("workshop")?.paused).toBe(true);
    clock.now += 60 * MINUTE;
    node().start(); await tick();
    expect([store.task(task.id)?.status, runs.length]).toEqual(["interrupted", 2]);
  });

  test("waits for you instead, once you pause or stop it, its knight or its room before it is taken up", async () => {
    for (const select of [{ teammate: "ada" }, { room: "workshop" }] as const) {
      for (const action of ["pause", "stop"] as const) {
        const { clock, store, runs, node } = restartable();
        const before = node();
        const task = before.createTask({ room: "workshop", assignee: "ada", title: "Long job", goal: "Long job" });
        before.start(); await until(() => store.task(task.id)?.status === "running");
        await before.stop();
        const after = node(); after.start();
        after.control({ ...select, action });
        clock.now += 20 * MINUTE; await tick();
        expect([action, store.task(task.id)?.status, store.task(task.id)?.error, runs.length]).toEqual([action, action === "pause" ? "interrupted" : "stopped", action === "pause" ? "Paused by you." : "Stopped by you.", 1]);
      }
    }
  });

  test("a reply cut off after it had done something waits for you; one that had only thought is taken up again by itself", async () => {
    for (const acted of [true, false]) {
      const clock = { now: 1_000_000 };
      const store = new TeamStore(":memory:", () => clock.now);
      store.saveTeammate({ id: "ada", name: "Ada" });
      store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"], turnBudget: 8 });
      let replies = 0;
      const node = () => {
        const service = new TeamService({ store, restartWaitMs: 16 * MINUTE, shutdownGraceMs: 1, tickMs: 2, executeTask: async () => ({ verified: false, output: "" }), respond: async (_teammate, _room, _history, context) => {
          replies += 1;
          // (A message sent is something done; so are its notes, a task proposed, a knight made, a command run.)
          if (acted) context.send({ room: "workshop" }, "On it.");
          return new Promise<string>((resolve) => context.signal.addEventListener("abort", () => resolve(""), { once: true }));
        } });
        fixtures.push({ store, service });
        return service;
      };
      const before = node();
      before.post({ room: "workshop", text: "@ada, look into it." });
      before.start(); await until(() => store.deliveries("workshop").some((d) => d.status === "running"));
      await before.stop();
      const reply = () => store.deliveries("workshop")[0]!;
      expect([acted, reply().status, store.room("workshop")?.paused]).toEqual([acted, "interrupted", acted]);
      expect(reply().error).toMatch(acted ? /after it had already done something .* so it waits for you/ : /picks up again by itself/);

      const after = node(); after.start();
      clock.now += 20 * MINUTE;
      if (acted) {
        await tick();
        expect([reply().status, replies]).toEqual(["interrupted", 1]);
      } else {
        await until(() => replies === 2);
      }
      await after.stop();
    }
  });

  test("a crash leaves no such mark: what it cut off waits for you, its room held", async () => {
    const { clock, store, runs, node } = restartable();
    const before = node();
    const task = before.createTask({ room: "workshop", assignee: "ada", title: "Long job", goal: "Long job" });
    before.start(); await until(() => store.task(task.id)?.status === "running");
    // (No stop(): the process died. The next start finds the job still marked running.)
    clock.now += 60 * MINUTE;
    const after = new TeamService({ store, respond: async () => "", executeTask: async () => ({ verified: true, output: "Never" }), tickMs: 2 });
    fixtures.push({ store, service: after });
    after.start(); await tick();
    expect([store.task(task.id)?.status, store.task(task.id)?.error, store.room("workshop")?.paused, runs.length]).toEqual(["interrupted", "The node stopped during this work. Review it before resuming.", true, 1]);
  });
});

describe("stopping, interruption and resource bounds", () => {
  test("a runner settling after bounded shutdown never touches the closed database or observers", async () => {
    const finish = deferred<{ verified: boolean; output: string }>(); let changes = 0;
    let rejectedAfterClose: boolean[] = [];
    const { store, service } = setup({ timeoutMs: 20, shutdownGraceMs: 1, onChange: () => { changes++; }, executeTask: async (_teammate, _task, context) => {
      const outcome = await finish.promise;
      rejectedAfterClose = [
        () => context.emit("Late progress"),
        () => context.remember("Late memory"),
        () => context.send({ teammate: "lin" }, "Late message"),
        () => context.delegate({ assignee: "lin", title: "Late task", goal: "Late task" }),
      ].map((write) => { try { write(); return false; } catch (error) { return (error as Error).message === "This knight's work has stopped."; } });
      return outcome;
    } });
    const task = service.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    service.start(); await until(() => store.task(task.id)?.status === "running");
    await service.stop();
    expect(store.task(task.id)?.status).toBe("interrupted");
    store.close(); fixtures.splice(fixtures.findIndex((f) => f.service === service), 1);
    const atClose = changes;
    expect(() => service.planWorkspace("ada", "host")).toThrow("This team controller has stopped.");
    expect(() => service.setWorkspace("ada", { node: "host", id: "0123456789" })).toThrow("This team controller has stopped.");
    expect(() => service.post({ room: "workshop", text: "Late owner request" })).toThrow("This team controller has stopped.");
    finish.resolve({ verified: true, output: "Too late" });
    await service.settled(); await new Promise((resolve) => setTimeout(resolve, 25));
    expect(changes).toBe(atClose);
    expect(rejectedAfterClose).toEqual([true, true, true, true]);
    await service.stop();
  });
  test("pause cancels an active knight, keeps queued work, and requires explicit resume", async () => {
    let calls = 0;
    const { store, service } = setup({ respond: async (teammate, _room, _history, context) => { if (teammate.id !== "ada") return ""; calls++; if (calls > 1) return ""; return new Promise<string>((resolve) => context.signal.addEventListener("abort", () => resolve("late words"), { once: true })); } });
    service.post({ room: "workshop", text: "@ada @lin: work." }); service.start(); await until(() => calls === 1);
    service.control({ teammate: "ada", action: "pause" }); await service.settled();
    expect(store.teammate("ada")?.enabled).toBe(false);
    expect(store.room("workshop")?.paused).toBe(false);
    expect(store.messages("workshop").some((m) => m.text === "late words")).toBe(false);
    service.control({ teammate: "ada", action: "resume" }); await service.settled(); expect(calls).toBe(2);
  });
  test("room stop cancels work and old manually stopped jobs do not replay when a room resumes", async () => {
    const { store, service } = setup();
    service.post({ room: "workshop", text: "@ada @lin: work." }); service.control({ room: "workshop", action: "stop" });
    service.start(); await service.settled();
    expect(store.deliveries().every((d) => d.status === "stopped")).toBe(true);
    service.control({ room: "workshop", action: "resume" }); await service.settled();
    expect(store.deliveries().every((d) => d.status === "stopped")).toBe(true);
    expect(store.teammates().every((t) => t.turnsToday === 0)).toBe(true);
  });
  test("a callback ignoring timeout keeps its VM lock until it ends and cannot publish late results", async () => {
    const finish = deferred<{ verified: boolean; output: string }>(); let calls = 0;
    const { store, service } = setup({ timeoutMs: 10, executeTask: async () => { calls++; return finish.promise; } });
    const a = service.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    const b = service.createTask({ room: "workshop", assignee: "ada", title: "Next", goal: "Next" });
    service.start(); await until(() => store.task(a.id)?.status === "interrupted");
    expect(calls).toBe(1); expect(store.task(b.id)?.status).toBe("queued");
    expect(() => service.control({ task: a.id, action: "resume" })).toThrow(/still stopping/);
    finish.resolve({ verified: true, output: "Too late" }); await service.settled();
    expect(store.task(a.id)).toMatchObject({ status: "interrupted", verified: false, output: "" });
  });
  test("a task may be given a longer limit than a reply: work in a repository takes longer than an answer", async () => {
    const { store, service } = setup({ timeoutMs: 10, taskTimeoutMs: 5_000, executeTask: async () => { await Bun.sleep(60); return { verified: true, output: "Checked" }; } });
    const task = service.createTask({ room: "workshop", assignee: "ada", title: "Long", goal: "Long" });
    service.start(); await until(() => !["queued", "running"].includes(store.task(task.id)?.status ?? ""));
    // (At the reply's limit of 10 ms it would have been interrupted, and its room held.)
    expect(store.task(task.id)).toMatchObject({ status: "done", verified: true });
  });
  test("a task with no limit of time is never stopped by the clock: a knight's, which its audit watches instead", async () => {
    const { store, service } = setup({ timeoutMs: 10, taskTimeoutMs: null, executeTask: async () => { await Bun.sleep(60); return { verified: true, output: "Checked" }; } });
    const task = service.createTask({ room: "workshop", assignee: "ada", title: "Long", goal: "Long" });
    service.start(); await until(() => !["queued", "running"].includes(store.task(task.id)?.status ?? ""));
    expect(store.task(task.id)).toMatchObject({ status: "done", verified: true });
    expect(store.room("workshop")?.paused).toBe(false);
  });
  test("restart resumes untouched queues but does not replay interrupted side effects", async () => {
    let calls = 0;
    const { store, service } = setup({ executeTask: async () => { calls++; return { verified: true, output: "Checked" }; } });
    const active = store.createTask({ room: "workshop", assignee: "ada", title: "Interrupted", goal: "Interrupted" });
    const queued = store.createTask({ room: "workshop", assignee: "lin", title: "Queued", goal: "Queued" });
    store.claim(active.id);
    service.start(); await service.settled();
    expect(calls).toBe(0); expect(store.task(active.id)?.status).toBe("interrupted"); expect(store.task(queued.id)?.status).toBe("queued");
    service.control({ room: "workshop", action: "resume" }); await service.settled();
    expect(calls).toBe(2); expect(store.task(active.id)?.status).toBe("done");
  });
});

describe("removing a knight", () => {
  test("its work is stopped first, then it is gone; the room goes on without it", async () => {
    let calls = 0;
    const heard: string[] = [];
    const { store, service } = setup({ respond: async (teammate, _room, _history, context) => {
      if (teammate.id !== "ada") { heard.push(teammate.id); return ""; }
      calls++;
      return new Promise<string>((resolve) => context.signal.addEventListener("abort", () => resolve("late words"), { once: true }));
    } });
    service.post({ room: "workshop", text: "@ada @lin: work." }); service.start(); await until(() => calls === 1);
    const next = service.createTask({ room: "workshop", assignee: "ada", title: "Next", goal: "Next" });
    const removed = await service.remove("ada");
    expect(removed).toMatchObject({ id: "ada", enabled: false });
    expect(removed.removedAt).toBeGreaterThan(0);
    expect(store.teammate("ada")).toBeNull();
    expect(service.activeWork().some((work) => work.teammate === "ada")).toBe(false);
    // What it was saying never lands; what it was doing and what waited for it both say why they stopped.
    expect(store.messages("workshop").some((m) => m.text === "late words")).toBe(false);
    expect(store.deliveries().find((d) => d.teammate === "ada")).toMatchObject({ status: "stopped", error: "Stopped to remove its knight." });
    expect(store.task(next.id)).toMatchObject({ status: "stopped", error: "Its knight was removed." });
    service.post({ room: "workshop", text: "@lin, carry on." }); await service.settled();
    expect(heard.filter((id) => id === "lin")).toHaveLength(2);
    expect(store.deliveries().filter((d) => d.teammate === "ada")).toHaveLength(1);
    expect(() => service.control({ teammate: "ada", action: "resume" })).toThrow(/was removed/);
    await expect(service.remove("ada")).rejects.toThrow(/was removed/);
  });

  test("work that will not stop keeps the worker: paused, and still here to remove once it has ended", async () => {
    const finish = deferred<{ verified: boolean; output: string }>(); let calls = 0;
    const { store, service } = setup({ executeTask: async () => { calls++; return finish.promise; } });
    const first = service.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    const waiting = service.createTask({ room: "workshop", assignee: "ada", title: "Waiting", goal: "Waiting" });
    service.start(); await until(() => calls === 1);
    await expect(service.remove("ada", { waitMs: 20 })).rejects.toThrow(/still stopping/);
    expect(store.teammate("ada")).toMatchObject({ enabled: false });
    expect(store.room("workshop")!.members).toEqual(["ada", "lin"]);
    expect(store.task(first.id)).toMatchObject({ status: "stopped", error: "Stopped to remove its knight." });
    // What had not started is untouched: resuming the worker would run it.
    expect(store.task(waiting.id)!.status).toBe("queued");
    finish.resolve({ verified: true, output: "Too late" }); await service.settled();
    expect(store.task(first.id)).toMatchObject({ status: "stopped", verified: false, output: "" });
    expect((await service.remove("ada")).removedAt).toBeGreaterThan(0);
    expect(store.task(waiting.id)).toMatchObject({ status: "stopped", error: "Its knight was removed." });
  });

  test("a workspace goes only when the caller releases it; a release that fails leaves the knight here and bound", async () => {
    const { store, service } = setup();
    service.start();
    service.setWorkspace("ada", { node: "host", id: "0123456789" });
    // Nobody said the workspace may go: refused before anything is touched.
    await expect(service.remove("ada")).rejects.toThrow(/workspace/);
    expect(store.teammate("ada")).toMatchObject({ enabled: true, workspace: { node: "host", id: "0123456789" } });
    await expect(service.remove("ada", { release: async () => { throw new TeamError(424, "its VM host is offline"); } })).rejects.toThrow(/offline/);
    expect(store.teammate("ada")).toMatchObject({ enabled: false, workspace: { node: "host", id: "0123456789" } });
    const released: string[] = [];
    const removed = await service.remove("ada", { release: async (member) => { released.push(`${member.workspace!.node}/${member.workspace!.id}`); } });
    expect(released).toEqual(["host/0123456789"]);
    expect(removed).toMatchObject({ id: "ada", workspace: null });
    expect(removed.removedAt).toBeGreaterThan(0);
    expect(store.teammate("ada")).toBeNull();
  });

  test("while it is being removed nothing brings it back, changes it or gives it a workspace", async () => {
    const gate = deferred();
    const { store, service } = setup();
    service.start();
    service.setWorkspace("ada", { node: "host", id: "0123456789" });
    const removing = service.remove("ada", { release: () => gate.promise });
    await Promise.resolve();
    expect(() => service.control({ teammate: "ada", action: "resume" })).toThrow(/being removed/);
    expect(() => service.saveTeammate({ id: "ada", name: "Ada", enabled: true })).toThrow(/being removed/);
    expect(() => service.planWorkspace("ada", "host")).toThrow(/being removed/);
    expect(() => service.setWorkspace("ada", null)).toThrow(/being removed/);
    await expect(service.remove("ada", { release: async () => {} })).rejects.toThrow(/being removed/);
    expect(store.teammate("ada")).toMatchObject({ enabled: false, workspace: { node: "host", id: "0123456789" } });
    gate.resolve();
    expect((await removing).removedAt).toBeGreaterThan(0);
    expect(store.teammate("ada")).toBeNull();
    // Nobody else was held up by it.
    expect(service.saveTeammate({ id: "lin", name: "Lin" }).id).toBe("lin");
  });

  test("the caller's release runs for a knight with no binding too, and a release already made is not left half done by a controller that begins to stop", async () => {
    // A VM made just before a crash may never have been bound: only the caller can know, so it is always asked.
    const { store, service } = setup();
    service.start();
    const asked: (string | null)[] = [];
    await service.remove("sam", { release: async (member) => { asked.push(member.workspace?.id ?? null); } });
    expect(asked).toEqual([null]);
    expect(store.teammate("sam")).toBeNull();
    // The VM is destroyed, and the controller begins to stop before the record is retired: it is retired all the same.
    service.setWorkspace("ada", { node: "host", id: "0123456789" });
    let stopping: Promise<void> | undefined;
    const removed = await service.remove("ada", { release: async () => { stopping = service.stop(); } });
    expect(removed).toMatchObject({ id: "ada", workspace: null });
    expect(removed.removedAt).toBeGreaterThan(0);
    expect(store.teammate("ada")).toBeNull();
    await stopping;
  });

  test("its observers hear of it, and a stopped controller removes no one", async () => {
    let changes = 0;
    const { store, service } = setup({ onChange: () => { changes++; } });
    service.start();
    const before = changes;
    await service.remove("sam");
    expect(changes).toBeGreaterThan(before);
    await service.stop();
    await expect(service.remove("ada")).rejects.toThrow(/stopped/);
    expect(store.teammate("ada")).not.toBeNull();
  });
});
