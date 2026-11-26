import { canonical, type ChatMessage, type ChatStreamEvent, type Json, priceFor, type Prices, pricesOf, redact, type Usage } from "@galahad/core";
import type { MindStore, Vault } from "@galahad/mind";
import { type ModelMessage, RefusalError, refusalWords, type ToolCall, type ToolImage, type ToolSpec, ToolsUnsupportedError, type TurnEnd } from "./adapters.ts";
import { conversationFor } from "./responses.ts";
import { rotated } from "./effort.ts";
import { isEmbeddingModel } from "./embeddings.ts";
import { GALAHAD_SYSTEM, runtimeContext, SHOW_GUIDE, TOOL_GUIDE } from "./persona.ts";
import { windowScope, windowsOf } from "./windows.ts";
import { refusedKeysOf } from "./refused-keys.ts";
import { followsFormat, readModelCheck, readsScreens, type ModelCheck } from "@galahad/core";
import { offeredModels, onPlan, planOf, providerRecords, QUIET_MS, quietly, resolveProvider, whyNoKey } from "./providers.ts";
import { effortFor, parseRef, pinnedEffort, roleModels, sameModel } from "./roster.ts";

export interface BrainContext {
  store: MindStore;
  vault: Vault;
  fetch?: typeof fetch;
  /** How long a model's call may send nothing before it is ended as failed (providers.ts QUIET_MS; tests pass less). */
  quietMs?: number;
  /**
   * Told of every model call as it ends: the role, the model, and its tokens as the provider reported them
   * (null: it reported nothing). Counts only. Whoever holds the context keeps its own tally with it.
   */
  spent?(call: { role: string; ref: string; usage: Usage | null }): void;
}

export interface ChatRequest {
  role?: string;
  model?: string;
  /** These models, in order, in place of the role's (a knight's own: its work runs on them). `model` comes first. */
  models?: string[];
  /** What was said, and the pictures that go with a message (yours, attached in your chat). */
  messages: ModelMessage[];
  /** Appended after the stable persona (keeps the cacheable prefix intact). */
  context?: string;
  signal?: AbortSignal;
  /** What the model may call while it answers, and how each call runs. */
  tools?: ChatTools;
  /**
   * Tools the caller runs itself (a quest's engineer: its shell and its files): offered to the model, never run here.
   * An answer that calls them ends with a `calls` event (and what the provider needs back to go on: its `carry`).
   */
  clientTools?: ToolSpec[];
  /** Start the role's models at this position (effort: each parallel attempt takes another one first). */
  rotate?: number;
  /**
   * This answer is coding work: a quest's planner, engineer or reviewer, a knight at its work. A coding plan's
   * models may give it (providers.ts); any other answer of his passes them over.
   */
  coding?: boolean;
  /**
   * This answer spends a budget of yours (a task's, an outcome's): only a model whose spend it can count may give it
   * (countable). Any other is passed over, saying why: counted as nothing, it would spend past the budget unseen.
   */
  budgeted?: boolean;
  /**
   * A turn of a quest's work loop (a command a reply), whichever role's models answer it: the engineer's, or the
   * planner's once a gate has failed twice in a row. Held to the loop's format checks as the engineer's turns are.
   */
  loop?: boolean;
  /**
   * The model this answer is to be independent of (a review, usually): the role's candidates that are the same
   * model as this are asked last, keeping their order, after every other. None is dropped, so a role with nothing
   * else still answers.
   */
  apart?: string;
  /** Messages the owner sends while this answer is under way: each reaches the model at the next safe point. */
  steering?: Steering;
}

/**
 * Steering: what the owner says while an answer is under way. Whoever owns the turn offers
 * each message; `chat()` takes them at the next safe point (a model call is ended cleanly;
 * a running tool finishes and reports first; tools not yet started aren't run) and goes on
 * with them, as with any message of the owner's. When the answer ends with nothing waiting
 * it accepts no more: a message after that belongs to a new turn.
 */
export class Steering {
  private pending: string[] = [];
  private closed = false;
  private readonly listeners = new Set<() => void>();

  /** The owner's message for the answer under way. False once the answer has ended: send it as a new message. */
  offer(text: string): boolean {
    if (this.closed) return false;
    this.pending.push(text);
    for (const listener of [...this.listeners]) listener();
    return true;
  }

  /** How many messages wait to be handed over. */
  get waiting(): number {
    return this.pending.length;
  }

  /** Everything waiting, in the order it came. */
  take(): string[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }

  /** The answer has come to its end: what arrived in time is taken (and the answer goes on); nothing waiting, and it's over. */
  finish(): string[] {
    const late = this.take();
    if (!late.length) this.closed = true;
    return late;
  }

  /** The answer ended some other way (an error, a stop): no more is accepted, and what never reached him is handed back. */
  close(): string[] {
    this.closed = true;
    return this.take();
  }

  /** Told when a message arrives. Returns how to stop listening. */
  onArrive(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/** What a tool that hadn't started is answered with when a message from the owner arrived first. */
const NOT_RUN = {
  content: "Not run: a new message from your liege arrived before this call started. Read it first; call the tool again only if it is still wanted.",
  isError: true,
  summary: "not run: your new message came first",
} as const;

/** The same call, with the same input, that said the same this many times in one answer isn't run again: it won't change. */
export const SAME_ANSWER_LIMIT = 2;
const sameAgain = (name: string) => ({
  content: `Not run: ${name} was called with this same input ${SAME_ANSWER_LIMIT} times in this answer and said the same each time, so it won't say anything new now. Answer with what you have, or try something different.`,
  isError: true,
  summary: "not run: it said the same twice",
});

/**
 * Tools for one answer. The specs stay the same for the whole answer (the provider
 * caches them, and a history naming tools it no longer sees can be refused); `run`
 * decides each call, so it can refuse one (checked input, scopes, what's already in
 * the conversation). `run` never throws: a failure is an outcome.
 */
export interface ChatTools {
  specs: ToolSpec[];
  /** The tool's title and a short, safe summary of the arguments, for the user's view. */
  describe(call: ToolCall): { title: string; input: string };
  /** A result may carry pictures: models that see get them, the rest their descriptions. */
  run(call: ToolCall, signal?: AbortSignal): Promise<{ content: string; isError?: boolean; summary: string; images?: ToolImage[] }>;
  /**
   * Whether running this call only looks (it changes nothing, so a model that takes an answer over may run
   * it again). Absent, or false: it may change something, and is never run twice for one answer.
   */
  readOnly?(call: ToolCall): boolean;
}

/** Tool rounds per answer; past it every call is refused, and then the answer ends. */
export const MAX_TOOL_ROUNDS = 12;

/** How many times an answer cut off by the model's output limit is continued. */
export const MAX_CONTINUATIONS = 3;

/**
 * How many times one model call is asked again when its provider's filter ended it before it said or asked
 * for anything. Such filters aren't steady (the same conversation passes the next time more often than not),
 * and asking again loses nothing: what he'd said and done stays, and no tool is run twice.
 */
export const MAX_REFUSAL_RETRIES = 2;

/** What a model was seen to do when it was last checked (core/model-checks.ts); null: never checked. */
export const checkOf = (store: MindStore, ref: string): ModelCheck | null => readModelCheck(store.lww(`modelcheck:${ref}`)?.value);

/**
 * Whether a budget can count what this model spends: you've set a price for it (or for its provider), or it runs on
 * this machine, where it costs nothing. A budget counts any other as nothing, so work with one passes it over.
 */
export function countable(store: MindStore, vault: Vault, ref: string, prices: Prices = pricesOf(store)): boolean {
  if (priceFor(prices, ref)) return true;
  const slash = ref.indexOf("/");
  return slash > 0 && resolveProvider(store, vault, ref.slice(0, slash))?.local === true;
}

/** Expand `<provider>/*` wildcards into the first model that provider serves on this node. */
async function expand(ctx: BrainContext, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const { provider, model } = parseRef(ref);
    if (model !== "*") {
      out.push(ref);
      continue;
    }
    // A coding plan isn't asked what it serves (that is no coding): the first model its preset names.
    const plan = planOf(provider);
    if (plan) {
      out.push(`${provider}/${plan.models[0]}`);
      continue;
    }
    const resolved = resolveProvider(ctx.store, ctx.vault, provider);
    if (!resolved) continue;
    try {
      // An embedding model can't chat: a local runtime serving the archive's embedder isn't picked for a chat role.
      const first = (await offeredModels(resolved, ctx.fetch)).find((m) => !isEmbeddingModel(m));
      if (first) out.push(`${provider}/${first}`);
    } catch {
      /* local runtime not running on this node */
    }
  }
  return out;
}

/**
 * Stream a reply, walking the role's roster: if a model fails *before* producing
 * anything (no key, outage, rate limit, refusal) the next one takes over. With
 * tools, the model may call them in rounds before it answers; once text has
 * streamed or a tool has run, a failure ends the answer instead (another model
 * would start over and might repeat what was done). One exception: a model that
 * declines for good after it has only looked (no tool that changes anything has
 * run) hands the answer to the next one, which starts it again from your message.
 */
export async function* chat(ctx: BrainContext, req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
  const asked = req.model ? [req.model] : req.models?.length ? [...req.models] : roleModels(ctx.store, req.role ?? "planner");
  // A coding plan's key is for coding (providers.ts): his coding work uses it, and the knights' coding tools through
  // the gateway. For any other answer its models are passed over without a word, unless they were all there was.
  const own = req.coding ? asked : asked.filter((ref) => !onPlan(ref));
  if (!own.length && asked.length) {
    yield { type: "error", error: `${asked.join(", ")} ${asked.length === 1 ? "is" : "are"} on a coding plan, whose key is for coding: his quests and the knights' work use it, and he doesn't answer you with it. ${req.model ? "Name" : "Give this role"} a model with a key of its own.` };
    return;
  }
  const listed = req.model ? own : await expand(ctx, own);
  // A parallel attempt starts at another of the role's models; the rest stay its fallbacks, in order.
  let candidates = req.rotate ? rotated(listed, req.rotate) : listed;
  // Asked to be independent of a model (`apart`, a review usually): its candidates that are the same model are
  // asked last, keeping their order, after every other; none is dropped, so a role with nothing else still answers.
  const apartFrom = req.apart;
  if (apartFrom) candidates = [...candidates.filter((ref) => !sameModel(ref, apartFrom)), ...candidates.filter((ref) => sameModel(ref, apartFrom))];
  const tools = req.tools?.specs.length ? req.tools : undefined;
  const steering = req.steering;
  // Every message handed over so far: a model that takes over (or starts again without tools) is handed them too.
  const handed: string[][] = [];
  /** A tool that may change something has run for this answer: from then on no other model takes it over. */
  let changed = false;
  /** He has said something in this answer (whichever model said it). */
  let wrote = false;
  /** Why the model that had begun this answer declined, when another was asked to take it over. */
  let declined: string | null = null;
  /** Another model has taken the answer over after words were said: its first words are a paragraph of their own. */
  let apart = false;
  /** Why each model that was asked couldn't answer, for the error if none could (a plan's spent window says when it resets). */
  const whyNot: string[] = [];
  /** The providers passed over because they aren't set up here, and how many models that was: when it was all, one thing to say. */
  const unset = new Set<string>();
  let unsetRefs = 0;
  const passOver = (ref: string, error: string): ChatStreamEvent => {
    whyNot.push(`${ref}: ${error.replace(/\s+/g, " ").slice(0, 240)}`);
    return { type: "fallback", from: ref, error };
  };
  // A turn of the quest loop (the engineer's, or another role's doing the work: coding, no tools, the role's own models):
  // a model that was checked and doesn't follow its format (one command a reply) is passed over while another can take
  // the turn (checks.ts; evidence, not a label).
  const loopTurn = !!req.coding && (req.loop || (req.role ?? "planner") === "engineer") && !tools && !req.clientTools && !req.model;
  const offFormat = (ref: string) => (loopTurn ? checkOf(ctx.store, ref) : null);
  const someoneFits = candidates.some((ref) => followsFormat(offFormat(ref)) !== false);
  // Your prices, read once for an answer that spends a budget of yours (countable).
  const prices = req.budgeted ? pricesOf(ctx.store) : null;
  // How hard it thinks: the level you pinned its role to, whatever its messages say; else what they say, step by step
  // (a quest's loop says each turn's: roster.ts STEP_EFFORT), and the role's own for one that says nothing.
  const pinned = pinnedEffort(ctx.store, req.role ?? "planner");
  const messages = pinned ? req.messages.map(({ effort: _, ...m }) => m) : req.messages;
  for (const ref of candidates) {
    const off = offFormat(ref);
    if (someoneFits && off?.format && followsFormat(off) === false) {
      yield passOver(ref, `it doesn't follow the quest loop's command format (commands in ${off.format.good} of ${off.format.replies} replies when it was checked): passed over for this loop`);
      continue;
    }
    // Stable persona first (cacheable), then the model it runs on; the memories recalled for this question follow it,
    // after the part a provider keeps in its cache (adapters.ts).
    // What he can show beyond words is for answers you read in the app, not a quest's commands.
    const system = [GALAHAD_SYSTEM, tools ? TOOL_GUIDE : null, req.coding ? null : SHOW_GUIDE, runtimeContext(ref)].filter(Boolean).join("\n\n");
    let parsed: { provider: string; model: string };
    try {
      parsed = parseRef(ref);
    } catch (error) {
      yield passOver(ref, (error as Error).message);
      continue;
    }
    // Its allowance spent until a time its provider gave (windows.ts): not asked again until then.
    const spentWindow = windowsOf(ctx.store).spentFor(ref);
    if (spentWindow) {
      yield passOver(ref, windowsOf(ctx.store).why(spentWindow));
      continue;
    }
    const provider = resolveProvider(ctx.store, ctx.vault, parsed.provider, req.coding ? "coding" : "own");
    if (!provider) {
      unset.add(parsed.provider);
      unsetRefs += 1;
      yield passOver(ref, `provider "${parsed.provider}" is not configured`);
      continue;
    }
    if (!provider.apiKey && !provider.local) {
      yield passOver(ref, whyNoKey(parsed.provider, req.coding ? "coding" : "own"));
      continue;
    }
    if (prices && !provider.local && !priceFor(prices, ref)) {
      yield passOver(ref, `you've set no price for it, so a budget can't count what it spends: work with a budget passes it over (galahad price set ${ref} <$ per million in> <$ per million out>)`);
      continue;
    }
    // Whether it reads pictures, where a check has said: then that, not the rule of thumb (adapters.ts seesImages).
    const sees = readsScreens(checkOf(ctx.store, ref));
    const start = () => {
      const fresh = conversationFor({
        provider,
        model: parsed.model,
        ...(sees === null ? {} : { sees }),
        system,
        ...(req.context ? { context: req.context } : {}),
        messages,
        effort: pinned ?? effortFor(req.role),
        signal: req.signal,
        // A call that goes silent is ended as a failed one (QUIET_MS): no turn hangs on a provider that stopped sending.
        fetch: quietly(ctx.fetch ?? fetch, ctx.quietMs ?? (provider.local ? QUIET_MS.local : QUIET_MS.remote)),
      });
      for (const texts of handed) fresh.interject(texts, "");
      return fresh;
    };
    let conversation = start();
    let offered = tools?.specs ?? req.clientTools ?? [];
    let emitted = false;
    try {
      yield { type: "model", ref };
      let spoke = false;
      let resumed = false;
      let continued = 0;
      let refused = 0;
      // Each call (its tool and input) and what it said last, with how many times it said that, in this answer.
      const repeats = new Map<string, { content: string; times: number }>();
      // The owner's message(s) reach him: the turn goes on with them, as with a new message of theirs.
      const handOver = function* (texts: string[], partial: string | null): Generator<ChatStreamEvent> {
        conversation.interject(texts, partial);
        handed.push(texts);
        for (const text of texts) yield { type: "steer", text };
        // What follows answers a new message: its own paragraphs, its own continuations, its own calls ("look again").
        spoke = resumed = false;
        continued = 0;
        repeats.clear();
      };
      // What the model call that just ended cost, as its provider said (a call that never reached a model: nothing).
      const tally = function* (): Generator<ChatStreamEvent> {
        const usage = conversation.spent?.();
        if (usage === undefined) return;
        ctx.spent?.({ role: req.role ?? "planner", ref, usage });
        yield { type: "usage", ref, usage };
      };
      for (let round = 0; ; round++) {
        // A message that came while a tool ran (or before he began): he's told before the next model call.
        const waiting = steering?.take() ?? [];
        if (waiting.length) {
          yield* handOver(waiting, null);
          round = 0;
        }
        let end: TurnEnd;
        // A message arriving ends this one model call cleanly; the turn's own signal still ends everything.
        const cut = new AbortController();
        const deaf = steering?.onArrive(() => cut.abort());
        let said = "";
        try {
          const turn = conversation.turn(offered, steering ? (req.signal ? AbortSignal.any([req.signal, cut.signal]) : cut.signal) : undefined);
          let next = await turn.next();
          for (; !next.done; next = await turn.next()) {
            // Text after a round of tools starts a new paragraph.
            if (resumed || apart) yield { type: "text", text: "\n\n" };
            resumed = apart = false;
            emitted = spoke = wrote = true;
            said += next.value;
            yield { type: "text", text: next.value };
          }
          end = next.value;
          // A call that got through means the key works: a refusal of it (from an earlier call) is forgotten.
          refusedKeysOf(ctx.store).forget(parsed.provider);
        } catch (error) {
          // A call that failed after it reached the model still cost something: it's counted (as unknown, if nothing said).
          yield* tally();
          // Cut short for the owner's message (not a stop): what he'd said stays said, and the turn goes on with it.
          const arrived = cut.signal.aborted && !req.signal?.aborted ? (steering?.take() ?? []) : [];
          if (arrived.length) {
            yield* handOver(arrived, said);
            round = -1;
            continue;
          }
          // Declined before this call came to anything: the same call, again (see MAX_REFUSAL_RETRIES).
          if (error instanceof RefusalError && !said && refused < MAX_REFUSAL_RETRIES && !req.signal?.aborted) {
            refused++;
            round--;
            continue;
          }
          // A runtime that can't take tools (some local models): the same model, without them. (Not for the caller's own:
          // an answer without them would be no turn of its work, so the next model is asked.)
          if (error instanceof ToolsUnsupportedError && !emitted && !req.clientTools) {
            conversation = start();
            offered = [];
            round = -1;
            continue;
          }
          throw error;
        } finally {
          deaf?.();
        }
        yield* tally();
        refused = 0;
        // A call to a tool when none was offered (a review, an audit; a runtime that takes none) is never run: the answer
        // is its words, and a reply with only such calls has none. (22 November 2026: a knight's audit on Ultra failed
        // twice so, "undefined is not an object (evaluating 'tools.describe')", and was asked again a minute later.)
        const unoffered = offered.length ? [] : end.calls;
        const calls: ToolCall[] = offered.length ? end.calls : [];
        if (!calls.length) {
          // Cut off by the model's output limit: it goes on where it stopped, in the same answer.
          if (end.truncated && continued < MAX_CONTINUATIONS) {
            continued++;
            conversation.resume();
            round--;
            continue;
          }
          if (end.truncated) yield { type: "text", text: "\n\n*(This answer reached the model's length limit. Ask me to go on.)*" };
          // A message that arrived as he finished is answered in this turn, after the whole answer. None: it's over.
          const late = steering?.finish() ?? [];
          if (late.length) {
            yield* handOver(late, null);
            round = -1;
            continue;
          }
          // An answer with no words in it is not an answer: it failed, and says how the provider ended it.
          if (!spoke) {
            if (unoffered.length) throw new Error(`${ref} asked for a tool (${[...new Set(unoffered.map((c) => c.name))].join(", ")}) when it was offered none, and said nothing`);
            throw new Error(`${ref} ended its answer without saying anything${end.detail ? ` (${end.detail})` : ""}`);
          }
          break;
        }
        // The caller's own tools: the answer ends here, with its calls, for the caller to run (and what to carry back).
        if (req.clientTools && !tools) {
          const carry = conversation.carry?.();
          yield { type: "calls", calls: calls.map((c) => ({ id: c.id, name: c.name, input: c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {} })), ...(carry ? { carry } : {}) };
          yield { type: "done", ref };
          return;
        }
        if (round > MAX_TOOL_ROUNDS) throw new Error(`stopped after ${MAX_TOOL_ROUNDS} rounds of tools without an answer`);
        emitted = true;
        const outcomes = [];
        for (const call of calls) {
          const { title, input } = tools!.describe(call);
          yield { type: "tool", id: call.id, name: call.name, title, input };
          // A tool that is running always finishes and reports. One that hasn't started when a message
          // arrives isn't run: every call still gets its outcome, and this one's says why.
          const runs = !steering?.waiting && round < MAX_TOOL_ROUNDS;
          if (runs && !tools!.readOnly?.(call)) changed = true;
          const asked = `${call.name}\n${canonical((call.input ?? null) as Json)}`;
          const before = repeats.get(asked);
          const outcome = steering?.waiting
            ? NOT_RUN
            : round >= MAX_TOOL_ROUNDS
              ? { content: `No more tools for this answer (${MAX_TOOL_ROUNDS} rounds). Answer with what you have.`, isError: true, summary: "no more tools for this answer" }
              : before && before.times >= SAME_ANSWER_LIMIT
                ? sameAgain(call.name)
                : await tools!.run(call, req.signal);
          if (outcome !== NOT_RUN && !(before && before.times >= SAME_ANSWER_LIMIT) && round < MAX_TOOL_ROUNDS) {
            repeats.set(asked, before && before.content === outcome.content ? { content: outcome.content, times: before.times + 1 } : { content: outcome.content, times: 1 });
          }
          yield { type: "tool_result", id: call.id, name: call.name, ok: !outcome.isError, summary: outcome.summary };
          outcomes.push({ id: call.id, content: outcome.content, ...(outcome.isError ? { isError: true } : {}), ...("images" in outcome && outcome.images?.length ? { images: outcome.images } : {}) });
        }
        conversation.answer(outcomes);
        resumed = spoke;
      }
      yield { type: "done", ref };
      return;
    } catch (error) {
      // Some providers echo the credential in error text; never let it reach a client.
      const message = redact(String((error as Error).message ?? error), [provider.apiKey]).slice(0, 500);
      // Declined for good, and all he had done was look: the next model takes the answer over from your message.
      const handsOver = error instanceof RefusalError && emitted && !changed && !req.signal?.aborted;
      if ((emitted && !handsOver) || req.signal?.aborted) {
        yield { type: "error", error: message };
        return;
      }
      if (handsOver) {
        declined = message;
        apart = wrote;
      }
      // A refusal that says its allowance is spent, and until when, is remembered: the next ask passes it over (its plan's
      // every model, or this model alone: windowScope).
      windowsOf(ctx.store).note(windowScope(ref), message);
      // A provider that refused its key (401/403) is remembered too, for the doctor and the Inbox to say: a later call
      // that gets through forgets it. A local runtime has no key to refuse (its 401 is said of it, not remembered here).
      if (!provider.local) refusedKeysOf(ctx.store).note(parsed.provider, message);
      // (Said in the provider's own words: a status and a JSON body read as its message.)
      yield passOver(ref, refusalWords(message, 500));
    }
  }
  // A node with no provider set up at all (a fresh one): what to do, said once.
  if (!declined && unsetRefs === candidates.length && candidates.length && !providerRecords(ctx.store).length) {
    yield { type: "error", error: `no model can answer yet: none of ${[...unset].join(", ")} is set up here. Add a key for one of them (galahad key add), or hire a model you have a key for (galahad roster set <role> <provider/model>)` };
    return;
  }
  // (Each model's own reason goes with it: "no model could answer" alone doesn't say whether to add a key or wait an hour.)
  const reasons = whyNot.length ? ` (${whyNot.join("; ").slice(0, 700)})` : "";
  yield { type: "error", error: declined ? `${declined}. No other model in the roster could take the answer over.` : `no model in the roster could answer; add a key or adjust the roster${reasons}` };
}
