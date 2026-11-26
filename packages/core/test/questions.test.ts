import { describe, expect, test } from "bun:test";
import { checkAnswer, QUESTION_LIMITS, questionFields } from "../src/questions.ts";

/* An MCP server's question to you, mid-call (elicitation's form mode): what a server may ask for, and your answer checked. */

const SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", title: "Repository", description: "owner/name", maxLength: 100 },
    email: { type: "string", format: "email" },
    count: { type: "integer", minimum: 1, maximum: 10, default: 3 },
    private: { type: "boolean", title: "Private?", default: true },
    region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "United States"] },
    labels: { type: "array", items: { anyOf: [{ const: "bug", title: "Bug" }, { const: "docs", title: "Docs" }] }, maxItems: 2 },
  },
  required: ["repo", "region"],
};

describe("what a server may ask", () => {
  test("a text, an email, a whole number, a yes or no, one of a list, some of a list: each with its words and bounds", () => {
    const read = questionFields(SCHEMA);
    if (!read.ok) throw new Error(read.why);
    expect(read.fields).toEqual([
      { name: "repo", kind: "text", title: "Repository", description: "owner/name", required: true, format: null, minLength: null, maxLength: 100, default: null },
      { name: "email", kind: "text", title: "email", description: null, required: false, format: "email", minLength: null, maxLength: QUESTION_LIMITS.text, default: null },
      { name: "count", kind: "number", title: "count", description: null, required: false, integer: true, minimum: 1, maximum: 10, default: 3 },
      { name: "private", kind: "yes-no", title: "Private?", description: null, required: false, default: true },
      { name: "region", kind: "one", title: "region", description: null, required: true, options: [{ value: "eu", title: "Europe" }, { value: "us", title: "United States" }], default: null },
      { name: "labels", kind: "many", title: "labels", description: null, required: false, options: [{ value: "bug", title: "Bug" }, { value: "docs", title: "Docs" }], minItems: null, maxItems: 2, default: null },
    ]);
  });

  test("anything else is no question it can ask: no form, an empty one, too many fields, a nested object, an endless list", () => {
    expect(questionFields(null)).toEqual({ ok: false, why: "it asked for no form" });
    expect(questionFields({ type: "object", properties: {} })).toEqual({ ok: false, why: "it asked for nothing" });
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(questionFields({ type: "object", properties: many })).toEqual({ ok: false, why: "it asked for 13 fields (at most 12)" });
    expect(questionFields({ type: "object", properties: { card: { type: "object", properties: {} } } })).toEqual({ ok: false, why: `its field "card" isn't a text, a number, a yes or no, or a choice` });
    expect(questionFields({ type: "object", properties: { pick: { type: "string", enum: Array.from({ length: 30 }, (_, i) => `o${i}`) } } })).toEqual({ ok: false, why: 'its field "pick" offers no list a form can hold' });
  });

  test("its words come plain: nothing hidden, one line, bounded", () => {
    const read = questionFields({ type: "object", properties: { x: { type: "string", title: "Pick\u202e one\nnow", description: "d".repeat(500) } } });
    expect(read.ok && [read.fields[0]!.title, read.fields[0]!.description!.length]).toEqual(["Pick one now", QUESTION_LIMITS.description]);
  });
});

describe("your answer", () => {
  const fields = (() => {
    const read = questionFields(SCHEMA);
    if (!read.ok) throw new Error(read.why);
    return read.fields;
  })();

  test("what it asked for, each as its kind: a number typed as text is a number, a list chosen once each", () => {
    expect(checkAnswer(fields, { repo: " amiriteorg/galahad ", region: "eu", count: "4", private: false, labels: ["bug", "bug", "docs"] })).toEqual({ ok: true, content: { repo: "amiriteorg/galahad", region: "eu", count: 4, private: false, labels: ["bug", "docs"] } });
  });

  test("what's wrong is said by its field: needed, of another kind, out of bounds, not among its choices, not asked for", () => {
    expect(checkAnswer(fields, { region: "eu" })).toEqual({ ok: false, field: "repo", why: "it's needed" });
    expect(checkAnswer(fields, { repo: "a", region: "asia" })).toEqual({ ok: false, field: "region", why: "one of its choices is needed" });
    expect(checkAnswer(fields, { repo: "a", region: "eu", count: 11 })).toEqual({ ok: false, field: "count", why: "at most 10" });
    expect(checkAnswer(fields, { repo: "a", region: "eu", count: 2.5 })).toEqual({ ok: false, field: "count", why: "a whole number is needed" });
    expect(checkAnswer(fields, { repo: "a", region: "eu", email: "not an address" })).toEqual({ ok: false, field: "email", why: "an email address is needed" });
    expect(checkAnswer(fields, { repo: "a", region: "eu", private: "yes" })).toEqual({ ok: false, field: "private", why: "yes or no is needed" });
    expect(checkAnswer(fields, { repo: "a", region: "eu", password: "x" })).toEqual({ ok: false, field: "password", why: "it wasn't asked for" });
  });
});
