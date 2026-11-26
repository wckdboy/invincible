import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { avatarExpression, defaultAvatar } from "@galahad/core/avatar";
import { TEAM_LIMITS } from "@galahad/core/team-limits";
import { SENSITIVE_WORK } from "@galahad/core";
import { TeamStore, TeamError } from "../src/team-store.ts";

const stores: TeamStore[] = [];
const dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const make = (path = ":memory:", now?: () => number) => { const store = new TeamStore(path, now); stores.push(store); return store; };
const close = (store: TeamStore) => { store.close(); stores.splice(stores.indexOf(store), 1); };
const setup = (store: TeamStore) => {
  store.saveTeammate({ id: "ada", name: "Ada" }); store.saveTeammate({ id: "lin", name: "Lin" });
  store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada", "lin"] });
};

describe("what is new to you", () => {
  test("when you last looked at each knight's page and each room is kept, and only grows", () => {
    let clock = 1_000;
    const store = make(":memory:", () => clock);
    setup(store);
    // A store made before anyone sat at the table has seen nothing: what ends there is new.
    expect(store.snapshot().seen).toEqual({});
    clock = 2_000;
    store.see("knight:ada");
    store.see("room:workshop");
    expect(store.snapshot().seen).toEqual({ "knight:ada": 2_000, "room:workshop": 2_000 });
    // A clock that went back never makes what you read new again.
    clock = 1_500;
    store.see("knight:ada");
    expect(store.snapshot().seen!["knight:ada"]).toBe(2_000);
  });

  test("a store from before it counts everything until then as seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-seen-")); dirs.push(dir); const path = join(dir, "team.db");
    let clock = 1_000;
    const store = make(path, () => clock);
    setup(store);
    close(store);
    const raw = new Database(path);
    raw.exec("DROP TABLE team_seen");
    raw.close();
    clock = 5_000;
    const reopened = make(path, () => clock);
    const seen = reopened.snapshot().seen!;
    expect(seen).toMatchObject({ "knight:ada": 5_000, "knight:lin": 5_000, "room:workshop": 5_000 });
  });
});

describe("private team persistence", () => {
  test("a knight's own models are kept through edits that leave them out and a reopen; none, or null, gives it its role's again", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-models-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path);
    expect(store.saveTeammate({ id: "ada", name: "Ada" }).models).toBeUndefined();
    expect(store.saveTeammate({ id: "ada", name: "Ada", models: ["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"] }).models).toEqual(["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"]);
    store.saveTeammate({ id: "ada", name: "Augusta", role: "planner" }); close(store);
    const reopened = make(path);
    expect(reopened.teammate("ada")).toMatchObject({ name: "Augusta", role: "planner", models: ["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"] });
    expect(reopened.saveTeammate({ id: "ada", name: "Augusta", models: [] }).models).toBeUndefined();
    reopened.saveTeammate({ id: "ada", name: "Augusta", models: ["ollama/qwen3.8:27b"] });
    expect(reopened.saveTeammate({ id: "ada", name: "Augusta", models: null }).models).toBeUndefined();
    // Never a wildcard, never more than eight, always provider/model.
    for (const models of [["ollama/*"], ["mimo"], Array.from({ length: 9 }, (_, i) => `p/m${i}`)]) expect(() => reopened.saveTeammate({ id: "ada", name: "Augusta", models })).toThrow();
  });

  test("custom appearances survive omitted edits and reopen; explicit null resets the seeded default", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-avatar-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path);
    const avatar = { ...defaultAvatar("ada"), form: "round" as const, color: "#ffccdd", accessory: "plume" as const };
    expect(store.saveTeammate({ id: "ada", name: "Ada" }).avatar).toEqual(defaultAvatar("ada"));
    expect(store.saveTeammate({ id: "ada", name: "Ada", avatar }).avatar).toEqual(avatar);
    store.saveTeammate({ id: "ada", name: "Augusta" }); store.remember("ada", "Keep these notes.");
    store.setWorkspace("ada", { node: "host", id: "0123456789" }); close(store);
    const reopened = make(path);
    expect(reopened.teammate("ada")).toMatchObject({ name: "Augusta", avatar, memory: "Keep these notes.", workspace: { node: "host", id: "0123456789" } });
    expect(() => reopened.saveTeammate({ id: "ada", name: "Augusta", avatar: { ...avatar, color: "url(https://example.invalid/p)" } })).toThrow(TeamError);
    expect(reopened.teammate("ada")?.avatar).toEqual(avatar);
    expect(reopened.saveTeammate({ id: "ada", name: "Augusta", avatar: null }).avatar).toEqual(defaultAvatar("ada"));
  });
  test("a colour chosen for a knight's orb is kept as it was chosen, through edits that leave it out and a reopen; a bad one is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-avatar-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path);
    expect(store.saveTeammate({ id: "ada", name: "Ada", avatar: { v: 2, color: "#3ABEFF" } }).avatar).toEqual({ v: 2, color: "#3abeff" });
    store.saveTeammate({ id: "ada", name: "Augusta" }); close(store);
    const reopened = make(path);
    expect(reopened.teammate("ada")?.avatar).toEqual({ v: 2, color: "#3abeff" });
    for (const avatar of [{ v: 2, color: "blue" }, { v: 2, color: "#3abeff", form: "round" }, { v: 3, color: "#3abeff" }]) {
      expect(() => reopened.saveTeammate({ id: "ada", name: "Augusta", avatar: avatar as never })).toThrow(TeamError);
    }
    expect(reopened.teammate("ada")?.avatar).toEqual({ v: 2, color: "#3abeff" });
    expect(reopened.saveTeammate({ id: "ada", name: "Augusta", avatar: null }).avatar).toEqual(defaultAvatar("ada"));
  });
  test("legacy records get deterministic appearances without rewriting their saved JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-avatar-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path);
    const { avatar: _unused, ...legacy } = store.saveTeammate({ id: "ada", name: "Ada", instructions: "Preserve this instruction." }); close(store);
    const raw = JSON.stringify(legacy);
    const db = new Database(path);
    db.query("UPDATE team_teammates SET value=? WHERE id='ada'").run(raw);
    const reopened = make(path);
    expect(reopened.teammate("ada")).toMatchObject({ avatar: defaultAvatar("ada"), instructions: "Preserve this instruction." });
    expect(db.query<{ value: string }, []>("SELECT value FROM team_teammates WHERE id='ada'").get()?.value).toBe(raw);
    db.close();
  });
  test("knights, memory, workspace, messages and queued work survive reopen; files stay private", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-")); dirs.push(dir);
    const path = join(dir, "team.db");
    const store = make(path); setup(store);
    store.remember("ada", "The fixture uses Bun.");
    store.setWorkspace("ada", { node: "host", id: "0123456789" });
    store.post({ room: "workshop", text: "@ada @lin: discuss the fixture." });
    close(store);
    const reopened = make(path);
    expect(reopened.teammate("ada")).toMatchObject({ memory: "The fixture uses Bun.", workspace: { node: "host", id: "0123456789" } });
    expect(reopened.messages("workshop")).toHaveLength(1);
    expect(reopened.queued()).toHaveLength(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test("opening team tables does not rewrite unrelated existing tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-")); dirs.push(dir);
    const path = join(dir, "team.db");
    const before = new Database(path); before.exec("CREATE TABLE previous_data(value TEXT); INSERT INTO previous_data VALUES('kept');"); before.close();
    make(path);
    const after = new Database(path); expect(after.query("SELECT value FROM previous_data").get()).toEqual({ value: "kept" }); after.close();
  });
  test("restart marks in-flight side effects interrupted, holds that room, and keeps queued work", () => {
    const store = make(); setup(store); store.post({ room: "workshop", text: "@ada @lin: work" });
    const first = store.queued()[0]!;
    expect(store.claim(first.id)).toBe(true);
    store.recover();
    expect(store.job(first.id)?.status).toBe("interrupted");
    expect(store.room("workshop")?.paused).toBe(true);
    expect(store.queued()).toHaveLength(1);
    expect(store.claim(store.queued()[0]!.id)).toBe(false);
  });
  test("renaming does not replace identity, memory or VM and historical names remain snapshots", () => {
    const store = make(); setup(store);
    store.remember("ada", "My notes"); store.setWorkspace("ada", { node: "host", id: "0123456789" });
    const owner = store.post({ room: "workshop", text: "Hello" });
    store.post({ room: "workshop", text: "Hello there" }, { teammate: "ada", chainId: owner.chainId });
    store.saveTeammate({ id: "ada", name: "Augusta" });
    expect(store.teammate("ada")).toMatchObject({ name: "Augusta", memory: "My notes", workspace: { node: "host", id: "0123456789" } });
    expect(store.messages("workshop").at(-1)?.speakerName).toBe("Ada");
    expect(() => store.setWorkspace("lin", { node: "host", id: "0123456789" })).toThrow(/another knight/);
  });
  test("provisioning intent survives reopen and neither its host nor a bound repository silently changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path); setup(store);
    store.saveTeammate({ id: "ada", name: "Ada", repository: "https://github.com/example/fixture.git" });
    store.planWorkspace("ada", "chosen-host"); close(store);
    const reopened = make(path);
    expect(reopened.teammate("ada")).toMatchObject({ workspace: null, workspaceNode: "chosen-host" });
    expect(() => reopened.planWorkspace("ada", "another-host")).toThrow(/another host/);
    expect(() => reopened.setWorkspace("ada", { node: "another-host", id: "0123456789" })).toThrow(/another host/);
    reopened.setWorkspace("ada", { node: "chosen-host", id: "0123456789" });
    expect(() => reopened.saveTeammate({ id: "ada", name: "Ada", repository: "https://github.com/example/different" })).toThrow(/already bound/);
    expect(() => reopened.saveTeammate({ id: "ada", name: "Augusta", repository: "https://github.com/example/fixture.git" })).not.toThrow();
  });
  test("a task keeps what it did as it happened: every progress line in order, with its time, readable from any point and after the task has ended", () => {
    // (Until 14 November 2026 a task held only its last line: one that failed left nothing to read, and nothing could follow one as it worked.)
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-")); dirs.push(dir); const path = join(dir, "team.db");
    let clock = 1_000;
    const store = make(path, () => clock++); setup(store);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Build", goal: "Build it" });
    // Nothing is kept of a task that is not running.
    store.progress(task.id, "too early");
    expect(store.trail(task.id)).toEqual({ entries: [], more: false });
    store.claim(task.id);
    for (const line of ["Plan · 1. Look.", "Running · ls", "Exit 0 · exit 0 · 3 ms\nREADME.md"]) store.progress(task.id, line);
    const all = store.trail(task.id);
    expect(all.entries.map((e) => [e.n, e.text])).toEqual([[1, "Plan · 1. Look."], [2, "Running · ls"], [3, "Exit 0 · exit 0 · 3 ms\nREADME.md"]]);
    expect(all.entries.every((e, i, list) => e.at > 0 && (i === 0 || e.at >= list[i - 1]!.at))).toBe(true);
    // Whoever follows it asks only for what is new.
    expect(store.trail(task.id, 2).entries.map((e) => e.n)).toEqual([3]);
    expect(store.trail(task.id, 3)).toEqual({ entries: [], more: false });
    // The last line is still the task's progress, as it always was.
    expect(store.task(task.id)!.progress).toBe("Exit 0 · exit 0 · 3 ms\nREADME.md");
    store.finish(task.id, "failed", "gave-up", { verified: false, output: "It can't be done here." });
    close(store);
    // After the task has ended, and after the node has restarted, it is all still there.
    const reopened = make(path);
    expect(reopened.trail(task.id).entries.map((e) => e.text)).toEqual(["Plan · 1. Look.", "Running · ls", "Exit 0 · exit 0 · 3 ms\nREADME.md"]);
    expect(reopened.trail("task-nosuchtask00")).toEqual({ entries: [], more: false });
    // What its verified work taught is a line of its own after it ran; a task that isn't there gets none.
    reopened.noteTask(task.id, "Skill learned: “Run the migrations first” (it waits for your approval, and isn't used until then)");
    reopened.noteTask("task-nosuchtask00", "nothing");
    expect(reopened.trail(task.id).entries.at(-1)!.text).toBe("Skill learned: “Run the migrations first” (it waits for your approval, and isn't used until then)");
    expect(reopened.trail("task-nosuchtask00")).toEqual({ entries: [], more: false });
  });
  test("a trail is bounded and holds no secret: long lines are cut, a page is at most two hundred, and the oldest go once a task has more than it may keep", () => {
    const store = make(); setup(store);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Loud", goal: "Print a lot" }); store.claim(task.id);
    store.progress(task.id, `Exit 0 · ${"x".repeat(9_000)}`);
    store.progress(task.id, `Exit 0 · KEY=sk-ant-api03-${"FAKE".repeat(8)}`);
    const [long, leaked] = store.trail(task.id).entries;
    expect(long!.text.length).toBeLessThanOrEqual(2_000);
    expect(leaked!.text).not.toContain("FAKEFAKE");
    for (let i = 0; i < 700; i++) store.progress(task.id, `Running · step ${i}`);
    const first = store.trail(task.id);
    expect(first.entries).toHaveLength(200);
    expect(first.more).toBe(true);
    // 702 lines were written; the six hundred newest are kept, numbered as they were written.
    expect(first.entries[0]!.n).toBe(103);
    let last = first.entries.at(-1)!.n, pages = 1;
    for (let page = store.trail(task.id, last); page.entries.length; page = store.trail(task.id, last)) { last = page.entries.at(-1)!.n; pages++; }
    expect({ last, pages }).toEqual({ last: 702, pages: 3 });
  });
  test("a knight whose VM has no repository may be given one; from then on it is bound like any other", () => {
    // (Seen on ultra, 14 November 2026: the first knight was made without a repository, and with its VM made it could never have one.)
    const store = make(); setup(store);
    store.setWorkspace("lin", { node: "host", id: "0123456789" });
    expect(store.teammate("lin")!.repository).toBeNull();
    // Nothing of a repository is in that VM yet, so there is nothing a first one could orphan.
    expect(store.saveTeammate({ id: "lin", name: "Lin", repository: "https://github.com/example/first" }).repository).toBe("https://github.com/example/first");
    expect(store.teammate("lin")!.workspace).toEqual({ node: "host", id: "0123456789" });
    expect(() => store.saveTeammate({ id: "lin", name: "Lin", repository: "https://github.com/example/second" })).toThrow(/already bound/);
    expect(() => store.saveTeammate({ id: "lin", name: "Lin", repository: null })).toThrow(/already bound/);
  });
});

describe("team boundaries", () => {
  test("avatar telemetry keeps old live work and recent outcomes, grouped without private text", () => {
    let now = 100_000;
    const store = make(":memory:", () => now); setup(store);
    const old = store.createTask({ room: "workshop", assignee: "ada", title: "private old title", goal: "private old goal" });
    store.finish(old.id, "done", null, { verified: true, output: "private old output" });
    const running = store.createTask({ room: "workshop", assignee: "ada", title: "private active title", goal: "private active goal" }); store.claim(running.id);
    for (let n = 0; n < 3; n++) store.createTask({ room: "workshop", assignee: "ada", title: `private queued ${n}`, goal: "private goal" });
    store.post({ room: "workshop", text: "@ada @lin: private conversation" });
    const delivery = store.queued().find((job) => job.kind === "delivery" && job.teammate === "lin")!; store.claim(delivery.id);
    now += 120_000;
    const failed = store.createTask({ room: "workshop", assignee: "lin", title: "private failure", goal: "private goal" });
    store.finish(failed.id, "done", null, { verified: false, output: "private unverified claim" });
    for (let n = 0; n < 3; n++) {
      const done = store.createTask({ room: "workshop", assignee: "lin", title: "private completion", goal: "private goal" });
      store.finish(done.id, "done", null, { verified: true, output: "private evidence ".repeat(2000) }); now++;
    }
    const activity = store.avatarActivity();
    expect(activity.tasks).toHaveLength(4); // one row per worker/status, not per task
    expect(activity.tasks).toContainEqual({ assignee: "ada", status: "running", verified: false, updatedAt: 100_000 });
    expect(activity.tasks).toContainEqual({ assignee: "ada", status: "queued", verified: false, updatedAt: 100_000 });
    expect(activity.tasks).toContainEqual({ assignee: "lin", status: "failed", verified: false, updatedAt: 220_000 });
    expect(activity.tasks).toContainEqual({ assignee: "lin", status: "done", verified: true, updatedAt: 220_002 });
    expect(activity.deliveries).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toContain("private");
    expect(Object.keys(activity.tasks[0]!).sort()).toEqual(["assignee", "status", "updatedAt", "verified"]);
    expect(Object.keys(activity.deliveries[0]!).sort()).toEqual(["status", "teammate", "updatedAt"]);
    expect(avatarExpression(store.requireTeammate("ada"), activity, now)).toBe("working");
    expect(avatarExpression(store.requireTeammate("lin"), activity, now)).toBe("thinking");
    store.finish(delivery.id, "done");
    expect(avatarExpression(store.requireTeammate("lin"), store.avatarActivity(), now)).toBe("concerned");
  });
  test("secrets are refused before input storage; errors and progress never retain them", () => {
    const store = make(); setup(store);
    const fake = "sk-ant-" + "obviouslyfaketest".repeat(3);
    expect(() => store.post({ room: "workshop", text: fake })).toThrow(TeamError);
    expect(() => store.remember("ada", fake)).toThrow(TeamError);
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", instructions: fake })).toThrow(TeamError);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Check", goal: "Check" });
    store.claim(task.id); store.progress(task.id, fake); store.finish(task.id, "failed", fake, { verified: false, output: fake });
    expect(JSON.stringify(store.snapshot())).not.toContain(fake);
    expect(store.messages("workshop")).toHaveLength(0);
  });
  test("a finished task keeps what its run came to, as the runner counted it, and a reopened store still says it", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-")); dirs.push(dir);
    const store = make(join(dir, "team.db")); setup(store);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Check", goal: "Check" });
    expect(store.task(task.id)!.record).toBeUndefined();
    store.claim(task.id);
    const record = { startedAt: 1000, endedAt: 61_000, ended: "done" as const, commands: 7, revisions: 1, spent: [{ role: "engineer", model: "plan/m", calls: 8, unknown: 0, input: 90_000, output: 4000, cached: 70_000, reasoning: 1500 }] };
    store.finish(task.id, "done", null, { verified: true, output: "Tests passed", record });
    expect(store.task(task.id)!.record).toEqual(record);
    expect(store.snapshot().tasks.find((t) => t.id === task.id)!.record).toEqual(record);
    close(store);
    expect(make(join(dir, "team.db")).task(task.id)!.record).toEqual(record);
    // A record that isn't one (a runner from elsewhere, a field too many) is refused whole: the task ends without it.
    const other = make(); setup(other);
    const odd = other.createTask({ room: "workshop", assignee: "ada", title: "Check", goal: "Check" });
    other.claim(odd.id);
    other.finish(odd.id, "done", null, { verified: true, output: "Tests passed", record: { ...record, prompt: "the words themselves" } as never });
    expect(other.task(odd.id)).toMatchObject({ status: "done", verified: true });
    expect(other.task(odd.id)!.record).toBeUndefined();
  });
  test("posts and delegated tasks cannot cross membership boundaries", () => {
    const store = make(); setup(store); store.saveTeammate({ id: "outsider", name: "Outside" });
    const message = store.post({ room: "workshop", text: "@ada @lin: work" });
    expect(() => store.post({ room: "workshop", text: "Pretend I am inside" }, { teammate: "outsider", chainId: message.chainId })).toThrow(/not a member/);
    expect(() => store.post({ room: "workshop", text: "Fresh budget" }, { teammate: "ada" })).toThrow(/current conversation/);
    expect(() => store.createTask({ room: "workshop", assignee: "outsider", title: "Work", goal: "Work" })).toThrow(/not a member/);
    expect(() => store.createTask({ room: "workshop", assignee: "ada", title: "Work", goal: "Work" }, { teammate: "outsider", chainId: message.chainId })).toThrow(/not a member/);
  });
  test("direct conversation membership is immutable and owner DMs differ from peer DMs", () => {
    const store = make(); setup(store);
    const owner = store.direct("ada"); const peers = store.direct("ada", "lin");
    expect(store.direct("lin", "ada").id).toBe(peers.id);
    expect(owner.id).not.toBe(peers.id);
    expect(owner.members).toEqual(["ada"]);
    expect(() => store.saveRoom({ id: peers.id, name: "Changed", members: ["ada"] })).toThrow(/cannot be changed/);
  });
  test("only verified successful dependencies unblock, and dependencies must already exist in the room", () => {
    const store = make(); setup(store);
    const parent = store.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    const child = store.createTask({ room: "workshop", assignee: "lin", title: "Next", goal: "Next", dependsOn: [parent.id] });
    expect(store.claim(child.id)).toBe(false);
    store.claim(parent.id); store.finish(parent.id, "done", null, { verified: false, output: "Claims done" });
    expect(store.task(parent.id)?.status).toBe("failed"); expect(store.claim(child.id)).toBe(false);
    store.resume({ task: parent.id }); store.claim(parent.id); store.finish(parent.id, "done", null, { verified: true, output: "Tests passed" });
    expect(store.claim(child.id)).toBe(true);
    const other = store.direct("ada");
    expect(() => store.createTask({ room: other.id, assignee: "ada", title: "Bad", goal: "Bad", dependsOn: [parent.id] })).toThrow(/this room/);
  });
  test("turn budgets are reserved before execution and daily allowance does not reset across rooms", () => {
    let now = Date.UTC(2026, 10, 12, 12);
    const store = make(":memory:", () => now); setup(store); store.saveTeammate({ id: "ada", name: "Ada", dailyTurns: 1 });
    const first = store.createTask({ room: "workshop", assignee: "ada", title: "First", goal: "First" });
    const room = store.direct("ada");
    const second = store.createTask({ room: room.id, assignee: "ada", title: "Next", goal: "Next" });
    expect(store.claim(first.id)).toBe(true); expect(store.claim(second.id)).toBe(false);
    store.finish(first.id, "failed", "Failure still costs a turn");
    expect(store.claim(second.id)).toBe(false); expect(store.teammate("ada")?.turnsToday).toBe(1);
    now += 86_400_000;
    expect(store.claim(second.id)).toBe(true);
  });
  test("a full queue refuses a whole owner post without leaving an unserviceable message", () => {
    const store = make(); setup(store);
    for (let n = 0; n < 128; n++) store.post({ room: "workshop", text: `@ada @lin: question ${n}` });
    expect(store.queued()).toHaveLength(256);
    const before = store.messages("workshop");
    expect(() => store.post({ room: "workshop", text: "@ada @lin: too much" })).toThrow(/queue is full/);
    expect(store.messages("workshop")).toEqual(before);
  });
  test("old running and queued work stays visible after more than 512 newer finished jobs", () => {
    const store = make(); setup(store);
    const running = store.createTask({ room: "workshop", assignee: "ada", title: "Long work", goal: "Long work" });
    store.claim(running.id);
    const queued = store.createTask({ room: "workshop", assignee: "ada", title: "Waiting", goal: "Waiting" });
    store.saveRoom({ id: "messages", name: "Messages", members: ["lin"] });
    store.post({ room: "messages", text: "@lin: a long conversation" });
    const liveDelivery = store.queued().find((job) => job.room === "messages")!;
    store.claim(liveDelivery.id);
    store.post({ room: "messages", text: "@lin: waiting on that conversation" });
    const queuedDelivery = store.queued().find((job) => job.room === "messages")!;
    for (let n = 0; n < 520; n++) {
      const task = store.createTask({ room: "workshop", assignee: "lin", title: `Finished ${n}`, goal: "Finished" });
      store.finish(task.id, "done", null, { verified: true, output: "Verified" });
      const message = store.post({ room: "messages", text: `@lin: finished conversation ${n}` });
      const delivery = store.queued().find((job) => job.room === "messages" && job.chainId === message.chainId)!;
      store.finish(delivery.id, "done");
    }
    for (const tasks of [store.tasks(), store.tasks("workshop"), store.snapshot().tasks, store.roomView("workshop").tasks]) {
      expect(tasks).toHaveLength(512);
      expect(tasks.slice(0, 2).map((task) => task.id)).toEqual([running.id, queued.id]);
    }
    for (const deliveries of [store.deliveries(), store.deliveries("messages"), store.snapshot().deliveries, store.roomView("messages").deliveries]) {
      expect(deliveries).toHaveLength(512);
      expect(deliveries.slice(0, 2).map((delivery) => delivery.id)).toEqual([liveDelivery.id, queuedDelivery.id]);
    }
  });
});

describe("Galahad's own computer", () => {
  test("its binding is kept as a knight's VM is, said in the snapshot, cleared when it goes, and survives a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-computer-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path);
    expect(store.computer()).toBeNull();
    expect(store.snapshot().computer).toBeUndefined();
    expect(store.setComputer({ node: "host", id: "0123456789" })).toEqual({ node: "host", id: "0123456789" });
    expect(() => store.setComputer({ node: "host", id: "../etc" } as never)).toThrow(TeamError);
    close(store);
    const reopened = make(path);
    expect(reopened.computer()).toEqual({ node: "host", id: "0123456789" });
    expect(reopened.snapshot().computer).toEqual({ node: "host", id: "0123456789" });
    // It is no knight: in no list of them.
    expect(reopened.teammates().map((t) => t.id)).not.toContain("galahad");
    reopened.setComputer(null);
    expect(reopened.computer()).toBeNull();
  });
});

describe("the knights Galahad makes for himself", () => {
  const DAY = 24 * 3_600_000;
  const job = (id: string) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "A lasting job." });

  test("a knight he makes is a new one with the defaults, and says whose words its job is", () => {
    const store = make(); setup(store);
    const scout = store.recruit({ id: "scout", name: "Scout", instructions: "Watch the dependency updates.", role: "reviewer" }, "galahad");
    expect(scout).toMatchObject({ id: "scout", name: "Scout", instructions: "Watch the dependency updates.", role: "reviewer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 0, repository: null, workspace: null, workspaceNode: null, memory: "", avatar: defaultAvatar("scout"), createdBy: "galahad", instructionsBy: "galahad" });
    // Never an existing worker: yours stay exactly as you left them.
    const ada = store.teammate("ada");
    expect(ada).toMatchObject({ createdBy: "owner", instructionsBy: "owner" });
    expect(() => store.recruit({ id: "ada", name: "Impostor", instructions: "Take her place." }, "galahad")).toThrow(/already exists/);
    expect(store.teammate("ada")).toEqual(ada);
    // Its allowance, its state and its look are not his to choose; nor is a credential ever part of a job.
    for (const extra of [{ dailyTurns: 1000 }, { enabled: false }, { avatar: defaultAvatar("x") }, { createdBy: "owner" }]) expect(() => store.recruit({ ...job("x"), ...extra } as never, "galahad")).toThrow(TeamError);
    expect(() => store.recruit({ ...job("keys"), instructions: `Sign in with ${"sk-ant-" + "obviouslyfaketest".repeat(3)}` }, "galahad")).toThrow(/credential/);
    expect(store.teammates().map((t) => t.id)).toEqual(["ada", "lin", "scout"]);
    // Its job becomes yours when you change its words, never by saving something else about it (the app sends
    // the whole profile with every save); who made it stays on record.
    expect(store.saveTeammate({ id: "scout", name: "Scout the second" })).toMatchObject({ createdBy: "galahad", instructionsBy: "galahad" });
    expect(store.saveTeammate({ id: "scout", name: "Scout", instructions: "Watch the dependency updates.", dailyTurns: 12, avatar: defaultAvatar("other") })).toMatchObject({ createdBy: "galahad", instructionsBy: "galahad", dailyTurns: 12 });
    expect(store.saveTeammate({ id: "scout", name: "Scout", instructions: "Watch them weekly." })).toMatchObject({ createdBy: "galahad", instructionsBy: "owner" });
    expect(store.saveTeammate({ id: "scout", name: "Scout", instructions: "Watch them weekly." })).toMatchObject({ createdBy: "galahad", instructionsBy: "owner" });
  });

  test("he cannot give a knight a name that reads as another knight's; yours stay yours to name", () => {
    const store = make(); setup(store);
    store.saveTeammate({ id: "ilya", name: "Ilya" });
    store.saveTeammate({ id: "mona", name: "Mona Lisa" });
    // The same name, its capitals, a hyphen in it, l for I, rn for m: each would be taken for the worker that has it.
    for (const name of ["Ada", "ADA", "A-da", "llya", "ILYA", "RnonaLisa"]) {
      expect(() => store.recruit({ ...job("double"), name }, "galahad")).toThrow(/reads like/);
    }
    // (Letters of two scripts in one name never get this far: the boundary refuses them.)
    expect(() => store.recruit({ ...job("double"), name: "\u0410d\u0430" }, "galahad")).toThrow(TeamError);
    expect(store.teammate("double")).toBeFalsy();
    // Hardly drawn or not at all: a raised apostrophe, a long-vowel mark, a tatweel after the same letters.
    for (const name of ["Ada\u02bc", "Ada\u30fc", "Ada\ua78c"]) expect(() => store.recruit({ ...job("double"), name }, "galahad")).toThrow(/reads like Ada/);
    // A capital L is not a capital I: Lan may stand beside Ian, and a small l may not.
    store.saveTeammate({ id: "ian", name: "Ian" });
    expect(() => store.recruit({ ...job("double"), name: "lan" }, "galahad")).toThrow(/reads like Ian/);
    expect(store.recruit({ ...job("lan"), name: "Lan" }, "galahad").name).toBe("Lan");
    expect(store.recruit({ ...job("double"), name: "Adah" }, "galahad")).toMatchObject({ id: "double", name: "Adah" });
    // One he made is protected the same way, from him and from a worker that makes one.
    expect(() => store.recruit({ ...job("third"), name: "ADAH" }, "ada")).toThrow(/reads like Adah/);
    expect(store.saveTeammate({ id: "twin", name: "Ada" }).name).toBe("Ada");
  });

  test("provenance survives a reopen, and an older record without it is yours", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-made-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path); setup(store);
    store.recruit(job("scout"), "ada");
    const { createdBy: _made, instructionsBy: _written, ...legacy } = store.teammate("lin")!; close(store);
    const db = new Database(path);
    db.query("UPDATE team_teammates SET value=? WHERE id='lin'").run(JSON.stringify(legacy)); db.close();
    const reopened = make(path);
    expect(reopened.teammate("scout")).toMatchObject({ createdBy: "ada", instructionsBy: "ada" });
    expect(reopened.teammate("lin")).toMatchObject({ createdBy: "owner", instructionsBy: "owner" });
  });

  test("he may make only a few in a day and never past the node's limit; yours never count against him", () => {
    let now = Date.UTC(2026, 10, 13, 12);
    const store = make(":memory:", () => now);
    for (let n = 0; n < 5; n++) store.saveTeammate({ id: `yours-${n}`, name: `Yours ${n}` });
    for (let n = 0; n < TEAM_LIMITS.recruitsPerDay; n++) store.recruit(job(`his-${n}`), n % 2 ? "galahad" : "yours-0");
    expect(() => store.recruit(job("one-more"), "galahad")).toThrow(/allowance/);
    expect(() => store.recruit(job("one-more"), "yours-1")).toThrow(/allowance/);
    expect(store.teammate("one-more")).toBeNull();
    expect(store.saveTeammate({ id: "yours-5", name: "Yours 5" }).createdBy).toBe("owner");
    now += DAY - 1;
    expect(() => store.recruit(job("one-more"), "galahad")).toThrow(/allowance/);
    now += 2;
    expect(store.recruit(job("one-more"), "galahad").createdBy).toBe("galahad");
    // The node's own limit holds for him as for you.
    for (let n = store.teammates().length; n < TEAM_LIMITS.teammates; n++) store.saveTeammate({ id: `fill-${n}`, name: `Fill ${n}` });
    now += DAY * 2;
    expect(() => store.recruit(job("past-the-limit"), "galahad")).toThrow(new RegExp(`At most ${TEAM_LIMITS.teammates}`));
    expect(store.teammates()).toHaveLength(TEAM_LIMITS.teammates);
  });

  test("a knight made by a knight joins its maker's shared room at once; never a direct conversation; and all of it or none", () => {
    const store = make(); setup(store);
    const made = store.recruit({ ...job("rev"), instructions: "Review Ada's diffs." }, "ada", "workshop");
    expect(made).toMatchObject({ createdBy: "ada", instructionsBy: "ada" });
    expect(store.room("workshop")!.members).toEqual(["ada", "lin", "rev"]);
    const direct = store.direct("lin");
    store.recruit(job("aide"), "lin", direct.id);
    expect(store.room(direct.id)!.members).toEqual(["lin"]);
    expect(() => store.recruit(job("orphan"), "nobody")).toThrow(/No such knight/);
    expect(() => store.recruit(job("lost"), "ada", "no-such-room")).toThrow(/No such team room/);
    // Nor into a room its maker is not in.
    store.saveRoom({ id: "private", name: "Private", members: ["lin"] });
    expect(() => store.recruit(job("intruder"), "ada", "private")).toThrow(/not a member/);
    expect(store.room("private")!.members).toEqual(["lin"]);
    for (const id of ["orphan", "lost", "intruder"]) expect(store.teammate(id)).toBeNull();
  });

  test("his own words reach a room as his, start their own bounded chain, and have a daily allowance of their own", () => {
    let now = Date.UTC(2026, 10, 13, 12);
    const store = make(":memory:", () => now); setup(store);
    const said = store.post({ room: "workshop", text: "Compare notes on the fixture." }, { galahad: true });
    expect(said).toMatchObject({ speaker: "galahad", speakerName: "Galahad", text: "Compare notes on the fixture." });
    expect(store.queued().map((queued) => queued.teammate).sort()).toEqual(["ada", "lin"]);
    expect(store.queued().every((queued) => queued.chainId === said.chainId)).toBe(true);
    const yours = store.post({ room: "workshop", text: "And tell me what you find." });
    expect(yours).toMatchObject({ speaker: "owner", speakerName: "You" });
    expect(yours.chainId).not.toBe(said.chainId);
    expect(() => store.post({ room: "workshop", text: `The key is ${"sk-ant-" + "obviouslyfaketest".repeat(3)}` }, { galahad: true })).toThrow(/credential/);
    expect(() => store.post({ room: "no-such-room", text: "Anyone?" }, { galahad: true })).toThrow(/No such team room/);
    store.stopQueued({});
    for (let n = 1; n < TEAM_LIMITS.saysPerDay; n++) { store.post({ room: "workshop", text: `Message ${n}.` }, { galahad: true }); store.stopQueued({}); }
    expect(() => store.post({ room: "workshop", text: "One more." }, { galahad: true })).toThrow(/allowance/);
    expect(store.post({ room: "workshop", text: "You always can." }).speaker).toBe("owner");
    now += DAY + 1;
    expect(store.post({ room: "workshop", text: "A new day." }, { galahad: true }).speaker).toBe("galahad");
  });

  test("his words never fill the queue: half of it is always left for yours", () => {
    const store = make();
    const members = Array.from({ length: 16 }, (_, n) => `worker-${n}`);
    for (const id of members) store.saveTeammate({ id, name: id });
    store.saveRoom({ id: "hall", name: "Hall", members });
    // A held room keeps what is said to it: nothing he sends there runs, and it would all stay queued.
    store.pauseRoom("hall", true);
    for (let n = 0; n < TEAM_LIMITS.pending / 2 / members.length; n++) store.post({ room: "hall", text: `Message ${n}.` }, { galahad: true });
    expect(store.queued()).toHaveLength(TEAM_LIMITS.pending / 2);
    expect(() => store.post({ room: "hall", text: "One more." }, { galahad: true })).toThrow(/queue/);
    expect(store.queued()).toHaveLength(TEAM_LIMITS.pending / 2);
    expect(store.post({ room: "hall", text: "Yours still goes." }).speaker).toBe("owner");
  });

  test("a message of his that is refused leaves nothing behind, not even the conversation it would have opened", () => {
    const store = make(); setup(store);
    expect(() => store.say({ teammate: "ada", text: `The key is ${"sk-ant-" + "obviouslyfaketest".repeat(3)}` })).toThrow(/credential/);
    expect(() => store.say({ teammate: "nobody", text: "Anyone?" })).toThrow(/No such knight/);
    expect(() => store.say({ text: "To nobody." } as never)).toThrow(TeamError);
    expect(store.rooms().map((room) => room.id)).toEqual(["workshop"]);
    const said = store.say({ teammate: "ada", text: "Look into the flaky test." });
    const direct = store.rooms().find((room) => room.direct)!;
    expect(direct.members).toEqual(["ada"]);
    expect(said).toMatchObject({ room: direct.id, speaker: "galahad" });
    expect(store.say({ room: "workshop", text: "Compare notes." })).toMatchObject({ room: "workshop", speaker: "galahad" });
  });

  test("his overview says who each knight is and what it is doing, never its working notes; a room's words only when asked", () => {
    let now = Date.UTC(2026, 10, 13, 12);
    const store = make(":memory:", () => now); setup(store);
    store.saveTeammate({ id: "ada", name: "Ada", instructions: `Implement small changes.\n${"More detail. ".repeat(60)}`, repository: "https://github.com/example/fixture" });
    store.remember("ada", "private working note");
    store.recruit(job("scout"), "galahad");
    store.enable("lin", false);
    store.post({ room: "workshop", text: "@ada @lin: the newest question." });
    store.claim(store.queued().find((queued) => queued.teammate === "ada")!.id);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Fix the parser", goal: "private goal text" });
    const view = store.overview();
    expect(view.workers.map((w) => [w.id, w.state, w.madeBy])).toEqual([["ada", "working", "owner"], ["lin", "paused", "owner"], ["scout", "ready", "galahad"]]);
    expect(view.workers[0]).toMatchObject({ name: "Ada", role: "engineer", harness: "native", repository: "https://github.com/example/fixture", workspace: false, turnsToday: 1, dailyTurns: 40 });
    expect(view.workers[0]!.job.length).toBeLessThanOrEqual(400);
    expect(view.workers[0]!.job).toContain("Implement small changes.");
    expect(view.rooms).toEqual([{ id: "workshop", name: "Workshop", members: ["ada", "lin"], direct: false, paused: false, turnBudget: 8 }]);
    expect(view.room).toBeUndefined();
    expect(view.spare).toEqual({ workers: TEAM_LIMITS.teammates - 3, today: TEAM_LIMITS.recruitsPerDay - 1 });
    expect(JSON.stringify(view)).not.toContain("private");
    const room = store.overview("workshop").room!;
    expect(room).toMatchObject({ id: "workshop", name: "Workshop", members: ["ada", "lin"] });
    expect(room.messages).toEqual([{ speaker: "owner", speakerName: "You", text: "@ada @lin: the newest question.", createdAt: now }]);
    expect(room.tasks).toEqual([{ id: task.id, title: "Fix the parser", assignee: "ada", status: "queued", verified: false }]);
    expect(() => store.overview("no-such-room")).toThrow(/No such team room/);
    // Long conversations come as their latest part, each message clipped.
    for (let n = 0; n < 40; n++) { store.post({ room: "workshop", text: `${n}: ${"long ".repeat(800)}` }); store.stopQueued({}); now += 1; }
    const latest = store.overview("workshop").room!.messages;
    expect(latest).toHaveLength(20);
    expect(latest.at(-1)!.text.startsWith("39: ")).toBe(true);
    expect(latest.every((message) => message.text.length <= 1300)).toBe(true);
  });
});

describe("removing a knight", () => {
  const DAY = 24 * 3_600_000;
  const job = (id: string) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "A lasting job." });
  /** One reply of a worker's in a room, as the service would record it: claimed, said, done. */
  const reply = (store: TeamStore, teammate: string, room: string, text: string) => {
    const delivery = store.queued().find((j) => j.teammate === teammate && j.room === room)!;
    expect(store.claim(delivery.id)).toBe(true);
    store.post({ room, text }, { teammate, chainId: delivery.chainId, output: true });
    store.finish(delivery.id, "done");
  };

  test("it is retired, not erased: gone from the team and from work, with its words and its record kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-remove-")); dirs.push(dir); const path = join(dir, "team.db");
    let now = 1_000_000;
    const store = make(path, () => now);
    setup(store);
    const dm = store.direct("ada");
    const peers = store.direct("lin", "ada");
    store.post({ room: "workshop", text: "@ada @lin: start." });
    reply(store, "ada", "workshop", "On it.");
    store.post({ room: dm.id, text: "Only you." });
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Fix it", goal: "Fix the parser." });
    now += 5_000;
    expect(store.remove("ada")).toMatchObject({ id: "ada", name: "Ada", enabled: false, removedAt: now });

    // Gone from the team, and said so wherever it is asked for.
    expect(store.teammate("ada")).toBeNull();
    expect(store.teammates().map((t) => t.id)).toEqual(["lin"]);
    expect(() => store.requireTeammate("ada")).toThrow(/was removed/);
    expect(store.snapshot().teammates.map((t) => t.id)).toEqual(["lin"]);
    // (With where to read its direct conversations, yours with it first, since they are in no other list.)
    expect(store.snapshot().removed).toEqual([{ id: "ada", name: "Ada", removedAt: now, conversations: [dm.id, peers.id] }]);
    expect(store.overview().workers.map((w) => w.id)).toEqual(["lin"]);
    // What it had not started is stopped, and says why.
    expect(store.queued().filter((j) => j.teammate === "ada")).toEqual([]);
    expect(store.task(task.id)).toMatchObject({ status: "stopped", error: "Its knight was removed." });
    // The shared room goes on without it; what it said there is still its own.
    expect(store.room("workshop")!.members).toEqual(["lin"]);
    expect(store.messages("workshop").map((m) => [m.speaker, m.speakerName, m.text])).toContainEqual(["ada", "Ada", "On it."]);
    expect(store.post({ room: "workshop", text: "Carry on." }).text).toBe("Carry on.");
    expect(store.queued().map((j) => j.teammate)).toEqual(expect.arrayContaining(["lin"]));
    // Its direct conversations are kept to read, are no longer listed, and take no new words.
    expect(store.snapshot().rooms.map((r) => r.id)).toEqual(["workshop"]);
    expect(store.overview().rooms.map((r) => r.id)).toEqual(["workshop"]);
    expect(store.roomView(dm.id).messages.map((m) => m.text)).toEqual(["Only you."]);
    expect(store.roomView(peers.id).members).toEqual(["ada", "lin"]);
    expect(() => store.post({ room: dm.id, text: "Still there?" })).toThrow(/was removed/);
    expect(() => store.direct("ada")).toThrow(/was removed/);
    expect(() => store.direct("ada", "lin")).toThrow(/was removed/);

    close(store);
    const reopened = make(path, () => now);
    expect(reopened.teammate("ada")).toBeNull();
    expect(reopened.snapshot().removed).toEqual([{ id: "ada", name: "Ada", removedAt: now, conversations: [dm.id, peers.id] }]);
    expect(reopened.room("workshop")!.members).toEqual(["lin"]);
  });

  test("its handle is never anyone else's, so nothing new inherits its history; and it takes no further change", () => {
    const store = make(); setup(store);
    store.remove("ada");
    expect(() => store.saveTeammate({ id: "ada", name: "Ada" })).toThrow(/was removed/);
    expect(() => store.recruit({ id: "ada", name: "Nova", instructions: "A job." }, "galahad")).toThrow(/was removed/);
    // Its name is still in the record, where people read it.
    expect(() => store.recruit({ id: "nova", name: "Ada", instructions: "A job." }, "galahad")).toThrow(/reads like Ada/);
    expect(() => store.saveRoom({ name: "New room", members: ["ada", "lin"] })).toThrow(/was removed/);
    for (const change of [() => store.remove("ada"), () => store.remember("ada", "notes"), () => store.enable("ada", true), () => store.planWorkspace("ada", "host"), () => store.setWorkspace("ada", { node: "host", id: "0123456789" })]) {
      expect(change).toThrow(/was removed/);
    }
    expect(() => store.remove("nobody")).toThrow(/No such knight/);
    expect(store.teammates().map((t) => t.id)).toEqual(["lin"]);
  });

  test("a workspace or running work is never left behind: each refuses the removal, and nothing changes", () => {
    const store = make(); setup(store);
    store.setWorkspace("ada", { node: "host", id: "0123456789" });
    expect(() => store.remove("ada")).toThrow(/workspace/);
    store.setWorkspace("ada", null);
    store.post({ room: "workshop", text: "@ada @lin: go." });
    const running = store.queued().find((j) => j.teammate === "ada")!;
    expect(store.claim(running.id)).toBe(true);
    expect(() => store.remove("ada")).toThrow(/Stop this knight's work/);
    expect(store.teammate("ada")).toMatchObject({ enabled: true });
    expect(store.room("workshop")!.members).toEqual(["ada", "lin"]);
    store.finish(running.id, "stopped", "Stopped by you.");
    expect(store.remove("ada").removedAt).toBeGreaterThan(0);
  });

  test("what it left unfinished can't be started again, and never stalls the others", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-remove-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path); setup(store);
    const hers = store.createTask({ room: "workshop", assignee: "ada", title: "Hers", goal: "Do it." });
    const his = store.createTask({ room: "workshop", assignee: "lin", title: "His", goal: "Do it." });
    expect(store.claim(hers.id)).toBe(true);
    store.finish(hers.id, "interrupted", "Paused by you.");
    store.remove("ada");
    // Resuming the room brings back nothing of hers; resuming her task by name says why not.
    store.resume({ room: "workshop" });
    expect(store.task(hers.id)!.status).toBe("interrupted");
    expect(() => store.resume({ task: hers.id })).toThrow(/was removed/);
    expect(store.task(hers.id)!.status).toBe("interrupted");
    // A job of hers that is somehow still queued (an older database) is stopped when its turn comes, and the queue moves on.
    close(store);
    const raw = new Database(path);
    raw.query("UPDATE team_jobs SET status='queued' WHERE id=?").run(hers.id);
    raw.close();
    const reopened = make(path);
    expect(reopened.queued().map((j) => j.id)).toEqual([hers.id, his.id]);
    expect(reopened.claim(hers.id)).toBe(false);
    expect(reopened.task(hers.id)).toMatchObject({ status: "stopped", error: "Its knight was removed." });
    expect(reopened.claim(his.id)).toBe(true);
  });

  test("the day's allowance for making knights isn't given back; the node's limit counts those still here", () => {
    let now = 5 * DAY;
    const store = make(":memory:", () => now);
    store.saveTeammate({ id: "ada", name: "Ada" });
    for (let n = 0; n < TEAM_LIMITS.recruitsPerDay; n++) store.recruit(job(`made-${n}`), "galahad");
    for (let n = 0; n < 3; n++) store.remove(`made-${n}`);
    expect(store.overview().spare.today).toBe(0);
    expect(() => store.recruit(job("one-more"), "galahad")).toThrow(/allowance/);
    now += DAY + 1;
    expect(store.recruit(job("one-more"), "galahad").id).toBe("one-more");
    // Yours fill the node; removing one makes room for one.
    const full = make();
    for (let n = 0; n < TEAM_LIMITS.teammates; n++) full.saveTeammate({ id: `yours-${n}`, name: `Yours ${n}` });
    expect(() => full.saveTeammate({ id: "extra", name: "Extra" })).toThrow(new RegExp(`At most ${TEAM_LIMITS.teammates}`));
    full.remove("yours-0");
    expect(full.overview().spare.workers).toBe(1);
    expect(full.saveTeammate({ id: "extra", name: "Extra" }).id).toBe("extra");
  });

  test("a conversation it had with another knight is closed for that knight too: no words, no work, and no turn spent on it", () => {
    const store = make(); setup(store);
    const peers = store.direct("lin", "ada");
    // Ada had written to Lin there, and Lin's reply was still waiting when Ada was removed.
    const opened = store.post({ room: "workshop", text: "@ada @lin: talk it over." });
    const adas = store.queued().find((j) => j.teammate === "ada")!;
    expect(store.claim(adas.id)).toBe(true);
    store.post({ room: peers.id, text: "Between us." }, { teammate: "ada", chainId: opened.chainId });
    store.finish(adas.id, "done");
    const waiting = store.queued().find((j) => j.teammate === "lin" && j.room === peers.id)!;
    const before = store.teammate("lin")!.turnsToday;
    store.remove("ada");
    expect(store.deliveries(peers.id).find((d) => d.id === waiting.id)).toMatchObject({ status: "stopped", error: "This conversation is kept to read: its knight was removed." });
    expect(store.claim(waiting.id)).toBe(false);
    expect(store.teammate("lin")!.turnsToday).toBe(before);
    // Nothing new is taken there, from you or from the worker that is still here.
    expect(() => store.post({ room: peers.id, text: "Still there?" })).toThrow(/was removed/);
    expect(() => store.post({ room: peers.id, text: "Hello?" }, { teammate: "lin", chainId: opened.chainId })).toThrow(/was removed/);
    expect(() => store.createTask({ room: peers.id, assignee: "lin", title: "Alone", goal: "Do it." })).toThrow(/was removed/);
    expect(store.snapshot().tasks.filter((t) => t.room === peers.id)).toEqual([]);
    // What was said there stays, and Lin's own work elsewhere goes on.
    expect(store.roomView(peers.id).messages.map((m) => m.text)).toEqual(["Between us."]);
    const elsewhere = store.queued().find((j) => j.teammate === "lin" && j.room === "workshop")!;
    expect(store.claim(elsewhere.id)).toBe(true);
  });

  test("an older database's job in such a conversation is stopped when its turn comes, without a turn spent", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-remove-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path); setup(store);
    const peers = store.direct("lin", "ada");
    const opened = store.post({ room: "workshop", text: "@ada @lin: talk." });
    const adas = store.queued().find((j) => j.teammate === "ada")!;
    store.claim(adas.id);
    store.post({ room: peers.id, text: "Between us." }, { teammate: "ada", chainId: opened.chainId });
    store.finish(adas.id, "done");
    const waiting = store.queued().find((j) => j.teammate === "lin" && j.room === peers.id)!;
    store.remove("ada");
    close(store);
    const raw = new Database(path);
    raw.query("UPDATE team_jobs SET status='queued',error=NULL WHERE id=?").run(waiting.id);
    raw.close();
    const reopened = make(path);
    expect(reopened.claim(waiting.id)).toBe(false);
    expect(reopened.deliveries(peers.id).find((d) => d.id === waiting.id)).toMatchObject({ status: "stopped", error: "This conversation is kept to read: its knight was removed." });
    expect(reopened.teammate("lin")!.turnsToday).toBe(0);
  });

  test("who made a knight stays on record after its maker is removed", () => {
    const store = make(); setup(store);
    store.recruit(job("rev"), "ada", "workshop");
    store.remove("ada");
    expect(store.teammate("rev")).toMatchObject({ createdBy: "ada", instructionsBy: "ada" });
    expect(store.room("workshop")!.members).toEqual(["lin", "rev"]);
  });
});

describe("the notes store's switch", () => {
  test("on unless you turned it off: in a new team and in one from before there was a switch; your off is kept across a restart, and the snapshot says it only when it is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-engram-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path); setup(store);
    // You asked for the knights to have it (15 November 2026): a team that never said no has it.
    expect(store.engram()).toBe(true);
    expect(store.snapshot().engram).toBe(true);
    expect(store.setEngram(false)).toBe(false);
    expect("engram" in store.snapshot()).toBe(false);
    close(store);
    // Your no is kept across a restart, and a yes after it too.
    const reopened = make(path);
    expect(reopened.engram()).toBe(false);
    expect(reopened.teammates().map((t) => t.id)).toEqual(["ada", "lin"]);
    expect(reopened.setEngram(true)).toBe(true);
    close(reopened);
    expect(make(path).engram()).toBe(true);
    // A team database from before the switch has no such table: it opens, on, with everything it held.
    const old = join(dir, "old.db");
    const before = make(old); setup(before); close(before);
    const raw = new Database(old); raw.exec("DROP TABLE team_settings"); raw.close();
    const opened = make(old);
    expect(opened.engram()).toBe(true);
    expect(opened.teammates().map((t) => t.id)).toEqual(["ada", "lin"]);
    // One where you had said no (as "off", the value the switch has always kept) stays off.
    const said = join(dir, "said-no.db");
    const no = make(said); setup(no); close(no);
    const rawNo = new Database(said); rawNo.exec("INSERT OR REPLACE INTO team_settings(key,value) VALUES('engram','off')"); rawNo.close();
    expect(make(said).engram()).toBe(false);
    // Only a yes or a no is ever kept.
    expect(() => opened.setEngram("yes" as never)).toThrow(TeamError);
    expect(opened.engram()).toBe(true);
  });
});

test("a room's story is kept for it, replaced as it grows, and never holds a secret", () => {
  const store = new TeamStore(":memory:");
  store.saveTeammate({ id: "ada", name: "Ada" });
  store.saveRoom({ id: "forge", name: "Forge", members: ["ada"] });
  expect(store.story("forge")).toBeNull();
  store.keepStory("forge", "Ada drafts the notes.", "message-1");
  store.keepStory("forge", "Ada drafted the notes; Kay plans Monday.", "message-9");
  expect(store.story("forge")).toMatchObject({ text: "Ada drafted the notes; Kay plans Monday.", through: "message-9" });
  const fake = "sk-ant-" + "obviouslyfaketest".repeat(3);
  store.keepStory("forge", `The key is ${fake}`, "message-10");
  expect(store.story("forge")?.text).not.toContain(fake);
  expect(() => store.keepStory("nowhere", "x", "message-1")).toThrow();
  store.close();
});

test("what was said is searched in the rooms asked, every word of the question, the latest first", () => {
  const store = new TeamStore(":memory:");
  for (const id of ["ada", "lin"]) store.saveTeammate({ id, name: id });
  store.saveRoom({ id: "forge", name: "Forge", members: ["ada"] });
  store.saveRoom({ id: "quiet", name: "Quiet", members: ["lin"] });
  store.post({ room: "forge", text: "The release date is Monday." });
  store.post({ room: "forge", text: "Monday it is: the release ships at nine." });
  store.post({ room: "forge", text: "Unrelated: the coffee machine broke." });
  store.post({ room: "quiet", text: "The release date is secret to Lin's room." });
  const found = store.searchMessages(["forge"], "Release MONDAY");
  expect(found.map((m) => m.text)).toEqual(["Monday it is: the release ships at nine.", "The release date is Monday."]);
  expect(store.searchMessages(["forge"], "100%_")).toEqual([]);
  expect(store.searchMessages([], "release")).toEqual([]);
  store.close();
});

describe("your order of the knights, and who leads", () => {
  test("the knights come in the order you gave; one you didn't place comes after them, by handle", () => {
    const store = make(); setup(store); store.saveTeammate({ id: "bors", name: "Bors" });
    expect(store.teammates().map((t) => t.id)).toEqual(["ada", "bors", "lin"]);
    store.arrange({ order: ["lin", "bors"] });
    expect(store.teammates().map((t) => t.id)).toEqual(["lin", "bors", "ada"]);
    expect(store.snapshot()).toMatchObject({ order: ["lin", "bors"], primary: "galahad" });
  });

  test("Galahad leads by default: your words to a room that name nobody are his to answer", () => {
    const store = make(); setup(store);
    store.post({ room: "workshop", text: "What's next?" });
    expect(store.queuedAnswers()).toHaveLength(1);
    expect(store.deliveries("workshop")).toEqual([]);
  });

  test("a knight you made primary leads a room it sits in: what names nobody goes to it alone; a room without it stays Galahad's", () => {
    const store = make(); setup(store);
    store.arrange({ primary: "lin" });
    expect(store.snapshot().primary).toBe("lin");
    store.post({ room: "workshop", text: "What's next?" });
    expect(store.queuedAnswers()).toEqual([]);
    expect(store.deliveries("workshop").map((d) => d.teammate)).toEqual(["lin"]);
    // Naming him still reaches him; a room the primary isn't in is still his to lead.
    store.post({ room: "workshop", text: "@galahad what do you think?" });
    expect(store.queuedAnswers()).toHaveLength(1);
    store.saveRoom({ id: "corner", name: "Corner", members: ["ada"] });
    store.post({ room: "corner", text: "And here?" });
    expect(store.queuedAnswers().map((a) => a.room)).toContain("corner");
  });

  test("the primary must be Galahad or a knight of yours, and the order names only yours; a primary removed hands the lead back", () => {
    const store = make(); setup(store);
    expect(() => store.arrange({ primary: "nobody" })).toThrow(TeamError);
    expect(() => store.arrange({ order: ["ada", "nobody"] })).toThrow(TeamError);
    store.arrange({ primary: "ada", order: ["lin", "ada"] });
    store.remove("ada");
    expect(store.snapshot()).toMatchObject({ primary: "galahad", order: ["lin"] });
    store.arrange({ primary: "galahad" });
    expect(store.snapshot().primary).toBe("galahad");
  });
});

describe("each time you step in on a task (#28)", () => {
  test("is counted on it by how, with a line on its trail; a desktop taken over counts once", () => {
    const store = make(); setup(store);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Fix the importer", goal: "Fix it" }); store.claim(task.id);
    expect(store.intervene(task.id, "approval", "approved github.create_pr")).toBe(true);
    expect(store.intervene(task.id, "message", "a message while it worked")).toBe(true);
    expect(store.intervene(task.id, "message", "a message while it worked")).toBe(true);
    expect(store.intervene(task.id, "takeover", "took over its desktop")).toBe(true);
    expect(store.intervene(task.id, "takeover", "took over its desktop")).toBe(false);
    expect(store.task(task.id)?.interventions).toEqual({ approval: 1, message: 2, takeover: 1 });
    expect(store.trail(task.id).entries.map((e) => e.text)).toEqual([
      "You stepped in: approved github.create_pr", "You stepped in: a message while it worked", "You stepped in: a message while it worked", "You stepped in: took over its desktop",
    ]);
    // Its other words are untouched, and only a task is counted.
    expect(store.task(task.id)).toMatchObject({ title: "Fix the importer", goal: "Fix it", status: "running" });
    expect(store.intervene("no-such-task", "stop", "stopped it")).toBe(false);
  });

  test("the tasks in a state are found by a knight, a room or their id", () => {
    const store = make(); setup(store);
    const ada = store.createTask({ room: "workshop", assignee: "ada", title: "One", goal: "One" }); store.claim(ada.id);
    const lin = store.createTask({ room: "workshop", assignee: "lin", title: "Two", goal: "Two" }); store.claim(lin.id);
    const queued = store.createTask({ room: "workshop", assignee: "ada", title: "Three", goal: "Three" });
    expect(store.tasksIn({ teammate: "ada" }, ["running"]).map((t) => t.id)).toEqual([ada.id]);
    expect(store.tasksIn({ room: "workshop" }, ["running"]).map((t) => t.id)).toEqual([ada.id, lin.id]);
    expect(store.tasksIn({ task: queued.id }, ["running"])).toEqual([]);
    expect(store.tasksIn({ task: queued.id }, ["queued", "running"]).map((t) => t.id)).toEqual([queued.id]);
    expect(store.tasksIn({ room: "workshop" }, [])).toEqual([]);
  });

  test("the north star: every intervention on the tasks that ended since, per one done and verified", () => {
    let now = 1_000;
    const store = make(":memory:", () => now); setup(store);
    const give = (title: string) => { const t = store.createTask({ room: "workshop", assignee: "ada", title, goal: title }); store.claim(t.id); return t.id; };
    const old = give("Old"); store.intervene(old, "message", "a message"); store.finish(old, "done", null, { verified: true, output: "ok" });
    now = 10_000;
    const done = give("Done"); store.intervene(done, "approval", "approved"); store.finish(done, "done", null, { verified: true, output: "ok" });
    const failed = give("Failed"); store.intervene(failed, "stop", "stopped it"); store.intervene(failed, "message", "a message"); store.finish(failed, "failed", "gave up", { verified: false, output: "" });
    const running = give("Running"); store.intervene(running, "message", "a message");
    expect(store.northStar(5_000)).toEqual({ since: 5_000, completed: 1, ended: 2, interventions: 3, perCompleted: 3, byKind: { approval: 1, stop: 1, message: 1 } });
    expect(store.snapshot().northStar).toMatchObject({ completed: 2, ended: 3, interventions: 4, perCompleted: 2 });
    expect(make().northStar(0)).toEqual({ since: 0, completed: 0, ended: 0, interventions: 0, perCompleted: null, byKind: {} });
  });
});

describe("your files at the Roundtable", () => {
  const picture = { id: "a".repeat(64), name: "screen.png", type: "image/png" as const, bytes: 2048 };
  const log = { id: "b".repeat(64), name: "build.log", type: "text/plain" as const, bytes: 300 };

  test("a message of yours carries them, with words or without, and they are kept with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-files-")); dirs.push(dir); const path = join(dir, "team.db");
    const store = make(path); setup(store);
    const sent = store.post({ room: "workshop", text: "", attachments: [picture, log] });
    expect(sent).toMatchObject({ speaker: "owner", text: "", attachments: [picture, log] });
    store.post({ room: "workshop", text: "No files with this one." });
    close(store);
    const reopened = make(path);
    const messages = reopened.messages("workshop", 10);
    expect(messages[0]!.attachments).toEqual([picture, log]);
    expect(messages[1]).not.toHaveProperty("attachments");
    expect(reopened.attachmentIds()).toEqual(new Set([picture.id, log.id]));
  });

  test("a message has words or files; only you bring files", () => {
    const store = make(); setup(store);
    expect(() => store.post({ room: "workshop", text: "  " })).toThrow(TeamError);
    const chain = store.post({ room: "workshop", text: "@ada look" }).chainId;
    expect(() => store.post({ room: "workshop", text: "Mine now", attachments: [picture] }, { teammate: "ada", chainId: chain })).toThrow("Only you bring files to the Roundtable.");
    expect(() => store.post({ room: "workshop", text: "His", attachments: [picture] }, { galahad: true })).toThrow("Only you bring files to the Roundtable.");
    expect(store.attachmentIds()).toEqual(new Set());
  });

  test("a database from before files takes them after it is opened again", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-team-files-")); dirs.push(dir); const path = join(dir, "team.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE team_rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE team_chains (id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE team_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL REFERENCES team_rooms(id), speaker TEXT NOT NULL, speaker_name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, chain_id TEXT NOT NULL REFERENCES team_chains(id));`);
    old.close();
    const store = make(path); setup(store);
    expect(store.post({ room: "workshop", text: "Now with a file", attachments: [log] }).attachments).toEqual([log]);
  });
});

describe("sensitive mode", () => {
  test("a knight is put in it with models of its own, and isn't let go of it by having them taken away", () => {
    const store = make(); setup(store);
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", sensitive: true })).toThrow("Sensitive mode holds a knight to models of its own: choose them first.");
    expect(store.saveTeammate({ id: "ada", name: "Ada", models: ["nearai/Qwen/Qwen3.8-27B-abliterated"], sensitive: true })).toMatchObject({ models: ["nearai/Qwen/Qwen3.8-27B-abliterated"], sensitive: true });
    // Saved again with something else about it, it stays in sensitive mode.
    expect(store.saveTeammate({ id: "ada", name: "Ada Lovelace" })).toMatchObject({ sensitive: true });
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", models: null })).toThrow("Ada Lovelace is in sensitive mode, held to its own models: choose others, or turn sensitive mode off first.");
    // Turned off, then its models may go: it works on its role's again, as any knight.
    const off = store.saveTeammate({ id: "ada", name: "Ada", sensitive: false, models: null });
    expect(off.sensitive).toBeUndefined();
    expect(off.models).toBeUndefined();
  });

  test("the work a knight in sensitive mode gives is held to its models, whoever does it; one in it is given none held to others; a knight it makes is in it too", () => {
    const store = make(); setup(store);
    store.saveTeammate({ id: "ada", name: "Ada", models: ["nearai/Qwen/Qwen3.8-27B-abliterated", "heabsy/heabsy/cyberheabsy"], sensitive: true });
    const message = store.post({ room: "workshop", text: "@ada: plan it" });
    const given = store.createTask({ room: "workshop", assignee: "lin", title: "Work", goal: "Work it out." }, { teammate: "ada", chainId: message.chainId });
    expect(given.models).toEqual(["nearai/Qwen/Qwen3.8-27B-abliterated", "heabsy/heabsy/cyberheabsy"]);
    // Yours, for it: held to some of its models, or to none of your naming; never to another.
    expect(store.createTask({ room: "workshop", assignee: "ada", title: "One", goal: "Work it out.", models: ["heabsy/heabsy/cyberheabsy"] }).models).toEqual(["heabsy/heabsy/cyberheabsy"]);
    expect(store.createTask({ room: "workshop", assignee: "ada", title: "Two", goal: "Work it out." }).models).toBeUndefined();
    expect(() => store.createTask({ room: "workshop", assignee: "ada", title: "Three", goal: "Work it out.", models: ["anthropic/claude-opus-5-5"] })).toThrow("Ada is in sensitive mode, held to its own models (nearai/Qwen/Qwen3.8-27B-abliterated, heabsy/heabsy/cyberheabsy): a task held to anthropic/claude-opus-5-5 is never its");
    // A task you hold to a model, for a knight not in sensitive mode: kept with it.
    expect(store.task(store.createTask({ room: "workshop", assignee: "lin", title: "Four", goal: "Work it out.", models: ["nearai/Qwen/Qwen3.8-27B-abliterated"] }).id)!.models).toEqual(["nearai/Qwen/Qwen3.8-27B-abliterated"]);
    const made = store.recruit({ id: "scout", name: "Scout", instructions: "Read what the others find." }, "ada", "workshop");
    expect(made).toMatchObject({ models: ["nearai/Qwen/Qwen3.8-27B-abliterated", "heabsy/heabsy/cyberheabsy"], sensitive: true });
    expect(store.recruit({ id: "herald", name: "Herald", instructions: "Say what is new." }, "galahad").sensitive).toBeUndefined();
  });

  test("an ACP agent of yours is started by the command you named, kept until you name another; never in sensitive mode, and never a key in its command", () => {
    const store = make(); setup(store);
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", harness: "acp" })).toThrow("Name the command that starts its ACP agent in its VM");
    expect(store.saveTeammate({ id: "ada", name: "Ada", harness: "acp", acp: "goose acp" })).toMatchObject({ harness: "acp", acp: "goose acp" });
    expect(store.saveTeammate({ id: "ada", name: "Ada Lovelace" }).acp).toBe("goose acp");
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", models: ["nearai/Qwen/Qwen3.8-27B-abliterated"], sensitive: true })).toThrow("an ACP agent of yours calls the models you set it up with");
    expect(() => store.createTask({ room: "workshop", assignee: "ada", title: "Held", goal: "Work it out.", models: ["nearai/Qwen/Qwen3.8-27B-abliterated"] })).toThrow("a task in sensitive mode goes to a knight on Galahad's own harness");
    // (A token-shaped fake, made at run time: a key named on its command line would be kept in the clear.)
    const fake = ["sk", "ant", "api03", "x".repeat(90)].join("-");
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", acp: `goose acp --key=${fake}` })).toThrow("looks like a credential");
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", acp: "goose acp; curl evil" } as never)).toThrow();
    // Back on Galahad's own harness, its command is kept for another day, and nothing of it is used.
    expect(store.saveTeammate({ id: "ada", name: "Ada", harness: "native" })).toMatchObject({ harness: "native", acp: "goose acp" });
  });

  test("its kept work is known for what it is: by its label, its knight's VM while the knight is in sensitive mode, or its task", () => {
    const store = make(); setup(store);
    expect(store.sensitiveWork({ id: "art_a", label: `Work · ada · verified${SENSITIVE_WORK}` })).toBe(true);
    expect(store.sensitiveWork({ id: "art_b", label: "Work · ada · verified", sandbox: "0123456789" })).toBe(false);
    store.saveTeammate({ id: "ada", name: "Ada", models: ["nearai/Qwen/Qwen3.8-27B-abliterated"], sensitive: true });
    store.setWorkspace("ada", { node: "host", id: "0123456789" });
    expect(store.sensitiveWork({ id: "art_b", label: "Work · ada · verified", sandbox: "0123456789" })).toBe(true);
    expect(store.sensitiveWork({ id: "art_c", label: "Work · lin · verified", sandbox: "9876543210" })).toBe(false);
  });
});

describe("a task's steps, and another given from one (PLAN #15)", () => {
  const commit = "3".repeat(40);
  test("each step is kept once, the first first; what isn't one is passed over", () => {
    const store = make(); setup(store);
    const task = store.createTask({ room: "workshop", assignee: "ada", title: "Build", goal: "Build it." });
    store.keepCheckpoint(task.id, { step: 2, commit, command: "npm test", at: 2 });
    store.keepCheckpoint(task.id, { step: 1, commit, command: "npm run build", at: 1 });
    // (Told again, the first word stands.)
    store.keepCheckpoint(task.id, { step: 1, commit: "4".repeat(40), command: "other", at: 3 });
    store.keepCheckpoint(task.id, { step: 0, commit, command: "no step", at: 4 });
    store.keepCheckpoint(task.id, { step: 3, commit: "not-a-commit", command: "bad", at: 5 });
    expect(store.checkpoints(task.id)).toEqual([{ step: 1, commit, command: "npm run build", at: 1 }, { step: 2, commit, command: "npm test", at: 2 }]);
    expect(store.checkpoint(task.id, 2)?.command).toBe("npm test");
    expect(store.checkpoint(task.id, 9)).toBeNull();
  });

  test("a task given from a step is the same knight's, from a step that was kept; it says which, with that step's commit and command", () => {
    const store = make(); setup(store);
    const first = store.createTask({ room: "workshop", assignee: "ada", title: "Build", goal: "Build it." });
    store.keepCheckpoint(first.id, { step: 4, commit, command: "npm run build", at: 1 });
    const again = store.createTask({ room: "workshop", assignee: "ada", title: "Build", goal: "Build it, the other way.", from: { task: first.id, step: 4 } });
    expect(store.task(again.id)!.from).toEqual({ task: first.id, step: 4, commit, command: "npm run build" });
    expect(() => store.createTask({ room: "workshop", assignee: "lin", title: "Build", goal: "Build it.", from: { task: first.id, step: 4 } })).toThrow("A task starts from a step of its own knight's work");
    expect(() => store.createTask({ room: "workshop", assignee: "ada", title: "Build", goal: "Build it.", from: { task: first.id, step: 5 } })).toThrow(`Task ${first.id} has no step 5 kept to start from.`);
    expect(() => store.createTask({ room: "workshop", assignee: "ada", title: "Build", goal: "Build it.", from: { task: "task-nosuchtask00", step: 1 } })).toThrow("No such task to start from.");
  });
});

describe("keys of yours a knight may use (PLAN #17)", () => {
  test("kept as given, each once; kept through another save; none again with null", () => {
    const store = make(); setup(store);
    // (As it arrives, the header and the leave to write may be left out: their defaults are given.)
    expect(store.saveTeammate({ id: "ada", name: "Ada", keys: [{ secret: "stripe" }] } as never).keys).toEqual([{ secret: "stripe", header: "authorization", write: false }]);
    expect(store.saveTeammate({ id: "ada", name: "Ada Lovelace" }).keys).toEqual([{ secret: "stripe", header: "authorization", write: false }]);
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", keys: [{ secret: "stripe" }, { secret: "stripe", write: true }] } as never)).toThrow();
    expect(() => store.saveTeammate({ id: "ada", name: "Ada", keys: [{ secret: "stripe", header: "cookie" }] } as never)).toThrow();
    expect(store.saveTeammate({ id: "ada", name: "Ada", keys: null }).keys).toBeUndefined();
  });
});
