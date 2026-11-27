import { expect, test } from "bun:test";
import { routes } from "@invincible/core";
import { printRunEvent, withoutPictures } from "../src/run-cli.ts";

/*
 * A node's run asks its models through the node's chat route, which takes no pictures on a question: the reviewer's
 * pictures of the desktop (C1 step 8) go as their hashes, named in its question, each said where it would have gone.
 */

test("a run's question goes to the chat route without its pictures, each said where it would have gone; what is sent is what the route takes", () => {
  const picture = { mediaType: "image/png" as const, data: "cGljdHVyZQ==", alt: "The desktop before step 1." };
  const sent = withoutPictures([{ role: "user", content: "Judge it.", images: [picture, picture] }, { role: "user", content: "As it is." }]);
  expect(sent[0]).toEqual({ role: "user", content: "Judge it.\n\n(The 2 pictures named above can't go with this through the node's chat route: each is kept in the sandbox's /work/.evidence/desktop under its SHA-256.)" });
  expect(sent[1]).toEqual({ role: "user", content: "As it is." });
  expect(routes.chat.input.safeParse({ messages: sent, tools: false }).success).toBe(true);
  expect(routes.chat.input.safeParse({ messages: [{ role: "user", content: "Judge it.", images: [picture] }], tools: false }).success).toBe(false);
});

test("`invincible do` says a batch's pictures by its steps and their hashes' first characters, and where they are kept", () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  try {
    printRunEvent({ type: "pictured", first: 2, last: 4, before: "c".repeat(64), after: "d".repeat(64) });
  } finally {
    console.log = log;
  }
  expect(Bun.stripANSI(printed.join("\n"))).toBe(`  (the desktop pictured, steps 2–4: before ${"c".repeat(12)}…, after ${"d".repeat(12)}…; kept in /work/.evidence/desktop by SHA-256)`);
});
