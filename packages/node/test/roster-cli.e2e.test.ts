import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes } from "@galahad/core";
import { windowScope, windowsOf } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * `galahad roster` marks each model a spent window holds back, beside its name: a coding plan's window every model of
 * it, any other provider's the one model told to wait (windowScope, since 22 November 2026). Until then the listing
 * matched only a plan's window, so a router's model told to wait looked as ready as any other.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "roster-cli-test", cores: 2, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["git"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };

const root = mkdtempSync(join(tmpdir(), "galahad-roster-cli-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon | undefined;

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function admin(name: "setProvider" | "setRoster", input: unknown): Promise<void> {
  const route = routes[name] as { method: string; path: string };
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
}

test("a spent window is marked on the models it holds back: a plan's on every model of it, a router's on its one model", async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: fakeDocker().runner, measure: false });

  await admin("setProvider", { id: "orcarouter", kind: "openai", baseUrl: "https://router.invalid/v1" });
  await admin("setRoster", { role: "planner", models: ["orcarouter/anthropic/claude-opus-5.5", "orcarouter/google/gemini-3.1-pro-preview"] });
  await admin("setRoster", { role: "engineer", models: ["opencode-go/deepseek-v4-pro", "opencode-go/glm-5.3"] });
  const windows = windowsOf(daemon.store);
  const router = windows.note(windowScope("orcarouter/anthropic/claude-opus-5.5"), "orcarouter → 429 rate limit reached for this model; try again in 2h")!;
  const plan = windows.note(windowScope("opencode-go/glm-5.3"), "opencode-go → 429 Go usage limit reached (5-hour, resets in 3h 10m). Upgrade or wait.")!;
  const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

  const run = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "roster", "--home", home.dir], { env: { ...process.env, GALAHAD_KEYSTORE: "file" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(err).toBe("");
  expect(code).toBe(0);
  const line = (role: string) => out.split("\n").find((l) => l.trimStart().startsWith(`${role} `)) ?? `(no ${role} line in: ${out})`;
  // The router's model told to wait, and not its other one.
  expect(line("planner")).toContain(`orcarouter/anthropic/claude-opus-5.5 (spent until ${hhmm(router.until)} UTC) → orcarouter/google/gemini-3.1-pro-preview`);
  expect(line("planner")).not.toContain("gemini-3.1-pro-preview (spent");
  // A plan's window, every model of it.
  expect(line("engineer")).toContain(`opencode-go/deepseek-v4-pro (coding only) (spent until ${hhmm(plan.until)} UTC) → opencode-go/glm-5.3 (coding only) (spent until ${hhmm(plan.until)} UTC)`);
}, 30_000);
