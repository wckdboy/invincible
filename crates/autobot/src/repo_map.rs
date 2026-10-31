//! A compact map of a project for coding sessions: the code files git tracks (or a filtered walk
//! outside git), grouped by directory, with a few top-level symbols from the files that matter
//! most. It is orientation, not an index: the agent still uses `search` and `read_file` for the
//! truth. The map is built once when a coding session starts and kept in the system prompt.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;

/// Most code files inspected for the map.
const MAX_FILES: usize = 1_500;
/// Files bigger than this are not read for symbols.
const MAX_FILE: u64 = 512 * 1024;
/// Symbols shown per file.
const MAX_SYMBOLS: usize = 8;
/// Directories listed in the summary.
const MAX_DIRS: usize = 12;

#[derive(Clone, Debug)]
struct Entry {
    /// Relative to the project root, with `/` separators.
    path: String,
    symbols: Vec<String>,
    /// All symbol-like lines seen, before the display cap: bigger files rank higher.
    weight: usize,
}

/// A map of [root], at most about [budget] bytes: None when there is no code to map.
pub fn render(root: &Path, budget: usize) -> Option<String> {
    let budget = budget.max(512);
    let files = code_files(root);
    if files.is_empty() {
        return None;
    }
    let mut dirs: BTreeMap<String, usize> = BTreeMap::new();
    let mut entries = Vec::new();
    for file in files.iter().take(MAX_FILES) {
        let rel = file.strip_prefix(root).unwrap_or(file).to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        let dir = rel.split_once('/').map_or(".", |(first, _)| first);
        *dirs.entry(if dir == "." { ".".to_owned() } else { format!("{dir}/") }).or_default() += 1;
        if std::fs::metadata(file).map(|m| m.len() > MAX_FILE).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        let (symbols, weight) = symbols(file, &text);
        if symbols.is_empty() {
            continue;
        }
        entries.push(Entry { path: rel, symbols, weight });
    }
    if entries.is_empty() {
        return None;
    }
    entries.sort_by(|a, b| score(b).cmp(&score(a)).then_with(|| a.path.cmp(&b.path)));
    let entries = balanced(entries);

    let name = root.file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty()).unwrap_or("project");
    let mut out = String::new();
    let _ = writeln!(out, "Project map: {name} — {} code files", files.len());
    let mut dirs: Vec<(String, usize)> = dirs.into_iter().collect();
    dirs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let summary: Vec<String> = dirs.iter().take(MAX_DIRS).map(|(dir, n)| format!("{dir} ({n})")).collect();
    let _ = writeln!(out, "Directories: {}", summary.join(", "));
    out.push_str("Key files (path — top-level symbols):\n");
    for entry in entries {
        let line = format!("  {} — {}\n", entry.path, entry.symbols.join(", "));
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(&line);
    }
    (out.lines().count() > 2).then_some(out)
}

/// The code files in [root], from git when it is a repository (tracked and new, never ignored),
/// else from a filtered walk. Relative paths become files under [root].
fn code_files(root: &Path) -> Vec<PathBuf> {
    if root.join(".git").exists()
        && let Ok(out) = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
            .output()
        && out.status.success()
    {
        let mut files: Vec<PathBuf> = String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(|p| root.join(p))
            .filter(|p| is_code(p) && !skipped(p, root))
            .collect();
        files.sort();
        files.dedup();
        if !files.is_empty() {
            return files;
        }
    }
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .require_git(false)
        .build()
        .flatten()
    {
        if entry.file_type().is_some_and(|t| t.is_file()) && is_code(entry.path()) && !skipped(entry.path(), root) {
            files.push(entry.into_path());
            if files.len() >= MAX_FILES {
                break;
            }
        }
    }
    files
}

fn skipped(path: &Path, root: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|part| {
        matches!(
            part.as_os_str().to_str().unwrap_or_default(),
            ".git"
                | "node_modules"
                | "target"
                | "vendor"
                | "dist"
                | "build"
                | ".build"
                | ".next"
                | ".turbo"
                | "Pods"
                | "DerivedData"
                | "out"
                | ".venv"
                | "venv"
                | "__pycache__"
        )
    })
}

fn is_code(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(),
        "rs" | "go"
            | "py"
            | "pyi"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "swift"
            | "kt"
            | "kts"
            | "java"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "lua"
            | "dart"
            | "scala"
            | "ex"
            | "exs"
            | "erl"
            | "hs"
            | "ml"
            | "clj"
            | "sh"
            | "bash"
            | "zsh"
    )
}

fn patterns(path: &Path) -> Option<&'static Vec<Regex>> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "rs" => Some(&RUST),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(&TS),
        "py" | "pyi" => Some(&PY),
        "go" => Some(&GO),
        "swift" => Some(&SWIFT),
        "kt" | "kts" => Some(&KOTLIN),
        "java" | "cs" | "scala" => Some(&JVM),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" => Some(&C),
        "rb" => Some(&RUBY),
        "php" => Some(&PHP),
        "lua" => Some(&LUA),
        "dart" => Some(&DART),
        "ex" | "exs" => Some(&ELIXIR),
        "erl" => Some(&ERLANG),
        "hs" => Some(&HASKELL),
        "ml" => Some(&OCAML),
        "clj" => Some(&CLOJURE),
        "sh" | "bash" | "zsh" => Some(&SHELL),
        _ => None,
    }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid symbol pattern")
}

static RUST: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)"),
        re(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|union)\s+([A-Za-z_][A-Za-z0-9_]*)"),
        re(r"^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_:]*)"),
        re(r"^\s*macro_rules!\s*([A-Za-z_][A-Za-z0-9_]*)"),
    ]
});
static TS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        re(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        re(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
        re(r"^\s*(?:export\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
    ]
});
static PY: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)"), re(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)")]
});
static GO: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)"), re(r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)")]
});
static SWIFT: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(
        r"^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)*(?:func|class|struct|enum|protocol|extension)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )]
});
static KOTLIN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(
        r"^\s*(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|data\s+|sealed\s+|abstract\s+)*(?:fun|class|object|interface|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )]
});
static JVM: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(
        r"^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )]
});
static C: LazyLock<Vec<Regex>> =
    LazyLock::new(|| vec![re(r"^\s*(?:class|struct|enum|namespace|union)\s+([A-Za-z_][A-Za-z0-9_]*)")]);
static RUBY: LazyLock<Vec<Regex>> =
    LazyLock::new(|| vec![re(r"^\s*(?:def|class|module)\s+([A-Za-z_][A-Za-z0-9_!?]*)")]);
static PHP: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(
        r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*(?:function|class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )]
});
static LUA: LazyLock<Vec<Regex>> = LazyLock::new(|| vec![re(r"^\s*(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.]*)")]);
static DART: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(r"^\s*(?:abstract\s+|sealed\s+|base\s+)*(?:class|mixin|enum|extension|typedef)\s+([A-Za-z_][A-Za-z0-9_]*)")]
});
static ELIXIR: LazyLock<Vec<Regex>> =
    LazyLock::new(|| vec![re(r"^\s*(?:def|defp|defmodule|defprotocol|defstruct)\s+([A-Za-z_][A-Za-z0-9_.]*)")]);
static ERLANG: LazyLock<Vec<Regex>> = LazyLock::new(|| vec![re(r"^\s*(?:-module|module)\s*\(?([a-z][A-Za-z0-9_]*)")]);
static HASKELL: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![re(r"^\s*(?:data|newtype|type|class)\s+([A-Z][A-Za-z0-9_]*)"), re(r"^([a-z_][A-Za-z0-9_']*)\s*::")]
});
static OCAML: LazyLock<Vec<Regex>> =
    LazyLock::new(|| vec![re(r"^\s*(?:let|type|module|class)\s+(?:rec\s+)?([A-Za-z_][A-Za-z0-9_']*)")]);
static CLOJURE: LazyLock<Vec<Regex>> =
    LazyLock::new(|| vec![re(r"^\s*\((?:def|defn|defmacro|defprotocol|defrecord|ns)\s+([A-Za-z_][A-Za-z0-9_.-]*)")]);
static SHELL: LazyLock<Vec<Regex>> =
    LazyLock::new(|| vec![re(r"^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{?")]);

fn symbols(path: &Path, text: &str) -> (Vec<String>, usize) {
    let Some(patterns) = patterns(path) else { return (Vec::new(), 0) };
    if patterns.is_empty() {
        return (Vec::new(), 0);
    }
    let mut found = Vec::new();
    let mut weight = 0;
    for line in text.lines() {
        for pattern in patterns {
            if let Some(name) = pattern.captures(line).and_then(|c| c.get(1)) {
                weight += 1;
                let name = name.as_str().trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != ':');
                if found.len() < MAX_SYMBOLS
                    && !name.is_empty()
                    && !matches!(name, "Default" | "default")
                    && !found.iter().any(|s: &String| s == name)
                {
                    found.push(name.to_owned());
                }
                break;
            }
        }
        if weight >= 200 {
            break;
        }
    }
    (found, weight)
}

/// The top files from each crate, app, package or top-level directory, in turn, so one large
/// crate cannot fill the map and hide the others.
fn balanced(entries: Vec<Entry>) -> Vec<Entry> {
    let mut groups: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    for entry in entries {
        groups.entry(group(&entry.path)).or_default().push(entry);
    }
    let keys: Vec<String> = groups.keys().cloned().collect();
    let mut out = Vec::new();
    let mut depth = 0;
    loop {
        let mut took = false;
        for key in &keys {
            if let Some(entry) = groups.get(key).and_then(|group| group.get(depth)) {
                out.push(entry.clone());
                took = true;
            }
        }
        if !took {
            break;
        }
        depth += 1;
    }
    out
}

fn group(path: &str) -> String {
    let mut parts = path.split('/');
    let first = parts.next().unwrap_or(".");
    if matches!(first, "crates" | "apps" | "packages" | "modules")
        && let Some(name) = parts.next()
    {
        return format!("{first}/{name}");
    }
    first.to_owned()
}

/// What makes a file worth the map's few bytes: symbols, then source and entry points.
fn score(entry: &Entry) -> i32 {
    let mut score = (entry.weight.min(30) as i32) * 3 + (entry.symbols.len() as i32) * 5;
    if entry.path.starts_with("src/") || entry.path.contains("/src/") {
        score += 30;
    }
    if matches!(
        entry.path.rsplit('/').next().unwrap_or_default(),
        "server.rs"
            | "main.rs"
            | "lib.rs"
            | "agent.rs"
            | "tools.rs"
            | "config.rs"
            | "gateway.rs"
            | "doctor.rs"
            | "routing.rs"
            | "network.rs"
    ) {
        score += 25;
    }
    if matches!(
        entry.path.rsplit('/').next().unwrap_or_default(),
        "main.rs" | "lib.rs" | "main.go" | "main.py" | "index.ts" | "index.tsx" | "main.swift" | "main.kt"
    ) {
        score += 20;
    }
    if entry.path.contains("/tests/") || entry.path.starts_with("tests/") {
        score -= 10;
    }
    score - entry.path.matches('/').count() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_symbols_and_respects_gitignore() {
        let root = std::env::temp_dir().join(format!("autobot-repo-map-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
        std::fs::write(root.join("src/main.rs"), "pub struct Cli;\npub fn main() {}\n").unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub trait Run { fn run(&self); }\n").unwrap();
        std::fs::write(root.join("ignored.rs"), "fn secret() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "fn not_code() {}\n").unwrap();

        let map = render(&root, 4096).unwrap();
        assert!(map.contains("src/main.rs"), "{map}");
        assert!(map.contains("main"), "{map}");
        assert!(map.contains("Run"), "{map}");
        assert!(!map.contains("ignored.rs"), "{map}");
        assert!(!map.contains("secret"), "{map}");
        assert!(!map.contains("not_code"), "{map}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn maps_this_repository() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let map = render(&root, 4096).expect("a map of Invincible");
        eprintln!("{map}");
        assert!(map.contains("crates/autobot/src/agent.rs"), "{map}");
        assert!(map.contains("crates/invincible/src/server.rs"), "{map}");
        assert!(map.len() <= 4096, "{} bytes", map.len());
    }

    #[test]
    fn knows_code_extensions() {
        assert!(is_code(Path::new("a.rs")));
        assert!(is_code(Path::new("a.tsx")));
        assert!(is_code(Path::new("a.swift")));
        assert!(!is_code(Path::new("a.md")));
        assert!(!is_code(Path::new("a.toml")));
    }

    #[test]
    fn stays_within_the_budget() {
        let root = std::env::temp_dir().join(format!("autobot-repo-budget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        for i in 0..40 {
            std::fs::write(
                root.join(format!("src/file{i}.rs")),
                format!("pub fn function_{i}() {{}}\npub struct Type{i};\n"),
            )
            .unwrap();
        }
        let map = render(&root, 768).unwrap();
        assert!(map.len() <= 768, "{} bytes", map.len());
        let _ = std::fs::remove_dir_all(&root);
    }
}
