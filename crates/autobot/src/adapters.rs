//! Agent adapters: the installed coding CLIs, behind one explicit run protocol.
//!
//! The registry is a catalogue, not a permission: a run happens only when the owner asks for one
//! (the panel or the API), in a thread's worktree, with the CLI's own account. These CLIs talk to
//! their own providers, so Invincible cannot receipt their model calls; the result says so.
//!
//! The child gets a scrubbed environment: gateway/provider/GitHub tokens and the agent's homes
//! are never inherited. It does get HOME and PATH, because its account lives there.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;

/// The most output kept from one run, before the stream is cut.
const STDOUT_CAP: usize = 128 * 1024;
const STDERR_CAP: usize = 32 * 1024;
/// One adapter run at a time per worktree.
static RUNNING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Debug, Serialize)]
pub struct Adapter {
    pub name: &'static str,
    pub label: &'static str,
    pub command: &'static str,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub auth: &'static str,
    pub login: Option<&'static str>,
    pub capabilities: Vec<&'static str>,
    /// False for the native Autobot adapter: use Chat for it.
    pub runnable: bool,
    pub note: &'static str,
}

#[derive(Debug, Serialize)]
pub struct RunOutput {
    pub adapter: String,
    pub exit_code: i32,
    pub seconds: u64,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

/// Every known adapter, installed or not. Detection is cached by [crate::providers].
pub fn list() -> Vec<Adapter> {
    crate::providers::detect()
        .into_iter()
        .map(|provider| {
            let native = provider.name == "autobot";
            Adapter {
                name: provider.name,
                label: label(provider.name),
                command: provider.command,
                installed: provider.installed,
                version: provider.version,
                path: provider.path,
                auth: provider.auth,
                login: provider.login,
                capabilities: if native {
                    provider.capabilities
                } else {
                    provider.capabilities.into_iter().chain(["own-auth", "worktree"]).collect()
                },
                runnable: !native,
                note: if native {
                    "Native Autobot: use Chat for it."
                } else {
                    "Runs with its own account; Invincible does not receipt its model calls."
                },
            }
        })
        .collect()
}

fn label(name: &str) -> &'static str {
    match name {
        "autobot" => "Autobot",
        "codex" => "Codex",
        "claude" => "Claude Code",
        "opencode" => "OpenCode",
        "cursor" => "Cursor Agent",
        "hermes" => "Hermes Agent",
        "pi" => "Pi",
        _ => "Agent",
    }
}

pub fn find(name: &str) -> Option<Adapter> {
    list().into_iter().find(|adapter| adapter.name == name)
}

/// The task's command, without a shell: the task is one argument.
fn command_for(adapter: &Adapter, task: &str, workdir: &Path) -> Result<Vec<String>, String> {
    let dir = workdir.display().to_string();
    let args = match adapter.name {
        "codex" => vec![
            "exec".into(),
            "-C".into(),
            dir,
            "--skip-git-repo-check".into(),
            "--dangerously-bypass-approvals-and-sandbox".into(),
            task.to_owned(),
        ],
        "claude" => vec!["-p".into(), task.to_owned(), "--permission-mode".into(), "bypassPermissions".into()],
        "opencode" => vec!["run".into(), "--standalone".into(), "--auto".into(), task.to_owned()],
        "cursor" => vec!["-p".into(), "--force".into(), task.to_owned()],
        "hermes" => vec!["--in".into(), dir, "--no-restore-cwd".into(), "-z".into(), task.to_owned(), "--yolo".into()],
        "pi" => {
            let provider = std::env::var("HARNESS_PI_PROVIDER").unwrap_or_else(|_| "deepseek".into());
            let model = std::env::var("HARNESS_PI_MODEL").unwrap_or_else(|_| "deepseek-v4-pro".into());
            vec![
                "-p".into(),
                task.to_owned(),
                "--provider".into(),
                provider,
                "--model".into(),
                model,
                "--approve".into(),
                "--no-session".into(),
            ]
        }
        _ => return Err(format!("unknown adapter {:?}", adapter.name)),
    };
    Ok(args)
}

/// A command that has passed every check and holds its worktree: ready to stream.
pub struct Prepared {
    adapter: Adapter,
    program: PathBuf,
    args: Vec<String>,
    workdir: PathBuf,
    _guard: RunGuard,
}

impl Prepared {
    pub fn name(&self) -> &'static str {
        self.adapter.name
    }

    pub fn label(&self) -> &'static str {
        self.adapter.label
    }
}

/// Run [name] in [workdir]. The caller has already chosen the thread and its worktree.
pub async fn run(name: &str, task: &str, workdir: &Path, limit: Duration) -> Result<RunOutput, String> {
    let prepared = prepare(name, task, workdir).await?;
    execute(prepared, limit, None).await
}

/// Validates the adapter, its login and the worktree, and claims the worktree for one run.
/// Streaming callers do this before opening the event stream, so a bad login is a normal error.
pub async fn prepare(name: &str, task: &str, workdir: &Path) -> Result<Prepared, String> {
    let adapter = find(name).ok_or_else(|| format!("unknown adapter {name:?}"))?;
    if !adapter.installed {
        return Err(format!("{} is not installed on this machine", adapter.label));
    }
    if !adapter.runnable {
        return Err(format!("{} is native; use Chat", adapter.label));
    }
    let workdir = workdir.canonicalize().map_err(|e| format!("{}: {e}", workdir.display()))?;
    if !workdir.is_dir() {
        return Err(format!("{} is not a directory", workdir.display()));
    }
    authenticate(&adapter, &workdir).await?;
    let args = command_for(&adapter, task, &workdir)?;
    let program = adapter.path.as_deref().map(PathBuf::from).unwrap_or_else(|| PathBuf::from(adapter.command));
    let guard = claim(&workdir)?;
    Ok(Prepared { adapter, program, args, workdir, _guard: guard })
}

/// Runs a [Prepared] command. With [chunks], each complete line of output is also sent live, in
/// order, tagged with its pipe (true: stdout).
pub async fn execute(
    prepared: Prepared,
    limit: Duration,
    chunks: Option<tokio::sync::mpsc::UnboundedSender<(bool, String)>>,
) -> Result<RunOutput, String> {
    let started = Instant::now();
    let (exit_code, stdout, stderr, truncated) =
        run_process(&prepared.program, &prepared.args, &prepared.workdir, limit, chunks).await?;
    Ok(RunOutput {
        adapter: prepared.adapter.name.to_owned(),
        exit_code,
        seconds: started.elapsed().as_secs(),
        stdout,
        stderr,
        truncated,
    })
}

/// One run per worktree. The guard removes the path however the runner ends.
fn claim(workdir: &Path) -> Result<RunGuard, String> {
    let mut running = RUNNING.lock().expect("adapter runs");
    if !running.insert(workdir.to_owned()) {
        return Err(format!("an adapter is already running in {}", workdir.display()));
    }
    Ok(RunGuard(workdir.to_owned()))
}

struct RunGuard(PathBuf);

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING.lock() {
            running.remove(&self.0);
        }
    }
}

async fn run_process(
    program: &Path,
    args: &[String],
    workdir: &Path,
    limit: Duration,
    chunks: Option<tokio::sync::mpsc::UnboundedSender<(bool, String)>>,
) -> Result<(i32, String, String, bool), String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env_clear();
    for (key, value) in base_env(workdir) {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|e| format!("{}: {e}", program.display()))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout pipe".to_owned())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr pipe".to_owned())?;
    let out_chunks = chunks.clone();
    let err_chunks = chunks;
    let out = tokio::spawn(read_pipe(stdout, true, STDOUT_CAP, out_chunks));
    let err = tokio::spawn(read_pipe(stderr, false, STDERR_CAP, err_chunks));
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(format!("timed out after {} s", limit.as_secs()));
        }
        Ok(Err(e)) => return Err(format!("{}: {e}", program.display())),
        Ok(Ok(status)) => status,
    };
    let (stdout, cut_out) =
        out.await.map_err(|e| format!("reading stdout: {e}"))?.map_err(|e| format!("stdout: {e}"))?;
    let (stderr, cut_err) =
        err.await.map_err(|e| format!("reading stderr: {e}"))?.map_err(|e| format!("stderr: {e}"))?;
    Ok((status.code().unwrap_or(-1), stdout, stderr, cut_out || cut_err))
}

/// Reads one pipe to EOF, keeping at most [max] bytes and sending complete lines live. A chunk
/// carries whole lines, so a split multi-byte character is never shown halfway.
async fn read_pipe(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    stdout: bool,
    max: usize,
    chunks: Option<tokio::sync::mpsc::UnboundedSender<(bool, String)>>,
) -> Result<(String, bool), String> {
    let mut kept = Vec::new();
    let mut pending = Vec::new();
    let mut total = 0usize;
    let mut buf = [0u8; 8192];
    loop {
        let n = pipe.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n;
        let take = max.saturating_sub(kept.len()).min(n);
        kept.extend_from_slice(&buf[..take]);
        if let Some(tx) = &chunks {
            pending.extend_from_slice(&buf[..n]);
            while let Some(at) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=at).collect();
                let text = String::from_utf8_lossy(&line).into_owned();
                if tx.send((stdout, text)).is_err() {
                    break;
                }
            }
            if pending.len() > 16 * 1024 {
                let text = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();
                let _ = tx.send((stdout, text));
            }
        }
    }
    if let Some(tx) = &chunks
        && !pending.is_empty()
    {
        let text = String::from_utf8_lossy(&pending).into_owned();
        let _ = tx.send((stdout, text));
    }
    let mut cut = kept.len();
    while cut > 0 && std::str::from_utf8(&kept[..cut]).is_err() {
        cut -= 1;
    }
    let mut text = String::from_utf8_lossy(&kept[..cut]).into_owned();
    let truncated = total > kept.len();
    if truncated {
        text.push_str(&format!("\n… {} bytes more (truncated)", total - kept.len()));
    }
    Ok((text, truncated))
}

/// Whether an adapter is logged in, checked just before a run. OpenCode and Hermes have no
/// status command; their run reports the error.
async fn authenticate(adapter: &Adapter, workdir: &Path) -> Result<(), String> {
    let program = adapter.path.as_deref().map(PathBuf::from).unwrap_or_else(|| PathBuf::from(adapter.command));
    let check = |args: &[&str]| {
        let program = program.clone();
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        let workdir = workdir.to_owned();
        async move { run_process(&program, &args, &workdir, Duration::from_secs(20), None).await }
    };
    match adapter.name {
        "codex" => {
            let (code, out, err, _) = check(&["login", "status"]).await?;
            let text = format!("{out}\n{err}");
            if code != 0 || !text.to_lowercase().contains("logged in") {
                return Err(format!("Codex is not logged in: {} (run `codex login`)", text.trim()));
            }
        }
        "claude" => {
            let (code, out, err, _) = check(&["auth", "status"]).await?;
            let text = format!("{out}\n{err}");
            let logged =
                serde_json::from_str::<Value>(out.trim()).ok().and_then(|v| v["loggedIn"].as_bool()).unwrap_or(false);
            if code != 0 || !logged {
                return Err(format!("Claude Code is not logged in: {} (run `claude auth login`)", text.trim()));
            }
        }
        "cursor" => {
            let (code, out, err, _) = check(&["status"]).await?;
            let text = format!("{out}\n{err}");
            if code != 0 || text.to_lowercase().contains("not logged in") {
                return Err(format!("Cursor Agent is not logged in: {} (run `cursor-agent login`)", text.trim()));
            }
        }
        "pi" => {
            let provider = std::env::var("HARNESS_PI_PROVIDER").unwrap_or_else(|_| "deepseek".into());
            let (code, out, err, _) = check(&["auth", "check", "--provider", provider.as_str(), "--json"]).await?;
            let text = format!("{out}\n{err}");
            let ready = serde_json::from_str::<Value>(out.trim())
                .ok()
                .and_then(|v| v["status"].as_str().map(|s| s == "ready"))
                .unwrap_or(false);
            if code != 0 || !ready {
                return Err(format!("Pi's {provider} credentials are not ready: {}", text.trim()));
            }
        }
        _ => {}
    }
    Ok(())
}

/// What a child process may inherit: enough to find its account and tools, never this node's
/// credentials or homes.
fn base_env(workdir: &Path) -> Vec<(String, OsString)> {
    let mut env: Vec<(String, OsString)> = std::env::vars_os()
        .filter_map(|(key, value)| key.to_str().filter(|key| keep_env(key)).map(|key| (key.to_owned(), value)))
        .collect();
    if !env.iter().any(|(key, _)| key == "PATH") {
        env.push(("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()));
    }
    env.push(("PWD".into(), workdir.as_os_str().to_owned()));
    env.push(("NO_COLOR".into(), "1".into()));
    env.push(("TERM".into(), "dumb".into()));
    env.push(("TERMINAL_CWD".into(), workdir.as_os_str().to_owned()));
    env
}

fn keep_env(key: &str) -> bool {
    matches!(
        key,
        "PATH"
            | "HOME"
            | "USER"
            | "LOGNAME"
            | "SHELL"
            | "LANG"
            | "LC_ALL"
            | "TMPDIR"
            | "TMP"
            | "TEMP"
            | "XDG_CONFIG_HOME"
            | "XDG_DATA_HOME"
            | "XDG_CACHE_HOME"
            | "XDG_RUNTIME_DIR"
            | "CODEX_HOME"
            | "CLAUDE_CONFIG_DIR"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(name: &'static str, program: &'static str) -> Adapter {
        Adapter {
            name,
            label: label(name),
            command: program,
            installed: true,
            version: None,
            path: Some(program.into()),
            auth: "account",
            login: None,
            capabilities: vec!["coding"],
            runnable: true,
            note: "",
        }
    }

    #[test]
    fn commands_keep_the_task_as_one_argument() {
        let dir = Path::new("/tmp/project with spaces");
        let args = command_for(&adapter("codex", "codex"), "fix the test; rm -rf /", dir).unwrap();
        assert_eq!(args.last().unwrap(), "fix the test; rm -rf /");
        assert!(args.contains(&"-C".to_owned()));
        let args = command_for(&adapter("hermes", "hermes"), "do it", dir).unwrap();
        assert!(args.contains(&"/tmp/project with spaces".to_owned()));
        assert!(command_for(&adapter("autobot", "autobot"), "x", dir).is_err());
    }

    #[test]
    fn child_environment_excludes_node_secrets() {
        for key in
            ["GH_TOKEN", "GITHUB_TOKEN", "INVINCIBLE_TOKEN", "CLOUD_API_KEY", "ANTHROPIC_API_KEY", "AUTOBOT_HOME"]
        {
            assert!(!keep_env(key), "{key}");
        }
        assert!(keep_env("HOME"));
        assert!(keep_env("PATH"));
        let env = base_env(Path::new("/tmp/project"));
        assert!(env.iter().any(|(key, _)| key == "PWD"));
        assert!(!env.iter().any(|(key, _)| key == "GH_TOKEN"));
    }

    #[tokio::test]
    async fn output_streams_in_complete_lines() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(64);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let reading = tokio::spawn(read_pipe(reader, true, 1024, Some(tx)));
        writer.write_all(b"one\ntw").await.unwrap();
        writer.write_all(b"o\n").await.unwrap();
        writer.shutdown().await.unwrap();
        let (kept, truncated) = reading.await.unwrap().unwrap();
        assert_eq!(kept, "one\ntwo\n");
        assert!(!truncated);
        assert_eq!(rx.recv().await.unwrap(), (true, "one\n".to_owned()));
        assert_eq!(rx.recv().await.unwrap(), (true, "two\n".to_owned()));
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_process_runs_with_a_scrubbed_environment() {
        let dir = std::env::temp_dir().join(format!("autobot-adapter-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = Path::new("sh");
        let args = vec!["-c".to_owned(), "printf ready; printf secret >&2; exit 0".to_owned()];
        let (code, out, err, truncated) =
            run_process(program, &args, &dir, Duration::from_secs(5), None).await.unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, "ready");
        assert_eq!(err, "secret");
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(dir);
    }
}
