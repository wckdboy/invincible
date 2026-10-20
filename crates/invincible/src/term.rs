//! Secrets from the terminal: read without echo, and the echo always comes back (ctrl+c
//! included: a shell trap restores it).

/// A line typed after [prompt], not shown; from stdin as it is when stdin is not a terminal.
pub fn read_hidden(prompt: &str) -> Result<String, String> {
    use std::io::{BufRead, IsTerminal, Write};
    let secret = if std::io::stdin().is_terminal() {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        #[cfg(not(windows))]
        let mut reader = std::process::Command::new("sh");
        #[cfg(not(windows))]
        reader.arg("-c").arg(
            "trap 'stty echo; exit 130' INT TERM; stty -echo; IFS= read -r line; status=$?; stty echo; printf '%s' \"$line\"; exit $status",
        );
        // The console's own hidden input.
        #[cfg(windows)]
        let mut reader = std::process::Command::new("powershell");
        #[cfg(windows)]
        // (Not -NonInteractive: Read-Host refuses to read then.)
        reader.args([
            "-NoProfile",
            "-Command",
            "$s = Read-Host -AsSecureString; [Console]::Out.Write([Net.NetworkCredential]::new('', $s).Password)",
        ]);
        let out = reader
            .stdin(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .output()
            .map_err(|e| format!("reading the input: {e}"))?;
        eprintln!();
        if out.status.code() == Some(130) {
            return Err("stopped".to_owned());
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map_err(|e| e.to_string())?;
        line
    };
    let secret = secret.trim().to_owned();
    if secret.is_empty() {
        return Err("nothing was entered".to_owned());
    }
    Ok(secret)
}
