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
 * Two ways of going about each, as C0 had them:
 *  - naive: one thing after another, with a fixed pause where an app is started;
 *  - careful: text typed only once the window that should take it has the keyboard's focus, and the screen let settle
 *    (250 ms with no pixel changing) before a key that commits (Return).
 */

export const TASKS = ["form", "terminal", "settings", "editor"] as const;
export type TaskName = (typeof TASKS)[number];
export const POLICIES = ["naive", "careful"] as const;
export type Policy = (typeof POLICIES)[number];

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
}

const FORM = { name: "Søren Ærø", email: "soren@example.test", plan: "Team", terms: "on", note: "Ready by Friday" };

export async function runTask(vm: BenchVm, task: TaskName, policy: Policy, run: number): Promise<TaskRun> {
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
  const settle = () => (careful ? sh(`python3 ${IN_VM}/probe.py settle-full 3 250`) : Promise.resolve(null));
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
      }
      await sh(`desktop type '${file}'`);
      await settle();
      await sh("desktop key Return");
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
  await tidy(vm, task);
  return { task, policy, run, pass, why, actedMs, commands, looks };
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
