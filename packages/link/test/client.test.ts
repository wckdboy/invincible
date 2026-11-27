import { describe, expect, test } from "bun:test";
import { newNodeIdentity, REQUESTS_NAME_THEIR_NODE_FROM, REQUESTS_READ, verifyRequestSignature } from "@invincible/core";
import { MAX_ANSWER_BYTES, peerOf, signedPost } from "../src/client.ts";

/*
 * What a node reads of a peer's answer over HTTP (the fallback, and every link before the fabric): as much as a sync page
 * or a forwarded route's answer can be, never more (the fabric's security review, L2). An answer past the bound is
 * refused as it comes, whether it says its length or not.
 */

const identity = newNodeIdentity();
const answering = (body: () => ReadableStream<Uint8Array> | string, headers: Record<string, string> = {}) => async () => new Response(body(), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** A stream of `total` bytes of a JSON string, made as it is read. */
function endless(total: number): ReadableStream<Uint8Array> {
  let sent = 0;
  const piece = new TextEncoder().encode("x".repeat(1 << 20));
  return new ReadableStream({
    pull(controller) {
      if (sent === 0) controller.enqueue(new TextEncoder().encode('"'));
      if (sent >= total) {
        controller.enqueue(new TextEncoder().encode('"'));
        controller.close();
        return;
      }
      controller.enqueue(piece);
      sent += piece.length;
    },
  });
}

/** The node it asks, by its id: what it signs names it. */
const PEER = newNodeIdentity().id;

describe("a peer's answer over HTTP", () => {
  test("an answer within the bound reads as it did", async () => {
    expect(await signedPost(identity, { id: PEER, endpoint: "http://198.51.100.7:7400" }, "/link/sync", { have: {} }, { fetch: answering(() => '{"events":[],"more":false}') })).toEqual({ events: [], more: false });
  });

  test("one that says it is past the bound is refused before it is read", async () => {
    const fetch = answering(() => endless(4 << 20), { "content-length": String(MAX_ANSWER_BYTES + 1) });
    await expect(signedPost(identity, { id: PEER, endpoint: "http://198.51.100.7:7400" }, "/link/sync", { have: {} }, { fetch })).rejects.toThrow(`past the ${MAX_ANSWER_BYTES} bytes this node reads`);
  });

  test("one that says nothing of its length and goes past the bound is refused as it comes", async () => {
    const fetch = answering(() => endless(MAX_ANSWER_BYTES + (8 << 20)));
    await expect(signedPost(identity, { id: PEER, endpoint: "http://198.51.100.7:7400" }, "/link/sync", { have: {} }, { fetch })).rejects.toThrow(`past the ${MAX_ANSWER_BYTES} bytes this node reads`);
  });
});

describe("what it signs for a peer", () => {
  test("names that peer: the peer takes it, another node refuses it (the slice 8 note's item 11)", async () => {
    const identity = newNodeIdentity();
    let seen: { headers: Headers; body: Uint8Array } | null = null;
    const fetch = (async (_url: string, init?: RequestInit) => {
      seen = { headers: new Headers(init!.headers as Record<string, string>), body: init!.body as Uint8Array };
      return new Response('{"events":[],"more":false}');
    }) as never;
    await signedPost(identity, { id: PEER, endpoint: "http://198.51.100.7:7400" }, "/link/sync", { have: {} }, { fetch });
    const { headers, body } = seen!;
    expect(verifyRequestSignature(headers, "POST", "/link/sync", body, Date.now(), PEER)?.named).toBe(true);
    expect(verifyRequestSignature(headers, "POST", "/link/sync", body, Date.now(), newNodeIdentity().id)).toBeNull();
  });
});

describe("a peer as it is asked", () => {
  test("named once its profile says it reads requests that name it; an older one as before, until the cutoff, then every one", () => {
    const at = "http://198.51.100.7:7400";
    const before = REQUESTS_NAME_THEIR_NODE_FROM - 1;
    expect(peerOf({ id: PEER, profile: { endpoint: at, caps: { requests: REQUESTS_READ } } }, at, before)).toEqual({ id: PEER, endpoint: at });
    expect(peerOf({ id: PEER, profile: { endpoint: at, caps: { cores: 8 } } }, at, before)).toEqual({ endpoint: at });
    expect(peerOf({ id: PEER, profile: { endpoint: at, caps: { cores: 8 } } }, at, REQUESTS_NAME_THEIR_NODE_FROM)).toEqual({ id: PEER, endpoint: at });
    expect(peerOf({ id: PEER, profile: null }, at, before)).toEqual({ endpoint: at });
  });

  test("an older peer is asked as before: what it signs names none, as that peer reads", async () => {
    const identity = newNodeIdentity();
    let seen: { headers: Headers; body: Uint8Array } | null = null;
    const fetch = (async (_url: string, init?: RequestInit) => {
      seen = { headers: new Headers(init!.headers as Record<string, string>), body: init!.body as Uint8Array };
      return new Response('{"events":[],"more":false}');
    }) as never;
    await signedPost(identity, { endpoint: "http://198.51.100.7:7400" }, "/link/sync", { have: {} }, { fetch });
    // (Read at a peer that still takes v1: one that names no node.)
    expect(verifyRequestSignature(seen!.headers, "POST", "/link/sync", seen!.body, Date.now(), PEER, true)?.named).toBe(false);
  });
});
