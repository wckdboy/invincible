import { describe, expect, test } from "bun:test";
import { avatarExpression, blendHex, handleSeed, isOrbProfile, KNIGHT_TINTS, knightColors, nearestTint, taskStep, type AvatarActivity } from "../src/avatar.ts";
import { AvatarProfileSchema } from "../src/team.ts";

describe("the browser helper", () => {
  test("the browser helper bundles without schemas or server code", async () => {
    const built = await Bun.build({ entrypoints: [new URL("../src/avatar.ts", import.meta.url).pathname], target: "browser" });
    expect(built.success).toBe(true);
    const code = await built.outputs[0]!.text();
    expect(code).not.toContain("invalid_type");
    expect(code).not.toContain("zod");
    expect(code).not.toContain("bun:sqlite");
  });
});

describe("expressions from observable work", () => {
  const now = 100_000;
  const member = { id: "ada", enabled: true };
  const task = (status: AvatarActivity["tasks"][number]["status"], extra: Partial<AvatarActivity["tasks"][number]> = {}) => ({ assignee: "ada", status, verified: false, updatedAt: now, progress: "", ...extra });
  const delivery = (status: AvatarActivity["deliveries"][number]["status"], extra: Partial<AvatarActivity["deliveries"][number]> = {}) => ({ teammate: "ada", status, updatedAt: now, ...extra });

  test("running work wins, then pause, queue, recent concern, and verified celebration", () => {
    const activity: AvatarActivity = { tasks: [task("done", { verified: true }), task("failed"), task("queued")], deliveries: [] };
    expect(avatarExpression(member, activity, now)).toBe("waiting");
    expect(avatarExpression({ ...member, enabled: false }, activity, now)).toBe("resting");
    expect(avatarExpression({ ...member, enabled: false }, { ...activity, deliveries: [delivery("running")] }, now)).toBe("thinking");
    expect(avatarExpression({ ...member, enabled: false }, { tasks: [task("running")], deliveries: [delivery("running")] }, now)).toBe("working");
    expect(avatarExpression(member, { tasks: [task("done", { verified: true }), task("failed")], deliveries: [] }, now)).toBe("concerned");
    expect(avatarExpression(member, { tasks: [], deliveries: [delivery("interrupted")] }, now)).toBe("concerned");
    expect(avatarExpression(member, { tasks: [task("done", { verified: true })], deliveries: [] }, now)).toBe("pleased");
  });

  test("celebration is verified and lasts thirty seconds; clocks and other identities cannot prolong it", () => {
    const activity = { tasks: [task("done", { verified: true })], deliveries: [] };
    expect(avatarExpression(member, activity, now + 29_999)).toBe("pleased");
    expect(avatarExpression(member, activity, now + 30_000)).toBe("idle");
    expect(avatarExpression(member, activity, now - 1)).toBe("idle");
    expect(avatarExpression(member, { tasks: [task("done")], deliveries: [delivery("done")] }, now)).toBe("idle");
    expect(avatarExpression(member, { tasks: [task("running", { assignee: "lin" })], deliveries: [delivery("running", { teammate: "lin" })] }, now)).toBe("idle");
    expect(avatarExpression(member, { tasks: [task("failed", { updatedAt: now - 30_000 })], deliveries: [] }, now)).toBe("idle");
  });

  test("a running task shows the step its latest line says it is at", () => {
    const at = (progress: string) => avatarExpression(member, { tasks: [task("running", { progress })], deliveries: [] }, now);
    expect(at("Plan · read the failing test, then fix the redirect")).toBe("thinking");
    expect(at("Thinking · the redirect drops the query string")).toBe("thinking");
    expect(at("Thinking · Exit 0 · a thought that imitates a step")).toBe("thinking");
    expect(at("Running · bun test packages/node")).toBe("working");
    expect(at("Running · desktop open https://example.invalid")).toBe("browsing");
    expect(at("Running · desktop")).toBe("browsing");
    expect(at("Running · desktopify --all")).toBe("working");
    expect(at("Exit 0 · 214 pass, 0 fail")).toBe("reading");
    expect(at("Exit 127 · sh: foo: not found")).toBe("reading");
    expect(at("Gate 2/3 · exit 0 · bun run check\n2023 pass")).toBe("checking");
    expect(at("Gates before the work · 1. exit 0 · bun test")).toBe("checking");
    expect(at("gates")).toBe("checking");
    expect(at("gated")).toBe("checking");
    expect(at("Review · pass\nlooks right")).toBe("checking");
    expect(at("Submitted for review · fixed the redirect")).toBe("checking");
    expect(at("Notes · Engram 1.0, project ada")).toBe("working");
    expect(at("")).toBe("working");
    // The running task decides, whatever else of the knight's waits or has ended.
    expect(avatarExpression(member, { tasks: [task("failed"), task("running", { progress: "Exit 0 · ok" }), task("queued")], deliveries: [delivery("running")] }, now)).toBe("reading");
    expect(taskStep("  Plan · indented")).toBe("thinking");
  });

  test("expression calculation reads only the step a task is at, never its words, and never mutates its inputs", () => {
    const privateText = () => { throw new Error("private text must not be inspected"); };
    const worker = Object.freeze({ ...member, get memory() { return privateText(); }, get instructions() { return privateText(); } });
    const job = Object.freeze({ ...task("running", { progress: "Exit 1 · sorry, everything failed and I am upset" }), get goal() { return privateText(); }, get output() { return privateText(); } });
    expect(avatarExpression(worker, { tasks: Object.freeze([job]), deliveries: Object.freeze([]) }, now)).toBe("reading");
    // Words that sound like a mood never become one: a line with no step's mark is just work, whatever it says.
    for (const words of ["I failed, sorry", "Great, all done and verified!", "Waiting for you", "Paused", "Exit · ok", "plan · lower case"]) {
      expect(avatarExpression(member, { tasks: [task("running", { progress: words })], deliveries: [] }, now)).toBe("working");
    }
  });
});

describe("a knight's orb", () => {
  test("its colour is one of the 24 tints, picked by its handle: the same every time, and spread round the circle", () => {
    expect(KNIGHT_TINTS).toHaveLength(24);
    expect(new Set(KNIGHT_TINTS).size).toBe(24);
    for (const tint of KNIGHT_TINTS) expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    const colors = knightColors("gareth");
    expect(knightColors("gareth")).toEqual(colors);
    expect(colors.tint).toBe(KNIGHT_TINTS[handleSeed("gareth") % 24]!);
    expect(colors.chosen).toBe(false);
    // Many handles reach every tint.
    expect(new Set(Array.from({ length: 400 }, (_, n) => knightColors(`knight-${n}`).tint))).toEqual(new Set(KNIGHT_TINTS));
  });

  test("a colour you chose is its tint; anything else colours nothing", () => {
    expect(knightColors("gareth", { v: 2, color: "#3ABEFF" })).toMatchObject({ tint: "#3abeff", chosen: true });
    expect(knightColors("gareth", { v: 2, color: "#123456" })).toMatchObject({ tint: "#123456", chosen: true });
    expect(knightColors("gareth", { v: 1, form: "round", color: "#be7153" })).toEqual(knightColors("gareth"));
    for (const odd of [null, "blue", { v: 2, color: "url(x)" }, { v: 2, color: "#3abeff", form: "round" }, { v: 3, color: "#3abeff" }]) expect(knightColors("gareth", odd)).toEqual(knightColors("gareth"));
  });

  test("lit and shadowed in whole channels, and a second colour three to six tints on from its own", () => {
    expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(blendHex("#3abeff", "#3abeff", 0.7)).toBe("#3abeff");
    const { tint, light, deep, second } = knightColors("ada", { v: 2, color: "#ff8d65" });
    expect(light).toBe(blendHex(tint, "#ffffff", 0.45));
    expect(deep).toBe(blendHex(tint, "#000000", 0.52));
    const steps = (KNIGHT_TINTS.indexOf(second as never) - nearestTint(tint) + 24) % 24;
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(steps).toBeLessThanOrEqual(6);
    expect(nearestTint("#ff8d65")).toBe(2);
    expect(nearestTint("#000000")).toBeGreaterThanOrEqual(0);
  });

  test("its seed is FNV-1a over the handle's UTF-16 code units", () => {
    expect(handleSeed("")).toBe(0x811c9dc5);
    expect(handleSeed("a")).toBe(0xe40c292c);
    expect(handleSeed("foobar")).toBe(0xbf9cf968);
  });

  test("a chosen colour is saved as exactly that, and nothing else is", () => {
    expect(AvatarProfileSchema.parse({ v: 2, color: "#3ABEFF" })).toEqual({ v: 2, color: "#3abeff" });
    const persona = { v: 1, form: "hooded", color: "#f9e9d9", accent: "#2fa36b", eyes: "oval", accessory: "none", temperament: "calm" };
    for (const odd of [{ v: 2, color: "blue" }, { v: 2, color: "#3abeff", accent: "#000000" }, { v: 2 }, persona]) expect(AvatarProfileSchema.safeParse(odd).success).toBe(false);
    expect(isOrbProfile({ v: 2, color: "#3abeff" })).toBe(true);
    expect(isOrbProfile(persona)).toBe(false);
  });
});
