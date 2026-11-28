import { BUN_LOCK_PY, VM_BUN_CACHE } from "@invincible/core";

/*
 * The node's install cache for bun (the lead's ruling of 28 November 2026, own-task step 1's design): a folder of the
 * node's on its host, mounted read-only at VM_BUN_CACHE into each round of another node's task's gates' VM, which has no
 * network; no VM writes it. The node fills it as each round begins, before the round's VM is made, in a filler container
 * of its own (FILLER_SCRIPT) from the task's image: no capability, a read-only root, the cache its one writable mount, a
 * user of its own, and Docker's default bridge to reach the registry. It is given the tree's bun.lock and the package.json
 * files it names, and nothing else of the tree (no bunfig.toml, .npmrc or script), checks them (LOCK_CHECK_PY), and runs
 * `bun install --frozen-lockfile --ignore-scripts` on them: bun checks each tarball it downloads against the lockfile's
 * hash, runs no package's script, and fetches from the registry alone. A gate's `bun install --frozen-lockfile` then takes
 * from it, offline; one that needs a package that wasn't filled fails, and its gate says why.
 *
 * What the cache holds is the registry's: bun keys it by name and version and checks nothing on reading it, so the one
 * check is the filler's, as it downloads. A lockfile's hash that isn't the registry's tarball's is refused there, so no
 * lockfile can put content of its own under a name and version. Shared by every task's rounds on the node, and safe to.
 */

/** The filler's user, where the node runs as root: never root, never a VM's (1000) nor the gates' (65534). */
export const FILLER_UID = 65533;

/**
 * The filler's check of what it was given, before bun reads it: bun.lock, and each package.json it names as a workspace,
 * read with no key twice (BUN_LOCK_PY), and nothing in them but packages of the default registry at a version of their
 * own, and the workspaces' own. Anything else (another registry, a git, GitHub, tarball, file or link dependency, a
 * patch) is refused, and nothing is filled: bun would fetch it from wherever it names, and the filler reaches what the
 * host does. Exit 0: bun may read them. Python 3.9's, as the Macs that test it have.
 */
export const LOCK_CHECK_PY = String.raw`import json, os, re, sys
${BUN_LOCK_PY}
RANGE = re.compile(r"[0-9A-Za-z.^~<>=|*+ -]*")
VERSION = re.compile(r"[0-9A-Za-z.+-]+")
FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions")
def asked(spec):
    if not isinstance(spec, str):
        return False
    if spec.startswith("workspace:") or spec.startswith("catalog:"):
        return True
    if spec.startswith("npm:"):
        name, at, version = spec[4:].rpartition("@")
        return bool(name) and bool(at) and bool(RANGE.fullmatch(version))
    return bool(RANGE.fullmatch(spec))
def specs(field, value):
    if isinstance(value, dict):
        for name, spec in value.items():
            if isinstance(spec, dict):
                yield from specs(field, spec)
            else:
                yield name, spec
try:
    lock = strict(open("bun.lock", encoding="utf-8").read(), "its bun.lock")
    if not isinstance(lock, dict):
        raise Unread("its bun.lock is no lockfile")
    if lock.get("patchedDependencies"):
        raise Unread("its bun.lock patches packages, which a fill can't")
    for key, entry in (lock.get("packages") or {}).items():
        if not isinstance(entry, list) or not entry or not isinstance(entry[0], str):
            raise Unread("its bun.lock can't be read: " + key[:100])
        name, _, version = entry[0].rpartition("@")
        if version.startswith("workspace:"):
            continue
        if not name or not VERSION.fullmatch(version) or len(entry) < 2 or entry[1] != "":
            raise Unread("its bun.lock names " + entry[0][:200] + ", which isn't the default registry's")
    given = {"bun.lock"} | {os.path.join(path, "package.json") if path else "package.json" for path in lock.get("workspaces") or {}}
    # (Nothing else of the tree's, its configuration above all: bun obeys a bunfig.toml's or an .npmrc's registry.)
    for here, dirs, files in os.walk("."):
        for name in dirs + files:
            rel = os.path.normpath(os.path.join(here, name))
            if os.path.islink(rel) or (name in files and rel not in given):
                raise Unread("what it was given holds " + rel[:100] + ", which is no manifest of its")
    for path in lock.get("workspaces") or {}:
        if path.startswith("/") or ".." in path.split("/"):
            raise Unread("its bun.lock names a workspace out of its tree, " + path[:100])
        where = os.path.join(path, "package.json") if path else "package.json"
        if not os.path.isfile(where):
            raise Unread("its bun.lock names a workspace, " + (path or "its own") + ", whose package.json it wasn't given")
        manifest = strict(open(where, encoding="utf-8").read(), "its " + where)
        if not isinstance(manifest, dict) or manifest.get("patchedDependencies"):
            raise Unread("its " + where + " patches packages, which a fill can't")
        for field in FIELDS:
            for name, spec in specs(field, manifest.get(field)):
                if not asked(spec):
                    raise Unread("its " + where + " asks " + str(name)[:100] + " from " + str(spec)[:200] + ", which isn't the default registry")
except Unread as e:
    sys.exit(str(e) + ", so nothing is filled")
except OSError as e:
    sys.exit("its bun.lock can't be read (" + (e.strerror or str(e)) + "), so nothing is filled")
`;

/**
 * The filler's own command, in its container: the manifests (a gzipped tar on its input, unpacked here and never by the
 * node: what it inflates to is held to the container's memory and its /tmp) unpacked in its memory, checked, and bun's
 * install of them into the cache, with no script of any package run. It says how many packages the cache was given.
 */
export const FILLER_SCRIPT = `set -o pipefail
mkdir -p /tmp/m /tmp/home && cd /tmp/m || exit 1
tar -x -z --no-same-owner --no-same-permissions -f - || { echo "its manifests couldn't be unpacked" >&2; exit 1; }
/usr/bin/python3 -I -c "$LOCK_CHECK" || exit 1
bun install --frozen-lockfile --ignore-scripts --no-progress > /tmp/out 2>&1
code=$?
tail -n 5 /tmp/out >&2
exit $code`;

/** The filler's environment: its own, alone (the image's PATH, a HOME in its memory, the cache), and its check. */
export const fillerEnv = (path: string): Record<string, string> => ({ PATH: path, HOME: "/tmp/home", BUN_INSTALL_CACHE_DIR: "/cache", LOCK_CHECK: LOCK_CHECK_PY });

/**
 * The filler as Docker runs it, its manifests on its input: `name` its own, from `image` (whose PATH is `path`), as `user`,
 * the cache at `cache` its one writable mount. Docker's default bridge reaches the registry; nothing listens on it.
 */
export const fillerArgs = (opts: { name: string; image: string; cache: string; user: string; path: string }): string[] => [
  "run", "--rm", "--interactive", "--name", opts.name, "--network", "bridge", "--user", opts.user,
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
  "--mount", `type=bind,src=${opts.cache},dst=/cache`, "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
  "--entrypoint", "/usr/bin/env", opts.image, "-i", ...Object.entries(fillerEnv(opts.path)).map(([key, value]) => `${key}=${value}`),
  "/bin/bash", "--noprofile", "--norc", "-c", FILLER_SCRIPT,
];

/** A gate VM's mount of the cache, read-only, and its environment for bun. */
export const cacheMount = (cache: string): string[] => ["--mount", `type=bind,src=${cache},dst=${VM_BUN_CACHE},readonly`];
