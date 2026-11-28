import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ExecResult } from "../../packages/core/src/index.ts";
import { benchLook, type EyesCount, eyesFraming, gatewayValues, limitAnswer, lookOf, meterDollars, pacer, recordOf, routeOf, whyNotOurs } from "./model-runs.ts";
import { spawned } from "../spawned.ts";

/* The real model's runs (model-runs.ts): what is read of a gateway token's file, where each route's calls go, and the node's meter. */

const FILE = [
  "a node's gateway token for the benchmark, c1-bench",
  "",
  "ANTHROPIC_BASE_URL=http://192.0.2.10:7811/gw/anthropic",
  "ANTHROPIC_AUTH_TOKEN=gw_FAKE_anthropic_0000000000000000000000000",
  "export OPENAI_BASE_URL='http://192.0.2.10:7811/gw/<provider>'",
  "OPENAI_API_KEY=gw_FAKE_openai_00000000000000000000000000000",
].join("\n");

test("a gateway token's file is read as its KEY=value lines; each route goes where the file says, as its model", () => {
  const values = gatewayValues(FILE);
  expect(Object.keys(values)).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "OPENAI_API_KEY"]);
  expect(routeOf(values, "anthropic")).toEqual({ base: "http://192.0.2.10:7811/gw/anthropic", token: "gw_FAKE_anthropic_0000000000000000000000000", model: "claude-opus-5-5", versioned: false });
  expect(routeOf(values, "orcarouter")).toEqual({ base: "http://192.0.2.10:7811/gw/orcarouter", token: "gw_FAKE_openai_00000000000000000000000000000", model: "anthropic/claude-opus-5.5", versioned: true });
  expect(routeOf(values, "elsewhere")).toBeNull();
  expect(routeOf({ ANTHROPIC_BASE_URL: "http://192.0.2.10:7811/gw/anthropic" }, "anthropic")).toBeNull();
});

test("a coding plan's model goes to the gateway's OpenAI-compatible address for its provider; only a plan whose terms let the primary call it is run on", () => {
  const values = gatewayValues(FILE);
  const go = routeOf(values, "opencode-go/kimi-k3.1-pro");
  expect(go).toEqual({ base: "http://192.0.2.10:7811/gw/opencode-go", token: "gw_FAKE_openai_00000000000000000000000000000", model: "kimi-k3.1-pro", versioned: false, openai: "opencode-go" });
  for (const bad of ["/kimi", "opencode-go/", "Open Code/kimi", "../x/y"]) expect(routeOf(values, bad)).toBeNull();
  expect(whyNotOurs(go!)).toBeNull();
  expect(whyNotOurs(routeOf(values, "zai-coding/glm-5.3-flash")!)).toBe("zai-coding's terms keep the primary's own calls off it (only coding tools it names may call it)");
  expect(whyNotOurs(routeOf(values, "mimo-token/mimo-v2.6-pro")!)).toContain("mimo-token's terms keep the primary's own calls off it");
  expect(whyNotOurs(routeOf(values, "deepseek/deepseek-v4-pro")!)).toBe("deepseek isn't a coding plan: a model billed by the token runs only with the owner's yes");
  expect(whyNotOurs(routeOf(values, "anthropic")!)).toBeNull();
});

test("a look given as a command of its own is the bench's to answer, its question read as a shell reads it; any other command, the VM's", () => {
  expect(lookOf('desktop look "Where is the Save button?"')).toBe("Where is the Save button?");
  expect(lookOf("desktop look --eyes opencode-go/qwen4-max 'What does the dialog say?'")).toBe("What does the dialog say?");
  expect(lookOf("  desktop look where is it  ")).toBe("where is it");
  expect(lookOf("desktop look")).toBe("");
  for (const other of ['cd /work && desktop look "q"', "desktop click 10 20", 'desktop look "$(cat q)"', "echo desktop look"]) expect(lookOf(other)).toBeNull();
});

test("a look is framed as deskd frames it: its own EYES_FRAMING, read from its source, word for word as Python has it", async () => {
  const path = new URL("../../sandbox/desktop/deskd.py", import.meta.url);
  const python = await spawned(["python3", "-I", "-c", "import importlib.util, sys; sys.dont_write_bytecode = True; s = importlib.util.spec_from_file_location('d', sys.argv[1]); d = importlib.util.module_from_spec(s); s.loader.exec_module(d); sys.stdout.write(d.EYES_FRAMING)", path.pathname], { stdout: "pipe", stderr: "pipe" });
  expect(python.exitCode).toBe(0);
  expect(eyesFraming(readFileSync(path, "utf8"))).toBe(python.stdout.toString());
  expect(eyesFraming(readFileSync(path, "utf8"))).toStartWith("This is a screenshot of a desktop, 1280 pixels wide and 800 high");
  expect(() => eyesFraming("nothing here")).toThrow("deskd.py has no EYES_FRAMING");
});

test("an answer that says a plan's allowance or its rate is spent stops the runs; any other failure doesn't", () => {
  for (const said of ["the loop failed: opencode-go → 429 Too Many Requests", "402 opencode-go's allowance is spent until 23:10 UTC", "the eyes: 429 rate limit reached", "monthly quota exceeded"]) expect(limitAnswer(said)).toBe(true);
  for (const said of ["the loop failed: opencode-go → 500 upstream error", 'the file holds ""', "the loop ended give_up: no Save button"]) expect(limitAnswer(said)).toBe(false);
});

test("the bench's look: the VM's own picture, the question in deskd's framing, to the eyes at the gateway with the token; their words as they came, and what they took counted", async () => {
  const eyes = { base: "http://192.0.2.10:7811/gw/opencode-go", token: "gw_FAKE_openai_00000000000000000000000000000", model: "kimi-k3.1-pro", versioned: false, openai: "opencode-go" };
  const ran: string[] = [];
  const inVm = async (command: string): Promise<ExecResult> => {
    ran.push(command);
    return { exitCode: 0, stdout: "/9j/FAKEJPEG\n", stderr: "", durationMs: 3, truncated: false };
  };
  const sent: { url: string; auth: string | null; body: any }[] = [];
  let status = 200;
  const gateway = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return status === 200
      ? Response.json({ choices: [{ message: { content: " The Save button is at 912,640. " } }], usage: { prompt_tokens: 1479, completion_tokens: 32 } })
      : new Response('{"error":{"message":"rate limit reached"}}', { status });
  }) as typeof fetch;
  const count: EyesCount = { calls: 0, input: 0, output: 0, ms: 0, failed: 0 };
  const limits: string[] = [];
  const answered = await benchLook("Where is Save?", inVm, eyes, "FRAMING", count, (why) => limits.push(why), gateway);
  expect([answered.exitCode, answered.stdout, answered.stderr]).toEqual([0, "The Save button is at 912,640.\n", ""]);
  expect(ran).toEqual(['f=$(mktemp --suffix=.jpg) && desktop shot "$f" >/dev/null && base64 -w0 "$f"; rm -f "$f"']);
  expect(sent[0]!.url).toBe(`${eyes.base}/chat/completions`);
  expect(sent[0]!.auth).toBe(`Bearer ${eyes.token}`);
  expect(sent[0]!.body).toEqual({ model: "kimi-k3.1-pro", max_tokens: 600, messages: [{ role: "user", content: [{ type: "text", text: "FRAMING\n\nWhere is Save?" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/FAKEJPEG" } }] }] });
  expect([count.calls, count.input, count.output, count.failed]).toEqual([1, 1479, 32, 0]);
  // A refusal is said as deskd says one, and a spent allowance stops the runs.
  status = 429;
  const refused = await benchLook("Where is Save?", inVm, eyes, "FRAMING", count, (why) => limits.push(why), gateway);
  expect([refused.exitCode, refused.stderr]).toEqual([1, 'desktop: the model that looks could not answer (429 {"error":{"message":"rate limit reached"}})\n']);
  expect(limits).toEqual(['the eyes: 429 {"error":{"message":"rate limit reached"}}']);
  expect([count.calls, count.failed]).toEqual([2, 1]);
  // No question: as deskd answers it, and nothing is asked.
  expect((await benchLook("", inVm, eyes, "FRAMING", count, () => {}, gateway)).exitCode).toBe(2);
  expect(sent).toHaveLength(2);
});

test("a plan's runs ask one call every 4 s at most, the engineer's and the eyes' together: a stand-in that refuses a burst, as OpenCode Go did, refuses none", async () => {
  // OpenCode Go refused a burst past about 25 calls a minute (28 November 2026: GLM's 27th call in about a minute). The
  // stand-in refuses a call when 25 have started in the minute before it, as that did; each call takes it a second.
  let now = 0;
  const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  const started: number[] = [];
  const refused: number[] = [];
  const plan = (async () => {
    const within = started.filter((t) => t > now - 60_000).length;
    started.push(now);
    now += 1000;
    if (within < 25) return Response.json({ choices: [{ message: { content: "ok" } }] });
    refused.push(started.length);
    return new Response('{"error":{"message":"Rate limit exceeded. Please try again later."}}', { status: 429 });
  }) as unknown as typeof fetch;
  const ask = (via: typeof fetch) => via("http://192.0.2.10:7811/gw/opencode-go/chat/completions", { method: "POST" });
  // Unpaced, as the run at 01:26 asked: its 26th call is refused.
  for (let n = 0; n < 40; n++) await ask(plan);
  expect(refused[0]).toBe(26);
  // Paced, one pacer for the engineer's calls and the eyes': none of 40 is refused, each begun 4 s after the one before.
  started.length = 0;
  refused.length = 0;
  now = 10 * 60_000;
  const pace = pacer(4000, clock);
  const [engineer, eyes] = [pace(plan), pace(plan)];
  for (let n = 0; n < 40; n++) await ask(n % 3 === 2 ? eyes : engineer);
  expect(refused).toEqual([]);
  expect(started.slice(1).map((t, i) => t - started[i]!)).toEqual(Array(39).fill(4000));
});

test("the node's meter is read for the token's label alone (as its by-who lines name a token, with no arm: before it), its colours aside; one it says nothing of is null", () => {
  const usage = [
    "Model calls on node since 2026-11-26 (UTC) · tokens as the providers reported them",
    "",
    "By who asked",
    "  arm:team.0123456789.curator                      59 calls     2.29M in     57.6k out  $0",
    "  \x1b[1mc1-bench\x1b[0m                                         12 calls      211k in      4.1k out  $1,204.37",
    "  arm:c1-bench-old                                  3 calls       10k in       1k out  $9.99",
    "  you                                              39 calls      621k in     32.3k out  $0.34",
  ].join("\n");
  expect(meterDollars(usage, "c1-bench")).toBe(1204.37);
  expect(meterDollars(usage, "c1")).toBeNull();
  expect(meterDollars(usage, "elsewhere")).toBeNull();
});

test("the runs are kept by task as the suite's model baseline: passes against the bar, calls and actions, tokens, dollars and minutes", () => {
  const run = (task: "form" | "editor", n: number, pass: boolean, calls: number, actions: number, meter: number | null) => ({
    task, policy: "model" as const, run: n, pass, why: pass ? "" : "the file holds \"\"", actedMs: 1000, commands: actions + 1, looks: 0,
    loop: { calls, actions, commands: 1, usage: { input: 1000 * calls, cached: 800 * calls, output: 100 * calls }, unknown: 0, shape: null, ms: 20_000 },
    dollars: 0.01 * calls, meter: meter, minutes: 0.3 * calls,
  });
  const record = recordOf({ at: "2026-11-27T00:00:00.000Z", commit: "abc1234", model: "anthropic/claude-opus-5.5", route: "orcarouter", runs: [run("form", 1, true, 4, 8, 0.03), run("form", 2, true, 6, 8, 0.05), run("editor", 1, false, 9, 3, 0.08)] }, { passed: 3, of: 3 });
  expect(record).toMatchObject({ suite: "desktop-model", passed: 2, of: 3, held: false, dollars: { meter: 0.16 } });
  expect(record.tasks.form).toEqual({
    passed: 2, of: 2,
    calls: { median: 5, most: 6 }, actions: { median: 8, most: 8 }, callsPerAction: { median: 0.63, most: 0.75 },
    tokens: { input: 10_000, cached: 8_000, output: 1_000, unreported: 0 },
    dollars: { meter: 0.08, upperBound: 0.1 }, minutes: { median: 1.5, most: 1.8 },
  });
  expect(record.tasks.editor).toMatchObject({ passed: 0, of: 1, failed: ['run 1: the file holds ""'], callsPerAction: null });
  // A run the meter couldn't say leaves the meter's sum unsaid, never a smaller one.
  expect(recordOf({ at: "x", commit: "y", model: "m", route: "r", runs: [run("form", 1, true, 4, 8, null)] }, { passed: 1, of: 1 }).dollars.meter).toBeNull();
});

test("a run with eyes keeps their calls, and the record says them by task: how many a run made, and what they took", () => {
  const run = (n: number, looks: number) => ({
    task: "form" as const, policy: "model" as const, run: n, pass: true, why: "", actedMs: 1000, commands: 9, looks: 0,
    loop: { calls: 6, actions: 8, commands: 1, usage: { input: 6000, cached: 0, output: 600 }, unknown: 0, shape: null, ms: 20_000 },
    dollars: 0, meter: null, minutes: 1.2, eyes: { calls: looks, input: 1500 * looks, output: 40 * looks, ms: 3000 * looks, failed: 0 },
  });
  const record = recordOf({ at: "x", commit: "y", model: "opencode-go/kimi-k3.1-pro", route: "opencode-go/kimi-k3.1-pro", eyes: "opencode-go/kimi-k3.1-pro", runs: [run(1, 1), run(2, 3), run(3, 0)] }, { passed: 3, of: 3 });
  expect(record).toMatchObject({ eyes: "opencode-go/kimi-k3.1-pro", passed: 3, dollars: { upperBound: 0 } });
  expect(record.tasks.form!.eyes).toEqual({ calls: { median: 1, most: 3 }, tokens: { input: 6000, output: 160 }, failed: 0 });
});
