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

/// Read backwards this much at a time.
const CHUNK: u64 = 1 << 20;

/// The last [n] whole lines of [path] that match [grep], read from the end in pieces (a log can
/// be large; a search goes back as far as it has to), and where the whole lines end: a line
/// still being written is left for [read_new] to give once it is.
pub fn tail(path: &Path, n: usize, grep: Option<&str>) -> Result<(Vec<String>, u64), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut read = |from: u64, to: u64| -> Result<Vec<u8>, String> {
        file.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        (&mut file).take(to - from).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    };
    // Where the whole lines end.
    let mut whole = 0;
    let mut end = len;
    while end > 0 {
        let start = end.saturating_sub(CHUNK);
        if let Some(i) = read(start, end)?.iter().rposition(|b| *b == b'\n') {
            whole = start + i as u64 + 1;
            break;
        }
        end = start;
    }
    let mut found = Vec::new();
    // The start of a line whose beginning is further back.
    let mut carry: Vec<u8> = Vec::new();
    let mut pos = whole;
    while pos > 0 && found.len() < n {
        let start = pos.saturating_sub(CHUNK);
        let mut bytes = read(start, pos)?;
        bytes.extend_from_slice(&carry);
        pos = start;
        let cut = if start == 0 {
            0
        } else {
            match bytes.iter().position(|b| *b == b'\n') {
                Some(i) => i + 1,
                None => {
                    carry = bytes;
                    continue;
                }
            }
        };
        carry = bytes[..cut].to_vec();
        let text = String::from_utf8_lossy(&bytes[cut..]);
        for line in text.lines().rev().filter(|l| matches(l, grep)) {
            found.push(line.to_owned());
            if found.len() == n {
                break;
            }
        }
    }
    found.reverse();
    Ok((found, whole))
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
        // A line being written is left until it is whole.
        let (last, at) = tail(&log, 1, None).unwrap();
        assert_eq!((last, at), (vec!["next".to_owned()], end + 5));
        let (new, pos) = read_new(&log, end).unwrap();
        assert_eq!(new, vec!["next"]);
        std::io::Write::write_all(&mut f, b"ial\n").unwrap();
        let (new, pos) = read_new(&log, pos).unwrap();
        assert_eq!(new, vec!["partial"]);
        assert_eq!(read_new(&log, pos).unwrap().0, Vec::<String>::new());
        // Rotated: emptied, then written again.
        std::fs::write(&log, "after\n").unwrap();
        assert_eq!(read_new(&log, pos).unwrap(), (vec!["after".to_owned()], 6));
        // Far back, past many pieces: still found.
        let mut big = String::from("needle first\n");
        while big.len() < 5 * CHUNK as usize {
            big.push_str(&"x".repeat(99));
            big.push('\n');
        }
        std::fs::write(&log, &big).unwrap();
        assert_eq!(tail(&log, 5, Some("needle")).unwrap().0, vec!["needle first"]);
        assert!(tail(&dir.join("none.log"), 3, None).is_err());
        assert!(path("weather", &dir).is_err());
        assert_eq!(path("agent", &dir).unwrap(), dir.join("logs/agent.log"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
