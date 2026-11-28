import { randomBytes } from "node:crypto";
import { VM_GATES } from "@invincible/core";
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
 * The binary parts of a task's patch, held to what git apply does with them, before git ever reads the patch (the
 * seventh fabric review's R7-1 and R7-2): `binary_refused(root, base, path, limit)` is None when the patch may go to
 * git, else why not. It reads them as git's own parser does (apply.c's parse_binary_hunk, parse_binary and
 * apply_binary, and patch-delta.c), so that no part git would apply goes unread here.
 *
 * - git apply takes a binary part's content from the agent's object store whenever the store holds the id its index
 *   line names, of any type, and ignores the part's data; and one with no data at all (`Binary files … differ`) is
 *   applied only that way (R7-1). So each part's own data must make the id it names: a literal's as it inflates, a
 *   delta's applied to the file of `base`'s tree it names, which the task's own bundle carried, and a delta from any
 *   other content is refused without that content being read, its size included. Then whatever git reads under the id
 *   is those same bytes: no object of the store the task wasn't given reaches its worktree, and whether the store holds
 *   one changes nothing, so none is an oracle either.
 * - git reads a part's sizes with strtoul (R7-2). So every line that starts `literal` or `delta` and a space is as git
 *   writes it, and is one of a `GIT binary patch` section's, read here as git reads one, or the patch is refused. What
 *   git inflates as it reads them (each hunk's size, both ways) and what a delta makes, with the file this check reads
 *   to make it, is held to `limit` before any of it is inflated, read or built: the check's own memory with it. The
 *   patch, which may be as large as the limit, is read a line at a time.
 * - A copy or a rename takes its content from a file of `base` and carries none of it, so a few KiB of them write that
 *   file as many times as they name it, past any limit (R7-2's kind: 64 copies wrote 2 MiB at a 64 KiB limit). The
 *   clone's send never makes one (`--no-renames`), so a patch with one is refused, however it is spelled (the eighth
 *   review's R8-1: 64 of git's older `rename old`/`new`, or of a `diff --git` naming two files, wrote 5.6 MB at a
 *   1 MiB limit): a `copy` or `rename` header line of any kind, a `diff --git` line whose two names aren't one path, or
 *   a `---` or `+++` in a section's header naming another than its path (or /dev/null). A traditional patch, with no
 *   `diff --git` line, is no copy: git patches the file its `+++` names, which must be there, with what it carries.
 */
const BINARY_CHECK = `import base64,hashlib,zlib
def binary_refused(root, base, path, limit):
    spelled = "its changes have a binary part not written as git writes one"
    carried = "its changes name content their binary parts don't carry"
    given = "its changes make a binary part from content the task wasn't given"
    over = 'its changes inflate to more than %d bytes' % limit
    copied = "its changes copy or rename a file, which its clone's send never does"
    method = re.compile(rb'(?:literal|delta)\\s').match
    sized = re.compile(rb'(literal|delta) (0|[1-9][0-9]{0,14})').fullmatch
    held = {}
    def text(line):
        return line[:-1] if line.endswith(b'\\n') else line
    def names(rest):
        # (A diff --git line's two names, as git writes them for one file, quoted or not: its a/ and b/ names, else None.)
        q = (len(rest) - (9 if rest.startswith(b'"') else 5)) // 2
        if q <= 0:
            return None
        if rest.startswith(b'"'):
            p = rest[3:3+q]
            return (b'"a/'+p+b'"', b'"b/'+p+b'"') if rest == b'"a/'+p+b'" "b/'+p+b'"' else None
        p = rest[2:2+q]
        return (b'a/'+p, b'b/'+p) if rest == b'a/'+p+b' b/'+p else None
    def blobs():
        # (The blobs of where the work began, by id with their sizes, read once: what the task's own bundle carried.)
        if 'blobs' not in held:
            r = git(root,'ls-tree','-r','-z','-l','--full-tree',base,timeout=600)
            found = {}
            for entry in (r.stdout.split(b'\\0') if not r.returncode else []):
                meta = entry.split(b'\\t',1)[0].split()
                if len(meta) == 4 and meta[1] == b'blob':
                    found[meta[2].decode()] = int(meta[3])
            held['blobs'] = None if r.returncode else found
        return held['blobs']
    def varint(data, at):
        # (A delta's size, as get_delta_hdr_size reads it: None past the delta's end, or past what git's size_t holds.)
        value = shift = 0
        while at < len(data) and shift < 64:
            byte = data[at]
            at += 1
            value |= (byte & 0x7f) << shift
            shift += 7
            if not byte & 0x80:
                return value, at
        return None, at
    def patched(source, delta, at, size):
        # (What a delta makes of its source, as patch-delta.c's patch_delta makes it, each bound checked as it checks it:
        # None where it would fail.)
        out = bytearray(size)
        source = memoryview(source)
        done = 0
        while at < len(delta):
            op = delta[at]
            at += 1
            if op & 0x80:
                offset = length = 0
                for bit, shift in ((1,0),(2,8),(4,16),(8,24)):
                    if op & bit:
                        if at >= len(delta): return None
                        offset |= delta[at] << shift
                        at += 1
                for bit, shift in ((16,0),(32,8),(64,16)):
                    if op & bit:
                        if at >= len(delta): return None
                        length |= delta[at] << shift
                        at += 1
                length = length or 0x10000
                if offset + length > len(source) or length > size - done: return None
                out[done:done+length] = source[offset:offset+length]
                done += length
            elif op:
                if op > size - done or op > len(delta) - at: return None
                out[done:done+op] = delta[at:at+op]
                at += op
                done += op
            else:
                return None
        return out if done == size else None
    def hunk(lines, inflated):
        # (A hunk's data lines to the blank line that ends it, as parse_binary_hunk reads them, and what they inflate to,
        # held to the size it states as inflate_it holds them: None where git would find it corrupt. A reverse hunk is
        # read and counted, never applied, so it isn't inflated.)
        z = zlib.decompressobj() if inflated is not None else None
        out = bytearray()
        for line in lines:
            if line == b'\\n':
                break
            n, c = len(line), line[0]
            length = c - 64 if 65 <= c <= 90 else c - 70 if 97 <= c <= 122 else 0
            room = (n - 2) // 5 * 4
            if n < 7 or (n - 2) % 5 or line[-1] != 10 or not room - 4 < length <= room:
                return None
            try:
                data = base64.b85decode(line[1:-1])[:length]
            except ValueError:
                return None
            if z is not None and not z.eof:
                try:
                    out += z.decompress(data, inflated + 1 - len(out))
                except zlib.error:
                    return None
                if len(out) > inflated:
                    return None
        else:
            return None
        return out if z is None or (z.eof and len(out) == inflated) else None
    with open(path,'rb') as f:
        def read():
            while True:
                line = f.readline(1<<16)
                if not line:
                    return
                # (A line longer than any of a binary part's is kept only as far as its start: it is none of them.)
                rest = line
                while len(rest) == 1<<16 and rest[-1] != 10:
                    rest = f.readline(1<<16)
                yield line
        lines = read()
        total, index = 0, None
        # (The names of the section being read, from its diff --git line, and whether its header is: to its first hunk.)
        section, header = None, False
        line = next(lines, None)
        while line is not None:
            if line.startswith(b'diff --git '):
                section, header = names(text(line)[11:]), True
                if section is None:
                    return copied
            elif header and (line.startswith(b'@@ ') or text(line) == b'GIT binary patch'):
                header = False
            # (Each name to its first tab, as git reads it: git ends one with a space in it so, and quotes any with a tab.)
            elif header and line.startswith(b'--- ') and text(line)[4:].split(b'\\t', 1)[0] not in (section[0], b'/dev/null'):
                return copied
            elif header and line.startswith(b'+++ ') and text(line)[4:].split(b'\\t', 1)[0] not in (section[1], b'/dev/null'):
                return copied
            if method(line):
                return spelled
            if line.startswith((b'Binary files ', b'Files ')):
                return carried
            # (A header line: no line of a hunk starts so, its first character being its kind. Any spelling of a copy or a
            # rename: git's older rename old/new among them.)
            if line.startswith((b'copy ', b'rename ')):
                return copied
            if line.startswith(b'index '):
                index = text(line)
            if text(line) != b'GIT binary patch':
                line = next(lines, None)
                continue
            # (A section: its ids from the index line before it, as full as git needs them, then its forward hunk.)
            if 'algo' not in held:
                r = git(root,'rev-parse','--show-object-format')
                held['algo'] = '' if r.returncode else r.stdout.decode(errors='replace').strip()
            algo = held['algo']
            if algo not in ('sha1','sha256'):
                return "could not read its repository's object format"
            hexsz = 40 if algo == 'sha1' else 64
            ids = index and re.fullmatch(rb'index ([0-9a-f]{%d})\\.\\.([0-9a-f]{%d})(?: [0-7]{6})?' % (hexsz, hexsz), index)
            if not ids:
                return 'its changes have a binary part without full ids'
            old, new = ids.group(1).decode(), ids.group(2).decode()
            line = next(lines, None)
            m = line is not None and sized(text(line))
            if not m:
                return spelled
            total += int(m.group(2))
            if total > limit:
                return over
            data = hunk(lines, int(m.group(2)))
            if data is None:
                return spelled
            # (A deletion's result is no content at all. Any other part's is its own data, or what its delta makes of a
            # file of where the work began, and must be the blob it names.)
            if new != '0' * hexsz:
                if m.group(1) == b'delta':
                    have = blobs()
                    if have is None:
                        return 'could not read the files where its work began'
                    if old not in have:
                        return given
                    source, at = varint(data, 0)
                    size, at = varint(data, at) if source is not None else (None, at)
                    if len(data) < 4 or size is None or source != have[old]:
                        return spelled
                    total += source + size
                    if total > limit:
                        return over
                    r = git(root,'cat-file','blob',old,timeout=600)
                    if r.returncode or len(r.stdout) != source:
                        return 'could not read the file its binary part changes'
                    data = patched(r.stdout, data, at, size)
                    if data is None:
                        return spelled
                made = hashlib.new(algo)
                made.update(b'blob %d\\0' % len(data))
                made.update(data)
                if made.hexdigest() != new:
                    return carried
            data = None
            # (Its reverse hunk, if it has one: counted, since git inflates it too.)
            line = next(lines, None)
            if line is not None and method(line):
                m = sized(text(line))
                if not m:
                    return spelled
                total += int(m.group(2))
                if total > limit:
                    return over
                if hunk(lines, None) is None:
                    return spelled
                line = next(lines, None)
    return None
`;

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
# (Each binary part carries the content it names, and what they inflate to is held to the limit, as git reads them:
# BINARY_CHECK. A small patch can't copy the store, or fill it, either.)
${BINARY_CHECK}
bad = binary_refused(root, base, path, limit)
if bad:
    gone()
    sys.exit(bad)
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

/**
 * In the task's VM, as its gates' own user (the eighth fabric review's R8-3): a copy of the task's tree at `on`, a folder of
 * its own in the gates' (VM_GATES), for one gate or one check of the node's, with a HOME and a temporary folder of its own
 * beside it. Every earlier folder there goes first, so nothing one gate (whose command may run the task's code) leaves
 * there reaches the next.
 *
 * - In a repository: the tree `tree`'s objects, from the task's clone, each hashed as the copy's own repository takes them
 *   (`index-pack`), so what is checked out is that tree, whatever the clone holds or does meanwhile, and the clone, its
 *   configuration among it, runs nothing (no fetch of any kind). Its `.git` is the copy's own: an index of that tree,
 *   and HEAD a commit of it with no history.
 * - With no repository (`tree` ""): the task's folder, copied as this user can read it now (only files, folders and
 *   links: no FIFO, socket or device), and that copy's tree as git hashes it, which must be `was` when it is given (the
 *   folder's as its gates began).
 * - A link that points out of the tree (an absolute one, or one up past its top) is refused: the gates run on the tree
 *   alone, and out of it is the task's to write.
 *
 * It prints how many files the copy holds, their bytes, and its tree.
 */
const GATES_SCRIPT = `root, tree, on, was = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
import stat
hexed = lambda t: re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', t)
if not re.fullmatch('[0-9a-f]{32}', os.path.basename(on)) or not os.path.isabs(on) or (tree and not hexed(tree)) or (was and (tree or not hexed(was))):
    sys.exit('not a copy for its gates')
top = os.path.dirname(on)
def drop(path):
    def again(fn, p, _):
        try:
            os.chmod(os.path.dirname(p), 0o700)
            if not os.path.islink(p): os.chmod(p, 0o700)
            fn(p)
        except OSError:
            pass
    shutil.rmtree(path, onerror=again)
for name in os.listdir(top):
    path = os.path.join(top, name)
    if path == on: continue
    if os.path.isdir(path) and not os.path.islink(path): drop(path)
    else:
        try:
            os.remove(path)
        except OSError:
            pass
os.mkdir(on, 0o700)
for sub in ('home', 'tmp', 'tree'):
    os.mkdir(os.path.join(on, sub), 0o700)
copy = os.path.join(on, 'tree')
env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': os.path.join(on, 'home'), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_ATTR_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_LAZY_FETCH': '1', 'GIT_LFS_SKIP_SMUDGE': '1', 'LC_ALL': 'C'}
off = RUN_OFF + ['-c', 'protocol.allow=never', '-c', 'safe.directory=*']
def said(r):
    return (r.stderr.decode(errors='replace').strip().split('\\n') or [''])[-1][:300] or 'no reason given'
def ran(*a, extra=None):
    return subprocess.run(['git', *off, *a], capture_output=True, timeout=600, env={**env, **(extra or {})})
if tree:
    r = ran('init', '-q', '--template=', '--object-format=' + ('sha256' if len(tree) == 64 else 'sha1'), '-b', 'main', copy)
    if r.returncode: sys.exit('its copy could not be begun: ' + said(r))
    clone = ['--git-dir=' + os.path.join(root, '.git')]
    listed = os.path.join(on, 'objects')
    with open(listed, 'wb') as out:
        r = subprocess.run(['git', *off, *clone, 'rev-list', '--objects', tree], stdout=out, stderr=subprocess.PIPE, timeout=600, env=env)
    if r.returncode: sys.exit('its tree could not be read from its clone: ' + said(r))
    with open(listed, 'rb') as names, open(os.path.join(on, 'pack-errors'), 'wb') as errors:
        packed = subprocess.Popen(['git', *off, *clone, 'pack-objects', '--stdout', '-q'], stdin=names, stdout=subprocess.PIPE, stderr=errors, env=env)
        taken = subprocess.run(['git', *off, '-C', copy, 'index-pack', '--stdin'], stdin=packed.stdout, capture_output=True, timeout=600, env=env)
        packed.stdout.close()
        packed.wait(600)
    for each in ('objects', 'pack-errors'):
        os.remove(os.path.join(on, each))
    if packed.returncode or taken.returncode: sys.exit('its tree could not be taken from its clone: ' + (said(taken) if taken.returncode else 'its objects could not be packed'))
    r = ran('-C', copy, 'read-tree', tree)
    if not r.returncode: r = ran('-C', copy, 'checkout-index', '-a', '-f')
    if r.returncode: sys.exit('its tree could not be checked out: ' + said(r))
    ident = {'GIT_AUTHOR_NAME': 'Invincible', 'GIT_AUTHOR_EMAIL': 'gates@invincible.invalid', 'GIT_COMMITTER_NAME': 'Invincible', 'GIT_COMMITTER_EMAIL': 'gates@invincible.invalid', 'GIT_AUTHOR_DATE': '@0 +0000', 'GIT_COMMITTER_DATE': '@0 +0000'}
    r = ran('-C', copy, 'commit-tree', tree, '-m', 'The tree its gates run on', extra=ident)
    commit = r.stdout.decode().strip()
    if not r.returncode: r = ran('-C', copy, 'update-ref', 'HEAD', commit)
    if r.returncode: sys.exit('its copy could not be given a HEAD: ' + said(r))
else:
    def copied(src, dst):
        for entry in os.scandir(src):
            s, d = entry.path, os.path.join(dst, entry.name)
            try:
                st = os.lstat(s)
                if stat.S_ISLNK(st.st_mode):
                    os.symlink(os.readlink(s), d)
                elif stat.S_ISDIR(st.st_mode):
                    os.mkdir(d, 0o700)
                    copied(s, d)
                    os.chmod(d, stat.S_IMODE(st.st_mode) | 0o700)
                elif stat.S_ISREG(st.st_mode):
                    fd = os.open(s, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    try:
                        if stat.S_ISREG(os.fstat(fd).st_mode):
                            with os.fdopen(os.dup(fd), 'rb') as a, open(d, 'wb') as b:
                                shutil.copyfileobj(a, b)
                            os.chmod(d, stat.S_IMODE(st.st_mode) | 0o600)
                    finally:
                        os.close(fd)
            except OSError:
                pass
    copied(root, copy)
    # (Its tree, as git hashes it, in a scratch store of the copy's own beside it: no file of it is changed.)
    store = os.path.join(on, 'hashed')
    held = {'GIT_DIR': store, 'GIT_INDEX_FILE': os.path.join(on, 'hashed.index'), 'GIT_WORK_TREE': copy}
    r = ran('init', '-q', '--bare', '--template=', store)
    if not r.returncode: r = subprocess.run(['git', *off, '-c', 'core.bare=false', 'add', '-A', '--force', '.'], cwd=copy, capture_output=True, timeout=600, env={**env, **held})
    tree = '' if r.returncode else ran('-c', 'core.bare=false', 'write-tree', extra=held).stdout.decode().strip()
    drop(store)
    try:
        os.remove(held['GIT_INDEX_FILE'])
    except OSError:
        pass
    if not hexed(tree): sys.exit('its folder could not be read: ' + (said(r) if r.returncode else 'no tree of it'))
    if was and tree != was: sys.exit("its folder isn't what it was as its gates began")
files = size = 0
for here, dirs, names in os.walk(copy):
    if here == copy and tree and '.git' in dirs: dirs.remove('.git')
    for name in dirs + names:
        path = os.path.join(here, name)
        if os.path.islink(path):
            to, rel = os.readlink(path), os.path.relpath(path, copy)
            if os.path.isabs(to) or os.path.normpath(os.path.join(os.path.dirname(rel), to)).split(os.sep)[0] == '..':
                sys.exit('its tree has a link out of it, ' + rel + ' -> ' + to + ': its gates run on the tree alone')
        elif name in names:
            files += 1
            size += os.lstat(path).st_size
print(files, size, tree)`;

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
/**
 * Its gates' copy of the task's tree (GATES_SCRIPT), run as their own user: at `on`, a folder of `gates` (VM_GATES) named
 * by a nonce of the node's. `tree`, its clone's tree; "" for a task with no repository, whose folder's copy must hash to
 * `was` when it is given.
 */
export const handedGates = (root: string, tree: string, on: string, gates: string = VM_GATES, was = ""): string => {
  const id = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  if (!on.startsWith(`${gates}/`) || !/^[0-9a-f]{32}$/.test(on.slice(gates.length + 1)) || (tree !== "" && !id.test(tree)) || (was !== "" && (tree !== "" || !id.test(was)))) throw new Error("not a copy for its gates");
  return heldGit(GATES_SCRIPT, root, tree, on, was);
};

/**
 * Its agent's side, as the node starts: the tasks whose cut-off runs left something there (the seventh fabric review's
 * I-d), by id, one a line. In `keep`: a receive's patch or its apply's index, a give's or a tree's index, the patch of
 * before, each named as SWEEP_SCRIPT takes it (the task's id and a dot first, `.patch` or `-index` last); a handed
 * helper's list (`.jsonl`) is endLeftovers'. In the repository at `root`, once it is there: a give's ref. Only names that
 * can be a task's id are printed, and the node checks each again.
 */
const LEFT_SCRIPT = `root, keep = sys.argv[1], sys.argv[2]
found = set()
if os.path.isdir(keep):
    for name in os.listdir(keep):
        if '.' in name and (name.endswith('.patch') or name.endswith('-index')):
            found.add(name.split('.',1)[0])
if os.path.isdir(root):
    bad = refused(root)
    if bad: sys.exit(bad)
    r = git(root,'for-each-ref','--format=%(refname)','refs/invincible/give/')
    if r.returncode: sys.exit('its gives could not be listed: '+(r.stderr or r.stdout).decode(errors='replace')[-300:])
    for ref in r.stdout.decode(errors='replace').splitlines():
        if ref.startswith('refs/invincible/give/'): found.add(ref[len('refs/invincible/give/'):])
for task in sorted(found):
    if re.fullmatch('[A-Za-z0-9_-]{1,80}', task): print(task)`;

/** The task-id rule of handed-process.ts (its TASK_ID): every id an agent's VM lists here is checked against it. */
const HANDED_TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Sweeps, in one agent's VM as the node starts, what runs of tasks other nodes handed over cut off left on its side (the
 * seventh fabric review's I-d). Each task's start sweeps its own (handedSweep), so a task that never runs again would
 * keep them, a receive's patch of up to the limit among them, for as long as the VM lasts. Every task that left any is
 * listed (LEFT_SCRIPT), its id checked first; each that `sweepable` says can't be running (it has ended, or the node
 * doesn't know it) is swept by handedSweep, which takes that task's own and nothing of any other's. `exec`: a command in
 * that VM that a pause of its agent doesn't refuse. A listing that fails throws, saying why.
 */
export async function sweepLeftovers(exec: (command: string, timeout: number) => Promise<{ exitCode: number; stdout: string; stderr?: string }>, sweepable: (task: string) => boolean, root = "/work/repo", keep = HANDED_KEEP): Promise<{ swept: string[]; failed: string[] }> {
  const listed = await exec(heldGit(LEFT_SCRIPT, root, keep), 60);
  if (listed.exitCode !== 0) throw new Error((listed.stderr || listed.stdout).trim().slice(-300) || "its listing failed");
  const swept: string[] = [];
  const failed: string[] = [];
  for (const task of new Set(listed.stdout.split("\n").map((line) => line.trim()))) {
    // (Asked just before its own sweep, not once for all: a task stopped here may be resumed meanwhile.)
    if (!HANDED_TASK_ID.test(task) || !sweepable(task)) continue;
    ((await exec(handedSweep(root, task, keep), 60)).exitCode === 0 ? swept : failed).push(task);
  }
  return { swept, failed };
}
