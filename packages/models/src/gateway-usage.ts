import type { Usage } from "@invincible/core";
import { anthropicUsage, openAIUsage } from "./adapters.ts";

/*
 * What a coding tool's call through the gateway cost, read from the provider's own answer as the gateway forwards it:
 * the events of a stream (OpenAI's chat completions, OpenAI's Responses, Anthropic's messages) or one JSON body. The
 * bytes are never changed or held back, only read; what is kept of them is bounded (a line, a body), so a long answer
 * can't grow it. A call whose answer says nothing of its tokens is a call with unknown usage, never an estimate.
 */

/** A line longer than this is no usage event: it is passed over. */
const MAX_LINE = 1 << 20;
/** An answer that isn't a stream is read whole up to this; a longer one is counted as saying nothing. */
const MAX_BODY = 8 << 20;

const tokenCount = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);
const record = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

/**
 * OpenAI's Responses usage as a Usage: `input_tokens` already includes the cached part
 * (`input_tokens_details.cached_tokens`); reasoning is `output_tokens_details.reasoning_tokens`.
 */
export function responsesUsage(raw: unknown): Usage | null {
  const u = record(raw);
  if (!u) return null;
  const input = tokenCount(u.input_tokens);
  const output = tokenCount(u.output_tokens);
  if (input === null || output === null) return null;
  const cached = tokenCount(record(u.input_tokens_details)?.cached_tokens);
  const reasoning = tokenCount(record(u.output_tokens_details)?.reasoning_tokens);
  return { input, output, ...(cached !== null ? { cached: Math.min(cached, input) } : {}), ...(reasoning !== null ? { reasoning: Math.min(reasoning, output) } : {}) };
}

/**
 * An embeddings answer's usage as a Usage: its input's tokens (`prompt_tokens`), and no output, as embeddings are billed.
 * Read so only for an embeddings call: a model call's usage that leaves out its output tokens is no usage.
 */
export function embeddingsUsage(raw: unknown): Usage | null {
  const input = tokenCount(record(raw)?.prompt_tokens);
  return input === null ? null : { input, output: 0 };
}

/** A body's usage, whichever of the three it is: Anthropic's has `cache_read_input_tokens` or `input_tokens` beside no `prompt_tokens`. */
function bodyUsage(body: Record<string, unknown>, kind: "openai" | "anthropic", embeddings: boolean): Usage | null {
  const usage = record(body.usage);
  if (!usage) return null;
  if (embeddings && kind === "openai") return embeddingsUsage(usage);
  if (kind === "anthropic") return anthropicUsage(usage);
  return "prompt_tokens" in usage ? openAIUsage(usage) : responsesUsage(usage);
}

export interface UsageReader {
  /** The answer's next bytes, as they are forwarded. */
  feed(chunk: Uint8Array): void;
  /** The answer has ended: its usage, or null when it said none. */
  end(): Usage | null;
  /** Its answer is generated: a finish_reason, Anthropic's stop, a Responses completion, or [DONE]. What may still come
   * is its last word on usage, and its end. */
  finished(): boolean;
  /** The provider has said its usage as its last word on it: a chat completion's usage chunk (no choices left in it),
   * a Responses completion's, or Anthropic's output count at its stop. A provider that says a running count in every
   * chunk hasn't said this until its answer's end. */
  final(): boolean;
}

/** Reads one answer's usage as it goes by. `kind` is the provider's protocol; `embeddings`, that the call is one. */
export function usageReader(kind: "openai" | "anthropic", embeddings = false): UsageReader {
  const text = new TextDecoder();
  let pending = "";
  let overlong = false;
  let sawEvent = false;
  let body = "";
  let bodyTooLong = false;
  let last: Usage | null = null;
  let started: Record<string, unknown> | null = null;
  let finalOutput: number | null = null;
  let done = false;
  let lastWord = false;

  const event = (data: string): void => {
    if (data === "[DONE]") {
      // (Nothing comes after it: a usage said by then is its last word, whichever chunk said it.)
      done = true;
      if (last) lastWord = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const e = record(parsed);
    if (!e) return;
    if (e.type === "message_start") {
      started = record(record(e.message)?.usage) ?? started;
      return;
    }
    if (e.type === "message_delta") {
      finalOutput = tokenCount(record(e.usage)?.output_tokens) ?? finalOutput;
      if (record(e.delta)?.stop_reason) {
        done = true;
        if (finalOutput !== null) lastWord = true;
      }
      return;
    }
    if (e.type === "response.completed") {
      last = responsesUsage(record(e.response)?.usage) ?? last;
      done = true;
      if (last) lastWord = true;
      return;
    }
    if (e.type === "message_stop") done = true;
    const choices = Array.isArray(e.choices) ? e.choices : null;
    if (choices?.some((c) => record(c)?.finish_reason)) done = true;
    // A chat completion's last chunk, when the stream was asked for its usage: no choices left in it, its usage alone.
    if (e.usage) {
      last = openAIUsage(e.usage) ?? last;
      if (last && !choices?.length) lastWord = true;
    }
  };

  const line = (raw: string): void => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!l.startsWith("data:")) return;
    sawEvent = true;
    event(l.slice(5).trim());
  };

  return {
    finished: () => done,
    final: () => lastWord,
    feed(chunk) {
      const s = text.decode(chunk, { stream: true });
      // A stream is read event by event: the whole of it is kept only until it shows it is one.
      if (sawEvent) body = "";
      else if (!bodyTooLong) {
        if (body.length + s.length > MAX_BODY) {
          bodyTooLong = true;
          body = "";
        } else body += s;
      }
      let from = 0;
      for (let at = s.indexOf("\n"); at !== -1; at = s.indexOf("\n", from)) {
        if (!overlong) line(pending + s.slice(from, at));
        pending = "";
        overlong = false;
        from = at + 1;
      }
      if (!overlong) {
        pending += s.slice(from);
        if (pending.length > MAX_LINE) {
          overlong = true;
          pending = "";
        }
      }
    },
    end() {
      const tail = text.decode();
      if (tail) this.feed(new TextEncoder().encode(tail));
      if (pending && !overlong) line(pending);
      if (started) return anthropicUsage(finalOutput === null ? started : { ...started, output_tokens: finalOutput });
      if (last) return last;
      if (sawEvent || bodyTooLong || !body.trim()) return null;
      try {
        const whole = record(JSON.parse(body));
        return whole ? bodyUsage(whole, kind, embeddings) : null;
      } catch {
        return null;
      }
    },
  };
}
