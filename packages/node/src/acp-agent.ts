import { sseData } from "@galahad/brain";
import type { ChatMessage, ChatStreamEvent } from "@galahad/core";
import { randomId, redact, routes } from "@galahad/core";

/*
 * Galahad as an ACP agent (the Agent Client Protocol: JSON-RPC 2.0, a message a line, over stdin and stdout), for any
 * harness that runs ACP agents: Buzz's buzz-acp, which makes an agent a member of a Buzz community (docs/BUZZ.md), and
 * editors and workbenches that run any ACP agent. Each prompt is answered by Galahad on his node, through the chat route
 * with an arm token of its own (least privilege: what he does there outward asks you on a card, as for any agent); his
 * words stream back as `agent_message_chunk`s, his tools as `tool_call`s. A session keeps its own exchange in memory
 * (an arm keeps no chat in your history), so a thread's follow-ups are answered in its light.
 *
 * Nothing here reads a file or runs a command for the client: Galahad advertises no client resources and asks for
 * none. stdout belongs to the protocol alone.
 */

/** The protocol version this speaks (ACP's integer version). */
export const ACP_VERSION = 1;
/** At most this many messages of a session's exchange go with each prompt (the newest), and this many characters of them. */
const SESSION_MESSAGES = 24;
const SESSION_CHARS = 200_000;
/** A longer message keeps its beginning and its end: an editor's request comes first in its prompt, Buzz's last in its turn. */
const MESSAGE_CHARS = 64_000;
/** A line longer than this is refused unread: no JSON-RPC message of this protocol is near it. */
const LINE_LIMIT = 2_000_000;

/** One answer of Galahad's to these messages, as the node streams it (the chat route, with the arm's token). */
export type AskGalahad = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatStreamEvent>;

/**
 * Where an answer goes besides the client, for a harness that shows an agent's words to nobody (Buzz: posted where it
 * was asked, buzz.ts). Without one, the client shows them.
 */
export interface Delivery {
  /** What Galahad is asked, for a turn's words: what he is told of where he answers, and the turn. */
  frame(turn: string): string;
  /** A turn's answer once it has ended (never a cancelled one's): his words, and whether he was cut off by a failure. */
  deliver(answer: { text: string; failed: boolean }, turn: string): Promise<void>;
}

interface Session {
  messages: ChatMessage[];
  /** The prompt under way, to cancel. */
  running: AbortController | null;
}

type Json = Record<string, unknown>;

/** A message as it goes with a prompt: whole, or its beginning and end with what was cut between them said. */
function bounded(text: string): string {
  if (text.length <= MESSAGE_CHARS) return text;
  const head = Math.floor(MESSAGE_CHARS / 4);
  return `${text.slice(0, head)}\n\n(… ${text.length - MESSAGE_CHARS} characters cut …)\n\n${text.slice(text.length - (MESSAGE_CHARS - head))}`;
}

/** The newest of a session's messages that fit, beginning with one of the client's (the newest always goes). */
function recent(messages: readonly ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let room = SESSION_CHARS;
  for (let i = messages.length - 1; i >= 0 && kept.length < SESSION_MESSAGES; i--) {
    room -= messages[i]!.content.length;
    if (room < 0 && kept.length) break;
    kept.unshift(messages[i]!);
  }
  while (kept.length > 1 && kept[0]!.role !== "user") kept.shift();
  return kept;
}

/** What a prompt's content blocks say, in words: text as it is, a resource's text fenced as data, anything else named. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Json;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "resource" && b.resource && typeof (b.resource as Json).text === "string") {
      const r = b.resource as Json;
      parts.push(`${typeof r.uri === "string" ? `${r.uri}:\n` : ""}${r.text as string}`);
    } else if (b.type === "resource_link" && typeof b.uri === "string") parts.push(`(linked: ${b.uri})`);
    else if (typeof b.type === "string") parts.push(`(a ${b.type} was attached, which Galahad can't read here)`);
  }
  return parts.join("\n\n").trim();
}

export interface AcpAgentOptions {
  ask: AskGalahad;
  /** Each protocol line out (stdout). */
  write: (line: string) => void;
  /** What happened, for whoever runs it (stderr): never the conversation's words. */
  log?: (message: string) => void;
  delivery?: Delivery;
}

/** The agent's side of the protocol: feed it each line read from the client; it answers through `write`. */
export function acpAgent(o: AcpAgentOptions) {
  const sessions = new Map<string, Session>();
  const send = (message: Json): void => void o.write(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const reply = (id: unknown, result: Json) => send({ id, result });
  const failed = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });
  const update = (sessionId: string, body: Json) => send({ method: "session/update", params: { sessionId, update: body } });

  async function prompt(id: unknown, params: Json): Promise<void> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = sessions.get(sessionId);
    if (!session) return failed(id, -32602, "no such session");
    if (session.running) return failed(id, -32600, "a prompt is under way in this session: cancel it first");
    const text = promptText(params.prompt);
    if (!text) return failed(id, -32602, "the prompt has no words");
    session.messages.push({ role: "user", content: bounded(o.delivery ? o.delivery.frame(text) : text) });
    const running = new AbortController();
    session.running = running;
    /** What goes into the session's exchange: his words, and why he stopped short if he did. */
    let said = "";
    /** His words alone, to deliver. */
    let spoke = "";
    let cutOff = false;
    let stop: "end_turn" | "cancelled" = "end_turn";
    /** Why there is no answer, said where you asked in his words (never a raw provider error: redacted, a line). */
    const sayWhy = (message: string) => {
      const why = `Galahad couldn't answer: ${redact(message).split("\n", 1)[0]!.slice(0, 300)}`;
      const chunk = said ? `\n\n${why}` : why;
      said += chunk;
      cutOff = true;
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
    };
    try {
      for await (const event of o.ask(recent(session.messages), running.signal)) {
        if (event.type === "text") {
          said += event.text;
          spoke += event.text;
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
        } else if (event.type === "tool") {
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: event.id, title: event.title || event.name, kind: "other", status: "in_progress", rawInput: { summary: event.input } });
        } else if (event.type === "tool_result") {
          update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: event.id, status: event.ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: event.summary } }] });
        } else if (event.type === "stopped") {
          stop = "cancelled";
        } else if (event.type === "error") sayWhy(event.error);
      }
    } catch (error) {
      if (running.signal.aborted) stop = "cancelled";
      else sayWhy(String((error as Error).message ?? error));
    } finally {
      session.running = null;
    }
    if (running.signal.aborted) stop = "cancelled";
    if (said.trim()) session.messages.push({ role: "assistant", content: bounded(said) });
    // Delivered before the turn is said to have ended, so the harness shows him working until it is.
    if (stop === "end_turn" && o.delivery) {
      await o.delivery.deliver({ text: spoke, failed: cutOff }, text).catch((error) => o.log?.(`not delivered: ${redact(String((error as Error).message ?? error)).slice(0, 300)}`));
    }
    reply(id, { stopReason: stop });
  }

  /** One line from the client. A request is answered (prompts as they end); a notification is acted on. */
  function receive(line: string): Promise<void> | void {
    if (!line.trim()) return;
    if (line.length > LINE_LIMIT) return failed(null, -32600, "message too long");
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return failed(null, -32700, "not JSON");
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return failed(null, -32600, "not a JSON-RPC message");
    const { id, method } = message;
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Json;
    if (typeof method !== "string") return; // A response to nothing it asked: it asks nothing.
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: ACP_VERSION,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
          authMethods: [],
          agentInfo: { name: "galahad", title: "Galahad" },
        });
      case "session/new": {
        const sessionId = `gal-${randomId(12)}`;
        sessions.set(sessionId, { messages: [], running: null });
        o.log?.(`session ${sessionId} opened`);
        return reply(id, { sessionId });
      }
      case "session/prompt":
        return prompt(id, params);
      case "session/cancel": {
        const session = sessions.get(typeof params.sessionId === "string" ? params.sessionId : "");
        session?.running?.abort();
        return;
      }
      case "authenticate":
        return reply(id, {});
      default:
        if (id !== undefined) return failed(id, -32601, `Galahad doesn't offer ${method}`);
    }
  }

  /** The client went away: every prompt under way is stopped (each ends as cancelled). */
  const close = () => {
    for (const session of sessions.values()) session.running?.abort();
  };

  return { receive, close, sessions: () => sessions.size };
}

/** Galahad on his node: the chat route with an arm's token, his answer's events as they come. */
export function askNode(base: string, token: string): AskGalahad {
  return async function* (messages, signal) {
    let response: Response;
    try {
      response = await fetch(`${base}${routes.chat.path}`, {
        method: routes.chat.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`no Galahad node is running at ${base}; start it with \`galahad serve\``);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    for await (const data of sseData(response.body!)) yield JSON.parse(data) as ChatStreamEvent;
  };
}

/**
 * `galahad acp`: the protocol on stdin and stdout. Each line is taken as it comes, so a cancel is read while a prompt
 * runs; when the client closes stdin, what is under way is stopped and the process ends.
 */
export async function runAcpAgent(o: { base: string; token: string; delivery?: Delivery }): Promise<void> {
  const log = (message: string) => process.stderr.write(`galahad acp: ${message}\n`);
  const agent = acpAgent({ ask: askNode(o.base, o.token), write: (line) => process.stdout.write(`${line}\n`), log, ...(o.delivery ? { delivery: o.delivery } : {}) });
  const running = new Set<Promise<void>>();
  const take = (line: string) => {
    const handled = agent.receive(line);
    if (!(handled instanceof Promise)) return;
    running.add(handled);
    void handled.finally(() => running.delete(handled));
  };
  const decoder = new TextDecoder();
  let buffer = "";
  // A line past the limit is refused once, and the rest of it skipped to its end.
  let skipping = false;
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (skipping) skipping = false;
      else take(line);
    }
    if (buffer.length > LINE_LIMIT) {
      if (!skipping) take(buffer);
      skipping = true;
      buffer = "";
    }
  }
  if (buffer.trim() && !skipping) take(buffer);
  agent.close();
  await Promise.allSettled(running);
}
