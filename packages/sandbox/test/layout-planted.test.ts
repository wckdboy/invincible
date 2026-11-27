import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE, NOTES_DIR } from "@invincible/core";
import { containerName, type DockerRunner, LABEL, type LayoutEntry, type LayoutMoves, memoryLayoutMoves, memoryTokenStore, runArgs, SandboxHost } from "../src/index.ts";

/*
 * What a layout-1 store's root held before its move, as the host moves it (the fourth fabric review's R4-1 and R4-2, its
 * PoCs turned around). In layout 1 the store's root is the agent's /work, which anything running as the agent writes: a
 * manifest that says the move is done, links named as the trees (work -> ., home -> a folder of its own, notes -> a place
 * out of the store: on a real node, any host path), or a staging folder's name as a link. The real host's prepareTeam runs
 * over a Docker stand-in that runs MOVE_PY for real (python3 -I, as the one-off container does) on a folder standing for
 * the store, a workspace image's, whose trees are host bind sources. Not run here: a real Docker or Kata resolving a bind
 * source (layout.integration.test.ts on a Linux host with Docker).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const file = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A layout-1 store as an agent leaves it: its repository, a tool's sign-in, its notes, its lease. */
function store(): string {
  const root = temp("planted-store-");
  file(root, "repo/README.md", "the agent's repository");
  file(root, ".claude/.credentials.json", '{"token":"not-a-real-secret-sentinel"}');
  file(root, `${NOTES_DIR}/notes.db`, "the agent's notes");
  file(root, LEASE_FILE, '{"INVINCIBLE_TOKEN":"gw_test"}');
  return root;
}

/** And what anything running as the agent can plant at its root (its /work) before its move. */
function planted(elsewhere: string): string {
  const root = store();
  writeFileSync(join(root, ".invincible-layout.json"), JSON.stringify({ state: "moved" }));
  symlinkSync(".", join(root, "work"));
  mkdirSync(join(root, "hometree"));
  symlinkSync("hometree", join(root, "home"));
  symlinkSync(elsewhere, join(root, "notes"));
  return root;
}

/** A place out of the store, holding what no VM of this agent's may reach: another agent's store, or the host's. */
function outside(): string {
  const dir = temp("planted-elsewhere-");
  writeFileSync(join(dir, "secret.txt"), "not-a-real-host-secret-sentinel");
  return dir;
}

const ID = "0123456789";
const RUN = "arm.team.abcdef0123.builder";
const IMAGE = "invincible/sandbox:1";
type Mount = { Type: string; Source?: string; Destination: string };

type Containers = Map<string, { labels: Record<string, string>; mounts: Mount[]; status: string }>;

/**
 * The host over a stand-in for Docker. `containers` and `moves`: a process before this one's, on the same Docker and the
 * same node database, as a node that comes back has them. `hang`: the node stops as the moved VM is being made (nothing
 * after that runs, its put-back neither). `layout2`: the node's setting.
 */
function hostOver(root: string, opts: { containers?: Containers; moves?: LayoutMoves; hang?: { on: boolean; entered?: boolean }; layout2?: boolean } = {}) {
  const containers: Containers = opts.containers ?? new Map();
  if (!opts.containers) containers.set(containerName(ID), {
    labels: {
      [LABEL]: "1", [`${LABEL}.id`]: ID, [`${LABEL}.node`]: "test", [`${LABEL}.run`]: RUN, [`${LABEL}.network`]: "gateway", [`${LABEL}.ephemeral`]: "false",
      [`${LABEL}.isolation`]: "vm", [`${LABEL}.providers`]: "openai", [`${LABEL}.disk`]: "20", [`${LABEL}.created`]: "1000", [`${LABEL}.expires`]: "2000",
    },
    mounts: [{ Type: "bind", Source: root, Destination: "/work" }],
    status: "exited",
  });
  /** The VMs made (not the one-offs), as `docker run` was asked to make them. */
  const made: string[][] = [];
  const modes: { mode: string; code: number; stderr: string }[] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const runner: DockerRunner = async (args) => {
    const [command, ...rest] = args;
    switch (command) {
      case "version":
      case "info":
        return ok("27.3.1");
      case "image":
        return rest.join(" ").includes(".Config.Env") ? ok("PATH=/usr/bin:/bin:/work/.local/bin\nHOME=/work\n") : ok("sha256:fake");
      case "network":
        return ok("net");
      case "run": {
        if (rest.includes("--rm")) {
          // The one-off: MOVE_PY, as python3 -I -c in it runs it, on the store it mounts at /work.
          const mount = rest[rest.indexOf("--mount") + 1]!;
          const src = /src=([^,]+)/.exec(mount)![1]!;
          const [script, mode, , ...more] = rest.slice(rest.indexOf("-c") + 1);
          const ran = spawnSync("python3", ["-I", "-c", script!, mode!, src, ...more], { encoding: "utf8", timeout: 20_000 });
          modes.push({ mode: mode!, code: ran.status ?? 1, stderr: ran.stderr });
          return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
        }
        if (opts.hang?.on) {
          opts.hang.entered = true;
          return new Promise<never>(() => {});
        }
        made.push(rest);
        const labels: Record<string, string> = {};
        const mounts: Mount[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--label") {
            const [k, ...v] = rest[i + 1]!.split("=");
            labels[k!] = v.join("=");
          }
          if (rest[i] === "--mount") {
            const p = Object.fromEntries(rest[i + 1]!.split(",").map((kv) => kv.split("=") as [string, string]));
            mounts.push({ Type: p.type!, Source: p.src, Destination: p.dst! });
          }
        }
        const name = rest[rest.indexOf("--name") + 1]!;
        containers.set(name, { labels, mounts, status: "running" });
        return ok(name);
      }
      case "ps": {
        const wanted = rest.filter((_, i) => rest[i - 1] === "--filter");
        const matching = [...containers.entries()].filter(([, c]) =>
          wanted.every((w) => {
            if (w.startsWith("status=")) return c.status === w.slice(7);
            const [k, ...v] = w.replace(/^label=/, "").split("=");
            return v.length ? c.labels[k!] === v.join("=") : k! in c.labels;
          }),
        );
        const label = /^\{\{\.Label "([^"]+)"\}\}$/.exec(rest.includes("--format") ? rest[rest.indexOf("--format") + 1]! : "")?.[1];
        return ok(matching.map(([name, c]) => (label ? (c.labels[label] ?? "") : name)).join("\n"));
      }
      case "inspect": {
        if (rest[0] === "--format") {
          const c = containers.get(rest[2]!);
          if (!c) return { code: 1, stdout: "", stderr: "No such object" };
          if (rest[1] === "{{.Name}}") return ok(`/${rest[2]}`);
          const label = /^\{\{index \.Config\.Labels "([^"]+)"\}\}$/.exec(rest[1]!)?.[1];
          return label ? ok(c.labels[label] ?? "") : ok(JSON.stringify(c.mounts));
        }
        // (As Docker says them, each with its own name.)
        const found = rest.filter((name) => containers.has(name));
        if (!found.length) return { code: 1, stdout: "", stderr: "No such object" };
        return ok(JSON.stringify(found.map((name) => ({ Name: `/${name}`, Config: { Labels: containers.get(name)!.labels, Image: IMAGE }, State: { Status: containers.get(name)!.status }, HostConfig: { NanoCpus: 2e9, Memory: 4 * 2 ** 30 } }))));
      }
      case "rename": {
        const c = containers.get(rest[0]!);
        if (!c) return { code: 1, stdout: "", stderr: "No such object" };
        containers.delete(rest[0]!);
        containers.set(rest[1]!, c);
        return ok();
      }
      case "rm":
        containers.delete(rest.at(-1)!);
        return ok();
      case "stop": {
        const c = containers.get(rest.at(-1)!);
        if (c) c.status = "exited";
        return ok();
      }
      case "start": {
        const c = containers.get(rest.at(-1)!);
        if (!c) return { code: 1, stdout: "", stderr: `Error response from daemon: No such container: ${rest.at(-1)}` };
        c.status = "running";
        return ok();
      }
      default:
        return ok();
    }
  };
  const ledger: { detail?: string }[] = [];
  const moved: { run: string; entries: readonly LayoutEntry[] }[] = [];
  const moves = opts.moves ?? memoryLayoutMoves();
  const host = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16, microVMs: true, runner, ledger: (e) => void ledger.push(e), layout2: opts.layout2 ?? true, moved: (run, entries) => void moved.push({ run, entries }),
    tokens: { mint: () => ({ token: "test-only-token", info: { hash: "test-only-hash" } }), revoke: () => true, extend: () => true },
    tokenStore: memoryTokenStore(),
    layoutMoves: moves,
    workspaces: { available: async () => true, create: async () => root, mount: async () => {}, retain: async () => {}, remove: async () => {}, stats: async () => ({ totalBytes: 10 ** 12, freeBytes: 10 ** 12, images: [] }) },
  });
  /** Each bind of the latest VM made, by where it is mounted: its source, and where that resolves on this host. */
  const binds = () => {
    const last = made.at(-1) ?? [];
    return last.flatMap((a, i) => {
      if (last[i - 1] !== "--mount" || !a.startsWith("type=bind")) return [];
      const p = Object.fromEntries(a.split(",").map((kv) => kv.split("=") as [string, string]));
      return [{ dst: p.dst!, src: p.src!, real: realpathSync(p.src!), dir: lstatSync(p.src!).isDirectory() }];
    });
  };
  return { host, made, modes, ledger, moved, containers, moves, binds, labels: () => containers.get(containerName(ID))!.labels };
}

describe("R4-1: a planted manifest and tree-named links at a layout-1 store's root", () => {
  test("its move moves them as the agent's entries, and each bind its VM is made with is a folder of the store's own", async () => {
    const elsewhere = outside();
    const root = planted(elsewhere);
    const { host, modes, ledger, moved, binds, labels } = hostOver(root);
    await host.prepareTeam(ID, RUN);
    expect(modes.map((m) => [m.mode, m.code])).toEqual([["list", 0], ["move", 0], ["check", 0]]);
    expect(labels()[`${LABEL}.layout`]).toBe("2");
    // Each source a real folder, the store's own tree, and nothing out of the store among them.
    expect(binds().map(({ dst, real, dir }) => [dst, real, dir])).toEqual([
      ["/work", join(root, "work"), true],
      ["/home/agent", join(root, "home"), true],
      ["/home/agent/.memory/engram", join(root, "notes"), true],
    ]);
    expect(binds().every((b) => b.src === b.real)).toBe(true);
    // The plant is the agent's: links as links, in its workspace's tree; its manifest in its HOME, as a dot-entry of its.
    for (const name of ["work", "home", "notes"]) expect(lstatSync(join(root, "work", name)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "home/.invincible-layout.json"))).toBe(true);
    // What you're told is what happened: its tool's sign-in is in its HOME now, and its notes in their own tree.
    expect(readFileSync(join(root, "home/.claude/.credentials.json"), "utf8")).toContain("not-a-real-secret-sentinel");
    expect(readdirSync(join(root, "notes"))).toEqual(["notes.db"]);
    expect(moved[0]!.entries.filter((e) => e.to === "home").map((e) => e.name)).toEqual([".claude", ".invincible-layout.json", ".memory"]);
    expect(ledger.some((e) => e.detail?.startsWith("made again in layout 2 · to its HOME: 3 entries"))).toBe(true);
    // And the place out of the store is as it was: nothing of it reached through any bind.
    expect(readdirSync(elsewhere)).toEqual(["secret.txt"]);
  });

  test("a tree swapped for a link after the move (as a VM that had its root could) is never mounted: the VM isn't started", async () => {
    const elsewhere = outside();
    const root = store();
    const { host, containers, made, ledger } = hostOver(root);
    await host.prepareTeam(ID, RUN);
    expect(made).toHaveLength(1);
    // Stopped, and its HOME's tree swapped for a link to a place out of the store.
    containers.get(containerName(ID))!.status = "exited";
    rmSync(join(root, "home"), { recursive: true });
    symlinkSync(elsewhere, join(root, "home"));
    await expect(host.prepareTeam(ID, RUN)).rejects.toThrow("nothing of the agent's store was mounted: its trees aren't folders of the store's own (home is a link)");
    expect(containers.get(containerName(ID))!.status).toBe("exited");
    // Made again by its owner: the same, and it is put back as it was, stopped.
    await expect(host.remakeTeam(ID, RUN, { providers: ["openai"], approvedBy: "test-owner" })).rejects.toThrow("home is a link");
    expect(made).toHaveLength(1);
    expect(ledger.filter((e) => e.detail?.startsWith("made again from")).length).toBe(0);
  });
});

describe("R4-2: a staging folder's name planted as a link in layout 1", () => {
  test("never takes the move's place: the agent's HOME is a tree of its own, and a task's VM sharing its workspace finds no lease", async () => {
    const root = store();
    mkdirSync(join(root, "work"));
    symlinkSync("work", join(root, ".invincible-layout-home"));
    symlinkSync("work", join(root, ".invincible-layout-work"));
    const { host, binds } = hostOver(root);
    await host.prepareTeam(ID, RUN);
    expect(lstatSync(join(root, "home")).isDirectory()).toBe(true);
    expect(realpathSync(join(root, "home"))).toBe(join(root, "home"));
    expect(binds().find((b) => b.dst === "/home/agent")!.real).toBe(join(root, "home"));
    // The planted links are the agent's own dot-entries, in its HOME as links; its folder named work, in its workspace.
    expect(lstatSync(join(root, "home/.invincible-layout-home")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, "work/work")).isDirectory()).toBe(true);
    // The node writes the agent's lease in its HOME; a task's VM gets the workspace's tree alone, where none is.
    file(root, `home/${LEASE_FILE}`, '{"INVINCIBLE_TOKEN":"gw_test_agent_lease_with_keys"}');
    const args = runArgs({ id: "1111111111", run: "handed.task-x", node: "test", image: IMAGE, network: "gateway", cpus: 1, memoryGb: 1, pidsLimit: 256, ttlMinutes: 60, ephemeral: true, providers: [], createdAt: 0, env: {}, isolation: "vm", shares: { sandbox: ID, workspace: root, tree: "work" }, task: "task-x", ownHome: { path: "/usr/bin:/bin:/home/agent/.local/bin" } });
    const work = /src=([^,]+)/.exec(args[args.findIndex((a) => a.includes("dst=/work"))]!)![1]!;
    expect(work).toBe(join(root, "work"));
    expect(existsSync(join(work, LEASE_FILE))).toBe(false);
    expect(readdirSync(work).sort()).toEqual(["repo", "work"]);
  });
});

describe("R4-6: a node that stops in the middle of a move", () => {
  /** A first process that moves the store and stops as its VM is made again: what it leaves, and the node's database. */
  async function cut(root: string) {
    const hang = { on: true, entered: false };
    const first = hostOver(root, { hang });
    void first.host.prepareTeam(ID, RUN).catch(() => {});
    const until = Date.now() + 10_000;
    while (!hang.entered && Date.now() < until) await Bun.sleep(5);
    expect(hang.entered).toBe(true);
    // What it leaves: its VM set aside, its store moved (the manifest says so), and its move under way in its database.
    expect([...first.containers.keys()]).toEqual([`${containerName(ID)}-replaced`]);
    expect(readdirSync(root).filter((n) => !n.startsWith(".invincible-layout-")).sort()).toEqual(["home", "notes", "work"]);
    expect(first.moves.started(ID)).not.toBeNull();
    return first;
  }

  test("is taken up at its next prepare: its VM gets its name back, its move is done with its own word, and you're told what moved", async () => {
    const root = store();
    const first = await cut(root);
    const word = first.moves.started(ID)!.nonce;
    const second = hostOver(root, { containers: first.containers, moves: first.moves });
    const prepared = await second.host.prepareTeam(ID, RUN);
    expect(prepared.status).toBe("running");
    // (No list: what it listed before it began is in the node's database. The move, then its trees checked.)
    expect(second.modes.map((m) => [m.mode, m.code])).toEqual([["move", 0], ["check", 0]]);
    expect(second.labels()[`${LABEL}.layout`]).toBe("2");
    expect([...second.containers.keys()]).toEqual([containerName(ID)]);
    expect(second.moves.started(ID)).toBeNull();
    expect(readdirSync(root).filter((n) => n.startsWith(".invincible-layout-"))).toEqual([`.invincible-layout-${word}.json`]);
    // What you're told is what moved, and that it was taken up.
    expect(second.ledger.find((e) => e.detail?.startsWith("made again in layout 2"))!.detail).toStartWith("made again in layout 2, taking up a move that was under way · to its HOME: 2 entries");
    expect(second.ledger.some((e) => e.detail?.startsWith("not moved"))).toBe(false);
    expect(second.moved[0]!.entries.filter((e) => e.to === "home").map((e) => e.name)).toEqual([".claude", ".memory"]);
    expect(readFileSync(join(root, "home/.claude/.credentials.json"), "utf8")).toContain("not-a-real-secret-sentinel");
    // And the prepare after: nothing more to do.
    second.modes.length = 0;
    await second.host.prepareTeam(ID, RUN);
    expect(second.modes).toEqual([]);
  });

  test("with layout 2 turned off since, it is put back with its own word: its store's entries where they were, its VM in layout 1", async () => {
    const root = store();
    const first = await cut(root);
    const second = hostOver(root, { containers: first.containers, moves: first.moves, layout2: false });
    const prepared = await second.host.prepareTeam(ID, RUN);
    expect(prepared.status).toBe("running");
    expect(second.modes.map((m) => [m.mode, m.code])).toEqual([["back", 0]]);
    expect(second.labels()[`${LABEL}.layout`]).toBeUndefined();
    expect(second.moves.started(ID)).toBeNull();
    expect(readdirSync(root).sort()).toEqual([".claude", ".memory", "repo"]);
    expect(readFileSync(join(root, NOTES_DIR, "notes.db"), "utf8")).toBe("the agent's notes");
    expect(second.ledger.some((e) => e.detail?.startsWith("a move to layout 2 under way was put back"))).toBe(true);
    expect(second.moved).toEqual([]);
  });

  test("cut at its very end (its VM made again, the old one still set aside): the old one goes, and you're told it moved", async () => {
    const root = store();
    const moves = memoryLayoutMoves();
    const first = hostOver(root, { moves });
    await first.host.prepareTeam(ID, RUN);
    // As the node would have left it, stopping before its last step: the old container still there, its move under way.
    first.containers.set(`${containerName(ID)}-replaced`, { labels: { ...first.labels(), [`${LABEL}.layout`]: "" }, mounts: [{ Type: "bind", Source: root, Destination: "/work" }], status: "exited" });
    moves.start(ID, { nonce: "f".repeat(32), entries: [{ name: ".claude", to: "home", kind: "dir", bytes: 100 }] });
    const second = hostOver(root, { containers: first.containers, moves });
    await second.host.prepareTeam(ID, RUN);
    expect([...second.containers.keys()]).toEqual([containerName(ID)]);
    expect(second.moves.started(ID)).toBeNull();
    expect(second.ledger.some((e) => e.detail?.startsWith("made again in layout 2, a move the node was cut off at the end of · to its HOME: 1 entries, 100 bytes"))).toBe(true);
    expect(second.moved).toHaveLength(1);
    expect(second.modes.map((m) => m.mode)).toEqual([]);
  });

  test("nothing shares a store while its move is under way", async () => {
    const root = store();
    const first = await cut(root);
    const second = hostOver(root, { containers: first.containers, moves: first.moves });
    // (As a run on a seat would: a VM that shares the agent's workspace.)
    second.containers.set(containerName(ID), second.containers.get(`${containerName(ID)}-replaced`)!);
    second.containers.delete(`${containerName(ID)}-replaced`);
    await expect(second.host.create({ network: "gateway", cpus: 1, memoryGb: 1, ttlMinutes: 30, persistent: false, run: "seat-run-x" }, { shares: { sandbox: ID, workspace: root } })).rejects.toThrow("that agent's store is being moved to layout 2: nothing shares it until its move is done or put back");
  });
});
