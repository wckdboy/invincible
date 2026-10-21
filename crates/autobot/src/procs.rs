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
    if stopping() {
        return Err("the agent is stopping; nothing new starts".to_owned());
    }
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
        // Its own process group, so stopping it stops what it started (npm → node).
        .process_group(0)
        .kill_on_drop(true);
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
            shared.lock().expect("proc").push(&text);
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
                    signal_group(pid, rustix::process::Signal::TERM);
                    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
                    // Then the whole group, whether or not the leader went quietly: a child that
                    // ignores TERM outlives a prompt leader.
                    signal_group(pid, rustix::process::Signal::KILL);
                    let _ = child.wait().await;
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
    // Stopping began while it started: the sweep may have looked already (it takes this lock), so
    // it is stopped here.
    if stopping() {
        drop(procs);
        signal_group(pid, rustix::process::Signal::KILL);
        return Err("the agent is stopping; nothing new starts".to_owned());
    }
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

fn signal_group(pid: Option<u32>, signal: rustix::process::Signal) {
    if let Some(pid) = pid.and_then(|p| rustix::process::Pid::from_raw(p as i32)) {
        let _ = rustix::process::kill_process_group(pid, signal);
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

/// Set once the agent began to stop: no command starts from then on (one started after the
/// stopping swept would outlive it).
static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the agent is stopping ([shut_down]).
pub fn stopping() -> bool {
    STOPPING.load(std::sync::atomic::Ordering::SeqCst)
}

/// The agent is going: nothing new starts, and what runs is stopped ([stop_all]).
pub async fn shut_down() {
    STOPPING.store(true, std::sync::atomic::Ordering::SeqCst);
    stop_all().await;
}

/// Kills at once every running command's and background process's group, without waiting:
/// the last thing before the process exits when asked twice to stop.
pub fn kill_now() {
    STOPPING.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::tools::stop_running();
    let procs = PROCS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    for p in procs.1.values() {
        if p.shared.lock().map(|s| s.ended.is_none()).unwrap_or(true) {
            signal_group(p.pid, rustix::process::Signal::KILL);
        }
    }
}

/// Stops every background process (at the end of a chat or a run), and the commands tools are
/// running in the foreground ([crate::tools::stop_running]).
pub async fn stop_all() {
    crate::tools::stop_running();
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

    /// Whether [pid] is a live process (not a zombie).
    fn running(pid: &str) -> bool {
        let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
        let state = String::from_utf8_lossy(&out.stdout);
        let state = state.trim();
        !state.is_empty() && !state.starts_with('Z')
    }

    /// A child that ignores TERM is stopped too, though the leader went at once.
    #[tokio::test]
    async fn stopping_takes_a_child_that_ignores_term() {
        let dir = std::env::temp_dir().join(format!("autobot-procs-term-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("pid");
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(format!("sh -c 'trap \"\" TERM; exec sleep 300' & echo $! > {}; wait", pidfile.display()));
        let id = start("stubborn", cmd, &dir, None).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(30);
        let pid = loop {
            if let Ok(pid) = std::fs::read_to_string(&pidfile)
                && !pid.trim().is_empty()
            {
                break pid.trim().to_owned();
            }
            assert!(std::time::Instant::now() < until, "it did not start");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(running(&pid));
        stop(id).await.unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while running(&pid) {
            assert!(std::time::Instant::now() < until, "{pid} ignored TERM and is still running");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn runs_reads_and_stops() {
        let dir = std::env::temp_dir();
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg("echo started; sleep 30");
        let id = start("sleeper", cmd, &dir, None).unwrap();
        // What it printed comes when it comes (a loaded machine is slow to start a shell): read
        // until it is there, not once after a fixed wait.
        let until = std::time::Instant::now() + Duration::from_secs(30);
        let mut out = String::new();
        while !out.contains("started") && std::time::Instant::now() < until {
            out = format!("{out}{}", output(id, Duration::from_millis(100)).await.unwrap());
        }
        assert!(out.contains("started"), "{out}");
        assert!(out.contains("running"), "{out}");
        assert!(list().contains("sleeper"));
        let out = stop(id).await.unwrap();
        assert!(out.contains("stopped"), "{out}");

        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg("echo done; exit 4");
        let id = start("quick", cmd, &dir, None).unwrap();
        let out = output(id, Duration::from_secs(5)).await.unwrap();
        assert!(out.contains("done") && out.contains("exit code 4"), "{out}");
    }
}
