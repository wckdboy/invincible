import { redact, type TrialAnswer, type TrialRecord } from "@galahad/core";
import { parseVerdict, poseReview, reviewDomain, type ReviewerCase } from "@galahad/brain";
import type { TrialUnit } from "./trial-cli.ts";

/*
 * One case put to the reviewer: a quest's evidence with a known answer, asked in the
 * words a real quest uses, through the same door (the chat route, the reviewer role,
 * no tools). No sandbox is involved: the evidence is the case. The verdict is read as
 * a quest reads it, and a program compares it with what a careful reviewer says.
 */

const verdictAnswer = (right: boolean | null): TrialAnswer[] => [{ key: "verdict_right", units: "pass", expected: 1, got: right === null ? null : right ? 1 : 0, tolerance: 0, ok: right === true }];

export const reviewerUnit = (kase: ReviewerCase): TrialUnit => ({
  id: kase.id,
  title: kase.title,
  // The case's truth is its domain: the report reads the reviewer's two error rates from it.
  domain: reviewDomain(kase.truth),
  async attempt(node, job): Promise<TrialRecord | null> {
    const { question } = poseReview(kase, job.seed);
    const started = Date.now();
    const base = { run: job.run, suite: job.suite, problem: kase.id, title: kase.title, domain: reviewDomain(kase.truth), seed: job.seed, version: job.version };
    let model = "";
    try {
      let text = "";
      // Exactly a quest's review: the reviewer role (or the model this run holds it to), no tools, the evidence redacted as ever,
      // and coding work as a quest's is, so a model on a coding plan answers here as it would there.
      for await (const event of node.stream("chat", { role: "reviewer", messages: [{ role: "user", content: redact(question) }], tools: false, coding: true, ...(job.pins?.reviewer ? { model: job.pins.reviewer } : {}) })) {
        if (event.type === "text") text += event.text;
        else if (event.type === "model") model = event.ref;
        else if (event.type === "usage") job.spent?.({ role: "reviewer", model: event.ref, usage: event.usage });
        else if (event.type === "error") throw new Error(`the reviewer could not answer: ${event.error}`);
      }
      if (job.signal?.aborted) return null;
      // Anything that isn't a clear PASS sends the work back, here as in a quest.
      const said = parseVerdict(text).verdict;
      const right = said === kase.truth;
      return {
        ...base,
        status: "scored",
        score: right ? 1 : 0,
        answers: verdictAnswer(right),
        models: model ? [model] : [],
        seconds: Math.round((Date.now() - started) / 1000),
        note: `said ${said.toUpperCase()}; a careful reviewer says ${kase.truth.toUpperCase()}: ${kase.because}`.slice(0, 1000),
      };
    } catch (error) {
      if (job.signal?.aborted) return null;
      return {
        ...base,
        status: "crashed",
        score: 0,
        answers: verdictAnswer(null),
        models: model ? [model] : [],
        seconds: Math.round((Date.now() - started) / 1000),
        note: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      };
    }
  },
});
