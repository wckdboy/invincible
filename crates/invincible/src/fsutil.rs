//! Files only the user can read (mode 0600): tokens, keys, the device list.

use std::io::Write;
use std::path::Path;

fn options() -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
}

/// Creates [path] with [contents]; fails if it already exists (never overwrites a secret).
pub fn create_private(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let mut file = options().create_new(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(contents.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

/// Replaces [path] with [contents] atomically (a reader sees the old file or the new one).
pub fn replace_private(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // A name of its own: two writers at once must not share (and clobber) one temporary file.
    let suffix = crate::token::hex(&crate::token::random::<6>()?);
    let tmp = path.with_extension(format!("{suffix}.tmp"));
    let mut file = options().create_new(true).open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    file.write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Reads [path], or `None` when it does not exist.
pub fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}
