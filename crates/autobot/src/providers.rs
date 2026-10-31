//! Agent providers installed on this machine: Autobot itself, and the external coding CLIs the
//! harness can hand work to. Detection is read-only: versions and paths, never credentials.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Provider {
    pub name: &'static str,
    pub command: &'static str,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub auth: &'static str,
    pub login: Option<&'static str>,
    pub capabilities: Vec<&'static str>,
}

const EXTERNAL: &[(&str, &str, &str)] = &[
    ("codex", "codex", "codex login"),
    ("claude", "claude", "claude auth login"),
    ("opencode", "opencode", ""),
    ("cursor", "cursor-agent", "cursor-agent login"),
    ("hermes", "hermes", ""),
    ("pi", "pi", ""),
];

/// The last detection and when it ran. Starting six CLIs is not free; the panel can ask often.
type Cache = Mutex<Option<(Instant, Vec<Provider>)>>;
static CACHE: LazyLock<Cache> = LazyLock::new(|| Mutex::new(None));

pub fn detect() -> Vec<Provider> {
    let mut cache = CACHE.lock().expect("providers cache");
    if let Some((at, list)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(300)
    {
        return list.clone();
    }
    let list = detect_now();
    *cache = Some((Instant::now(), list.clone()));
    list
}

fn detect_now() -> Vec<Provider> {
    let mut providers = vec![Provider {
        name: "autobot",
        command: "autobot",
        installed: true,
        version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        path: std::env::current_exe().ok().map(|p| p.display().to_string()),
        auth: "gateway",
        login: None,
        capabilities: vec!["coding", "tools", "delegation", "gateway-receipts"],
    }];
    for (name, command, login) in EXTERNAL {
        let path = find_in_path(command);
        let version = path.as_ref().and_then(|_| version(command));
        providers.push(Provider {
            name,
            command,
            installed: path.is_some(),
            version,
            path: path.map(|p| p.display().to_string()),
            auth: "account",
            login: (!login.is_empty()).then_some(*login),
            capabilities: vec!["coding", "non-interactive"],
        });
    }
    providers
}

fn find_in_path(command: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|dir| dir.join(command)).find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file() && path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn version(command: &str) -> Option<String> {
    let output = Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).into_owned()
    } else {
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(120).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autobot_is_always_a_provider() {
        let providers = detect();
        let autobot = providers.iter().find(|p| p.name == "autobot").unwrap();
        assert!(autobot.installed);
        assert_eq!(autobot.auth, "gateway");
    }

    #[test]
    fn a_missing_command_is_not_installed() {
        assert!(find_in_path("definitely-not-a-real-agent-cli-xyz").is_none());
    }
}
