import { randomBytes } from "node:crypto";
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
 *   (`handedSend`, in its own VM), which its agent's side keeps as a file of that receive's own (`handedReceive`, named
 *   by a nonce the node gives it and its apply), held to a limit, and then applies with the node's held git
 *   (`handedApply`): to where the work began alone, in an index of its own, so that nothing in the task's worktree is read
 *   or written through, and then the tree that makes, and nothing else, is made the worktree's; what the patch's binary
 *   parts inflate to is held to the limit too. Every step of the agent's side on that worktree runs one at a time
 *   (team-runtime.ts), and each apply prints the tree it made, which is what its review's evidence is read on.
 * - It is applied only once the node has seen all of it come: its sender done, the pipe not cut, and as many bytes kept
 *   as were carried. A side ended by its deadline, or a pipe cut at its cap, ends what the other reads as if the patch
 *   ended there, so a patch cut short at a file's end would otherwise be applied as a smaller one. One that didn't all
 *   come is dropped (`handedDrop`).
 * - What a run cut off left on the agent's side (a receive's file, an index, the give's ref: each removed by its own
 *   script's end, which a deadline's SIGKILL skips) is swept as the task starts again (`handedSweep`).
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

/**
 * Its agent's side: the patch on stdin kept in `keep` as a file of this receive's own, by the node's `nonce`, refused past
 * `limit` bytes; its size printed.
 */
const RECEIVE_SCRIPT = `keep, task, nonce, limit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
if not re.fullmatch('[0-9a-f]{32}', nonce): sys.exit('no such receive')
os.makedirs(keep, exist_ok=True)
path = os.path.join(keep, task+'.'+nonce+'.patch')
def gone():
    try:
        os.remove(path)
    except OSError:
        pass
# (A file of its own each time, by a name only the node and this receive's apply know: the apply reads only what its own
# pipe carried, and whatever an earlier one cut short still writes goes to that one's (the seventh fabric review's R7-3).)
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
 * Its agent's side: the patch of one receive (`nonce`) kept in `keep`, applied with the node's held git to `base` alone, in
 * an index of its own, and then dropped; the tree that made is then the task's worktree at `root`, and its index, with
 * nothing else in it (what git ignores too). Its size and that tree printed. Refused whole unless it is the `size` bytes
 * the node carried, or past `limit` as its binary parts say they inflate.
 */
const APPLY_SCRIPT = `root, base, keep, task, nonce, size, limit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6]), int(sys.argv[7])
if not re.fullmatch('[0-9a-f]{32}', nonce): sys.exit('no such receive')
path = os.path.join(keep, task+'.'+nonce+'.patch')
index = os.path.join(keep, task+'.'+nonce+'.apply-index')
def gone():
    for each in (path, index):
        try:
            os.remove(each)
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
# (The patch applied to where the work began alone, in an index of this apply's own. git apply --cached reads and writes
# nothing of the worktree, so no file or link there is read or written through: not an earlier run's, nor one another
# apply on the worktree left in it (the seventh fabric review's R7-3), nor one inside an untracked nested repository
# (I-a). git apply --index checks the index alone for a link its paths go through, and would follow one.)
held = {'GIT_INDEX_FILE': index}
r = git(root,'read-tree',base,env=held)
if not r.returncode: r = git(root,'apply','--cached','--binary','--allow-empty','--whitespace=nowarn',path,timeout=600,env=held)
tree = '' if r.returncode else git(root,'write-tree',env=held).stdout.decode().strip()
gone()
if r.returncode or not re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', tree): sys.exit('its changes could not be applied: '+(said(r) if r.returncode else 'their tree could not be written'))
# (Then that tree, and nothing else, is the worktree and its index. An earlier run's files are untracked once its changes
# are read, and the tree has them all as the clone has them, kept, changed or gone. read-tree -u replaces a link in the
# way of a path it writes with a folder, and writes nothing through it; clean -ff takes the rest, what git ignores and an
# untracked nested repository among it.)
r = git(root,'read-tree','--reset','-u',tree,timeout=600)
if not r.returncode: r = git(root,'clean','-f','-f','-d','-x','-q',timeout=600)
if r.returncode: sys.exit('its workspace could not be made what its changes are: '+said(r))
print(size, tree)`;

/** Its agent's side: a patch of one receive (`nonce`) that didn't all come, dropped, with its apply's index. */
const DROP_SCRIPT = `keep, task, nonce = sys.argv[1], sys.argv[2], sys.argv[3]
if re.fullmatch('[0-9a-f]{32}', nonce):
    for each in ('.patch', '.apply-index'):
        try:
            os.remove(os.path.join(keep, task+'.'+nonce+each))
        except OSError:
            pass`;

/**
 * Its agent's side: the tree of the task's worktree at `root` as it stands, everything git doesn't ignore, read as its VM's
 * send reads its clone (SEND_SCRIPT): what its changes' read would ship. Its scratch index goes in `keep`.
 */
const TREE_SCRIPT = `root, base, keep, task = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
bad = refused(root)
if bad: sys.exit(bad)
os.makedirs(keep, exist_ok=True)
index = os.path.join(keep, task+'.tree-index')
def gone():
    try:
        os.remove(index)
    except OSError:
        pass
gone()
held = {'GIT_INDEX_FILE': index}
r = git(root,'read-tree',base,env=held)
if not r.returncode: r = git(root,'add','-A','.',env=held,timeout=600)
tree = '' if r.returncode else git(root,'write-tree',env=held).stdout.decode().strip()
gone()
if not re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', tree): sys.exit('could not read its workspace')
print(tree)`;

/**
 * Its agent's side, as the task starts again: what a run of it cut off left there (the seventh fabric review's I-d), gone.
 * A receive's patch (up to the limit), an apply's, a give's or a tree's index, each removed by its own script's end, and
 * the give's ref, removed by its finally: a deadline's SIGKILL skips both. Only this task's own: another's may be under
 * way.
 */
const SWEEP_SCRIPT = `root, task, keep = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.isdir(keep):
    for name in os.listdir(keep):
        if name.startswith(task+'.') and (name.endswith('.patch') or name.endswith('-index')):
            try:
                os.remove(os.path.join(keep, name))
            except OSError:
                pass
bad = refused(root)
if bad: sys.exit(bad)
ref = 'refs/invincible/give/'+task
if git(root,'rev-parse','-q','--verify',ref).returncode == 0 and git(root,'update-ref','-d',ref).returncode:
    sys.exit('its given workspace could not be let go')`;

/** Where each side keeps its scratch files: under the agent's /work/.agent, and the task VM's own. */
export const HANDED_KEEP = "/work/.agent/handed";

export const handedGive = (root: string, task: string, keep = HANDED_KEEP): string => heldGit(GIVE_SCRIPT, root, task, keep);
export const handedTake = (root: string, base: string, name: string, email: string, keep = HANDED_KEEP): string => heldGit(TAKE_SCRIPT, root, base, name, email, keep);
export const handedSend = (root: string, base: string, keep = HANDED_KEEP): string => heldGit(SEND_SCRIPT, root, base, keep);
/** A receive's own name, which its apply (or its drop) is given too: 128 random bits, as hex. */
export const handedNonce = (): string => randomBytes(16).toString("hex");
export const handedReceive = (task: string, nonce: string, limit: number, keep = HANDED_KEEP): string => heldGit(RECEIVE_SCRIPT, keep, task, nonce, String(limit));
export const handedApply = (root: string, base: string, task: string, nonce: string, size: number, limit: number, keep = HANDED_KEEP): string => heldGit(APPLY_SCRIPT, root, base, keep, task, nonce, String(size), String(limit));
export const handedDrop = (task: string, nonce: string, keep = HANDED_KEEP): string => heldGit(DROP_SCRIPT, keep, task, nonce);
export const handedTree = (root: string, base: string, task: string, keep = HANDED_KEEP): string => heldGit(TREE_SCRIPT, root, base, keep, task);
export const handedSweep = (root: string, task: string, keep = HANDED_KEEP): string => heldGit(SWEEP_SCRIPT, root, task, keep);
