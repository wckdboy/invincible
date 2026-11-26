import { expect, test } from "bun:test";
import type { ExecResult } from "../../packages/core/src/index.ts";
import { type Asked, dollarsOf, loopAsk, modelsContext, standIn, throughGateway, viaLoop } from "./loop.ts";
import { GOALS, shapeOf, standInTurns } from "./tasks.ts";

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
  expect([run.error, run.outcome?.status]).toEqual([null, "done"]);
  expect([run.calls, run.actions, run.commands]).toEqual([3, 14, 0]);
  expect(vm.ran).toEqual([
    "desktop key ctrl+l",
    "desktop type http://127.0.0.1:8000/form.html",
    "desktop key Return",
    "desktop tree",
    "desktop screenshot --base64",
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
    "desktop screenshot --base64",
  ]);
  // Each request offered the toolset; each turn came back as the toolset's, its results too, with one picture.
  expect(asked.map((a) => a.toolset)).toEqual([true, true, true]);
  expect(asked.slice(1).map((a) => a.echoed)).toEqual([
    { calls: 3, asToolset: 3, results: 3, resultsAsToolset: 3, pictures: 1 },
    { calls: 11, asToolset: 11, results: 11, resultsAsToolset: 11, pictures: 1 },
  ]);
  expect(shapeOf(asked)).toBeNull();
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
