import { WORKSPACE_OWN } from "@invincible/core";

/**
 * The way to what a look into an agent's workspace names (a look, or a folder kept as an artifact), within /work alone (its second argument names another, for tests): each folder on the
 * way and the last one opened from the one before it, never by its path, with O_NOFOLLOW. A link on the way is read, not
 * followed, and its target walked in its place: within /work it works as ever; one that leads out (an absolute target
 * elsewhere, or `..` above /work) is refused, and so is a chain of more than 40. What is read is what was opened, so a
 * link swapped in as it reads can change which name is walked, never take it outside (27 November 2026: a link an agent
 * left in /work could make the node read a file outside it, a tool's sign-in among them). In a VM whose HOME is its /work,
 * what it reaches may not be in a top-level dot-entry of /work that isn't the workspace's own (WORKSPACE_OWN): that is its
 * HOME's, what its tools keep for themselves, which no look reads (the same rule a move to layout 2 goes by).
 */
export const WALK = `import base64,errno,json,os,re,stat,subprocess,sys
OWN=${JSON.stringify(WORKSPACE_OWN)}
class Refused(Exception):
    pass
def out(**said):
    print(json.dumps(said));sys.exit(0)
def walk(p,want):
    if p!=root and not p.startswith(root+'/'):
        raise Refused('OutsideWorkspace')
    rest=[c for c in p[len(root):].split('/') if c]
    held=[os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)]
    names=[];links=0
    while rest:
        c=rest.pop(0)
        if c=='.':
            continue
        if c=='..':
            if len(held)==1:
                raise Refused('OutsideWorkspace')
            os.close(held.pop());names.pop();continue
        last=not rest
        flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|(os.O_NONBLOCK if last and want=='file' else os.O_DIRECTORY)
        try:
            fd=os.open(c,flags,dir_fd=held[-1])
        except OSError as e:
            # A link (by lstat: a link opened as a folder is ELOOP on Linux, ENOTDIR on a Mac) is read. Not a link, its
            # own error, unless it was one as it was opened (ELOOP) and changed since; and one that changed as it was
            # read: either walked again, within the links' bound.
            try:
                seen=os.stat(c,dir_fd=held[-1],follow_symlinks=False)
            except OSError:
                seen=None
            to=None
            if seen is not None and stat.S_ISLNK(seen.st_mode):
                try:
                    to=os.readlink(c,dir_fd=held[-1])
                except OSError:
                    pass
            elif e.errno!=errno.ELOOP:
                raise e
            links+=1
            if links>40:
                raise Refused('TooManyLinks')
            if to is None:
                rest.insert(0,c);continue
            if to.startswith('/'):
                if to!=root and not to.startswith(root+'/'):
                    raise Refused('OutsideWorkspace')
                for d in held[1:]:
                    os.close(d)
                held=held[:1];names=[];to=to[len(root):]
            rest=[x for x in to.split('/') if x]+rest
            continue
        held.append(fd);names.append(c)
    if names and names[0].startswith('.') and names[0] not in OWN and os.path.normpath(os.environ.get('HOME','')) == root:
        raise Refused('KeptHome')
    return held,names
def at(names):
    return root+''.join('/'+n for n in names)
`;

/** What a folder's collecting says when it can't be (its exit): refused (outside /work, or its HOME's), or not there. */
export const COLLECT_REFUSED = 3;
export const COLLECT_MISSING = 4;

/**
 * `python3 -I -c COLLECT <folder>`: a folder of a VM's /work as a tar on its stdout, for the node to keep (SandboxHost.collect:
 * an artifact), its entries named under the folder's own name as docker cp named them. The folder is reached by the walk;
 * what is in it is read as the walk reads, each folder opened from the one before it and each file from its folder, with
 * O_NOFOLLOW, so nothing swapped in as it is read takes it outside. A link is kept as a link (which the node's extractor
 * leaves out), never followed. In a VM whose HOME is its /work, collecting /work leaves out every top-level dot-entry
 * that isn't the workspace's own (WORKSPACE_OWN), and a folder that is one, or lies in one, is refused, as a look is.
 */
export const COLLECT_SCRIPT = `${WALK}import tarfile
p=sys.argv[1]
root=sys.argv[2] if len(sys.argv)>2 else '/work'
try:
    held,names=walk(p,'dir')
except Refused as r:
    sys.stderr.write('refused: '+r.args[0]+'\\n');sys.exit(${COLLECT_REFUSED})
except FileNotFoundError:
    sys.stderr.write('no such folder\\n');sys.exit(${COLLECT_MISSING})
home=os.path.normpath(os.environ.get('HOME',''))==root
tar=tarfile.open(fileobj=sys.stdout.buffer,mode='w|',format=tarfile.PAX_FORMAT)
def entry(name,seen,kind):
    e=tarfile.TarInfo(name);e.mtime=int(seen.st_mtime);e.mode=stat.S_IMODE(seen.st_mode);e.type=kind
    return e
top=names[-1] if names else (os.path.basename(root) or 'work')
tar.addfile(entry(top,os.fstat(held[-1]),tarfile.DIRTYPE))
todo=[(os.dup(held[-1]),top,not names)]
while todo:
    fd,name,isroot=todo.pop()
    try:
        for n in sorted(os.listdir(fd)):
            # (Its HOME's, in a VM whose HOME is its /work: left out, whatever it is.)
            if isroot and home and n.startswith('.') and n not in OWN:
                continue
            try:
                seen=os.stat(n,dir_fd=fd,follow_symlinks=False)
            except OSError:
                continue
            path=name+'/'+n
            if stat.S_ISDIR(seen.st_mode):
                try:
                    sub=os.open(n,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                except OSError:
                    continue
                tar.addfile(entry(path,seen,tarfile.DIRTYPE))
                todo.append((sub,path,False))
            elif stat.S_ISREG(seen.st_mode):
                try:
                    f=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
                except OSError:
                    continue
                with os.fdopen(f,'rb') as file:
                    now=os.fstat(file.fileno())
                    if not stat.S_ISREG(now.st_mode):
                        continue
                    e=entry(path,now,tarfile.REGTYPE);e.size=now.st_size
                    tar.addfile(e,file)
            elif stat.S_ISLNK(seen.st_mode):
                e=entry(path,seen,tarfile.SYMTYPE)
                try:
                    e.linkname=os.readlink(n,dir_fd=fd)
                except OSError:
                    continue
                tar.addfile(e)
    finally:
        os.close(fd)
tar.close()`;

/** The command that collects a VM's folder (COLLECT_SCRIPT), as the VM runs it; `root` names another /work, for tests. */
export const collectCommand = (folder: string, root?: string): string[] => ["python3", "-I", "-c", COLLECT_SCRIPT, folder, ...(root ? [root] : [])];
