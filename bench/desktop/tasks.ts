import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult, Usage } from "../../packages/core/src/index.ts";
import type { ModelsContext } from "../../packages/models/src/index.ts";
import { OUT_DIR } from "../scorecard.ts";
import { type Asked, type LoopRun, loopAsk, modelsContext, standIn, type Turn, viaLoop, type Where } from "./loop.ts";
import { type BenchVm, IN_VM, type Ran } from "./vm.ts";

/*
 * The four tasks, C0's (§2.6), every step one command through the agent's own path (BenchVm.agent: SandboxHost.exec of
 * `bash -lc withGateway(…)`), acting only with the VM's `desktop` command. Where an agent would ask its eyes "where is
 * X" (`desktop look`, a model's call), the oracle answers from the truth: the DOM, the X window list. So a run measures
 * everything but the model: the actions, focus, timing and dialogs, with perfect targeting. Each ends at its gate,
 * which reads what the task was for, never the screen:
 *  - form: the server received exactly the five values;
 *  - terminal: the file the command wrote says 42;
 *  - settings: Chromium's font size is Large on its page and in its Preferences file;
 *  - editor: the file saved through the Save As dialog holds the text.
 *
 * Three ways of going about each:
 *  - naive (C0's): one thing after another, with a fixed pause where an app is started;
 *  - settled: naive, and the VM's own `desktop settle` (150 ms with nothing drawn, 3 s at most) wherever careful lets
 *    the screen settle, before a key that commits: what an agent is told to do, and no more (BRIEF-C1 step 5);
 *  - careful (C0's): text typed only once the window that should take it has the keyboard's focus, and the screen let
 *    settle (250 ms with no pixel changing, by pictures compared) before a key that commits (Return);
 *  - toolset (C1 step 7): through an agent's own tool loop with Claude's computer toolset (loop.ts), its model the
 *    stand-in: each turn several actions, the places it clicks read from the oracle at the turn's start, as a model
 *    reads them from the screen it was shown, and one look at the turn's end. Its model calls are counted.
 */

export const TASKS = ["form", "terminal", "settings", "editor"] as const;
export type TaskName = (typeof TASKS)[number];
export const POLICIES = ["naive", "settled", "careful", "toolset"] as const;
/** The scorecard's ways, and a real model's (model-runs.ts, by hand: it spends money). */
export type Policy = (typeof POLICIES)[number] | "model";

/**
 * A real model's way through the loop (model-runs.ts): a mind whose engineer is that model, its requests kept as Asked;
 * told after each of its calls what the run has spent so far; a signal that ends the run past its share.
 */
export interface ModelWay {
  ctx(asked: Asked[]): ModelsContext;
  spent?(counted: { calls: number; usage: Usage; unknown?: number }): void;
  signal?: AbortSignal;
  maxSteps?: number;
}

export interface TaskRun {
  task: TaskName;
  policy: Policy;
  run: number;
  pass: boolean;
  why: string;
  /** From the first command to the last action's return: the machinery's time, before the gate's own waiting. */
  actedMs: number | null;
  commands: number;
  /** Where an agent would have asked its eyes (a model's call). */
  looks: number;
  /** Through the loop: its model calls (each a turn), the toolset's actions, its other commands, its tokens (the calls its provider said nothing of, apart), and whether every request offered the toolset and every turn came back as the toolset's. */
  loop?: { calls: number; actions: number; commands: number; said?: string[]; usage: Usage; unknown: number; shape: string | null; ms: number };
}

/** What each task asks of an agent, as its goal: done on the screen, the point being the desktop. */
export const GOALS: Record<TaskName, (file: string) => string> = {
  form: () => `In the browser on your desktop, open http://127.0.0.1:8000/form.html and fill in its form: name "${FORM_VALUES.name}", email "${FORM_VALUES.email}", plan "${FORM_VALUES.plan}", the terms accepted, note "${FORM_VALUES.note}". Then send it. This is a test of working the desktop: do it on the screen.`,
  terminal: (file) => `In the terminal (xterm) on your desktop, type the command echo $((6*7)) > ${file} and run it. This is a test of working the desktop: type it into that terminal on the screen, not with your own shell.`,
  settings: () => "In the browser on your desktop, set its font size to Large in its appearance settings (chrome://settings/appearance). This is a test of working the desktop: do it on the screen.",
  editor: (file) => `In the editor (Mousepad) on your desktop, type the text Written on the desktop, then save it through its Save As dialog as ${file}. This is a test of working the desktop: do it on the screen, not with your own shell.`,
};

/** A turn's calls, in the toolset's own words. */
const act = {
  click: ([x, y]: [number, number]) => ({ name: "left_click", input: { coordinate: [x, y] } }),
  type: (text: string) => ({ name: "type", input: { text } }),
  key: (text: string) => ({ name: "key", input: { text } }),
  scroll: (direction: string, amount: number, at: [number, number]) => ({ name: "scroll", input: { scroll_direction: direction, scroll_amount: amount, coordinate: at } }),
};

/** Asked until it says what `ok` wants, or `tries` times: the last answer. */
async function polled(ask: () => Promise<Record<string, any>>, ok: (p: Record<string, any>) => boolean, tries: number, ms: number): Promise<Record<string, any>> {
  let p: Record<string, any> = {};
  for (let i = 0; i < tries; i++) {
    p = await ask();
    if (ok(p)) break;
    await Bun.sleep(ms);
  }
  return p;
}

/**
 * The stand-in's turns for each task: what a model that sees the screen would do, each place it clicks read from the
 * oracle at the turn's start (the screen as the last turn's look left it), several actions a turn, then DONE.
 */
export async function* standInTurns(task: TaskName, where: Where, file: string): AsyncGenerator<Turn, void> {
  const at = (p: Record<string, any>): [number, number] => {
    if (typeof p.x !== "number") throw new Error(`no target: ${JSON.stringify(p).slice(0, 200)}`);
    return [p.x, p.y];
  };
  if (task === "form") {
    yield { calls: [act.key("ctrl+l"), act.type("http://127.0.0.1:8000/form.html"), act.key("Return")] };
    const [name, email, plan, terms, note, send] = await Promise.all(["#name", "#email", "#plan", "#terms", "#note", "#send"].map(async (id) => at(await polled(() => where(`dom '${id}'`), (p) => typeof p.x === "number", 10, 300))));
    yield { calls: [act.click(name!), act.type(FORM_VALUES.name), act.click(email!), act.type(FORM_VALUES.email), act.click(plan!), act.key("Down"), act.key("Return"), act.click(terms!), act.click(note!), act.type(FORM_VALUES.note), act.click(send!)] };
    yield { text: "DONE\nThe form is filled in and sent." };
  } else if (task === "terminal") {
    const w = await polled(() => where("window '^xterm$'"), (p) => typeof p.x === "number", 20, 250);
    yield { calls: [act.click(at(w)), act.type(`echo $((6*7)) > ${file}`), act.key("Return")] };
    yield { text: "DONE\nRan it in the terminal." };
  } else if (task === "settings") {
    yield { calls: [act.key("ctrl+l"), act.type("chrome://settings/appearance"), act.key("Return")] };
    let p = await polled(() => where("settings-font"), (q) => typeof q.x === "number" || Boolean(q.offscreen), 8, 400);
    for (let i = 0; i < 4 && p.offscreen; i++) {
      yield { calls: [act.scroll("down", 3, [640, 450])] };
      p = await where("settings-font");
    }
    if (typeof p.x !== "number") return yield { text: `GIVE UP\nThe font size setting isn't on the screen: ${JSON.stringify(p).slice(0, 200)}` };
    if (p.value !== "16") return yield { text: `GIVE UP\nThe font size was ${p.value} before the run, not 16.` };
    yield { calls: [act.click(at(p)), act.key("Down"), act.key("Return")] };
    yield { text: "DONE\nThe font size is Large." };
  } else {
    const w = await polled(() => where("window 'Mousepad$'"), (p) => typeof p.x === "number" && p.w > 600, 20, 250);
    yield { calls: [act.click(at(w)), act.type("Written on the desktop"), act.key("ctrl+s")] };
    await polled(() => where("window 'Save As'"), (p) => typeof p.x === "number", 10, 300);
    yield { calls: [act.type(file), act.key("Return")] };
    yield { text: "DONE\nSaved it." };
  }
}

/**
 * How the model was asked, in a phrase when something wasn't the toolset's shape (null: every request was). `pictures`:
 * each turn that acted ended with exactly one picture of the screen, as the stand-in's do (a real model may look in the
 * middle of a turn, or act on nothing).
 */
export function shapeOf(asked: readonly Asked[], pictures = true): string | null {
  if (!asked.length) return "it was never asked";
  if (!asked.every((a) => a.toolset)) return "a request didn't offer the computer toolset";
  if (asked.some((a) => a.echoed.calls !== a.echoed.asToolset)) return "a turn's toolset calls came back without toolset_name";
  if (asked.some((a) => a.echoed.calls && a.echoed.resultsAsToolset !== a.echoed.calls)) return "a toolset call's result came back without toolset_name";
  if (pictures && asked.slice(1).some((a) => a.echoed.calls && a.echoed.pictures !== 1)) return "a turn that acted didn't end with one picture of the screen";
  return null;
}

const FORM = { name: "Søren Ærø", email: "soren@example.test", plan: "Team", terms: "on", note: "Ready by Friday" };
const FORM_VALUES = FORM;

export async function runTask(vm: BenchVm, task: TaskName, policy: Policy, run: number, way?: ModelWay): Promise<TaskRun> {
  let commands = 0;
  let looks = 0;
  const sh = async (command: string, timeout = 120): Promise<Ran> => {
    commands++;
    return vm.agent(command, timeout);
  };
  const where = async (args: string): Promise<Record<string, any>> => {
    if (!args.startsWith("focus")) looks++;
    const r = await sh(`python3 ${IN_VM}/oracle.py ${args}`);
    try {
      return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
    } catch {
      return { error: r.stderr.slice(-200) };
    }
  };
  const click = async (args: string) => {
    const p = await where(args);
    if (typeof p.x !== "number") throw new Error(`no target for ${args}: ${JSON.stringify(p)}`);
    const r = await sh(`desktop click ${p.x} ${p.y}`);
    if (r.code !== 0) throw new Error(`the click failed: ${r.stderr.slice(-200)}`);
  };
  const careful = policy === "careful";
  // Through the loop (toolset, model): the stand-in's turns or a real model's, the VM's commands through the agent's
  // path; what it took, kept.
  const byLoop = policy === "toolset" || policy === "model";
  if (policy === "model" && !way) throw new Error("a real model's way needs its mind (model-runs.ts)");
  let looped: LoopRun | null = null;
  let shape: string | null = null;
  let counted: { calls: number; usage: Usage; unknown?: number } = { calls: 0, usage: { input: 0, output: 0, cached: 0 } };
  const loop = async (file: string) => {
    const asked: Asked[] = [];
    counted = { calls: 0, usage: { input: 0, output: 0, cached: 0 } };
    const ctx = way ? way.ctx(asked) : modelsContext("bench-stand-in-key-FAKE-0000", standIn(standInTurns(task, where, file), asked));
    const exec = async (command: string, timeoutSec: number): Promise<ExecResult> => {
      const r = await vm.agent(command, timeoutSec);
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, durationMs: Math.round(r.ms), truncated: false };
    };
    const asking = loopAsk(ctx, counted);
    const ask: typeof asking = async (...args) => {
      try {
        return await asking(...args);
      } finally {
        way?.spent?.(counted);
      }
    };
    looped = await viaLoop(GOALS[task](file), ask, exec, counted, way?.maxSteps ?? 40, way?.signal);
    commands += looped.actions + looped.commands;
    shape = shapeOf(asked, !way);
    if (looped.error) throw new Error(`the loop failed: ${looped.error}`);
    if (looped.outcome?.status !== "done") throw new Error(`the loop ended ${looped.outcome?.status}: ${looped.outcome?.summary.slice(0, 200)}`);
  };
  const settle = () => (careful ? sh(`python3 ${IN_VM}/probe.py settle-full 3 250`) : policy === "settled" ? sh("desktop settle") : Promise.resolve(null));
  const focusIs = async (rx: RegExp, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      const f = await where("focus");
      if (rx.test(String(f.name ?? ""))) return true;
      await Bun.sleep(150);
    }
    return false;
  };
  const t0 = performance.now();
  let acted = 0;
  const done = () => void (acted = performance.now());
  let pass = false;
  let why = "";
  try {
    if (task === "form") {
      const before = (await sh(`ls ${IN_VM}/out/form-*.json 2>/dev/null | wc -l`)).stdout.trim();
      if (byLoop) await loop("");
      else {
        await sh("desktop open http://127.0.0.1:8000/form.html");
        await click("dom '#name'");
        await sh(`desktop type '${FORM.name}'`);
        await click("dom '#email'");
        await sh(`desktop type '${FORM.email}'`);
        await click("dom '#plan'");
        await sh("desktop key Down Return");
        await click("dom '#terms'");
        await click("dom '#note'");
        await sh(`desktop type '${FORM.note}'`);
        await settle();
        await click("dom '#send'");
      }
      done();
      let got = "";
      for (let i = 0; i < 10; i++) {
        const after = (await sh(`ls ${IN_VM}/out/form-*.json 2>/dev/null | wc -l`)).stdout.trim();
        if (after !== before) {
          got = (await sh(`cat "$(ls ${IN_VM}/out/form-*.json | tail -1)"`)).stdout;
          break;
        }
        await Bun.sleep(300);
      }
      const fields = got ? JSON.parse(got) : null;
      pass = !!fields && JSON.stringify(fields) === JSON.stringify(FORM);
      why = pass ? "" : `it submitted ${got || "nothing"}`;
    } else if (task === "settings") {
      // Careful: its keys go to the browser only once the browser has the keyboard (after another app closed, nothing
      // may have it): a click on an empty part of its tab strip gives it, harmlessly.
      if (byLoop) await loop("");
      else {
        if (careful && !(await focusIs(/Chromium/, 3))) {
          await sh("desktop click 900 15");
          if (!(await focusIs(/Chromium/))) throw new Error("the browser never took the focus");
          // (And the pointer back over the page, where a scroll scrolls it.)
          await sh("desktop move 640 450");
        }
        await sh("desktop key ctrl+l");
        await sh("desktop type chrome://settings/appearance");
        await settle();
        await sh("desktop key Return");
        let p: Record<string, any> = {};
        for (let i = 0; i < 8; i++) {
          p = await where("settings-font");
          if (typeof p.x === "number" || p.offscreen) break;
          await Bun.sleep(400);
        }
        for (let i = 0; i < 4 && p.offscreen; i++) {
          await sh("desktop scroll down 3");
          p = await where("settings-font");
        }
        if (typeof p.x !== "number") throw new Error(`the font size select wasn't found: ${JSON.stringify(p)}`);
        if (p.value !== "16") throw new Error(`the font size was ${p.value} before the run, not 16`);
        await sh(`desktop click ${p.x} ${p.y}`);
        await settle();
        await sh("desktop key Down Return");
      }
      done();
      const ui = await where("settings-font");
      let saved: unknown = null;
      for (let i = 0; i < 20; i++) {
        saved = JSON.parse((await sh(`python3 ${IN_VM}/oracle.py pref webkit.webprefs.default_font_size`)).stdout).value;
        if (saved === 20) break;
        await Bun.sleep(1000);
      }
      pass = ui.value === "20" && saved === 20;
      why = pass ? "" : `the page says ${ui.value}, Preferences say ${saved}`;
    } else if (task === "terminal") {
      if ((await sh("command -v xterm")).code !== 0) throw new Error("no terminal on this desktop (xterm isn't in the image)");
      await sh(`DISPLAY=:1 setsid xterm -geometry 90x20+200+200 >/dev/null 2>&1 & echo $! > ${IN_VM}/out/app.pid; sleep 1`);
      if (byLoop) await loop(`${IN_VM}/out/t2-${policy}-${run}.txt`);
      else {
        if (careful) {
          let w: Record<string, any> = {};
          for (let i = 0; i < 20; i++) {
            w = await where("window '^xterm$'");
            if (typeof w.x === "number") break;
            await Bun.sleep(250);
          }
          if (typeof w.x !== "number") throw new Error(`no terminal window: ${JSON.stringify(w)}`);
          await sh(`desktop click ${w.x} ${w.y}`);
          if (!(await focusIs(/^xterm$/))) throw new Error("the terminal never took the focus");
        } else await click("window '^xterm$'");
        await sh(`desktop type 'echo $((6*7)) > ${IN_VM}/out/t2-${policy}-${run}.txt'`);
        await settle();
        await sh("desktop key Return");
      }
      done();
      let got = "";
      for (let i = 0; i < 10; i++) {
        const r = await sh(`cat ${IN_VM}/out/t2-${policy}-${run}.txt`);
        if (r.code === 0 && r.stdout.trim()) {
          got = r.stdout.trim();
          break;
        }
        await Bun.sleep(150);
      }
      pass = got === "42";
      why = pass ? "" : `the file holds ${JSON.stringify(got)}`;
    } else if (task === "editor") {
      if ((await sh("command -v mousepad")).code !== 0) throw new Error("no editor on this desktop (mousepad isn't in the image)");
      const file = `${IN_VM}/out/t4-${policy}-${run}.txt`;
      await sh(`DISPLAY=:1 setsid mousepad >/dev/null 2>&1 & echo $! > ${IN_VM}/out/app.pid; sleep 2`);
      if (byLoop) await loop(file);
      else {
        if (careful) {
          let w: Record<string, any> = {};
          for (let i = 0; i < 20; i++) {
            w = await where("window 'Mousepad$'");
            if (typeof w.x === "number" && w.w > 600) break;
            await Bun.sleep(250);
          }
          if (!(typeof w.x === "number" && w.w > 600)) throw new Error(`no editor window: ${JSON.stringify(w)}`);
          await sh(`desktop click ${w.x} ${w.y}`);
          if (!(await focusIs(/Mousepad$/))) throw new Error("the editor never took the focus");
        } else await click("window 'Mousepad'");
        await sh("desktop type 'Written on the desktop'");
        await sh("desktop key ctrl+s");
        if (careful) {
          if (!(await focusIs(/^Save As$/))) throw new Error("the Save As dialog never took the focus");
          await settle();
        } else {
          let d: Record<string, any> = {};
          for (let i = 0; i < 10; i++) {
            d = await where("window 'Save As'");
            if (typeof d.x === "number") break;
            await Bun.sleep(300);
          }
          if (typeof d.x !== "number") throw new Error("the Save As dialog didn't appear");
          await settle();
        }
        await sh(`desktop type '${file}'`);
        await settle();
        await sh("desktop key Return");
      }
      done();
      let got = "";
      for (let i = 0; i < 10; i++) {
        const r = await sh(`cat ${file}`);
        if (r.code === 0) {
          got = r.stdout;
          break;
        }
        await Bun.sleep(300);
      }
      pass = got.trim() === "Written on the desktop";
      why = pass ? "" : `the file holds ${JSON.stringify(got)}`;
    }
  } catch (error) {
    why = String((error as Error).message ?? error);
  }
  const actedMs = acted ? acted - t0 : null;
  // A run that failed leaves the screen as it was, to look at (bench/out/desktop/, never committed).
  if (!pass) {
    const shot = await vm.raw(["sh", "-c", "f=/tmp/failed.png; desktop shot $f >/dev/null && base64 -w0 $f"]);
    if (shot.code === 0 && shot.stdout) {
      mkdirSync(join(OUT_DIR, "desktop"), { recursive: true });
      writeFileSync(join(OUT_DIR, "desktop", `failed-${task}-${policy}-${run}.png`), Buffer.from(shot.stdout.trim(), "base64"));
    }
  }
  await tidy(vm, task);
  const through = looped as LoopRun | null;
  if (through && pass && shape) {
    pass = false;
    why = `it passed its gate, but not in the toolset's shape: ${shape}`;
  }
  return { task, policy, run, pass, why, actedMs, commands, looks, ...(through ? { loop: { calls: through.calls, actions: through.actions, commands: through.commands, ...(policy === "model" ? { said: through.said } : {}), usage: through.usage, unknown: counted.unknown ?? 0, shape, ms: Math.round(through.ms) } } : {}) };
}

/**
 * Between runs (not counted): the app the task started is closed the way a person closes it (its window's close, so no
 * restore question follows), then ended by its process id if it's still there; the settings put back to Medium. Then
 * the desktop as an agent's task finds it: the browser with the keyboard's focus and the pointer over its page (an app
 * that closed leaves the focus with no window: the next task's keys would go nowhere).
 */
async function tidy(vm: BenchVm, task: TaskName): Promise<void> {
  if (task === "settings") {
    await vm.agent(`python3 ${IN_VM}/oracle.py font-reset`);
    for (let i = 0; i < 25; i++) {
      if (JSON.parse((await vm.agent(`python3 ${IN_VM}/oracle.py pref webkit.webprefs.default_font_size`)).stdout || "{}").value === 16) break;
      await Bun.sleep(1000);
    }
  }
  const app = task === "terminal" ? "xterm" : task === "editor" ? "mousepad" : null;
  if (app) {
    if (task === "editor") {
      await vm.agent("desktop key ctrl+q");
      await Bun.sleep(500);
    }
    // By process id: the one the task's own start wrote down, and those its app's windows carry (_NET_WM_PID). An app
    // that keeps one process for all its windows (Mousepad) hands a second start to the first and is gone at once, so
    // the id written down would leave the first, with a dialog a failed run left open, to stand in the next run's way.
    const owners = JSON.parse((await vm.raw(["python3", `${IN_VM}/oracle.py`, "pids", task === "terminal" ? "^(xterm|XTerm)$" : "^(mousepad|Mousepad)$"])).stdout.trim() || "[]") as number[];
    await vm.raw(["sh", "-c", `for p in $(cat ${IN_VM}/out/app.pid 2>/dev/null) ${owners.join(" ")}; do kill -TERM "$p" 2>/dev/null; done; rm -f ${IN_VM}/out/app.pid; true`]);
    await Bun.sleep(300);
  }
  // A click on an empty part of the browser's tab strip gives it the focus, harmlessly; then the pointer over its page.
  await vm.raw(["desktop", "click", "900", "15"]);
  await vm.raw(["desktop", "move", "640", "450"]);
  await Bun.sleep(200);
}
