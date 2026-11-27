import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Refreshed, SandboxHost } from "./host.ts";

/*
 * A node's own images at its start: each kept in use against pruning (keepImages), and, at the first start of a new
 * release, made again from that release's contexts (SandboxHost.refreshImages): a VM is made from its image's tag, so
 * an image built under an older release's context would otherwise stay as it was for good (the node builds one only
 * when it's missing, and neither install path builds the ones a VM needed later). In the background, after the start's
 * own work, and once a start: a release whose refresh didn't make every image is tried again at the next start, never
 * in a loop. What it did is kept in the node's home (sandbox-images.json) for its doctor, and said in its log.
 */

export interface ImagesAtStart {
  /** The node's home, where what it did with its images for a release is kept (sandbox-images.json), for its doctor. */
  home: string;
  /** The release the node runs (its REVISION). */
  release: string;
  log: (line: string) => void;
  /** How long after the start it waits before it builds anything: the start's own work first. 60 s. */
  delayMs?: number;
  pause?: (ms: number) => Promise<unknown>;
}

/** What a node did with its own images for a release, kept in its home (sandbox-images.json), for its doctor. */
export interface ImagesRecord {
  /** The release whose refresh last made every one of them, or null. */
  refreshedFor: string | null;
  /** The last start's try: its release, when, and what of it failed. */
  tried: { release: string; at: number; failed: { image: string; why: string }[] } | null;
}

const RECORD = "sandbox-images.json";
const Record = z.object({
  refreshedFor: z.string().nullable(),
  tried: z.object({ release: z.string(), at: z.number(), failed: z.array(z.object({ image: z.string(), why: z.string() })) }).nullable(),
});

/** What the node did for its releases, as its home keeps it: nothing, where it kept nothing (or nothing it can read). */
export function readImagesRecord(home: string): ImagesRecord {
  try {
    return Record.parse(JSON.parse(readFileSync(join(home, RECORD), "utf8")));
  } catch {
    return { refreshedFor: null, tried: null };
  }
}

function keep(home: string, record: ImagesRecord): void {
  const path = join(home, RECORD);
  writeFileSync(`${path}.new`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

/** A wait that never keeps a stopping node alive. */
export const idle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

const said = (r: Refreshed): string | null =>
  r.outcome === "rebuilt" ? "made anew for this release" : r.outcome === "held" ? `its last build kept: ${r.why}` : r.outcome === "failed" ? `not made anew, its last build kept: ${r.why}` : null;

/**
 * The node's own images at its start: kept in use, then, for a release not refreshed yet, made again (after `delayMs`,
 * in the background of the start that called it). Returns what the refresh did, or null where there was nothing to do.
 */
export async function imagesAtStart(host: Pick<SandboxHost, "keepImages" | "refreshImages">, opts: ImagesAtStart): Promise<Refreshed[] | null> {
  await host.keepImages();
  const record = readImagesRecord(opts.home);
  if (record.refreshedFor === opts.release) return null;
  await (opts.pause ?? idle)(opts.delayMs ?? 60_000);
  let done: Refreshed[];
  try {
    done = await host.refreshImages(opts.pause ? { pause: opts.pause } : {});
  } catch (error) {
    done = [{ image: "the node's own images", outcome: "failed", why: (error as Error).message }];
  }
  for (const r of done) {
    const line = said(r);
    if (line) opts.log(`sandbox image ${r.image}: ${line}`);
  }
  const failed = done.filter((r) => r.outcome === "failed" || r.outcome === "held").map((r) => ({ image: r.image, why: r.why ?? "" }));
  keep(opts.home, { refreshedFor: failed.length ? record.refreshedFor : opts.release, tried: { release: opts.release, at: Date.now(), failed } });
  return done;
}
