/*
 * Where things are in an agent's VM (sandbox's layout.ts makes and moves a store to it). /work is its workspace, which a
 * VM that runs its own work may share (a run on a seat); its HOME is its own, never shared. In layout 2 that HOME is
 * /home/agent; in layout 1 (a Mac, where no VM shares a workspace, and an agent made before layout 2 until it is moved)
 * HOME is /work itself. What lives in HOME is named relative to it, so one name serves both.
 */
export const VM_WORK = "/work";
export const VM_HOME = "/home/agent";
/** The lease's file in a VM's HOME: its gateway token and where its gateway is (JSON, never a shell's configuration). */
export const LEASE_FILE = ".invincible-gateway.json";
/** Where the agent's notes (Engram) are kept, in its HOME: in layout 2 a tree of their own in its store, mounted there. */
export const NOTES_DIR = ".memory/engram";
