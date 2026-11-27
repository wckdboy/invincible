import { NOTES_DIR, VM_HOME, VM_WORK } from "@invincible/core";

/*
 * An agent's store in layout 2 (the owner's decisions of 27 November 2026, for the fabric's R3-1 and I-l): one store per
 * agent (its Docker volume, or its size-limited workspace image) holding three trees, each mounted on its own:
 *
 *   work/   at /work                        its workspace: its repository, its tasks, what it makes, and the runtime's own
 *   home/   at /home/agent                  its HOME: whatever its tools keep for themselves, its browser's profile, its lease
 *   notes/  at /home/agent/.memory/engram   its notes (Engram's, where ENGRAM_DATA_DIR points)
 *
 * A VM that shares an agent's workspace mounts work/ alone (another node's task), or work/ and notes/ (a run on a seat of
 * yours, which is the agent's own work): nothing of the agent's HOME is in its reach. A link left in a tree resolves in
 * that VM's own view, where the tree's parent is no part of the store, and no tree is ever mounted from inside another,
 * which the agent writes: each is an entry at the store's root, which no VM mounts. The store's limit, where it has one (a
 * workspace image's), bounds all three.
 *
 * Layout 1, a store that is /work and HOME both, is a Mac's (no VM there shares a workspace, so a HOME apart would keep
 * nothing from anyone) and an agent's made before layout 2, until it is moved: at its VM's next prepare while nothing runs
 * in it, by renames inside the store's one filesystem (MOVE_PY), so nothing is copied, and back by the reverse renames.
 */

/** The trees of a store in layout 2. */
export const WORK_TREE = "work";
export const HOME_TREE = "home";
export const NOTES_TREE = "notes";

/** Where the notes' tree is mounted in a VM: their place in its HOME (core's NOTES_DIR), where ENGRAM_DATA_DIR points. */
export const VM_NOTES = `${VM_HOME}/${NOTES_DIR}`;

/**
 * What a VM in layout 2 is told: its HOME, and where what it installs for itself goes, so that its tools, its own installs
 * and its notes are in its HOME, never in the workspace another VM may share. Its PATH follows HOME too (layoutPath).
 */
export const LAYOUT_ENV: Readonly<Record<string, string>> = {
  HOME: VM_HOME,
  NPM_CONFIG_PREFIX: `${VM_HOME}/.local`,
  ENGRAM_DATA_DIR: VM_NOTES,
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
 * store at /store. `list`: what it would do, one JSON line per top-level entry and one for its notes, by name, kind and
 * size (lstat sizes of what it holds, never a byte of any file read, and nothing followed); `move`: do it; `back`: undo
 * a move, as its manifest says; `make`: a store new in layout 2. Names a tool's own files nowhere: what moves to HOME is
 * every top-level dot-entry that isn't the workspace's own (core's WORKSPACE_OWN, given as its third argument), and
 * everything else is the workspace's.
 *
 * - The agent's notes (its arguments name their place in a HOME: NOTES_DIR) go to a tree of their own by one rename, and
 *   only where every part of that place is a folder: a link there is never followed, and moves with its HOME as it is.
 *   Where their tree is mounted in HOME, an empty folder is made as the VMs' user, so the VM's runtime makes none of root's.
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
NOTES_AT = sys.argv[5]
WORK, HOME, NOTES = "work", "home", "notes"
TREES = (WORK, HOME, NOTES)
MODES = {WORK: 0o755, HOME: 0o700, NOTES: 0o700}
MANIFEST = os.path.join(ROOT, ".invincible-layout.json")
STAGED = {WORK: ".invincible-layout-work", HOME: ".invincible-layout-home", NOTES: ".invincible-layout-notes"}
KEEP = {"lost+found", os.path.basename(MANIFEST), *STAGED.values()}

def staged(tree):
    return os.path.join(ROOT, STAGED[tree])

def folders(base, rel):
    # Whether every part of rel below base is a folder, by lstat: never a link.
    here = base
    for part in rel.split("/"):
        here = os.path.join(here, part)
        try:
            if not stat.S_ISDIR(os.lstat(here).st_mode):
                return False
        except OSError:
            return False
    return True

def size(path, skip=None):
    # What it holds, by lstat alone: no file is opened, and no link followed.
    total, todo = 0, [path]
    while todo:
        here = todo.pop()
        if here == skip:
            continue
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

def notes_here():
    # The agent's notes at their place in a layout-1 HOME (its /work), when that place is folders all the way.
    return os.path.join(ROOT, NOTES_AT) if folders(ROOT, NOTES_AT) else None

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
    for tree in TREES:
        named = os.path.join(ROOT, tree)
        if os.path.isdir(staged(tree)) and not os.path.lexists(named):
            os.rename(staged(tree), named)
    for tree in TREES:
        os.chmod(os.path.join(ROOT, tree), MODES[tree])

def mountpoint(manifest):
    # Where the notes' tree is mounted in HOME, made as the VMs' user: only through folders, or where nothing is yet.
    # Each folder made is written down, so that back takes away what the move made and nothing else.
    here, rel = os.path.join(ROOT, HOME), []
    for part in NOTES_AT.split("/"):
        here, rel = os.path.join(here, part), rel + [part]
        try:
            if not stat.S_ISDIR(os.lstat(here).st_mode):
                return
        except FileNotFoundError:
            os.mkdir(here, 0o700)
            manifest.setdefault("made", []).append("/".join(rel))
            save(manifest)

def move():
    manifest = load() or {"layout": 2, "state": "moving", "moved": []}
    if manifest["state"] == "moved":
        return 0
    if manifest["state"] == "moving":
        for tree in (WORK, HOME):
            os.makedirs(staged(tree), mode=0o700, exist_ok=True)
        moved = {m["name"] for m in manifest["moved"]}
        # Its notes first, out of the HOME they were in, into their own tree: the folder they are in, by one rename.
        if NOTES_AT not in moved:
            notes = notes_here()
            if notes is not None and not os.path.lexists(staged(NOTES)):
                os.rename(notes, staged(NOTES))
                entry = {"name": NOTES_AT, "to": NOTES}
            elif os.path.isdir(staged(NOTES)) and not os.path.islink(staged(NOTES)) and os.listdir(staged(NOTES)):
                # (Renamed before a cut, and not written down.)
                entry = {"name": NOTES_AT, "to": NOTES}
            else:
                os.makedirs(staged(NOTES), mode=0o700, exist_ok=True)
                entry = {"name": NOTES_AT, "to": NOTES, "made": True}
            manifest["moved"].append(entry)
            save(manifest)
            moved.add(NOTES_AT)
        for entry in plan():
            if entry["name"] in moved:
                continue
            src = os.path.join(ROOT, entry["name"])
            if entry["to"] == "drop":
                if os.path.islink(src) or not os.path.isdir(src):
                    os.unlink(src)
            else:
                os.rename(src, os.path.join(staged(entry["to"]), entry["name"]))
            manifest["moved"].append(entry)
            save(manifest)
        # From here on the names work, home and notes at the root are the trees', never an entry of the workspace's.
        manifest["state"] = "naming"
        save(manifest)
    name_trees()
    mountpoint(manifest)
    manifest["state"] = "moved"
    save(manifest)
    return 0

def back():
    # Undoes a move just made. What a VM made in the trees since stays in their staging, never lost.
    manifest = load()
    if manifest is None:
        return 0
    if manifest["state"] in ("naming", "moved"):
        for tree in TREES:
            named = os.path.join(ROOT, tree)
            if os.path.isdir(named) and not os.path.islink(named) and not os.path.lexists(staged(tree)):
                os.rename(named, staged(tree))
    for entry in reversed(manifest["moved"]):
        if entry["to"] == "drop":
            continue
        if entry["to"] == NOTES:
            if entry.get("made"):
                continue
            # (Their place may hold the empty folder made as their mountpoint, or the VM's runtime's: that goes first.)
            place = os.path.join(ROOT, NOTES_AT)
            if folders(ROOT, NOTES_AT) and not os.listdir(place):
                os.rmdir(place)
            if folders(ROOT, os.path.dirname(NOTES_AT)) and os.path.isdir(staged(NOTES)) and not os.path.islink(staged(NOTES)) and not os.path.lexists(place):
                os.rename(staged(NOTES), place)
            continue
        src, dst = os.path.join(staged(entry["to"]), entry["name"]), os.path.join(ROOT, entry["name"])
        if os.path.lexists(src) and not os.path.lexists(dst):
            os.rename(src, dst)
    # (What the move made as the notes' mountpoint is no entry of the store's: taken away, deepest first, where it is
    # still an empty folder, at the root if its HOME's entry went back there, else in HOME's staging.)
    for rel in reversed(manifest.get("made", [])):
        for base in (ROOT, staged(HOME)):
            here = os.path.join(base, rel)
            if folders(base, rel) and not os.listdir(here):
                os.rmdir(here)
                break
    for tree in TREES:
        if os.path.isdir(staged(tree)) and not os.path.islink(staged(tree)) and not os.listdir(staged(tree)):
            os.rmdir(staged(tree))
    os.unlink(MANIFEST)
    return 0

def make():
    # A store made new, in layout 2 from the start: its three trees, its notes' mountpoint, and the manifest that says so.
    manifest = load() or {"layout": 2, "state": "moved", "moved": []}
    for tree in TREES:
        os.makedirs(os.path.join(ROOT, tree), mode=MODES[tree], exist_ok=True)
    name_trees()
    mountpoint(manifest)
    save(manifest)
    return 0

if MODE == "list":
    notes = notes_here()
    first = NOTES_AT.split("/")[0]
    for entry in plan():
        path = os.path.join(ROOT, entry["name"])
        print(json.dumps({"name": entry["name"], "to": entry["to"], "kind": kind(path), "bytes": size(path, skip=notes)}))
        if notes is not None and entry["name"] == first:
            print(json.dumps({"name": NOTES_AT, "to": NOTES, "kind": "dir", "bytes": size(notes)}))
    sys.exit(0)
sys.exit(move() if MODE == "move" else back() if MODE == "back" else make() if MODE == "make" else 2)
`;
