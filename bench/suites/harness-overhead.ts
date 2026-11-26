import { type ChatStreamEvent, type ExecResult, nodeIdentity } from "../../packages/core/src/index.ts";
import { chat, type ChatTools } from "../../packages/brain/src/chat.ts";
import { type QuestRole, runQuest } from "../../packages/brain/src/quest.ts";
import { foundFleet, MindStore, Vault } from "../../packages/mind/src/index.ts";
import { intBelow, rng, subSeed, type Suite } from "../lib.ts";

/*
 * The harness's own overhead: the chat loop and the quest runner driven by
 * scripted stand-in models that answer at once, and tools and commands that
 * return at once. Whatever time is left is the harness's: building the prompt,
 * redacting, parsing a reply, keeping the trail, compacting. A change that makes
 * the loop slower shows here, where no model's latency hides it.
 *
 * No model is called and nothing leaves the process: the "provider" is a
 * function that returns the next scripted reply in the provider's own wire format.
 */

const ROUNDS = 8;
const STEPS = 12;

const sse = (...chunks: object[]): Response => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const callTool = (id: string): Response => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "recall", arguments: '{"query":"the build"}' } }] } }] });
const say = (text: string): Response => sse({ choices: [{ delta: { content: text } }] });

export const suite: Suite = {
  name: "harness-overhead",
  about: "the chat loop and the quest runner with models that answer at once: the time the harness itself adds",
  headline: ["harness.chat.rounds-run", "harness.quest.steps-run", "harness.chat.tool-round", "harness.chat.plain-answer", "harness.quest.step"],
  async run(ctx) {
    const keys = rng(subSeed(ctx.seed, "harness-keys"));
    const identity = nodeIdentity(Uint8Array.from({ length: 32 }, () => intBelow(keys, 256)), Uint8Array.from({ length: 32 }, () => intBelow(keys, 256)));
    const store = new MindStore(":memory:");
    try {
      foundFleet(store, identity, { fleetName: "bench", nodeName: "n" });
      const vault = new Vault(store, identity);
      store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
      store.emit(identity, "roster.set", { role: "planner", models: ["local/stand-in"] });
      // A mind with something in it: the persona and the context are built from it for every answer.
      for (let i = 0; i < 40; i++) store.remember(identity, `the build of project ${i} takes about ${10 + i} seconds on the rack`, { tags: ["bench"], prov: { trust: "owner" } });

      /** A provider that answers each request with the next of `replies`. */
      const provider = (replies: (() => Response)[]): typeof fetch => (async () => (replies.shift() ?? (() => new Response("no more replies", { status: 500 })))()) as unknown as typeof fetch;
      const tools: ChatTools = {
        specs: [{ name: "recall", description: "Search memory.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
        describe: (call) => ({ title: "Recall from the shared mind", input: JSON.stringify(call.input) }),
        run: async () => ({ content: "3 memories about the build: it takes about 20 seconds; it failed on Tuesday; it passes now.", summary: "3 memories" }),
        readOnly: () => true,
      };
      const answer = async (replies: (() => Response)[], withTools: boolean): Promise<ChatStreamEvent[]> => {
        const events: ChatStreamEvent[] = [];
        for await (const event of chat({ store, vault, fetch: provider(replies) }, { messages: [{ role: "user", content: "How long does the build take, and did it pass?" }], ...(withTools ? { tools } : {}) })) events.push(event);
        return events;
      };

      // An answer that calls a tool eight times and then says what it found.
      const withRounds = (): (() => Response)[] => [...Array.from({ length: ROUNDS }, (_, i) => () => callTool(`call_${i}`)), () => say("About twenty seconds, and it passes now.")];
      const first = await answer(withRounds(), true);
      ctx.quality("harness.chat.rounds-run", first.filter((e) => e.type === "tool_result").length, "rounds", "higher", { note: `of ${ROUNDS} scripted: each tool call ran and its outcome went back to the model` });
      ctx.quality("harness.chat.answered", first.some((e) => e.type === "text") && first.at(-1)?.type === "done" ? 1 : 0, "", "higher", { note: "the answer came after the rounds and the stream ended cleanly" });
      await ctx.timeAsync("harness.chat.tool-round", () => answer(withRounds(), true), { n: 9, warm: 2, per: ROUNDS, note: `one tool round of an answer with ${ROUNDS} (the model and the tool return at once)` });
      await ctx.timeAsync("harness.chat.plain-answer", () => answer([() => say("About twenty seconds.")], false), { n: 15, warm: 3, note: "an answer with no tools: the prompt built, one reply streamed" });

      // A quest: a plan, twelve commands, DONE, a review that passes.
      const sh = (command: string): string => `Next step.\n\`\`\`sh\n${command}\n\`\`\``;
      const output = "ok\n".repeat(40);
      const quest = async (): Promise<{ status: string; steps: number }> => {
        const script: Record<QuestRole, string[]> = {
          planner: ["1. Build it.\n2. Test it.\nDone when: the tests pass."],
          engineer: [...Array.from({ length: STEPS }, (_, i) => sh(`make step-${i} && ./check.sh ${i}`)), "DONE\nBuilt and tested; the checks pass."],
          reviewer: ["PASS\nThe commands and their output bear it out."],
        };
        const outcome = await runQuest(
          { goal: "build the project and show its tests pass", environment: "a test sandbox with make and a shell" },
          { ask: async (role) => ({ text: script[role].shift() ?? "DONE", model: `stand-in/${role}` }), exec: async (): Promise<ExecResult> => ({ exitCode: 0, stdout: output, stderr: "", durationMs: 1, truncated: false }), sleep: async () => {} },
        );
        return { status: outcome.status, steps: outcome.steps };
      };
      const ran = await quest();
      ctx.quality("harness.quest.steps-run", ran.steps, "steps", "higher", { note: `of ${STEPS} scripted commands, each run and observed` });
      ctx.quality("harness.quest.done", ran.status === "done" ? 1 : 0, "", "higher", { note: "planned, worked, reviewed and passed" });
      await ctx.timeAsync("harness.quest.step", quest, { n: 9, warm: 2, per: STEPS, note: `one step of a quest of ${STEPS} (the reply parsed, the command "run", its output observed and kept for the review)` });
    } finally {
      store.close();
    }
  },
};
