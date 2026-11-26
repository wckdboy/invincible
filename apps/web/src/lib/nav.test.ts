import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyScope } from "../types.ts";
import { ALIASES, goToOf, hashOf, homeOf, keyedOf, landingOf, moreIndex, PLACES, placesFor, placesIndex, primaryOf, routeOf, taskOf } from "./nav.ts";

/* Every address the app had before it was a roster and More, with the scope each asked for (and Sandboxes'
 * second one): an address is a contract, and what a device may see follows its scopes as it did. */
const BEFORE: Record<string, [scope: AnyScope | null, alsoFor?: AnyScope]> = {
  overview: [null], inbox: [null], chat: ["chat"], team: ["chat"], projects: ["mind:read"], memory: ["mind:read"], skills: ["mind:read"],
  activity: ["mind:read"], loops: ["mind:read"], artifacts: ["mind:read"], archive: ["mind:read"], findings: ["mind:read"], trials: ["mind:read"],
  fleet: ["mind:read"], sandboxes: ["sandbox", "fleet:admin"], vault: ["vault:read"], models: ["mind:read"], bank: ["bank:read"],
  connectors: ["mind:read"], settings: [null],
};
/** Places added since, each for any device that may chat (More for any). */
const ADDED = ["more", "home", "task"];
const OWNER: AnyScope[] = ["chat", "mind:read", "mind:write", "vault:read", "vault:write", "brain:write", "fleet:admin", "bank:read", "sandbox"];
const device = (...scopes: AnyScope[]) => placesFor((scope) => scopes.includes(scope));
const ids = (places: readonly { id: string }[]) => places.map((place) => place.id);
const TASK = "task-abcdef012345";

describe("the app's places", () => {
  test("every address the app had still opens: a place, or a second name of one (#/work is Home's, #/roundtable the Roundtable's)", () => {
    expect(ids(PLACES).filter((id) => !ADDED.includes(id)).sort()).toEqual(Object.keys(BEFORE).sort());
    for (const id of ADDED.filter((id) => id !== "more")) expect([id, PLACES.find((place) => place.id === id)?.scope]).toEqual([id, "chat"]);
    expect(ALIASES).toEqual({ roundtable: "team", work: "home" });
    const all = device(...OWNER);
    for (const hash of ["#/work", "#/work?project=x", "#/home"]) expect([hash, routeOf(hash, all)]).toEqual([hash, "home"]);
  });

  test("what a device may see follows its scopes as it did", () => {
    const sets: AnyScope[][] = [OWNER, [], ["chat"], ["mind:read"], ["chat", "mind:read"], ["fleet:admin"], ["sandbox"], ["vault:read"], ["bank:read"], ["chat", "mind:read", "vault:read"]];
    for (const scopes of sets) {
      const before = Object.entries(BEFORE).filter(([, [scope, alsoFor]]) => scope === null || scopes.includes(scope) || (alsoFor !== undefined && scopes.includes(alsoFor))).map(([id]) => id);
      expect([scopes, ids(device(...scopes)).filter((id) => !ADDED.includes(id)).sort()]).toEqual([scopes, before.sort()]);
    }
  });

  test("Home comes first, then Galahad's own conversation, then the Roundtable", () => {
    expect(ids(primaryOf(device(...OWNER)))).toEqual(["home", "chat", "team"]);
    expect(primaryOf(device(...OWNER)).map((place) => place.label)).toEqual(["Home", "Galahad", "Roundtable"]);
  });

  test("#/roundtable is the Roundtable's address as well as #/team; nothing else has a second name but #/work", () => {
    const all = device(...OWNER);
    for (const hash of ["#/roundtable", "#/roundtable?room=forge", "#/team", "#/team?room=forge&tab=workspace"]) expect([hash, routeOf(hash, all)]).toEqual([hash, "team"]);
    expect(routeOf("#/fleet", all)).toBe("fleet");
    expect(routeOf("#/chat?c=cv_abc", all)).toBe("chat");
    for (const hash of ["", "#/", "#/nowhere", "#/roundtables", "#/works", "#pair=abc"]) expect([hash, routeOf(hash, all)]).toEqual([hash, null]);
    // A device that may not see the Roundtable (or Home) doesn't reach it by its other name either.
    expect(routeOf("#/roundtable", device("mind:read"))).toBeNull();
    expect(routeOf("#/work", device("mind:read"))).toBeNull();
  });

  test("a task has an address of its own, #/task/<id>, and the app settles on it as it is", () => {
    const all = device(...OWNER);
    expect(routeOf(`#/task/${TASK}`, all)).toBe("task");
    expect(routeOf("#/task", all)).toBe("task");
    expect(taskOf(`#/task/${TASK}`)).toBe(TASK);
    for (const hash of ["#/task", "#/task/", "#/task/nope", `#/task/${TASK}/x`, `#/task/${TASK}?x=1`, `#/team?task=${TASK}`, `#/task/TASK-ABCDEF012345`]) expect([hash, taskOf(hash)]).toEqual([hash, null]);
    expect(hashOf("task", { task: TASK })).toBe(`#/task/${TASK}`);
    expect(hashOf("task", { task: "../fleet" })).toBe("#/task");
    expect(hashOf("task")).toBe("#/task");
    expect(hashOf("team", { room: "forge", task: TASK })).toBe(`#/team?room=forge&task=${TASK}`);
    expect(hashOf("fleet")).toBe("#/fleet");
    expect(landingOf("task", `#/task/${TASK}`)).toBe(`#/task/${TASK}`);
    expect(landingOf("task", "#/task/nope")).toBe("#/task");
    expect(landingOf("team", "#/roundtable?room=forge&tab=work")).toBe("#/team?room=forge");
    expect(landingOf("home", "#/work")).toBe("#/home");
    expect(landingOf("chat", "#/chat?c=cv_abc")).toBe("#/chat");
  });

  test("everything else is reached from More, the Inbox first, each under exactly one heading", () => {
    const index = moreIndex(device(...OWNER));
    const listed = index.flatMap((group) => ids(group.places));
    expect(listed.sort()).toEqual(Object.keys(BEFORE).filter((id) => !["chat", "team"].includes(id)).sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(index[0]!.places[0]!.id).toBe("inbox");
    // A few plain headings, and each place says what's there in a line.
    expect(index.length).toBeGreaterThanOrEqual(3);
    expect(index.length).toBeLessThanOrEqual(5);
    for (const group of index) for (const place of group.places) expect([place.id, place.about.length > 8 && place.about.length <= 60]).toEqual([place.id, true]);
  });

  test("More lists only what this device may see, and a heading with nothing under it is left out", () => {
    const index = moreIndex(device("chat"));
    expect(index.flatMap((group) => ids(group.places)).sort()).toEqual(["inbox", "overview", "settings"]);
    expect(index.every((group) => group.places.length > 0)).toBe(true);
  });

  // Your words, 26 November 2026: "agent first (Galahad)"; on a phone, no tab bar: Home is Galahad.
  test("a phone opens on Home and a wide screen on Galahad's conversation; a device that may not chat opens on its Inbox", () => {
    expect(homeOf(device(...OWNER), { narrow: true })).toBe("home");
    expect(homeOf(device(...OWNER), { narrow: false })).toBe("chat");
    for (const narrow of [true, false]) {
      expect(homeOf(device("mind:read"), { narrow })).toBe("inbox");
      expect(homeOf(device(), { narrow })).toBe("inbox");
    }
  });

  test("an app installed on a Home Screen starts where the app opens: at no address of its own, so the shell takes it home", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../manifest.webmanifest"), "utf8")) as { start_url: string; shortcuts: { url: string }[] };
    expect(manifest.start_url).toBe("/");
    // Its shortcuts are addresses the app still has.
    for (const shortcut of manifest.shortcuts) expect([shortcut.url, routeOf(shortcut.url.replace(/^\//, ""), device(...OWNER))]).not.toEqual([shortcut.url, null]);
  });

  test("the index under “…” has every place but Home, Galahad and a task's thread: the Roundtable first, then More's headings", () => {
    const index = placesIndex(device(...OWNER));
    expect(index[0]).toEqual({ heading: null, places: PLACES.filter((place) => place.id === "team") });
    expect(index.slice(1)).toEqual(moreIndex(device(...OWNER)));
    const listed = index.flatMap((group) => ids(group.places));
    expect(new Set(listed).size).toBe(listed.length);
    // Nothing this device may see is out of reach: what isn't listed is a tap away anywhere (Home, Galahad), or a row's.
    expect(ids(device(...OWNER)).filter((id) => !listed.includes(id)).sort()).toEqual(["chat", "home", "more", "task"]);
    // A device that may only read sees only what it may open, and no Roundtable.
    expect(placesIndex(device("mind:read")).every((group) => group.heading !== null)).toBe(true);
  });

  test("every place has its own key after G, and none is G itself; a task's thread has none, and the palette doesn't offer it", () => {
    const keyed = keyedOf(PLACES as typeof PLACES & import("./nav.ts").Place[]);
    const keys = keyed.map((place) => place.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("g");
    expect(ids(PLACES.filter((place) => !keyed.includes(place)))).toEqual(["task"]);
    expect(ids(goToOf(device(...OWNER)))).not.toContain("task");
    expect(goToOf(device(...OWNER))).toHaveLength(device(...OWNER).length - 1);
    // The keys people already know still go where they went (Work's, J, to Home, where the work is now).
    const key = (id: string) => PLACES.find((place) => place.id === id)!.key;
    expect([key("overview"), key("inbox"), key("chat"), key("team"), key("fleet"), key("settings"), key("home")]).toEqual(["o", "i", "c", "h", "f", ",", "j"]);
  });
});
