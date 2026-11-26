import { describe, expect, test } from "bun:test";
import { MAX_QUESTIONS, QuestionError, Questions } from "../src/questions.ts";

/* MCP servers' questions to you, mid-call: each holds its call until you answer, say no, or its time runs out. */

const TRACKER = { id: "tracker", label: "Tracker" };
const ASK = { message: "Which repository should the issue go in?", requestedSchema: { type: "object", properties: { repo: { type: "string", title: "Repository" }, urgent: { type: "boolean" } }, required: ["repo"] } };
const status = (work: () => unknown): number | string => {
  try {
    work();
    return "ok";
  } catch (error) {
    return error instanceof QuestionError ? error.status : String(error);
  }
};

describe("a server's question", () => {
  test("waits for you, shown as it asked; your answer, checked, goes back to the call", async () => {
    const changed: number[] = [];
    const questions = new Questions({ now: () => 1_000, changed: () => void changed.push(questions.list().length) });
    const call = questions.ask(TRACKER, ASK);
    const [q] = questions.list();
    expect(q).toMatchObject({ connector: "tracker", label: "Tracker", message: "Which repository should the issue go in?", askedAt: 1_000, expires: 301_000 });
    expect(q!.fields.map((f) => [f.name, f.kind, f.required])).toEqual([["repo", "text", true], ["urgent", "yes-no", false]]);
    expect(status(() => questions.answer(q!.id, true, { urgent: true }))).toBe(400);
    questions.answer(q!.id, true, { repo: "amiriteorg/galahad", urgent: true });
    expect(await call).toEqual({ action: "accept", content: { repo: "amiriteorg/galahad", urgent: true } });
    expect(questions.list()).toEqual([]);
    expect(changed).toEqual([1, 0]);
    expect(status(() => questions.answer(q!.id, false))).toBe(404);
  });

  test("your no goes back as one; no answer in time, and the call goes on without one", async () => {
    const questions = new Questions({ waitMs: 30 });
    const declined = questions.ask(TRACKER, ASK);
    questions.answer(questions.list()[0]!.id, false);
    expect(await declined).toEqual({ action: "decline" });
    expect(await questions.ask(TRACKER, ASK)).toEqual({ action: "cancel" });
    expect(questions.list()).toEqual([]);
  });

  test("one a server at a time, and a few in all; a form it can't hold, or words it didn't give, declined at once", async () => {
    const questions = new Questions();
    void questions.ask(TRACKER, ASK);
    expect(await questions.ask(TRACKER, ASK)).toEqual({ action: "decline" });
    for (let i = 1; i < MAX_QUESTIONS; i++) void questions.ask({ id: `s${i}`, label: `S${i}` }, ASK);
    expect(questions.list()).toHaveLength(MAX_QUESTIONS);
    expect(await questions.ask({ id: "one-more", label: "One more" }, ASK)).toEqual({ action: "decline" });
    const fresh = new Questions();
    expect(await fresh.ask(TRACKER, { message: "Card details?", requestedSchema: { type: "object", properties: { card: { type: "object" } } } })).toEqual({ action: "decline" });
    expect(await fresh.ask(TRACKER, { message: "", requestedSchema: ASK.requestedSchema })).toEqual({ action: "decline" });
    expect(fresh.list()).toEqual([]);
    questions.drain();
  });

  test("a key typed into a server's form never goes to it; a call that stops takes its question with it; a node stopping lets every call go on", async () => {
    const questions = new Questions();
    const call = questions.ask(TRACKER, ASK);
    const id = questions.list()[0]!.id;
    expect(status(() => questions.answer(id, true, { repo: ["sk", "proj", "A".repeat(40)].join("-") }))).toBe(422);
    const stop = new AbortController();
    const other = questions.ask({ id: "other", label: "Other" }, ASK, stop.signal);
    stop.abort();
    expect(await other).toEqual({ action: "cancel" });
    questions.drain();
    expect(await call).toEqual({ action: "cancel" });
    expect(questions.list()).toEqual([]);
  });
});
