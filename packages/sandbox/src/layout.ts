import { VM_HOME, VM_WORK } from "@invincible/core";

/*
 * An agent's store in layout 2 (the owner's decisions of 27 November 2026, for the fabric's R3-1 and I-l): one store per
 * agent (its Docker volume, or its size-limited workspace image) holding two trees, each mounted on its own:
 *
 *   work/   at /work          its workspace: its repository, its tasks, what it makes, and the runtime's own entries
 *   home/   at /home/agent    its HOME: whatever its tools keep for themselves, its browser's profile, its notes, its lease
 *
 * A VM that shares an agent's workspace (a run on a seat, another node's task) mounts work/ alone, so nothing of the
 * agent's HOME is in its reach: a link left in work/ resolves in that VM's own view, where work/'s parent is no part of the
 * store. The store's limit, where it has one (a workspace image's), bounds both trees.
 *
 * Layout 1, a store that is /work and HOME both, is a Mac's (no VM there shares a workspace, so a HOME apart would keep
 * nothing from anyone) and an agent's made before layout 2, until it is moved: at its VM's next prepare while nothing runs
 * in it, by renames inside the store's one filesystem (MOVE_PY), so nothing is copied, and back by the reverse renames.
 */

/** The trees of a store in layout 2. */
export const WORK_TREE = "work";
export const HOME_TREE = "home";

/**
 * What a VM in layout 2 is told: its HOME, and where what it installs for itself goes, so that its tools, its own installs
 * and its notes are in its HOME, never in the workspace another VM may share. Its PATH follows HOME too (layoutPath).
 */
export const LAYOUT_ENV: Readonly<Record<string, string>> = {
  HOME: VM_HOME,
  NPM_CONFIG_PREFIX: `${VM_HOME}/.local`,
  ENGRAM_DATA_DIR: `${VM_HOME}/.memory/engram`,
  XDG_CACHE_HOME: `${VM_HOME}/.cache`,
};

/**
 * A VM's PATH in layout 2: its image's, without any directory in the workspace (something another VM sharing it could
 * put there would run in this one), and its HOME's own bin last, as the image put its /work one.
 */
export function layoutPath(imagePath: string): string {
  const kept = imagePath.split(":").filter((dir) => dir.length > 0 && dir !== VM_WORK && !dir.startsWith(`${VM_WORK}/`));
  const own = `${VM_HOME}/.local/bin`;
  return [...kept.filter((dir) => dir !== own), own].join(":");
}

/**
 * The migration, run in a one-off container of the store's own (uid 1000, no network, no capability) with the whole
 * store at /store. `list`: what it would do, one JSON line per top-level entry, by name, kind and size (lstat sizes of
 * what it holds, never a byte of any file read, and nothing followed); `move`: do it; `back`: undo a move, as its
 * manifest says. Names a tool's own files nowhere: what moves to HOME is every top-level dot-entry that isn't the
 * workspace's own (core's WORKSPACE_OWN, given as its third argument), and everything else is the workspace's.
 *
 * - The lease (a file of the gateway's, re-minted at every prepare) is dropped, never moved.
 * - lost+found (an ext4 image's, root's) stays where it is: it is the image's, not the agent's.
 * - Each entry goes into a tree being made beside it, and the trees take their names last, so a store cut off in the
 *   middle is moved on, or back, from where it was: the manifest (at the store's root, which no VM mounts) says what went
 *   where as it goes.
 */
export const MOVE_PY = String.raw`import json, os, stat, sys
MODE, ROOT = sys.argv[1], sys.argv[2]
OWN = set(json.loads(sys.argv[3]))
LEASE = sys.argv[4]
WORK, HOME = "work", "home"
MANIFEST = os.path.join(ROOT, ".invincible-layout.json")
STAGED = {WORK: ".invincible-layout-work", HOME: ".invincible-layout-home"}
KEEP = {"lost+found", os.path.basename(MANIFEST), *STAGED.values()}

def size(path):
    # What it holds, by lstat alone: no file is opened, and no link followed.
    total, todo = 0, [path]
    while todo:
        here = todo.pop()
        try:
            seen = os.lstat(here)
        except OSError:
            continue
        total += seen.st_size
        if stat.S_ISDIR(seen.st_mode):
            try:
                todo.extend(os.path.join(here, name) for name in os.listdir(here))
            except OSError:
                pass
    return total

def kind(path):
    mode = os.lstat(path).st_mode
    return "link" if stat.S_ISLNK(mode) else "dir" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode) else "other"

def plan():
    out = []
    for name in sorted(os.listdir(ROOT)):
        if name in KEEP:
            continue
        if name == LEASE or name.startswith(LEASE.rsplit(".", 1)[0] + "-"):
            to = "drop"
        elif name.startswith(".") and name not in OWN:
            to = HOME
        else:
            to = WORK
        out.append({"name": name, "to": to})
    return out

def save(manifest):
    tmp = MANIFEST + ".new"
    with open(tmp, "w") as f:
        json.dump(manifest, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, MANIFEST)

def load():
    try:
        with open(MANIFEST) as f:
            return json.load(f)
    except FileNotFoundError:
        return None

def name_trees():
    # (Each tree takes its name once: a tree already named, and its staging gone, was named before a cut.)
    for tree in (WORK, HOME):
        staged, named = os.path.join(ROOT, STAGED[tree]), os.path.join(ROOT, tree)
        if os.path.isdir(staged) and not os.path.lexists(named):
            os.rename(staged, named)
    os.chmod(os.path.join(ROOT, WORK), 0o755)
    os.chmod(os.path.join(ROOT, HOME), 0o700)

def move():
    manifest = load() or {"layout": 2, "state": "moving", "moved": []}
    if manifest["state"] == "moved":
        return 0
    if manifest["state"] == "moving":
        for tree in (WORK, HOME):
            os.makedirs(os.path.join(ROOT, STAGED[tree]), mode=0o700, exist_ok=True)
        moved = {m["name"] for m in manifest["moved"]}
        for entry in plan():
            if entry["name"] in moved:
                continue
            src = os.path.join(ROOT, entry["name"])
            if entry["to"] == "drop":
                if os.path.islink(src) or not os.path.isdir(src):
                    os.unlink(src)
            else:
                os.rename(src, os.path.join(ROOT, STAGED[entry["to"]], entry["name"]))
            manifest["moved"].append(entry)
            save(manifest)
        # From here on the names work and home at the root are the trees', never an entry of the workspace's.
        manifest["state"] = "naming"
        save(manifest)
    name_trees()
    manifest["state"] = "moved"
    save(manifest)
    return 0

def back():
    # Undoes a move just made. What a VM made in the trees since stays in their staging, never lost.
    manifest = load()
    if manifest is None:
        return 0
    if manifest["state"] in ("naming", "moved"):
        for tree in (WORK, HOME):
            staged, named = os.path.join(ROOT, STAGED[tree]), os.path.join(ROOT, tree)
            if os.path.isdir(named) and not os.path.islink(named) and not os.path.lexists(staged):
                os.rename(named, staged)
    for entry in reversed(manifest["moved"]):
        if entry["to"] == "drop":
            continue
        src, dst = os.path.join(ROOT, STAGED[entry["to"]], entry["name"]), os.path.join(ROOT, entry["name"])
        if os.path.lexists(src) and not os.path.lexists(dst):
            os.rename(src, dst)
    for tree in (WORK, HOME):
        staged = os.path.join(ROOT, STAGED[tree])
        if os.path.isdir(staged) and not os.path.islink(staged) and not os.listdir(staged):
            os.rmdir(staged)
    os.unlink(MANIFEST)
    return 0

def make():
    # A store made new, in layout 2 from the start: its two trees, and the manifest that says so.
    os.makedirs(os.path.join(ROOT, WORK), mode=0o755, exist_ok=True)
    os.makedirs(os.path.join(ROOT, HOME), mode=0o700, exist_ok=True)
    name_trees()
    if load() is None:
        save({"layout": 2, "state": "moved", "moved": []})
    return 0

if MODE == "list":
    for entry in plan():
        path = os.path.join(ROOT, entry["name"])
        print(json.dumps({"name": entry["name"], "to": entry["to"], "kind": kind(path), "bytes": size(path)}))
    sys.exit(0)
sys.exit(move() if MODE == "move" else back() if MODE == "back" else make() if MODE == "make" else 2)
`;
