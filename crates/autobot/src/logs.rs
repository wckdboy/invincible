//! `autobot logs`: the services' logs, the last lines or as they come.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The logs there are: the agent's (`autobot serve`), the gateway's, the daily update's.
pub const WHICH: &[&str] = &["agent", "gateway", "update"];

/// Where [which]'s log is, for the autobot home [root].
pub fn path(which: &str, root: &Path) -> Result<PathBuf, String> {
    match which {
        "agent" => Ok(root.join("logs/agent.log")),
        "gateway" => Ok(invincible::config::home()?.join("logs/gateway.log")),
        "update" => Ok(invincible::config::home()?.join("logs/update.log")),
        other => Err(format!("no {other:?} log: {}", WHICH.join(", "))),
    }
}

/// Whether [line] matches [grep] (case does not matter; no filter: every line).
pub fn matches(line: &str, grep: Option<&str>) -> bool {
    grep.is_none_or(|g| line.to_lowercase().contains(&g.to_lowercase()))
}

/// The last [n] lines of [path] that match [grep], read from the end (a log can be large), and
/// where the file ends.
pub fn tail(path: &Path, n: usize, grep: Option<&str>) -> Result<(Vec<String>, u64), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut chunk = 64 * 1024u64;
    loop {
        let start = len.saturating_sub(chunk);
        file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.by_ref().take(len - start).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        let mut lines: Vec<&str> = text.lines().collect();
        // A line cut by the chunk's start is not whole.
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        let found: Vec<String> = lines.iter().filter(|l| matches(l, grep)).map(|l| (*l).to_owned()).collect();
        if found.len() >= n || start == 0 || chunk >= 64 << 20 {
            let skip = found.len().saturating_sub(n);
            return Ok((found.into_iter().skip(skip).collect(), len));
        }
        chunk *= 4;
    }
}

/// What [path] has gained since [pos]: whole lines, and where to read on from. A file that
/// shrank was rotated (the watchdog empties a log over its cap): read from its start.
pub fn read_new(path: &Path, pos: u64) -> Result<(Vec<String>, u64), String> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let pos = if len < pos { 0 } else { pos };
    if len == pos {
        return Ok((Vec::new(), pos));
    }
    file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(len - pos).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Only up to the last newline: the rest is a line still being written.
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else { return Ok((Vec::new(), pos)) };
    let text = String::from_utf8_lossy(&bytes[..end]);
    Ok((text.lines().map(str::to_owned).collect(), pos + end as u64 + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_follow_and_rotation() {
        let dir = std::env::temp_dir().join(format!("autobot-logs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("agent.log");
        let mut text = String::new();
        for i in 0..20000 {
            text.push_str(&format!("{i} {}\n", if i % 1000 == 0 { "WARN gateway" } else { "INFO fine" }));
        }
        std::fs::write(&log, &text).unwrap();
        let (last, end) = tail(&log, 3, None).unwrap();
        assert_eq!(last, vec!["19997 INFO fine", "19998 INFO fine", "19999 INFO fine"]);
        assert_eq!(end, text.len() as u64);
        // Matches from far back: read further back for them.
        let (warns, _) = tail(&log, 25, Some("warn")).unwrap();
        assert_eq!(warns.len(), 20);
        assert_eq!(warns[0], "0 WARN gateway");

        let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        std::io::Write::write_all(&mut f, b"next\npart").unwrap();
        let (new, pos) = read_new(&log, end).unwrap();
        assert_eq!(new, vec!["next"]);
        std::io::Write::write_all(&mut f, b"ial\n").unwrap();
        let (new, pos) = read_new(&log, pos).unwrap();
        assert_eq!(new, vec!["partial"]);
        assert_eq!(read_new(&log, pos).unwrap().0, Vec::<String>::new());
        // Rotated: emptied, then written again.
        std::fs::write(&log, "after\n").unwrap();
        assert_eq!(read_new(&log, pos).unwrap(), (vec!["after".to_owned()], 6));
        assert!(tail(&dir.join("none.log"), 3, None).is_err());
        assert!(path("weather", &dir).is_err());
        assert_eq!(path("agent", &dir).unwrap(), dir.join("logs/agent.log"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
