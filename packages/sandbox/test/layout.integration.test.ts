import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runArgs, type SandboxSpec } from "../src/index.ts";

/*
 * Layout 2 on real Docker (layout.ts): a VM that shares an agent's workspace (a run on a seat, another node's task)
 * mounts the store's work/ tree alone, as runArgs mounts it, and no link the agent leaves in work/ reaches the store's
 * home/: not a relative ../home/…, not an absolute /home/agent/…, and not one swapped in after the VM mounted it. Each
 * through a Docker volume's subpaths and through a workspace image's directories (here a host folder, bound as the
 * helper's image is). A Linux host with Docker Engine 26 or later; skipped, and so unverified, anywhere else.
 */

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const engine = process.platform === "linux" ? Number.parseInt(docker("version", "--format", "{{.Server.Version}}").stdout ?? "", 10) : Number.NaN;
const available = Number.isFinite(engine) && engine >= 26 && docker("image", "inspect", "invincible/sandbox:1").status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, Docker Engine 26 or later, and invincible/sandbox:1.`);

const made: { volumes: string[]; containers: string[]; dirs: string[] } = { volumes: [], containers: [], dirs: [] };
afterAll(() => {
  for (const name of made.containers) docker("rm", "-f", name);
  for (const name of made.volumes) docker("volume", "rm", "-f", name);
  // (What the VMs' user made in a folder is that user's to remove: a one-off removes it first.)
  for (const dir of made.dirs) {
    asAgent([`type=bind,src=${dir},dst=/work`], "rm -rf /work/work /work/home");
    rmSync(dir, { recursive: true, force: true });
  }
});

const SECRET = "not-a-real-secret-sentinel";
/** A one-off as the VMs' user, with nothing else of the host. */
const asAgent = (mounts: string[], script: string) =>
  docker("run", "--rm", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", ...mounts.flatMap((m) => ["--mount", m]), "invincible/sandbox:1", "sh", "-c", script);

const spec = (over: Partial<SandboxSpec>): SandboxSpec => ({
  id: "q5" + randomBytes(4).toString("hex"), run: "q5-escape", node: "test", image: "invincible/sandbox:1", network: "isolated", cpus: 1, memoryGb: 1, pidsLimit: 256,
  ttlMinutes: 10, ephemeral: true, providers: [], createdAt: 0, env: {}, isolation: "container", ...over,
});
const mountsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === "--mount");

for (const kind of ["volume", "bind"] as const) {
  describe.skipIf(!available)(`a VM sharing an agent's workspace, through a ${kind === "volume" ? "volume's subpaths" : "workspace image's directories"}`, () => {
    test("reaches nothing of its HOME: not by a path, a relative link, an absolute link, or a link swapped in after it mounted", () => {
      // The agent's store, in layout 2: its workspace, and its HOME with something in it.
      const volume = `q5-escape-${randomBytes(4).toString("hex")}`;
      const dir = kind === "bind" ? mkdtempSync(join(tmpdir(), "q5-escape-")) : null;
      if (dir) {
        made.dirs.push(dir);
        // (Its user is the VMs' as a workspace image's root is; a folder of the test's own is open to it instead.)
        chmodSync(dir, 0o777);
      } else {
        made.volumes.push(volume);
        expect(docker("volume", "create", volume).status).toBe(0);
      }
      const store = dir ? `type=bind,src=${dir},dst=/work` : `type=volume,src=${volume},dst=/work`;
      expect(asAgent([store], `mkdir -p /work/work /work/home && chmod 700 /work/home && printf ${SECRET} > /work/home/secret && ln -s ../home/secret /work/work/rel && ln -s /home/agent/secret /work/work/abs && ln -s .. /work/work/up`).status).toBe(0);
      // The VM that shares it, mounted as the host mounts one (runArgs), its own HOME empty.
      const shares = dir ? { sandbox: "agent", workspace: dir, tree: "work" as const } : { sandbox: "agent", volume, tree: "work" as const };
      const mounts = mountsOf(runArgs(spec({ shares })));
      expect(mounts).toHaveLength(1);
      const name = `q5-escape-vm-${randomBytes(4).toString("hex")}`;
      made.containers.push(name);
      expect(docker("run", "--detach", "--name", name, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
        "--tmpfs", "/home/agent:rw,uid=1000,gid=1000,mode=0700", ...mounts.flatMap((m) => ["--mount", m]), "invincible/sandbox:1", "sleep", "300").status).toBe(0);
      const read = (path: string) => docker("exec", name, "sh", "-c", `cat ${path} 2>/dev/null || true`).stdout;
      for (const path of ["/work/home/secret", "/work/rel", "/work/abs", "/work/up/home/secret", "/work/../home/secret"]) expect([path, read(path)]).toEqual([path, ""]);
      // Swapped in after it mounted, by the agent's own VM, which has both trees.
      const agentMounts = dir ? [`type=bind,src=${dir}/work,dst=/work`, `type=bind,src=${dir}/home,dst=/home/agent`] : [`type=volume,src=${volume},dst=/work,volume-subpath=work`, `type=volume,src=${volume},dst=/home/agent,volume-subpath=home`];
      expect(asAgent(agentMounts, "rm -f /work/rel && ln -s ../home/secret /work/rel && ln -s /home/agent/secret /work/late && ln -s ../../home /work/upper").status).toBe(0);
      for (const path of ["/work/rel", "/work/late", "/work/upper/secret", "/work/upper/agent/secret"]) expect([path, read(path)]).toEqual([path, ""]);
      // (The agent's own VM reads its HOME, as it should: the store is as made.)
      expect(asAgent(agentMounts, "cat /home/agent/secret").stdout).toBe(SECRET);
    });
  });
}
