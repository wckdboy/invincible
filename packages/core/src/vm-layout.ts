/*
 * Where things are in an agent's VM (sandbox's layout.ts makes and moves a store to it). /work is its workspace, which a
 * VM that runs its own work may share (a run on a seat); its HOME is its own, never shared. In layout 2 that HOME is
 * /home/agent; in layout 1 (a Mac, where no VM shares a workspace, and an agent made before layout 2 until it is moved)
 * HOME is /work itself. What lives in HOME is named relative to it, so one name serves both.
 */
export const VM_WORK = "/work";
export const VM_HOME = "/home/agent";
/**
 * Where another node's task's gates run in its VM (the eighth fabric review's R8-3): a filesystem in memory of their own
 * user's alone (VM_GATES_USER, mode 0700), so nothing the task runs, as the VMs' user (1000), can list, write or move
 * what is there, nor signal or trace what runs there. Unlike /tmp and HOME, what is there may run (a tree's scripts).
 */
export const VM_GATES = "/gates";
/** The user another node's task's gates run as in its VM, uid:gid: nobody, never the VMs' user the task runs as. */
export const VM_GATES_USER = "65534:65534";
/**
 * Where a round of another node's task's gates finds its packages (bun's install cache, BUN_INSTALL_CACHE_DIR): the node's
 * own cache, filled by the node from the registry as the round begins and mounted read-only, since the round's VM has no
 * network. No VM writes it.
 */
export const VM_BUN_CACHE = "/cache/bun";
/** The lease's file in a VM's HOME: its gateway token and where its gateway is (JSON, never a shell's configuration). */
export const LEASE_FILE = ".invincible-gateway.json";
/** Where the agent's notes (Engram) are kept, in its HOME: in layout 2 a tree of their own in its store, mounted there. */
export const NOTES_DIR = ".memory/engram";
