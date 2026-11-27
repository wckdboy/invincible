import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runArgs, type SandboxSpec } from "../src/index.ts";

/*
 * Layout 2 on real Docker (layout.ts): a VM that shares an agent's workspace alone (another node's task) mounts the
 * store's work/ tree alone, as runArgs mounts it, and no link the agent leaves in work/ reaches the store's home/ or its
 * notes/: not a relative ../home/…, not an absolute /home/agent/…, and not one swapped in after the VM mounted it. One
 * for a run on a seat of yours mounts the notes' tree too, inside a HOME of its own in memory, and no link the agent
 * leaves in its notes or its workspace reaches the rest of its HOME. Each through a Docker volume's subpaths and through
 * a workspace image's directories (here a host folder, bound as the helper's image is). A Linux host with Docker Engine
 * 26 or later; skipped, and so unverified, anywhere else.
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
    asAgent([`type=bind,src=${dir},dst=/work`], "rm -rf /work/work /work/home /work/notes");
    rmSync(dir, { recursive: true, force: true });
  }
});

const SECRET = "not-a-real-secret-sentinel";
const NOTE = "not-a-real-note-sentinel";
/** A one-off as the VMs' user, with nothing else of the host. */
const asAgent = (mounts: string[], script: string) =>
  docker("run", "--rm", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", ...mounts.flatMap((m) => ["--mount", m]), "invincible/sandbox:1", "sh", "-c", script);

const spec = (over: Partial<SandboxSpec>): SandboxSpec => ({
  id: "q5" + randomBytes(4).toString("hex"), run: "q5-escape", node: "test", image: "invincible/sandbox:1", network: "isolated", cpus: 1, memoryGb: 1, pidsLimit: 256,
  ttlMinutes: 10, ephemeral: true, providers: [], createdAt: 0, env: {}, isolation: "container", ...over,
});
const mountsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === "--mount");

const tmpfsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === "--tmpfs");

/** An agent's store in layout 2 (its workspace, its HOME with something in it and its notes' mountpoint, its notes), and the mounts of the agent's own VM on it. */
function layoutStore(kind: "volume" | "bind") {
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
  expect(asAgent([store], `mkdir -p /work/work /work/home/.memory/engram /work/notes && chmod 700 /work/home /work/notes && printf ${SECRET} > /work/home/secret && printf ${NOTE} > /work/notes/note && ln -s ../home/secret /work/work/rel && ln -s /home/agent/secret /work/work/abs && ln -s .. /work/work/up && ln -s ../notes/note /work/work/relnote && ln -s /home/agent/.memory/engram/note /work/work/absnote`).status).toBe(0);
  const shares = dir ? { sandbox: "agent", workspace: dir, tree: "work" as const } : { sandbox: "agent", volume, tree: "work" as const };
  const agentMounts = mountsOf(runArgs(spec({ ephemeral: false, layout: { path: "/usr/bin:/bin" }, ...(dir ? { workspace: dir } : {}) }))).map((m) => (dir ? m : m.replace(/src=invincible-sbx-[^,]+-work/, `src=${volume}`)));
  expect(agentMounts).toHaveLength(3);
  return { shares, agentMounts };
}

/** A VM as the host makes one that shares the store (runArgs: its mounts and its own memory), running; and a read in it. */
function sharingVm(args: string[]) {
  const name = `q5-escape-vm-${randomBytes(4).toString("hex")}`;
  made.containers.push(name);
  expect(docker("run", "--detach", "--name", name, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
    ...tmpfsOf(args).flatMap((t) => ["--tmpfs", t]), ...mountsOf(args).flatMap((m) => ["--mount", m]), "invincible/sandbox:1", "sleep", "300").status).toBe(0);
  return (path: string) => docker("exec", name, "sh", "-c", `cat ${path} 2>/dev/null || true`).stdout;
}

const ownHome = { path: "/usr/bin:/bin:/home/agent/.local/bin" };

for (const kind of ["volume", "bind"] as const) {
  describe.skipIf(!available)(`a VM sharing an agent's workspace, through a ${kind === "volume" ? "volume's subpaths" : "workspace image's directories"}`, () => {
    test("another node's task's reaches nothing of its HOME or its notes: not by a path, a relative link, an absolute link, or a link swapped in after it mounted", () => {
      const { shares, agentMounts } = layoutStore(kind);
      // The VM that shares its workspace alone, mounted as the host mounts one, its own HOME empty.
      const args = runArgs(spec({ shares, ownHome }));
      expect(mountsOf(args)).toHaveLength(1);
      const read = sharingVm(args);
      for (const path of ["/work/home/secret", "/work/rel", "/work/abs", "/work/up/home/secret", "/work/../home/secret", "/work/relnote", "/work/absnote", "/work/up/notes/note", "/work/../notes/note", "/home/agent/secret", "/home/agent/.memory/engram/note"]) expect([path, read(path)]).toEqual([path, ""]);
      // Swapped in after it mounted, by the agent's own VM, which has all three trees.
      expect(asAgent(agentMounts, "rm -f /work/rel && ln -s ../home/secret /work/rel && ln -s /home/agent/secret /work/late && ln -s ../../home /work/upper && ln -s /home/agent/.memory/engram/note /work/latenote").status).toBe(0);
      for (const path of ["/work/rel", "/work/late", "/work/upper/secret", "/work/upper/agent/secret", "/work/latenote"]) expect([path, read(path)]).toEqual([path, ""]);
      // (The agent's own VM reads its HOME, and its notes where ENGRAM_DATA_DIR points, as it should: the store is as made.)
      expect(asAgent(agentMounts, "cat /home/agent/secret").stdout).toBe(SECRET);
      expect(asAgent(agentMounts, "cat /home/agent/.memory/engram/note").stdout).toBe(NOTE);
    });

    test("a run on a seat's has the agent's notes where they are kept, and nothing else of its HOME: not through a link left in its notes or its workspace", () => {
      const { shares, agentMounts } = layoutStore(kind);
      // Links the agent leaves in its notes, from its own VM: up to its HOME, and to it by an absolute path.
      expect(asAgent(agentMounts, "ln -s ../../secret /home/agent/.memory/engram/up && ln -s /home/agent/secret /home/agent/.memory/engram/abs && ln -s ../../../work/../home /home/agent/.memory/engram/far").status).toBe(0);
      const args = runArgs(spec({ shares: { ...shares, notes: true }, ownHome }));
      expect(mountsOf(args)).toHaveLength(2);
      const read = sharingVm(args);
      // Its notes, where ENGRAM_DATA_DIR points in its own HOME.
      expect(read("/home/agent/.memory/engram/note")).toBe(NOTE);
      for (const path of ["/home/agent/secret", "/home/agent/.memory/engram/up", "/home/agent/.memory/engram/abs", "/home/agent/.memory/engram/far/secret", "/home/agent/.memory/engram/../../secret", "/work/rel", "/work/abs", "/work/up/home/secret", "/work/relnote"]) expect([path, read(path)]).toEqual([path, ""]);
      // A link swapped into its notes after it mounted reaches no further.
      expect(asAgent(agentMounts, "rm -f /home/agent/.memory/engram/up && ln -s ../../secret /home/agent/.memory/engram/up && ln -s /home/agent/secret /home/agent/.memory/engram/late").status).toBe(0);
      for (const path of ["/home/agent/.memory/engram/up", "/home/agent/.memory/engram/late"]) expect([path, read(path)]).toEqual([path, ""]);
    });
  });
}
