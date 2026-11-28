import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, type HandedView, KERNEL, REFERENCE_SINGLE, type TeamSnapshot } from "@invincible/core";
import { DEFAULT_IMAGE, type DockerRunner, KATA_RUNTIME, LABEL } from "@invincible/sandbox";
import type { Measure } from "../src/compute/service.ts";
import { HAVE_QAMP, type Pair, sandboxCaps, startPair, until } from "./fabric-pair.ts";

/*
 * Another node's task, end to end on real VMs: two nodes over real Q-AMP sidecars (fabric-pair.ts), alpha handing a task
 * to beta's agent, which takes it in a VM of its own beside its agent's, both Kata microVMs (and again with Docker's own
 * runtime, runc), through its gates, its review and its bring-back, to its proof checked back on alpha. Until this ran, no
 * node had taken a handed task end to end on real Docker or Kata (the lead, 28 November 2026), which kept the fabric off.
 *
 * Beta is a scratch node beside a live one (sandboxNetworks false): its sandboxes join no network, so nothing of it
 * reaches the live node's (its sandbox networks, its gateway), and it makes, keeps and builds no image. Its models are a
 * stand-in, which the node calls itself; its agent's commands run in the VMs for real. Its Docker is the host's, through a
 * wrapper this test writes, given as both its engine and the binary it spawns itself (pipes, streams, a collect):
 * - each VM and volume it makes is named this run's own (E2E_PREFIX, never invincible-sbx-), and a listing shows it back
 *   as the node named it;
 * - it refuses what would touch anything else: an image built, pulled, tagged or removed, a network made or changed, a
 *   prune, a name of a live node's kind; each refusal is kept, and the test fails on one;
 * - for runc, it runs each VM without Kata's runtime (the node asks one for every agent's VM).
 * It has no workspace helper (one given an engine runs none; and its socket is a path nothing listens on): a host's
 * helper is its live node's.
 *
 * Its agent's repository is made in its VM before the task: a clone comes through the gateway, which a scratch node has
 * none of, so the task's start finds it as it is ("stale") and begins on it.
 *
 * Linux, Docker, invincible/sandbox:1 and a Q-AMP binary (INVINCIBLE_QAMP_TEST_BIN), and Kata for its first half.
 * Skipped, and so unverified, anywhere else. Each run prints the times of its stages.
 */

setDefaultTimeout(600_000);

/** The host's docker (E2E_DOCKER where PATH's first is a stand-in that refuses everything: see E2E_STRAY_LOG). */
const REAL = process.platform === "linux" ? (process.env.E2E_DOCKER ?? Bun.which("docker")) : null;
/** Where such a stand-in first on PATH writes what reached it: nothing of a node's may, only the wrapper's own. */
const STRAY = process.env.E2E_STRAY_LOG ?? null;
const docker = (...args: string[]) => spawnSync(REAL!, args, { encoding: "utf8", timeout: 180_000 });
/** This run's own names: letters, digits and dashes, ending in a dash (`<prefix>sbx-<id>`, as the node's `invincible-sbx-<id>`). */
const PREFIX = process.env.E2E_PREFIX ?? `e2e-${randomBytes(3).toString("hex")}-`;
if (!/^[a-z][a-z0-9-]{2,30}-$/.test(PREFIX)) throw new Error(`E2E_PREFIX must be lowercase letters, digits and dashes, ending in a dash: ${PREFIX}`);
const available = !!REAL && HAVE_QAMP && docker("version", "--format", "{{.Server.Version}}").status === 0 && docker("image", "inspect", DEFAULT_IMAGE).status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, a Docker it can reach, ${DEFAULT_IMAGE} and a Q-AMP binary (INVINCIBLE_QAMP_TEST_BIN).`);
const kata = available && docker("run", "--rm", "--name", `${PREFIX}kata-probe`, "--runtime", KATA_RUNTIME, "--network", "none", DEFAULT_IMAGE, "true").status === 0;
if (available && !kata) console.log(`${import.meta.file}: its Kata half SKIPPED, unverified: the Docker host runs no Kata microVM.`);

const dir = mkdtempSync(join(tmpdir(), PREFIX));
afterAll(() => {
  drop();
  rmSync(dir, { recursive: true, force: true });
});

/** Every container and volume of this run's, removed by its own name: never by a pattern. */
function drop(): void {
  if (!available) return;
  const named = (out: string) => out.split("\n").map((line) => line.trim()).filter((name) => name.startsWith(PREFIX));
  for (const name of named(docker("ps", "-a", "--filter", `name=^${PREFIX}`, "--format", "{{.Names}}").stdout)) docker("rm", "-f", name);
  for (const name of named(docker("volume", "ls", "--filter", `name=^${PREFIX}`, "--format", "{{.Name}}").stdout)) docker("volume", "rm", "-f", name);
}

/** The docker a node of this run runs (see above): its log, a line per call, and its refusals beside it. */
function wrapper(runtime: "kata" | "runc"): { path: string; log: string } {
  const at = join(dir, runtime);
  mkdirSync(at);
  const log = join(at, "docker.log");
  writeFileSync(
    join(at, "docker"),
    `#!/bin/bash
# (When the node asked: before anything here, so that what this takes is never counted as the node's.)
asked=$(date +%s%3N)
REAL=${REAL}; PREFIX=${PREFIX}; LOG=${log}; RUNTIME=${runtime}
args=()
for a in "$@"; do args+=("\${a//invincible-sbx-/\${PREFIX}sbx-}"); done
refuse() { printf '%s %s\\n' "$(date +%s%3N)" "$1" >> "$LOG.refused"; echo "e2e docker: refused: $1" >&2; exit 125; }
case \${args[0]} in
  build|buildx|builder|rmi|tag|push|pull|load|save|import|commit|plugin|swarm|compose|context|login|logout|system) refuse "\${args[0]}";;
  network) case \${args[1]} in inspect|ls) ;; *) refuse "network \${args[1]}";; esac;;
  image) case \${args[1]} in inspect|ls) ;; *) refuse "image \${args[1]}";; esac;;
  volume|container) [ "\${args[1]}" = prune ] && refuse "\${args[0]} prune";;
esac
for a in "\${args[@]}"; do case $a in invincible-*) refuse "a name of a live node's kind: $a";; esac; done
if [ "$RUNTIME" = runc ] && [ "\${args[0]}" = run ]; then
  kept=(); skip=0
  for a in "\${args[@]}"; do
    if [ $skip = 1 ]; then skip=0; continue; fi
    if [ "$a" = --runtime ]; then skip=1; continue; fi
    case $a in --runtime=*) continue;; esac
    kept+=("$a")
  done
  args=("\${kept[@]}")
fi
all="$*"
kind=\${args[0]}
[ "$kind" = run ] && case $all in *"${LABEL}.task="*) kind=run-task;; esac
[ "$kind" = run ] || [ "$kind" = run-task ] || case $all in
  *given.bundle*) kind=take;; *"its workspace as it was given"*) kind=give;; *send-index*) kind=send;; *apply-index*) kind=apply;;
  *tree-index*) kind=tree;; *"no such receive"*) kind=receive;; *"tagged()"*) kind=pipe-end;; *"its gates run on the tree alone"*) kind=copy;;
  *gate-faker*|*PROFILE*) kind=work;; *"test -f result-real.txt"*) kind=gate;; *"> result-real.txt"*) kind=work;;
esac
printf '%s %s %s (+%s ms here)\\n' "$asked" "$kind" "$(printf '%q ' "\${args[@]:0:12}" | cut -c1-300)" "$(( $(date +%s%3N) - asked ))" >> "$LOG"
case \${args[0]} in
  ps|inspect) set -o pipefail; "$REAL" "\${args[@]}" | sed "s/\${PREFIX}sbx-/invincible-sbx-/g"; exit $?;;
  volume) case \${args[1]} in ls|inspect) set -o pipefail; "$REAL" "\${args[@]}" | sed "s/\${PREFIX}sbx-/invincible-sbx-/g"; exit $?;; esac;;
esac
exec "$REAL" "\${args[@]}"
`,
  );
  chmodSync(join(at, "docker"), 0o755);
  return { path: at, log };
}

/**
 * What the stand-in engineer runs, by the task's goal (its first word): the work, writing the gate's file; or one of two
 * ways a task could make its gate say it passed without it (the eighth fabric review's R8-3). It then says DONE, and the
 * reviewer passes whatever it is shown.
 */
const WORK = {
  TASK_REAL: "printf '%s\\n' real > result-real.txt",
  // The review's PoC (zz-rc8-handed-profile): a login profile whose python3 says each gate passed, and makes the end of
  // what the task left running a no-op, for each `bash -lc` the node runs in the task's VM.
  TASK_PROFILE: [
    "cat > \"$HOME/.bash_profile\" <<'PROFILE'",
    "python3() {",
    "  case \"$2\" in *'end_task(sys.argv[1])'*) return 0;; esac",
    "  if [ \"$1\" = -c ] && [ \"$3\" = gate ]; then echo '(the gate, as this task tells it: passed)'; return 0; fi",
    "  command python3 \"$@\"",
    "}",
    "PROFILE",
    "echo profile written",
  ].join("\n"),
  // A process that outlives the freeze's end, as one does whose command ended its own helper first (FABRIC.md says it
  // escapes that bound): it writes the gate's file in the task's worktree while a gate looks for it, and takes it away
  // after, so the tree read before the gates and the one brought back after them never have it.
  TASK_SURVIVOR: [
    "cat > \"$TMPDIR/gate-faker.sh\" <<'FAKER'",
    "while :; do",
    "  if grep -qa 'test -f result-real[.]txt' /proc/[0-9]*/cmdline 2>/dev/null; then",
    "    : > \"$1/result-real.txt\"",
    "    while grep -qa 'test -f result-real[.]txt' /proc/[0-9]*/cmdline 2>/dev/null; do sleep 0.01; done",
    "    rm -f \"$1/result-real.txt\"",
    "  fi",
    "  sleep 0.01",
    "done",
    "FAKER",
    "setsid bash \"$TMPDIR/gate-faker.sh\" \"$PWD\" </dev/null >/dev/null 2>&1 &",
    // (Its helper, the nearest of its ancestors that is a subreaper, ended: so it lists nothing this command started.)
    // ([S]: so that this command's own words, in its shell's command line, never match.)
    "p=$PPID; while [ \"$p\" -gt 1 ]; do if grep -qa 'PR_SET_CHILD_[S]UBREAPER' /proc/$p/cmdline 2>/dev/null; then kill -KILL $p; break; fi; p=$(cut -d' ' -f4 /proc/$p/stat); done",
    "echo started",
  ].join("\n"),
} as const;
type Work = keyof typeof WORK;
const fence = "```";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const sse = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    if (body.model === "reviewer") return sse({ content: "PASS\nThe gate passed after the work, and its evidence shows the file written." });
    if (body.model === "engineer") {
      const asked = JSON.stringify(body.messages);
      const command = WORK[(Object.keys(WORK) as Work[]).find((work) => asked.includes(`${work}:`)) ?? "TASK_REAL"];
      const worked = turns.some((m) => m.role === "assistant" || m.role === "tool");
      if (body.tools?.length && !worked) return sse({ tool_calls: [{ index: 0, id: "call_work", function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
      return sse({ content: worked ? "DONE\nThe file is written." : `${fence}sh\n${command}\n${fence}` });
    }
    return sse({ content: "1. Write the file.\n2. Check it.\nDone when: the gate passes." });
  },
});
afterAll(() => models.stop(true));

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
};

for (const runtime of ["kata", "runc"] as const) {
  describe.skipIf(!available || (runtime === "kata" && !kata))(`another node's task, end to end on real VMs: ${runtime === "kata" ? "Kata microVMs" : "containers (runc)"}`, () => {
    let pair: Pair;
    let log = "";
    /** The workspace socket this process had before: given back as the run ends, so no later file of the run sees this one's. */
    const socketBefore = process.env.INVINCIBLE_WORKSPACE_SOCKET;

    beforeAll(async () => {
      const bin = wrapper(runtime);
      log = bin.log;
      process.env.INVINCIBLE_WORKSPACE_SOCKET = join(dir, "no-workspace-helper.sock");
      // (The node runs the wrapper both ways: given as its engine, and as the binary its pipes, streams and collects spawn.)
      const wrapped: DockerRunner = async (args, timeoutMs) => {
        const proc = Bun.spawn([join(bin.path, "docker"), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        clearTimeout(timer);
        return { code, stdout, stderr };
      };
      pair = await startPair({ b: { capabilities: { ...sandboxCaps("beta"), cores: 16, memoryGb: 32 }, docker: wrapped, dockerBinary: join(bin.path, "docker"), sandboxNetworks: false, measure, shutdownGraceMs: 2_000 } });
      const { b, callB } = pair;
      await until(() => b.store.lww(`calibration:${b.identity.id}`) !== null, 15_000, "beta's calibration");
      await callB("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
      for (const role of ["planner", "engineer", "reviewer"]) await callB("setRoster", { role, models: [`stand-in/${role}`] });
      for (const role of ["planner", "engineer", "reviewer"]) await callB("setPrice", { model: `stand-in/${role}`, input: 1, output: 2 });
      await callB("saveAgent", { id: "ada", name: "Ada", role: "engineer", repository: "https://github.com/you/project" });
      await callB("grantHandoffs", { from: "alpha", to: "beta", agents: ["ada"], tools: ["fleet"], budgetUsdPerDay: 100 });
    });

    afterAll(async () => {
      await pair?.stop();
      drop();
      if (socketBefore === undefined) delete process.env.INVINCIBLE_WORKSPACE_SOCKET;
      else process.env.INVINCIBLE_WORKSPACE_SOCKET = socketBefore;
    });

    /** Ada's VM, and her repository in it as a clone would leave it, its origin her repository's (her VM has no network here: see above): made once. */
    let hers: Promise<{ herVm: string; madeMs: number; seededMs: number }> | null = null;
    const her = () =>
      (hers ??= (async () => {
        const began = Date.now();
        const { workspace } = await pair.callB<{ workspace: { id: string; network: string; isolation: string } }>("provisionAgent", { id: "ada", desktop: false });
        expect(workspace).toMatchObject({ network: "isolated", isolation: "vm" });
        const made = Date.now();
        const herVm = `${PREFIX}sbx-${workspace.id}`;
        const seeded = docker("exec", "--workdir", "/work", herVm, "bash", "-lc", "set -e; git init -q -b main /work/repo; cd /work/repo; printf 'the project\\n' > README.md; printf 'one\\n' > app.txt; git add -A; git -c user.name=Owner -c user.email=owner@example.test commit -q -m first; git remote add origin https://github.com/you/project; git rev-parse HEAD");
        expect([seeded.status, seeded.stderr.trim()]).toEqual([0, ""]);
        return { herVm, madeMs: made - began, seededMs: Date.now() - made };
      })());

    /** A task handed to beta's agent, whose work is `work`, followed to its end on alpha; its stages and calls printed. */
    async function handOff(work: Work) {
      const { callA } = pair;
      const { herVm, madeMs, seededMs } = await her();
      const handedAt = Date.now();
      const view = await callA<HandedView>("handTask", { node: "beta", goal: `${work}: write the file and prove it`, gates: ["test -f result-real.txt"], agent: "ada" });
      await until(async () => (await callA<HandedView>("handedTask", { id: view.id, after: 0 })).phase === "ended", 480_000, "the task ended");
      const seenAt = Date.now();
      const done = await callA<HandedView>("handedTask", { id: view.id, after: 0 });

      // Its stages, as alpha saw them come back and as beta's Docker was asked them.
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => {
        const [at, kind] = line.split(" ");
        return { at: Number(at), kind: kind!, line };
      });
      const first = (kind: string, after = 0) => calls.find((c) => c.kind === kind && c.at >= after)?.at;
      const last = (kind: string) => calls.filter((c) => c.kind === kind).at(-1)?.at;
      const taskVm = calls.find((c) => c.kind === "run-task" && c.at >= handedAt);
      const timeline: [string, number | undefined][] = [
        ["handed (alpha)", handedAt],
        ["task VM asked (run)", taskVm?.at],
        ["clone given (give)", first("give", handedAt)],
        ["clone made in it (take)", first("take", handedAt)],
        ["first gates' copy (copy)", first("copy", handedAt)],
        ["first gate, before the work", first("gate", handedAt)],
        ["the work's command", first("work", handedAt)],
        ["first bring-back (send)", first("send", handedAt)],
        ["last gates' copy", last("copy")],
        ["last bring-back's apply", last("apply")],
        ["last gate", last("gate")],
        ["review (trail)", done.trail.find((t) => t.text.startsWith("Review · "))?.at],
        ["ended on beta (alpha's view)", done.endedAt ?? undefined],
        ["ended, seen on alpha", seenAt],
      ];
      console.log(`\n${runtime}, ${work}: her VM ${madeMs} ms, her repository ${seededMs} ms (made once); from the hand-off:`);
      for (const [what, at] of timeline) console.log(`  ${at === undefined ? "    —" : `${String(at - handedAt).padStart(6)} ms`}  ${what}`);
      console.log(`  docker calls: ${calls.filter((c) => c.at >= handedAt).length}; trail:\n${done.trail.map((t) => `  ${String(t.at - handedAt).padStart(6)} ms  ${t.text.split("\n")[0]!.slice(0, 150)}`).join("\n")}`);
      // What the wrapper took itself, after the node asked (never counted above: each call is timed as it was asked).
      const here = calls.filter((c) => c.at >= handedAt).map((c) => Number(/\(\+(\d+) ms here\)$/.exec(c.line)?.[1] ?? 0));
      console.log(`  the wrapper's own time: at most ${Math.max(...here)} ms a call, ${here.reduce((a, b) => a + b, 0)} ms in all; the task VM's run +${/\(\+(\d+) ms here\)$/.exec(taskVm?.line ?? "")?.[1] ?? "?"} ms`);
      // Each call of the task's own, as it was asked: when, what, and in which VM (hers, or the task's).
      const vmOf = (line: string) => (line.includes(herVm) ? "hers" : new RegExp(`${PREFIX}sbx-[0-9a-f]+`).test(line) ? "task's" : "");
      const own = calls.filter((c) => c.at >= handedAt && !["ps", "inspect", "info", "version", "image", "volume", "update", "stats"].includes(c.kind));
      console.log(`  its calls:\n${own.map((c) => `  ${String(c.at - handedAt).padStart(6)} ms  ${c.kind.padEnd(9)} ${vmOf(c.line).padEnd(6)} ${c.line.split(" ").slice(2, 9).join(" ").slice(0, 110)}`).join("\n")}`);

      // Nothing of anything else's was asked of Docker, and nothing reached it but through the wrapper.
      expect(existsSync(`${log}.refused`) ? readFileSync(`${log}.refused`, "utf8") : "").toBe("");
      if (STRAY) expect(existsSync(STRAY) ? readFileSync(STRAY, "utf8") : "").toBe("");
      // Its work ran in a VM of its own beside hers, never in hers, and that VM is gone.
      expect(taskVm).toBeDefined();
      const workIn = calls.filter((c) => c.kind === "work" && c.at >= handedAt).map((c) => c.line);
      expect(workIn.length).toBeGreaterThan(0);
      expect(workIn.every((line) => !line.includes(herVm))).toBe(true);
      expect(docker("ps", "-a", "--filter", `label=${LABEL}.node=${pair.b.identity.id}`, "--filter", `label=${LABEL}.task`, "--format", "{{.Names}}").stdout.trim()).toBe("");
      return { done, herVm, gates: done.trail.filter((t) => t.text.startsWith("Gate ")).map((t) => t.text.split("\n").slice(0, 2).join(" / ").slice(0, 200)) };
    }

    test("a task handed to beta's agent runs in a VM of its own beside hers, through its gates, review and bring-back, and comes back Proven", async () => {
      const { done, herVm } = await handOff("TASK_REAL");
      // Done, and Proven by beta's own signature: its gate failed before the work and passes after, another model reviewed.
      expect(done).toMatchObject({ phase: "ended", status: "done", agent: { id: "ada", name: "Ada" }, error: null });
      expect(done.proof).toEqual({ state: "checked", verified: true, ended: "done", proof: { before: [1], after: [0], review: "pass", sameModel: false } });
      // Its changes came back to her worktree, and were read and kept there.
      const there = (await pair.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === done.task);
      expect(there).toMatchObject({ status: "done", verified: true, assignee: "ada" });
      expect(docker("exec", herVm, "cat", `/work/tasks/${done.task}/result-real.txt`).stdout).toBe("real\n");
      expect(done.output).toContain("Changes: 1 file");
    });

    /*
     * The eighth fabric review's R8-3: each node command in the task's VM ran as `bash -lc`, under the login profile the
     * task writes there, so a task chose its gates' verdict. Now none reads a profile, the helper is the VM's own python3
     * by its path, and its gates run as their own user on a copy of the tree: what each says is what its gate did.
     */
    test("R8-3: a task whose login profile says its gates pass comes back as its gates find it: not verified", async () => {
      const { done, herVm, gates } = await handOff("TASK_PROFILE");
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      // (Checked against beta's signature, as any: what beta says is that its gate failed, so not verified.)
      expect(done.proof).toMatchObject({ state: "checked", verified: false, proof: { before: [1], after: [1] } });
      expect(gates.every((gate) => !gate.includes("as this task tells it"))).toBe(true);
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
    });

    test("R8-3: a process the freeze's end misses can't make a gate pass: the gates run as their own user, on a copy no process of the task's can reach", async () => {
      const { done, herVm, gates } = await handOff("TASK_SURVIVOR");
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      // (Checked against beta's signature, as any: what beta says is that its gate failed, so not verified.)
      expect(done.proof).toMatchObject({ state: "checked", verified: false, proof: { before: [1], after: [1] } });
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
    });
  });
}
