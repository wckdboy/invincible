import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetProblem, parseStats, WorkspaceHelper, type WorkspaceStats } from "../src/index.ts";

/*
 * Sandbox disk limits: the helper's answers, the budget rule, and the client that
 * talks to the helper over its socket (against a stand-in on a temp socket).
 */

const GIB = 2 ** 30;
const disk = (freeGb: number, images: [number, number][] = [], totalGb = 1800): WorkspaceStats => ({
  totalBytes: totalGb * GIB,
  freeBytes: freeGb * GIB,
  images: images.map(([size, used], i) => ({ id: `${i}`.padStart(10, "0"), sizeBytes: size * GIB, usedBytes: used * GIB, mounted: true, createdAt: 0 })),
});

describe("the helper's stats", () => {
  test("parse: the filesystem, then one line per workspace; junk is ignored", () => {
    const stats = parseStats("ok 1932735283200 1717986918400\n0123456789 21474836480 1048576 1 1762780000\n../etc 1 1 1 1\n\n");
    expect(stats).toEqual({
      totalBytes: 1932735283200,
      freeBytes: 1717986918400,
      images: [{ id: "0123456789", sizeBytes: 21474836480, usedBytes: 1048576, mounted: true, createdAt: 1762780000000 }],
    });
    expect(() => parseStats("error cannot prepare")).toThrow(/unexpected stats/);
  });

  test("the new retention column is explicit, while legacy rows keep their original shape", () => {
    const stats = parseStats("ok 100 80\n0123456789 10 1 0 100 1\nabcdef0123 10 2 1 200 0\n9876543210 10 3 1 300\n");
    expect(stats.images).toEqual([
      { id: "0123456789", sizeBytes: 10, usedBytes: 1, mounted: false, createdAt: 100000, retained: true },
      { id: "abcdef0123", sizeBytes: 10, usedBytes: 2, mounted: true, createdAt: 200000, retained: false },
      { id: "9876543210", sizeBytes: 10, usedBytes: 3, mounted: true, createdAt: 300000 },
    ]);
  });
});

describe("the disk budget", () => {
  test("a workspace fits when every other one could fill up and the reserve stays free", () => {
    expect(budgetProblem(disk(1600), 20)).toBeNull();
    // 1800 GB disk → 180 GB reserve. 300 GB free, two workspaces promised 100 GB more growth: 20 GB left.
    expect(budgetProblem(disk(300, [[60, 10], [60, 10]]), 20)).toBeNull();
    expect(budgetProblem(disk(300, [[60, 10], [60, 10]]), 21)).toMatch(/doesn't fit: 20 GB is left .* 180 GB stays free/);
  });
  test("used space is already counted as used: only the growth still to come is promised", () => {
    expect(budgetProblem(disk(250, [[50, 50]]), 50)).toBeNull();
    expect(budgetProblem(disk(250, [[50, 0]]), 50)).not.toBeNull();
  });
  test("small disks keep at least 20 GB free", () => {
    expect(budgetProblem(disk(40, [], 100), 20)).toBeNull();
    expect(budgetProblem(disk(39, [], 100), 20)).not.toBeNull();
  });
});

const unixSockets = process.platform !== "win32";
describe.skipIf(!unixSockets)("talking to the helper", () => {
  // A skipped block's body still runs (to collect it) but its afterAll doesn't: set nothing up.
  if (!unixSockets) return;
  const dir = mkdtempSync(join(tmpdir(), "galahad-ws-"));
  const path = join(dir, "helper.sock");
  const heard: string[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        const line = new TextDecoder().decode(chunk).trim();
        heard.push(line);
        const [verb, id] = line.split(" ");
        socket.end(
          verb === "ping" ? "ok\n"
          : verb === "create" ? `ok /var/lib/galahad-workspaces/${id}\n`
          : verb === "stats-v2" ? "ok 100 50\n0123456789 10 1 1 1762780000 1\n"
          : verb === "remove" && id === "ffffffffff" ? "error cannot unmount\n"
          : "ok\n",
        );
      },
    },
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("one line out, the answer back; refusals become errors", async () => {
    const helper = new WorkspaceHelper(path, 5000);
    expect(await helper.available()).toBe(true);
    expect(await helper.create("0123456789", 20)).toBe("/var/lib/galahad-workspaces/0123456789");
    expect((await helper.stats()).images[0]).toMatchObject({ id: "0123456789", retained: true });
    await helper.remove("0123456789");
    await expect(helper.remove("ffffffffff")).rejects.toThrow(/cannot unmount/);
    expect(heard).toEqual(["ping", "create 0123456789 20", "stats-v2", "remove 0123456789", "remove ffffffffff"]);
  });

  test("resume and owner-approved removal use separate, exact helper commands", async () => {
    const helper = new WorkspaceHelper(path, 5000);
    const before = heard.length;
    await helper.retain("0123456789");
    await helper.mount("0123456789");
    await helper.removeRetained("0123456789");
    expect(heard.slice(before)).toEqual(["retain 0123456789", "mount 0123456789", "remove-owned 0123456789"]);
  });

  test("growing a workspace is one exact line: its id and its new size", async () => {
    const helper = new WorkspaceHelper(path, 5000);
    const before = heard.length;
    await helper.grow("0123456789", 30);
    expect(heard.slice(before)).toEqual(["grow 0123456789 30"]);
  });

  test("nothing that isn't an id or a size is ever sent", async () => {
    const helper = new WorkspaceHelper(path, 5000);
    const before = heard.length;
    await expect(helper.grow("../../etc", 30)).rejects.toThrow(/bad workspace/);
    await expect(helper.grow("0123456789", 2.5)).rejects.toThrow(/bad workspace/);
    await expect(helper.grow("0123456789", 0)).rejects.toThrow(/bad workspace/);
    await expect(helper.grow("0123456789", 5000)).rejects.toThrow(/bad workspace/);
    await expect(helper.create("../../etc", 20)).rejects.toThrow(/bad workspace/);
    await expect(helper.create("0123456789", 1.5)).rejects.toThrow(/bad workspace/);
    await expect(helper.remove("0123456789 ; rm -rf /")).rejects.toThrow(/bad workspace/);
    await expect(helper.mount("../../etc")).rejects.toThrow(/bad workspace/);
    await expect(helper.retain("0123456789\nremove-owned 9876543210")).rejects.toThrow(/bad workspace/);
    await expect(helper.removeRetained("0123456789 extra")).rejects.toThrow(/bad workspace/);
    expect(heard).toHaveLength(before);
  });

  test("an old helper falls back to legacy stats but cannot silently retain or remount workspaces", async () => {
    const legacyHeard: string[] = [];
    const legacyPath = join(dir, "legacy.sock");
    const legacy = Bun.listen({ unix: legacyPath, socket: {
      data(socket, chunk) {
        const line = new TextDecoder().decode(chunk).trim();
        legacyHeard.push(line);
        socket.end(line === "stats" ? "ok 100 50\n0123456789 10 1 1 100\n" : "error unknown command\n");
      },
    } });
    try {
      const helper = new WorkspaceHelper(legacyPath, 5000);
      expect(await helper.stats()).toEqual({ totalBytes: 100, freeBytes: 50,
        images: [{ id: "0123456789", sizeBytes: 10, usedBytes: 1, mounted: true, createdAt: 100000 }],
      });
      await expect(helper.retain("0123456789")).rejects.toThrow("unknown command");
      await expect(helper.mount("0123456789")).rejects.toThrow("unknown command");
      expect(legacyHeard).toEqual(["stats-v2", "stats", "retain 0123456789", "mount 0123456789"]);
    } finally { legacy.stop(true); }
  });

  test("a new helper's actual stats failure is surfaced without falling back", async () => {
    const refusedHeard: string[] = [];
    const refusedPath = join(dir, "refused.sock");
    const refused = Bun.listen({ unix: refusedPath, socket: {
      data(socket, chunk) {
        refusedHeard.push(new TextDecoder().decode(chunk).trim());
        socket.end("error cannot prepare workspace root\n");
      },
    } });
    try {
      await expect(new WorkspaceHelper(refusedPath, 5000).stats()).rejects.toThrow("cannot prepare workspace root");
      expect(refusedHeard).toEqual(["stats-v2"]);
    } finally { refused.stop(true); }
  });

  test("no helper: not available, so sandboxes fall back to unlimited volumes (and the heartbeat says so)", async () => {
    expect(await new WorkspaceHelper(join(dir, "missing.sock"), 1000).available()).toBe(false);
  });
});

describe.skipIf(!unixSockets)("the installed helper's retention rules", () => {
  test("remount preserves existing data; retained data requires remove-owned", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-helper-"));
    const root = join(dir, "workspaces");
    const bin = join(dir, "bin");
    const trace = join(dir, "mounts");
    const id = "0123456789";
    mkdirSync(root); mkdirSync(bin);
    // Run the actual shell helper in a temporary root. Privileged commands are
    // stand-ins, so this exercises its policy without touching host mounts.
    writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(bin, "mountpoint"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    writeFileSync(join(bin, "mount"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_WORKSPACE_TRACE"\n', { mode: 0o700 });
    const source = readFileSync(new URL("../../../sandbox/galahad-workspace", import.meta.url), "utf8");
    expect(source.match(/^ROOT=\/var\/lib\/galahad-workspaces$/gm)).toHaveLength(1);
    const isolated = source.replace(/^ROOT=\/var\/lib\/galahad-workspaces$/m, 'ROOT="$TEST_WORKSPACE_ROOT"');
    const ask = (command: string) => {
      const result = Bun.spawnSync(["sh", "-c", isolated], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_WORKSPACE_ROOT: root, TEST_WORKSPACE_TRACE: trace },
        stdin: Buffer.from(`${command}\n`),
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      expect(ask(`mount ${id}`)).toBe("error existing workspace is missing");
      expect(existsSync(join(root, `${id}.img`))).toBe(false);
      writeFileSync(join(root, `${id}.img`), "existing teammate work");
      mkdirSync(join(root, id));
      expect(ask(`mount ${id}`)).toBe("ok");
      expect(readFileSync(trace, "utf8")).toBe(`-o loop,nodev,nosuid,discard ${root}/${id}.img ${root}/${id}\n`);
      expect(readFileSync(join(root, `${id}.img`), "utf8")).toBe("existing teammate work");
      expect(ask(`retain ${id}`)).toBe("ok");
      expect(existsSync(join(root, `${id}.keep`))).toBe(true);
      expect(ask(`remove ${id}`)).toBe("error retained workspace needs owner-approved removal");
      expect(readFileSync(join(root, `${id}.img`), "utf8")).toBe("existing teammate work");
      expect(existsSync(join(root, id))).toBe(true);
      expect(ask(`remove-owned ${id}`)).toBe("ok");
      expect([id, `${id}.img`, `${id}.keep`].some((name) => existsSync(join(root, name)))).toBe(false);

      // Recovery must not follow a substituted image into another workspace.
      const other = join(root, "other.img");
      writeFileSync(other, "unrelated data");
      symlinkSync(other, join(root, `${id}.img`));
      mkdirSync(join(root, id));
      expect(ask(`mount ${id}`)).toBe("error existing workspace is missing");
      expect(ask(`retain ${id}`)).toBe("error existing workspace is missing");
      expect(readFileSync(other, "utf8")).toBe("unrelated data");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // (It runs the installed helper's shell, which starts processes: 30 s, not bun's 5, for a busy machine; on 19 November 2026 it ran past 5 s under load.)
  test("a workspace grows where it is mounted, or unmounted after a check, and never shrinks or grows another's disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-helper-"));
    const root = join(dir, "workspaces");
    const bin = join(dir, "bin");
    const trace = join(dir, "calls");
    const id = "0123456789";
    mkdirSync(root); mkdirSync(bin);
    // The privileged commands are stand-ins that say what they were asked: the policy is the helper's own.
    const record = '#!/bin/sh\nprintf "%s %s\\n" "$(basename "$0")" "$*" >> "$TEST_WORKSPACE_TRACE"\n';
    for (const name of ["truncate", "resize2fs", "e2fsck"]) writeFileSync(join(bin, name), record, { mode: 0o700 });
    // Asked which file a loop device is backed by, it says; asked to resize one, it is recorded like the rest.
    writeFileSync(join(bin, "losetup"), '#!/bin/sh\ncase "$*" in *BACK-FILE*) echo "$TEST_BACKING" ;; *) printf "%s %s\\n" losetup "$*" >> "$TEST_WORKSPACE_TRACE" ;; esac\n', { mode: 0o700 });
    writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(bin, "mountpoint"), '#!/bin/sh\n[ "$TEST_MOUNTED" = 1 ]\n', { mode: 0o700 });
    writeFileSync(join(bin, "findmnt"), '#!/bin/sh\necho "$TEST_SOURCE"\n', { mode: 0o700 });
    writeFileSync(join(bin, "stat"), '#!/bin/sh\necho "$TEST_SIZE"\n', { mode: 0o700 });
    const source = readFileSync(new URL("../../../sandbox/galahad-workspace", import.meta.url), "utf8");
    const isolated = source.replace(/^ROOT=\/var\/lib\/galahad-workspaces$/m, 'ROOT="$TEST_WORKSPACE_ROOT"');
    const ask = (command: string, env: { mounted: boolean; source?: string; size?: number; backing?: string }) => {
      rmSync(trace, { force: true });
      const result = Bun.spawnSync(["sh", "-c", isolated], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_WORKSPACE_ROOT: root, TEST_WORKSPACE_TRACE: trace, TEST_MOUNTED: env.mounted ? "1" : "0", TEST_SOURCE: env.source ?? "/dev/loop7", TEST_SIZE: String(env.size ?? GIB), TEST_BACKING: env.backing ?? join(root, `${id}.img`) },
        stdin: Buffer.from(`${command}\n`),
      });
      expect(result.exitCode).toBe(0);
      return { said: result.stdout.toString().trim(), calls: existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [] };
    };
    const img = join(root, `${id}.img`);
    try {
      expect(ask(`grow ${id} 3`, { mounted: true }).said).toBe("error existing workspace is missing");
      writeFileSync(img, "teammate work");
      mkdirSync(join(root, id));
      // Mounted: the image, its loop device, then the filesystem, while the sandbox runs.
      expect(ask(`grow ${id} 3`, { mounted: true })).toEqual({ said: "ok", calls: [`truncate -s 3G ${img}`, "losetup -c /dev/loop7", "resize2fs /dev/loop7"] });
      // Not mounted: checked first, then grown.
      expect(ask(`grow ${id} 3`, { mounted: false })).toEqual({ said: "ok", calls: [`truncate -s 3G ${img}`, `e2fsck -f -p ${img}`, `resize2fs ${img}`] });
      // Never smaller, nor the same; never a disk that isn't a workspace's loop device.
      expect(ask(`grow ${id} 1`, { mounted: true })).toEqual({ said: "error a workspace only grows", calls: [] });
      expect(ask(`grow ${id} 3`, { mounted: true, size: 3 * GIB })).toEqual({ said: "error a workspace only grows", calls: [] });
      expect(ask(`grow ${id} 3`, { mounted: true, source: "/dev/nvme0n1p2" })).toEqual({ said: "error not a workspace mount", calls: [] });
      expect(ask(`grow ${id} 3`, { mounted: true, backing: join(root, "9876543210.img") })).toEqual({ said: "error not this workspace's disk", calls: [] });
      for (const [line, error] of [[`grow ../etc 3`, "bad id"], [`grow ${id} 0`, "bad size"], [`grow ${id} 9999`, "at most 4096 GiB"], [`grow ${id}`, "bad arguments"], [`grow ${id} 3 4`, "bad arguments"]] as const) {
        expect(ask(line, { mounted: true })).toEqual({ said: `error ${error}`, calls: [] });
      }
      // A substituted image is never followed.
      rmSync(img);
      const other = join(root, "other.img");
      writeFileSync(other, "unrelated data");
      symlinkSync(other, img);
      expect(ask(`grow ${id} 3`, { mounted: true })).toEqual({ said: "error existing workspace is missing", calls: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
