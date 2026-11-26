import { describe, expect, test } from "bun:test";
import { AVATAR_ACCESSORIES, AVATAR_EYES, AVATAR_FORMS, AVATAR_LOOKS, AVATAR_PALETTES, AVATAR_TEMPERAMENTS, avatarExpression, avatarLook, blendHex, defaultAvatar, handleSeed, isAvatarProfile, isOrbProfile, KNIGHT_TINTS, knightColors, lookProfile, matchingAccent, nearestTint, resolveAvatar, taskStep, withBodyColor, type AvatarActivity } from "../src/avatar.ts";
import { AvatarProfileSchema } from "../src/team.ts";

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const luminance = (hex: string) => channels(hex).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const hue = (hex: string) => {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b), spread = max - Math.min(r, g, b);
  return !spread ? 0 : ((max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4) * 60 + 360) % 360;
};
const hueApart = (a: string, b: string) => Math.min(Math.abs(hue(a) - hue(b)), 360 - Math.abs(hue(a) - hue(b)));

/** What Ada wears when nobody has chosen for her: pinned, so a change to how defaults are seeded is seen. */
const ADA_DEFAULT = { v: 1, form: "hooded", color: "#4f8fe0", accent: "#f0e8d6", eyes: "oval", accessory: "crown", temperament: "curious" } as const;

describe("knight appearance", () => {
  test("unconfigured identities have stable, distinct, valid defaults across reads", () => {
    const ada = ADA_DEFAULT;
    expect(defaultAvatar("ada")).toEqual(ada);
    expect(defaultAvatar("lin")).not.toEqual(ada);
    expect(resolveAvatar("ada")).toEqual(ada);
    expect(resolveAvatar("ada", null)).toEqual(ada);
    const changed = defaultAvatar("ada"); changed.color = "#000000";
    expect(defaultAvatar("ada")).toEqual(ada);
    for (const id of ["ada", "lin", "grace", "worker-with-a-long-name", "owner"]) expect(AvatarProfileSchema.safeParse(defaultAvatar(id)).success).toBe(true);
  });

  test("seeded defaults and presets are one set of tinctures: each knight's accent a different tincture from its armour, both plain to see", () => {
    expect(AVATAR_PALETTES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(AVATAR_PALETTES.map((palette) => palette.name)).size).toBe(AVATAR_PALETTES.length);
    const page = "#0a0a0b";
    for (const { color, accent } of AVATAR_PALETTES) {
      // A plume or a crown must stand apart from the body it sits on: round the hue circle, or clearly lighter or darker.
      expect(hueApart(color, accent) >= 30 || contrast(color, accent) >= 1.8).toBe(true);
      // Both are drawn on deep tiles and the app's dark page: neither may sink into them.
      expect(contrast(color, page)).toBeGreaterThanOrEqual(5);
      expect(contrast(accent, page)).toBeGreaterThanOrEqual(3);
    }
    // Two knights given different presets never look alike: their bodies are apart in hue or in lightness.
    for (const [i, a] of AVATAR_PALETTES.entries()) for (const b of AVATAR_PALETTES.slice(i + 1)) expect(hueApart(a.color, b.color) >= 18 || contrast(a.color, b.color) >= 1.4).toBe(true);
    const seeded = Array.from({ length: 400 }, (_, n) => defaultAvatar(`worker-${n}`));
    for (const { color, accent } of seeded) expect(AVATAR_PALETTES.some((palette) => palette.color === color && palette.accent === accent)).toBe(true);
    expect(new Set(seeded.map((avatar) => avatar.color)).size).toBe(AVATAR_PALETTES.length);
    // Every form, eyes, accessory and temperament turns up among the defaults.
    expect(new Set(seeded.map((avatar) => avatar.form))).toEqual(new Set(AVATAR_FORMS));
    expect(new Set(seeded.map((avatar) => avatar.eyes))).toEqual(new Set(AVATAR_EYES));
    expect(new Set(seeded.map((avatar) => avatar.accessory))).toEqual(new Set(AVATAR_ACCESSORIES));
    expect(new Set(seeded.map((avatar) => avatar.temperament))).toEqual(new Set(AVATAR_TEMPERAMENTS));
  });

  test("every look a profile can name is one the node keeps and the app draws, unchanged", () => {
    const base = defaultAvatar("ada");
    for (const form of AVATAR_FORMS) for (const eyes of AVATAR_EYES) for (const accessory of AVATAR_ACCESSORIES) for (const temperament of AVATAR_TEMPERAMENTS) {
      const profile = { ...base, form, eyes, accessory, temperament };
      expect(AvatarProfileSchema.safeParse(profile).success).toBe(true);
      expect(resolveAvatar("ada", profile)).toEqual(profile);
    }
  });

  test("a new armor color brings a matching accent, never the old one from another hue", () => {
    // The pairing that looked wrong: sky-blue armor still wearing the sand palette's brown.
    const sand = { ...defaultAvatar("ada"), color: "#e8c8a5", accent: matchingAccent("#e8c8a5") };
    const blue = withBodyColor(sand, "#AED4ED");
    expect(blue.color).toBe("#aed4ed");
    expect(hueApart(blue.color, blue.accent)).toBeLessThanOrEqual(20);
    expect({ ...blue, color: sand.color, accent: sand.accent }).toEqual(sand);
    // A preset's armor color brings the preset's own accent.
    expect(withBodyColor(sand, AVATAR_PALETTES[1]!.color).accent).toBe(AVATAR_PALETTES[1]!.accent);
    // An accent chosen apart from the armor is the owner's choice, and stays.
    const chosen = { ...sand, accent: "#3355aa" };
    expect(withBodyColor(chosen, "#aed4ed").accent).toBe("#3355aa");
    // An accent that had followed the armor keeps following it.
    expect(withBodyColor(blue, "#f0b0c0").accent).toBe(matchingAccent("#f0b0c0"));
    for (const color of ["#aed4ed", "#f2bb8f", "#3d6fd6", "#d94f4f", "#2e7d5b", "#fafafa", "#808080", "#080808", "#000000", "#ffffff"]) {
      const accent = matchingAccent(color);
      expect(accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(matchingAccent(color.toUpperCase())).toBe(accent);
      expect(contrast(color, accent)).toBeGreaterThanOrEqual(1.5);
      const [r, g, b] = channels(color);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 0.1) expect(hueApart(color, accent)).toBeLessThanOrEqual(20);
    }
  });

  test("untrusted snapshots cannot supply arbitrary SVG paint or appearance properties", () => {
    const valid = defaultAvatar("lin");
    expect(resolveAvatar("ada", valid)).toEqual(valid);
    expect(resolveAvatar("ada", { ...valid, color: "#AABBCC" }).color).toBe("#aabbcc");
    for (const value of [undefined, null, "image.svg", [], {}, { ...valid, v: 2 }, { ...valid, form: "orb" },
      { ...valid, eyes: "<script>" }, { ...valid, accessory: "antenna" }, { ...valid, temperament: "angry" },
      { ...valid, color: "url(https://example.invalid/paint)" }, { ...valid, accent: "#fff;opacity:0" },
      { ...valid, src: "https://example.invalid/image.svg" }]) expect(resolveAvatar("ada", value)).toEqual(defaultAvatar("ada"));
    expect(resolveAvatar("ada", valid)).not.toBe(valid);
  });

  test("the ten looks are the owner's ten drawings, each named by a colour of its own that a saved profile keeps", () => {
    expect(AVATAR_LOOKS.map((look) => look.id)).toEqual(["kay", "gaheris", "percival", "palamedes", "gawain", "tristan", "lancelot", "bedivere", "bors", "gareth"]);
    expect(new Set(AVATAR_LOOKS.map((look) => look.color)).size).toBe(AVATAR_LOOKS.length);
    for (const look of AVATAR_LOOKS) {
      const profile = lookProfile(look.id, "lively");
      expect(AvatarProfileSchema.safeParse(profile).success).toBe(true);
      expect(isAvatarProfile(profile)).toBe(true);
      expect(profile).toMatchObject({ color: look.color, form: look.form, temperament: "lively" });
      // A profile saved for a look is that look, whatever the knight is called.
      expect(avatarLook("ada", "Ada", profile)).toBe(look.id);
      expect(avatarLook("gareth", "Gareth", profile)).toBe(look.id);
    }
  });

  test("a knight nobody chose a look for wears the drawing named for it, else one of the ten, the same on every read", () => {
    // Named for a drawing: that one, from its first name, whatever profile the node seeded.
    expect(avatarLook("gareth", "Gareth", defaultAvatar("gareth"))).toBe("gareth");
    expect(avatarLook("k-1", "kay the seneschal", undefined)).toBe("kay");
    expect(avatarLook("percy", "PERCIVAL", null)).toBe("percival");
    // An older profile that names no look: the drawing nearest its colour.
    expect(avatarLook("ada", "Ada", { ...defaultAvatar("ada"), color: "#d9a43c" })).toBe("gareth");
    expect(avatarLook("ada", "Ada", { ...defaultAvatar("ada"), color: "#c9713b" })).toBe("bors");
    expect(avatarLook("ada", "Ada", { ...defaultAvatar("ada"), color: "#4f8fe0" })).toBe("lancelot");
    // Nothing at all: one of the ten from the handle alone, stable and spread across all ten.
    expect(avatarLook("worker-7", "Worker", undefined)).toBe(avatarLook("worker-7", "Someone else", "not a profile"));
    expect(new Set(Array.from({ length: 300 }, (_, n) => avatarLook(`worker-${n}`, "Worker", undefined)))).toEqual(new Set(AVATAR_LOOKS.map((look) => look.id)));
    // Galahad's own drawing, and the Black Knight's, are no knight's to wear.
    expect(AVATAR_LOOKS.map((look) => look.id)).not.toContain("galahad");
    expect(avatarLook("ada", "Galahad", undefined)).not.toBe("galahad");
  });

  test("whether a profile is one as saved is the same test resolveAvatar trusts", () => {
    const valid = defaultAvatar("lin");
    expect(isAvatarProfile(valid)).toBe(true);
    for (const value of [undefined, null, "x", [], {}, { ...valid, v: 2 }, { ...valid, form: "orb" }, { ...valid, color: "red" }, { ...valid, extra: 1 }]) {
      expect(isAvatarProfile(value)).toBe(false);
      expect(resolveAvatar("ada", value)).toEqual(defaultAvatar("ada"));
    }
  });

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

  test("a colour you chose is its tint; a look from the drawings colours nothing", () => {
    expect(knightColors("gareth", { v: 2, color: "#3ABEFF" })).toMatchObject({ tint: "#3abeff", chosen: true });
    expect(knightColors("gareth", { v: 2, color: "#123456" })).toMatchObject({ tint: "#123456", chosen: true });
    expect(knightColors("gareth", lookProfile("bors"))).toEqual(knightColors("gareth"));
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

  test("a chosen colour is saved as exactly that, and a look from before the orbs is still taken", () => {
    expect(AvatarProfileSchema.parse({ v: 2, color: "#3ABEFF" })).toEqual({ v: 2, color: "#3abeff" });
    expect(AvatarProfileSchema.safeParse(lookProfile("kay")).success).toBe(true);
    for (const odd of [{ v: 2, color: "blue" }, { v: 2, color: "#3abeff", accent: "#000000" }, { v: 2 }]) expect(AvatarProfileSchema.safeParse(odd).success).toBe(false);
    expect(isOrbProfile({ v: 2, color: "#3abeff" })).toBe(true);
    expect(isOrbProfile(lookProfile("kay"))).toBe(false);
  });
});
