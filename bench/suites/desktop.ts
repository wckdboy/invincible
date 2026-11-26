import { DEFAULT_IMAGE, DESKTOP_IMAGE } from "../../packages/sandbox/src/spec.ts";
import { buildImages } from "../desktop/images.ts";
import { a11y, boot, core, costs, fragile, lookActLook, paths, type Samples, typing } from "../desktop/measure.ts";
import { POLICIES, runTask, TASKS, type TaskRun } from "../desktop/tasks.ts";
import { bench, BenchVm, cannotRunHere, clearLeftovers } from "../desktop/vm.ts";
import { sig, type Suite, type SuiteContext } from "../lib.ts";

/*
 * An agent's desktop, as the node makes one: a Kata microVM from the desktop image, with Invincible's own run
 * arguments, driven through the node's own paths (C0's study, BRIEF-C1 step 1). It needs Docker with Kata, so it runs
 * on a sandbox host and nowhere else: elsewhere it is skipped, and says so, and is never a pass.
 *
 * On a host that runs a live node, everything it makes has names and a label of its own (desktop/scratch.ts):
 * INVINCIBLE_BENCH_SCRATCH is the prefix (default "bench"; "c1" for the runs that built it), so the live node never lists, keeps or
 * removes one of its VMs. It builds its images from this checkout under that prefix, makes its VMs with no network
 * (every page is served from the VM's own loopback), and removes every VM it made, whatever happens.
 *
 * A desktop number worse than its baseline fails the run: speed beyond a ±20 % band (or the samples' own spread),
 * not only past 2×; a count of passes, or a check that held, going down; memory or CPU past their resolution.
 */

const NOTE = {
  boot: "a fresh VM (docker run as the node makes an agent's) to the desktop started, a page painted and a picture taken",
  vm: "inside the VM, no exec around it",
  agent: "through the agent's path, as team-runtime runs each command of a task: a plain desktop command to the VM's held desktop session where it has one, else SandboxHost.exec of bash -lc withGateway(…)",
  owner: "through the owner's path: SandboxHost.desktop (POST /api/team/desktop), the action and a fresh picture",
};

/** Median, IQR-aware: through ctx.speed, with when the samples were taken. */
const speed = (ctx: SuiteContext, id: string, s: Samples, note: string) => ctx.speed(id, s.samples, "ms", "lower", s.span, note);

function tasks(ctx: SuiteContext, runs: TaskRun[], n: number, span: [number, number]): void {
  for (const task of TASKS) {
    for (const policy of POLICIES) {
      const these = runs.filter((r) => r.task === task && r.policy === policy);
      const passed = these.filter((r) => r.pass).length;
      const failed = these.find((r) => !r.pass);
      ctx.quality(`desktop.task.${task}.${policy}`, passed, "of 5", "higher", { n, note: `${task}, the ${policy} way, with perfect targeting: runs that passed their gate${failed ? `; one that didn't: ${failed.why.slice(0, 160)}` : ""}` });
      const acted = these.filter((r) => r.actedMs !== null).map((r) => r.actedMs!);
      if (acted.length) ctx.speed(`desktop.task.${task}.${policy}.ms`, acted, "ms", "lower", span, `${task}, ${policy}: from its first command to its last action's return (no model)`);
      if (passed) {
        const ok = these.filter((r) => r.pass);
        ctx.quality(`desktop.task.${task}.${policy}.commands`, Math.max(...ok.map((r) => r.commands)), "commands", "lower", { note: `${task}, ${policy}: commands a passing run took (each one an agent turn with a model)` });
        ctx.quality(`desktop.task.${task}.${policy}.looks`, Math.max(...ok.map((r) => r.looks)), "looks", "lower", { note: `${task}, ${policy}: where it would have asked its eyes (each one a model's call)` });
      }
    }
  }
}

export const suite: Suite = {
  name: "desktop",
  about: "an agent's desktop in a Kata microVM, as the node makes one: boot, actions, typing, the four tasks, what breaks, what it costs",
  headline: [
    "desktop.boot.to-usable",
    "desktop.vm.click-to-pixels",
    "desktop.vm.click-dead",
    "desktop.agent.click",
    "desktop.agent.key",
    "desktop.agent.shot",
    "desktop.owner.look",
    "desktop.loop.look-act-look",
    "desktop.type.chromium.exact",
    "desktop.task.form.careful",
    "desktop.task.terminal.careful",
    "desktop.task.settings.careful",
    "desktop.task.editor.careful",
    "desktop.task.editor.naive",
    "desktop.task.editor.settled",
    "desktop.a11y.form-match",
    "desktop.a11y.find",
    "desktop.a11y.tree-tokens.typical",
    "desktop.f.alert-ms",
    "desktop.f.blind-type-refused",
    "desktop.cost.idle.extra-mb",
    "desktop.cost.watched.cpu-pct",
    "desktop.image.desktop-gb",
  ],
  cannot: cannotRunHere,
  strict: { noiseFloor: 0.2 },
  asMeasured: true,
  // What C1's steps reached, held whatever the baseline (still C0's) says: a step that helps one way through a task
  // mustn't quietly break another (step 3 took the naive editor from 5/5 to 0/5, and C0's 0/5 hid it).
  held: {
    "desktop.boot.usable": 5,
    "desktop.task.form.naive": 5,
    "desktop.task.form.careful": 5,
    "desktop.task.terminal.naive": 5,
    "desktop.task.terminal.careful": 5,
    "desktop.task.settings.naive": 5,
    "desktop.task.settings.careful": 5,
    "desktop.task.editor.naive": 5,
    "desktop.task.editor.settled": 5,
    "desktop.task.editor.careful": 5,
    "desktop.type.chromium.exact": 1,
    "desktop.type.xterm.exact": 1,
    "desktop.type.mousepad.exact": 1,
    "desktop.f.blind-type-refused": 1,
    "desktop.f.alert-reported": 1,
    "desktop.f.front-tab-read": 2,
    "desktop.f.stale-after-navigation": 0,
    "desktop.f.double-clicks": 5,
    "desktop.f.browser-back": 1,
    "desktop.f.after-last-tab": 1,
  },
  async run(ctx) {
    const prefix = process.env.INVINCIBLE_BENCH_SCRATCH ?? "bench";
    const b = bench(prefix, ctx.log);
    const left = await clearLeftovers(b);
    if (left) ctx.log(`removed ${left} things an earlier run of the bench left behind`);
    const built = await buildImages(b);
    ctx.quality("desktop.image.desktop-gb", sig(built.sizes[DESKTOP_IMAGE]! / 1e9, 3), "GB", "lower", { resolution: 0.02, note: "the desktop image as built from this checkout (once per host, shared by every VM)" });
    ctx.quality("desktop.image.workshop-gb", sig(built.sizes[DEFAULT_IMAGE]! / 1e9, 3), "GB", "lower", { resolution: 0.02, note: "the workshop image it is made from" });

    const made: BenchVm[] = [];
    try {
      // Boot: fresh VMs, each removed after.
      const n = 5;
      const booted = await boot(b, n, ctx.seed);
      speed(ctx, "desktop.boot.to-usable", booted.toUsable, NOTE.boot);
      speed(ctx, "desktop.boot.vm", booted.vm, "the VM made (SandboxHost.create: docker run, Kata, as the node makes an agent's)");
      speed(ctx, "desktop.boot.start", booted.start, "desktop start: the display, the window manager and the browser launched");
      speed(ctx, "desktop.boot.first-open", booted.firstOpen, "the first desktop open: the browser's first page");
      speed(ctx, "desktop.boot.first-shot", booted.firstShot, "the first screenshot");
      ctx.quality("desktop.boot.usable", booted.usable, `of ${n}`, "higher", { n, note: "fresh VMs whose first page could be read" });

      // One VM for the rest, 1 vCPU and 4 GB, as an agent's desktop VM is made.
      const { vm } = await BenchVm.make(b, { desktop: true, seed: ctx.seed });
      made.push(vm);
      await vm.ready(ctx.seed);

      const c = await core(vm);
      speed(ctx, "desktop.vm.exec", c.execTrue, "docker exec true into the Kata VM, from its host");
      speed(ctx, "desktop.vm.shot-png", c.shotPng, `desktop shot x.png of a text page, ${NOTE.vm}`);
      speed(ctx, "desktop.vm.shot-jpg", c.shotJpg, `desktop shot x.jpg of a text page, ${NOTE.vm}`);
      speed(ctx, "desktop.vm.click-to-pixels", c.clickPixels, `desktop click to the page's pixels changing, ${NOTE.vm}`);
      speed(ctx, "desktop.vm.click-returns", c.clickReturns, `desktop click to its return, ${NOTE.vm}`);
      speed(ctx, "desktop.vm.click-dead", c.clickDead, "a click's dead time: from the pixels changing to the command's return");
      speed(ctx, "desktop.vm.key-to-pixels", c.keyPixels, `desktop key to the page's pixels changing, ${NOTE.vm}`);
      speed(ctx, "desktop.vm.key-returns", c.keyReturns, `desktop key to its return, ${NOTE.vm}`);

      const p = await paths(vm);
      speed(ctx, "desktop.agent.exec-click", p.execClick, "desktop click as an exec of its own, straight into the VM (no lookup, no shell): the other way the host could act");
      speed(ctx, "desktop.agent.true", p.agentTrue, `true, ${NOTE.agent}`);
      speed(ctx, "desktop.agent.click", p.agentClick, `desktop click, ${NOTE.agent}`);
      speed(ctx, "desktop.agent.key", p.agentKey, `desktop key, ${NOTE.agent}`);
      speed(ctx, "desktop.agent.shot", p.agentShot, `desktop shot, ${NOTE.agent}`);
      speed(ctx, "desktop.owner.look", p.ownerLook, `a look (no action), ${NOTE.owner}`);
      speed(ctx, "desktop.owner.click", p.ownerClick, `a click, ${NOTE.owner}`);
      speed(ctx, "desktop.owner.key", p.ownerKey, `a key, ${NOTE.owner}`);
      ctx.quality("desktop.owner.look-kb", sig(p.lookBytes / 1000, 3), "KB", "lower", { resolution: Math.max(10, (p.lookBytes / 1000) * 0.1), note: "the owner's look of a text page, base64 as it crosses the wire" });

      speed(ctx, "desktop.loop.look-act-look", await lookActLook(vm), "a look, a click and a look through the agent's path, the eyes answering at once (no model)");

      const t = await typing(vm, 20);
      for (const [app, r] of Object.entries(t.exact)) ctx.quality(`desktop.type.${app}.exact`, r.of ? r.exact / r.of : 0, "of 1", "higher", { n: Math.max(1, r.of), note: `the test string typed into ${app}, exact${r.note ? ` (${r.note})` : ""}` });
      speed(ctx, "desktop.type.ms", t.ms, "the test string (40 characters) typed into Chromium by the VM's own command (C0's typefix.sh)");

      const tree = await a11y(vm, 10);
      ctx.quality("desktop.a11y.form-match", tree.formMatch, `of ${tree.formOf}`, "higher", { n: tree.formOf, note: `the form's controls where desktop find (the accessibility tree) gives the DOM's centre within 2 px${tree.misses.length ? `; not: ${tree.misses.join("; ").slice(0, 300)}` : ""}` });
      speed(ctx, "desktop.a11y.find", tree.findMs, `desktop find button Send on the form, ${NOTE.agent}`);
      speed(ctx, "desktop.a11y.find-vm", tree.findInVm, `desktop find button Send, a process each, ${NOTE.vm}`);
      speed(ctx, "desktop.a11y.tree", tree.treeMs, `desktop tree of a typical front page (typical.html), ${NOTE.agent}`);
      ctx.quality("desktop.a11y.tree-tokens.typical", tree.typical.tokens, "tokens", "lower", { resolution: Math.max(50, tree.typical.tokens * 0.05), note: `desktop tree of a typical front page, as a model reads it: characters / 4 (${tree.typical.lines} lines)` });
      ctx.quality("desktop.a11y.tree-tokens.settings", tree.settings.tokens, "tokens", "lower", { resolution: Math.max(50, tree.settings.tokens * 0.05), note: `desktop tree of the browser's own settings (chrome://settings/appearance): characters / 4 (${tree.settings.lines} lines)` });

      const runs: TaskRun[] = [];
      const tasksFrom = performance.now();
      for (const task of TASKS) for (const policy of POLICIES) for (let run = 1; run <= 5; run++) {
        runs.push(await runTask(vm, task, policy, run));
        ctx.log(`${task} ${policy} ${run}: ${runs.at(-1)!.pass ? "pass" : `fail: ${runs.at(-1)!.why.slice(0, 120)}`}`);
      }
      tasks(ctx, runs, 5, [tasksFrom, performance.now()]);

      const fragileFrom = performance.now();
      const f = await fragile(vm, 10);
      const fragileSpan: [number, number] = [fragileFrom, performance.now()];
      ctx.quality("desktop.f.blind-type-refused", f.blindTypeRefused, "", "higher", { note: "F1: text typed with nothing that takes it focused is an error (1), not lost with exit 0 (0)" });
      ctx.speed("desktop.f.alert-ms", [f.alertMs], "ms", "lower", fragileSpan, "F4: desktop text while a JavaScript alert is up: how long until it answers");
      ctx.quality("desktop.f.alert-reported", f.alertReported, "", "higher", { note: "F4: the alert reported within 1 s (1), or not (0)" });
      ctx.quality("desktop.f.front-tab-read", f.frontTabRead, "of 2", "higher", { note: "F5: desktop text reads the tab in front: the new tab, then the first brought back" });
      ctx.quality("desktop.f.stale-after-navigation", f.staleAfterNavigation, `of ${f.navigations}`, "lower", { note: "F6: the owner's pictures right after a click that navigates which still show the old page" });
      ctx.quality("desktop.f.double-clicks", f.doubleClicks, "of 5", "higher", { note: "F7: five double clicks 0.3 s apart, as the page counted them" });
      ctx.speed("desktop.f.browser-back-ms", [f.browserBackMs], "ms", "lower", fragileSpan, "F9: the browser killed; the next desktop open, to its page");
      ctx.quality("desktop.f.browser-back", f.browserBack, "", "higher", { note: "F9: that next open worked" });
      ctx.quality("desktop.f.after-last-tab", f.afterLastTab, "", "higher", { note: "F10: the last tab closed; the next desktop text read a page (1) or nothing (0)" });

      // (On VMs of its own: what a state costs isn't to be read off one that has done all of the above.)
      const w = await costs(b, ctx.seed, 20);
      const mb = (id: string, value: number, note: string) => ctx.quality(id, Math.round(value), "MB", "lower", { resolution: Math.max(15, value * 0.08), note: `${note}: the VM's processes on the host (QEMU, virtiofsd, the shim), proportional set size` });
      const cpu = (id: string, value: number, note: string) => ctx.quality(id, sig(value, 2), "% of a core", "lower", { resolution: Math.max(0.3, value * 0.2), note: `${note}: the VM's host CPU over 20 s` });
      mb("desktop.cost.workshop-idle.mem-mb", w.workshopIdle.pssMb, "a workshop VM (no desktop image), idle");
      ctx.quality("desktop.cost.unstarted.extra-mb", Math.round(w.unstarted.qemuRssMb - w.workshopIdle.qemuRssMb), "MB", "lower", { resolution: 15, note: "a desktop-image VM with its desktop not started, over a workshop VM: QEMU's resident memory" });
      mb("desktop.cost.idle.mem-mb", w.idle.pssMb, "the desktop up, a form page, idle");
      ctx.quality("desktop.cost.idle.extra-mb", Math.round(w.idle.pssMb - w.workshopIdle.pssMb), "MB", "lower", { resolution: Math.max(15, (w.idle.pssMb - w.workshopIdle.pssMb) * 0.08), note: "the desktop up and idle, over a workshop VM idle (host memory)" });
      cpu("desktop.cost.idle.cpu-pct", w.idle.cpuPct, "the desktop up, a form page, idle");
      cpu("desktop.cost.busy.cpu-pct", w.busy.cpuPct, "busy: a canvas animation");
      mb("desktop.cost.busy.mem-mb", w.busy.pssMb, "busy: a canvas animation");
      cpu("desktop.cost.watched-busy.cpu-pct", w.watchedBusy.cpuPct, "watched (a look every 2 s) while the agent scrolls every 2 s");
      cpu("desktop.cost.watched.cpu-pct", w.watched.cpuPct, "watched alone: the app's look every 2 s on a still text page");
      mb("desktop.cost.after-busy.mem-mb", w.afterBusy.pssMb, "idle again after being busy");
      ctx.quality("desktop.stream.still-kbit", Math.round(w.stillKbit), "kbit/s", "lower", { resolution: Math.max(20, w.stillKbit * 0.1), note: "what watching moves while the screen is still: the app's look every 2 s (apps/web/src/views/desktop.ts), base64" });
    } finally {
      for (const vm of made) await vm.remove().catch((error) => ctx.log(`couldn't remove ${vm.container}: ${(error as Error).message}`));
      const still = await clearLeftovers(b);
      if (still) ctx.log(`removed ${still} more of the bench's own`);
    }
  },
};
