//! Secret files in a bot's home: the names, sizes and times, never the values.
//!
//! Channels read their own files (`telegram.token`, `email.password`, …) with mode 0600. This
//! module only lists and removes them for the panel; setting one stays in `POST /v1/agent/secrets`.

use std::path::{Path, PathBuf};

use serde::Serialize;

const SUFFIXES: &[&str] = &[".token", ".secret", ".password", ".key"];

#[derive(Clone, Debug, Serialize)]
pub struct SecretFile {
    pub name: String,
    pub bytes: u64,
    pub updated_at: u64,
    pub kind: &'static str,
}

pub fn list(home: &Path) -> Result<Vec<SecretFile>, String> {
    let mut files = Vec::new();
    let entries = std::fs::read_dir(home).map_err(|e| format!("{}: {e}", home.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !allowed(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        files.push(SecretFile {
            kind: kind(&name),
            name,
            bytes: meta.len(),
            updated_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs()),
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

pub fn remove(home: &Path, name: &str) -> Result<bool, String> {
    if !allowed(name) || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("not a secret file name in the bot's home".to_owned());
    }
    let path: PathBuf = home.join(name);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn allowed(name: &str) -> bool {
    SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

fn kind(name: &str) -> &'static str {
    match name {
        "telegram.token"
        | "discord.token"
        | "slack-app.token"
        | "slack-bot.token"
        | "matrix.token"
        | "email.password"
        | "whatsapp.token"
        | "whatsapp-app.secret"
        | "whatsapp-verify.token" => "connector",
        _ => "secret",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "autobot-secrets-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn secret_files_are_listed_without_values() {
        let dir = dir();
        std::fs::write(dir.join("telegram.token"), "123:secret\n").unwrap();
        std::fs::write(dir.join("custom.secret"), "hunter2\n").unwrap();
        std::fs::write(dir.join("config.toml"), "[agent]\n").unwrap();
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        let files = list(&dir).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.name == "telegram.token" && f.kind == "connector"));
        assert!(files.iter().any(|f| f.name == "custom.secret" && f.kind == "secret"));
        assert!(remove(&dir, "custom.secret").unwrap());
        assert!(!remove(&dir, "custom.secret").unwrap());
        assert!(remove(&dir, "../outside").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
