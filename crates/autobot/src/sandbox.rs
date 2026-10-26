//! Commands with nobody watching (scheduled tasks, board work, phone recipes, hooks, Home
//! Assistant's voice requests, the heartbeat, `autobot run`) run write-confined: a command's own
//! writes go only to the working directory and temporary directories. Reads, the network and the
//! programs it can talk to are not restricted yet: it can read what the user can, reach any host,
//! and have a program outside the sandbox write for it (`systemd-run --user`, `launchctl`, D-Bus,
//! Docker's socket, the node's and agent's local APIs, any socket). The allowlist says which
//! commands may run; the sandbox bounds what an allowed command can write itself (an allowlisted
//! `git` cannot rewrite `~/.zshrc`).
//!
//! The working directory is writable and shared with interactive turns, which are unconfined
//! unless the sandbox is `"always"`: a confined command can leave files there that a later
//! interactive turn in that directory runs unconfined (`core.hooksPath` or `core.fsmonitor` in
//! `.git/config`, a `Makefile`, `node_modules/.bin`, an `.envrc` once the owner runs
//! `direnv allow`). The approval rules hold back the agent's own writes under dot names (they
//! ask, and with nobody to ask they are refused; `trust` runs them); they do not see what a
//! command writes.
//!
//! macOS: `sandbox-exec` with a write-deny profile. Linux: `bwrap` (bubblewrap) with the system
//! read-only and the working directory writable. Where neither is available, a confined
//! command is refused rather than run unconfined.
//!
//! `[agent] sandbox = "unattended"` (default), `"always"` (interactive turns too) or `"off"`;
//! `autobot run --no-sandbox` turns it off for one run. The action log records which ([name]).

use std::path::Path;

use serde::Deserialize;

/// What confines commands on this machine, as the action log names it: `sandbox-exec` (macOS),
/// `bwrap` (Linux), `none` elsewhere (where a confined command is refused).
pub fn name() -> &'static str {
    if cfg!(target_os = "macos") {
        "sandbox-exec"
    } else if cfg!(target_os = "linux") {
        "bwrap"
    } else {
        "none"
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Off,
    #[default]
    Unattended,
    Always,
}

/// The command that runs [shell] (`sh -c`) in [workdir], its own writes confined there.
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
            .ok_or("unattended commands run write-confined and bubblewrap (bwrap) is not installed: install the bubblewrap package (apt install bubblewrap, dnf install bubblewrap, apk add bubblewrap), or set [agent] sandbox = \"off\"")?;
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
