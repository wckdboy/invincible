import { ATTACHMENT_LIMITS, pictureType, redact, type TeamChangedFile, type TeamChangesView, type TeamFileEntry, type TeamFilesView, type TeamFileView, textOf } from "@invincible/core";

/*
 * Looking into an agent's workspace (its VM's /work, or the primary's computer's) from your devices: a folder's entries, one
 * file, and what a task changed in its repository. Read only, and yours alone (the routes are owner-only). Each look is
 * one of these fixed scripts, run in the VM with Python as the VM's own user, its only input the path or the task given
 * as arguments (never in the script's text). A folder and a file are looked at within /work alone, never through a link
 * out of it (WALK). What comes back is bounded in the VM, checked here, and a text or a diff has anything that looks like
 * a key redacted before it leaves the node.
 */

/** A file shown whole up to this many bytes (its bytes go base64 through the VM's 1 MB of output). */
export const READ_LIMIT = 700_000;
/** A diff shown up to this many characters. */
export const DIFF_LIMIT = 600_000;
/** A folder's first entries, in order. */
export const LIST_LIMIT = 2_000;
/** Kept from view, whatever is asked: the file that holds the VM's gateway token. */
export const KEPT_FROM_VIEW = ["/work/.invincible-gateway.json"] as const;

/**
 * The way to what a look names, within /work alone (its second argument names another, for tests): each folder on the
 * way and the last one opened from the one before it, never by its path, with O_NOFOLLOW. A link on the way is read, not
 * followed, and its target walked in its place: within /work it works as ever; one that leads out (an absolute target
 * elsewhere, or `..` above /work) is refused, and so is a chain of more than 40. What is read is what was opened, so a
 * link swapped in as it reads can change which name is walked, never take it outside (27 November 2026: a link an agent
 * left in /work could make the node read a file outside it, a tool's sign-in among them).
 */
const WALK = `import base64,errno,json,os,stat,sys
p=sys.argv[1]
root=sys.argv[2] if len(sys.argv)>2 else '/work'
KEPT=${JSON.stringify(KEPT_FROM_VIEW.map((path) => path.slice("/work/".length)))}
def out(**said):
    print(json.dumps(said));sys.exit(0)
def walk(p,want):
    if p!=root and not p.startswith(root+'/'):
        out(error='OutsideWorkspace')
    rest=[c for c in p[len(root):].split('/') if c]
    held=[os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)]
    names=[];links=0
    while rest:
        c=rest.pop(0)
        if c=='.':
            continue
        if c=='..':
            if len(held)==1:
                out(error='OutsideWorkspace')
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
                out(error='TooManyLinks')
            if to is None:
                rest.insert(0,c);continue
            if to.startswith('/'):
                if to!=root and not to.startswith(root+'/'):
                    out(error='OutsideWorkspace')
                for d in held[1:]:
                    os.close(d)
                held=held[:1];names=[];to=to[len(root):]
            rest=[x for x in to.split('/') if x]+rest
            continue
        held.append(fd);names.append(c)
    return held,names
`;

/** `python3 -I -c LIST <path>`: a folder's entries, folders and files each with its size and when it changed, a link as a link. */
export const LIST_SCRIPT = `${WALK}try:
    held,_=walk(p,'dir')
    names=sorted(os.listdir(held[-1]),key=lambda n:n.lower())
except OSError as e:
    out(error=type(e).__name__)
entries=[]
for n in names[:${LIST_LIMIT}]:
    try:
        s=os.stat(n,dir_fd=held[-1],follow_symlinks=False)
    except Exception:
        continue
    k='link' if stat.S_ISLNK(s.st_mode) else 'dir' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'other'
    entries.append({"name":n,"kind":k,"size":s.st_size,"modified":int(s.st_mtime*1000)})
out(entries=entries,more=len(names)>${LIST_LIMIT})`;

/**
 * `python3 -I -c READ <path>`: one regular file's first READ_LIMIT bytes, base64, with its size and when it changed. Not
 * the VM's lease (KEPT_FROM_VIEW), whatever leads to it: its name, a link to it, or the same file under another name.
 */
export const READ_SCRIPT = `${WALK}try:
    held,names=walk(p,'file')
    s=os.fstat(held[-1])
except OSError as e:
    out(error=type(e).__name__)
if not stat.S_ISREG(s.st_mode):
    out(error='NotAFile')
for kept in KEPT:
    try:
        k=os.stat(kept,dir_fd=held[0],follow_symlinks=False)
    except OSError:
        k=None
    if '/'.join(names)==kept or (k is not None and (k.st_dev,k.st_ino)==(s.st_dev,s.st_ino)):
        out(error='KeptFromView')
with os.fdopen(held[-1],'rb') as f:
    b=f.read(${READ_LIMIT}+1)
out(size=s.st_size,modified=int(s.st_mtime*1000),cut=len(b)>${READ_LIMIT},data=base64.b64encode(b[:${READ_LIMIT}]).decode())`;

/**
 * `python3 -I -c CHANGES <worktree> <kept>`: what a task changed in its worktree (a task's own git worktree, /work/tasks/<id>,
 * or the repository itself): from the commit it started at (the first word of <kept>, written as it started) or, with
 * none, from HEAD; the files and the diff (bounded), and the files git doesn't track yet.
 */
export const CHANGES_SCRIPT = `import json,os,subprocess,sys
root,kept=sys.argv[1],sys.argv[2]
if not os.path.exists(os.path.join(root,'.git')):
    print(json.dumps({"error":"NotARepository"}));sys.exit(0)
git=lambda *a: subprocess.run(['git','-C',root,*a],capture_output=True,timeout=60)
base=None
if os.path.isfile(kept):
    words=open(kept).read().split()
    base=words[0] if words else None
since=base or 'HEAD'
head=git('rev-parse','HEAD').stdout.decode().strip() or None
numstat=git('diff','--numstat','--no-renames',since).stdout.decode(errors='replace')
names=git('diff','--name-status','--no-renames',since).stdout.decode(errors='replace')
untracked=git('ls-files','--others','--exclude-standard').stdout.decode(errors='replace').splitlines()
diff=git('diff','--no-color','--no-ext-diff','--no-renames',since).stdout
print(json.dumps({"base":base,"head":head,"numstat":numstat,"names":names,"untracked":untracked[:500],"diff":diff[:${DIFF_LIMIT}].decode(errors='replace'),"cut":len(diff)>${DIFF_LIMIT}}))`;

export class LookError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What the VM said, as JSON; anything else is the VM's failing. */
function said(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new LookError("the workspace didn't answer as it should (is Python 3 there?)", 502);
  }
  if (!value || typeof value !== "object") throw new LookError("the workspace didn't answer as it should", 502);
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") {
    const why: Record<string, [string, number]> = {
      FileNotFoundError: ["nothing is there", 404],
      NotADirectoryError: ["that is a file, not a folder", 409],
      IsADirectoryError: ["that is a folder, not a file", 409],
      NotAFile: ["that isn't a file", 409],
      PermissionError: ["the workspace's user may not read that", 403],
      NotARepository: ["that isn't a git repository", 404],
      OutsideWorkspace: ["that is outside the workspace", 403],
      TooManyLinks: ["too many links on the way to it", 422],
      KeptFromView: ["kept from view: it holds this VM's gateway token", 403],
    };
    const [message, status] = why[error] ?? ["it couldn't be read", 422];
    throw new LookError(message, status);
  }
  return value as Record<string, unknown>;
}

const isEntry = (e: unknown): e is TeamFileEntry => {
  const x = e as TeamFileEntry;
  return !!x && typeof x.name === "string" && x.name.length > 0 && x.name.length <= 1024 && ["dir", "file", "link", "other"].includes(x.kind) && Number.isFinite(x.size) && Number.isFinite(x.modified);
};

/** A folder's entries as the VM listed them (each checked; folders first, then by name). */
export function filesView(stdout: string, id: string, path: string): TeamFilesView {
  const raw = said(stdout);
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).filter(isEntry).map(({ name, kind, size, modified }) => ({ name, kind, size, modified }));
  entries.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return { id, path, entries, more: raw.more === true };
}

/**
 * One file as the VM read it: a picture (its bytes, when it came whole and fits a message's picture), text (UTF-8 with
 * no NUL, redacted), or what it is when it is neither or too big.
 */
export function fileView(stdout: string, id: string, path: string): TeamFileView {
  const raw = said(stdout);
  const size = Number(raw.size), modified = Number(raw.modified);
  if (!Number.isFinite(size) || !Number.isFinite(modified) || typeof raw.data !== "string") throw new LookError("the workspace didn't answer as it should", 502);
  const bytes = new Uint8Array(Buffer.from(raw.data, "base64"));
  const cut = raw.cut === true;
  const picture = pictureType(bytes);
  if (picture) {
    if (cut || bytes.length > ATTACHMENT_LIMITS.imageBytes) return { id, path, size, modified, kind: "large", type: picture };
    return { id, path, size, modified, kind: "image", type: picture, data: Buffer.from(bytes).toString("base64") };
  }
  // A text cut in the middle of a character is cut back to the last whole one.
  const text = textOf(bytes) ?? (cut ? textOf(wholeCharacters(bytes)) : null);
  if (text === null) return { id, path, size, modified, kind: "binary" };
  const shown = redact(text);
  return { id, path, size, modified, kind: "text", text: shown, ...(shown !== text ? { redacted: true } : {}), ...(cut ? { cut: true } : {}) };
}

/** Bytes cut at a byte limit, cut back to before a UTF-8 character the cut split (at most three bytes). */
function wholeCharacters(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const b = bytes[end - back]!;
    if ((b & 0xc0) !== 0x80) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (need > back) end -= back;
      break;
    }
  }
  return bytes.subarray(0, end);
}

/** What a task changed, as git in the VM said it: each file with its lines added and removed, and the diff, redacted. */
export function changesView(stdout: string, id: string, task: string | null, path: string): TeamChangesView {
  const raw = said(stdout);
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const line of String(raw.numstat ?? "").split("\n")) {
    const [added, removed, ...name] = line.split("\t");
    if (!name.length) continue;
    counts.set(name.join("\t"), { added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) });
  }
  const files: TeamChangedFile[] = [];
  for (const line of String(raw.names ?? "").split("\n")) {
    const [status, ...name] = line.split("\t");
    if (!status || !name.length) continue;
    const file = name.join("\t");
    files.push({ path: file, status: status.slice(0, 1), ...(counts.get(file) ?? { added: null, removed: null }) });
  }
  const untracked = (Array.isArray(raw.untracked) ? raw.untracked : []).filter((f): f is string => typeof f === "string").slice(0, 500);
  const diff = typeof raw.diff === "string" ? raw.diff : "";
  const shown = redact(diff);
  const word = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? v : null);
  return { id, task, path, base: word(raw.base), head: word(raw.head), files, untracked, diff: shown, cut: raw.cut === true, ...(shown !== diff ? { redacted: true } : {}) };
}
