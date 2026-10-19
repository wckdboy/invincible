//! The `search` and `find_files` tools: ripgrep's walker (`.gitignore`, `.ignore` and hidden
//! files respected), so the agent finds code without a shell command to approve.

use std::fmt::Write as _;
use std::io::BufRead;
use std::path::Path;

/// Most matches `search` hands back.
const MAX_MATCHES: usize = 200;
/// Most paths `find_files` hands back.
const MAX_FILES: usize = 500;
/// Files bigger than this are not searched.
const MAX_FILE: u64 = 2 * 1024 * 1024;

fn walker(path: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(path).hidden(true).git_ignore(true).git_global(false).require_git(false).build()
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).display().to_string()
}

/// Lines matching [pattern] in the files under [path] (or [path] itself), `path:line: text`.
pub fn grep(root: &Path, path: &Path, pattern: &str, glob: Option<&str>, ignore_case: bool) -> Result<String, String> {
    let regex = regex::RegexBuilder::new(pattern)
        .case_insensitive(ignore_case)
        .build()
        .map_err(|e| format!("the pattern: {e}"))?;
    let glob = glob.map(matcher).transpose()?;
    let mut out = String::new();
    let mut found = 0;
    let mut files = 0;
    for entry in walker(path).flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let file = entry.path();
        let name = relative(root, file);
        if let Some(glob) = &glob
            && !glob.is_match(&name)
            && !file.file_name().is_some_and(|n| glob.is_match(n))
        {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE).unwrap_or(true) {
            continue;
        }
        let Ok(handle) = std::fs::File::open(file) else { continue };
        let mut reader = std::io::BufReader::new(handle);
        if reader.fill_buf().map(|b| b.iter().take(8192).any(|c| *c == 0)).unwrap_or(true) {
            continue;
        }
        let mut hit = false;
        for (n, line) in reader.lines().enumerate() {
            let Ok(line) = line else { break };
            if !regex.is_match(&line) {
                continue;
            }
            hit = true;
            found += 1;
            if found <= MAX_MATCHES {
                let text: String = line.trim_end().chars().take(300).collect();
                let _ = writeln!(out, "{name}:{}: {text}", n + 1);
            }
        }
        files += usize::from(hit);
    }
    Ok(match found {
        0 => format!("no matches for {pattern:?}"),
        n if n > MAX_MATCHES => {
            format!("{out}[… {} more matches in {files} files; narrow the search …]", n - MAX_MATCHES)
        }
        _ => out,
    })
}

fn matcher(glob: &str) -> Result<globset::GlobMatcher, String> {
    globset::GlobBuilder::new(glob)
        .literal_separator(false)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|e| format!("the glob: {e}"))
}

/// Files under [path] whose path (relative to [root]) matches [pattern].
pub fn find(root: &Path, path: &Path, pattern: &str) -> Result<String, String> {
    let glob = matcher(pattern.trim_start_matches("./"))?;
    let mut names = Vec::new();
    for entry in walker(path).flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let name = relative(root, entry.path());
        if glob.is_match(&name)
            || (!pattern.contains('/') && entry.path().file_name().is_some_and(|n| glob.is_match(n)))
        {
            names.push(name);
        }
    }
    names.sort();
    let total = names.len();
    names.truncate(MAX_FILES);
    Ok(match total {
        0 => format!("no files match {pattern:?}"),
        n if n > MAX_FILES => format!("{}\n[… {} more …]", names.join("\n"), n - MAX_FILES),
        _ => names.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::{find, grep};

    #[test]
    fn searches_respect_gitignore_and_globs() {
        let dir = std::env::temp_dir().join(format!("autobot-grep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {\n    run();\n}\n").unwrap();
        std::fs::write(dir.join("src/deep/lib.rs"), "pub fn run() {}\n").unwrap();
        std::fs::write(dir.join("target/out.rs"), "fn run() {}\n").unwrap();
        std::fs::write(dir.join("notes.md"), "run the tests\n").unwrap();
        std::fs::write(dir.join("blob.bin"), b"run\0\0").unwrap();

        let hits = grep(&dir, &dir, r"\brun\(", None, false).unwrap();
        assert!(hits.contains("src/main.rs:2:     run();"), "{hits}");
        assert!(hits.contains("src/deep/lib.rs:1: pub fn run() {}"), "{hits}");
        assert!(!hits.contains("target/"), "ignored by .gitignore");
        let rs = grep(&dir, &dir, "run", Some("*.rs"), false).unwrap();
        assert!(!rs.contains("notes.md") && !rs.contains("blob.bin"));
        assert!(grep(&dir, &dir, "RUN THE", None, true).unwrap().contains("notes.md:1"));
        assert!(grep(&dir, &dir, "nothing-here", None, false).unwrap().starts_with("no matches"));
        assert!(grep(&dir, &dir, "(", None, false).is_err());

        assert_eq!(find(&dir, &dir, "**/*.rs").unwrap(), "src/deep/lib.rs\nsrc/main.rs");
        assert_eq!(find(&dir, &dir, "lib.rs").unwrap(), "src/deep/lib.rs");
        assert_eq!(find(&dir, &dir, "src/*.rs").unwrap(), "src/deep/lib.rs\nsrc/main.rs");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
