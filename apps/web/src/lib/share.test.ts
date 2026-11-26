import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isShare, readShare, SHARE_MAX, SHARE_PARAMS } from "./share.ts";

const query = (fields: Record<string, string>) => `?${new URLSearchParams(Object.entries(fields).map(([k, v]) => [SHARE_PARAMS[k as keyof typeof SHARE_PARAMS], v]))}`;

test("a page shared from a browser: its title and its link", () => {
  expect(readShare(query({ title: "Bun 2.0 is out", url: "https://bun.sh/blog/bun-v2" }))).toBe("Bun 2.0 is out\n\nhttps://bun.sh/blog/bun-v2");
});

test("text that already holds the link or the title has each once", () => {
  const text = "Worth reading: https://example.com/post";
  expect(readShare(query({ title: "A post", text, url: "https://example.com/post" }))).toBe(`A post\n\n${text}`);
  expect(readShare(query({ title: "Worth reading", text, url: "https://example.com/post" }))).toBe(text);
});

test("only a web link is a link; nothing shared is nothing", () => {
  expect(readShare(query({ text: "look", url: "javascript:alert(1)" }))).toBe("look");
  expect(readShare(query({ url: "file:///etc/passwd" }))).toBeNull();
  expect(readShare("")).toBeNull();
  expect(readShare(query({ title: "  ", text: "\n" }))).toBeNull();
});

test("what lands in the message box carries nothing hidden and is bounded", () => {
  const shared = readShare(query({ text: `pay‮evil​ now\r\nplease\u0007` }));
  expect(shared).toBe("payevil now\nplease");
  expect(readShare(query({ text: "x".repeat(SHARE_MAX + 50) }))!.length).toBe(SHARE_MAX);
});

test("an address is a share by its names alone, and nothing else is", () => {
  expect(isShare(query({ text: "hi" }))).toBe(true);
  expect(isShare("?code=1&state=2")).toBe(false);
  expect(isShare("")).toBe(false);
});

test("the manifest's share target opens the app with those names, by GET (nothing is posted to the node)", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../manifest.webmanifest"), "utf8"));
  expect(manifest.share_target).toEqual({ action: "/", method: "GET", params: { title: SHARE_PARAMS.title, text: SHARE_PARAMS.text, url: SHARE_PARAMS.url } });
});
