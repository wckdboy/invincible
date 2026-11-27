import { describe, expect, test } from "bun:test";
import { LEASE_FILE, NOTES_DIR } from "@invincible/core";
import { containerName, type DockerRunner, LABEL, type LayoutEntry, memoryTokenStore, SandboxHost, seatVolumeName, TEAM_LEASE_MINUTES, volumeName } from "../src/index.ts";

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

function fake(opts: { engine?: string; disk?: boolean; layout?: "2"; sharing?: boolean; runFails?: boolean; leaseFails?: (container: string) => boolean; extendFails?: boolean } = {}) {
  const containers = new Map<string, { labels: Record<string, string>; mounts: Mount[]; status: string; image: string }>();
  const calls: string[][] = [];
  /** The modes MOVE_PY was run in, in order. */
  const modes: string[] = [];
  /** The lease written in each VM (writeLease's payload), by its container's name. */
  const leases = new Map<string, Record<string, string>>();
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
        // (Asked for a label, the label; otherwise Docker's names for them, which the host inspects them by.)
        const label = /^\{\{\.Label "([^"]+)"\}\}$/.exec(rest.includes("--format") ? rest[rest.indexOf("--format") + 1]! : "")?.[1];
        return ok(matching.map(([name, c]) => (label ? (c.labels[label] ?? "") : name)).join("\n"));
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
      case "exec": {
        // exec --interactive --workdir /work <container> timeout --signal=KILL <n>s <cmd…>: a lease written is kept.
        const container = rest[3]!;
        const cmd = rest.slice(7);
        if (cmd.join(" ").includes("prefix='.invincible-gateway-'")) {
          if (opts.leaseFails?.(container)) return { code: 1, stdout: "", stderr: "no space left on device" };
          leases.set(container, JSON.parse(Buffer.from(cmd.at(-1)!, "base64").toString("utf8")));
        }
        return ok();
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
  // Each lease minted is a token of its own, by its number; what was asked of each is kept.
  const tokens = { minted: [] as { label: string; providers?: string[]; models?: string[]; ttlMinutes: number; maxRequests: number }[], extended: [] as string[], revoked: [] as string[] };
  const host = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16, runner, ledger: (e) => void ledger.push(e), layout2: true, moved: (run, entries) => void moved.push({ run, entries }),
    tokens: {
      mint: (scope) => {
        tokens.minted.push(scope);
        return { token: `test-only-token-${tokens.minted.length}`, info: { hash: `test-only-hash-${tokens.minted.length}` } };
      },
      revoke: (hash) => (tokens.revoked.push(hash), true),
      extend: (hash) => (tokens.extended.push(hash), !opts.extendFails),
    },
    tokenStore: memoryTokenStore(),
    ...(workspaces ? { workspaces } : {}),
  });
  const agent = () => containers.get(containerName(ID))!;
  return { host, calls, containers, ledger, moved, modes, agent, leases, tokens };
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

  const SEAT = { id: `st_${"a".repeat(22)}`, kind: "claude-subscription" as const, runs: 1 };
  const onSeat = { seat: SEAT, network: "online" as const, cpus: 1, memoryGb: 2, ttlMinutes: 30, run: `seat.${SEAT.id}`, shares: ID };
  const seatVm = (f: ReturnType<typeof fake>) => [...f.containers.entries()].find(([, c]) => c.labels[`${LABEL}.shares`] === ID && c.labels[`${LABEL}.seat`])!;

  test("a seat's VM that shares its workspace mounts the workspace's tree and its notes', never its HOME, and has a HOME of its own", async () => {
    for (const disk of [false, true]) {
      const f = fake({ layout: "2", disk });
      f.agent().status = "running";
      await f.host.createSeatVm(onSeat);
      const [, seat] = seatVm(f);
      const work = disk ? { Type: "bind", Source: `/var/lib/invincible-workspaces/${ID}/work`, Destination: "/work" } : { Type: "volume", Name: volumeName(ID), Destination: "/work", Subpath: "work" };
      const notes = disk ? { Type: "bind", Source: `/var/lib/invincible-workspaces/${ID}/notes`, Destination: "/home/agent/.memory/engram" } : { Type: "volume", Name: volumeName(ID), Destination: "/home/agent/.memory/engram", Subpath: "notes" };
      expect(seat.mounts).toEqual([work, notes, { Type: "volume", Name: seatVolumeName(SEAT.id), Destination: `/seats/${SEAT.id}` }]);
      expect(seat.mounts.some((m) => m.Destination === "/home/agent" || m.Subpath === "home" || m.Source?.endsWith("/home"))).toBe(false);
      // Its HOME its own: in memory, the VMs' user's; its environment follows it.
      const made = f.calls.find((a) => a[0] === "run" && a.includes(`${LABEL}.shares=${ID}`))!;
      expect(made).toEqual(expect.arrayContaining(["--tmpfs", "/home/agent:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700", "HOME=/home/agent"]));
      expect(made).not.toContain("HOME=/work");
    }
  });

  test("a seat's VM has a lease of its own, as the agent's VM's is: its scopes, its models, its keys and its repository, written in its own HOME", async () => {
    const f = fake({ layout: "2" });
    const git = { connector: "github", owner: "example", repo: "app" };
    await f.host.prepareTeam(ID, RUN, git, ["anthropic"], ["anthropic/claude-test"], ["key:test-only"]);
    await f.host.createSeatVm(onSeat);
    const [name] = seatVm(f);
    const seatId = name.replace("invincible-sbx-", "");
    // Minted for it as the agent's was, with a token of its own.
    expect(f.tokens.minted).toHaveLength(2);
    const mine = f.tokens.minted[0]!;
    const its = f.tokens.minted[1]!;
    expect(its).toEqual({ ...mine, label: `sandbox:${seatId}` });
    expect(its).toMatchObject({ providers: ["anthropic", "git:github:example:app", "key:test-only"], models: ["anthropic/claude-test"], ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
    // Written in its own HOME (its write's HOME is the VM's), and nowhere else of the agent's.
    const agentLease = f.leases.get(containerName(ID))!;
    const seatLease = f.leases.get(name)!;
    expect(seatLease.INVINCIBLE_TOKEN).toBe("test-only-token-2");
    expect(agentLease.INVINCIBLE_TOKEN).toBe("test-only-token-1");
    expect(Object.keys(seatLease).sort()).toEqual(Object.keys(agentLease).sort());
    expect(seatLease.INVINCIBLE_REPO_URL).toContain("example/app");
    expect(seatLease.INVINCIBLE_KEYS).toBeDefined();
    expect(f.ledger.find((e) => e.resource === "sandbox.seat-lease")?.detail).toBe(`a lease of its own, as ${containerName(ID)}'s is: model access capped at ${TEAM_LEASE_MINUTES} minutes and 500 requests, for anthropic/claude-test alone`);
    // Renewed with the agent's, and only then.
    await f.host.renewTeam(ID, RUN);
    expect(f.tokens.extended).toEqual(["test-only-hash-1", "test-only-hash-2"]);
    // Revoked as it goes; the agent's is its own, and stays.
    await f.host.destroy(seatId, { run: onSeat.run });
    expect(f.tokens.revoked).toEqual(["test-only-hash-2"]);
    f.tokens.extended.length = 0;
    await f.host.renewTeam(ID, RUN);
    expect(f.tokens.extended).toEqual(["test-only-hash-1"]);
    // As the agent's lease is now, never as it was: prepared as another node's task's VM is (its paid models alone, and
    // neither your keys nor its repository, as the server leases one), a seat's VM made then carries none of them.
    await f.host.prepareTeam(ID, RUN, undefined, ["anthropic"], ["anthropic/claude-paid"], []);
    await f.host.createSeatVm(onSeat);
    expect(f.tokens.minted.at(-1)).toEqual({ label: `sandbox:${seatVm(f)[0].replace("invincible-sbx-", "")}`, providers: ["anthropic"], models: ["anthropic/claude-paid"], ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
    const narrow = f.leases.get(seatVm(f)[0])!;
    expect([narrow.INVINCIBLE_REPO_URL, narrow.INVINCIBLE_KEYS]).toEqual([undefined, undefined]);
  });

  test("an agent's lease that couldn't be renewed renews none of its seats' VMs'", async () => {
    const f = fake({ layout: "2", extendFails: true });
    await f.host.prepareTeam(ID, RUN, undefined, ["anthropic"]);
    await f.host.createSeatVm(onSeat);
    expect(await f.host.renewTeam(ID, RUN)).toBe(false);
    expect(f.tokens.extended).toEqual(["test-only-hash-1"]);
  });

  test("a seat's VM whose agent's VM this process didn't prepare gets no lease, and the ledger says so; one whose lease can't be written is removed", async () => {
    const f = fake({ layout: "2" });
    f.agent().status = "running";
    await f.host.createSeatVm(onSeat);
    expect(f.tokens.minted).toHaveLength(0);
    expect(f.ledger.find((e) => e.resource === "sandbox.seat-lease")?.detail).toBe(`no lease: ${containerName(ID)} wasn't prepared by this process, so it has none to share`);
    // Its lease not written: the VM goes, and its token with it.
    const broken = fake({ layout: "2", leaseFails: (container) => container !== containerName(ID) });
    await broken.host.prepareTeam(ID, RUN, undefined, ["anthropic"]);
    await expect(broken.host.createSeatVm(onSeat)).rejects.toThrow("could not give the seat's VM its lease, so it was removed");
    expect([...broken.containers.values()].some((c) => c.labels[`${LABEL}.shares`] === ID)).toBe(false);
    expect(broken.tokens.revoked).toEqual(["test-only-hash-2"]);
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
