//! Secrets from the terminal: read without echo, and the echo always comes back (ctrl+c
//! included: a shell trap restores it).

/// A line typed after [prompt], not shown; from stdin as it is when stdin is not a terminal.
pub fn read_hidden(prompt: &str) -> Result<String, String> {
    use std::io::{BufRead, IsTerminal, Write};
    let secret = if std::io::stdin().is_terminal() {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg("trap 'stty echo; exit 130' INT TERM; stty -echo; IFS= read -r line; status=$?; stty echo; printf '%s' \"$line\"; exit $status")
            .stdin(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .output()
            .map_err(|e| format!("sh: {e}"))?;
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
