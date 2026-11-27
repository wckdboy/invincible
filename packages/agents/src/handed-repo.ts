import { heldGit } from "./held-git.ts";

/*
 * Another node's task's repository, a clone of its own (the fifth fabric review's R5-3, by the reviewer's first option):
 * its VM holds nothing of its agent's store, so nothing it writes there is read by the agent's side but its changes.
 *
 * - Its agent's side gives it the task's worktree as it stands, as a commit on the worktree's HEAD (its changes so far,
 *   for a task taken up again), with that commit's history, as a bundle (`handedGive`, in the agent's VM).
 * - Its own VM makes its clone of that bundle at the same place, its HEAD where the work began and its changes so far in
 *   its files, as the agent's (`handedTake`).
 * - After each step it keeps, and as it ends, what changed in its clone since then comes back as one patch
 *   (`handedSend`, in its own VM), which its agent's side keeps as a file (`handedReceive`), held to a limit, and then
 *   applies to the task's worktree with the node's held git (`handedApply`): the worktree set back to where the work
 *   began, with nothing an earlier run left in it, then git apply, which takes nothing outside the worktree, into a
 *   .git, or through a link; what the patch's binary parts inflate to is held to the limit too.
 * - It is applied only once the node has seen all of it come: its sender done, the pipe not cut, and as many bytes kept
 *   as were carried. A side ended by its deadline, or a pipe cut at its cap, ends what the other reads as if the patch
 *   ended there, so a patch cut short at a file's end would otherwise be applied as a smaller one. One that didn't all
 *   come is dropped (`handedDrop`).
 *
 * Each pair is joined through the node (HandedVm.receive and send): one side's stdout is the other's input, never kept.
 * Every git of these is the node's held git (held-git.ts), in the task's VM as well as in its agent's.
 */

/** Its agent's side: the task's worktree at `root` as it stands, as a bundle on stdout. Its scratch files go in `keep`. */
const GIVE_SCRIPT = `root, task, keep = sys.argv[1], sys.argv[2], sys.argv[3]
bad = refused(root)
if bad: sys.exit(bad)
os.makedirs(keep, exist_ok=True)
index = os.path.join(keep, task+'.give-index')
def gone(path):
    try:
        os.remove(path)
    except OSError:
        pass
gone(index)
held = {'GIT_INDEX_FILE': index}
head = git(root,'rev-parse','HEAD').stdout.decode().strip()
if not head or git(root,'read-tree',head,env=held).returncode or git(root,'add','-A','.',env=held,timeout=600).returncode:
    gone(index)
    sys.exit('could not read the workspace')
tree = git(root,'write-tree',env=held).stdout.decode().strip()
gone(index)
if not tree: sys.exit('could not read the workspace')
# (By a name of its own, as a checkpoint is: never one git guesses.)
by = {'GIT_AUTHOR_NAME':'Your agent','GIT_AUTHOR_EMAIL':'agent@invincible.invalid','GIT_COMMITTER_NAME':'Your agent','GIT_COMMITTER_EMAIL':'agent@invincible.invalid'}
same = tree == git(root,'rev-parse',head+'^{tree}').stdout.decode().strip()
state = head if same else git(root,'commit-tree',tree,'-p',head,'-m','its workspace as it was given',env=by).stdout.decode().strip()
ref = 'refs/invincible/give/'+task
if not state or git(root,'update-ref',ref,state).returncode: sys.exit('could not give the workspace')
sys.stdout.flush()
try:
    r = subprocess.run(['git','-C',root,*HELD_OFF,'bundle','create','-',ref],stdout=sys.stdout.buffer,stderr=subprocess.PIPE,timeout=900,env=held_env(root))
finally:
    git(root,'update-ref','-d',ref)
if r.returncode: sys.exit('could not give the workspace: '+r.stderr.decode(errors='replace')[-300:])`;

/** Its own VM: its clone at `root` of the bundle on stdin, HEAD at `base`, the state given in its files; its commits by `name`. */
const TAKE_SCRIPT = `root, base, name, email, keep = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
os.makedirs(keep, exist_ok=True)
bundle = os.path.join(keep, 'given.bundle')
with open(bundle,'wb') as f:
    shutil.copyfileobj(sys.stdin.buffer, f, 1<<20)
os.makedirs(os.path.dirname(root) or '.', exist_ok=True)
if subprocess.run(['git','init','-q',root],capture_output=True,timeout=60,env=GIT_ENV).returncode: sys.exit('could not make its clone')
heads = git(root,'bundle','list-heads',bundle).stdout.decode().split()
if len(heads) < 2 or not re.fullmatch('[0-9a-f]{40}', heads[0]): sys.exit('it was given no workspace')
state = heads[0]
said = lambda r: (r.stderr or r.stdout).decode(errors='replace')[-300:]
# (The bundle it was given is a file here: fetched by the file transport, which the held git allows nothing else.)
for step in (('-c','protocol.file.allow=always','fetch','-q',bundle,heads[1]),('checkout','-q','--detach',state)) + ((('reset','-q','--mixed',base),) if state != base else ()):
    r = git(root,*step,timeout=900)
    if r.returncode: sys.exit('could not make its clone: '+said(r))
git(root,'config','user.name',name)
git(root,'config','user.email',email)
os.remove(bundle)
print(state)`;

/** Its own VM: its changes at `root` since `base`, everything git doesn't ignore, as one patch on stdout. */
const SEND_SCRIPT = `root, base, keep = sys.argv[1], sys.argv[2], sys.argv[3]
bad = refused(root)
if bad: sys.exit(bad)
os.makedirs(keep, exist_ok=True)
index = os.path.join(keep, 'send-index')
def gone():
    try:
        os.remove(index)
    except OSError:
        pass
gone()
held = {'GIT_INDEX_FILE': index}
if git(root,'read-tree',base,env=held).returncode or git(root,'add','-A','.',env=held,timeout=600).returncode:
    gone()
    sys.exit('could not read its workspace')
sys.stdout.flush()
r = subprocess.run(['git','-C',root,*HELD_OFF,'diff','--cached','--binary','--full-index','--no-renames','--no-ext-diff','--no-textconv',base],stdout=sys.stdout.buffer,stderr=subprocess.PIPE,timeout=600,env=held_env(root,held))
gone()
if r.returncode: sys.exit('could not read its changes: '+r.stderr.decode(errors='replace')[-300:])`;

/** Its agent's side: the patch on stdin kept as the task's file in `keep`, refused past `limit` bytes; its size printed. */
const RECEIVE_SCRIPT = `keep, task, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.makedirs(keep, exist_ok=True)
path = os.path.join(keep, task+'.patch')
def gone():
    try:
        os.remove(path)
    except OSError:
        pass
# (A file of its own each time: whatever an earlier one cut short still writes goes to that one's.)
gone()
size = 0
with open(path,'wb') as f:
    while size <= limit:
        chunk = sys.stdin.buffer.read(1<<20)
        if not chunk: break
        size += len(chunk)
        f.write(chunk)
if size > limit:
    gone()
    sys.exit('its changes come to more than %d bytes' % limit)
print(size)`;

/**
 * Its agent's side: the patch kept in `keep`, applied to the task's worktree at `root`, set back to `base` first with
 * nothing else in it (what git ignores too), with the node's held git, and then dropped. Refused whole unless it is the
 * `size` bytes the node carried, or past `limit` as its binary parts say they inflate.
 */
const APPLY_SCRIPT = `root, base, keep, task, size, limit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
path = os.path.join(keep, task+'.patch')
def gone():
    try:
        os.remove(path)
    except OSError:
        pass
bad = refused(root)
if bad:
    gone()
    sys.exit(bad)
# (All of what the node carried, and nothing else.)
try:
    got = os.path.getsize(path)
except OSError:
    got = -1
if got != size:
    gone()
    sys.exit('its changes came cut short: %d of %d bytes' % (max(got, 0), size))
# (What each binary part inflates to, as it says: a small patch can't fill the store either.)
inflated = 0
with open(path,'rb') as f:
    for line in f:
        m = re.fullmatch(rb'(?:literal|delta) ([0-9]{1,15})', line.rstrip(b'\\n'))
        if m: inflated += int(m.group(1))
if inflated > limit:
    gone()
    sys.exit('its changes inflate to more than %d bytes' % limit)
said = lambda r: (r.stderr or r.stdout).decode(errors='replace')[-300:]
# (Its worktree set back to where the work began, and nothing else in it: an earlier run's files are untracked once its
# changes are read, and the patch has them all as the clone has them, kept, changed or gone. Those git ignores go too,
# a link among them: git apply checks the index alone for a link its paths go through, and would follow one.)
r = git(root,'read-tree','--reset','-u',base,timeout=600)
if not r.returncode: r = git(root,'clean','-f','-d','-x','-q',timeout=600)
if r.returncode:
    gone()
    sys.exit('could not set its workspace back to where it began: '+said(r))
r = git(root,'apply','--index','--binary','--allow-empty','--whitespace=nowarn',path,timeout=600)
gone()
if r.returncode: sys.exit('its changes could not be applied: '+said(r))
print(size)`;

/** Its agent's side: a patch that didn't all come, dropped. */
const DROP_SCRIPT = `keep, task = sys.argv[1], sys.argv[2]
try:
    os.remove(os.path.join(keep, task+'.patch'))
except OSError:
    pass`;

/** Where each side keeps its scratch files: under the agent's /work/.agent, and the task VM's own. */
export const HANDED_KEEP = "/work/.agent/handed";

export const handedGive = (root: string, task: string, keep = HANDED_KEEP): string => heldGit(GIVE_SCRIPT, root, task, keep);
export const handedTake = (root: string, base: string, name: string, email: string, keep = HANDED_KEEP): string => heldGit(TAKE_SCRIPT, root, base, name, email, keep);
export const handedSend = (root: string, base: string, keep = HANDED_KEEP): string => heldGit(SEND_SCRIPT, root, base, keep);
export const handedReceive = (task: string, limit: number, keep = HANDED_KEEP): string => heldGit(RECEIVE_SCRIPT, keep, task, String(limit));
export const handedApply = (root: string, base: string, task: string, size: number, limit: number, keep = HANDED_KEEP): string => heldGit(APPLY_SCRIPT, root, base, keep, task, String(size), String(limit));
export const handedDrop = (task: string, keep = HANDED_KEEP): string => heldGit(DROP_SCRIPT, keep, task);
