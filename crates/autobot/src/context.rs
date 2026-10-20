//! The project's instructions for agents: the context files.
//!
//! In each directory, `AGENTS.md`, `CLAUDE.md`, `.hermes.md` and `HERMES.md` (Hermes Agent's),
//! and `.autobot/AGENTS.md`, in that order; `.cursorrules` only where there is none of those. A
//! text that is the same as one already taken (a `CLAUDE.md` that copies `AGENTS.md`) is taken
//! once.
//!
//! - **At the start**: the working directory's, and when it is inside a git repository, those of
//!   the directories from the repository's root down to it, root first,
//!   so the most specific comes last. At most 24 KiB in all, in the system prompt.
//! - **On the way**: when a file tool first reaches a subdirectory that has its own (a nested
//!   `AGENTS.md` in a monorepo's package), its text goes with that tool's result, once per
//!   conversation, at most 16 KiB.
//!
//! `/context` lists the files in play.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

/// The names looked for in a directory, in order.
pub const NAMES: &[&str] = &["AGENTS.md", "CLAUDE.md", ".hermes.md", "HERMES.md", ".autobot/AGENTS.md"];
/// Taken only where none of [NAMES] is.
const FALLBACK: &str = ".cursorrules";
/// The start's files, in all.
const STARTUP: usize = 24 * 1024;
/// One nested file, at most.
const NESTED: usize = 16 * 1024;

/// One context file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct File {
    pub path: PathBuf,
    /// Its path for people: relative to the working directory (`../AGENTS.md`, `pkg/AGENTS.md`).
    pub shown: String,
    pub text: String,
}

fn shown(workdir: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(workdir) {
        return rel.display().to_string();
    }
    // Above it: as many `../` as it takes.
    let mut up = PathBuf::new();
    let mut base = workdir;
    while let Some(parent) = base.parent() {
        up.push("..");
        if let Ok(rel) = path.strip_prefix(parent) {
            return up.join(rel).display().to_string();
        }
        base = parent;
    }
    path.display().to_string()
}

/// The files of [dir], in order, skipping texts already in [seen] (hashes).
fn in_dir(dir: &Path, workdir: &Path, seen: &mut HashSet<[u8; 32]>) -> Vec<File> {
    let read = |name: &str| -> Option<(PathBuf, String)> {
        let path = dir.join(name);
        let text = std::fs::read_to_string(&path).ok()?;
        let text = text.trim().to_owned();
        (!text.is_empty()).then_some((path, text))
    };
    let mut found: Vec<(PathBuf, String)> = NAMES.iter().filter_map(|n| read(n)).collect();
    if found.is_empty() {
        found.extend(read(FALLBACK));
    }
    found
        .into_iter()
        .filter(|(_, text)| seen.insert(Sha256::digest(text.as_bytes()).into()))
        .map(|(path, text)| File { shown: shown(workdir, &path), path, text })
        .collect()
}

/// The git repository's root above (or at) [dir].
fn repo_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| d.join(".git").exists()).map(Path::to_owned)
}

/// The files for working in [workdir]: from its repository's root down to it.
pub fn project(workdir: &Path) -> Vec<File> {
    let mut dirs: Vec<&Path> = match repo_root(workdir) {
        Some(root) => workdir.ancestors().take_while(|d| d.starts_with(&root)).collect(),
        None => vec![workdir],
    };
    dirs.reverse();
    let mut seen = HashSet::new();
    dirs.into_iter().flat_map(|d| in_dir(d, workdir, &mut seen)).collect()
}

/// The start's files as the system prompt takes them, `--- name ---` before each, at most
/// [STARTUP] in all.
pub fn prompt(files: &[File]) -> Option<String> {
    let mut out = String::new();
    for file in files {
        if out.len() >= STARTUP {
            break;
        }
        let room = STARTUP - out.len();
        out.push_str(&format!("--- {} ---\n{}\n", file.shown, cut(&file.text, room)));
    }
    (!out.is_empty()).then_some(out)
}

fn cut(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Nested files given in each conversation so far: (conversation → paths).
static GIVEN: Mutex<Option<HashMap<String, Vec<PathBuf>>>> = Mutex::new(None);

/// A conversation that starts over has had none.
pub fn forget(session: &str) {
    if let Some(map) = GIVEN.lock().expect("context").as_mut() {
        map.remove(session);
    }
}

/// The nested files taken in [session] so far.
pub fn given(session: &str) -> Vec<PathBuf> {
    GIVEN.lock().expect("context").as_ref().and_then(|m| m.get(session).cloned()).unwrap_or_default()
}

/// The files of the directories between [workdir] (not included) and [path] (or its directory)
/// that [session] has not had yet; they are then counted as given.
pub fn nested(workdir: &Path, path: &Path, session: &str) -> Vec<File> {
    let Ok(rel) = path.strip_prefix(workdir) else { return Vec::new() };
    let dir = if path.is_dir() { rel } else { rel.parent().unwrap_or(Path::new("")) };
    // Not into what is ignored anyway.
    if dir.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target" | "vendor" | "dist" | "build")
    }) {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    let mut at = workdir.to_owned();
    for part in dir.components() {
        at.push(part);
        candidates.push(at.clone());
    }
    if candidates.is_empty() {
        return Vec::new();
    }
    // What the start took counts as seen, so a copy of it is not given again.
    let mut seen: HashSet<[u8; 32]> =
        project(workdir).iter().map(|f| Sha256::digest(f.text.as_bytes()).into()).collect();
    let mut guard = GIVEN.lock().expect("context");
    let given = guard.get_or_insert_with(HashMap::new).entry(session.to_owned()).or_default();
    let mut out = Vec::new();
    for dir in candidates {
        for file in in_dir(&dir, workdir, &mut seen) {
            if given.contains(&file.path) {
                continue;
            }
            given.push(file.path.clone());
            out.push(file);
        }
    }
    out
}

/// [files] as they go with a tool's result.
pub fn hint(files: &[File]) -> String {
    let mut out = String::new();
    for file in files {
        let dir = Path::new(&file.shown).parent().map(|d| d.display().to_string()).unwrap_or_default();
        let dir = dir.trim_end_matches(".autobot").trim_end_matches('/');
        out.push_str(&format!(
            "\n\n[The project's instructions for {dir}/, from {} (follow them when working there):]\n{}",
            file.shown,
            cut(&file.text, NESTED)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("autobot-context-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pkg/api/src")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn the_start_takes_the_repository_root_down_to_the_working_directory() {
        let root = tree("start");
        std::fs::write(root.join("AGENTS.md"), "Root rules.").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "Root rules.").unwrap();
        std::fs::write(root.join("pkg/HERMES.md"), "Package rules.").unwrap();
        std::fs::write(root.join("pkg/.cursorrules"), "not taken: there is a HERMES.md").unwrap();
        let files = project(&root.join("pkg"));
        let names: Vec<&str> = files.iter().map(|f| f.shown.as_str()).collect();
        assert_eq!(names, ["../AGENTS.md", "HERMES.md"], "the copy once, root first");
        let prompt = prompt(&files).unwrap();
        assert!(prompt.starts_with("--- ../AGENTS.md ---\nRoot rules.\n--- HERMES.md ---"));
        // Outside a repository: the directory alone; .cursorrules when it has nothing else.
        std::fs::remove_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("pkg/api/.cursorrules"), "Cursor rules.").unwrap();
        let alone = project(&root.join("pkg/api"));
        assert_eq!(alone.iter().map(|f| f.shown.as_str()).collect::<Vec<_>>(), [".cursorrules"]);
        assert!(project(&root.join("pkg/api/src")).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_files_come_once_when_a_tool_reaches_their_directory() {
        let root = tree("nested");
        std::fs::write(root.join("AGENTS.md"), "Root rules.").unwrap();
        std::fs::write(root.join("pkg/AGENTS.md"), "Root rules.").unwrap();
        std::fs::write(root.join("pkg/api/AGENTS.md"), "API rules: run make check.").unwrap();
        std::fs::write(root.join("pkg/api/src/main.rs"), "fn main() {}").unwrap();
        let file = root.join("pkg/api/src/main.rs");
        let first = nested(&root, &file, "s1");
        assert_eq!(first.len(), 1, "pkg/AGENTS.md copies the root's: {first:?}");
        assert_eq!(first[0].shown, "pkg/api/AGENTS.md");
        assert!(hint(&first).contains("instructions for pkg/api/, from pkg/api/AGENTS.md"));
        assert!(nested(&root, &file, "s1").is_empty(), "once per conversation");
        assert_eq!(nested(&root, &root.join("pkg/api"), "s2").len(), 1, "another conversation");
        assert_eq!(given("s1"), [root.join("pkg/api/AGENTS.md")]);
        assert!(nested(&root, &root.join("AGENTS.md"), "s3").is_empty(), "the root is the start's");
        assert!(nested(&root, Path::new("/etc/hosts"), "s3").is_empty());
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/AGENTS.md"), "no").unwrap();
        assert!(nested(&root, &root.join("node_modules/x/index.js"), "s3").is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
