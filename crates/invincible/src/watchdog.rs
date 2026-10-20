//! Staying up 24/7, for `invincible serve` and `autobot serve` alike.
//!
//! A plain thread (not a task: it must notice when the async runtime itself is stuck) asks the
//! service's own `GET /healthz` every 30 s:
//! - answered: it tells systemd (`WATCHDOG=1` on `$NOTIFY_SOCKET`, so `WatchdogSec` restarts a
//!   service that stops answering);
//! - not answered for [STUCK] (after the first answer, or after a startup grace): it logs why and
//!   exits, so the service manager (launchd's KeepAlive, systemd's Restart) starts it again.
//!
//! The same thread keeps the logs in the service's log directory size-capped: a `*.log` over
//! [MAX_LOG] is copied to `*.log.1` and emptied (the writers append, so they carry on at the
//! start). `INVINCIBLE_WATCHDOG=off` turns the exit off (the log cap stays).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How often the health check runs.
pub const EVERY: Duration = Duration::from_secs(30);
/// How long without an answer before the service restarts itself.
pub const STUCK: Duration = Duration::from_secs(180);
/// How long a starting service has to answer for the first time.
pub const GRACE: Duration = Duration::from_secs(600);
/// A log file grows to this before it is rotated (one old copy is kept).
pub const MAX_LOG: u64 = 16 << 20;

/// Sends [state] (`READY=1`, `WATCHDOG=1`, …) to systemd, when it is listening; whether it was sent.
pub fn notify(state: &str) -> bool {
    let Some(socket) = std::env::var_os("NOTIFY_SOCKET") else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixDatagram;
        let Ok(sock) = UnixDatagram::unbound() else { return false };
        let name = socket.to_string_lossy().into_owned();
        if let Some(abstract_name) = name.strip_prefix('@') {
            #[cfg(target_os = "linux")]
            {
                use std::os::linux::net::SocketAddrExt;
                return std::os::unix::net::SocketAddr::from_abstract_name(abstract_name.as_bytes())
                    .and_then(|addr| sock.send_to_addr(state.as_bytes(), &addr))
                    .is_ok();
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = abstract_name;
                return false;
            }
        }
        sock.send_to(state.as_bytes(), name).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = (socket, state);
        false
    }
}

/// Whether `GET /healthz` at [addr] answers 200 within [timeout].
pub fn healthy(addr: SocketAddr, timeout: Duration) -> bool {
    let check = || -> std::io::Result<bool> {
        let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.write_all(format!("GET /healthz HTTP/1.0\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes())?;
        let mut head = [0u8; 16];
        let mut n = 0;
        while n < head.len() {
            let got = stream.read(&mut head[n..])?;
            if got == 0 {
                break;
            }
            n += got;
        }
        let line = String::from_utf8_lossy(&head[..n]);
        Ok(line.starts_with("HTTP/1.") && line.get(9..12) == Some("200"))
    };
    check().unwrap_or(false)
}

/// Where to reach a service listening on [listen]: itself on loopback when it listens on every
/// interface.
pub fn local(listen: SocketAddr) -> SocketAddr {
    let mut addr = listen;
    if addr.ip().is_unspecified() {
        addr.set_ip(if addr.is_ipv4() {
            std::net::Ipv4Addr::LOCALHOST.into()
        } else {
            std::net::Ipv6Addr::LOCALHOST.into()
        });
    }
    addr
}

/// What the watchdog decides after one check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Healthy, or still within its grace: tell systemd all is well.
    Alive,
    /// Not answering, but not for long yet.
    Waiting,
    /// Not answering for [STUCK]: restart.
    Stuck,
}

/// The watchdog's state: when the service started and last answered.
#[derive(Clone, Copy, Debug)]
pub struct Watch {
    started: Instant,
    last_ok: Option<Instant>,
}

impl Watch {
    pub fn new(started: Instant) -> Self {
        Self { started, last_ok: None }
    }

    pub fn check(&mut self, ok: bool, now: Instant) -> Verdict {
        if ok {
            self.last_ok = Some(now);
            return Verdict::Alive;
        }
        match self.last_ok {
            None if now.duration_since(self.started) < GRACE => Verdict::Alive,
            None => Verdict::Stuck,
            Some(last) if now.duration_since(last) >= STUCK => Verdict::Stuck,
            Some(_) => Verdict::Waiting,
        }
    }
}

/// Starts the watchdog for the service [name] answering on [listen], with its logs in [logs].
pub fn spawn(name: &'static str, listen: SocketAddr, logs: PathBuf) {
    let exit = std::env::var("INVINCIBLE_WATCHDOG").map_or(true, |v| v != "off");
    let addr = local(listen);
    let spawned = std::thread::Builder::new().name("watchdog".into()).spawn(move || {
        let mut watch = Watch::new(Instant::now());
        let mut ready = false;
        let mut rounds = 0u64;
        loop {
            std::thread::sleep(if ready { EVERY } else { Duration::from_secs(2) });
            let ok = healthy(addr, Duration::from_secs(10));
            if ok && !ready {
                ready = true;
                notify("READY=1");
            }
            match watch.check(ok, Instant::now()) {
                Verdict::Alive => {
                    notify("WATCHDOG=1");
                }
                Verdict::Waiting => tracing::warn!("{name}: http://{addr}/healthz does not answer"),
                Verdict::Stuck if exit => {
                    tracing::error!(
                        "{name}: http://{addr}/healthz has not answered for {} s; exiting so the service manager restarts it (watchdog)",
                        STUCK.as_secs()
                    );
                    std::process::exit(70);
                }
                Verdict::Stuck => {}
            }
            rounds += 1;
            if rounds % 10 == 1 {
                rotate_logs(&logs, MAX_LOG);
            }
        }
    });
    if let Err(e) = spawned {
        tracing::warn!("{name}: no watchdog: {e}");
    }
}

/// Rotates every `*.log` in [dir] larger than [max] bytes; returns the files rotated.
pub fn rotate_logs(dir: &Path, max: u64) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut rotated = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "log")
            && entry.metadata().is_ok_and(|m| m.is_file() && m.len() > max)
            && rotate(&path).is_ok()
        {
            rotated.push(path);
        }
    }
    rotated
}

/// Copies [path] to `<path>.1` and empties it, keeping it open for whoever appends to it.
fn rotate(path: &Path) -> std::io::Result<()> {
    let old = PathBuf::from(format!("{}.1", path.display()));
    std::fs::copy(path, &old)?;
    std::fs::OpenOptions::new().write(true).open(path)?.set_len(0)
}

#[cfg(test)]
mod tests {
    use super::{GRACE, STUCK, Verdict, Watch, healthy, local, rotate_logs};
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    #[test]
    fn decides_when_a_service_is_stuck() {
        let t0 = Instant::now();
        let mut w = Watch::new(t0);
        // Starting: not answering yet is fine for a while, then it is not.
        assert_eq!(w.check(false, t0 + Duration::from_secs(30)), Verdict::Alive);
        assert_eq!(Watch::new(t0).check(false, t0 + GRACE), Verdict::Stuck);
        assert_eq!(w.check(true, t0 + Duration::from_secs(60)), Verdict::Alive);
        assert_eq!(w.check(false, t0 + Duration::from_secs(90)), Verdict::Waiting);
        assert_eq!(w.check(false, t0 + Duration::from_secs(60) + STUCK), Verdict::Stuck);
    }

    #[test]
    fn asks_healthz() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for (i, stream) in listener.incoming().take(2).enumerate() {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 256];
                let n = stream.read(&mut buf).unwrap();
                assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /healthz HTTP/1.0\r\n"));
                let status = if i == 0 { "200 OK" } else { "503 Service Unavailable" };
                stream.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\n\r\n").as_bytes()).unwrap();
            }
        });
        assert!(healthy(addr, Duration::from_secs(5)));
        assert!(!healthy(addr, Duration::from_secs(5)));
        server.join().unwrap();
        // Nothing listening.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        assert!(!healthy(closed, Duration::from_secs(1)));
        assert_eq!(local("0.0.0.0:7777".parse().unwrap()), "127.0.0.1:7777".parse().unwrap());
        assert_eq!(local("[::]:7777".parse().unwrap()), "[::1]:7777".parse().unwrap());
    }

    #[test]
    fn rotates_big_logs_and_keeps_appending() {
        let dir = std::env::temp_dir().join(format!("invincible-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("gateway.log");
        let mut writer = std::fs::OpenOptions::new().create(true).append(true).open(&log).unwrap();
        writer.write_all(&[b'x'; 100]).unwrap();
        std::fs::write(dir.join("small.log"), b"hi").unwrap();
        std::fs::write(dir.join("notes.txt"), [b'y'; 100]).unwrap();
        assert_eq!(rotate_logs(&dir, 50), vec![log.clone()]);
        assert_eq!(std::fs::metadata(dir.join("gateway.log.1")).unwrap().len(), 100);
        writer.write_all(b"after\n").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "after\n");
        assert_eq!(std::fs::read_to_string(dir.join("small.log")).unwrap(), "hi");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
