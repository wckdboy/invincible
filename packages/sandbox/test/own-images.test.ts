import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_IMAGE, DESKTOP_IMAGE, OWN_IMAGES, SandboxHost, type DockerRunner } from "../src/index.ts";

/*
 * Galahad's own images. One made from another of his (the desktop from the workshop's) names a base that is in no
 * registry, and `docker build --pull` looks for it there: "pull access denied for galahad/sandbox", as on ultra on
 * 21 November 2026. So the node couldn't make the desktop image again once it was pruned, nor build it when asked.
 * Such an image is built without --pull, after its base, which is made first when it's gone too.
 */

const context = new URL("../../../sandbox/", import.meta.url);
const baseOf = (dir: string): string => /^FROM (\S+)$/m.exec(readFileSync(new URL(dir === "." ? "Dockerfile" : `${dir}/Dockerfile`, context), "utf8"))![1]!;

/** A Linux host whose Docker has the images in `built`, and builds what it is asked to. */
function host(built: Set<string>) {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") return built.has(args[2]!) ? { code: 0, stdout: "sha256:test", stderr: "" } : { code: 1, stdout: "", stderr: `No such image: ${args[2]}` };
    if (args[0] === "build") built.add(args[args.indexOf("-t") + 1]!);
    return { code: 0, stdout: "", stderr: "" };
  };
  const sandboxes = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16, imageContext: "/opt/galahad/sandbox", runner, ledger: () => {},
    tokens: { mint: () => ({ token: "test-only-token", info: { hash: "test-only-hash" } }), revoke: () => true },
  });
  return { sandboxes, builds: () => calls.filter((args) => args[0] === "build") };
}

test("an image made from another of his names that one as its base, and only such an image names one", () => {
  for (const [image, own] of Object.entries(OWN_IMAGES)) {
    const from = baseOf(own.context);
    expect({ image, base: own.base ?? null }).toEqual({ image, base: from in OWN_IMAGES ? from : null });
  }
  expect(OWN_IMAGES[DESKTOP_IMAGE]!.base).toBe(DEFAULT_IMAGE);
});

test("an image from a registry's base is built with --pull; one from his own base, without", async () => {
  const h = host(new Set());
  await h.sandboxes.build("/opt/galahad/sandbox", undefined, DEFAULT_IMAGE);
  await h.sandboxes.build("/opt/galahad/sandbox/desktop", undefined, DESKTOP_IMAGE);
  expect(h.builds()).toEqual([
    ["build", "--pull", "-t", DEFAULT_IMAGE, "/opt/galahad/sandbox"],
    ["build", "-t", DESKTOP_IMAGE, "/opt/galahad/sandbox/desktop"],
  ]);
});

test("a sandbox on an image that's gone, whose base is gone too, has the base made first", async () => {
  const h = host(new Set());
  await h.sandboxes.create({ network: "isolated", cpus: 1, memoryGb: 1, ttlMinutes: 30, persistent: false, desktop: true });
  expect(h.builds()).toEqual([
    ["build", "--pull", "-t", DEFAULT_IMAGE, "/opt/galahad/sandbox"],
    ["build", "-t", DESKTOP_IMAGE, "/opt/galahad/sandbox/desktop"],
  ]);
});

test("whose base is there, only the image itself is made", async () => {
  const h = host(new Set([DEFAULT_IMAGE]));
  await h.sandboxes.create({ network: "isolated", cpus: 1, memoryGb: 1, ttlMinutes: 30, persistent: false, desktop: true });
  expect(h.builds()).toEqual([["build", "-t", DESKTOP_IMAGE, "/opt/galahad/sandbox/desktop"]]);
});
