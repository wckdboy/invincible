import { expect, test } from "bun:test";
import { READING_POSTS } from "../api.ts";
import { PLACES } from "./nav.ts";
import { PLACE_READS, readsFor } from "./prefetch.ts";

const all = PLACES.map((place) => place.id);

test("a place's first reads, and a room's conversation, asked for ahead of the tap", () => {
  expect(readsFor("#/loops", all)).toEqual(["/api/loops", "/api/self-action"]);
  expect(readsFor("#/overview", all)).toContainEqual({ post: "/api/doctor", body: { quick: true } });
  expect(readsFor("#/team?room=forge&tab=work", all)).toEqual([{ post: "/api/team/room", body: { id: "forge" } }]);
  expect(readsFor("#/roundtable?room=r_ada", all)).toEqual([{ post: "/api/team/room", body: { id: "r_ada" } }]);
  // A place with nothing to read ahead (its data is live already), and an address that isn't a place.
  expect(readsFor("#/inbox", all)).toEqual([]);
  expect(readsFor("#/nowhere", all)).toEqual([]);
});

test("never for a place this device may not see", () => {
  expect(readsFor("#/vault", all.filter((id) => id !== "vault"))).toEqual([]);
  expect(readsFor("#/team?room=forge", all.filter((id) => id !== "team"))).toEqual([]);
});

test("only reads, of places that exist: GETs of the API, and POSTs that change nothing", () => {
  for (const [place, reads] of Object.entries(PLACE_READS)) {
    expect(all).toContain(place as never);
    for (const read of reads!) {
      if (typeof read === "string") expect(read).toMatch(/^\/api\/[a-z/-]+$/);
      else expect([read.post, READING_POSTS.has(read.post)]).toEqual([read.post, true]);
    }
  }
});
