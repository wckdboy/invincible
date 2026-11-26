import { createHash } from "node:crypto";
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomId } from "@galahad/core";

/*
 * Where the archive's files live: content-addressed by SHA-256, stored once whatever
 * refers to them. A small interface so another backend slots in without changing a
 * caller: the local disk now; an S3-compatible one (Cloudflare R2) later, as a replica
 * of every blob verified by its hash (see docs/ARCHITECTURE.md, "The archive").
 *
 * A backend computes the hash itself on the way in (a caller can't name a blob for
 * bytes that aren't its own) and never evicts: the only removal is the owner's delete.
 */

export interface BlobInfo {
  sha256: string;
  size: number;
}

export interface BlobBackend {
  /** "local", later "r2". */
  readonly name: string;
  /** Where it keeps them, for the status page (a directory, a bucket). */
  readonly where: string;
  /** Store bytes; returns their SHA-256 (hex). Storing what's already there is a no-op. */
  put(bytes: Uint8Array): Promise<BlobInfo>;
  /** Store a file from disk, streamed and hashed on the way (large models, recordings). */
  putFile(path: string): Promise<BlobInfo>;
  get(sha256: string): Promise<Uint8Array | null>;
  has(sha256: string): Promise<boolean>;
  list(): AsyncIterable<BlobInfo>;
  /** Hash what's stored now (the integrity check); null when it's missing. */
  rehash(sha256: string): Promise<string | null>;
  /** Only ever for the owner's delete of the last entry that refers to it. */
  delete(sha256: string): Promise<void>;
}

export const isSha256 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

/**
 * The local disk: `<root>/<ab>/<cd>/<sha256>`, files 0600 and directories 0700 (the
 * node's user alone). Written to a temporary name and renamed, so a crash never leaves
 * a blob whose bytes don't match its name.
 */
export class LocalDiskBackend implements BlobBackend {
  readonly name = "local";

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSafe(root, 0o700);
  }

  get where(): string {
    return this.root;
  }

  private path(sha256: string): string {
    if (!isSha256(sha256)) throw new Error("not a SHA-256");
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  private dirFor(sha256: string): string {
    const dir = join(this.root, sha256.slice(0, 2), sha256.slice(2, 4));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSafe(join(this.root, sha256.slice(0, 2)), 0o700);
      chmodSafe(dir, 0o700);
    }
    return dir;
  }

  private settle(temp: string, sha256: string): void {
    const target = this.path(sha256);
    if (existsSync(target)) {
      rmSync(temp, { force: true });
      return;
    }
    this.dirFor(sha256);
    renameSync(temp, target);
    chmodSafe(target, 0o600);
  }

  async put(bytes: Uint8Array): Promise<BlobInfo> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (existsSync(this.path(sha256))) return { sha256, size: bytes.length };
    const temp = join(this.root, `.in-${randomId(9)}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } finally {
      closeSync(fd);
    }
    this.settle(temp, sha256);
    return { sha256, size: bytes.length };
  }

  async putFile(path: string): Promise<BlobInfo> {
    const temp = join(this.root, `.in-${randomId(9)}`);
    const fd = openSync(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        size += bytes.length;
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      }
    } catch (error) {
      closeSync(fd);
      rmSync(temp, { force: true });
      throw error;
    }
    closeSync(fd);
    const sha256 = hash.digest("hex");
    this.settle(temp, sha256);
    return { sha256, size };
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    const path = this.path(sha256);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  async has(sha256: string): Promise<boolean> {
    return existsSync(this.path(sha256));
  }

  async *list(): AsyncIterable<BlobInfo> {
    for (const a of readdirSafe(this.root)) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue;
      for (const b of readdirSafe(join(this.root, a))) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue;
        for (const name of readdirSafe(join(this.root, a, b))) {
          if (isSha256(name) && name.startsWith(a + b)) yield { sha256: name, size: statSync(join(this.root, a, b, name)).size };
        }
      }
    }
  }

  async rehash(sha256: string): Promise<string | null> {
    const path = this.path(sha256);
    if (!existsSync(path)) return null;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async delete(sha256: string): Promise<void> {
    rmSync(this.path(sha256), { force: true });
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** POSIX modes; Windows has none to set. */
function chmodSafe(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    /* not ours to change */
  }
}

/** The SHA-256 (hex) of bytes. */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Size of a file on disk, or 0. */
export const fileSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};
