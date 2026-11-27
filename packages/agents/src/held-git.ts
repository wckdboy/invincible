/*
 * How the node's own git runs in an agent's VM, in the agent's repository (the fourth fabric review's R4-4): a task's
 * setup (REPO_TASK_START), its step checkpoints, its evidence and its changes (team-runtime.ts), and what is kept to ship
 * (ship.ts SHIPMENT_SCRIPT). The repository is the agent's to change, and in layout 2 another node's task shares it, its
 * .git among it. So a hook, an fsmonitor, a filter or a signing program written there would otherwise be run by the node
 * itself, as the agent, in its VM, with its lease and sign-ins beside it. What would run is held off instead, so that an
 * ordinary repository (husky's hooks path, Git LFS installed in it, its own HTTP settings) is used as it is (the fifth
 * review's R5-6):
 *
 * - no system or global configuration (the VM's HOME is the agent's to change too), and no attributes from outside the
 *   repository;
 * - no fsmonitor, no hooks (core.hooksPath at /dev/null, whatever the repository's says), no signing (so no gpg.program
 *   of its), no askpass program, no fetch of a submodule's (which would carry the lease to the submodule's own remote),
 *   and no credential helper, proxy or transport but HTTP and HTTPS;
 * - every filter its configuration names, its own or one it includes, held off (`held_env`): no clean, smudge or process
 *   command of its runs, and none is required, so a file is added, checked out and compared as it is. Git LFS's among
 *   them: its pointers are checked out as they are stored (GIT_LFS_SKIP_SMUDGE too), and a file it would clean is kept
 *   as it is. They are listed just before each git command, so one a writer adds between that list and the command
 *   isn't held off: only another node's task writes there, so only with the fabric on (SECURITY.md says so);
 * - no external diff or textconv: each diff says --no-ext-diff and --no-textconv;
 * - a repository whose configuration names another worktree (core.worktree) is refused (`refused`): git reads that as
 *   it finds the repository, before any -c, so nothing holds it off, and an ordinary repository never names one;
 * - and one whose configuration would take a fetch, and the lease it carries, elsewhere isn't fetched with the lease
 *   (`unfetched`): a URL rewrite, an HTTP proxy or address of its own (http.curloptResolve, which re-points even an
 *   address), a credential helper, or a remote named by the gateway's own address (git takes a fetch by address to
 *   that remote's URL and proxy). Nothing else of its HTTP or credential settings stops a fetch: none of the others
 *   can take it elsewhere.
 *
 * Python, run as `python3 -I -c`: this is its head, and the script that follows it calls `git(root, …)`.
 */
export const HELD_GIT = `import json,os,re,shutil,subprocess,sys
GIT_ENV={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':os.environ.get('HOME','/nonexistent'),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'GIT_ATTR_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','GIT_ASKPASS':'','GIT_LFS_SKIP_SMUDGE':'1','LC_ALL':'C'}
HELD_OFF=['-c','core.fsmonitor=false','-c','core.hooksPath='+os.devnull,'-c','core.excludesFile='+os.devnull,'-c','core.attributesFile='+os.devnull,'-c','core.askPass=','-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','log.showSignature=false','-c','submodule.recurse=false','-c','credential.helper=','-c','http.proxy=','-c','protocol.allow=never','-c','protocol.http.allow=always','-c','protocol.https.allow=always']
def keys(root):
    # Its configuration's keys as git reads them there: its own, its worktree's and what they include (none of the system's
    # or a global one). A subsection keeps its case, and may hold any character but a newline.
    r=subprocess.run(['git','-C',root,'config','--list','-z','--name-only'],capture_output=True,timeout=60,env=GIT_ENV)
    return [k for k in r.stdout.decode(errors='surrogateescape').split('\\0') if k]
def held_env(root,env=None):
    # GIT_ENV, and each filter its configuration names held off by the environment (a filter's name may hold '=', which
    # a -c would take for the end of the key).
    names=sorted({k[7:k.rindex('.')] for k in keys(root) if k[:7].lower()=='filter.' and k.count('.')>1})
    pairs=[('filter.'+n+'.'+v,'false' if v=='required' else '') for n in names for v in ('clean','smudge','process','required')]
    held={'GIT_CONFIG_COUNT':str(len(pairs))}
    for i,(k,v) in enumerate(pairs):
        held['GIT_CONFIG_KEY_%d'%i]=k
        held['GIT_CONFIG_VALUE_%d'%i]=v
    return {**GIT_ENV,**held,**(env or {})}
def git(root,*a,timeout=60,env=None):
    return subprocess.run(['git','-C',root,*HELD_OFF,*a],capture_output=True,timeout=timeout,env=held_env(root,env))
def named(root,pattern):
    # The first key of its configuration that matches, or None.
    for key in keys(root):
        if re.match(pattern,key.lower()):
            return key.lower()[:200]
    return None
def refused(root):
    key=named(root,r'core\\.worktree$')
    return "this repository isn't used here: its configuration names "+key+", which would have git work on files outside it, and nothing the node sets holds that off" if key else None
def unfetched(root):
    key=named(root,r'(url\\.|http\\.(.+\\.)?(proxy[a-z]*|curloptresolve)$|credential\\.(.+\\.)?helper$|remote\\.[^.]*://)')
    return "not fetched: its configuration names "+key+", which would take the fetch, and the lease it carries, elsewhere" if key else None
`;

/** A python3 -I -c script with HELD_GIT at its head, as one shell word with its arguments. */
export const heldGit = (body: string, ...args: string[]): string => ["python3", "-I", "-c", quote(`${HELD_GIT}${body}`), ...args.map(quote)].join(" ");

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
