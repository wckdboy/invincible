import { describe, expect, test } from "bun:test";
import { LEASE_FILE, NOTES_DIR } from "@invincible/core";
import { containerName, type DockerRunner, LABEL, type LayoutEntry, memoryLayoutMoves, memoryTokenStore, SandboxHost, seatVolumeName, TEAM_LEASE_MINUTES, volumeName } from "../src/index.ts";

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

function fake(opts: { engine?: string; disk?: boolean; layout?: "2"; sharing?: boolean; runFails?: boolean; leaseFails?: (container: string) => boolean; extendFails?: boolean; listCut?: boolean; checkFails?: string; backFails?: boolean; labelFails?: boolean; layout2?: boolean; listWaits?: Promise<void>; stopFails?: boolean } = {}) {
  const containers = new Map<string, { labels: Record<string, string>; mounts: Mount[]; status: string; image: string }>();
  const calls: string[][] = [];
  /** The modes MOVE_PY was run in, in order, and the word each was given (the move's own), if any. */
  const modes: string[] = [];
  const words: (string | null)[] = [];
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
          const after = rest.slice(rest.indexOf(NOTES_DIR) + 1);
          words.push(after[0] ?? null);
          // (Its check, as MOVE_PY says what it found: a tree that isn't a folder of the store's own.)
          if (mode === "check" && opts.checkFails) return { code: 3, stdout: "", stderr: opts.checkFails };
          if (mode === "back" && opts.backFails) return { code: 1, stdout: "", stderr: "back: input/output error" };
          // (Held open where a test holds it, as a long list of a large store is.)
          if (mode === "list" && opts.listWaits) await opts.listWaits;
          // (Cut, as the node's read of it is past its cap: whole lines here, so that only its being cut can tell.)
          if (mode === "list" && opts.listCut) return { ...ok(LISTED.map((e) => JSON.stringify(e)).join("\n")), truncated: true };
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
          // (Docker failing to say one container's layout, as a daemon under load or restarting does.)
          if (label === `${LABEL}.layout` && opts.labelFails) return { code: 1, stdout: "", stderr: "Error response from daemon: context deadline exceeded" };
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
        // (A VM that won't stop, as one whose runtime is stuck: it runs on.)
        return opts.stopFails ? { code: 1, stdout: "", stderr: "Error response from daemon: cannot stop container: did not receive an exit event" } : ok();
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
  const layoutMoves = memoryLayoutMoves();
  const moved: { run: string; entries: readonly LayoutEntry[] }[] = [];
  const workspaces = opts.disk
    ? { available: async () => true, create: async () => `/var/lib/invincible-workspaces/${ID}`, mount: async () => {}, retain: async () => {}, remove: async () => {}, stats: async () => ({ totalBytes: 10 ** 12, freeBytes: 10 ** 12, images: [] }) }
    : null;
  // Each lease minted is a token of its own, by its number; what was asked of each is kept.
  const tokens = { minted: [] as { label: string; providers?: string[]; models?: string[]; ttlMinutes: number; maxRequests: number }[], extended: [] as string[], revoked: [] as string[] };
  const host = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16, microVMs: true, runner, ledger: (e) => void ledger.push(e), layout2: opts.layout2 ?? true, moved: (run, entries) => void moved.push({ run, entries }),
    tokens: {
      mint: (scope) => {
        tokens.minted.push(scope);
        return { token: `test-only-token-${tokens.minted.length}`, info: { hash: `test-only-hash-${tokens.minted.length}` } };
      },
      revoke: (hash) => (tokens.revoked.push(hash), true),
      extend: (hash) => (tokens.extended.push(hash), !opts.extendFails),
    },
    tokenStore: memoryTokenStore(),
    layoutMoves,
    ...(workspaces ? { workspaces } : {}),
  });
  const agent = () => containers.get(containerName(ID))!;
  return { host, calls, containers, ledger, moved, modes, words, agent, leases, tokens, layoutMoves };
}

describe("a store's list, whole or not at all (the review's F3, swept)", () => {
  test("cut at the node's cap, it is never read in part: the dry run refuses it, and the move waits, saying why", async () => {
    const f = fake({ listCut: true });
    await expect(f.host.layoutList(ID)).rejects.toThrow("the agent's store lists more than the node reads");
    await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    // (Listed, and not moved: it stays in layout 1, and the ledger says why.)
    expect(f.modes).toEqual(["list", "list"]);
    expect(f.moved).toEqual([]);
    expect(f.ledger.some((e) => e.detail?.startsWith("not moved to layout 2, so it stays as it was: the agent's store lists more than the node reads"))).toBe(true);
  });
});

describe("an agent's VM in layout 1, at a prepare while nothing runs in it", () => {
  test("is moved to layout 2: its store's entries renamed into its three trees, and its VM made again on them", async () => {
    const f = fake();
    await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    // Listed, moved, and its trees checked as they are about to be mounted.
    expect(f.modes).toEqual(["list", "move", "check"]);
    // The one-off runs as the VM's user, with no network and no capability; the list and the check see its store read-only.
    const oneOffs = f.calls.filter((a) => a[0] === "run" && a.includes("--rm"));
    for (const args of oneOffs) {
      expect(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2)).toEqual(["--user", "1000:1000"]);
      expect(args).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "--read-only"]));
      // (Told the lease's name, to drop it, and its notes' place in a HOME, to take them to their own tree.)
      expect(args.slice(args.indexOf(LEASE_FILE), args.indexOf(LEASE_FILE) + 2)).toEqual([LEASE_FILE, NOTES_DIR]);
    }
    expect(oneOffs[0]).toContain(`type=volume,src=${volumeName(ID)},dst=/work,readonly`);
    expect(oneOffs[1]).toContain(`type=volume,src=${volumeName(ID)},dst=/work`);
    expect(oneOffs[2]).toContain(`type=volume,src=${volumeName(ID)},dst=/work,readonly`);
    // The move alone is given its word (the node's, 128 bits, kept here until it is done): never the list or the check.
    expect(f.words[0]).toBeNull();
    expect(f.words[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(f.words[2]).toBeNull();
    expect(f.layoutMoves.started(ID)).toBeNull();
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
    expect(image.modes).toEqual(["list", "move", "check"]);
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
    expect(f.modes).toEqual(["list", "move", "check", "back"]);
    // Put back with the move's own word, and then there is no move under way.
    expect(f.words[3]).toBe(f.words[1]);
    expect(f.layoutMoves.started(ID)).toBeNull();
    expect(f.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    expect(f.agent().mounts).toEqual([{ Type: "volume", Name: volumeName(ID), Destination: "/work" }]);
    expect(f.ledger.some((e) => e.detail?.startsWith("not moved to layout 2, so it stays as it was"))).toBe(true);
    expect(f.moved).toEqual([]);
    expect(prepared.status).toBe("running");
  });
});

describe("its trees, checked before each mount (the fourth fabric review's R4-1)", () => {
  const WRONG = "its trees aren't folders of the store's own (home is a link)";

  test("a move whose trees aren't the store's own is put back: nothing of it mounted, its VM in layout 1, the ledger says why", async () => {
    const f = fake({ checkFails: WRONG, disk: true });
    const prepared = await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(f.modes).toEqual(["list", "move", "check", "back"]);
    expect(f.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    expect(f.agent().mounts).toEqual([{ Type: "bind", Source: `/var/lib/invincible-workspaces/${ID}`, Destination: "/work" }]);
    // (No VM was made on its trees: the only docker run that isn't a one-off never came.)
    expect(f.calls.filter((a) => a[0] === "run" && !a.includes("--rm"))).toEqual([]);
    expect(f.ledger.some((e) => e.detail === `not moved to layout 2, so it stays as it was: could not make the agent's VM again, so it is as it was: nothing of the agent's store was mounted: ${WRONG}`)).toBe(true);
    expect(f.moved).toEqual([]);
    expect(prepared.status).toBe("running");
  });

  test("a VM in layout 2 isn't started on trees that aren't its store's own", async () => {
    const f = fake({ layout: "2", disk: true, checkFails: WRONG });
    await expect(f.host.prepareTeam(ID, RUN, undefined, ["openai"])).rejects.toThrow(`nothing of the agent's store was mounted: ${WRONG}`);
    expect(f.modes).toEqual(["check"]);
    expect(f.calls.some((a) => a[0] === "start")).toBe(false);
    expect(f.agent().status).toBe("exited");
  });

  test("a store made new whose trees aren't its own is taken away, and no VM is made on it", async () => {
    const f = fake({ checkFails: WRONG });
    f.containers.clear();
    await expect(f.host.create({ network: "gateway", cpus: 1, memoryGb: 2, ttlMinutes: 60, persistent: true, run: "arm.team.abcdef0124.noa" })).rejects.toThrow(`could not make the agent's store: nothing of the agent's store was mounted: ${WRONG}`);
    expect(f.modes).toEqual(["make", "check"]);
    expect(f.containers.size).toBe(0);
    expect(f.calls.some((a) => a[0] === "volume" && a[1] === "rm")).toBe(true);
  });

  test("one whose store couldn't be put back isn't started on it; its next prepare takes the move up again, with its own word", async () => {
    const opts = { runFails: true, backFails: true };
    const f = fake(opts);
    await expect(f.host.prepareTeam(ID, RUN, undefined, ["openai"])).rejects.toThrow("the agent's store is half moved to layout 2 and couldn't be put back, so its VM isn't started on it");
    expect(f.modes).toEqual(["list", "move", "check", "back"]);
    expect(f.agent().status).toBe("exited");
    expect(f.calls.some((a) => a[0] === "start")).toBe(false);
    const underway = f.layoutMoves.started(ID)!;
    expect(underway.nonce).toBe(f.words[1]!);
    expect(underway.entries).toEqual(LISTED);
    // With Docker well again: moved on with the same word, and what it listed before it began, and you're told.
    opts.runFails = false;
    opts.backFails = false;
    f.modes.length = 0;
    f.words.length = 0;
    const prepared = await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(f.modes).toEqual(["move", "check"]);
    expect(f.words[0]).toBe(underway.nonce);
    expect(prepared.status).toBe("running");
    expect(f.agent().labels[`${LABEL}.layout`]).toBe("2");
    expect(f.layoutMoves.started(ID)).toBeNull();
    expect(f.ledger.find((e) => e.detail?.startsWith("made again in layout 2"))!.detail).toStartWith("made again in layout 2, taking up a move that was under way · to its HOME: 1 entries, 2048 bytes");
    expect(f.moved).toEqual([{ run: RUN, entries: LISTED }]);
  });
});

describe("an agent's VM in layout 2", () => {
  test("made again by its owner, it stays in layout 2", async () => {
    const f = fake({ layout: "2" });
    await f.host.remakeTeam(ID, RUN, { providers: ["openai"], approvedBy: "test-owner" });
    // (Its trees checked as they are about to be mounted again.)
    expect(f.modes).toEqual(["check"]);
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
    // (Under the agent's VM's label, which a task's spend is counted by: what a run on a seat spends through the gateway is
    // its task's, as it was when it used the agent's lease. Its token, and so its revoking, is its own.)
    expect(its).toEqual({ ...mine, label: `sandbox:${ID}` });
    expect(seatId).not.toBe(ID);
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
    expect(f.tokens.minted.at(-1)).toEqual({ label: `sandbox:${ID}`, providers: ["anthropic"], models: ["anthropic/claude-paid"], ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
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
    expect(f.modes).toEqual(["make", "check"]);
    expect(f.words[0]).toMatch(/^[0-9a-f]{32}$/);
    const made = [...f.containers.values()].find((c) => c.labels[`${LABEL}.run`] === "arm.team.abcdef0124.noa")!;
    expect(made.labels[`${LABEL}.layout`]).toBe("2");
    expect(made.mounts.map((m) => [m.Destination, m.Subpath])).toEqual([["/work", "work"], ["/home/agent", "home"], ["/home/agent/.memory/engram", "notes"]]);
    // Anything else it makes stays as it was made: a sandbox for a run is in layout 1.
    f.modes.length = 0;
    await f.host.create({ network: "gateway", cpus: 1, memoryGb: 2, ttlMinutes: 60, persistent: false, run: "adhoc-test" });
    expect(f.modes).toEqual([]);
  });
});

/*
 * Another node's task's VM (createTaskVm; the owner's decision of 27 November 2026, the fabric's R3-1 (a)): one of its
 * own, from the agent's VM's image, with a /work and a HOME of its own and nothing of the agent's store (the fifth fabric
 * review's R5-3: the task works on a clone of its own); leased the task's models alone, never your keys nor its
 * repository; labelled with its task, and gone, with all it started, as the task ends.
 */
describe("a VM whose layout Docker can't say (the fifth fabric review's R5-8)", () => {
  const CANT = "could not tell which layout the agent's VM is in, so nothing of its store is mounted: Error response from daemon: context deadline exceeded";
  // Anything that mounts the store, or would change it: a VM made, started, stopped or set aside, or a one-off on it.
  const mounted = (f: ReturnType<typeof fake>) => f.calls.filter((a) => ["run", "start", "stop", "rename", "rm"].includes(a[0]!));

  test("isn't started, nor moved as if it were in layout 1, at a prepare: nothing of its store is mounted, and the error says why", async () => {
    for (const layout2 of [true, false]) {
      const f = fake({ layout: "2", labelFails: true, layout2 });
      await expect(f.host.prepareTeam(ID, RUN, undefined, ["openai"])).rejects.toThrow(CANT);
      expect([layout2, mounted(f)]).toEqual([layout2, []]);
      expect(f.modes).toEqual([]);
      expect(f.agent().status).toBe("exited");
    }
  });

  test("isn't made again by its owner in layout 1 on its store", async () => {
    for (const disk of [false, true]) {
      const f = fake({ layout: "2", labelFails: true, disk });
      await expect(f.host.remakeTeam(ID, RUN, { providers: ["openai"], approvedBy: "test-owner" })).rejects.toThrow(CANT);
      expect([disk, mounted(f)]).toEqual([disk, []]);
      expect(f.agent().labels[`${LABEL}.layout`]).toBe("2");
    }
  });

  test("has no seat's VM made beside it on its store's root", async () => {
    const SEAT = { id: `st_${"b".repeat(22)}`, kind: "claude-subscription" as const, runs: 1 };
    const f = fake({ layout: "2", labelFails: true });
    f.agent().status = "running";
    await expect(f.host.createSeatVm({ seat: SEAT, network: "online", cpus: 1, memoryGb: 2, ttlMinutes: 30, run: `seat.${SEAT.id}`, shares: ID })).rejects.toThrow(CANT);
    expect(mounted(f)).toEqual([]);
    expect([...f.containers.values()].some((c) => c.labels[`${LABEL}.shares`] === ID)).toBe(false);
  });
});

describe("a VM that shares an agent's store, and its move to layout 2 (the fifth fabric review's R5-1)", () => {
  const SEAT = { id: `st_${"c".repeat(22)}`, kind: "claude-subscription" as const, runs: 1 };
  const onSeat = { seat: SEAT, network: "online" as const, cpus: 1, memoryGb: 2, ttlMinutes: 30, run: `seat.${SEAT.id}`, shares: ID };
  /** A VM made before the agent's move that shares its whole store (no tree): in layout 1 a seat's run's. */
  const rootSharer = (f: ReturnType<typeof fake>, status: string) =>
    f.containers.set("invincible-sbx-7777777777", { labels: { [LABEL]: "1", [`${LABEL}.id`]: "7777777777", [`${LABEL}.node`]: "test", [`${LABEL}.shares`]: ID }, mounts: [{ Type: "volume", Name: volumeName(ID), Destination: "/work" }], status, image: IMAGE });
  const sharers = (f: ReturnType<typeof fake>) => [...f.containers.entries()].filter(([name, c]) => c.labels[`${LABEL}.shares`] === ID && name !== "invincible-sbx-7777777777");

  test("a seat's VM asked for while a move is about to begin is refused, and none is made on the store's root", async () => {
    let release!: () => void;
    const f = fake({ listWaits: new Promise<void>((resolve) => (release = resolve)) });
    const preparing = f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    // (The move has begun: the store's list is under way, before anything of it is written down as moving.)
    for (let i = 0; i < 200 && !f.modes.includes("list"); i++) await Bun.sleep(5);
    expect(f.modes).toEqual(["list"]);
    await expect(f.host.createSeatVm(onSeat)).rejects.toThrow("that agent's store is being moved to layout 2");
    expect(sharers(f)).toEqual([]);
    release();
    await preparing;
    expect(f.agent().labels[`${LABEL}.layout`]).toBe("2");
  });

  test("a move doesn't begin while a VM shares the store, stopped as well as running", async () => {
    for (const status of ["exited", "running"]) {
      const f = fake();
      rootSharer(f, status);
      await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
      expect([status, f.modes]).toEqual([status, []]);
      expect(f.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    }
  });

  test("a VM in layout 2 isn't started, made again or shared beside one that holds its store's whole root", async () => {
    const f = fake({ layout: "2" });
    rootSharer(f, "exited");
    const held = "a VM made before that agent's move to layout 2 shares its whole store (invincible-sbx-7777777777), and holds its root";
    await expect(f.host.prepareTeam(ID, RUN, undefined, ["openai"])).rejects.toThrow(held);
    expect(f.calls.some((a) => a[0] === "start")).toBe(false);
    await expect(f.host.remakeTeam(ID, RUN, { providers: ["openai"], approvedBy: "test-owner" })).rejects.toThrow(held);
    expect(f.calls.some((a) => a[0] === "stop" || a[0] === "rename")).toBe(false);
    expect(sharers(f)).toEqual([]);
    expect(f.modes).toEqual([]);
  });

  test("what a VM shares is decided again as it is made: a share decided in layout 1 isn't made once the store is in layout 2", async () => {
    const f = fake({ layout: "2" });
    f.agent().status = "running";
    await expect(f.host.create({ network: "online", cpus: 1, memoryGb: 2, ttlMinutes: 30, persistent: false, run: "seat.late" }, { shares: { sandbox: ID, volume: volumeName(ID) } })).rejects.toThrow("that agent's store is in layout 2 now, not as this VM was to share it");
    expect(sharers(f)).toEqual([]);
  });

  test("a move whose VM won't stop is never begun: nothing of its store is renamed, and the ledger says why", async () => {
    const f = fake({ stopFails: true });
    f.agent().status = "running";
    await f.host.prepareTeam(ID, RUN, undefined, ["openai"]);
    expect(f.modes).toEqual(["list"]);
    expect(f.calls.some((a) => a[0] === "rename")).toBe(false);
    expect(f.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    expect(f.ledger.some((e) => e.detail?.startsWith("not moved to layout 2, so it stays as it was: could not stop the agent's VM, so it isn't made again"))).toBe(true);
    expect(f.layoutMoves.started(ID)).toBeNull();
  });
});

describe("another node's task's VM", () => {
  const task = { task: "task-abcdefghijkl", beside: ID, run: "handed.task-abcdefghijkl", providers: ["anthropic"], models: ["anthropic/claude-paid"], ttlMinutes: 60 };

  test("has a /work and a HOME of its own, and nothing of the agent's store; leased the task's models alone; labelled with its task", async () => {
    const f = fake({ layout: "2" });
    await f.host.prepareTeam(ID, RUN, { connector: "github", owner: "example", repo: "app" }, ["anthropic"], undefined, ["key:test-only"]);
    const vm = await f.host.createTaskVm(task);
    const made = f.containers.get(containerName(vm.id))!;
    expect(made.labels[`${LABEL}.task`]).toBe(task.task);
    expect(made.labels[`${LABEL}.shares`]).toBeUndefined();
    expect(made.image).toBe(IMAGE);
    expect(made.mounts).toEqual([{ Type: "volume", Name: volumeName(vm.id), Destination: "/work" }]);
    const run = f.calls.find((a) => a[0] === "run" && a.includes(`${LABEL}.task=${task.task}`))!;
    expect(run).toEqual(expect.arrayContaining(["--tmpfs", "/home/agent:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700", "HOME=/home/agent"]));
    // Its lease: its models alone, on their providers; none of the agent's keys or its repository, though the agent's has them.
    // (Under the agent's VM's label, which its task's spend and budget are counted by: its token is its own.)
    expect(f.tokens.minted.at(-1)).toEqual({ label: `sandbox:${ID}`, providers: ["anthropic"], models: ["anthropic/claude-paid"], ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
    const lease = f.leases.get(containerName(vm.id))!;
    expect([lease.INVINCIBLE_REPO_URL, lease.INVINCIBLE_KEYS]).toEqual([undefined, undefined]);
    expect(f.leases.get(containerName(ID))!.INVINCIBLE_REPO_URL).toBeDefined();
    expect(f.ledger.find((e) => e.resource === "sandbox.task-lease")?.detail).toContain("for anthropic/claude-paid alone");
    // Renewed with the agent's, and revoked as it goes.
    await f.host.renewTeam(ID, RUN);
    expect(f.tokens.extended).toEqual(["test-only-hash-1", "test-only-hash-2"]);
    await f.host.destroy(vm.id, { run: task.run });
    expect(f.tokens.revoked).toEqual(["test-only-hash-2"]);
    // And it is known as what it is: a task's, which no route reaches into.
    expect(await f.host.taskVms()).toEqual([]);
  });

  test("its lease ended as its task ends (R4-7) is revoked then, and never renewed with its agent's again, whatever becomes of the VM", async () => {
    const f = fake({ layout: "2" });
    await f.host.prepareTeam(ID, RUN, undefined, ["anthropic"]);
    const vm = await f.host.createTaskVm(task);
    f.host.endLease(vm.id);
    expect(f.tokens.revoked).toEqual(["test-only-hash-2"]);
    // The VM is still there (its removal yet to come, or failed), and its agent's lease is renewed: never its own.
    expect(await f.host.taskVms()).toEqual([vm.id]);
    await f.host.renewTeam(ID, RUN);
    await f.host.renewTeam(ID, RUN);
    expect(f.tokens.extended).toEqual(["test-only-hash-1", "test-only-hash-1"]);
    // Ended again, or removed after: nothing more to revoke.
    f.host.endLease(vm.id);
    await f.host.destroy(vm.id, { run: task.run });
    expect(f.tokens.revoked).toEqual(["test-only-hash-2"]);
  });

  test("is listed by its id while it is there, and is a task's in its view", async () => {
    const f = fake({ layout: "2" });
    f.agent().status = "running";
    const vm = await f.host.createTaskVm(task);
    expect(await f.host.taskVms()).toEqual([vm.id]);
    expect((await f.host.get(vm.id))?.task).toBe(task.task);
  });

  test("is made beside an agent's VM in layout 1 too, sharing nothing of it; refused beside one that isn't here, and on a Mac", async () => {
    const old = fake();
    old.agent().status = "running";
    const vm = await old.host.createTaskVm(task);
    expect(old.containers.get(containerName(vm.id))!.mounts).toEqual([{ Type: "volume", Name: volumeName(vm.id), Destination: "/work" }]);
    expect(old.agent().labels[`${LABEL}.layout`]).toBeUndefined();
    await expect(fake({ layout: "2" }).host.createTaskVm({ ...task, beside: "9876543210" })).rejects.toMatchObject({ status: 404 });
    const mac = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, runner: async () => ({ code: 1, stdout: "", stderr: "" }), ledger: () => {}, engine: "container", tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true } });
    await expect(mac.createTaskVm(task)).rejects.toMatchObject({ status: 424 });
  });
});
