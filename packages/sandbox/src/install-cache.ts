import { BUN_LOCK_PY, VM_BUN_CACHE } from "@invincible/core";

/*
 * The node's install cache for bun (the lead's ruling of 28 November 2026, own-task step 1's design): a folder of the
 * node's on its host, mounted read-only at VM_BUN_CACHE into each round of another node's task's gates' VM, which has no
 * network; no VM writes it. The node fills it as each round begins, before the round's VM is made, in a filler container
 * of its own (FILLER_SCRIPT) from the task's image: no capability, a read-only root, the cache its one writable mount, a
 * user of its own, and no network (the twelfth fabric re-review's R12-2). Its one way out is the node's proxy
 * (registry-proxy.ts), on a socket mounted into it, which opens a tunnel to the registry (registry.npmjs.org:443) and
 * refuses everything else.
 *
 * It is given the tree's bun.lock alone, nothing else of the tree's (no package.json, bunfig.toml, .npmrc or script). It
 * checks the lockfile (LOCK_CHECK_PY), and fills from the lockfile's packages alone: it writes a manifest of its own that
 * asks for each of the registry's packages the lockfile names, by name and version (`npm:<name>@<version>`). Bun
 * resolves that manifest from the registry to a lockfile of the fill's own, in a cache of the fill's own in its memory
 * (what it acts on while it resolves, a registry package's own git dependency among it, never reaches the node's: the
 * thirteenth fabric re-review's I-13b). That lockfile must name each package by the lockfile's own hash, and nothing
 * but the registry's (FILL_CHECK_PY). Then bun installs from it into the node's cache, checking each tarball against
 * its hash, and runs no package's script. So a tree's catalogs, overrides and workspaces never reach bun, nothing of its
 * own manifests does, and the node's cache gets what the registry gave alone.
 *
 * A gate's `bun install --frozen-lockfile` then takes from the cache, offline. One that needs a package that wasn't
 * filled fails, and its gate says why. Bun doesn't check a hash of what it takes from its cache: the cache holds what the
 * registry gave, each tarball checked against the registry's hash as it was fetched.
 */

/** The filler's user, where the node runs as root: never root, a VM's (1000), nobody (65534), nor a gate's (61001…). */
export const FILLER_UID = 65533;

/** Where the filler finds the node's proxy (registry-proxy.ts): a folder of the fill's own, mounted read-only. */
export const FILL_PROXY_DIR = "/proxy";
/** The proxy's socket in it. */
export const FILL_PROXY_SOCKET = "registry.sock";
/** Where bun in the filler sends what it fetches: the filler's forwarder (FORWARD_PY) to the node's proxy. */
const FORWARD_PORT = 3128;

/**
 * The filler's check of what it was given, before bun reads anything: its bun.lock alone, read with no key twice
 * (BUN_LOCK_PY), whose every package is the default registry's (`<name>@<version>`, an npm name and an exact version,
 * from the default registry, with a sha512 hash) or a workspace's own. Its workspaces' dependencies, its catalogs and its
 * overrides are checked as strictly, though bun never reads them here: a table of npm names, each asked of the default
 * registry by a version, a range or a tag, or an `npm:` alias of one (a workspace's own and a catalog's too, for a
 * workspace's dependency). Anything else, a patch among them, is refused, and nothing is filled.
 *
 * What passes is written out as the fill's own manifest, in `sys.argv[1]` (a folder it makes), asking for each of those
 * packages by name and version, and each one's hash in `sys.argv[2]`, for FILL_CHECK_PY. Nothing is written where it
 * names none of the registry's. Exit 0: bun may read the fill's own manifest. Python 3.9's, as the Macs that test it have.
 */
export const LOCK_CHECK_PY = String.raw`import json, os, re, stat, sys
${BUN_LOCK_PY}
NAME = re.compile(r"(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
RANGE = re.compile(r"[0-9A-Za-z.^~<>=|*+ -]*")
CATALOG = re.compile(r"[A-Za-z0-9._-]{1,100}")
SHA512 = re.compile(r"sha512-[A-Za-z0-9+/]{86}==")
FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
fill, hashes = sys.argv[1], sys.argv[2]
def named(name):
    return isinstance(name, str) and len(name) <= 214 and NAME.fullmatch(name) is not None
def registry(spec):
    if not isinstance(spec, str) or len(spec) > 256:
        return False
    if spec.startswith("npm:"):
        name, at, version = spec[4:].rpartition("@")
        return named(name) and at == "@" and RANGE.fullmatch(version) is not None
    return RANGE.fullmatch(spec) is not None
def own(spec):
    return isinstance(spec, str) and (spec.startswith("workspace:") or spec == "catalog:" or (spec.startswith("catalog:") and CATALOG.fullmatch(spec[8:]) is not None))
def table(value, what):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise Unread("its bun.lock's " + what + " is no table of packages")
    for name in value:
        if not named(name):
            raise Unread("its bun.lock's " + what + " names " + name[:100] + ", which is no package's name")
    return value
def asked(value, what, also=lambda spec: False):
    for name, spec in table(value, what).items():
        if not (registry(spec) or also(spec)):
            raise Unread("its bun.lock's " + what + " asks " + name[:100] + " from " + json.dumps(spec)[:200] + ", which isn't the default registry")
try:
    for name in sorted(os.listdir(".")):
        if name != "bun.lock":
            raise Unread("what it was given holds " + name[:100] + ", and a fill is given its bun.lock alone")
    if not stat.S_ISREG(os.lstat("bun.lock").st_mode):
        raise Unread("its bun.lock is no file")
    lock = strict(open("bun.lock", encoding="utf-8").read(), "its bun.lock")
    if not isinstance(lock, dict):
        raise Unread("its bun.lock is no lockfile")
    if lock.get("patchedDependencies"):
        raise Unread("its bun.lock patches packages, which a fill can't")
    workspaces = lock.get("workspaces")
    if workspaces is not None and not isinstance(workspaces, dict):
        raise Unread("its bun.lock's workspaces are no table")
    for path, workspace in (workspaces or {}).items():
        if path.startswith("/") or ".." in path.split("/"):
            raise Unread("its bun.lock names a workspace out of its tree, " + path[:100])
        if not isinstance(workspace, dict):
            raise Unread("its bun.lock's workspace " + (path or "of its own") + " is no table")
        for field in FIELDS:
            asked(workspace.get(field), "workspace " + (path or "of its own") + "'s " + field, own)
    asked(lock.get("catalog"), "catalog")
    catalogs = lock.get("catalogs")
    if catalogs is not None and not isinstance(catalogs, dict):
        raise Unread("its bun.lock's catalogs are no table")
    for name, catalog in (catalogs or {}).items():
        if CATALOG.fullmatch(name) is None:
            raise Unread("its bun.lock names a catalog " + name[:100] + ", which is no catalog's name")
        asked(catalog, "catalog " + name)
    asked(lock.get("overrides"), "overrides")
    packages = lock.get("packages")
    if packages is not None and not isinstance(packages, dict):
        raise Unread("its bun.lock's packages are no table")
    want = {}
    for key, entry in (packages or {}).items():
        if not isinstance(entry, list) or not entry or not isinstance(entry[0], str):
            raise Unread("its bun.lock can't be read: " + key[:100])
        name, at, version = entry[0].rpartition("@")
        if not named(name) or not at:
            raise Unread("its bun.lock names " + entry[0][:200] + ", which is no package's name")
        if version.startswith("workspace:"):
            continue
        if VERSION.fullmatch(version) is None or len(entry) != 4 or entry[1] != "" or not isinstance(entry[2], dict):
            raise Unread("its bun.lock names " + entry[0][:200] + ", which isn't the default registry's")
        if not isinstance(entry[3], str) or SHA512.fullmatch(entry[3]) is None:
            raise Unread("its bun.lock has no sha512 hash of " + entry[0][:200])
        if want.setdefault(entry[0], entry[3]) != entry[3]:
            raise Unread("its bun.lock has two hashes of " + entry[0][:200])
    if want:
        os.mkdir(fill, 0o700)
        with open(os.path.join(fill, "package.json"), "w") as f:
            json.dump({"name": "fill", "private": True, "optionalDependencies": {"p%d" % i: "npm:" + ident for i, ident in enumerate(sorted(want))}}, f)
        with open(hashes, "w") as f:
            json.dump(want, f)
except Unread as e:
    sys.exit(str(e) + ", so nothing is filled")
except OSError as e:
    sys.exit("its bun.lock can't be read (" + (e.strerror or str(e)) + "), so nothing is filled")
`;

/**
 * The filler's check of what bun would fetch, before it fetches a tarball: the lockfile bun resolved the fill's own
 * manifest to (`sys.argv[1]`'s bun.lock), from the registry alone, names each package the tree's bun.lock names
 * (`sys.argv[2]`, from LOCK_CHECK_PY) by the same hash, and every package it names is the default registry's. A hash
 * that isn't the registry's, or a package the registry hasn't, is refused, and nothing is filled. What the registry's
 * own resolution adds beside them is the registry's, and is said. Exit 0: bun may fetch what its lockfile names.
 */
export const FILL_CHECK_PY = String.raw`import json, sys
${BUN_LOCK_PY}
fill, hashes = sys.argv[1], sys.argv[2]
try:
    want = json.load(open(hashes))
    lock = strict(open(fill + "/bun.lock", encoding="utf-8").read(), "the fill's own bun.lock")
    seen = {}
    for entry in ((lock.get("packages") if isinstance(lock, dict) else None) or {}).values():
        if not isinstance(entry, list) or not entry or not isinstance(entry[0], str):
            raise Unread("the fill's own bun.lock can't be read")
        if len(entry) != 4 or entry[1] != "":
            raise Unread("bun would fetch " + entry[0][:200] + ", which isn't the default registry's")
        seen[entry[0]] = entry[3]
    for ident, hash in sorted(want.items()):
        if ident not in seen:
            raise Unread("the registry has no " + ident[:200] + ", which its bun.lock names")
        if seen[ident] != hash:
            raise Unread("its bun.lock's hash of " + ident[:200] + " isn't the registry's")
    more = sorted(set(seen) - set(want))
    if more:
        print("the registry's resolution adds %d package(s) its bun.lock doesn't name, the first %s" % (len(more), more[0][:200]), file=sys.stderr)
except Unread as e:
    sys.exit(str(e) + ", so nothing is filled")
except (OSError, ValueError) as e:
    sys.exit("the fill's own bun.lock can't be read (" + str(e)[:200] + "), so nothing is filled")
`;

/**
 * The filler's forwarder, its one way out: each connection to 127.0.0.1:`sys.argv[2]`, where bun sends what it fetches
 * (HTTPS_PROXY), passed to the node's proxy on its socket (`sys.argv[1]`), which decides. It writes `sys.argv[3]` once it
 * listens. It lives as long as its container.
 */
export const FORWARD_PY = String.raw`import socket, sys, threading
path, port, ready = sys.argv[1], int(sys.argv[2]), sys.argv[3]
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", port))
listener.listen(128)
open(ready, "w").close()
def pipe(source, to):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            to.sendall(data)
    except OSError:
        pass
    try:
        to.shutdown(socket.SHUT_WR)
    except OSError:
        pass
def serve(client):
    up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        up.connect(path)
    except OSError:
        client.close()
        up.close()
        return
    back = threading.Thread(target=pipe, args=(up, client), daemon=True)
    back.start()
    pipe(client, up)
    back.join()
    client.close()
    up.close()
while True:
    client, _ = listener.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
`;

/**
 * The filler's own command, in its container: the tree's bun.lock (a gzipped tar on its input, unpacked here and never
 * by the node: what it inflates to is held to the container's memory and its /tmp) checked, and the fill's own manifest
 * written from it (LOCK_CHECK_PY); its forwarder to the node's proxy started; that manifest resolved to a lockfile of
 * the fill's own, with a cache of its own in its memory (/tmp/resolve: I-13b), and checked (FILL_CHECK_PY); then bun's
 * install of that lockfile into the node's cache, each tarball checked against its hash, with no script of any package
 * run.
 */
export const FILLER_SCRIPT = `set -o pipefail
mkdir -p /tmp/m /tmp/home && cd /tmp/m || exit 1
tar -x -z --no-same-owner --no-same-permissions -f - || { echo "its manifests couldn't be unpacked" >&2; exit 1; }
/usr/bin/python3 -I -c "$LOCK_CHECK" /tmp/fill /tmp/hashes.json || exit 1
[ -d /tmp/fill ] || { echo "its bun.lock names none of the registry's packages: nothing to fill" >&2; exit 0; }
/usr/bin/python3 -I -c "$FORWARD" ${FILL_PROXY_DIR}/${FILL_PROXY_SOCKET} ${FORWARD_PORT} /tmp/forwarding &
for _ in {1..200}; do [ -e /tmp/forwarding ] && break; sleep 0.05; done
[ -e /tmp/forwarding ] || { echo "its way to the registry couldn't be opened, so nothing is filled" >&2; exit 1; }
cd /tmp/fill || exit 1
BUN_INSTALL_CACHE_DIR=/tmp/resolve bun install --lockfile-only --ignore-scripts --no-progress > /tmp/out 2>&1 || { tail -n 5 /tmp/out >&2; exit 1; }
/usr/bin/python3 -I -c "$FILL_CHECK" /tmp/fill /tmp/hashes.json || exit 1
bun install --frozen-lockfile --ignore-scripts --no-progress > /tmp/out 2>&1
code=$?
tail -n 5 /tmp/out >&2
exit $code`;

/** The filler's environment: its own, alone (the image's PATH, a HOME in its memory, the cache, its way out), and its scripts. */
export const fillerEnv = (path: string): Record<string, string> => {
  const way = `http://127.0.0.1:${FORWARD_PORT}`;
  return { PATH: path, HOME: "/tmp/home", BUN_INSTALL_CACHE_DIR: "/cache", HTTPS_PROXY: way, https_proxy: way, HTTP_PROXY: way, http_proxy: way, LOCK_CHECK: LOCK_CHECK_PY, FILL_CHECK: FILL_CHECK_PY, FORWARD: FORWARD_PY };
};

/**
 * The filler as Docker runs it, the tree's bun.lock on its input: `name` its own, from `image` (whose PATH is `path`), as
 * `user`, the cache at `cache` its one writable mount, with no network: `proxy`, the folder of the node's proxy's socket
 * (registry-proxy.ts), mounted read-only, is its one way out.
 */
export const fillerArgs = (opts: { name: string; image: string; cache: string; user: string; path: string; proxy: string }): string[] => [
  "run", "--rm", "--interactive", "--name", opts.name, "--network", "none", "--user", opts.user,
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
  "--mount", `type=bind,src=${opts.cache},dst=/cache`, "--mount", `type=bind,src=${opts.proxy},dst=${FILL_PROXY_DIR},readonly`,
  "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
  "--entrypoint", "/usr/bin/env", opts.image, "-i", ...Object.entries(fillerEnv(opts.path)).map(([key, value]) => `${key}=${value}`),
  "/bin/bash", "--noprofile", "--norc", "-c", FILLER_SCRIPT,
];

/** A gate VM's mount of the cache, read-only, and its environment for bun. */
export const cacheMount = (cache: string): string[] => ["--mount", `type=bind,src=${cache},dst=${VM_BUN_CACHE},readonly`];
