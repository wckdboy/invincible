//! Commands with nobody watching (scheduled tasks, board work, phone recipes) run confined:
//! they can read what the user can, but write only in the working directory and temporary
//! directories. The allowlist says which commands may run; the sandbox bounds what an allowed
//! command can do (an allowlisted `git` cannot rewrite `~/.zshrc`).
//!
//! macOS: `sandbox-exec` with a write-deny profile. Linux: `bwrap` (bubblewrap) with the system
//! read-only and the working directory writable. Where neither is available, a confined
//! command is refused rather than run unconfined.
//!
//! `[agent] sandbox = "unattended"` (default), `"always"` (interactive turns too) or `"off"`.

use std::path::Path;

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Off,
    #[default]
    Unattended,
    Always,
}

/// The command that runs [shell] (`sh -c`) in [workdir], confined to writing there.
pub fn command(shell: &str, workdir: &Path) -> Result<tokio::process::Command, String> {
    let workdir = workdir.canonicalize().map_err(|e| format!("{}: {e}", workdir.display()))?;
    let dir = workdir.to_str().ok_or("the working directory's path is not UTF-8")?;
    if cfg!(target_os = "macos") {
        // The profile quotes the path: refuse anything that could break out of the string.
        if dir.contains(['"', '\\', '\n']) {
            return Err("the working directory's path cannot be sandboxed".to_owned());
        }
        let profile = format!(
            r#"(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "{dir}")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/"))"#
        );
        let mut command = tokio::process::Command::new("/usr/bin/sandbox-exec");
        command.arg("-p").arg(profile).arg("sh").arg("-c").arg(shell);
        return Ok(command);
    }
    if cfg!(target_os = "linux") {
        let bwrap = crate::find_on_path("bwrap")
            .ok_or("unattended commands run sandboxed and bubblewrap (bwrap) is not installed; install it, or set [agent] sandbox = \"off\"")?;
        let mut command = tokio::process::Command::new(bwrap);
        command
            .args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"])
            .args(["--bind", dir, dir, "--chdir", dir, "--die-with-parent", "--new-session"])
            .args(["sh", "-c", shell]);
        return Ok(command);
    }
    Err(format!(
        "no sandbox on {}; set [agent] sandbox = \"off\" to run unattended commands unconfined",
        std::env::consts::OS
    ))
}
