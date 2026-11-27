import { NOTES_DIR, VM_HOME, VM_WORK } from "@invincible/core";

/*
 * An agent's store in layout 2 (the owner's decisions of 27 November 2026, for the fabric's R3-1 and I-l): one store per
 * agent (its Docker volume, or its size-limited workspace image) holding three trees, each mounted on its own:
 *
 *   work/   at /work                        its workspace: its repository, its tasks, what it makes, and the runtime's own
 *   home/   at /home/agent                  its HOME: whatever its tools keep for themselves, its browser's profile, its lease
 *   notes/  at /home/agent/.memory/engram   its notes (Engram's, where ENGRAM_DATA_DIR points)
 *
 * A VM that shares an agent's workspace mounts work/ alone, or work/ and notes/ (a run on a seat of yours, which is the
 * agent's own work): nothing of the agent's HOME is in its reach. (Another node's task shares nothing of the store: its VM
 * has a /work of its own, with a clone of its own of the repository, handed-repo.ts.) A link left in a tree resolves in
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
 * store at /work. `list`: what it would do, one JSON line per top-level entry and one for its notes, by name, kind and
 * size (lstat sizes of what it holds, never a byte of any file read, and nothing followed); `move`: do it; `back`: undo
 * a move, as its manifest says; `make`: a store new in layout 2; `check`: whether its three trees are folders of its own,
 * as the host checks them before it mounts any (its exit says, and its stderr why not). Names a tool's own files
 * nowhere: what moves to HOME is every top-level dot-entry that isn't the workspace's own (core's WORKSPACE_OWN, given as
 * its third argument), and everything else is the workspace's.
 *
 * - **Nothing it finds is its own** (the fourth fabric review's R4-1 and R4-2). In layout 1 the store's root is the
 *   agent's /work, which whatever runs in its VM writes, so whatever is there from before a move is the agent's: a
 *   manifest, a staging folder, a link named as a tree. Each move has a word of its own, the node's (its sixth argument,
 *   kept in the node's own database, which no VM reaches), and every name it makes in the store carries it: the manifest
 *   it keeps, and the folders its trees are made in. So it never takes anything found there for its own, and every entry
 *   that was there goes where the rule says, links as links. Its folders are made with os.mkdir (never one already
 *   there), and a tree is named only from one of them, never through a link.
 * - The agent's notes (its arguments name their place in a HOME: NOTES_DIR) go to a tree of their own by one rename, and
 *   only where every part of that place is a folder: a link there is never followed, and moves with its HOME as it is.
 *   Where their tree is mounted in HOME, an empty folder is made as the VMs' user, so the VM's runtime makes none of root's.
 * - The lease (a file of the gateway's, re-minted at every prepare) is dropped, never moved.
 * - lost+found (an ext4 image's, root's) stays where it is: it is the image's, not the agent's.
 * - Each entry goes into a tree being made beside it, and the trees take their names last, so a store cut off in the
 *   middle is moved on, or back, from where it was: the manifest (at the store's root, which no VM mounts in layout 2)
 *   says what went where as it goes, and is read only by the move whose word its name carries.
 */
export const MOVE_PY = String.raw`import json, os, re, stat, sys
MODE, ROOT = sys.argv[1], sys.argv[2]
OWN = set(json.loads(sys.argv[3]))
LEASE = sys.argv[4]
NOTES_AT = sys.argv[5]
# This move's word, the node's: every name the move makes in the store carries it. None: a list, or a check.
NONCE = sys.argv[6] if len(sys.argv) > 6 else ""
WORK, HOME, NOTES = "work", "home", "notes"
TREES = (WORK, HOME, NOTES)
MODES = {WORK: 0o755, HOME: 0o700, NOTES: 0o700}
OURS = ".invincible-layout-" + NONCE
MANIFEST = os.path.join(ROOT, OURS + ".json")
STAGED = {tree: OURS + "-" + tree for tree in TREES}
KEEP = {"lost+found", *({os.path.basename(MANIFEST), os.path.basename(MANIFEST) + ".new", *STAGED.values()} if NONCE else set())}

def refuse(why):
    sys.stderr.write(why + "\n")
    sys.exit(3)

def staged(tree):
    return os.path.join(ROOT, STAGED[tree])

def real_folder(path):
    # A folder by lstat: never a link, whatever it points at.
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False

def own_folder(path, mode):
    # One of the move's own folders: made now, or (a move cut off and taken up again) the one it made before, a real
    # folder. Its name carries the move's word, so nothing from before the move is ever one.
    try:
        os.mkdir(path, mode)
    except FileExistsError:
        if not real_folder(path):
            refuse(os.path.basename(path) + " is there and isn't a folder the move made, so the move stops here")

def folders(base, rel):
    # Whether every part of rel below base is a folder, by lstat: never a link.
    here = base
    for part in rel.split("/"):
        here = os.path.join(here, part)
        if not real_folder(here):
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

def show(name):
    # A name as the list says it: its bytes as UTF-8, and each byte that isn't one as \xNN, so that what it prints is
    # always well-formed text (a name may hold any byte on Linux, and Python lists one that isn't UTF-8 as a lone
    # surrogate, which a reader that wants well-formed text, Swift's JSONDecoder, refuses whole: R4-5).
    return os.fsencode(name).decode("utf-8", "backslashreplace")

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
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(manifest, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, MANIFEST)

def load():
    # This move's manifest, or none yet: found by its own name alone, and holding its word.
    try:
        fd = os.open(MANIFEST, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as f:
        manifest = json.load(f)
    if not isinstance(manifest, dict) or manifest.get("nonce") != NONCE:
        refuse("the manifest under this move's name isn't this move's, so the move stops here")
    return manifest

def name_trees():
    # (Each tree takes its name once, from the move's own folder: a tree already named, and its staging gone, was named
    # before a cut. Whatever has a tree's name then must be a folder the move made: never a link, never chmod'ed through.)
    for tree in TREES:
        named = os.path.join(ROOT, tree)
        if real_folder(staged(tree)) and not os.path.lexists(named):
            os.rename(staged(tree), named)
    for tree in TREES:
        named = os.path.join(ROOT, tree)
        if not real_folder(named):
            refuse("the store's " + tree + " isn't a folder the move made, so it is neither named nor mounted")
        os.chmod(named, MODES[tree])

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
    if not NONCE:
        refuse("a move needs the node's word for it")
    manifest = load()
    if manifest is None:
        # A move begins. One whose manifest is here under another word (its node lost its own) may have left the store
        # half moved: that store is neither moved again nor touched, as a fresh move would take its trees for entries.
        other = sorted(name for name in os.listdir(ROOT) if re.fullmatch(r"\.invincible-layout-[0-9a-f]{32}\.json", name))
        if other:
            refuse("the store holds another move's manifest (" + other[0] + "), and the node has no word for it: it may be half moved, so it is neither moved again nor touched")
        manifest = {"layout": 2, "state": "moving", "moved": [], "nonce": NONCE}
        save(manifest)
    if manifest["state"] == "moved":
        return 0
    if manifest["state"] == "moving":
        for tree in (WORK, HOME):
            own_folder(staged(tree), 0o700)
        moved = {m["name"] for m in manifest["moved"]}
        # Its notes first, out of the HOME they were in, into their own tree: the folder they are in, by one rename.
        if NOTES_AT not in moved:
            notes = notes_here()
            if notes is not None and not os.path.lexists(staged(NOTES)):
                # (Its mode kept, as its tree's is the VMs' user's alone once named, and back gives it its own again.)
                mode = stat.S_IMODE(os.lstat(notes).st_mode)
                os.rename(notes, staged(NOTES))
                entry = {"name": NOTES_AT, "to": NOTES, "mode": mode}
            elif real_folder(staged(NOTES)) and os.listdir(staged(NOTES)):
                # (Renamed before a cut, and not written down.)
                entry = {"name": NOTES_AT, "to": NOTES}
            else:
                own_folder(staged(NOTES), 0o700)
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
        # From here on the names work, home and notes at the root are the trees', never an entry of the workspace's: every
        # entry that had one (a folder of the agent's, a link) is in the workspace's tree now, as it was.
        manifest["state"] = "naming"
        save(manifest)
    name_trees()
    mountpoint(manifest)
    manifest["state"] = "moved"
    save(manifest)
    return 0

def back():
    # Undoes a move just made. What a VM made in the trees since stays in their staging, never lost.
    if not NONCE:
        refuse("putting a move back needs the node's word for it")
    manifest = load()
    if manifest is None:
        return 0
    if manifest["state"] in ("naming", "moved"):
        for tree in TREES:
            named = os.path.join(ROOT, tree)
            if real_folder(named) and not os.path.lexists(staged(tree)):
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
            if folders(ROOT, os.path.dirname(NOTES_AT)) and real_folder(staged(NOTES)) and not os.path.lexists(place):
                os.rename(staged(NOTES), place)
                # Its own mode again, as it was before the move: through the folder itself, never a link in its place.
                if isinstance(entry.get("mode"), int):
                    fd = os.open(place, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        os.fchmod(fd, entry["mode"] & 0o7777)
                    finally:
                        os.close(fd)
            continue
        src, dst = os.path.join(staged(entry["to"]), entry["name"]), os.path.join(ROOT, entry["name"])
        if real_folder(staged(entry["to"])) and os.path.lexists(src) and not os.path.lexists(dst):
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
        if real_folder(staged(tree)) and not os.listdir(staged(tree)):
            os.rmdir(staged(tree))
    os.unlink(MANIFEST)
    return 0

def make():
    # A store made new, in layout 2 from the start: its three trees, its notes' mountpoint, and the manifest that says so.
    if not NONCE:
        refuse("a store is made with the node's word for it")
    manifest = load() or {"layout": 2, "state": "moved", "moved": [], "nonce": NONCE}
    for tree in TREES:
        own_folder(os.path.join(ROOT, tree), MODES[tree])
    name_trees()
    mountpoint(manifest)
    save(manifest)
    return 0

def check():
    # The trees as the host is about to mount them, each on its own: a folder at the store's root (by lstat, never a
    # link, and nothing on its way out of the store), the VMs' user's. Anything else, and nothing of the store is mounted.
    root = os.path.realpath(ROOT)
    wrong = []
    for tree in TREES:
        path = os.path.join(ROOT, tree)
        try:
            seen = os.lstat(path)
        except FileNotFoundError:
            wrong.append(tree + " is missing")
            continue
        if stat.S_ISLNK(seen.st_mode):
            wrong.append(tree + " is a link")
        elif not stat.S_ISDIR(seen.st_mode):
            wrong.append(tree + " isn't a folder")
        elif os.path.realpath(path) != os.path.join(root, tree):
            wrong.append(tree + " resolves out of the store")
        elif seen.st_uid != os.getuid():
            wrong.append(tree + " isn't the VMs' user's")
    if wrong:
        refuse("its trees aren't folders of the store's own (" + "; ".join(wrong) + ")")
    return 0

if MODE == "list":
    notes = notes_here()
    first = NOTES_AT.split("/")[0]
    for entry in plan():
        path = os.path.join(ROOT, entry["name"])
        print(json.dumps({"name": show(entry["name"]), "to": entry["to"], "kind": kind(path), "bytes": size(path, skip=notes)}))
        if notes is not None and entry["name"] == first:
            print(json.dumps({"name": NOTES_AT, "to": NOTES, "kind": "dir", "bytes": size(notes)}))
    sys.exit(0)
sys.exit(move() if MODE == "move" else back() if MODE == "back" else make() if MODE == "make" else check() if MODE == "check" else 2)
`;
