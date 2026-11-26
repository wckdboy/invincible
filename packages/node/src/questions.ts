import { checkAnswer, findSecrets, plainLine, QUESTION_LIMITS, type QuestionAnswer, questionFields, type QuestionField, type QuestionView, randomId } from "@galahad/core";

/*
 * MCP servers' questions to you, mid-call (PLAN #49; core's questions.ts): the call waits while its question waits in
 * your Inbox, and goes on with your answer, your no, or, past its time, without one. They live as long as their calls
 * do, in this node's memory: a call doesn't outlive a restart, and neither does its question. Nothing answers one but
 * you (answerQuestion, fleet:admin): never a model, never an agent.
 */

/** How long a question waits for you before its call goes on without an answer. */
export const QUESTION_WAIT_MS = 5 * 60_000;
/** At most this many wait at once, and one a server: a server can't fill your Inbox with them. */
export const MAX_QUESTIONS = 5;

export type QuestionResult = { action: "accept"; content: QuestionAnswer } | { action: "decline" | "cancel" };

export class QuestionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Waiting {
  view: QuestionView;
  done: (result: QuestionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Questions {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly o: { now?: () => number; waitMs?: number; log?: (line: string) => void; changed?: () => void } = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** What waits for you, oldest first. */
  list(): QuestionView[] {
    return [...this.waiting.values()].map((w) => w.view);
  }

  /**
   * A server's question, in the middle of a call of one of its tools: shown in your Inbox, and its call held until you
   * answer, say no, or its time runs out. One that can't be shown (a form too big, a field of another kind) is declined
   * at once; so is one asked while that server's last waits, or while too many do.
   */
  ask(connector: { id: string; label: string }, params: { message?: unknown; requestedSchema?: unknown }, signal?: AbortSignal): Promise<QuestionResult> {
    const read = questionFields(params.requestedSchema);
    const message = typeof params.message === "string" ? plainLine(params.message).slice(0, QUESTION_LIMITS.message) : "";
    if (!read.ok || !message) {
      this.o.log?.(`questions: ${connector.id}'s declined: ${read.ok ? "it asked nothing in words" : read.why}`);
      return Promise.resolve({ action: "decline" });
    }
    if (this.list().some((q) => q.connector === connector.id) || this.waiting.size >= MAX_QUESTIONS) return Promise.resolve({ action: "decline" });
    const id = `qn_${randomId(12)}`;
    const askedAt = this.now();
    const view: QuestionView = { id, connector: connector.id, label: plainLine(connector.label).slice(0, 80) || connector.id, message, fields: read.fields, askedAt, expires: askedAt + (this.o.waitMs ?? QUESTION_WAIT_MS) };
    return new Promise<QuestionResult>((resolve) => {
      const finish = (result: QuestionResult) => {
        const was = this.waiting.get(id);
        if (!was) return;
        clearTimeout(was.timer);
        this.waiting.delete(id);
        signal?.removeEventListener("abort", stopped);
        this.o.changed?.();
        resolve(result);
      };
      // (The call stopped first: its question goes with it.)
      const stopped = () => finish({ action: "cancel" });
      signal?.addEventListener("abort", stopped, { once: true });
      const timer = setTimeout(() => finish({ action: "cancel" }), this.o.waitMs ?? QUESTION_WAIT_MS);
      this.waiting.set(id, { view, done: finish, timer });
      this.o.changed?.();
    });
  }

  /** Your answer: checked against what was asked, then sent back to the call that waits. */
  answer(id: string, accept: boolean, content: Record<string, unknown> = {}): QuestionView {
    const waiting = this.waiting.get(id);
    if (!waiting) throw new QuestionError(404, "no such question waits (it was answered, its time ran out, or its call ended)");
    if (!accept) {
      waiting.done({ action: "decline" });
      return waiting.view;
    }
    const checked = checkAnswer(waiting.view.fields, content);
    if (!checked.ok) throw new QuestionError(400, `${fieldTitle(waiting.view.fields, checked.field)}: ${checked.why}`);
    // A key never goes to a server's form, whatever it asked: it belongs in the vault.
    const secret = Object.values(checked.content).flat().find((v) => typeof v === "string" && findSecrets(v).length);
    if (secret !== undefined) throw new QuestionError(422, "That looks like a key or a password: it never goes to a server's form. Keys belong in the vault.");
    waiting.done({ action: "accept", content: checked.content });
    return waiting.view;
  }

  /** The node is stopping: every call that waits goes on without an answer. */
  drain(): void {
    for (const w of [...this.waiting.values()]) w.done({ action: "cancel" });
  }
}

const fieldTitle = (fields: readonly QuestionField[], name: string): string => fields.find((f) => f.name === name)?.title ?? name;
