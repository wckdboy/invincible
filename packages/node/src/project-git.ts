import { type ProjectGitView, redact } from "@galahad/core";
import { LookError } from "./workspace-look.ts";

/*
 * The Build view's git (docs/BUILD.md): a project's checkout on Galahad's computer (core's `projectCheckout`), as git
 * has it, and what you do to it from there: switch to or start a branch, commit what changed, clone it the first time.
 * Yours alone (the routes are owner-only). As with looking into a workspace (workspace-look.ts), each is one of these
 * fixed scripts, run in his VM with Python as its own user, its only input the folder, a branch's name, a message or the
 * repository's address given as arguments (never in the script's text, and never through a shell); what comes back is
 * checked here, and anything git says is redacted before it leaves the node.
 */

/** `python3 -c GIT <checkout>`: its branch and branches, what isn't committed, how it stands with its upstream, its latest commits. */
export const GIT_SCRIPT = `import json,os,re,subprocess,sys
root=sys.argv[1]
if not os.path.isdir(root):
    print(json.dumps({"state":"missing"}));sys.exit(0)
if not os.path.exists(os.path.join(root,'.git')):
    print(json.dumps({"state":"not-a-repository"}));sys.exit(0)
def out(*a):
    r=subprocess.run(['git','-C',root,*a],capture_output=True,timeout=60)
    return r.stdout.decode(errors='replace').strip() if r.returncode==0 else ''
branch=out('symbolic-ref','--short','-q','HEAD') or None
head=out('rev-parse','--short','HEAD') or None
branches=[b for b in out('for-each-ref','--sort=-committerdate','--format=%(refname:short)','refs/heads').splitlines() if b][:200]
changed=len([l for l in out('status','--porcelain').splitlines() if l.strip()])
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

/** `python3 -c BRANCH <checkout> <name> <1|0>`: switch to the branch, or start it (1) from where it stands; git checks the name too. */
export const BRANCH_SCRIPT = `import json,subprocess,sys
root,name,create=sys.argv[1],sys.argv[2],sys.argv[3]=='1'
g=lambda *a: subprocess.run(['git','-C',root,*a],capture_output=True,timeout=60)
if g('check-ref-format','--branch',name).returncode!=0:
    print(json.dumps({"ok":False,"said":"git doesn't take that as a branch's name"}));sys.exit(0)
r=g('switch',*(['-c',name] if create else [name]))
print(json.dumps({"ok":r.returncode==0,"said":(r.stderr or r.stdout).decode(errors='replace')[-600:]}))`;

/** `python3 -c COMMIT <checkout> <message>`: everything changed or new, committed; as Galahad where the checkout has no author set. */
export const COMMIT_SCRIPT = `import json,subprocess,sys
root,message=sys.argv[1],sys.argv[2]
g=lambda *a: subprocess.run(['git','-C',root,*a],capture_output=True,timeout=120)
who=[] if g('config','user.email').stdout.strip() else ['-c','user.name=Galahad','-c','user.email=galahad@localhost']
g('add','-A')
r=g(*who,'commit','-m',message)
print(json.dumps({"ok":r.returncode==0,"said":(r.stdout if r.returncode==0 else (r.stdout+r.stderr)).decode(errors='replace')[-600:]}))`;

/** `python3 -c CLONE <checkout> <repository>`: its first clone, into a folder that isn't there yet (or is empty). */
export const CLONE_SCRIPT = `import json,os,subprocess,sys
dest,repo=sys.argv[1],sys.argv[2]
if os.path.isdir(dest) and os.listdir(dest):
    print(json.dumps({"ok":False,"said":"the checkout is there already"}));sys.exit(0)
os.makedirs(os.path.dirname(dest),exist_ok=True)
r=subprocess.run(['git','clone','--',repo,dest],capture_output=True,timeout=840)
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
