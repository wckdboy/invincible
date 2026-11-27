import { expect, test } from "bun:test";
import { routes } from "@invincible/core";
import { pictureName, printRunEvent, sendable } from "../src/run-cli.ts";

/*
 * A node's run asks its models through the node's chat route, which takes no picture inline on a question: the
 * reviewer's pictures of the desktop (C1 step 8) go as files the node keeps by their SHA-256, as yours do, and the node
 * takes those from its owner alone. Where it doesn't, the question names each by its hash, saying why and where it is.
 */

const hash = "e".repeat(16);
const pictures = (["before", "after"] as const).map((at, i) => ({ mediaType: "image/png" as const, data: Buffer.from(`picture ${i + 1}`).toString("base64"), alt: `The desktop ${at} step 1 (SHA-256 ${hash}…).` }));

test("a run's question takes its pictures as files the node keeps by their SHA-256, in order; each upload and what is sent are what the routes take", async () => {
  const uploaded: unknown[] = [];
  const sent = await sendable([{ role: "user", content: "Judge it.", images: pictures }, { role: "user", content: "As it is." }], async (picture) => {
    const bytes = Buffer.from(picture.data, "base64");
    const upload = { name: pictureName(picture), type: picture.mediaType, data: picture.data };
    uploaded.push(upload);
    return { id: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), name: upload.name, type: upload.type, bytes: bytes.length };
  });
  expect(uploaded.map((u) => (u as { name: string }).name)).toEqual([`The desktop before step 1 (SHA-256 ${hash}…).png`, `The desktop after step 1 (SHA-256 ${hash}…).png`]);
  for (const upload of uploaded) expect(routes.uploadAttachment.input.safeParse(upload).success).toBe(true);
  const sha = (n: number) => new Bun.CryptoHasher("sha256").update(`picture ${n}`).digest("hex");
  expect(sent[0]).toEqual({
    role: "user",
    content: "Judge it.",
    attachments: [
      { id: sha(1), name: `The desktop before step 1 (SHA-256 ${hash}…).png`, type: "image/png", bytes: 9 },
      { id: sha(2), name: `The desktop after step 1 (SHA-256 ${hash}…).png`, type: "image/png", bytes: 9 },
    ],
  });
  expect(sent[1]).toEqual({ role: "user", content: "As it is." });
  expect(routes.chat.input.safeParse({ messages: sent, tools: false }).success).toBe(true);
  // (Never a picture inline on a message: the route refuses one.)
  expect(routes.chat.input.safeParse({ messages: [{ role: "user", content: "Judge it.", images: [pictures[0]] }], tools: false }).success).toBe(false);
});

test("where the node doesn't take them (another's token: only its owner attaches files), the question names each by its hash, saying why and where it is kept", async () => {
  const sent = await sendable([{ role: "user", content: "Judge it.", images: pictures }], async () => {
    throw new Error("403: only you attach files to a message");
  });
  expect(sent[0]).toEqual({ role: "user", content: "Judge it.\n\n(The 2 pictures named above didn't go with this (the node: 403: only you attach files to a message): each is kept in the sandbox's /work/.evidence/desktop under its SHA-256.)" });
  expect(routes.chat.input.safeParse({ messages: sent, tools: false }).success).toBe(true);
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
