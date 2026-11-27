import { describe, expect, test } from "bun:test";
import { LEASE_FILE, NOTES_DIR } from "@invincible/core";
import { containerName, type DockerRunner, LABEL, type LayoutEntry, SandboxHost, volumeName } from "../src/index.ts";

/*
 * Layout 2 on an agent's VM (layout.ts; the owner's decisions of 27 November 2026): made in it new, moved to it from layout
 * 1 at a prepare while nothing runs in it (and put back as it was when it can't be made again), kept in it when its owner
 * makes it again, and shared with a seat's VM by its workspace's tree alone. Docker is a stand-in that keeps containers,
 * their labels and mounts in memory, and runs nothing: the host's own logic runs unchanged above it.
 */

const ID = "0123456789";
const RUN = "arm.team.abcdef0123.builder";
const IMAGE = "invincible/sandbox:1";
type Mount = { Type: string; Name?: string; Source?: string; Destination: string; Subpath?: string };
const LISTED: LayoutEntry[] = [
  { name: ".agent", to: "work", kind: "dir", bytes: 10 },
  { name: ".config", to: "home", kind: "dir", bytes: 2048 },
  { name: ".memory/engram", to: "notes", kind: "dir", bytes: 512 },
  { name: ".invincible-gateway.json", to: "drop", kind: "file", bytes: 300 },
  { name: "repo", to: "work", kind: "dir", bytes: 4096 },
];

function fake(opts: { engine?: string; disk?: boolean; layout?: "2"; sharing?: boolean; runFails?: boolean } = {}) {
  const containers = new Map<string, { labels: Record<string, string>; mounts: Mount[]; status: string; image: string }>();
  const calls: string[][] = [];
  /** The modes MOVE_PY was run in, in order. */
  const modes: string[] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr = "No such object") => ({ code: 1, stdout: "", stderr });
  const parse = (rest: string[]) => {
    const labels: Record<string, string> = {};
    const mounts: Mount[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--label") {
        const [key, ...value] = rest[i + 1]!.split("=");
        labels[key!] = value.join("=");
      }
      if (rest[i] === "--mount") {
        const parts = Object.fromEntries(rest[i + 1]!.split(",").map((kv) => kv.split("=") as [string, string]));
        mounts.push({ Type: parts.type!, ...(parts.type === "volume" ? { Name: parts.src } : { Source: parts.src }), Destination: parts.dst!, ...(parts["volume-subpath"] ? { Subpath: parts["volume-subpath"] } : {}) });
      }
    }
    return { labels, mounts };
  };
  // The agent's VM as it is now: made before layout 2, or in it.
  const work = opts.disk ? `/var/lib/invincible-workspaces/${ID}` : null;
  containers.set(containerName(ID), {
    labels: {
      [LABEL]: "1", [`${LABEL}.id`]: ID, [`${LABEL}.node`]: "test", [`${LABEL}.run`]: RUN, [`${LABEL}.network`]: "gateway", [`${LABEL}.ephemeral`]: "false",
      [`${LABEL}.isolation`]: "vm", [`${LABEL}.providers`]: "openai", [`${LABEL}.disk`]: opts.disk ? "20" : "none", [`${LABEL}.created`]: "1000", [`${LABEL}.expires`]: "2000",
      ...(opts.layout ? { [`${LABEL}.layout`]: opts.layout } : {}),
    },
    mounts: [work ? { Type: "bind", Source: opts.layout ? `${work}/work` : work, Destination: "/work" } : { Type: "volume", Name: volumeName(ID), Destination: "/work", ...(opts.layout ? { Subpath: "work" } : {}) }],
    status: "exited",
    image: IMAGE,
  });
  if (opts.sharing) containers.set("invincible-sbx-5555555555", { labels: { [LABEL]: "1", [`${LABEL}.id`]: "5555555555", [`${LABEL}.node`]: "test", [`${LABEL}.shares`]: ID }, mounts: [], status: "running", image: IMAGE });
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    const [command, ...rest] = args;
    switch (command) {
      case "version":
        return ok(opts.engine ?? "27.3.1");
      case "info":
        return ok("27.3.1");
      case "image":
        // Its PATH as the image was built, when asked for its environment; that it is there, otherwise.
        return rest.includes("--format") && rest.join(" ").includes(".Config.Env") ? ok("PATH=/opt/bun/bin:/usr/bin:/bin:/work/.local/bin\nHOME=/work\n") : ok("sha256:fake");
      case "network":
        return ok("net");
      case "volume":
        return ok(rest.at(-1));
      case "run": {
        if (rest.includes("--rm")) {
          const mode = rest[rest.indexOf("-c") + 2]!;
          modes.push(mode);
          return mode === "list" ? ok(LISTED.map((e) => JSON.stringify(e)).join("\n")) : ok();
        }
        if (opts.runFails) return { code: 125, stdout: "", stderr: "kata: could not start the VM" };
        const name = rest[rest.indexOf("--name") + 1]!;
        containers.set(name, { ...parse(rest), status: "running", image: rest[rest.length - 3]! });
        return ok(name);
      }
      case "ps": {
        const wanted = rest.filter((_, i) => rest[i - 1] === "--filter");
        const matching = [...containers.entries()].filter(([, c]) =>
          wanted.every((w) => (w.startsWith("status=") ? c.status === w.slice(7) : (() => { const [k, ...v] = w.replace(/^label=/, "").split("="); return v.length ? c.labels[k!] === v.join("=") : k! in c.labels; })())),
        );
        // (Docker's names for them, which the host inspects them by.)
        return ok(matching.map(([name]) => name).join("\n"));
      }
      case "inspect": {
        if (rest[0] === "--format") {
          const c = containers.get(rest[2]!);
          if (!c) return no();
          if (rest[1] === "{{.Name}}") return ok(`/${rest[2]}`);
          const label = /^\{\{index \.Config\.Labels "([^"]+)"\}\}$/.exec(rest[1]!)?.[1];
          return label ? ok(c.labels[label] ?? "") : ok(JSON.stringify(c.mounts));
        }
        const found = rest.map((name) => containers.get(name)).filter((c) => !!c);
        if (!found.length) return no();
        return ok(JSON.stringify(found.map((c) => ({ Config: { Labels: c!.labels, Image: c!.image }, State: { Status: c!.status }, HostConfig: { NanoCpus: 2e9, Memory: 4 * 2 ** 30 } }))));
      }
      case "stop":
        return ok();
      case "start": {
        const c = containers.get(rest.at(-1)!);
        if (c) c.status = "running";
        return ok();
      }
      case "rename": {
        const c = containers.get(rest[0]!);
        if (!c) return no();
        containers.delete(rest[0]!);
        containers.set(rest[1]!, c);
        return ok();
      }
      case "rm":
        containers.delete(rest.at(-1)!);
        return ok();
      default:
        return ok();
    }
  };
  const ledger: { class: string; resource: string; target: string; detail?: string; reason?: string }[] = [];
  const moved: { run: string; entries: readonly LayoutEntry[] }[] = [];
  const workspaces = opts.disk
    ? { available: async () => true, create: async () => `/var/lib/invincible-workspaces/${ID}`, mount: async () => {}, retain: async () => {}, remove: async () => {}, stats: async () => ({ totalBytes: 10 ** 12, freeBytes: 10 ** 12, images: [] }) }
    : null;
  const host = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16, runner, ledger: (e) => void ledger.push(e), layout2: true, moved: (run, entries) => void moved.push({ run, entries }),
    tokens: { mint: () => ({ token: "test-only-token", info: { hash: "test-only-hash" } }), revoke: () => true },
    tokenStore: { put: () => {}, take: () => null },
    ...(workspaces ? { workspaces } : {}),
  });
  const agent = () => containers.get(containerName(ID))!;
  return { host, calls, containers, ledger, moved, modes, agent };
}

describe("an agent's VM in layout 1, at a prepare while nothing runs in it", () => {
  test("is moved to layout 2: its store's entries renamed into its three trees, and its VM made again on them", async () => {
    const f = fake();
    await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(f.modes).toEqual(["list", "move"]);
    // The one-off runs as the VM's user, with no network and no capability; the list sees its store read-only.
    const oneOffs = f.calls.filter((a) => a[0] === "run" && a.includes("--rm"));
    for (const args of oneOffs) {
      expect(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2)).toEqual(["--user", "1000:1000"]);
      expect(args).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "--read-only"]));
      // (Told the lease's name, to drop it, and its notes' place in a HOME, to take them to their own tree.)
      expect(args.slice(-2)).toEqual([LEASE_FILE, NOTES_DIR]);
    }
    expect(oneOffs[0]).toContain(`type=volume,src=${volumeName(ID)},dst=/work,readonly`);
    expect(oneOffs[1]).toContain(`type=volume,src=${volumeName(ID)},dst=/work`);
    // Made again on its three trees, its HOME and its notes apart, and running.
    expect(f.agent().labels[`${LABEL}.layout`]).toBe("2");
    expect(f.agent().mounts).toEqual([
      { Type: "volume", Name: volumeName(ID), Destination: "/work", Subpath: "work" },
      { Type: "volume", Name: volumeName(ID), Destination: "/home/agent", Subpath: "home" },
      { Type: "volume", Name: volumeName(ID), Destination: "/home/agent/.memory/engram", Subpath: "notes" },
    ]);
    const made = f.calls.find((a) => a[0] === "run" && !a.includes("--rm"))!;
    expect(made).toEqual(expect.arrayContaining(["HOME=/home/agent", "PATH=/opt/bun/bin:/usr/bin:/bin:/home/agent/.local/bin"]));
    expect(f.containers.has(`${containerName(ID)}-replaced`)).toBe(false);
    // Said once in the ledger, by names and sizes alone, and to its owner.
    const said = f.ledger.find((e) => e.detail?.startsWith("made again in layout 2"))!;
    expect(said.detail).toBe("made again in layout 2 · to its HOME: 1 entries, 2048 bytes · its notes: 512 bytes, to a tree of their own · kept in its workspace: 2 entries · its old lease dropped");
    expect(f.moved).toEqual([{ run: RUN, entries: LISTED }]);
    // Its next prepare finds it in layout 2: nothing is moved again.
    f.modes.length = 0;
    await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(f.modes).toEqual([]);
  });

  test("a workspace image's store is moved too, on any Docker; one on a volume waits for Docker Engine 26", async () => {
    const image = fake({ disk: true, engine: "25.0.3" });
    await image.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(image.modes).toEqual(["list", "move"]);
    expect(image.agent().mounts).toEqual([
      { Type: "bind", Source: `/var/lib/invincible-workspaces/${ID}/work`, Destination: "/work" },
      { Type: "bind", Source: `/var/lib/invincible-workspaces/${ID}/home`, Destination: "/home/agent" },
      { Type: "bind", Source: `/var/lib/invincible-workspaces/${ID}/notes`, Destination: "/home/agent/.memory/engram" },
    ]);
    const volume = fake({ engine: "25.0.3" });
    await volume.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(volume.modes).toEqual([]);
    expect(volume.agent().labels[`${LABEL}.layout`]).toBeUndefined();
  });

  test("not while a VM shares its workspace, or a command runs in it", async () => {
    const shared = fake({ sharing: true });
    await shared.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(shared.modes).toEqual([]);
    expect(shared.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    // A command of its, still running: its exec holds it.
    const busy = fake();
    busy.agent().status = "running";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const running = busy.host as unknown as { execNow: (id: string, cmd: string[], t: number) => Promise<unknown> };
    const execNow = running.execNow.bind(busy.host);
    running.execNow = async (id, cmd, t) => {
      await held;
      return execNow(id, cmd, t);
    };
    const command = busy.host.exec(ID, ["sleep", "1"]);
    await busy.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(busy.modes).toEqual([]);
    release();
    await command;
  });

  test("one that can't be made again is put back as it was, its store's entries back where they were, and its work goes on", async () => {
    const f = fake({ runFails: true });
    const prepared = await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(f.modes).toEqual(["list", "move", "back"]);
    expect(f.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    expect(f.agent().mounts).toEqual([{ Type: "volume", Name: volumeName(ID), Destination: "/work" }]);
    expect(f.ledger.some((e) => e.detail?.startsWith("not moved to layout 2, so it stays as it was"))).toBe(true);
    expect(f.moved).toEqual([]);
    expect(prepared.status).toBe("running");
  });
});

describe("an agent's VM in layout 2", () => {
  test("made again by its owner, it stays in layout 2", async () => {
    const f = fake({ layout: "2" });
    await f.host.remakeTeam(ID, RUN, { providers: ["openai"], approvedBy: "test-owner" });
    expect(f.modes).toEqual([]);
    expect(f.agent().labels[`${LABEL}.layout`]).toBe("2");
    expect(f.agent().mounts.map((m) => m.Destination)).toEqual(["/work", "/home/agent", "/home/agent/.memory/engram"]);
  });

  test("a seat's VM that shares its workspace mounts the workspace's tree alone, never its HOME", async () => {
    const f = fake({ layout: "2" });
    f.agent().status = "running";
    await f.host.createSeatVm({ seat: { id: `st_${"a".repeat(22)}`, kind: "claude-subscription", runs: 1 }, network: "online", cpus: 1, memoryGb: 2, ttlMinutes: 30, run: RUN, shares: ID });
    const seat = [...f.containers.entries()].find(([, c]) => c.labels[`${LABEL}.shares`] === ID && c.labels[`${LABEL}.seat`])![1];
    expect(seat.mounts.filter((m) => m.Destination === "/work")).toEqual([{ Type: "volume", Name: volumeName(ID), Destination: "/work", Subpath: "work" }]);
    expect(seat.mounts.some((m) => m.Destination === "/home/agent" || m.Subpath === "home" || m.Subpath === "notes")).toBe(false);
  });

  test("made new, it is in layout 2 from the start: its store's three trees made before it is", async () => {
    const f = fake();
    f.containers.clear();
    await f.host.create({ network: "gateway", cpus: 1, memoryGb: 2, ttlMinutes: 60, persistent: true, run: "arm.team.abcdef0124.noa" });
    expect(f.modes).toEqual(["make"]);
    const made = [...f.containers.values()].find((c) => c.labels[`${LABEL}.run`] === "arm.team.abcdef0124.noa")!;
    expect(made.labels[`${LABEL}.layout`]).toBe("2");
    expect(made.mounts.map((m) => [m.Destination, m.Subpath])).toEqual([["/work", "work"], ["/home/agent", "home"], ["/home/agent/.memory/engram", "notes"]]);
    // Anything else it makes stays as it was made: a sandbox for a run is in layout 1.
    f.modes.length = 0;
    await f.host.create({ network: "gateway", cpus: 1, memoryGb: 2, ttlMinutes: 60, persistent: false, run: "adhoc-test" });
    expect(f.modes).toEqual([]);
  });
});
