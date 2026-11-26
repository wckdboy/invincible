import type { DockerRunner } from "../../packages/sandbox/src/host.ts";

/*
 * The desktop suite's Docker: the real SandboxHost (its run arguments, its exec, its desktop), run through a runner
 * that gives everything it makes names and a label of the bench's own. On a host that runs a live node beside it,
 * the node lists sandboxes by its label (`dev.invincible`) and names them `invincible-sbx-<id>`: the bench's
 * are `dev.<prefix>` and `<prefix>-sbx-<id>`, and its images `<prefix>/…`, so no live node ever lists, keeps, prunes
 * or removes one, and the bench never touches one of theirs.
 *
 * What the runner does to a command, by its kind:
 *  - `exec`: the container's name, and nothing after it (the command and its arguments are the VM's data);
 *  - `run`: every option and the image, and nothing after the image; its only network is none (the live nodes'
 *    networks are theirs), and its image must be one of the bench's;
 *  - the rest (ps, inspect, volume, rm, stop, start…): every argument, and what Docker answers is mapped back, so the
 *    host reads its own names (never an exec's output, which is the command's own and may hold anything).
 * It refuses outright what could reach past its own: networks, builds (the suite builds its images itself, from this
 * checkout: images.ts), prunes, kills, and any argument that still names a live node's thing once mapped.
 */

/** A prefix the bench's names are made with: short, lower-case, never a live node's own. */
export const SCRATCH_PREFIX = /^[a-z][a-z0-9]{0,15}$/;
/** The node's own word, which the bench's names replace: never left in what the bench runs. */
const NODE = /invincible/i;
/** Docker commands the bench never runs (images are built by images.ts, under the bench's names, from this checkout). */
const REFUSED = new Set(["network", "system", "builder", "buildx", "build", "kill", "pause", "unpause", "commit", "push", "pull", "login", "logout", "swarm", "service", "stack", "plugin", "context", "compose"]);
const PRUNE = new Set(["prune"]);
/** `docker exec` options that take a value (the rest are flags). */
const EXEC_VALUED = new Set(["--workdir", "-w", "--env", "-e", "--user", "-u", "--env-file", "--detach-keys"]);
/** `docker run` flags that take no value; every other option takes one. */
const RUN_FLAGS = new Set(["--detach", "-d", "--init", "--read-only", "--rm", "--interactive", "-i", "--tty", "-t", "--privileged", "--sig-proxy", "--quiet", "-q"]);

export class ScratchRefusal extends Error {}

export function checkPrefix(prefix: string): string {
  if (!SCRATCH_PREFIX.test(prefix) || NODE.test(prefix)) throw new ScratchRefusal(`"${prefix}" can't be the bench's prefix: lower-case letters and digits, a letter first, at most 16, and never the node's own name`);
  return prefix;
}

/** The bench's own names, as the live node's map to them. */
export function scratchNames(prefix: string) {
  checkPrefix(prefix);
  return {
    prefix,
    label: `dev.${prefix}`,
    container: (id: string) => `${prefix}-sbx-${id}`,
    volume: (id: string) => `${prefix}-sbx-${id}-work`,
    /** `invincible/desktop:1` → `<prefix>/desktop:1`. */
    image: (tag: string) => tag.replace(/^invincible\//, `${prefix}/`),
  };
}

/**
 * One argument of the node's, in the bench's names: every "invincible" its prefix. What still names a sandbox (`*-sbx-*`)
 * or a label (`dev.*`) that isn't the bench's then is another node's (one on the same host names its own the same way),
 * and is refused.
 */
const own = (arg: string, prefix: string): string => {
  const mapped = arg.replace(/invincible/g, prefix);
  const theirs = [...mapped.matchAll(/([A-Za-z0-9_.-]*)-sbx-/g)].find((m) => !m[1]!.endsWith(prefix) || /[A-Za-z0-9]/.test(m[1]!.slice(0, -prefix.length).slice(-1)))
    ?? [...mapped.matchAll(/\bdev\.([a-z0-9-]+)/g)].find((m) => m[1] !== prefix);
  if (NODE.test(mapped) || theirs) throw new ScratchRefusal(`the bench names only its own things, and this is another's: ${arg.slice(0, 80)}`);
  return mapped;
};

/** A docker command of the node's, as the bench runs it. Throws ScratchRefusal for what it never runs. */
export function scratchArgs(args: readonly string[], prefix: string): string[] {
  checkPrefix(prefix);
  const [command, sub] = args;
  if (!command) throw new ScratchRefusal("no docker command");
  if (REFUSED.has(command)) throw new ScratchRefusal(`the bench never runs docker ${command}`);
  if (sub && PRUNE.has(sub)) throw new ScratchRefusal(`the bench never prunes (docker ${command} ${sub})`);
  if (command === "exec") {
    const out = ["exec"];
    let i = 1;
    for (; i < args.length; i++) {
      const arg = args[i]!;
      if (!arg.startsWith("-")) break;
      out.push(arg);
      if (EXEC_VALUED.has(arg)) out.push(args[++i] ?? "");
    }
    const name = args[i];
    if (!name) throw new ScratchRefusal("docker exec with no container");
    return [...out, own(name, prefix), ...args.slice(i + 1)];
  }
  if (command === "run") {
    const out = ["run"];
    let i = 1;
    for (; i < args.length; i++) {
      const arg = args[i]!;
      if (!arg.startsWith("-")) break;
      if (RUN_FLAGS.has(arg) || arg.includes("=")) {
        if (/^--network=/.test(arg) && arg !== "--network=none") throw new ScratchRefusal("a bench VM has no network but none: the live nodes' networks are theirs");
        out.push(own(arg, prefix));
        continue;
      }
      const value = args[++i] ?? "";
      if (arg === "--network" && value !== "none") throw new ScratchRefusal(`a bench VM has no network but none (asked for ${value}): the live nodes' networks are theirs`);
      // (The environment is the VM's: passed as it is.)
      out.push(arg, arg === "--env" || arg === "-e" ? value : own(value, prefix));
    }
    const image = args[i];
    if (!image) throw new ScratchRefusal("docker run with no image");
    const mapped = own(image, prefix);
    if (!mapped.startsWith(`${prefix}/`)) throw new ScratchRefusal(`a bench VM is made only from the bench's own images, not ${image}`);
    return [...out, mapped, ...args.slice(i + 1)];
  }
  return args.map((arg) => own(arg, prefix));
}

/** What Docker said about the bench's things, in the node's names again (never an exec's output). */
export function fromScratch(text: string, prefix: string): string {
  checkPrefix(prefix);
  return text
    .replace(new RegExp(`\\bdev\\.${prefix}\\b`, "g"), "dev.invincible")
    .replace(new RegExp(`(^|[^A-Za-z0-9_.-])${prefix}-sbx-`, "gm"), "$1invincible-sbx-")
    .replace(new RegExp(`(^|["'\\s=:])${prefix}/`, "gm"), "$1invincible/");
}

export type Spawn = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** docker itself: no stdin, its output whole, killed past its time. */
export const spawnDocker: Spawn = async (args, timeoutMs) => {
  const proc = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

/** The runner the bench's SandboxHost is given. A refused command answers as Docker's own failure would, with why. */
export function scratchRunner(prefix: string, spawn: Spawn = spawnDocker): DockerRunner {
  checkPrefix(prefix);
  return async (args, timeoutMs) => {
    let mapped: string[];
    try {
      mapped = scratchArgs(args, prefix);
    } catch (error) {
      if (error instanceof ScratchRefusal) return { code: 125, stdout: "", stderr: `bench: ${error.message}` };
      throw error;
    }
    const ran = await spawn(mapped, timeoutMs);
    if (args[0] === "exec" || args[0] === "cp") return ran;
    return { code: ran.code, stdout: fromScratch(ran.stdout, prefix), stderr: fromScratch(ran.stderr, prefix) };
  };
}
