import type { Usage } from "@galahad/core";
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

/** A body's usage, whichever of the three it is: Anthropic's has `cache_read_input_tokens` or `input_tokens` beside no `prompt_tokens`. */
function bodyUsage(body: Record<string, unknown>, kind: "openai" | "anthropic"): Usage | null {
  const usage = record(body.usage);
  if (!usage) return null;
  if (kind === "anthropic") return anthropicUsage(usage);
  return "prompt_tokens" in usage ? openAIUsage(usage) : responsesUsage(usage);
}

export interface UsageReader {
  /** The answer's next bytes, as they are forwarded. */
  feed(chunk: Uint8Array): void;
  /** The answer has ended: its usage, or null when it said none. */
  end(): Usage | null;
}

/** Reads one answer's usage as it goes by. `kind` is the provider's protocol. */
export function usageReader(kind: "openai" | "anthropic"): UsageReader {
  const text = new TextDecoder();
  let pending = "";
  let overlong = false;
  let sawEvent = false;
  let body = "";
  let bodyTooLong = false;
  let last: Usage | null = null;
  let started: Record<string, unknown> | null = null;
  let finalOutput: number | null = null;

  const event = (data: string): void => {
    if (data === "[DONE]") return;
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
      return;
    }
    if (e.type === "response.completed") {
      last = responsesUsage(record(e.response)?.usage) ?? last;
      return;
    }
    // A chat completion's last chunk, when the stream was asked for its usage.
    if (e.usage) last = openAIUsage(e.usage) ?? last;
  };

  const line = (raw: string): void => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!l.startsWith("data:")) return;
    sawEvent = true;
    event(l.slice(5).trim());
  };

  return {
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
        return whole ? bodyUsage(whole, kind) : null;
      } catch {
        return null;
      }
    },
  };
}
