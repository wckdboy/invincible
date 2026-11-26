import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { type ArtifactView, type NodeIdentity, randomId } from "@galahad/core";
import type { MindStore } from "@galahad/mind";
import type { ExtractLimits, ExtractResult, LedgerEntryInput } from "@galahad/sandbox";

/*
 * Artifacts: a sandbox's work products, kept after the sandbox is gone. A quest
 * writes reports, plots, data and models to /work/out; the node copies that out
 * (through the hostile-archive extractor in @galahad/sandbox), keeps the files in
 * its home, and records in the mind what they are: paths, sizes, SHA-256s. Any
 * device sees the record; the files are served by the node that holds them.
 */

export const ARTIFACT_LIMITS: ExtractLimits = { maxBytes: 512 * 2 ** 20, maxFiles: 5000 };
/** All artifacts on one node together. */
export const ARTIFACT_BUDGET_BYTES = 20 * 2 ** 30;
/** The log entry lists files up to this many bytes of JSON (the event cap is 64 KB); the rest are in the manifest. */
const LISTED_BYTES = 40 * 1024;

export class ArtifactError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Collect = (sandbox: string, from: string, dest: string, limits: ExtractLimits) => Promise<ExtractResult | null>;

export interface ArtifactStoreOptions {
  store: MindStore;
  identity: NodeIdentity;
  /** Where this node keeps artifact files (its home/artifacts). */
  dir: string;
  ledger: (entry: LedgerEntryInput) => void;
  now?: () => number;
}

interface Manifest {
  id: string;
  files: { path: string; size: number; sha256: string }[];
  bytes: number;
}

/** Text we show inline, raster images we show inline; everything else downloads (never HTML or SVG inline). */
const TEXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".log", ".py", ".ts", ".js", ".rs", ".c", ".h", ".cpp", ".hpp", ".f90", ".m", ".jl", ".toml", ".yaml", ".yml", ".xml", ".ini", ".cfg", ".tex", ".sh", ".svg", ".html", ".dat", ".out", ".cir", ".geo", ".step", ".stp", ".obj"]);
const IMAGES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export function contentTypeOf(path: string): { type: string; inline: boolean } {
  const ext = extname(path).toLowerCase();
  if (IMAGES[ext]) return { type: IMAGES[ext]!, inline: true };
  // HTML and SVG are shown as their source: never rendered on the PWA's origin.
  if (TEXT.has(ext) || !ext) return { type: "text/plain; charset=utf-8", inline: true };
  if (ext === ".pdf") return { type: "application/pdf", inline: false };
  return { type: "application/octet-stream", inline: false };
}

/**
 * Where one fetched file of an artifact lands under `out`. The paths come from the mind's
 * record, which another node signed, so they're checked like anything from outside: a path
 * that climbs out, is absolute or names a drive is refused, and a fetch never writes
 * outside the directory you chose.
 */
export function artifactTarget(out: string, path: string): string {
  const refuse = () => new ArtifactError(400, `refusing ${JSON.stringify(path.slice(0, 200))}: not a path inside the artifact`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw refuse();
  const root = resolve(out);
  const target = resolve(root, ...parts);
  // Whatever this system reads as a separator or a drive, the result stays under the root.
  if (!target.startsWith(root + sep)) throw refuse();
  return target;
}

export class ArtifactStore {
  private readonly now: () => number;

  constructor(private readonly o: ArtifactStoreOptions) {
    this.now = o.now ?? Date.now;
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  }

  private filesDir(id: string): string {
    return join(this.o.dir, id, "files");
  }

  private manifest(id: string): Manifest | null {
    try {
      return JSON.parse(readFileSync(join(this.o.dir, id, "manifest.json"), "utf8")) as Manifest;
    } catch {
      return null;
    }
  }

  /** Every file of work this node holds (the mind's record lists at most 200), or null. */
  filesOf(id: string): { path: string; size: number; sha256: string }[] | null {
    return this.manifest(id)?.files ?? null;
  }

  /** Bytes this node already keeps. */
  usedBytes(): number {
    if (!existsSync(this.o.dir)) return 0;
    return readdirSync(this.o.dir).reduce((sum, id) => sum + (this.manifest(id)?.bytes ?? 0), 0);
  }

  /** Copy a sandbox's directory out and record it. Null when there was nothing to keep. */
  async save(collect: Collect, input: { sandbox: string; path?: string; label?: string; quest?: string }): Promise<ArtifactView | null> {
    const left = ARTIFACT_BUDGET_BYTES - this.usedBytes();
    if (left <= 0) throw new ArtifactError(507, `this node keeps ${Math.round(ARTIFACT_BUDGET_BYTES / 2 ** 30)} GB of artifacts already; remove some first`);
    const id = `art_${randomId(16)}`;
    const staging = join(this.o.dir, `${id}.part`);
    const files = join(staging, "files");
    mkdirSync(files, { recursive: true, mode: 0o700 });
    let result: ExtractResult | null;
    try {
      result = await collect(input.sandbox, input.path ?? "/work/out", files, { ...ARTIFACT_LIMITS, maxBytes: Math.min(ARTIFACT_LIMITS.maxBytes, left) });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw new ArtifactError(413, `nothing was kept: ${(error as Error).message}`);
    }
    if (!result || result.files.length === 0) {
      rmSync(staging, { recursive: true, force: true });
      return null;
    }
    const manifest: Manifest = { id, files: result.files, bytes: result.bytes };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest));
    await renameSettled(staging, join(this.o.dir, id));

    const listed: Manifest["files"] = [];
    let size = 0;
    for (const file of result.files) {
      size += JSON.stringify(file).length + 1;
      if (size > LISTED_BYTES || listed.length >= 200) break;
      listed.push(file);
    }
    const label = (input.label ?? input.path ?? "/work/out").slice(0, 200);
    this.o.store.emit(this.o.identity, "artifact.saved", {
      id,
      label,
      ...(input.quest ? { quest: input.quest.slice(0, 64) } : {}),
      sandbox: input.sandbox,
      bytes: result.bytes,
      count: result.files.length,
      files: listed,
    });
    this.o.ledger({
      class: "create",
      resource: "artifact",
      target: id,
      verdict: "allow",
      ...(input.quest ? { quest: input.quest } : {}),
      detail: `${result.files.length} file(s), ${result.bytes} bytes from sandbox ${input.sandbox}${result.skipped.length ? ` · refused ${result.skipped.length} (links, devices or unsafe paths)` : ""}`,
    });
    return this.get(id)!;
  }

  list(): ArtifactView[] {
    return this.o.store
      .lwwPrefix<{ id: string; label: string; quest?: string; sandbox?: string; bytes: number; count: number; files: Manifest["files"] }>("artifact:")
      .map((entry) => {
        const body = entry.value!;
        const local = entry.device === this.o.identity.id ? this.manifest(body.id) : null;
        return {
          id: body.id,
          label: body.label,
          quest: body.quest ?? null,
          sandbox: body.sandbox ?? null,
          node: entry.device,
          nodeName: this.o.store.device(entry.device)?.name ?? entry.device.slice(0, 12),
          bytes: body.bytes,
          count: body.count,
          files: (local?.files ?? body.files).slice(0, 200),
          savedAt: Number(entry.hlc.split(".")[0]),
          here: !!local,
        };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  get(id: string): ArtifactView | null {
    return this.list().find((a) => a.id === id) ?? null;
  }

  /** One file's bytes, if this node holds it and the manifest lists it (no other path is ever opened). */
  read(id: string, path: string): { bytes: Uint8Array<ArrayBuffer>; type: string; inline: boolean; name: string } {
    const full = this.locate(id, path);
    return { bytes: new Uint8Array(readFileSync(full)), ...contentTypeOf(path), name: path.split("/").at(-1)! };
  }

  /** Where one listed file is on this node's disk (the archive streams large ones in), with read's checks. */
  locate(id: string, path: string): string {
    const manifest = this.manifest(id);
    if (!manifest) throw new ArtifactError(this.get(id) ? 421 : 404, this.get(id) ? `its files are on ${this.get(id)!.nodeName}` : "no such artifact");
    const entry = manifest.files.find((f) => f.path === path);
    if (!entry) throw new ArtifactError(404, "no such file in that artifact");
    const root = resolve(this.filesDir(id));
    const full = resolve(root, ...entry.path.split("/"));
    if (!full.startsWith(root + sep)) throw new ArtifactError(400, "bad path");
    if (!statSync(full).isFile()) throw new ArtifactError(404, "no such file in that artifact");
    return full;
  }

  /** Delete the files, then record that they're gone. Only you ask for this (fleet:admin). */
  remove(id: string, by: string): void {
    const artifact = this.get(id);
    if (!artifact) throw new ArtifactError(404, "no such artifact");
    if (!artifact.here) throw new ArtifactError(421, `its files are on ${artifact.nodeName}`);
    rmSync(join(this.o.dir, id), { recursive: true, force: true });
    this.o.store.emit(this.o.identity, "artifact.removed", { id });
    this.o.ledger({ class: "delete", resource: "artifact", target: id, verdict: "approved", reason: "you asked for it", detail: `${artifact.label} · ${by}` });
  }
}

/**
 * Renames a directory that was only just written. On Windows that can be refused for a moment (EPERM, EBUSY,
 * EACCES) while something else still has a file in it open (a virus scanner reading what was just written): it's
 * asked again after a short wait, a few times; anywhere else, and after that, the error stands.
 */
export async function renameSettled(from: string, to: string, rename: (from: string, to: string) => void = renameSync, platform: string = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (platform !== "win32" || attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
