import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { b64u, newNodeIdentity, type Scope } from "@invincible/core";
import { signedPost } from "@invincible/link";
import { doorPair, type DoorPair } from "./fabric-door.ts";

/*
 * The link's scopes hold over HTTP as over Q-AMP (the fabric re-review, I-e). Over Q-AMP each link tool needs its one
 * scope of its caller (FABRIC_SCOPES: a pull mind:read, a push mind:write); a limited node refused there was answered
 * "not over this path", and the sync engine went on over HTTP, where /link/sync and /link/push took any enrolled node.
 * Now HTTP asks the same scopes. Test keys only; loopback addresses only.
 */

setDefaultTimeout(60_000);

let p: DoorPair;

beforeAll(async () => {
  p = await doorPair("q5s-");
});

afterAll(async () => {
  await p?.stop();
});

/** A limited node enrolled on alpha with these scopes, and what alpha answers its signed pull and push over HTTP. */
async function limitedNode(scopes: Scope[]) {
  const node = newNodeIdentity();
  p.a.store.emit(p.a.identity, "device.enrolled", { device: node.id, name: `sensor-${scopes.length}`, kind: "node", role: "limited", box: b64u(node.boxPublic), scopes });
  const answer = (path: string, body: unknown) =>
    signedPost(node, { id: p.a.identity.id, endpoint: p.a.endpoint }, path, body).then(
      () => 200,
      (error: Error) => Number(/→ (\d{3})/.exec(error.message)?.[1] ?? 0),
    );
  return { sync: await answer("/link/sync", { have: {} }), push: await answer("/link/push", { events: [] }) };
}

describe("the link over HTTP, from a limited node", () => {
  test("one with neither scope pulls nothing and pushes nothing", async () => {
    expect(await limitedNode([])).toEqual({ sync: 403, push: 403 });
  });

  test("one that may read pulls, and may not push", async () => {
    expect(await limitedNode(["mind:read"])).toEqual({ sync: 200, push: 403 });
  });

  test("one that may read and write does both, as a full node does", async () => {
    expect(await limitedNode(["mind:read", "mind:write"])).toEqual({ sync: 200, push: 200 });
  });
});
