/*
 * Where things are in an agent's VM (sandbox's layout.ts makes and moves a store to it). /work is its workspace, which a
 * VM that runs its own work may share (a run on a seat); its HOME is its own, never shared. In layout 2 that HOME is
 * /home/agent; in layout 1 (a Mac, where no VM shares a workspace, and an agent made before layout 2 until it is moved)
 * HOME is /work itself. What lives in HOME is named relative to it, so one name serves both.
 */
export const VM_WORK = "/work";
export const VM_HOME = "/home/agent";
/**
 * Where a round of another node's task's gates runs them, in the round's own VM: a filesystem in memory, sticky as /tmp
 * is, in which each gate's copy is a folder of its own user's alone (VM_GATE_UID_FIRST…, mode 0700), so no other gate
 * of the round can list, write or move what is there. Unlike /tmp and HOME, what is there may run (a tree's scripts).
 */
export const VM_GATES = "/gates";
/**
 * The users a round of another node's task's gates runs them as (the twelfth fabric re-review's R12-1): each gate, each
 * check of the node's on what they judge and each evidence of a task with no repository as a uid of these of its own,
 * never one a gate of the round had, so nothing one leaves can trace, signal or write the next one's processes or files.
 * Never the VMs' user (1000), nor any user of an image's own: the round's VM names them gate1… (gateUsers).
 */
export const VM_GATE_UID_FIRST = 61001;
export const VM_GATE_UIDS = 256;
/** Whether `uid` is one of the gates' users (VM_GATE_UID_FIRST…). */
export const isGateUid = (uid: number): boolean => Number.isInteger(uid) && uid >= VM_GATE_UID_FIRST && uid < VM_GATE_UID_FIRST + VM_GATE_UIDS;
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
