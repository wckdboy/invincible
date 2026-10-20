//! Commands that keep running after the call returns (`terminal` with `background`): a dev
//! server, a watcher, a long build. Each gets a number; `process` reads what it printed since the
//! last look, waits for it, or stops it. They live as long as this Autobot process, and are
//! stopped (their whole process group) when it ends a chat or a run.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;

/// Most output kept per process: the end of it.
const KEEP: usize = 256 * 1024;
/// At most this many at once.
const MOST: usize = 16;

struct Proc {
    command: String,
    pid: Option<u32>,
    started: Instant,
    shared: Arc<Mutex<Shared>>,
    stop: Arc<tokio::sync::Notify>,
    done: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
struct Shared {
    output: String,
    /// Bytes dropped from the front of [output] to keep it at [KEEP].
    dropped: usize,
    /// Where the last `output` stopped reading (counting dropped bytes).
    read: usize,
    /// How it ended: an exit code, or a description.
    ended: Option<String>,
}

impl Shared {
    fn push(&mut self, text: &str) {
        self.output.push_str(text);
        if self.output.len() > KEEP {
            let mut cut = self.output.len() - KEEP;
            while !self.output.is_char_boundary(cut) {
                cut += 1;
            }
            self.output.drain(..cut);
            self.dropped += cut;
        }
    }

    /// What was printed since the last call.
    fn unread(&mut self) -> String {
        let total = self.dropped + self.output.len();
        let from = self.read.max(self.dropped) - self.dropped;
        let skipped = self.read < self.dropped;
        self.read = total;
        let mut from = from.min(self.output.len());
        while !self.output.is_char_boundary(from) {
            from += 1;
        }
        let text = &self.output[from..];
        if skipped { format!("[… earlier output dropped]\n{text}") } else { text.to_owned() }
    }
}

static PROCS: LazyLock<Mutex<(u32, BTreeMap<u32, Proc>)>> = LazyLock::new(|| Mutex::new((0, BTreeMap::new())));

/// Starts [command] (already built: plain or sandboxed) in the background; its number.
/// [stopper]: a command that stops it where signals to its process group do not reach (in a
/// container), run before those.
pub fn start(
    label: &str,
    mut command: tokio::process::Command,
    workdir: &Path,
    stopper: Option<Vec<String>>,
) -> Result<u32, String> {
    {
        let procs = PROCS.lock().expect("procs");
        let running = procs.1.values().filter(|p| p.shared.lock().expect("proc").ended.is_none()).count();
        if running >= MOST {
            return Err(format!("{MOST} background processes are running; stop one first"));
        }
    }
    command
        .current_dir(workdir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, so stopping it stops what it started (npm → node).
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    let mut child = command.spawn().map_err(|e| format!("sh: {e}"))?;
    let pid = child.id();
    let shared = Arc::new(Mutex::new(Shared::default()));
    let stop = Arc::new(tokio::sync::Notify::new());
    let done = Arc::new(tokio::sync::Notify::new());
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let pump = |mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>, shared: Arc<Mutex<Shared>>| async move {
        let mut buf = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        while let Ok(n) = reader.read(&mut buf).await {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            // Whole characters only; the rest of one comes with the next read.
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            shared.lock().expect("proc").push(&text.replace("\r\n", "\n"));
        }
    };
    {
        let (shared, stop, done) = (shared.clone(), stop.clone(), done.clone());
        tokio::spawn(async move {
            let out = tokio::spawn(pump(Box::new(stdout), shared.clone()));
            let err = tokio::spawn(pump(Box::new(stderr), shared.clone()));
            let ended = tokio::select! {
                status = child.wait() => match status {
                    Ok(s) => s.code().map_or("killed by a signal".to_owned(), |c| format!("exit code {c}")),
                    Err(e) => e.to_string(),
                },
                () = stop.notified() => {
                    if let Some([program, args @ ..]) = stopper.as_deref() {
                        let mut stopping = tokio::process::Command::new(program);
                        stopping.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                        let _ = tokio::time::timeout(Duration::from_secs(8), stopping.status()).await;
                    }
                    stop_group(pid, false).await;
                    match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                        Ok(_) => {}
                        Err(_) => {
                            stop_group(pid, true).await;
                            let _ = child.wait().await;
                        }
                    }
                    "stopped".to_owned()
                }
            };
            // What it printed last, once its pipes close (a grandchild may hold them open).
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                let _ = out.await;
                let _ = err.await;
            })
            .await;
            shared.lock().expect("proc").ended = Some(ended);
            done.notify_waiters();
        });
    }
    let mut procs = PROCS.lock().expect("procs");
    procs.0 += 1;
    let id = procs.0;
    procs.1.insert(id, Proc { command: label.to_owned(), pid, started: Instant::now(), shared, stop, done });
    // Keep the list short: forget the oldest ended ones.
    let ended: Vec<u32> =
        procs.1.iter().filter(|(_, p)| p.shared.lock().expect("proc").ended.is_some()).map(|(id, _)| *id).collect();
    for old in ended.iter().take(ended.len().saturating_sub(MOST)) {
        procs.1.remove(old);
    }
    Ok(id)
}

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Asks [pid]'s process group to stop ([kill]: makes it): SIGTERM or SIGKILL to the group on
/// Unix; on Windows, `taskkill /T` over the process tree (`/F` to force).
async fn stop_group(pid: Option<u32>, kill: bool) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
        let signal = if kill { rustix::process::Signal::KILL } else { rustix::process::Signal::TERM };
        let _ = rustix::process::kill_process_group(pid, signal);
    }
    #[cfg(windows)]
    {
        let mut taskkill = tokio::process::Command::new("taskkill");
        taskkill.args(["/T", "/PID", &pid.to_string()]);
        if kill {
            taskkill.arg("/F");
        }
        let quiet = std::process::Stdio::null;
        let _ = taskkill.stdin(quiet()).stdout(quiet()).stderr(quiet()).status().await;
    }
}

fn status(p: &Proc) -> String {
    let shared = p.shared.lock().expect("proc");
    let secs = p.started.elapsed().as_secs();
    let state = shared.ended.clone().unwrap_or_else(|| format!("running {secs}s"));
    let pid = p.pid.map(|p| format!(" pid {p}")).unwrap_or_default();
    format!("{state}{pid}")
}

/// Every background process: number, state, command.
pub fn list() -> String {
    let procs = PROCS.lock().expect("procs");
    if procs.1.is_empty() {
        return "no background processes".to_owned();
    }
    procs.1.iter().map(|(id, p)| format!("{id}  [{}]  {}", status(p), p.command)).collect::<Vec<_>>().join("\n")
}

/// What [id] printed since the last look, after waiting up to [wait] for it to end.
pub async fn output(id: u32, wait: Duration) -> Result<String, String> {
    let (shared, done) = {
        let procs = PROCS.lock().expect("procs");
        let p = procs.1.get(&id).ok_or_else(|| format!("there is no background process {id} (see list)"))?;
        (p.shared.clone(), p.done.clone())
    };
    if !wait.is_zero() {
        let notified = done.notified();
        if shared.lock().expect("proc").ended.is_none() {
            let _ = tokio::time::timeout(wait, notified).await;
        }
    }
    let state = {
        let procs = PROCS.lock().expect("procs");
        procs.1.get(&id).map(status).unwrap_or_default()
    };
    let text = shared.lock().expect("proc").unread();
    let text = if text.trim().is_empty() { "(no new output)\n".to_owned() } else { text };
    Ok(format!("{text}{}[process {id}: {state}]", if text.ends_with('\n') { "" } else { "\n" }))
}

/// Stops [id] and what it started; its last output.
pub async fn stop(id: u32) -> Result<String, String> {
    let (stop, done, shared) = {
        let procs = PROCS.lock().expect("procs");
        let p = procs.1.get(&id).ok_or_else(|| format!("there is no background process {id} (see list)"))?;
        (p.stop.clone(), p.done.clone(), p.shared.clone())
    };
    if shared.lock().expect("proc").ended.is_none() {
        let notified = done.notified();
        stop.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(6), notified).await;
    }
    output(id, Duration::ZERO).await
}

/// Stops every background process (at the end of a chat or a run).
pub async fn stop_all() {
    let ids: Vec<u32> = {
        let procs = PROCS.lock().expect("procs");
        procs.1.iter().filter(|(_, p)| p.shared.lock().expect("proc").ended.is_none()).map(|(id, _)| *id).collect()
    };
    futures_util::future::join_all(ids.into_iter().map(stop)).await;
    crate::browser::close().await;
}

/// How many are running.
pub fn running() -> usize {
    PROCS.lock().expect("procs").1.values().filter(|p| p.shared.lock().expect("proc").ended.is_none()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unread_follows_the_cursor_and_drops() {
        let mut s = Shared::default();
        s.push("one\n");
        assert_eq!(s.unread(), "one\n");
        assert_eq!(s.unread(), "");
        s.push("two\n");
        assert_eq!(s.unread(), "two\n");
        s.push(&"x".repeat(KEEP + 10));
        let text = s.unread();
        assert!(text.starts_with("[… earlier output dropped]"));
        assert_eq!(s.output.len(), KEEP);
    }

    #[tokio::test]
    async fn runs_reads_and_stops() {
        let dir = std::env::temp_dir();
        // `echo` and `sleep` mean the same in PowerShell.
        let cmd = crate::shell::command("echo started; sleep 30");
        let id = start("sleeper", cmd, &dir, None).unwrap();
        // PowerShell takes a moment to start.
        let wait = if cfg!(windows) { Duration::from_secs(5) } else { Duration::from_millis(300) };
        let out = output(id, wait).await.unwrap();
        assert!(out.contains("started"), "{out}");
        assert!(out.contains("running"), "{out}");
        assert!(list().contains("sleeper"));
        let out = stop(id).await.unwrap();
        assert!(out.contains("stopped"), "{out}");

        let cmd = crate::shell::command("echo done; exit 4");
        let id = start("quick", cmd, &dir, None).unwrap();
        let out = output(id, Duration::from_secs(5)).await.unwrap();
        assert!(out.contains("done") && out.contains("exit code 4"), "{out}");
    }
}
