/*
 * How the node's own git runs in an agent's VM, in the agent's repository (the fourth fabric review's R4-4): a task's
 * setup (REPO_TASK_START), its step checkpoints, its evidence and its changes (team-runtime.ts), and what is kept to ship
 * (ship.ts SHIPMENT_SCRIPT). The repository is the agent's to change, and in layout 2 another node's task shares it, its
 * .git among it. So a hook, an fsmonitor, a filter or a signing program written there would otherwise be run by the node
 * itself, as the agent, in its VM, with its lease and sign-ins beside it. The same holds as the Build view's git does
 * (node's project-git.ts), with what a fetch that carries the agent's lease needs besides:
 *
 * - no system or global configuration (the VM's HOME is the agent's to change too), and no attributes from outside the
 *   repository;
 * - no fsmonitor, no hooks (core.hooksPath at /dev/null), no signing (so no gpg.program of its), no submodule's own git;
 * - no credential helper, no proxy, and no transport but HTTP and HTTPS;
 * - a repository whose own configuration names a filter, an include, another worktree or a hooks path is refused
 *   (`refused`), by its name: nothing of it is checked out, added or diffed;
 * - and one that names a URL rewrite, an HTTP setting, a credential helper, or another command to reach a remote with,
 *   isn't fetched with the lease (`unfetched`), by its name: the token would go where those say. (A fetch names the
 *   gateway's address itself, so no remote of its configuration is used.)
 *
 * Python, run as `python3 -I -c`: this is its head, and the script that follows it calls `git(root, …)`.
 */
export const HELD_GIT = `import json,os,re,shutil,subprocess,sys
GIT_ENV={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':os.environ.get('HOME','/nonexistent'),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'GIT_ATTR_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','LC_ALL':'C'}
HELD_OFF=['-c','core.fsmonitor=false','-c','core.hooksPath='+os.devnull,'-c','core.excludesFile='+os.devnull,'-c','core.attributesFile='+os.devnull,'-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','log.showSignature=false','-c','submodule.recurse=false','-c','credential.helper=','-c','http.proxy=','-c','protocol.allow=never','-c','protocol.http.allow=always','-c','protocol.https.allow=always']
def git(root,*a,timeout=60,env=None):
    return subprocess.run(['git','-C',root,*HELD_OFF,*a],capture_output=True,timeout=timeout,env={**GIT_ENV,**(env or {})})
def named(root,pattern):
    # Its own configuration, as written (no include followed): the first key that matches, or None.
    keys=subprocess.run(['git','-C',root,'config','--list','--no-includes','--name-only'],capture_output=True,timeout=60,env=GIT_ENV)
    for key in keys.stdout.decode(errors='replace').splitlines():
        if re.match(pattern,key.lower()):
            return key.lower()[:200]
    return None
def refused(root):
    key=named(root,r'(core\\.worktree$|core\\.hookspath$|include\\.|includeif\\.|filter\\.)')
    return "this repository isn't used here: its configuration names "+key+", and the node runs its own git with a repository's own configuration held off" if key else None
def unfetched(root):
    key=named(root,r'(url\\.|http\\.|credential\\.|core\\.sshcommand$|core\\.gitproxy$|core\\.askpass$)')
    return "not fetched: its configuration names "+key+", which would take the fetch, and the lease it carries, elsewhere" if key else None
`;

/** A python3 -I -c script with HELD_GIT at its head, as one shell word with its arguments. */
export const heldGit = (body: string, ...args: string[]): string => ["python3", "-I", "-c", quote(`${HELD_GIT}${body}`), ...args.map(quote)].join(" ");

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
