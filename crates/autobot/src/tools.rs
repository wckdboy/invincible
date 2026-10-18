//! The agent's tools. Each call is first described as an [Action] when it needs approval, then
//! run; results go back to the model as text, cut to a size a small local model can take.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::approval::Action;

/// Most text one result hands back to the model.
pub const RESULT_LIMIT: usize = 16 * 1024;

pub struct Tools {
    workdir: PathBuf,
    timeout: Duration,
}

/// One tool call, parsed.
#[derive(Debug, PartialEq, Eq)]
pub enum Call {
    Terminal { command: String },
    ReadFile { path: PathBuf },
    WriteFile { path: PathBuf, content: String },
    ListDir { path: PathBuf },
}

impl Tools {
    pub fn new(workdir: PathBuf, timeout: Duration) -> Self {
        Self { workdir, timeout }
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    /// The tools in the OpenAI `tools` shape.
    pub fn definitions() -> Value {
        let function = |name: &str, description: &str, properties: Value, required: &[&str]| {
            json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": { "type": "object", "properties": properties, "required": required },
                },
            })
        };
        json!([
            function(
                "terminal",
                "Run a shell command (sh -c) in the working directory and return its output and exit code.",
                json!({ "command": { "type": "string", "description": "The command line." } }),
                &["command"],
            ),
            function(
                "read_file",
                "Read a text file. Relative paths are in the working directory.",
                json!({ "path": { "type": "string" } }),
                &["path"],
            ),
            function(
                "write_file",
                "Create or replace a text file with the given content. Relative paths are in the working directory.",
                json!({ "path": { "type": "string" }, "content": { "type": "string" } }),
                &["path", "content"],
            ),
            function(
                "list_dir",
                "List a directory's entries. Relative paths are in the working directory.",
                json!({ "path": { "type": "string", "description": "Default: the working directory." } }),
                &[],
            ),
        ])
    }

    /// [name] with its JSON [arguments], as a [Call].
    pub fn parse(&self, name: &str, arguments: &str) -> Result<Call, String> {
        let args: Value = if arguments.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(arguments).map_err(|e| format!("the arguments are not JSON: {e}"))?
        };
        let text = |key: &str| -> Result<String, String> {
            args.get(key).and_then(Value::as_str).map(str::to_owned).ok_or(format!("`{key}` is missing"))
        };
        Ok(match name {
            "terminal" => Call::Terminal { command: text("command")? },
            "read_file" => Call::ReadFile { path: self.resolve(&text("path")?) },
            "write_file" => Call::WriteFile { path: self.resolve(&text("path")?), content: text("content")? },
            "list_dir" => Call::ListDir { path: self.resolve(&text("path").unwrap_or_else(|_| ".".to_owned())) },
            other => return Err(format!("there is no tool named {other:?}")),
        })
    }

    /// What [call] needs approved, if anything. Reading inside the working directory does not.
    pub fn action(&self, call: &Call) -> Option<Action> {
        match call {
            Call::Terminal { command } => Some(Action::Command(command.clone())),
            Call::WriteFile { path, content } => {
                Some(Action::Write { path: path.clone(), bytes: content.len(), inside: self.inside(path) })
            }
            Call::ReadFile { path } | Call::ListDir { path } => {
                (!self.inside(path)).then(|| Action::Read(path.clone()))
            }
        }
    }

    pub async fn run(&self, call: &Call) -> String {
        let result = match call {
            Call::Terminal { command } => self.terminal(command).await,
            Call::ReadFile { path } => read(path).await,
            Call::WriteFile { path, content } => write(path, content).await,
            Call::ListDir { path } => list(path).await,
        };
        cut(result.unwrap_or_else(|e| format!("error: {e}")))
    }

    async fn terminal(&self, command: &str) -> Result<String, String> {
        tokio::fs::create_dir_all(&self.workdir).await.map_err(|e| format!("{}: {e}", self.workdir.display()))?;
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(&self.workdir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("sh: {e}"))?;
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let run = async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            a.and(b).map_err(|e| e.to_string())?;
            let status = child.wait().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((out, err, status))
        };
        match tokio::time::timeout(self.timeout, run).await {
            Err(_) => Err(format!("stopped after {} seconds", self.timeout.as_secs())),
            Ok(result) => {
                let (out, err, status) = result?;
                let mut text = String::from_utf8_lossy(&out).into_owned();
                if !err.is_empty() {
                    text.push_str(&String::from_utf8_lossy(&err));
                }
                let code = status.code().map_or("killed by a signal".to_owned(), |c| format!("exit code {c}"));
                Ok(format!("{text}{}[{code}]", if text.is_empty() || text.ends_with('\n') { "" } else { "\n" }))
            }
        }
    }

    /// [path] relative to the working directory, with `~` expanded and `.`/`..` folded.
    pub fn resolve(&self, path: &str) -> PathBuf {
        let path = crate::config::expand(Path::new(path.trim()));
        let joined = if path.is_absolute() { path } else { self.workdir.join(path) };
        let mut clean = PathBuf::new();
        for part in joined.components() {
            match part {
                Component::ParentDir => {
                    clean.pop();
                }
                Component::CurDir => {}
                other => clean.push(other),
            }
        }
        clean
    }

    /// [path] is in the working directory, symlinks followed as far as the path exists.
    fn inside(&self, path: &Path) -> bool {
        let real = |p: &Path| {
            let mut existing = p.to_path_buf();
            let mut rest = Vec::new();
            while !existing.exists() {
                match (existing.file_name().map(ToOwned::to_owned), existing.parent()) {
                    (Some(name), Some(parent)) => {
                        rest.push(name);
                        existing = parent.to_path_buf();
                    }
                    _ => break,
                }
            }
            let mut full = existing.canonicalize().unwrap_or(existing);
            full.extend(rest.into_iter().rev());
            full
        };
        real(path).starts_with(real(&self.workdir))
    }
}

async fn read(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("{} is not a text file ({} bytes)", path.display(), bytes.len()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn write(path: &Path, content: &str) -> Result<String, String> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    tokio::fs::write(path, content).await.map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(format!("wrote {} bytes to {}", content.len(), path.display()))
}

async fn list(path: &Path) -> Result<String, String> {
    let mut entries = tokio::fs::read_dir(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let dir = entry.file_type().await.is_ok_and(|t| t.is_dir());
        names.push(format!("{}{}", entry.file_name().to_string_lossy(), if dir { "/" } else { "" }));
    }
    names.sort();
    Ok(if names.is_empty() { "(empty)".to_owned() } else { names.join("\n") })
}

/// Keeps the start and the end of a long result: errors tend to be at the end.
fn cut(text: String) -> String {
    if text.len() <= RESULT_LIMIT {
        return text;
    }
    let half = RESULT_LIMIT / 2;
    let start = floor(&text, half);
    let end = ceil(&text, text.len() - half);
    format!("{}\n[… {} bytes cut …]\n{}", &text[..start], end - start, &text[end..])
}

fn floor(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::{Call, RESULT_LIMIT, Tools, cut};
    use crate::approval::Action;
    use std::time::Duration;

    fn tools() -> (Tools, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("autobot-tools-{}-{}", std::process::id(), rand()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        (Tools::new(dir.clone(), Duration::from_secs(5)), dir)
    }

    fn rand() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64
    }

    #[test]
    fn paths_resolve_in_the_workdir() {
        let (tools, dir) = tools();
        assert_eq!(tools.resolve("a/b.txt"), dir.join("a/b.txt"));
        assert_eq!(tools.resolve("a/../b.txt"), dir.join("b.txt"));
        assert_eq!(tools.resolve("/etc/hosts"), std::path::PathBuf::from("/etc/hosts"));
    }

    #[test]
    fn reads_outside_the_workdir_need_approval() {
        let (tools, dir) = tools();
        let inside = tools.parse("read_file", r#"{"path":"notes.txt"}"#).unwrap();
        assert_eq!(tools.action(&inside), None);
        let escape = tools.parse("read_file", r#"{"path":"../../etc/passwd"}"#).unwrap();
        assert!(matches!(tools.action(&escape), Some(Action::Read(_))));
        // A symlink out of the working directory counts as outside.
        std::os::unix::fs::symlink("/etc", dir.join("link")).unwrap();
        let through = tools.parse("list_dir", r#"{"path":"link"}"#).unwrap();
        assert!(matches!(tools.action(&through), Some(Action::Read(_))));
        let write = tools.parse("write_file", r#"{"path":"x","content":"hi"}"#).unwrap();
        assert!(matches!(tools.action(&write), Some(Action::Write { bytes: 2, inside: true, .. })));
        assert!(tools.parse("rm", "{}").is_err());
        assert!(tools.parse("terminal", "{}").is_err());
    }

    #[tokio::test]
    async fn terminal_reports_output_and_exit_code() {
        let (tools, dir) = tools();
        let out = tools.run(&Call::Terminal { command: "echo hi; echo oops >&2; exit 3".into() }).await;
        assert_eq!(out, "hi\noops\n[exit code 3]");
        let out = tools.run(&Call::Terminal { command: "pwd".into() }).await;
        assert!(out.starts_with(dir.to_str().unwrap()), "{out}");
        let tools = Tools::new(dir, Duration::from_millis(200));
        let out = tools.run(&Call::Terminal { command: "sleep 5".into() }).await;
        assert!(out.contains("stopped after"), "{out}");
    }

    #[tokio::test]
    async fn files_round_trip() {
        let (tools, _) = tools();
        let write = tools.parse("write_file", r#"{"path":"d/n.txt","content":"héllo"}"#).unwrap();
        assert!(tools.run(&write).await.starts_with("wrote 6 bytes"));
        assert_eq!(tools.run(&tools.parse("read_file", r#"{"path":"d/n.txt"}"#).unwrap()).await, "héllo");
        assert_eq!(tools.run(&tools.parse("list_dir", "{}").unwrap()).await, "d/");
        assert!(tools.run(&tools.parse("read_file", r#"{"path":"nope"}"#).unwrap()).await.starts_with("error:"));
    }

    #[test]
    fn long_results_keep_both_ends() {
        let text = format!("start{}end", "é".repeat(RESULT_LIMIT));
        let cut = cut(text);
        assert!(cut.starts_with("start") && cut.ends_with("end") && cut.contains("bytes cut"));
        assert!(cut.len() < RESULT_LIMIT + 100);
    }
}
