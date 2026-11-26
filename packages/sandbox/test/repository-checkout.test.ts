import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_SCRIPT, containerName, LABEL, SandboxHost, type LedgerEntryInput, type TokenMinter } from "../src/index.ts";

/*
 * A commit of a repository put in a trial's sandbox through the git gateway (a trial of your own work starts from
 * the commit its task began at). Docker is a stand-in that answers each command; no container, file or credential
 * is real. What's held: the lease reads one repository, lives inside the sandbox only for the fetch, never appears in
 * a command, an answer or the ledger, and is revoked once the fetch is over, whatever happened.
 */

const ID = "0123456789";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "/work/tasks/task-abc_def-1234";
const WIDGETS = { connector: "github", owner: "example", repo: "widgets" };
const lease = (n: number) => `test-only-checkout-lease-${n}`;

function trialHost(opts: { labels?: Record<string, string>; status?: string; fetch?: { code: number; stdout?: string; stderr?: string }; failWrite?: boolean } = {}) {
  const commands: string[][] = [];
  const minted: Parameters<TokenMinter["mint"]>[0][] = [];
  const revoked: string[] = [];
  const ledger: LedgerEntryInput[] = [];
  const events: string[] = [];
  const labels = {
    [LABEL]: "1", [`${LABEL}.id`]: ID, [`${LABEL}.node`]: "test", [`${LABEL}.quest`]: "g-mwk1abc",
    [`${LABEL}.network`]: "online", [`${LABEL}.ephemeral`]: "true", [`${LABEL}.isolation`]: "vm", [`${LABEL}.providers`]: "search",
    ...opts.labels,
  };
  const host = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16,
    tokens: {
      mint: (scope) => {
        minted.push(scope);
        events.push("mint");
        return { token: lease(minted.length), info: { hash: `test-only-checkout-hash-${minted.length}` } };
      },
      revoke: (hash) => { revoked.push(hash); events.push(`revoke:${hash}`); return true; },
    },
    ledger: (entry) => { ledger.push(entry); },
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "ps") return { code: 0, stdout: ID, stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels, Image: "galahad/sandbox:1" }, State: { Status: opts.status ?? "running" } }]), stderr: "" };
      if (args[0] === "exec" && args.includes("python3") && args.at(-1) !== BASE) {
        events.push("write");
        return opts.failWrite ? { code: 1, stdout: "", stderr: "no space left" } : { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "exec") {
        events.push("fetch");
        return { stdout: "", stderr: "", ...(opts.fetch ?? { code: 0, stdout: `${BASE}\n` }) };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { host, commands, minted, revoked, ledger, events };
}

describe("a repository checked out in a trial's sandbox", () => {
  test("its commit is fetched through the git gateway on a lease for that repository alone, read inside the sandbox and revoked after", async () => {
    const f = trialHost();
    expect(await f.host.checkoutRepository(ID, WIDGETS, BASE, ROOT)).toEqual({ commit: BASE });
    // One lease, for the one repository: short, and good for a fetch's few requests.
    expect(f.minted).toEqual([{ label: `sandbox:${ID}`, providers: ["git:github:example:widgets"], ttlMinutes: 15, maxRequests: 100 }]);
    expect(f.events).toEqual(["mint", "write", "fetch", "revoke:test-only-checkout-hash-1"]);
    // Written inside the sandbox as the knights' lease is: JSON in /work/.galahad-gateway.json, never a shell's configuration.
    const write = f.commands.find((args) => args[0] === "exec" && args.at(-1) !== BASE)!;
    expect(write.slice(0, 5)).toEqual(["exec", "--interactive", "--workdir", "/work", containerName(ID)]);
    const env = JSON.parse(Buffer.from(write.at(-1)!, "base64").toString());
    expect(env).toEqual({ GALAHAD_GATEWAY: "http://172.31.250.1:7779/gw", GALAHAD_TOKEN: lease(1), GALAHAD_REPO_URL: "http://172.31.250.1:7779/git/github/example/widgets.git" });
    // The fetch names the place and the commit, and reads the lease itself: the token is in no command of it.
    const fetch = f.commands.find((args) => args[0] === "exec" && args.at(-1) === BASE)!;
    expect(fetch.slice(-2)).toEqual([ROOT, BASE]);
    expect(fetch.join(" ")).not.toContain(lease(1));
    expect(fetch.join(" ")).toContain("/work/.galahad-gateway.json");
    // The ledger says what was read, where; never the lease or its hash.
    expect(f.ledger).toEqual([expect.objectContaining({ class: "read", resource: "sandbox.checkout", target: containerName(ID), quest: "g-mwk1abc", verdict: "allow" })]);
    expect(f.ledger[0]!.detail).toContain("example/widgets");
    expect(JSON.stringify(f.ledger)).not.toContain(lease(1));
    expect(JSON.stringify(f.ledger)).not.toContain("test-only-checkout-hash");
  });

  test("a commit that can't be fetched is said, and the lease is revoked all the same", async () => {
    // (Something printed the lease beside git's own words: what comes back says what git said, never the lease.)
    const f = trialHost({ fetch: { code: 1, stderr: `warning: shallow fetch\nfatal: remote error: upload-pack: not our ref ${BASE} (${lease(1)})` } });
    const refused = await f.host.checkoutRepository(ID, WIDGETS, BASE, ROOT).then(() => null, (error: Error & { status?: number }) => error);
    expect(refused?.status).toBe(424);
    expect(refused?.message).toMatch(/^couldn't fetch 0123456789ab of example\/widgets: fatal: remote error: upload-pack: not our ref/);
    expect(refused?.message).not.toContain(lease(1));
    expect(f.revoked).toEqual(["test-only-checkout-hash-1"]);
    expect(f.ledger).toEqual([]);
  });

  test("a lease that can't be written is revoked at once, and nothing is fetched", async () => {
    const f = trialHost({ failWrite: true });
    await expect(f.host.checkoutRepository(ID, WIDGETS, BASE, ROOT)).rejects.toMatchObject({ status: 424 });
    expect(f.events).toEqual(["mint", "write", "revoke:test-only-checkout-hash-1"]);
  });

  const refused: { name: string; labels?: Record<string, string>; status?: string; code: number; id?: string }[] = [
    { name: "a sandbox that isn't there", id: "9876543210", code: 404 },
    { name: "a knight's VM (it is given its repository as it is prepared)", labels: { [`${LABEL}.ephemeral`]: "false", [`${LABEL}.quest`]: "arm.team.abcdef0123.gareth" }, code: 409 },
    { name: "a sandbox with no network (it can't reach the gateway)", labels: { [`${LABEL}.network`]: "isolated" }, code: 409 },
    { name: "a sandbox that has stopped", status: "exited", code: 409 },
  ];
  test.each(refused)("refused before any lease: $name", async ({ labels, status, code, id }) => {
    const f = trialHost({ ...(labels ? { labels } : {}), ...(status ? { status } : {}) });
    await expect(f.host.checkoutRepository(id ?? ID, WIDGETS, BASE, ROOT)).rejects.toMatchObject({ status: code });
    expect(f.minted).toEqual([]);
    expect(f.commands.some((args) => args[0] === "exec")).toBe(false);
  });
});

/*
 * The script itself, really run with python3 and git (where they are), on a repository of three commits read
 * through `file://` in place of the gateway: only its lease's place differs from a sandbox's.
 */
describe("the checkout, really run", () => {
  const have = (cmd: string[]) => {
    try {
      return Bun.spawnSync(cmd).exitCode === 0;
    } catch {
      return false;
    }
  };
  const tools = have(["python3", "--version"]) && have(["git", "--version"]);

  function upstream() {
    const dir = mkdtempSync(join(tmpdir(), "galahad-checkout-"));
    const src = join(dir, "widgets");
    mkdirSync(src);
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", src, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a]).stdout.toString().trim();
    git("init", "-q");
    for (const n of [1, 2, 3]) {
      writeFileSync(join(src, "count.txt"), `${n}\n`);
      git("add", "-A");
      git("commit", "-qm", `commit ${n}`);
    }
    const leasePath = join(dir, "lease.json");
    writeFileSync(leasePath, JSON.stringify({ GALAHAD_TOKEN: "test-only-token", GALAHAD_REPO_URL: `file://${src}` }));
    // (In a sandbox the lease is /work/.galahad-gateway.json: here it is a file of the test's own.)
    const script = CHECKOUT_SCRIPT.replace("'/work/.galahad-gateway.json'", JSON.stringify(leasePath));
    const run = (root: string, commit: string) => Bun.spawnSync(["python3", "-c", script, root, commit]);
    return { dir, src, leasePath, run, base: git("rev-parse", "HEAD~1"), later: git("rev-parse", "HEAD") };
  }

  test.skipIf(!tools)("the commit is checked out, detached, with nothing after it and no remote; the lease is gone, and never in the repository", () => {
    const u = upstream();
    try {
      const root = join(u.dir, "work", "tasks", "task-abc_def-1234");
      const run = u.run(root, u.base);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString().trim()).toBe(u.base);
      const git = (...a: string[]) => Bun.spawnSync(["git", "-C", root, ...a]);
      expect(git("rev-parse", "HEAD").stdout.toString().trim()).toBe(u.base);
      expect(readFileSync(join(root, "count.txt"), "utf8")).toBe("2\n");
      // What came after the commit isn't there to be read, and there is nowhere to fetch it from.
      expect(git("cat-file", "-e", u.later).exitCode).not.toBe(0);
      expect(git("remote").stdout.toString().trim()).toBe("");
      expect(existsSync(u.leasePath)).toBe(false);
      expect(readFileSync(join(root, ".git", "config"), "utf8")).not.toContain("test-only-token");
    } finally {
      rmSync(u.dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!tools)("a commit the repository doesn't have fails, and the lease is gone all the same", () => {
    const u = upstream();
    try {
      const run = u.run(join(u.dir, "work", "repo"), "f".repeat(40));
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).not.toContain("test-only-token");
      expect(existsSync(u.leasePath)).toBe(false);
    } finally {
      rmSync(u.dir, { recursive: true, force: true });
    }
  });
});
