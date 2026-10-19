//! Unified diffs of what the agent changes: shown before a write is approved, and after.

/// Most lines of a diff shown.
const MAX_LINES: usize = 400;

/// [before] → [after] as a unified diff of [label], 3 lines of context; empty when equal.
pub fn unified(before: &str, after: &str, label: &str) -> String {
    if before == after {
        return String::new();
    }
    let diff = similar::TextDiff::from_lines(before, after);
    let mut text =
        diff.unified_diff().context_radius(3).header(&format!("a/{label}"), &format!("b/{label}")).to_string();
    let lines = text.lines().count();
    if lines > MAX_LINES {
        let keep: Vec<&str> = text.lines().take(MAX_LINES).collect();
        text = format!("{}\n[… {} more lines …]\n", keep.join("\n"), lines - MAX_LINES);
    }
    text
}

/// Lines added and removed in a unified diff.
pub fn counts(diff: &str) -> (usize, usize) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

#[cfg(test)]
mod tests {
    use super::{counts, unified};

    #[test]
    fn a_change_is_a_unified_diff() {
        let diff = unified("a\nb\nc\n", "a\nB\nc\nd\n", "x.txt");
        assert!(diff.starts_with("--- a/x.txt\n+++ b/x.txt\n@@"), "{diff}");
        assert!(diff.contains("-b\n+B\n"));
        assert_eq!(counts(&diff), (2, 1));
        assert_eq!(unified("same", "same", "x"), "");
        // A new file is all additions.
        assert_eq!(counts(&unified("", "one\ntwo\n", "new.txt")), (2, 0));
    }
}
