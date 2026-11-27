import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE, imagesAtStart, OWN_IMAGES, readImagesRecord, SandboxHost } from "../src/index.ts";

/*
 * A node's own images made again for a new release, at its start: a context the release changed makes its image anew
 * under the same tag, its keeper follows the new build and the old one goes. Docker here is a stand-in that knows tags,
 * their builds, keepers and removals: a build makes a new image only when what it's made of changed, its context or its
 * base's build, as Docker's cache does.
 */

/** The contexts of the node's own images, under one folder as a release has them (sandbox/). */
const contexts = () => mkdtempSync(join(tmpdir(), "invincible-contexts-"));
const dirOf = (root: string, image: string) => join(root, OWN_IMAGES[image]!.context);

function docker() {
  const images = new Map<string, string>();
  const keepers = new Map<string, string>();
  // (What each is made of, as Docker says it: its layers and its config.)
  const contents = new Map<string, string>();
  // (As Docker's BuildKit with its provenance attestation: every build an id of its own, what it is made of the same.)
  let attests = false;
  const versions = new Map<string, number>();
  const failing = new Set<string>();
  const builds: string[] = [];
  const pulled: string[] = [];
  const removed: string[] = [];
  let next = 0;
  const id = () => `sha256:${(++next).toString(16).padStart(64, "0")}`;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const made = (image: string, dir: string) => {
    const base = OWN_IMAGES[image]?.base;
    return `${versions.get(dir) ?? 0}|${base ? contents.get(base) : ""}`;
  };
  const build = (image: string, dir: string) => {
    const now = made(image, dir);
    if (!images.has(image) || contents.get(image) !== now || attests) images.set(image, id());
    contents.set(image, now);
  };
  const run = async (args: string[]) => {
    const [command, sub] = args;
    if (command === "build") {
      const image = args[args.indexOf("-t") + 1]!;
      builds.push(image);
      if (args.includes("--pull")) pulled.push(image);
      if (failing.has(image)) return no('ERROR: failed to solve: process "/bin/sh -c apt-get install" did not complete successfully: exit code: 100');
      build(image, args.at(-1)!);
      return ok();
    }
    if (command === "image" && sub === "inspect") {
      if (!images.has(args[2]!)) return no(`Error: No such image: ${args[2]}`);
      const format = args[args.indexOf("--format") + 1] ?? "";
      return ok(format.includes("RootFS") ? `${images.get(args[2]!)} ["sha256:made-of-${contents.get(args[2]!)}"] {"Env":[]}\n` : `${images.get(args[2]!)}\n`);
    }
    if (command === "image" && sub === "rm") {
      const target = args[2]!;
      if ([...keepers.values()].includes(target)) return no(`Error response from daemon: conflict: unable to delete ${target} (must be forced) - image is being used by stopped container`);
      if ([...images.values()].includes(target)) return no(`Error response from daemon: conflict: unable to delete ${target}: image is tagged`);
      removed.push(target);
      return ok(`Deleted: ${target}\n`);
    }
    if (command === "container" && sub === "inspect") return keepers.has(args[2]!) ? ok(`${keepers.get(args[2]!)}\n`) : no(`Error: No such container: ${args[2]}`);
    if (command === "rm") return keepers.delete(args.at(-1)!), ok();
    if (command === "create") return keepers.set(args[args.indexOf("--name") + 1]!, images.get(args.at(-2)!)!), ok("c0ffee\n");
    return no(`the stand-in knows no docker ${args.join(" ")}`);
  };
  return {
    run,
    images,
    keepers,
    failing,
    builds,
    pulled,
    removed,
    /** Built before, in this order, each kept as the node keeps it. */
    built(root: string, ...tags: string[]) {
      for (const tag of tags) {
        build(tag, dirOf(root, tag));
        keepers.set(OWN_IMAGES[tag]!.keeper, images.get(tag)!);
      }
    },
    /** Builds that each get an id of their own, as Docker's with its provenance attestation. */
    attesting: (on: boolean) => void (attests = on),
    /** The release changed this image's context. */
    change: (root: string, image: string) => versions.set(dirOf(root, image), (versions.get(dirOf(root, image)) ?? 0) + 1),
  };
}

const hostOn = (d: ReturnType<typeof docker>, root: string) =>
  new SandboxHost({ node: "n", tokens: { mint: () => { throw new Error("no lease here"); }, revoke: () => false }, ledger: () => {}, maxCpus: 4, maxMemoryGb: 8, runner: d.run, imageContext: root });
const home = () => mkdtempSync(join(tmpdir(), "invincible-home-"));
const nowait = { pause: async () => {} };

describe("a node's own images at its start", () => {
  test("a built hardware image whose context a new release changed is made anew: its keeper on the new build, the old one gone, the release kept as refreshed", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE);
    const old = d.images.get(HARDWARE_IMAGE)!;
    d.change(root, HARDWARE_IMAGE);
    const at = home();
    await imagesAtStart(hostOn(d, root), { home: at, release: "bbbbbbbbbbbb", log: () => {}, ...nowait });
    const now = d.images.get(HARDWARE_IMAGE)!;
    expect(now).not.toBe(old);
    expect(d.keepers.get(OWN_IMAGES[HARDWARE_IMAGE]!.keeper)).toBe(now);
    expect(d.removed).toContain(old);
    // (From cache: a release's own contexts make an image anew, never a base pulled again.)
    expect(d.pulled).toEqual([]);
    expect(readImagesRecord(at)).toEqual({ refreshedFor: "bbbbbbbbbbbb", tried: { release: "bbbbbbbbbbbb", at: expect.any(Number), failed: [] } });
  });
});

describe("a node's own images at its start, further", () => {
  test("a release refreshed already builds nothing: its images are only kept", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE);
    const at = home();
    await imagesAtStart(hostOn(d, root), { home: at, release: "bbbbbbbbbbbb", log: () => {}, ...nowait });
    const builds = d.builds.length;
    expect(await imagesAtStart(hostOn(d, root), { home: at, release: "bbbbbbbbbbbb", log: () => {}, ...nowait })).toBeNull();
    expect(d.builds).toHaveLength(builds);
  });

  test("it waits a minute after the start before it builds anything, the start's own work first", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE);
    const waited: number[] = [];
    await imagesAtStart(hostOn(d, root), { home: home(), release: "bbbbbbbbbbbb", log: () => {}, pause: async (ms) => void waited.push(ms) });
    expect(waited[0]).toBe(60_000);
    expect(d.builds).toEqual([DEFAULT_IMAGE]);
  });

  test("a base made anew makes the ones made from it anew too, bases first, though their own contexts didn't change", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE);
    const old = { desktop: d.images.get(DESKTOP_IMAGE)!, hardware: d.images.get(HARDWARE_IMAGE)! };
    d.change(root, DESKTOP_IMAGE);
    const done = await hostOn(d, root).refreshImages(nowait);
    expect(d.builds).toEqual([DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE]);
    expect(done).toEqual([
      { image: DEFAULT_IMAGE, outcome: "unchanged" },
      { image: DESKTOP_IMAGE, outcome: "rebuilt" },
      { image: HARDWARE_IMAGE, outcome: "rebuilt" },
    ]);
    expect(d.images.get(HARDWARE_IMAGE)).not.toBe(old.hardware);
    expect(d.removed.sort()).toEqual([old.desktop, old.hardware].sort());
  });

  test("a build that fails keeps its old build and keeper, holds what's made from it, says which and why, and isn't kept as refreshed: the next start tries again, once", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE);
    const old = { desktop: d.images.get(DESKTOP_IMAGE)!, hardware: d.images.get(HARDWARE_IMAGE)! };
    d.change(root, DESKTOP_IMAGE);
    d.failing.add(DESKTOP_IMAGE);
    const at = home();
    const said: string[] = [];
    const done = await imagesAtStart(hostOn(d, root), { home: at, release: "bbbbbbbbbbbb", log: (line) => said.push(line), ...nowait });
    expect(done?.map((r) => r.outcome)).toEqual(["unchanged", "failed", "held"]);
    expect(d.images.get(DESKTOP_IMAGE)).toBe(old.desktop);
    expect(d.images.get(HARDWARE_IMAGE)).toBe(old.hardware);
    expect(d.keepers.get(OWN_IMAGES[DESKTOP_IMAGE]!.keeper)).toBe(old.desktop);
    expect(d.removed).toEqual([]);
    expect(d.builds).not.toContain(HARDWARE_IMAGE);
    expect(said).toEqual([
      `sandbox image ${DESKTOP_IMAGE}: not made anew, its last build kept: ERROR: failed to solve: process "/bin/sh -c apt-get install" did not complete successfully: exit code: 100`,
      `sandbox image ${HARDWARE_IMAGE}: its last build kept: ${DESKTOP_IMAGE} wasn't made anew`,
    ]);
    const record = readImagesRecord(at);
    expect(record.refreshedFor).toBeNull();
    expect(record.tried?.failed.map((f) => f.image)).toEqual([DESKTOP_IMAGE, HARDWARE_IMAGE]);
    // The next start: tried again, once, and this time made.
    d.failing.clear();
    await imagesAtStart(hostOn(d, root), { home: at, release: "bbbbbbbbbbbb", log: () => {}, ...nowait });
    expect(d.builds.filter((b) => b === DESKTOP_IMAGE)).toHaveLength(2);
    expect(readImagesRecord(at)).toEqual({ refreshedFor: "bbbbbbbbbbbb", tried: { release: "bbbbbbbbbbbb", at: expect.any(Number), failed: [] } });
  });

  test("none is begun while a VM is being made: it waits for that", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE);
    let making = 3;
    const builtWhileMaking: number[] = [];
    const run = d.run;
    const host = new SandboxHost({
      node: "n",
      tokens: { mint: () => { throw new Error("no lease here"); }, revoke: () => false },
      ledger: () => {},
      maxCpus: 4,
      maxMemoryGb: 8,
      imageContext: root,
      runner: async (args) => {
        if (args[0] === "build") builtWhileMaking.push(making);
        return run(args);
      },
    });
    await host.refreshImages({ busy: () => making > 0, pause: async () => void making-- });
    expect(builtWhileMaking).toEqual([0]);
  });

  test("one that isn't built here is left to be built at its first need, and an old build a VM still runs on stays", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE);
    const old = d.images.get(DESKTOP_IMAGE)!;
    d.keepers.set("invincible-sbx-agent", old);
    d.change(root, DESKTOP_IMAGE);
    const done = await hostOn(d, root).refreshImages(nowait);
    expect(d.builds).not.toContain(HARDWARE_IMAGE);
    expect(done.map((r) => r.image)).toEqual([DEFAULT_IMAGE, DESKTOP_IMAGE]);
    expect(done[1]!.outcome).toBe("rebuilt");
    expect(d.removed).toEqual([]);
  });
});

describe("a node's own images, and a VM being made", () => {
  test("a VM the node is making holds the refresh back: its first build begins once that VM is made", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE);
    let hold = false;
    let release: () => void = () => {};
    const host = new SandboxHost({
      node: "n",
      tokens: { mint: () => { throw new Error("no lease here"); }, revoke: () => false },
      ledger: () => {},
      maxCpus: 4,
      maxMemoryGb: 8,
      imageContext: root,
      runner: async (args) => {
        if (!hold) return d.run(args);
        // (The VM's making, held at its first look at Docker until the refresh has waited for it.)
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
        return { code: 1, stdout: "", stderr: "this stand-in makes no VM" };
      },
    });
    hold = true;
    const made = host.create({ network: "isolated", isolation: "container", cpus: 1, memoryGb: 1, ttlMinutes: 5, persistent: false, run: "arm.team.0123456789.bench" }).catch(() => null);
    let waited = 0;
    await host.refreshImages({
      pause: async () => {
        waited++;
        release();
        await made;
      },
    });
    expect(waited).toBeGreaterThan(0);
    expect(d.builds).toEqual([DEFAULT_IMAGE]);
  });
});

describe("a node's own images, and a node that stops", () => {
  test("the start's wait before it builds never keeps a stopping node alive", async () => {
    const module = JSON.stringify(new URL("../src/images-refresh.ts", import.meta.url).pathname);
    const script = `import { imagesAtStart } from ${module};\nvoid imagesAtStart({ keepImages: async () => {}, refreshImages: async () => [] }, { home: ${JSON.stringify(home())}, release: "bbbbbbbbbbbb", log: () => {} });\n`;
    const t0 = performance.now();
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
    const ended = await Promise.race([child.exited, Bun.sleep(10_000).then(() => (child.kill(), "held up"))]);
    expect(ended).toBe(0);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("a node's own images on Docker, whose builds each get an id of their own", () => {
  // (BuildKit's provenance attestation: on Ultra's Docker 29, the same context built twice got two ids, the same layers
  // and config, 27 November 2026.)
  test("one whose context didn't change is unchanged: the same layers and config, nothing made from it counted made anew, and its old id, a duplicate, cleared", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE);
    const old = d.images.get(HARDWARE_IMAGE)!;
    d.attesting(true);
    const done = await hostOn(d, root).refreshImages(nowait);
    expect(done.map((r) => r.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(d.keepers.get(OWN_IMAGES[HARDWARE_IMAGE]!.keeper)).toBe(d.images.get(HARDWARE_IMAGE));
    expect(d.removed).toContain(old);
  });

  test("one whose context did change is made anew, and only it", async () => {
    const root = contexts();
    const d = docker();
    d.built(root, DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE);
    d.attesting(true);
    d.change(root, HARDWARE_IMAGE);
    const done = await hostOn(d, root).refreshImages(nowait);
    expect(done.map((r) => r.outcome)).toEqual(["unchanged", "unchanged", "rebuilt"]);
  });
});
