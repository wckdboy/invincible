import { describe, expect, test } from "bun:test";
import { LABEL, SandboxError, SandboxHost, type DockerRunner, type Workspaces } from "../src/index.ts";

/*
 * What a command in a VM asks Docker before it runs (speed, 28 November 2026). Every command an agent runs went through
 * the node's exec route, which looked its sandbox up (`docker info`, `docker ps`, `docker inspect`, and on a live node the
 * workspace helper's sizes), and then through `exec`, which looked it up again the same way: 75 of a task's 87 docker
 * calls, and 59 % of its time with models that answer at once (Ultra, Kata). Now a command asks once: `docker ps` and
 * `docker inspect`, as fresh as before (nothing is kept between commands), and nothing of the helper, whose sizes a
 * command doesn't show. Whoever runs it holds it to whose it is on that same look (`check`), before anything else is said
 * of it, as the route did.
 */

const ID = "0123456789";

function host(opts: { status?: string; workspaces?: boolean } = {}) {
  const asked: string[] = [];
  let stats = 0;
  const labels: Record<string, string> = {
    [LABEL]: "1",
    [`${LABEL}.id`]: ID,
    [`${LABEL}.node`]: "test",
    [`${LABEL}.run`]: "arm.ada",
    [`${LABEL}.network`]: "isolated",
    [`${LABEL}.ephemeral`]: "false",
    [`${LABEL}.isolation`]: "vm",
    [`${LABEL}.disk`]: "20",
  };
  const runner: DockerRunner = async (args) => {
    asked.push(args[0]!);
    if (args[0] === "info") return { code: 0, stdout: "29.0.0", stderr: "" };
    if (args[0] === "ps") return { code: 0, stdout: ID, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels, Image: "invincible/sandbox:1" }, State: { Status: opts.status ?? "running" } }]), stderr: "" };
    return { code: 0, stdout: "done\n", stderr: "" };
  };
  const workspaces: Workspaces = {
    available: async () => true,
    create: async () => "/x",
    remove: async () => {},
    stats: async () => {
      stats++;
      return { totalBytes: 100 * 2 ** 30, freeBytes: 50 * 2 ** 30, images: [{ id: ID, sizeBytes: 25 * 2 ** 30, usedBytes: 3 * 2 ** 30, mounted: true, createdAt: 1, retained: true }] };
    },
  };
  const made = new SandboxHost({
    node: "test",
    tokens: { mint: () => ({ token: "test-token", info: { hash: "test-hash" } }), revoke: () => true },
    ledger: () => {},
    maxCpus: 4,
    maxMemoryGb: 4,
    runner,
    ...(opts.workspaces ? { workspaces } : {}),
  });
  return { host: made, asked, stats: () => stats };
}

describe("a command in a VM", () => {
  test("looks its sandbox up once, with docker ps and docker inspect alone, then runs", async () => {
    const h = host();
    expect((await h.host.exec(ID, ["true"])).stdout).toBe("done\n");
    expect(h.asked).toEqual(["ps", "inspect", "exec"]);
  });

  test("is held to whose it is on that same look, before it is said to be stopped, and runs nothing when it isn't theirs", async () => {
    const h = host({ status: "exited" });
    const seen: string[] = [];
    await expect(
      h.host.exec(ID, ["true"], 60, (sandbox) => {
        seen.push(sandbox.run);
        throw new SandboxError("that sandbox belongs to another run", 403);
      }),
    ).rejects.toThrow("that sandbox belongs to another run");
    expect(seen).toEqual(["arm.ada"]);
    expect(h.asked).toEqual(["ps", "inspect"]);
    // (Its own: then it is said to be stopped, as before.)
    await expect(h.host.exec(ID, ["true"], 60, () => {})).rejects.toThrow("sandbox is exited");
  });

  test("asks the workspace helper nothing, though a listing still says each workspace's use", async () => {
    const h = host({ workspaces: true });
    await h.host.exec(ID, ["true"]);
    expect(h.stats()).toBe(0);
    const [listed] = await h.host.list();
    expect(h.stats()).toBe(1);
    expect(listed!.disk).toEqual({ limitGb: 25, usedGb: 3 });
  });

  test("a sandbox Docker doesn't list is no sandbox of this node's, and its check isn't asked", async () => {
    const h = host();
    const checked: string[] = [];
    await expect(h.host.exec("9876543210", ["true"], 60, (s) => void checked.push(s.id))).rejects.toThrow("no such sandbox on this node");
    expect(checked).toEqual([]);
  });
});
