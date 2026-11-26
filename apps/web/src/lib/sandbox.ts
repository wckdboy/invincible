import type { Caps } from "../types.ts";
import { gb } from "./text.ts";

/*
 * Sandboxes as people read them: how a sandbox is isolated, what Automatic picks
 * on a host, and its disk. The node decides and enforces (packages/sandbox); this
 * says it plainly before you create one. Pure, so unit-tested.
 */

/** The two images: the workshop (everyday work) and the Lab (mathematics, physics, engineering). */
export const IMAGES = {
  workshop: "A shell with git, Python, Bun, build tools, ripgrep and jq.",
  lab: "SciPy and SymPy, FEniCSx with MPI, OpenFOAM, gmsh, build123d on OpenCascade, MuJoCo, ngspice, Octave, Maxima, Cantera, CoolProp, OpenSees, cvxpy and Z3. lab-check proves each tool against a known answer.",
} as const;

/** What a sandbox may reach through its gateway, as a chip says it: web search, or a provider's models. */
export function gatewayUse(name: string): { kind: "search" | "models"; label: string; title: string } {
  if (name === "search") return { kind: "search", label: "web search", title: "May search the web through Galahad's own search engine" };
  return { kind: "models", label: name, title: `May use ${name}'s models (your key stays in the vault)` };
}

/** A Lab sandbox: its image is galahad/lab, whatever the version. */
export const isLab = (image: string): boolean => /^galahad\/lab(:|$)/.test(image);

export type Isolation = "container" | "vm";
export type IsolationChoice = "auto" | Isolation;

export const ISOLATION: Record<Isolation, { label: string; explain: string }> = {
  container: { label: "container", explain: "A hardened container on the host's kernel." },
  vm: { label: "microVM", explain: "The same hardened container inside its own KVM microVM, with its own kernel: for code there's no reason to trust." },
};

/** What the host picks when you don't, as the node does: its own microVM for an online sandbox where the host has them, else a container. */
export const autoIsolation = (network: string, hostHasVm: boolean): Isolation => (network === "online" && hostHasVm ? "vm" : "container");

export interface IsolationPlan {
  /** What it will run as. */
  isolation: Isolation;
  /** What to send: nothing for Automatic, so the host decides. */
  send?: Isolation;
  /** Whether MicroVM can be chosen on this host, and why not. */
  vmAvailable: boolean;
  vmReason: string | null;
  /** One line under the choice. */
  note: string;
}

/** Whether a node makes sandboxes: Docker, KVM or a VM tool, or on a Mac Apple's container. */
export const makesSandboxes = (caps: Pick<Caps, "docker" | "vm" | "sandbox">): boolean => !!(caps.docker || caps.vm?.kvm || caps.vm?.tools.length || caps.sandbox?.engine === "container");

/**
 * The isolation for a sandbox about to be made on `host`. MicroVM on a host
 * without microVMs falls back to Automatic (the form disables it; the node would
 * refuse it with a 424). On a Mac (`mac`: Apple's container) every sandbox is a VM
 * of its own, whatever is chosen, and none is made with no network at all.
 */
export function isolationPlan(choice: IsolationChoice, network: string, host: { name: string; vm: boolean; mac?: boolean }): IsolationPlan {
  if (host.mac) {
    const note =
      network === "isolated"
        ? `${host.name} is a Mac, which makes no sandbox with no network at all: placed by Galahad, it goes to a Linux host with Docker; asked of ${host.name}, it is refused.`
        : `On ${host.name}, a Mac, every sandbox is a VM of its own (Apple's container).`;
    return { isolation: "vm", ...(choice === "auto" ? {} : { send: choice }), vmAvailable: true, vmReason: null, note };
  }
  const chosen: IsolationChoice = choice === "vm" && !host.vm ? "auto" : choice;
  const isolation = chosen === "auto" ? autoIsolation(network, host.vm) : chosen;
  const vmReason = host.vm ? null : `${host.name} can't run microVMs (it needs KVM and Kata).`;
  let note: string;
  if (chosen !== "auto") note = ISOLATION[chosen].explain;
  else if (network === "online")
    note = host.vm
      ? `Automatic: it's online, so it gets its own microVM on ${host.name}.`
      : `Automatic: a hardened container, since ${host.name} has no microVMs; online code shares its kernel.`;
  else note = `Automatic: a hardened container on ${host.name}'s kernel.${host.vm ? " Online sandboxes get their own microVM." : ""}`;
  return { isolation, ...(chosen === "auto" ? {} : { send: chosen }), vmAvailable: host.vm, vmReason, note };
}

/**
 * Giving a knight's VM more, said as it will be: while it runs; or, its host a Mac (Apple's container can't grow a
 * running VM), a pause in which what runs in it stops, and no bigger disk.
 */
export function growWords(pauses: boolean): { intro: string; done: string; disk: boolean } {
  return pauses
    ? {
        intro: "More threads or memory. Its Mac can't grow a running VM: it stops for a moment and starts again with more, its /work kept, and whatever is running in it stops. Its disk keeps the size it was made with.",
        done: "after a pause: what was running in it stopped.",
        disk: false,
      }
    : { intro: "More threads, memory or disk while it runs: nothing in it stops, and its work is kept.", done: "and nothing in it stopped.", disk: true };
}

/**
 * A sandbox's disk as people read it: "3.2 GB of 20 GB" with how full it is,
 * "20 GB limit" when the use isn't known, or "no disk limit" when its host can't
 * cap it (its workspace shares the machine's disk). Nearly full from 85%.
 */
export function diskUse(disk: { limitGb: number; usedGb: number | null } | null): { text: string; fraction: number | null; nearlyFull: boolean } {
  if (!disk) return { text: "no disk limit", fraction: null, nearlyFull: false };
  if (disk.usedGb === null) return { text: `${gb(disk.limitGb)} limit`, fraction: null, nearlyFull: false };
  const fraction = disk.limitGb > 0 ? Math.min(1, Math.max(0, disk.usedGb / disk.limitGb)) : 1;
  return { text: `${gb(disk.usedGb)} of ${gb(disk.limitGb)}`, fraction, nearlyFull: fraction >= 0.85 };
}
