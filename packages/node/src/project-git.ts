import { HELD_GIT } from "@invincible/agents";
import { type ProjectGitView, redact } from "@invincible/core";
import { LookError } from "./workspace-look.ts";

/*
 * The Build view's git (docs/BUILD.md): a project's checkout on the primary's computer (core's `projectCheckout`), as git
 * has it, and what you do to it from there: switch to or start a branch, commit what changed, clone it the first time.
 * Yours alone (the routes are owner-only). As with looking into a workspace (workspace-look.ts), each is one of these
 * fixed scripts, run in its VM with Python as its own user, its only input the folder, a branch's name, a message or the
 * repository's address given as arguments (never in the script's text, and never through a shell); what comes back is
 * checked here, and anything git says is redacted before it leaves the node.
 */

/**
 * How each script runs git: the node's own held git (agents' held-git.ts), the one a task's setup, checkpoints, evidence
 * and changes run, so that its repository's own configuration is held off here as there (the apps thread's finding, 27
 * November 2026; one held git everywhere, the fifth fabric review's R5-6). The checkout is the agent's to change, and so
 * is the VM's HOME, where a global configuration would be (in layout 1 its HOME is its /work): what you ask here runs
 * nothing of either. No system or global configuration, no fsmonitor, no hooks (husky's hooks path is held off, not
 * refused), no signing (so no gpg.program of its), no submodule's own git run, no askpass program, and no attributes
 * or excludes from outside the repository. A filter its configuration names is never run: status reads its files as
 * they are, and a switch or a commit is refused (`unwritten`), as either would write its files without it (an LFS
 * pointer, a file git-crypt encrypts). A repository whose configuration names another worktree is refused (`refused`).
 */
const HELD = `${HELD_GIT}def unwritten(root):
    f=filters(root)
    return "this checkout's configuration names a filter ("+", ".join(f)[:200]+"), and what you ask here runs none: a switch would check its files out, and a commit keep them, without it" if f else None
`;

/** `python3 -I -c GIT <checkout>`: its branch and branches, what isn't committed, how it stands with its upstream, its latest commits. */
export const GIT_SCRIPT = `${HELD}root=sys.argv[1]
if not os.path.isdir(root):
    print(json.dumps({"state":"missing"}));sys.exit(0)
if not os.path.exists(os.path.join(root,'.git')):
    print(json.dumps({"state":"not-a-repository"}));sys.exit(0)
bad=refused(root)
if bad:
    print(json.dumps({"state":"refused","said":bad}));sys.exit(0)
def out(*a):
    r=git(root,*a)
    return r.stdout.decode(errors='replace').strip() if r.returncode==0 else ''
branch=out('symbolic-ref','--short','-q','HEAD') or None
head=out('rev-parse','--short','HEAD') or None
branches=[b for b in out('for-each-ref','--sort=-committerdate','--format=%(refname:short)','refs/heads').splitlines() if b][:200]
# (A submodule's own changes aren't asked of it: that would run its git, with its configuration.)
changed=len([l for l in out('status','--porcelain','--ignore-submodules=dirty').splitlines() if l.strip()])
upstream=out('rev-parse','--abbrev-ref','--symbolic-full-name','@{u}') or None
ahead=behind=None
if upstream:
    c=out('rev-list','--left-right','--count',upstream+'...HEAD').split()
    if len(c)==2:
        behind,ahead=int(c[0]),int(c[1])
remote=re.sub(r'//[^/@]*@','//',out('remote','get-url','origin')) or None
log=[]
for l in out('log','-n','10','--format=%h%x1f%s%x1f%ct').splitlines():
    p=l.split('\\x1f')
    if len(p)==3:
        log.append({"sha":p[0],"subject":p[1][:200],"at":int(p[2])*1000})
print(json.dumps({"state":"ready","branch":branch,"head":head,"branches":branches,"changed":changed,"upstream":upstream,"ahead":ahead,"behind":behind,"remote":remote,"log":log}))`;

/** `python3 -I -c BRANCH <checkout> <name> <1|0>`: switch to the branch, or start it (1) from where it stands; git checks the name too. */
export const BRANCH_SCRIPT = `${HELD}root,name,create=sys.argv[1],sys.argv[2],sys.argv[3]=='1'
bad=refused(root) or unwritten(root)
if bad:
    print(json.dumps({"ok":False,"said":bad}));sys.exit(0)
g=lambda *a: git(root,*a)
if g('check-ref-format','--branch',name).returncode!=0:
    print(json.dumps({"ok":False,"said":"git doesn't take that as a branch's name"}));sys.exit(0)
r=g('switch',*(['-c',name] if create else [name]))
print(json.dumps({"ok":r.returncode==0,"said":(r.stderr or r.stdout).decode(errors='replace')[-600:]}))`;

/**
 * `python3 -I -c COMMIT <checkout> <message>`: everything changed or new, committed, by you: as the checkout's own git
 * configuration names you, else as its computer's global one does (read on its own, which runs nothing: the held git
 * reads no global configuration), else as Invincible <invincible@localhost>, and the answer says so. Never a name git
 * guesses from the host, which on Linux has none to guess and fails.
 */
export const COMMIT_SCRIPT = `${HELD}root,message=sys.argv[1],sys.argv[2]
bad=refused(root) or unwritten(root)
if bad:
    print(json.dumps({"ok":False,"said":bad}));sys.exit(0)
g=lambda *a: git(root,*a,timeout=120)
def yours(key):
    # The checkout's own configuration's, else its computer's global one (read alone: it runs nothing), as git takes it.
    for where,env in (([],GIT_ENV),(['--global','--includes'],{k:v for k,v in GIT_ENV.items() if k!='GIT_CONFIG_GLOBAL'})):
        r=subprocess.run(['git','-C',root,'config',*where,'--get',key],capture_output=True,timeout=30,env=env)
        v=r.stdout.decode(errors='replace').strip()
        if r.returncode==0 and v and len(v)<=200 and all(ord(c)>=32 for c in v):
            return v
    return None
name,email=yours('user.name'),yours('user.email')
told='' if name and email else "\\n(Committed as "+(name or 'Invincible')+" <"+(email or 'invincible@localhost')+">: neither the checkout's git configuration nor its computer's says who you are. git config --global user.name and user.email, in its terminal, do.)"
by={'GIT_AUTHOR_NAME':name or 'Invincible','GIT_AUTHOR_EMAIL':email or 'invincible@localhost'}
by.update({'GIT_COMMITTER_NAME':by['GIT_AUTHOR_NAME'],'GIT_COMMITTER_EMAIL':by['GIT_AUTHOR_EMAIL']})
g('add','-A')
r=git(root,'commit','-m',message,timeout=120,env=by)
if r.returncode==0:
    print(json.dumps({"ok":True,"said":r.stdout.decode(errors='replace')[-(600-len(told)):]+told}))
else:
    print(json.dumps({"ok":False,"said":(r.stdout+r.stderr).decode(errors='replace')[-600:]}))`;

/** `python3 -I -c CLONE <checkout> <repository>`: its first clone, into a folder that isn't there yet (or is empty). */
export const CLONE_SCRIPT = `${HELD}dest,repo=sys.argv[1],sys.argv[2]
if os.path.isdir(dest) and os.listdir(dest):
    print(json.dumps({"ok":False,"said":"the checkout is there already"}));sys.exit(0)
os.makedirs(os.path.dirname(dest),exist_ok=True)
# (Not a fetch with a lease: its transport is the repository's address, as git takes it.)
r=subprocess.run(['git',*RUN_OFF,'clone','--',repo,dest],capture_output=True,timeout=840,env=GIT_ENV)
print(json.dumps({"ok":r.returncode==0,"said":(r.stderr or r.stdout).decode(errors='replace')[-600:]}))`;

/** How long each may run in the VM, in seconds: a look and a commit are quick; a clone may be large. */
export const GIT_TIMEOUT = 60;
export const CLONE_TIMEOUT = 900;

const record = (stdout: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new LookError("the checkout couldn't be read", 502);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LookError("the checkout couldn't be read", 502);
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value ? value.slice(0, max) : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** GIT's answer, checked: a checkout's state, never more than it should say. */
export function gitView(stdout: string, checkout: string): ProjectGitView {
  const said = record(stdout);
  const none: ProjectGitView = { checkout, state: "missing", branch: null, head: null, branches: [], changed: 0, upstream: null, ahead: null, behind: null, remote: null, log: [] };
  if (said.state === "missing" || said.state === "not-a-repository") return { ...none, state: said.state };
  // One whose own configuration names what would run (a filter, a hooks path, ...): not read, and you're told why.
  if (said.state === "refused") throw new LookError(redact(text(said.said, 600) ?? "").trim() || "this repository isn't used here", 409);
  if (said.state !== "ready") throw new LookError("the checkout couldn't be read", 502);
  const log = Array.isArray(said.log) ? said.log : [];
  return {
    checkout,
    state: "ready",
    branch: text(said.branch, 200),
    head: text(said.head, 40),
    branches: (Array.isArray(said.branches) ? said.branches : []).filter((b): b is string => typeof b === "string" && b.length > 0).slice(0, 200).map((b) => b.slice(0, 200)),
    changed: count(said.changed) ?? 0,
    upstream: text(said.upstream, 200),
    ahead: count(said.ahead),
    behind: count(said.behind),
    remote: said.remote ? redact(text(said.remote, 500) ?? "") || null : null,
    log: log
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({ sha: text(c.sha, 40) ?? "", subject: redact(text(c.subject, 200) ?? ""), at: count(c.at) ?? 0 }))
      .filter((c) => c.sha)
      .slice(0, 10),
  };
}

/** What an action's script said: done, or why not in git's words (redacted), as a conflict to show you. */
export function actionDone(stdout: string): void {
  const said = record(stdout);
  if (said.ok === true) return;
  const why = redact(text(said.said, 600) ?? "").trim();
  throw new LookError(why || "git refused it", 409);
}
