//! `autobot backup` and `autobot restore` as the owner runs them, on a home of their own, and
//! `autobot alerts` before anything is set up.

use std::path::{Path, PathBuf};
use std::process::Command;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-backup-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn autobot(home: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_autobot"))
        .args(args)
        .env("AUTOBOT_HOME", home)
        .env("HOME", home.parent().unwrap())
        .env_remove("AUTOBOT_BOT")
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

fn put(home: &Path, rel: &str, text: &str) {
    let path = home.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn back_up_change_restore() {
    let dir = temp("cli");
    let home = dir.join("autobot");
    put(&home, "config.toml", "[agent]\nheartbeat = \"off\"\n");
    put(&home, "SOUL.md", "Be brief.");
    put(&home, "telegram.token", "123:abc");
    put(&home, "sessions/cli.jsonl", "{}\n");
    put(&home, "work/notes.txt", "mine");
    let archive = dir.join("one.tar.gz");
    let out_arg = archive.to_string_lossy().into_owned();

    let (ok, out) = autobot(&home, &["backup", "--out", &out_arg]);
    assert!(ok, "{out}");
    assert!(out.contains("backed up 3 file(s)"), "{out}");
    assert!(out.contains("left out 1 secret(s)") && out.contains("telegram.token"), "{out}");
    assert!(out.contains("work/ (the working directory)"), "{out}");

    // Nothing changed yet.
    let (ok, out) = autobot(&home, &["restore", &out_arg, "--dry-run"]);
    assert!(ok && out.contains("every checksum matches") && out.contains("nothing to do"), "{out}");

    put(&home, "SOUL.md", "Be loud.");
    put(&home, "later.md", "x");
    let (ok, out) = autobot(&home, &["restore", &out_arg, "--dry-run"]);
    assert!(ok, "{out}");
    assert!(out.contains("changed (1):\n  SOUL.md"), "{out}");
    assert!(out.contains("gone after the restore (not in the backup) (1):\n  later.md"), "{out}");
    assert!(out.contains("kept as they are") && out.contains("telegram.token"), "{out}");
    assert!(out.contains("dry run: nothing changed"), "{out}");
    assert_eq!(std::fs::read_to_string(home.join("SOUL.md")).unwrap(), "Be loud.");

    // Not at a terminal, and not --yes: nothing happens.
    let (ok, out) = autobot(&home, &["restore", &out_arg]);
    assert!(!ok && out.contains("--yes"), "{out}");

    let (ok, out) = autobot(&home, &["restore", &out_arg, "--yes"]);
    assert!(ok && out.contains("the home as it was is"), "{out}");
    assert_eq!(std::fs::read_to_string(home.join("SOUL.md")).unwrap(), "Be brief.");
    assert!(!home.join("later.md").exists());
    assert_eq!(std::fs::read_to_string(home.join("telegram.token")).unwrap(), "123:abc");
    assert_eq!(std::fs::read_to_string(home.join("work/notes.txt")).unwrap(), "mine");
    let previous: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().contains("autobot.before-restore-"))
        .collect();
    assert_eq!(previous.len(), 1, "{previous:?}");
    assert_eq!(std::fs::read_to_string(previous[0].join("SOUL.md")).unwrap(), "Be loud.");
    let first = previous[0].clone();

    // A broken configuration is no obstacle: it is what the backup puts right.
    put(&home, "config.toml", "[agent\nthis is not toml");
    let (ok, out) = autobot(&home, &["restore", &out_arg, "--yes"]);
    assert!(ok && out.contains("the home as it was is"), "{out}");
    assert_eq!(std::fs::read_to_string(home.join("config.toml")).unwrap(), "[agent]\nheartbeat = \"off\"\n");
    assert_eq!(std::fs::read_to_string(first.join("SOUL.md")).unwrap(), "Be loud.", "the first one kept");

    // A file that is not a backup is refused before anything changes.
    std::fs::write(&archive, b"nope").unwrap();
    let (ok, out) = autobot(&home, &["restore", &out_arg, "--yes"]);
    assert!(!ok && out.contains("not a whole autobot backup"), "{out}");

    // The agent's log (carried over by the restore: logs are not in backups).
    put(&home, "logs/agent.log", "one INFO\ntwo WARN gateway\nthree INFO\n");
    let (ok, out) = autobot(&home, &["logs", "-n", "2"]);
    assert!(ok && out == "two WARN gateway\nthree INFO\n", "{out}");
    let (ok, out) = autobot(&home, &["logs", "--grep", "warn"]);
    assert!(ok && out == "two WARN gateway\n", "{out}");
    let (ok, out) = autobot(&home, &["logs", "weather"]);
    assert!(!ok && out.contains("agent, gateway, update"), "{out}");

    // Alerts, set up nowhere yet.
    let (ok, out) = autobot(&home, &["alerts"]);
    assert!(ok && out.contains("nowhere yet") && out.contains("no alerts yet"), "{out}");
    put(&home, "config.toml", "[alerts]\nquiet_hours = \"late\"\n");
    let (ok, out) = autobot(&home, &["alerts"]);
    assert!(ok && out.contains("quiet_hours"), "{out}");
    std::fs::remove_dir_all(dir).unwrap();
}
