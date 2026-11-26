import { existsSync } from "node:fs";

/*
 * Disk limits for sandboxes. Each sandbox's /work is its own fixed-size ext4 image
 * (sparse: it takes only what's written), so a runaway knight fills its own
 * workspace, never the host's disk. Mounting needs root, which the node doesn't
 * have; a tiny root helper (sandbox/galahad-workspace, started by systemd per
 * connection) does exactly that, on a socket only the galahad user can open.
 *
 * And a budget: a sandbox is created only if every workspace could fill up to its
 * limit and the disk would still keep its reserve free.
 */

export const WORKSPACE_SOCKET = "/run/galahad-workspace.sock";
export const DEFAULT_DISK_GB = 20;
/** The most a workspace may be, as the helper itself holds (its MAX_GIB). */
export const MAX_WORKSPACE_GB = 4096;
const GIB = 2 ** 30;

export interface WorkspaceStats {
  totalBytes: number;
  freeBytes: number;
  images: { id: string; sizeBytes: number; usedBytes: number; mounted: boolean; createdAt: number; retained?: boolean }[];
}

/** What the sandbox host needs from the helper (a fake in tests). */
export interface Workspaces {
  available(): Promise<boolean>;
  /**
   * Creates and mounts an empty workspace; returns its host path (on a Mac, its volume's name). `retain`: it is a
   * persistent teammate's, kept from the start (the helper is told by `retain` after; a Mac's volume only as it is made).
   */
  create(id: string, gib: number, opts?: { retain?: boolean }): Promise<string>;
  /** Remount existing data after a host restart; never creates an empty image. */
  mount?(id: string): Promise<void>;
  /** Protect a persistent teammate's data even if its container is lost. */
  retain?(id: string): Promise<void>;
  /** Make a workspace bigger, where it is mounted (its sandbox running) or not; never smaller. */
  grow?(id: string, gib: number): Promise<void>;
  remove(id: string): Promise<void>;
  /** Only an owner-approved destruction may remove retained data. */
  removeRetained?(id: string): Promise<void>;
  stats(): Promise<WorkspaceStats>;
}

export class WorkspaceError extends Error {}

export function parseStats(text: string): WorkspaceStats {
  const [head, ...rows] = text.trim().split("\n");
  const top = head?.split(" ") ?? [];
  if (top[0] !== "ok" || top.length !== 3) throw new WorkspaceError(`unexpected stats: ${head?.slice(0, 100)}`);
  const images = rows
    .map((row) => row.trim().split(" "))
    .filter((cols) => (cols.length === 5 || cols.length === 6) && /^[0-9a-f]{10}$/.test(cols[0]!))
    .map(([id, size, used, mounted, created, retained]) => ({
      id: id!,
      sizeBytes: Number(size),
      usedBytes: Number(used),
      mounted: mounted === "1",
      createdAt: Number(created) * 1000,
      ...(retained === undefined ? {} : { retained: retained === "1" }),
    }));
  return { totalBytes: Number(top[1]), freeBytes: Number(top[2]), images };
}

export interface BudgetOptions {
  /** Share of the disk always kept free (default 10%). */
  reserveShare?: number;
  /** ...and at least this much (default 20 GiB). */
  minReserveBytes?: number;
}

/**
 * Why a new workspace of `gib` doesn't fit, or null if it does: every existing
 * workspace may still grow to its limit, and the reserve stays free regardless.
 */
export function budgetProblem(stats: WorkspaceStats, gib: number, opts: BudgetOptions = {}): string | null {
  const reserve = Math.max(stats.totalBytes * (opts.reserveShare ?? 0.1), opts.minReserveBytes ?? 20 * GIB);
  const promised = stats.images.reduce((sum, image) => sum + Math.max(0, image.sizeBytes - image.usedBytes), 0);
  const room = stats.freeBytes - promised - reserve;
  if (gib * GIB <= room) return null;
  const roomGb = Math.max(0, Math.floor(room / GIB));
  return `a ${gib} GB workspace doesn't fit: ${roomGb} GB is left for sandboxes once the others may fill theirs and ${Math.round(reserve / GIB)} GB stays free for the host`;
}

/** The helper, over its unix socket: one line out, the answer back. */
export class WorkspaceHelper implements Workspaces {
  constructor(
    private readonly socket = WORKSPACE_SOCKET,
    private readonly timeoutMs = 120_000,
  ) {}

  private ask(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = "";
      const decoder = new TextDecoder();
      const timer = setTimeout(() => reject(new WorkspaceError("the workspace helper didn't answer")), this.timeoutMs);
      Bun.connect({
        unix: this.socket,
        socket: {
          open: (s) => {
            s.write(`${line}\n`);
            s.flush();
          },
          data: (_s, chunk) => {
            out += decoder.decode(chunk, { stream: true });
          },
          close: () => {
            clearTimeout(timer);
            out += decoder.decode();
            if (out.startsWith("ok")) resolve(out);
            else reject(new WorkspaceError(out.replace(/^error\s*/, "").trim() || "the workspace helper refused"));
          },
          error: (_s, error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async available(): Promise<boolean> {
    if (!existsSync(this.socket)) return false;
    try {
      return (await this.ask("ping")).trim() === "ok";
    } catch {
      return false;
    }
  }

  async create(id: string, gib: number): Promise<string> {
    if (!/^[0-9a-f]{10}$/.test(id) || !Number.isInteger(gib) || gib < 1) throw new WorkspaceError("bad workspace request");
    const path = (await this.ask(`create ${id} ${gib}`)).trim().split(" ")[1];
    if (!path?.startsWith("/")) throw new WorkspaceError("the workspace helper gave no path");
    return path;
  }

  async remove(id: string): Promise<void> {
    if (!/^[0-9a-f]{10}$/.test(id)) throw new WorkspaceError("bad workspace id");
    await this.ask(`remove ${id}`);
  }

  async grow(id: string, gib: number): Promise<void> {
    if (!/^[0-9a-f]{10}$/.test(id) || !Number.isInteger(gib) || gib < 1 || gib > MAX_WORKSPACE_GB) throw new WorkspaceError("bad workspace request");
    await this.ask(`grow ${id} ${gib}`);
  }

  async mount(id: string): Promise<void> {
    if (!/^[0-9a-f]{10}$/.test(id)) throw new WorkspaceError("bad workspace id");
    await this.ask(`mount ${id}`);
  }

  async removeRetained(id: string): Promise<void> {
    if (!/^[0-9a-f]{10}$/.test(id)) throw new WorkspaceError("bad workspace id");
    await this.ask(`remove-owned ${id}`);
  }

  async retain(id: string): Promise<void> {
    if (!/^[0-9a-f]{10}$/.test(id)) throw new WorkspaceError("bad workspace id");
    await this.ask(`retain ${id}`);
  }

  async stats(): Promise<WorkspaceStats> {
    // Old helpers keep their original five-column protocol. They cannot create
    // retained teammate workspaces, but existing ephemeral sandboxes still work.
    let answer: string;
    try { answer = await this.ask("stats-v2"); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("unknown command")) throw error;
      answer = await this.ask("stats");
    }
    return parseStats(answer);
  }
}
