import { expect, test } from "bun:test";
import type { ExecResult } from "../../packages/core/src/index.ts";
import { UNPROVEN } from "../../packages/agents/src/run.ts";
import { type Asked, desktopActions, dollarsOf, gatewayAlone, loopAsk, modelsContext, standIn, throughGateway, viaLoop } from "./loop.ts";
import { GOALS, shapeOf, shellTurns, standInTurns } from "./tasks.ts";

/*
 * The bench's way through a task by an agent's own tool loop with Claude's computer toolset (loop.ts), here without a
 * VM: the stand-in model speaks Anthropic's stream to the real adapter, chat() and runLoop, and a stand-in for the VM's
 * desktop answers each command as deskd does. On a sandbox host the same runs against a real desktop (bench/run.ts).
 */

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });

/** The VM's desktop, stood in for: every command kept; each answered as deskd answers it. */
function desk() {
  const ran: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    ran.push(command);
    if (command === "desktop tree") return ok('Chromium "Form"\n  ref=1 push button "Send" 640,600 80x30\n');
    if (command.startsWith("desktop screenshot")) return ok("data:image/png;base64,iVBORw0KGgo=\n");
    if (command.startsWith("desktop ")) return ok(`${command.split(" ")[1]} done · the screen changed (5 ms)\n`);
    return ok("");
  };
  return { ran, exec };
}

const PLACES: Record<string, [number, number]> = { "#name": [400, 200], "#email": [400, 260], "#plan": [400, 320], "#terms": [300, 380], "#note": [400, 440], "#send": [640, 600] };
const where = async (args: string) => {
  const id = /^dom '(.+)'$/.exec(args)?.[1] ?? "";
  return PLACES[id] ? { x: PLACES[id]![0], y: PLACES[id]![1] } : { error: "no such thing" };
};

test("the stand-in drives a task through the loop in the toolset's own shape: several actions a turn, one look at its end, a model call a turn", async () => {
  const asked: Asked[] = [];
  const counted = { calls: 0, usage: { input: 0, output: 0, cached: 0 } };
  const ctx = modelsContext("bench-stand-in-key-FAKE-0000", standIn(standInTurns("form", where, ""), asked));
  const vm = desk();
  const run = await viaLoop(GOALS.form(""), loopAsk(ctx, counted), vm.exec, counted);
  // (Given no gate of its own, its desktop work is never verified by the run: the bench's own gate reads what it did.)
  expect([run.error, run.outcome?.status]).toEqual([null, "unverified"]);
  expect(run.outcome?.review).toContain(UNPROVEN);
  expect([run.calls, run.actions, run.commands]).toEqual([3, 14, 0]);
  // What it ran, as said: the toolset's actions as the VM's desktop commands.
  expect(run.said.slice(0, 3)).toEqual(["desktop key ctrl+l", "desktop type http://127.0.0.1:8000/form.html", "desktop key Return"]);
  // (Each batch of actions pictured before and after it, kept for the trail: C1 step 8. The second's before is the first's after.)
  const kept = "desktop screenshot --base64 --keep /work/.evidence/desktop";
  expect(vm.ran).toEqual([
    kept,
    "desktop key ctrl+l",
    "desktop type http://127.0.0.1:8000/form.html",
    "desktop key Return",
    "desktop tree",
    kept,
    "desktop left_click 400 200",
    "desktop type 'Søren Ærø'",
    "desktop left_click 400 260",
    "desktop type soren@example.test",
    "desktop left_click 400 320",
    "desktop key Down",
    "desktop key Return",
    "desktop left_click 300 380",
    "desktop left_click 400 440",
    "desktop type 'Ready by Friday'",
    "desktop left_click 640 600",
    "desktop tree",
    kept,
  ]);
  // Each request offered the toolset; each turn came back as the toolset's, its results too, with one picture.
  expect(asked.map((a) => a.toolset)).toEqual([true, true, true]);
  expect(asked.slice(1).map((a) => a.echoed)).toEqual([
    { calls: 3, asToolset: 3, results: 3, resultsAsToolset: 3, pictures: 1 },
    { calls: 11, asToolset: 11, results: 11, resultsAsToolset: 11, pictures: 1 },
  ]);
  expect(shapeOf(asked)).toBeNull();
});

test("the stand-in that works the shell's way, as a model offered no toolset does, does the form in two commands: open and the tree, then the form filled and sent in one", async () => {
  const asked: Asked[] = [];
  const counted = { calls: 0, usage: { input: 0, output: 0, cached: 0 } };
  const ctx = modelsContext("bench-stand-in-key-FAKE-0000", standIn(shellTurns("form", where, ""), asked));
  const vm = desk();
  const run = await viaLoop(GOALS.form(""), loopAsk(ctx, counted), vm.exec, counted);
  expect([run.error, run.outcome?.status]).toEqual([null, "unverified"]);
  // Two turns that act and its DONE: a model call each; four of the desktop's actions in two commands.
  expect([run.calls, run.actions, run.commands]).toEqual([3, 4, 0]);
  expect(run.said).toEqual([
    "desktop open http://127.0.0.1:8000/form.html && desktop tree",
    `desktop fill "Full name" 'Søren Ærø' Email soren@example.test Plan Team "I accept the terms" on Note 'Ready by Friday' && desktop click 640 600`,
  ]);
  // (Its commands are its shell's: no toolset call, so none comes back as one.)
  expect(asked.slice(1).map((a) => a.echoed.calls)).toEqual([0, 0]);
  expect(vm.ran.filter((c) => c.startsWith("desktop fill"))).toHaveLength(1);
});

test("the shell's stand-in sets the settings' font size in one fill, the control below the screen or on it: no turn of its own to scroll", async () => {
  // (`desktop fill` scrolls to a field below the screen the page's own way: the settings task took 4 calls, a scroll's
  // among them, as every model run's did, 28 November 2026.)
  const below = async (args: string) => (args === "settings-font" ? { offscreen: true, client: [636, 893], value: "16" } : where(args));
  const asked: Asked[] = [];
  const counted = { calls: 0, usage: { input: 0, output: 0, cached: 0 } };
  const ctx = modelsContext("bench-stand-in-key-FAKE-0000", standIn(shellTurns("settings", below, ""), asked));
  const vm = desk();
  const run = await viaLoop(GOALS.settings(""), loopAsk(ctx, counted), vm.exec, counted);
  expect([run.error, run.outcome?.status]).toEqual([null, "unverified"]);
  expect(run.said).toEqual(["desktop key ctrl+l && desktop type chrome://settings/appearance && desktop key Return && desktop settle", 'desktop fill "Font size" Large']);
  expect(run.calls).toBe(3);
});

test("a request or a turn not in the toolset's shape is said, so a task that passed its gate that way doesn't pass", () => {
  const fine: Asked = { toolset: true, echoed: { calls: 2, asToolset: 2, results: 2, resultsAsToolset: 2, pictures: 1 } };
  expect(shapeOf([fine, fine])).toBeNull();
  expect(shapeOf([])).toBe("it was never asked");
  expect(shapeOf([{ ...fine, toolset: false }])).toBe("a request didn't offer the computer toolset");
  expect(shapeOf([fine, { ...fine, echoed: { ...fine.echoed, asToolset: 1 } }])).toBe("a turn's toolset calls came back without toolset_name");
  expect(shapeOf([fine, { ...fine, echoed: { ...fine.echoed, resultsAsToolset: 0 } }])).toBe("a toolset call's result came back without toolset_name");
  expect(shapeOf([fine, { ...fine, echoed: { ...fine.echoed, pictures: 2 } }])).toBe("a turn that acted didn't end with one picture of the screen");
});

test("a real model's calls go to the node's gateway as to Anthropic's own API, and nowhere else; their dollars are an upper bound", async () => {
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    sent.push(String(url));
    return new Response("{}");
  }) as typeof fetch;
  try {
    const via = throughGateway("http://192.0.2.10:7811/gw/claude/");
    await via("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", body: "{}" });
    await expect(via("https://example.test/v1/messages", { method: "POST" })).rejects.toThrow("the bench's model calls go to Anthropic's API alone, not https://example.test");
  } finally {
    globalThis.fetch = original;
  }
  expect(sent).toEqual(["http://192.0.2.10:7811/gw/claude/v1/messages?beta=true"]);
  // A million fresh input tokens (priced as cache writes), a million read from the cache, and a million out.
  expect(dollarsOf({ input: 2_000_000, cached: 1_000_000, output: 1_000_000 })).toBeCloseTo(5 + 0.2 + 20, 6);
});

test("an action is each desktop command a run gave, the toolset's or inside a shell's own command; a command with none is another command", () => {
  // (A run that worked the desktop through bash, as two form runs on Opus 5.5 did, counts its actions too: C1 step 7.)
  const said = ["desktop left_click 400 200", "desktop click 1 2 && desktop key Return", "cd /work && desktop type 'hi'", "echo \"$(desktop text)\"", "echo desktop click", "ls -la"];
  expect(said.map(desktopActions)).toEqual([1, 2, 1, 1, 0, 0]);
});

test("an OpenAI-compatible plan's model, the loop's engineer, is asked at the gateway's address for its provider with the benchmark's token, and nowhere else", async () => {
  const base = "http://192.0.2.10:7811/gw/opencode-go";
  const sent: { url: string; auth: string | null; body: any }[] = [];
  const gateway = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "DONE\nThe form was sent." } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const counted = { calls: 0, usage: { input: 0, output: 0, cached: 0 } };
  const ctx = modelsContext("gw_FAKE_openai_00000000000000000000000000000", gateway, "kimi-k3.1-pro", { id: "opencode-go", baseUrl: base });
  await loopAsk(ctx, counted)("engineer", [{ role: "user", content: "Send the form." }], { loop: true, tools: [] });
  expect(sent.map((s) => [s.url, s.auth, s.body.model])).toEqual([[`${base}/chat/completions`, "Bearer gw_FAKE_openai_00000000000000000000000000000", "kimi-k3.1-pro"]]);
  expect(counted.calls).toBe(1);
  // (Its fetch goes to the gateway's address for it alone: anywhere else is refused before a byte is sent.)
  await expect(gatewayAlone(base)("https://opencode.test/v1/chat/completions", { method: "POST" })).rejects.toThrow("the bench's model calls go to the gateway alone, not https://opencode.test");
});
