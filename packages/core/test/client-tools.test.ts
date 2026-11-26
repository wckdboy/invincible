import { describe, expect, test } from "bun:test";
import { ChatMessage, routes } from "../src/index.ts";

/*
 * Tools the caller runs itself (a quest's engineer: its shell and its files): the chat route offers them to the model
 * and never runs one. An answer that calls them carries its calls (and what its provider needs back); the caller's next
 * message carries what they came to.
 */

const call = { id: "call_1", name: "read", input: { path: "a.ts" } };
const result = { id: "call_1", content: "1\tconst a = 1;" };
const tool = { name: "read", description: "Read a file.", inputSchema: { type: "object" } };
const asked = [{ role: "user" as const, content: "Fix it." }];

describe("the caller's own tools in the chat contract", () => {
  test("an answer may be calls alone, and the caller's message what they came to alone", () => {
    expect(ChatMessage.safeParse({ role: "assistant", content: "", calls: [call], carry: "{}" }).success).toBe(true);
    expect(ChatMessage.safeParse({ role: "user", content: "", results: [result] }).success).toBe(true);
    expect(ChatMessage.safeParse({ role: "assistant", content: "" }).success).toBe(false);
    expect(ChatMessage.safeParse({ role: "user", content: "" }).success).toBe(false);
  });

  test("only an answer calls tools, and only the caller's messages carry results", () => {
    expect(ChatMessage.safeParse({ role: "user", content: "x", calls: [call] }).success).toBe(false);
    expect(ChatMessage.safeParse({ role: "user", content: "x", carry: "{}" }).success).toBe(false);
    expect(ChatMessage.safeParse({ role: "assistant", content: "x", results: [result] }).success).toBe(false);
  });

  test("a call names a tool as tools are named, with its input an object", () => {
    expect(ChatMessage.safeParse({ role: "assistant", content: "", calls: [{ ...call, name: "Read File" }] }).success).toBe(false);
    expect(ChatMessage.safeParse({ role: "assistant", content: "", calls: [{ ...call, input: "a.ts" }] }).success).toBe(false);
    expect(ChatMessage.safeParse({ role: "assistant", content: "", calls: [{ ...call, extra: true }] }).success).toBe(false);
  });

  test("they go only without Galahad's own tools, and never in a kept chat", () => {
    const chat = routes.chat.input;
    expect(chat.safeParse({ messages: asked, tools: false, clientTools: [tool] }).success).toBe(true);
    expect(chat.safeParse({ messages: asked, clientTools: [tool] }).success).toBe(false);
    expect(chat.safeParse({ messages: asked, tools: true, clientTools: [tool] }).success).toBe(false);
    expect(chat.safeParse({ messages: asked, tools: false, clientTools: [tool], save: true }).success).toBe(false);
  });
});
