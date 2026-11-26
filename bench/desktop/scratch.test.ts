import { describe, expect, test } from "bun:test";
import { execArgs, runArgs, type SandboxSpec } from "../../packages/sandbox/src/spec.ts";
import { SandboxHost } from "../../packages/sandbox/src/host.ts";
import { fromScratch, scratchArgs, scratchNames, scratchRunner, ScratchRefusal, type Spawn } from "./scratch.ts";

/*
 * The bench's Docker gives everything it makes names of its own: on a sandbox host a live node runs beside it, and must never
 * list, keep or remove a VM of the bench's, nor the bench one of the node's. Held here with the node's own run and
 * exec arguments, and its own SandboxHost against a Docker stand-in that writes down what it was asked.
 */

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  id: "0123456789",
  run: "arm.team.0123456789.bench",
  node: "bench",
  image: "invincible/desktop:1",
  network: "isolated",
  cpus: 1,
  memoryGb: 4,
  pidsLimit: 1024,
  ttlMinutes: 120,
  ephemeral: false,
  providers: [],
  createdAt: 1,
  env: {},
  isolation: "vm",
  ...over,
});

describe("the bench's names", () => {
  test("a VM the node would make is made under the bench's label, name, volume and image, with its hardening as it is", () => {
    const node = runArgs(spec());
    const bench = scratchArgs(node, "c1");
    expect(bench.join(" ")).not.toMatch(/invincible/);
    expect(bench).toContain("c1-sbx-0123456789");
    expect(bench).toContain("type=volume,src=c1-sbx-0123456789-work,dst=/work");
    expect(bench).toContain("dev.c1.id=0123456789");
    expect(bench.slice(-3)).toEqual(["c1/desktop:1", "sleep", "infinity"]);
    // Every flag that isn't a name is the node's own: the bench measures the VM the node makes.
    expect(bench.length).toBe(node.length);
    for (const flag of ["--read-only", "--cap-drop", "ALL", "no-new-privileges:true", "--user", "1000:1000", "--runtime", "io.containerd.kata.v2", "--network", "none"]) expect(bench).toContain(flag);
  });

  test("an exec names the bench's container, and what it runs in the VM is passed exactly as it was", () => {
    const node = execArgs("0123456789", ["sh", "-c", "echo invincible-sbx-x dev.invincible invincible/desktop:1"], 60);
    const bench = scratchArgs(node, "c1");
    const at = node.indexOf("invincible-sbx-0123456789");
    expect(bench[at]).toBe("c1-sbx-0123456789");
    expect(bench.slice(at + 1)).toEqual(node.slice(at + 1));
    expect(scratchArgs(["exec", "--interactive", "--env", "A=invincible", "--workdir", "/work", "invincible-sbx-0123456789", "true"], "c1")).toEqual(["exec", "--interactive", "--env", "A=invincible", "--workdir", "/work", "c1-sbx-0123456789", "true"]);
  });

  test("listing, inspecting and removing name only the bench's things", () => {
    expect(scratchArgs(["ps", "-aq", "--filter", "label=dev.invincible=1", "--filter", "label=dev.invincible.node=bench"], "c1")).toEqual(["ps", "-aq", "--filter", "label=dev.c1=1", "--filter", "label=dev.c1.node=bench"]);
    expect(scratchArgs(["rm", "--force", "--volumes", "invincible-sbx-0123456789"], "c1")).toEqual(["rm", "--force", "--volumes", "c1-sbx-0123456789"]);
    expect(scratchArgs(["volume", "rm", "--force", "invincible-sbx-0123456789-work"], "c1")).toEqual(["volume", "rm", "--force", "c1-sbx-0123456789-work"]);
    expect(scratchArgs(["image", "inspect", "invincible/desktop:1", "--format", "{{.Id}}"], "c1")).toEqual(["image", "inspect", "c1/desktop:1", "--format", "{{.Id}}"]);
    expect(scratchArgs(["ps", "-a", "--filter", "label=dev.invincible=1", "--format", '{{.Label "dev.invincible.id"}}'], "c1")).toEqual(["ps", "-a", "--filter", "label=dev.c1=1", "--format", '{{.Label "dev.c1.id"}}']);
  });

  test("what Docker says back is in the node's names again, and nothing else in it is touched", () => {
    const inspected = JSON.stringify([{ Id: "c1a2b3c1", Name: "/c1-sbx-0123456789", Config: { Image: "c1/desktop:1", Labels: { "dev.c1": "1", "dev.c1.id": "0123456789", "dev.c1.run": "arm.team.0123456789.bench" } } }]);
    const read = JSON.parse(fromScratch(inspected, "c1"));
    expect(read[0]).toEqual({ Id: "c1a2b3c1", Name: "/invincible-sbx-0123456789", Config: { Image: "invincible/desktop:1", Labels: { "dev.invincible": "1", "dev.invincible.id": "0123456789", "dev.invincible.run": "arm.team.0123456789.bench" } } });
  });

  test("it never joins a network, builds, prunes or kills, and never names a live node's things", () => {
    const refused = (args: string[]) => expect(() => scratchArgs(args, "c1")).toThrow(ScratchRefusal);
    refused(runArgs(spec({ network: "gateway" })));
    refused(runArgs(spec({ network: "online" })));
    refused(["run", "--network=invincible-net", "c1/desktop:1"]);
    refused(["run", "--name", "x", "debian:trixie-slim", "true"]);
    refused(["network", "create", "x"]);
    refused(["build", "-t", "invincible/desktop:1", "."]);
    refused(["image", "prune", "-af"]);
    refused(["builder", "prune"]);
    refused(["system", "prune"]);
    refused(["kill", "invincible-sbx-0123456789"]);
    // Another node's on the same host, named its own way: never the bench's to touch.
    refused(["rm", "--force", "other-sbx-9876543210"]);
    refused(["exec", "other-sbx-9876543210", "true"]);
    refused(["ps", "-aq", "--filter", "label=dev.other=1"]);
    refused(["inspect", "xc1-sbx-0123456789"]);
    expect(() => scratchNames("invincible")).toThrow(ScratchRefusal);
    expect(() => scratchNames("C1")).toThrow(ScratchRefusal);
  });

  test("the node's own SandboxHost, given the runner, makes, finds, runs in and removes a VM under the bench's names alone", async () => {
    const asked: string[][] = [];
    // A Docker that holds one container, as Docker would answer for it.
    let made = false;
    const docker: Spawn = async (args) => {
      asked.push(args);
      const [command] = args;
      if (command === "info") return { code: 0, stdout: "29.10.0\n", stderr: "" };
      if (command === "image") return { code: 0, stdout: "sha256:feed\n", stderr: "" };
      if (command === "volume") return { code: 0, stdout: "c1-sbx-x-work\n", stderr: "" };
      if (command === "run") {
        made = true;
        return { code: 0, stdout: "c1c1\n", stderr: "" };
      }
      if (command === "ps") return { code: 0, stdout: made ? "c1c1\n" : "", stderr: "" };
      if (command === "inspect") {
        const id = asked.find((a) => a[0] === "run")!.find((a) => a.startsWith("dev.c1.id="))!.split("=")[1]!;
        const labels = Object.fromEntries(asked.find((a) => a[0] === "run")!.flatMap((a, i, all) => (all[i - 1] === "--label" ? [a.split("=") as [string, string]] : [])));
        return { code: 0, stdout: JSON.stringify([{ Id: "c1c1", Name: `/c1-sbx-${id}`, Config: { Image: "c1/desktop:1", Labels: labels }, State: { Status: "running" }, HostConfig: { NanoCpus: 1e9, Memory: 4 * 2 ** 30 } }]), stderr: "" };
      }
      if (command === "exec") return { code: 0, stdout: "invincible-sbx-x dev.invincible\n", stderr: "" };
      if (command === "rm") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `not in this stand-in: ${args.join(" ")}` };
    };
    const host = new SandboxHost({ node: "bench", tokens: { mint: () => { throw new Error("an isolated VM has no lease"); }, revoke: () => false }, ledger: () => {}, maxCpus: 8, maxMemoryGb: 16, microVMs: true, workspaces: null, runner: scratchRunner("c1", docker) });
    const vm = await host.create({ network: "isolated", isolation: "vm", desktop: true, cpus: 1, memoryGb: 4, ttlMinutes: 60, persistent: true, run: "arm.team.0123456789.bench" });
    expect(vm.image).toBe("invincible/desktop:1");
    expect(vm.name).toBe(`invincible-sbx-${vm.id}`);
    // The VM's own output is its own: an exec's is never mapped.
    expect((await host.exec(vm.id, ["true"], 10)).stdout).toBe("invincible-sbx-x dev.invincible\n");
    expect(await host.destroy(vm.id, { approvedBy: "bench" })).toMatchObject({ verdict: "allow" });
    const said = asked.map((a) => a.join(" ")).join("\n");
    expect(said).not.toMatch(/invincible/);
    expect(said).toContain(`run --detach --name c1-sbx-${vm.id}`);
    expect(said).toContain(`rm --force --volumes c1-sbx-${vm.id}`);
  });
});
