import { join } from "node:path";
import { DEFAULT_IMAGE, DESKTOP_IMAGE } from "../../packages/sandbox/src/spec.ts";
import type { Bench } from "./vm.ts";
import { ROOT } from "./vm.ts";
import { spawnDocker } from "./scratch.ts";

/*
 * The bench's images, built from this checkout's own Dockerfiles under the bench's names: the workshop as
 * `<prefix>/sandbox:1`, then the desktop as `<prefix>/desktop:1`, made from that one. The desktop's Dockerfile says
 * `FROM invincible/sandbox:1` (the node's name for the workshop): BuildKit's named context points that name at the
 * bench's workshop for this build alone, so the build never reads, and never tags, a live node's image. Docker's layer
 * cache makes a build with nothing changed a matter of seconds; the shared build cache is never pruned.
 */

export interface Built {
  /** Each image's size, bytes, by the node's name for it. */
  sizes: Record<string, number>;
  ms: number;
}

async function build(args: string[], what: string): Promise<void> {
  const ran = await spawnDocker(args, 60 * 60_000);
  if (ran.code !== 0) throw new Error(`the bench's ${what} image didn't build:\n${ran.stderr.trim().split("\n").slice(-12).join("\n")}`);
}

export async function buildImages(b: Bench, root = ROOT): Promise<Built> {
  const t0 = performance.now();
  const workshop = b.names.image(DEFAULT_IMAGE);
  const desktop = b.names.image(DESKTOP_IMAGE);
  b.log(`building ${workshop} and ${desktop} from this checkout`);
  await build(["build", "--quiet", "--pull", "-t", workshop, join(root, "sandbox")], "workshop");
  await build(["buildx", "build", "--quiet", "--load", "--build-context", `${DEFAULT_IMAGE}=docker-image://${workshop}`, "-t", desktop, join(root, "sandbox/desktop")], "desktop");
  const sizes: Record<string, number> = {};
  for (const [node, own] of [[DEFAULT_IMAGE, workshop], [DESKTOP_IMAGE, desktop]] as const) {
    const r = await spawnDocker(["image", "inspect", own, "--format", "{{.Size}}"], 30_000);
    sizes[node] = Number(r.stdout.trim());
  }
  return { sizes, ms: performance.now() - t0 };
}

/** The bench's images untagged (by their names, never by id: a layer another image shares stays). */
export async function removeImages(b: Bench): Promise<void> {
  await spawnDocker(["rmi", b.names.image(DESKTOP_IMAGE), b.names.image(DEFAULT_IMAGE)], 120_000);
}
