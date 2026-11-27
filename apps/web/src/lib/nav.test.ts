import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyScope } from "../types.ts";
import { rank } from "./fuzzy.ts";
import { ALIASES, goToOf, hashOf, homeOf, keyedOf, landingOf, moreIndex, PLACES, placesFor, placesIndex, primaryOf, routeOf, taskOf } from "./nav.ts";

/* Every address the app had before it was a roster and More, with the scope each asked for (and Sandboxes'
 * second one): an address is a contract, and what a device may see follows its scopes as it did. */
const BEFORE: Record<string, [scope: AnyScope | null, alsoFor?: AnyScope]> = {
  overview: [null], inbox: [null], chat: ["chat"], team: ["chat"], projects: ["mind:read"], memory: ["mind:read"], skills: ["mind:read"],
  activity: ["mind:read"], loops: ["mind:read"], artifacts: ["mind:read"], archive: ["mind:read"], findings: ["mind:read"], evals: ["mind:read"],
  fleet: ["mind:read"], sandboxes: ["sandbox", "fleet:admin"], vault: ["vault:read"], models: ["mind:read"], seats: ["mind:read"],
  connectors: ["mind:read"], settings: [null],
};
/** Places added since, each for any device that may chat (More for any). */
const ADDED = ["more", "home", "task"];
const OWNER: AnyScope[] = ["chat", "mind:read", "mind:write", "vault:read", "vault:write", "brain:write", "fleet:admin", "sandbox"];
const device = (...scopes: AnyScope[]) => placesFor((scope) => scopes.includes(scope));
const ids = (places: readonly { id: string }[]) => places.map((place) => place.id);
const TASK = "task-abcdef012345";

describe("the app's places", () => {
  test("every address the app had still opens: a place, or a second name of one (#/work is Home's, #/agents the agents')", () => {
    expect(ids(PLACES).filter((id) => !ADDED.includes(id)).sort()).toEqual(Object.keys(BEFORE).sort());
    for (const id of ADDED.filter((id) => id !== "more")) expect([id, PLACES.find((place) => place.id === id)?.scope]).toEqual([id, "chat"]);
    expect(ALIASES).toEqual({ agents: "team", work: "home" });
    const all = device(...OWNER);
    for (const hash of ["#/work", "#/work?project=x", "#/home"]) expect([hash, routeOf(hash, all)]).toEqual([hash, "home"]);
  });

  test("what a device may see follows its scopes as it did", () => {
    const sets: AnyScope[][] = [OWNER, [], ["chat"], ["mind:read"], ["chat", "mind:read"], ["fleet:admin"], ["sandbox"], ["vault:read"], ["chat", "mind:read", "vault:read"]];
    for (const scopes of sets) {
      const before = Object.entries(BEFORE).filter(([, [scope, alsoFor]]) => scope === null || scopes.includes(scope) || (alsoFor !== undefined && scopes.includes(alsoFor))).map(([id]) => id);
      expect([scopes, ids(device(...scopes)).filter((id) => !ADDED.includes(id)).sort()]).toEqual([scopes, before.sort()]);
    }
  });

  test("your agent's own conversation comes first, then the work (Home's address, called Work), then the agents", () => {
    expect(ids(primaryOf(device(...OWNER)))).toEqual(["chat", "home", "team"]);
    expect(primaryOf(device(...OWNER)).map((place) => place.label)).toEqual(["Your agent", "Work", "Agents"]);
  });

  test("#/agents is the agents' address as well as #/team; nothing else has a second name but #/work", () => {
    const all = device(...OWNER);
    for (const hash of ["#/agents", "#/agents?room=forge", "#/team", "#/team?room=forge&tab=workspace"]) expect([hash, routeOf(hash, all)]).toEqual([hash, "team"]);
    expect(routeOf("#/fleet", all)).toBe("fleet");
    expect(routeOf("#/chat?c=cv_abc", all)).toBe("chat");
    for (const hash of ["", "#/", "#/nowhere", "#/agentss", "#/works", "#pair=abc"]) expect([hash, routeOf(hash, all)]).toEqual([hash, null]);
    // A device that may not see the agents (or Home) doesn't reach it by its other name either.
    expect(routeOf("#/agents", device("mind:read"))).toBeNull();
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
    expect(landingOf("team", "#/agents?room=forge&tab=work")).toBe("#/team?room=forge");
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

  // Your words, 26 November 2026: "agent first ([the primary])"; on a phone, no tab bar: Home is the primary. And I11: at
  // desktop width the drawer's places are a sidebar that stays open, with Home beside it.
  test("an approval has an address of its own, kept when the app opens at it: its card first in the Inbox", () => {
    const id = "a_0123456789abcdefghijkl";
    expect(hashOf("inbox", { approval: id })).toBe(`#/inbox?a=${id}`);
    expect(hashOf("inbox", { approval: "<script>" })).toBe("#/inbox");
    expect(landingOf("inbox", `#/inbox?a=${id}`)).toBe(`#/inbox?a=${id}`);
    expect(landingOf("inbox", "#/inbox?a=nope")).toBe("#/inbox");
    expect(routeOf(`#/inbox?a=${id}`, PLACES as never)).toBe("inbox");
  });

  // The owner's word, 27 November 2026: "something like t3code on desktop, and openmausbot/grokbot on mobile": the app opens
  // on your agent's conversation, as T3 Code opens on a thread, with the roster beside it (or a swipe away on a phone).
  test("a phone and a wide screen both open on your agent's conversation; a device that may not chat opens on its Inbox", () => {
    expect(homeOf(device(...OWNER), { narrow: true })).toBe("chat");
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

  test("the index under “…” has every place but Home, your agent and a task's thread: the agents first, then More's headings", () => {
    const index = placesIndex(device(...OWNER));
    expect(index[0]).toEqual({ heading: null, places: PLACES.filter((place) => place.id === "team") });
    expect(index.slice(1)).toEqual(moreIndex(device(...OWNER)));
    const listed = index.flatMap((group) => ids(group.places));
    expect(new Set(listed).size).toBe(listed.length);
    // Nothing this device may see is out of reach: what isn't listed is a tap away anywhere (Home, the primary), or a row's.
    expect(ids(device(...OWNER)).filter((id) => !listed.includes(id)).sort()).toEqual(["chat", "home", "more", "task"]);
    // A device that may only read sees only what it may open, and no Agents.
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

  test("Needs you was the Inbox until 27 November 2026: the palette's “inbox” still finds it first, by any device", () => {
    // (As the shell's palette offers the places: each by its label and its keywords.)
    const found = (query: string, ...scopes: AnyScope[]) => rank(query, goToOf(device(...scopes)).map((place) => ({ id: place.id, label: place.label, keywords: [...place.keywords] })))[0]?.item.id;
    expect(PLACES.find((place) => place.id === "inbox")!.label).toBe("Needs you");
    for (const query of ["inbox", "Inbox", "needs you"]) {
      expect(found(query, ...OWNER)).toBe("inbox");
      expect(found(query)).toBe("inbox");
    }
  });
});
