import { statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { containerVolumeCreateArgs, containerVolumeDeleteArgs, containerVolumeListArgs, containerVolumeOwnArgs, parseContainerVolumes } from "./container.ts";
import { DEFAULT_IMAGE, LABEL, volumeName } from "./spec.ts";
import { MAX_WORKSPACE_GB, WorkspaceError, type Workspaces, type WorkspaceStats } from "./workspaces.ts";

/*
 * A Mac's workspaces: Apple's container makes each sandbox's /work a named volume, an ext4 image of its own whose
 * size is fixed as it is made (`volume create -s`; volumes.md), so a runaway job fills its own workspace and never
 * the Mac's disk, as the root helper gives on Linux, with no root needed. The budget is the same (workspaces.ts):
 * the disk is the one the user's container data lives on, and a volume's use is what its sparse image has taken.
 */

/** One `container` command (the host's own runner). */
export type ContainerRun = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const homeDisk = (): { totalBytes: number; freeBytes: number } => {
  const disk = statfsSync(homedir());
  return { totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize };
};

/** What a sparse image has taken of the disk (0 when it can't be read: the budget then counts all of it as to come). */
function taken(path: string | null): number {
  if (!path) return 0;
  try {
    return statSync(path).blocks * 512;
  } catch {
    return 0;
  }
}

export class ContainerVolumes implements Workspaces {
  constructor(
    private readonly run: ContainerRun,
    private readonly disk: () => { totalBytes: number; freeBytes: number } = homeDisk,
    /** The image whose one-off container hands a new volume to the sandbox's user (containerVolumeOwnArgs). */
    private readonly image: string = DEFAULT_IMAGE,
  ) {}

  /** A volume is container's own: there whenever container is. */
  async available(): Promise<boolean> {
    return true;
  }

  /** `retain`: a knight's, kept whatever becomes of its VM. A volume's labels are fixed as it is made, so it is said here. */
  async create(id: string, gib: number, opts: { retain?: boolean } = {}): Promise<string> {
    if (!/^[0-9a-f]{10}$/.test(id) || !Number.isInteger(gib) || gib < 1 || gib > MAX_WORKSPACE_GB) throw new WorkspaceError("bad workspace request");
    const made = await this.run(containerVolumeCreateArgs(id, gib, opts.retain === true), 60_000);
    if (made.code !== 0) throw new WorkspaceError(made.stderr.trim().slice(0, 300) || "container couldn't make the volume");
    // Its root is root's as it is made: handed to the sandbox's user, or the volume goes and the workspace fails.
    const owned = await this.run(containerVolumeOwnArgs(id, this.image), 120_000);
    if (owned.code !== 0) {
      await this.run(containerVolumeDeleteArgs(id), 60_000).catch(() => {});
      throw new WorkspaceError(`couldn't give the workspace to the sandbox's user: ${owned.stderr.trim().slice(0, 300) || `exit ${owned.code}`}`);
    }
    return volumeName(id);
  }

  /** Nothing to do: container gives a named volume to the VM that names it. */
  async mount(_id: string): Promise<void> {}

  /** Kept already, when it was made to be: a volume's labels can't be changed once it is made. */
  async retain(id: string): Promise<void> {
    const volume = await this.find(id);
    if (!volume) throw new WorkspaceError("no such workspace");
    if (volume.labels[`${LABEL}.retained`] !== "1") throw new WorkspaceError("this workspace wasn't made to be kept, and a volume's labels can't be changed once it is made");
  }

  /** Never a kept one (a knight's): only its owner's removal takes that (removeRetained). */
  async remove(id: string): Promise<void> {
    const volume = await this.find(id);
    if (!volume) return;
    if (volume.labels[`${LABEL}.retained`] === "1") throw new WorkspaceError("a knight's workspace is kept: only its owner's removal takes it");
    await this.delete(id);
  }

  async removeRetained(id: string): Promise<void> {
    if (await this.find(id)) await this.delete(id);
  }

  async stats(): Promise<WorkspaceStats> {
    const volumes = await this.volumes();
    return {
      ...this.disk(),
      images: volumes
        .filter((v) => v.labels[LABEL] === "1" && /^[0-9a-f]{10}$/.test(v.labels[`${LABEL}.id`] ?? ""))
        .map((v) => ({ id: v.labels[`${LABEL}.id`]!, sizeBytes: v.sizeBytes, usedBytes: Math.min(v.sizeBytes, taken(v.source)), mounted: false, createdAt: v.createdAt, retained: v.labels[`${LABEL}.retained`] === "1" })),
    };
  }

  private async volumes() {
    const listed = await this.run(containerVolumeListArgs(), 30_000);
    const volumes = listed.code === 0 ? parseContainerVolumes(listed.stdout) : null;
    if (!volumes) throw new WorkspaceError(`container couldn't list its volumes: ${listed.stderr.trim().slice(0, 200)}`);
    return volumes;
  }

  private async find(id: string) {
    if (!/^[0-9a-f]{10}$/.test(id)) throw new WorkspaceError("bad workspace id");
    return (await this.volumes()).find((v) => v.name === volumeName(id)) ?? null;
  }

  private async delete(id: string): Promise<void> {
    const removed = await this.run(containerVolumeDeleteArgs(id), 60_000);
    if (removed.code !== 0) throw new WorkspaceError(removed.stderr.trim().slice(0, 300) || "container couldn't remove the volume");
  }
}
