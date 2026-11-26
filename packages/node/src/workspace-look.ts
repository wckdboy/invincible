import { ATTACHMENT_LIMITS, pictureType, redact, type TeamChangedFile, type TeamChangesView, type TeamFileEntry, type TeamFilesView, type TeamFileView, textOf } from "@galahad/core";

/*
 * Looking into a knight's workspace (its VM's /work, or Galahad's computer's) from your devices: a folder's entries, one
 * file, and what a task changed in its repository. Read only, and yours alone (the routes are owner-only). Each look is
 * one of these fixed scripts, run in the VM with Python as the VM's own user, its only input the path or the task given
 * as arguments (never in the script's text). What comes back is bounded in the VM, checked here, and a text or a diff
 * has anything that looks like a key redacted before it leaves the node.
 */

/** A file shown whole up to this many bytes (its bytes go base64 through the VM's 1 MB of output). */
export const READ_LIMIT = 700_000;
/** A diff shown up to this many characters. */
export const DIFF_LIMIT = 600_000;
/** A folder's first entries, in order. */
export const LIST_LIMIT = 2_000;
/** Kept from view, whatever is asked: the file that holds the VM's gateway token. */
export const KEPT_FROM_VIEW = ["/work/.galahad-gateway.json"] as const;

/** `python3 -c LIST <path>`: a folder's entries, folders and files each with its size and when it changed. */
export const LIST_SCRIPT = `import json,os,stat,sys
p=sys.argv[1]
try:
    names=sorted(os.listdir(p),key=lambda n:n.lower())
except Exception as e:
    print(json.dumps({"error":type(e).__name__}));sys.exit(0)
out=[]
for n in names[:${LIST_LIMIT}]:
    try:
        s=os.lstat(os.path.join(p,n))
    except Exception:
        continue
    k='link' if stat.S_ISLNK(s.st_mode) else 'dir' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'other'
    out.append({"name":n,"kind":k,"size":s.st_size,"modified":int(s.st_mtime*1000)})
print(json.dumps({"entries":out,"more":len(names)>${LIST_LIMIT}}))`;

/** `python3 -c READ <path>`: one regular file's first READ_LIMIT bytes, base64, with its size and when it changed. */
export const READ_SCRIPT = `import base64,json,os,stat,sys
p=sys.argv[1]
try:
    s=os.stat(p)
except Exception as e:
    print(json.dumps({"error":type(e).__name__}));sys.exit(0)
if not stat.S_ISREG(s.st_mode):
    print(json.dumps({"error":"NotAFile"}));sys.exit(0)
with open(p,'rb') as f:
    b=f.read(${READ_LIMIT}+1)
print(json.dumps({"size":s.st_size,"modified":int(s.st_mtime*1000),"cut":len(b)>${READ_LIMIT},"data":base64.b64encode(b[:${READ_LIMIT}]).decode()}))`;

/**
 * `python3 -c CHANGES <worktree> <kept>`: what a task changed in its worktree (a task's own git worktree, /work/tasks/<id>,
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
