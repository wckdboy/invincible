import { readFileSync } from "node:fs";
import { type ChatMessage, chooseEyes, type ModelCheck } from "@galahad/core";
import type { ToolImage } from "./adapters.ts";
import { conversationFor } from "./responses.ts";
import { type BrainContext, chat } from "./chat.ts";
import { offersModel, onPlan, resolveProvider, whyNoKey } from "./providers.ts";
import { parseRef } from "./roster.ts";
import { parseAction, runQuest } from "./quest.ts";

/*
 * Checking what a model can do, before it is given work that needs it (core/model-checks.ts says what a check is):
 *
 * - the quest loop's format: the opening of two small quests, exactly as a quest's engineer is briefed, with a
 *   stand-in for the sandbox; counted are the replies that held a command (or said DONE or GIVE UP);
 * - reading a screen: a page drawn once by Chrome (assets/check-card), its largest heading asked for;
 * - placing a click: the centres of eight things on that page, asked for in its pixels, each judged by whether
 *   it lands inside the thing as the page itself measured it.
 *
 * About eight calls, a few thousand tokens. The picture is sent whatever is known of the model seeing: that is
 * what is checked. Each call's cost is counted, as role `check`.
 */

const here = (file: string) => new URL(`../assets/check-card/${file}`, import.meta.url);
const CARD = JSON.parse(readFileSync(here("card.json"), "utf8")) as {
  width: number;
  height: number;
  heading: string;
  targets: Record<string, { name: string; box: [number, number, number, number]; centre: [number, number] }>;
};
const PICTURE: ToolImage = { mediaType: "image/jpeg", data: readFileSync(here("card.jpg")).toString("base64"), alt: "A screenshot of a web page: the Harbour quarterly ledger, with a top bar, buttons, a search field and a table." };

/** The two small quests the format is checked on: what they ask is beside the point, only how he answers. */
const QUESTS = [
  "In /work, write count.ts exporting countWords(text): how many words a text has, split on runs of whitespace. Check it with bun.",
  "In /work, write a file named today.txt holding the word ledger, then show that it is there.",
];

export type CheckPart = "format" | "reads" | "places";

/**
 * A VM's eyes (core's chooseEyes): the first model named for the role that can be used there, yours to name; with none
 * named, the checked model that sees best among the ones he offers (providers.ts offersModel), so a check of a model
 * he doesn't offer never puts it on the role.
 */
export const eyesOf = (named: readonly string[], checks: readonly { ref: string; check: ModelCheck }[], usable: (ref: string) => boolean): string | null =>
  chooseEyes(named, checks.filter(({ ref }) => offersModel(ref)), usable);

/** Check a model (`provider/model`): every part, or those named. Throws only when the model can't be asked at all. */
export async function checkModel(ctx: BrainContext, ref: string, options: { version?: string; parts?: readonly CheckPart[]; signal?: AbortSignal } = {}): Promise<ModelCheck> {
  const parts = new Set<CheckPart>(options.parts?.length ? options.parts : ["format", "reads", "places"]);
  const { provider: providerId } = parseRef(ref);
  const provider = resolveProvider(ctx.store, ctx.vault, providerId, onPlan(ref) ? "coding" : "own");
  if (!provider) throw new Error(`provider "${providerId}" is not configured`);
  if (!provider.apiKey && !provider.local) throw new Error(whyNoKey(providerId, onPlan(ref) ? "coding" : "own"));
  const check: ModelCheck = { at: Date.now(), ...(options.version ? { version: options.version } : {}) };
  const errors: string[] = [];
  if (parts.has("format")) {
    try {
      check.format = await checkFormat(ctx, ref, options.signal);
    } catch (error) {
      errors.push(`format: ${String((error as Error).message ?? error).slice(0, 240)}`);
    }
  }
  if (parts.has("reads")) {
    try {
      const said = (await withPicture(ctx, ref, "This is a screenshot of a web page. What are the words of its largest heading? Reply with those words only.", options.signal)).trim().split("\n")[0]!.trim();
      check.reads = { ok: plainWords(said) === plainWords(CARD.heading), said: said.slice(0, 200) };
    } catch (error) {
      errors.push(`reads: ${String((error as Error).message ?? error).slice(0, 240)}`);
    }
  }
  if (parts.has("places")) {
    try {
      const asked = Object.entries(CARD.targets).map(([id, t]) => `${id}: ${t.name}`).join("\n");
      const said = await withPicture(
        ctx,
        ref,
        `This is a screenshot of a web page, ${CARD.width} pixels wide and ${CARD.height} high: x runs right from 0 and y runs down from 0. Give the pixel coordinates of the centre of each of these:\n${asked}\nReply with only a JSON object that maps each name before the colon to [x, y].`,
        options.signal,
      );
      check.places = judgePlaces(said);
    } catch (error) {
      errors.push(`places: ${String((error as Error).message ?? error).slice(0, 240)}`);
    }
  }
  if (errors.length) check.errors = errors;
  return check;
}

/** Words as words: case, punctuation and spacing aside. */
const plainWords = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Each answered place judged against its target: does a click there land inside it (four pixels' grace), and how far off is it. */
function judgePlaces(said: string): NonNullable<ModelCheck["places"]> {
  const from = said.indexOf("{");
  const to = said.lastIndexOf("}");
  let answered: Record<string, unknown> = {};
  try {
    answered = from >= 0 && to > from ? (JSON.parse(said.slice(from, to + 1)) as Record<string, unknown>) : {};
  } catch {
    // (Not JSON: nothing answered.)
  }
  const targets = Object.entries(CARD.targets);
  let landed = 0;
  const errors: number[] = [];
  for (const [id, target] of targets) {
    const point = answered[id];
    if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const [x, y] = point as [number, number];
    const [left, top, right, bottom] = target.box;
    if (x >= left - 4 && x <= right + 4 && y >= top - 4 && y <= bottom + 4) landed++;
    errors.push(Math.hypot(x - target.centre[0], y - target.centre[1]));
  }
  return { targets: targets.length, landed, meanErrorPx: errors.length ? Math.round(errors.reduce((a, b) => a + b, 0) / errors.length) : null };
}

/** One question with the test screen as its picture, sent whether or not the model is known to see; its answer, whole. */
async function withPicture(ctx: BrainContext, ref: string, question: string, signal?: AbortSignal): Promise<string> {
  const { provider: providerId, model } = parseRef(ref);
  const provider = resolveProvider(ctx.store, ctx.vault, providerId, onPlan(ref) ? "coding" : "own")!;
  const conversation = conversationFor({
    provider,
    model,
    system: "You read screenshots exactly, and answer only what is asked.",
    messages: [{ role: "user", content: question }],
    effort: "low",
    images: [PICTURE],
    sees: true,
    ...(signal ? { signal } : {}),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  let text = "";
  try {
    const turn = conversation.turn([], signal);
    for (let next = await turn.next(); !next.done; next = await turn.next()) text += next.value;
  } finally {
    const usage = conversation.spent?.();
    if (usage !== undefined) ctx.spent?.({ role: "check", ref, usage });
  }
  if (!text.trim()) throw new Error("it said nothing");
  return text;
}

/** The opening of two small quests, as a quest's engineer is briefed: how many of its replies held a command. */
async function checkFormat(given: BrainContext, ref: string, signal?: AbortSignal): Promise<{ replies: number; good: number }> {
  // (What it costs is the check's, not an engineer's.)
  const ctx: BrainContext = { ...given, spent: (call) => given.spent?.({ ...call, role: "check" }) };
  let replies = 0;
  let good = 0;
  for (const goal of QUESTS) {
    const stop = new AbortController();
    const ended = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    let failure: Error | null = null;
    await runQuest(
      { goal, environment: "A Linux sandbox; your workspace is /work. Bun and Python are installed.", plan: "1. Write the file.\n2. Show that it works.\nDone when: running it shows the right result.", maxSteps: 3, maxRevisions: 0, commandTimeoutSec: 60 },
      {
        ask: async (role, messages: ChatMessage[]) => {
          // Only the engineer is checked: a DONE is accepted without asking anyone.
          if (role !== "engineer") return { text: "PASS\nAccepted.", model: "check" };
          let text = "";
          for await (const event of chat(ctx, { model: ref, role: "engineer", coding: true, messages, signal: ended })) {
            if (event.type === "text") text += event.text;
            else if (event.type === "error" || event.type === "fallback") {
              failure = new Error(event.type === "error" ? event.error : `${event.from}: ${event.error}`);
              stop.abort();
              throw failure;
            }
          }
          replies++;
          if (parseAction(text).kind !== "invalid") good++;
          return { text, model: ref };
        },
        exec: async (command) => ({ exitCode: 0, stdout: command.includes("cat") || command.includes("ls") ? "count.ts  today.txt\n" : "ok\n", stderr: "", durationMs: 4, truncated: false }),
        signal: ended,
        sleep: async () => {},
      },
    ).catch((error: unknown) => {
      failure ??= error as Error;
    });
    if (failure) throw failure;
  }
  return { replies, good };
}
