import { HELD_GIT } from "@invincible/agents";
import { ATTACHMENT_LIMITS, pictureType, redact, type TeamChangedFile, type TeamChangesView, type TeamFileEntry, type TeamFilesView, type TeamFileView, textOf } from "@invincible/core";
import { WALK } from "@invincible/sandbox";

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

/** The sandbox's walk (sandbox's walk.ts), with what the view keeps from view whatever leads to it (KEPT_FROM_VIEW). */
const LOOK = `${WALK}KEPT=${JSON.stringify(KEPT_FROM_VIEW.map((path) => path.slice("/work/".length)))}
`;

/** `python3 -I -c LIST <path>`: a folder's entries, folders and files each with its size and when it changed, a link as a link. */
export const LIST_SCRIPT = `${LOOK}p=sys.argv[1]
root=sys.argv[2] if len(sys.argv)>2 else '/work'
try:
    held,_=walk(p,'dir')
    names=sorted(os.listdir(held[-1]),key=lambda n:n.lower())
except Refused as r:
    out(error=r.args[0])
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
export const READ_SCRIPT = `${LOOK}p=sys.argv[1]
root=sys.argv[2] if len(sys.argv)>2 else '/work'
try:
    held,names=walk(p,'file')
    s=os.fstat(held[-1])
except Refused as r:
    out(error=r.args[0])
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
 * none, from HEAD; the files and the diff (bounded), and the files git doesn't track yet. Held to /work as a file's look
 * is (27 November 2026): the worktree is the folder the walk opened, and git runs in it (fchdir), its git dir (and a
 * worktree's common one) within /work too; and as the node's held git (agents' held-git.ts, one held git everywhere): no
 * system or global configuration, no textconv, no fsmonitor, no hooks (husky's hooks path held off, not refused), and
 * no filter run (Git LFS's among them: its files are compared as they are). A repository whose configuration names
 * another worktree or includes a configuration from anywhere is refused, as either would have git read outside /work.
 * The commit it started at is a commit's name, or none.
 */
export const CHANGES_SCRIPT = `${LOOK}${HELD_GIT}work,kept=sys.argv[1],sys.argv[2]
root=sys.argv[3] if len(sys.argv)>3 else '/work'
def held_to_work(path,want):
    try:
        return walk(path,want)
    except Refused as r:
        out(error=r.args[0])
try:
    held,names=walk(work,'dir')
except Refused as r:
    out(error=r.args[0])
except OSError as e:
    out(error=type(e).__name__)
here=at(names)
# Its git dir: its own .git folder, or the one a .git file names; a worktree's common git dir, as its commondir says.
try:
    g,gnames=held_to_work(here+'/.git','file')
    gs=os.fstat(g[-1])
except OSError:
    out(error='NotARepository')
if stat.S_ISDIR(gs.st_mode):
    gitdir=at(gnames)
elif stat.S_ISREG(gs.st_mode):
    line=os.read(g[-1],4096).decode(errors='replace').strip()
    if not line.startswith('gitdir: '):
        out(error='NotARepository')
    pointed=line[8:].strip()
    try:
        _,dnames=held_to_work(pointed if pointed.startswith('/') else here+'/'+pointed,'dir')
    except OSError:
        out(error='NotARepository')
    gitdir=at(dnames)
else:
    out(error='NotARepository')
try:
    c,_=held_to_work(gitdir+'/commondir','file')
    common=os.read(c[-1],4096).decode(errors='replace').strip()
except OSError:
    common=''
if common:
    try:
        held_to_work(common if common.startswith('/') else gitdir+'/'+common,'dir')
    except OSError:
        out(error='NotARepository')
os.fchdir(held[-1])
# The node's held git (HELD_GIT), in the git dir and worktree the walk held, writing nothing (no optional lock), with no
# HOME of the VM's for a path in its configuration to start from.
look={'GIT_DIR':gitdir,'GIT_WORK_TREE':'.','GIT_OPTIONAL_LOCKS':'0','HOME':'/nonexistent'}
if subprocess.run(['git','config','--list','-z','--name-only'],capture_output=True,timeout=60,env={**GIT_ENV,**look}).returncode!=0:
    out(error='NotARepository')
# Another worktree, or a configuration it includes from anywhere, would have git read outside /work: refused. A hooks path,
# a filter (Git LFS's among them) and the rest are held off.
if refused('.',look) or named('.',r'(include\\.|includeif\\.)',look):
    out(error='RepositoryConfig')
look_git=lambda *a: git('.',*a,env=look)
base=None
if kept:
    try:
        k,_=walk(kept,'file')
        words=os.read(k[-1],4096).decode(errors='replace').split()
        base=words[0] if words and re.fullmatch(r'[0-9a-f]{40}',words[0]) else None
    except (Refused,OSError):
        base=None
since=base or 'HEAD'
head=look_git('rev-parse','HEAD').stdout.decode().strip() or None
numstat=look_git('diff','--no-textconv','--no-ext-diff','--numstat','--no-renames',since).stdout.decode(errors='replace')
names=look_git('diff','--no-textconv','--no-ext-diff','--name-status','--no-renames',since).stdout.decode(errors='replace')
untracked=look_git('ls-files','--others','--exclude-standard').stdout.decode(errors='replace').splitlines()
diff=look_git('diff','--no-color','--no-textconv','--no-ext-diff','--no-renames',since).stdout
out(base=base,head=head,numstat=numstat,names=names,untracked=untracked[:500],diff=diff[:${DIFF_LIMIT}].decode(errors='replace'),cut=len(diff)>${DIFF_LIMIT})`;

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
      KeptHome: ["kept from view: in this VM its HOME is its workspace, and that is what its tools keep for themselves", 403],
      RepositoryConfig: ["kept from view: its repository's own configuration would have git look elsewhere or run something", 403],
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
