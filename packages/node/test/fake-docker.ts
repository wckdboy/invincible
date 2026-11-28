import { type DockerRunner, withoutInput } from "@invincible/sandbox";

/*
 * A stand-in for Docker, for tests on machines without one: it answers the commands
 * the sandbox host runs (info, inspect, run, ps, exec, stop, start, rename, rm, update, volumes, networks) from
 * memory, so the real host's own logic (labels, the ledger, approvals, reaping)
 * runs unchanged above it. Nothing is spawned.
 *
 * A lease a VM is given (the host's writeLease) is kept where that VM's mounts put it: in the volume and subpath, the
 * host folder or the VM's own memory that holds its HOME. lease() reads it back where a command run in a VM would read
 * one (its HOME, as the VM was told it), so a VM that shares another's files sees what those files hold, and nothing else.
 */

interface Container {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** Its mounts as it was run (`--mount type=…,src=…,dst=…`), as `docker inspect` says them. */
  mounts: { Type: string; Name?: string; Source?: string; Destination: string }[];
  status: string;
  /** What Docker holds it to (--cpus and --memory as it was run, or as `docker update` changed them). */
  held: { NanoCpus: number; Memory: number };
  /** Its environment as it was run (--env), its own memory's folders (--tmpfs), and each volume mount's subpath. */
  env: Record<string, string>;
  tmpfs: string[];
  subpaths: Record<string, string>;
  /** Its own, as it was run: what its memory and its own disk hold are no other's. */
  key: number;
}

/** `--cpus 2` and `--memory 4096m`, as Docker keeps them. */
const heldOf = (args: string[], before?: Container["held"]): Container["held"] => {
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  return {
    NanoCpus: args.includes("--cpus") ? Number(at("--cpus")) * 1e9 : (before?.NanoCpus ?? 0),
    Memory: args.includes("--memory") ? Number.parseInt(at("--memory")!, 10) * 2 ** 20 : (before?.Memory ?? 0),
  };
};

export interface FakeDocker {
  runner: DockerRunner;
  /** Every `docker exec` command, as the sandbox ran it (after its timeout wrapper). */
  execs: { container: string; cmd: string[] }[];
  /** Containers alive now, and the most there ever were at once. */
  running(): number;
  peak(): number;
  /** How `docker exec` answers (default: exit 0, nothing printed). */
  onExec?: (container: string, cmd: string[]) => Promise<{ code: number; stdout: string; stderr?: string }> | { code: number; stdout: string; stderr?: string };
  /** How long `docker run` takes (ms). */
  startMs: number;
  /** The lease a VM's commands would read now, from its HOME (the JSON the host wrote), or null where there is none. */
  lease(container: string): Record<string, string> | null;
}

/** The lease's file in a VM's HOME, and the host's write of it (writeLease), by a word of its script. */
const LEASE_FILE = ".invincible-gateway.json";
const LEASE_WRITE = "prefix='.invincible-gateway-'";

/** `engine`: the Docker Engine version it says it is (`docker version`); none, as by default, and it says nothing, so an agent's VM on a volume stays in layout 1. */
export function fakeDocker(opts: { engine?: string } = {}): FakeDocker {
  const containers = new Map<string, Container>();
  /** Files written in VMs, by where they are: a volume's (by its name and the path in it), a host folder's, or a VM's own. */
  const files = new Map<string, string>();
  let made = 0;
  let peak = 0;
  /** Where a path in a VM is: under the deepest of its mounts that holds it, else on its own disk. */
  const where = (c: Container, path: string): string => {
    const mounts = [
      ...c.mounts.map((m) => ({ at: m.Destination, base: m.Type === "volume" ? `volume:${m.Name}:/${c.subpaths[m.Destination] ?? ""}` : `bind::${m.Source}` })),
      ...c.tmpfs.map((at) => ({ at, base: `tmpfs:${c.key}:${at}` })),
    ].filter((m) => path === m.at || path.startsWith(`${m.at}/`)).sort((a, b) => b.at.length - a.at.length);
    const holder = mounts[0];
    return holder ? `${holder.base}/${path.slice(holder.at.length)}`.replace(/\/+/g, "/") : `own:${c.key}:${path}`;
  };
  const homeOf = (c: Container) => c.env.HOME ?? "/";
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr = "No such object") => ({ code: 1, stdout: "", stderr });
  const fake: FakeDocker = {
    execs: [],
    startMs: 0,
    running: () => [...containers.values()].filter((c) => c.status === "running").length,
    peak: () => peak,
    lease: (name) => {
      const container = containers.get(name);
      const held = container ? files.get(where(container, `${homeOf(container)}/${LEASE_FILE}`)) : undefined;
      return held === undefined ? null : (JSON.parse(held) as Record<string, string>);
    },
    runner: async (args) => {
      const [command, ...rest] = args;
      switch (command) {
        case "info":
          return ok("27.0.0-fake");
        case "version":
          return opts.engine ? ok(opts.engine) : no("fake docker says no version");
        case "image":
          return rest[0] === "inspect" ? ok("sha256:fake") : no();
        case "network":
          return ok("net");
        case "volume":
          return ok();
        case "container":
          // Keeper containers (image pins): none here.
          return no();
        case "create":
          return ok("keeper");
        case "build":
          return ok("built");
        case "run": {
          // A one-off (a store's move, a seat home's hand-over) runs and leaves nothing behind.
          if (rest.includes("--rm")) return ok();
          if (fake.startMs) await Bun.sleep(fake.startMs);
          const name = rest[rest.indexOf("--name") + 1]!;
          const labels: Record<string, string> = {};
          const env: Record<string, string> = {};
          const tmpfs: string[] = [];
          const subpaths: Record<string, string> = {};
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "--label") {
              const [key, ...value] = rest[i + 1]!.split("=");
              labels[key!] = value.join("=");
            }
            if (rest[i] === "--env") {
              const [key, ...value] = rest[i + 1]!.split("=");
              env[key!] = value.join("=");
            }
            if (rest[i] === "--tmpfs") tmpfs.push(rest[i + 1]!.split(":")[0]!);
          }
          const mounts: Container["mounts"] = [];
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] !== "--mount") continue;
            const parts = Object.fromEntries(rest[i + 1]!.split(",").map((kv) => kv.split("=") as [string, string]));
            mounts.push({ Type: parts.type!, ...(parts.type === "volume" ? { Name: parts.src } : { Source: parts.src }), Destination: parts.dst! });
            if (parts["volume-subpath"]) subpaths[parts.dst!] = parts["volume-subpath"];
          }
          // The image comes before the command (`sleep infinity`).
          const image = rest[rest.length - 3]!;
          containers.set(name, { name, image, labels, mounts, status: "running", held: heldOf(rest), env, tmpfs, subpaths, key: ++made });
          peak = Math.max(peak, fake.running());
          return ok(name);
        }
        case "ps": {
          const wanted = rest.filter((_, i) => rest[i - 1] === "--filter").map((f) => f.replace(/^label=/, ""));
          const matching = [...containers.values()].filter((c) => wanted.every((w) => {
            // (A label's key alone: whatever its value.)
            const [key, ...value] = w.split("=");
            return value.length ? c.labels[key!] === value.join("=") : key! in c.labels;
          }));
          if (rest.includes("--format")) return ok(matching.map((c) => c.labels["dev.invincible.id"] ?? "").join("\n"));
          return ok(matching.map((c) => c.name).join("\n"));
        }
        case "inspect": {
          // (Its mounts alone, as the host asks where an agent's /work is; or one of its labels, as it asks which layout it is in.)
          if (rest[0] === "--format" && rest[1] === "{{json .Mounts}}") {
            const container = containers.get(rest[2]!);
            return container ? ok(JSON.stringify(container.mounts)) : no();
          }
          const label = rest[0] === "--format" ? /^\{\{index \.Config\.Labels "([^"]+)"\}\}$/.exec(rest[1]!)?.[1] : undefined;
          if (label) {
            const container = containers.get(rest[2]!);
            return container ? ok(container.labels[label] ?? "") : no();
          }
          const found = rest.map((name) => containers.get(name)).filter((c): c is Container => !!c);
          if (!found.length) return no();
          return ok(JSON.stringify(found.map((c) => ({ Config: { Labels: c.labels, Image: c.image }, State: { Status: c.status }, HostConfig: c.held }))));
        }
        case "exec": {
          const at = rest.findIndex((a) => a.startsWith("invincible-sbx-"));
          const container = rest[at]!;
          if (!containers.has(container)) return no(`No such container: ${container}`);
          // After the container: timeout --signal=KILL <n>s, then <cmd…> (given nothing to read: withoutInput's first).
          const after = rest.slice(at + 4);
          const none = withoutInput([]);
          const cmd = none.every((part, i) => after[i] === part) ? after.slice(none.length) : after;
          fake.execs.push({ container, cmd });
          const answer = (await fake.onExec?.(container, cmd)) ?? { code: 0, stdout: "" };
          // A lease the host wrote is kept where the VM's HOME is (its payload: the JSON, base64, its last argument).
          if (answer.code === 0 && cmd.some((part) => part.includes(LEASE_WRITE))) {
            const c = containers.get(container)!;
            files.set(where(c, `${homeOf(c)}/${LEASE_FILE}`), Buffer.from(cmd.at(-1)!, "base64").toString("utf8"));
          }
          return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" };
        }
        case "stop":
        case "start": {
          const container = containers.get(rest.at(-1)!);
          if (!container) return no(`No such container: ${rest.at(-1)}`);
          container.status = command === "stop" ? "exited" : "running";
          return ok(container.name);
        }
        case "rename": {
          const [from, to] = rest as [string, string];
          const container = containers.get(from);
          if (!container || containers.has(to)) return no(container ? `the name ${to} is in use` : `No such container: ${from}`);
          containers.delete(from);
          containers.set(to, { ...container, name: to });
          return ok();
        }
        case "update": {
          const container = containers.get(rest.at(-1)!);
          if (!container) return no(`No such container: ${rest.at(-1)}`);
          container.held = heldOf(rest, container.held);
          return ok(container.name);
        }
        case "rm": {
          const name = rest.at(-1)!;
          containers.delete(name);
          return ok(name);
        }
        default:
          return no(`fake docker doesn't know "${command}"`);
      }
    },
  };
  return fake;
}
