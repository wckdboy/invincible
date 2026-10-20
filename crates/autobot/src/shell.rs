//! The shell commands run in on this machine: `sh -c` on Unix; on Windows PowerShell (`pwsh`
//! when it is installed, Windows PowerShell otherwise), which is what models write for Windows.
//! Commands in a container, over SSH or in the sandbox run in `sh` there, not through this.

/// The shell's name, for the tool description and the system prompt.
pub fn name() -> &'static str {
    if cfg!(windows) { "PowerShell" } else { "sh" }
}

/// What runs [command] here, through [name]'s shell.
pub fn command(command: &str) -> tokio::process::Command {
    let mut child = tokio::process::Command::new(program());
    // Plain text for the model: no colors from pwsh.
    #[cfg(windows)]
    child.env("NO_COLOR", "1").args(["-NoProfile", "-NonInteractive", "-Command"]);
    #[cfg(not(windows))]
    child.arg("-c");
    child.arg(command);
    child
}

/// [command] as a blocking process (eval checks, which run outside the runtime's tasks).
pub fn std_command(command: &str) -> std::process::Command {
    let mut child = std::process::Command::new(program());
    #[cfg(windows)]
    child.env("NO_COLOR", "1").args(["-NoProfile", "-NonInteractive", "-Command"]);
    #[cfg(not(windows))]
    child.arg("-c");
    child.arg(command);
    child
}

/// The program and the arguments before the command (an editor's terminal starts it so).
pub fn argv(command: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    let before = ["-NoProfile", "-NonInteractive", "-Command"];
    #[cfg(not(windows))]
    let before = ["-c"];
    let mut args: Vec<String> = before.iter().map(|a| (*a).to_owned()).collect();
    args.push(command.to_owned());
    (program().to_owned(), args)
}

fn program() -> &'static str {
    #[cfg(windows)]
    {
        static FOUND: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
        FOUND.get_or_init(|| if crate::find_on_path("pwsh").is_some() { "pwsh" } else { "powershell" })
    }
    #[cfg(not(windows))]
    {
        "sh"
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn runs_a_command_and_says_how_it_ended() {
        let out = super::command("echo hello").output().await.unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello"));
        assert!(out.status.success());
        let failed = super::command("exit 3").output().await.unwrap();
        assert_eq!(failed.status.code(), Some(3));
        let (program, args) = super::argv("echo hi");
        assert!(!program.is_empty() && args.last().map(String::as_str) == Some("echo hi"));
    }
}
