import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@invincible/core";
import { MAX_ANSWER_BYTES, signedPost } from "../src/client.ts";

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

describe("a peer's answer over HTTP", () => {
  test("an answer within the bound reads as it did", async () => {
    expect(await signedPost(identity, "http://198.51.100.7:7400", "/link/sync", { have: {} }, { fetch: answering(() => '{"events":[],"more":false}') })).toEqual({ events: [], more: false });
  });

  test("one that says it is past the bound is refused before it is read", async () => {
    const fetch = answering(() => endless(4 << 20), { "content-length": String(MAX_ANSWER_BYTES + 1) });
    await expect(signedPost(identity, "http://198.51.100.7:7400", "/link/sync", { have: {} }, { fetch })).rejects.toThrow(`past the ${MAX_ANSWER_BYTES} bytes this node reads`);
  });

  test("one that says nothing of its length and goes past the bound is refused as it comes", async () => {
    const fetch = answering(() => endless(MAX_ANSWER_BYTES + (8 << 20)));
    await expect(signedPost(identity, "http://198.51.100.7:7400", "/link/sync", { have: {} }, { fetch })).rejects.toThrow(`past the ${MAX_ANSWER_BYTES} bytes this node reads`);
  });
});
