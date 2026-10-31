//! Running in the background, 24/7: launchd agents on macOS, systemd units on Linux (user units
//! with linger, or system units when installed as root, as on a VPS).
//!
//! - The gateway (`invincible serve`) and the agent (`autobot serve`) run always: started at
//!   boot (at login on macOS), restarted whenever they exit, with their output appended to a log
//!   file the programs keep size-capped themselves. On systemd a watchdog restarts a service
//!   that stops answering its health check (`WatchdogSec`, fed by [crate::watchdog]).
//! - The daily update check (`invincible update --scheduled`) runs only when `[update] auto` is
//!   on: a launchd calendar job, a systemd timer.
//!
//! Installing is idempotent: a definition is rewritten only when it changed, and a service is
//! (re)started only when its definition changed or it is not running.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub const GATEWAY: &str = "sh.invincible.gateway";
pub const AGENT: &str = "sh.invincible.autobot";
pub const UPDATE: &str = "sh.invincible.update";

/// How long a service may go without a watchdog ping before systemd restarts it.
pub const WATCHDOG_SECS: u64 = 180;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Launchd,
    /// `systemctl --user`, units in `~/.config/systemd/user`; needs linger to outlive a login.
    SystemdUser,
    /// `systemctl`, units in `/etc/systemd/system` (installed as root).
    SystemdSystem,
}

impl Platform {
    pub fn current() -> Result<Self, String> {
        match std::env::consts::OS {
            "macos" => Ok(Self::Launchd),
            "linux" if uid().is_ok_and(|u| u == "0") => Ok(Self::SystemdSystem),
            "linux" => Ok(Self::SystemdUser),
            other => Err(format!("no service manager support on {other}")),
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::Launchd => "launchd agents",
            Self::SystemdUser => "systemd user units",
            Self::SystemdSystem => "systemd system units",
        }
    }

    fn systemctl(self) -> Vec<&'static str> {
        match self {
            Self::SystemdUser => vec!["--user"],
            _ => Vec::new(),
        }
    }
}

/// When a service runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Always: started at boot, restarted when it exits, watched.
    Daemon,
    /// Once a day at this local time (a missed run happens at the next boot on systemd).
    Daily { hour: u8, minute: u8 },
}

/// One background service.
#[derive(Clone, Debug)]
pub struct Service {
    /// launchd label (the systemd unit name follows from it).
    pub name: &'static str,
    pub description: &'static str,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub log: PathBuf,
    /// The service this one starts after.
    pub after: Option<&'static str>,
    /// Environment beyond PATH: the homes, when they are not the defaults.
    pub env: Vec<(String, String)>,
    pub kind: Kind,
}

/// The systemd unit name (without `.service`) for a launchd label.
pub fn unit(label: &str) -> String {
    match label {
        GATEWAY => "invincible".to_owned(),
        UPDATE => "invincible-update".to_owned(),
        other => other.rsplit('.').next().unwrap_or(other).to_owned(),
    }
}

/// Where launchd agents or systemd units of [platform] go, for the user with [home].
pub fn dir(platform: Platform, home: &Path) -> PathBuf {
    match platform {
        Platform::Launchd => home.join("Library/LaunchAgents"),
        Platform::SystemdUser => home.join(".config/systemd/user"),
        Platform::SystemdSystem => PathBuf::from("/etc/systemd/system"),
    }
}

/// The file the service's definition (its `.plist` or `.service`) is in.
pub fn path(platform: Platform, home: &Path, label: &str) -> PathBuf {
    match platform {
        Platform::Launchd => dir(platform, home).join(format!("{label}.plist")),
        _ => dir(platform, home).join(format!("{}.service", unit(label))),
    }
}

/// The environment variables that pick a different home, passed on to services as they are set
/// now (a test stack, or a node kept somewhere other than `~/.invincible`).
pub fn home_env() -> Vec<(String, String)> {
    ["INVINCIBLE_HOME", "AUTOBOT_HOME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()).map(|v| ((*k).to_owned(), v)))
        .collect()
}

/// The daily update job (`[update] auto`): [program] is `invincible`, [home] the gateway's home.
pub fn update_job(program: PathBuf, home: &Path) -> Service {
    Service {
        name: UPDATE,
        description: "Invincible and Autobot update check",
        program,
        args: vec!["update".into(), "--scheduled".into()],
        log: home.join("logs/update.log"),
        after: None,
        env: home_env(),
        kind: Kind::Daily { hour: 4, minute: 17 },
    }
}

impl Service {
    fn unit_name(&self) -> String {
        format!("{}.service", unit(self.name))
    }

    /// The unit systemd enables: the timer of a daily job, else the service.
    fn enabled_unit(&self) -> String {
        match self.kind {
            Kind::Daemon => self.unit_name(),
            Kind::Daily { .. } => format!("{}.timer", unit(self.name)),
        }
    }

    /// Where its definition goes, under [home] (the user's home directory).
    pub fn path(&self, platform: Platform, home: &Path) -> PathBuf {
        path(platform, home, self.name)
    }

    /// Every file it is made of, with its contents: one plist, or a unit (and its timer).
    pub fn files(&self, platform: Platform, home: &Path, path_env: &str) -> Vec<(PathBuf, String)> {
        // A system unit starts with no HOME: it gets the installing user's (root's), where the
        // data is.
        let mut service = self.clone();
        if platform == Platform::SystemdSystem && !service.env.iter().any(|(k, _)| k == "HOME") {
            service.env.insert(0, ("HOME".to_owned(), home.display().to_string()));
        }
        let mut files = vec![(self.path(platform, home), service.render(platform, path_env))];
        if let (Platform::SystemdUser | Platform::SystemdSystem, Kind::Daily { hour, minute }) = (platform, self.kind) {
            let timer = format!(
                "[Unit]\nDescription={description} (daily)\n\n[Timer]\nOnCalendar=*-*-* {hour:02}:{minute:02}:00\nRandomizedDelaySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n",
                description = self.description,
            );
            files.push((dir(platform, home).join(self.enabled_unit()), timer));
        }
        files
    }

    /// The definition, with [path_env] as the service's PATH (so it finds llama-server).
    pub fn render(&self, platform: Platform, path_env: &str) -> String {
        let mut command = vec![self.program.display().to_string()];
        command.extend(self.args.iter().cloned());
        let mut env = vec![("PATH".to_owned(), path_env.to_owned())];
        env.extend(self.env.iter().cloned());
        match platform {
            Platform::Launchd => self.plist(&command, &env),
            Platform::SystemdUser | Platform::SystemdSystem => self.systemd(platform, &command, &env),
        }
    }

    fn plist(&self, command: &[String], env: &[(String, String)]) -> String {
        let args: String = command.iter().map(|a| format!("        <string>{}</string>\n", xml(a))).collect();
        let env: String = env
            .iter()
            .map(|(k, v)| format!("        <key>{}</key>\n        <string>{}</string>\n", xml(k), xml(v)))
            .collect();
        let when = match self.kind {
            // Started at login and kept running; restarted at most every 10 s if it keeps exiting.
            Kind::Daemon => "    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>ThrottleInterval</key>\n    <integer>10</integer>\n    <key>ExitTimeOut</key>\n    <integer>20</integer>\n    <key>SoftResourceLimits</key>\n    <dict>\n        <key>NumberOfFiles</key>\n        <integer>8192</integer>\n    </dict>\n".to_owned(),
            Kind::Daily { hour, minute } => format!(
                "    <key>RunAtLoad</key>\n    <false/>\n    <key>StartCalendarInterval</key>\n    <dict>\n        <key>Hour</key>\n        <integer>{hour}</integer>\n        <key>Minute</key>\n        <integer>{minute}</integer>\n    </dict>\n"
            ),
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{args}    </array>
    <key>EnvironmentVariables</key>
    <dict>
{env}    </dict>
{when}    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
            label = xml(self.name),
            log = xml(&self.log.display().to_string()),
        )
    }

    fn systemd(&self, platform: Platform, command: &[String], env: &[(String, String)]) -> String {
        let exec: Vec<String> = command.iter().map(|a| systemd_quote(a)).collect();
        let after = self.after.map(|a| format!("{}.service", unit(a)));
        let system = platform == Platform::SystemdSystem;
        let mut unit = format!("[Unit]\nDescription={}\n", self.description);
        let mut wants: Vec<String> = Vec::new();
        let mut order = vec!["network-online.target".to_owned()];
        if system {
            wants.push("network-online.target".to_owned());
        }
        if let Some(after) = &after {
            order.push(after.clone());
            wants.push(after.clone());
        }
        unit.push_str(&format!("After={}\n", order.join(" ")));
        if !wants.is_empty() {
            unit.push_str(&format!("Wants={}\n", wants.join(" ")));
        }
        // `append:` takes the path as it is (no quoting).
        let log = self.log.display().to_string();
        let env: String =
            env.iter().map(|(k, v)| format!("Environment={}\n", systemd_quote(&format!("{k}={v}")))).collect();
        match self.kind {
            Kind::Daemon => {
                // Never give up restarting (the default stops after 5 starts in 10 s).
                unit.push_str("StartLimitIntervalSec=0\n");
                // Stopping signals the gateway alone, which stops its engines once answers in
                // flight have finished or had 15 s; what is left is killed when it exits, or at
                // TimeoutStopSec if it has not. By default (`control-group`) systemd signals the
                // engines at the same moment, ending those answers.
                let kill_mode = if self.name == GATEWAY { "KillMode=mixed\n" } else { "" };
                format!(
                    "{unit}\n[Service]\nType=simple\nExecStart={exec}\n{env}Restart=always\nRestartSec=5\nWatchdogSec={WATCHDOG_SECS}\nTimeoutStopSec=20\n{kill_mode}LimitNOFILE=65536\nStandardOutput=append:{log}\nStandardError=append:{log}\n\n[Install]\nWantedBy={target}\n",
                    exec = exec.join(" "),
                    target = if system { "multi-user.target" } else { "default.target" },
                )
            }
            Kind::Daily { .. } => format!(
                "{unit}\n[Service]\nType=oneshot\nExecStart={exec}\n{env}StandardOutput=append:{log}\nStandardError=append:{log}\n",
                exec = exec.join(" "),
            ),
        }
    }
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn systemd_quote(text: &str) -> String {
    if text.chars().all(|c| c.is_ascii_alphanumeric() || "/._-=:".contains(c)) {
        text.to_owned()
    } else {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%"))
    }
}

/// Writes [path] only when its contents differ; whether it did.
fn write_if_changed(path: &Path, text: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).is_ok_and(|old| old == text) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// The PATH services get: this one, so they find what the user's shell finds.
pub fn path_env() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned())
}

/// Writes [services] and starts them; returns what was done, line by line. Run again, it changes
/// nothing that is already as it should be.
pub fn install(platform: Platform, home: &Path, services: &[Service]) -> Result<Vec<String>, String> {
    let path_env = path_env();
    let mut done = Vec::new();
    let mut changed = Vec::new();
    for service in services {
        if let Some(dir) = service.log.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut any = false;
        for (file, text) in service.files(platform, home, &path_env) {
            if write_if_changed(&file, &text)? {
                done.push(format!("wrote {}", file.display()));
                any = true;
            }
        }
        changed.push(any);
    }
    match platform {
        Platform::Launchd => {
            let domain = format!("gui/{}", uid()?);
            for (service, changed) in services.iter().zip(changed) {
                let file = service.path(platform, home).display().to_string();
                let was_loaded = loaded(&domain, service.name);
                if was_loaded && !changed {
                    done.push(format!("{} already {}", service.name, state_word(service.kind)));
                    continue;
                }
                // Replace a loaded copy; "not loaded" is fine. `bootout` returns before launchd
                // has finished tearing the job down, and a `bootstrap` in that window fails
                // with EIO, so wait for the label to actually go and retry the bootstrap.
                if was_loaded {
                    let _ = run("launchctl", &["bootout", &format!("{domain}/{}", service.name)]);
                    for _ in 0..50 {
                        if !loaded(&domain, service.name) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                bootstrap(&domain, &file)?;
                done.push(format!("{} {}", if was_loaded { "reloaded" } else { "started" }, service.name));
            }
        }
        Platform::SystemdUser | Platform::SystemdSystem => {
            if changed.iter().any(|c| *c) {
                systemctl(platform, &["daemon-reload"])?;
            }
            for (service, changed) in services.iter().zip(changed) {
                let enabled = service.enabled_unit();
                systemctl(platform, &["enable", "--now", &enabled])?;
                if service.kind == Kind::Daemon {
                    if changed || !active(platform, &service.unit_name()) {
                        systemctl(platform, &["restart", &enabled])?;
                        done.push(format!("started {enabled}"));
                    } else {
                        done.push(format!("{enabled} already running"));
                    }
                } else {
                    done.push(format!("{enabled} {}", if changed { "scheduled" } else { "already scheduled" }));
                }
            }
            if platform == Platform::SystemdUser {
                // Without linger, user services stop at logout: on a VPS, when SSH closes.
                let user = user();
                if linger(&user) {
                    done.push(format!("linger is on for {user} (services run without a login)"));
                } else {
                    match run("loginctl", &["enable-linger", &user]) {
                        Ok(()) => done.push(format!("enabled linger for {user} (services run without a login)")),
                        Err(e) => done
                            .push(format!("could not enable linger ({e}); run `sudo loginctl enable-linger {user}`")),
                    }
                }
            }
        }
    }
    Ok(done)
}

fn state_word(kind: Kind) -> &'static str {
    match kind {
        Kind::Daemon => "running, unchanged",
        Kind::Daily { .. } => "scheduled, unchanged",
    }
}

/// Stops and removes [services]; those not installed are skipped.
pub fn uninstall(platform: Platform, home: &Path, services: &[Service]) -> Result<Vec<String>, String> {
    let mut done = Vec::new();
    let mut removed = false;
    for service in services {
        let files = service.files(platform, home, "");
        if !files.iter().any(|(f, _)| f.exists()) {
            continue;
        }
        match platform {
            Platform::Launchd => {
                let _ = run("launchctl", &["bootout", &format!("gui/{}/{}", uid()?, service.name)]);
            }
            Platform::SystemdUser | Platform::SystemdSystem => {
                let _ = systemctl(platform, &["disable", "--now", &service.enabled_unit()]);
            }
        }
        for (file, _) in files {
            match std::fs::remove_file(&file) {
                Ok(()) => done.push(format!("removed {}", file.display())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{}: {e}", file.display())),
            }
        }
        removed = true;
    }
    if removed && platform != Platform::Launchd {
        let _ = systemctl(platform, &["daemon-reload"]);
    }
    Ok(done)
}

/// Restarts those of [labels] that are installed and loaded (new binaries, a changed config);
/// returns the ones restarted.
pub fn restart(platform: Platform, home: &Path, labels: &[&str]) -> Vec<String> {
    let mut restarted = Vec::new();
    for label in labels {
        if !path(platform, home, label).exists() {
            continue;
        }
        let ok = match platform {
            Platform::Launchd => uid().is_ok_and(|uid| {
                let domain = format!("gui/{uid}");
                let target = format!("{domain}/{label}");
                if loaded(&domain, label) {
                    run("launchctl", &["kickstart", "-k", &target]).is_ok()
                } else {
                    // Installed, but a failed reload left it unloaded: start it from its file.
                    bootstrap(&domain, &path(platform, home, label).display().to_string()).is_ok()
                }
            }),
            Platform::SystemdUser | Platform::SystemdSystem => {
                let unit = format!("{}.service", unit(label));
                active(platform, &unit) && systemctl(platform, &["restart", &unit]).is_ok()
            }
        };
        if ok {
            restarted.push((*label).to_owned());
        }
    }
    restarted
}

/// How one service is doing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Status {
    pub name: String,
    pub installed: bool,
    /// Starts by itself (at boot or login).
    pub enabled: bool,
    pub running: bool,
    /// How it last stopped, as the service manager tells it: `exit code 1`, `watchdog`, ….
    pub last_exit: Option<String>,
    /// How many times the service manager restarted it, when it says.
    pub restarts: Option<u64>,
}

/// Whether each of [services] is installed, enabled and running, and how it last stopped.
pub fn status(platform: Platform, home: &Path, services: &[Service]) -> Vec<Status> {
    services.iter().map(|s| status_of(platform, home, s)).collect()
}

fn status_of(platform: Platform, home: &Path, service: &Service) -> Status {
    let mut status = Status { name: service.name.to_owned(), ..Status::default() };
    status.installed = service.path(platform, home).exists();
    if !status.installed {
        return status;
    }
    match platform {
        Platform::Launchd => {
            let Ok(uid) = uid() else { return status };
            let out = Command::new("launchctl").args(["print", &format!("gui/{uid}/{}", service.name)]).output();
            if let Some(out) = out.ok().filter(|o| o.status.success()) {
                let text = String::from_utf8_lossy(&out.stdout);
                status.enabled = true;
                status.running = text.contains("state = running");
                let parsed = parse_launchctl(&text);
                status.last_exit = parsed.0;
                status.restarts = parsed.1;
            }
        }
        Platform::SystemdUser | Platform::SystemdSystem => {
            let mut ctl = platform.systemctl();
            let enabled = service.enabled_unit();
            ctl.extend(["is-enabled", "--quiet", &enabled]);
            status.enabled = Command::new("systemctl").args(&ctl).status().is_ok_and(|s| s.success());
            status.running = match service.kind {
                Kind::Daemon => active(platform, &service.unit_name()),
                Kind::Daily { .. } => active(platform, &enabled),
            };
            let mut ctl = platform.systemctl();
            let unit = service.unit_name();
            ctl.extend(["show", &unit, "-p", "Result", "-p", "NRestarts", "-p", "ExecMainStatus"]);
            if let Ok(out) = Command::new("systemctl").args(&ctl).output() {
                let parsed = parse_systemd_show(&String::from_utf8_lossy(&out.stdout));
                status.last_exit = parsed.0;
                status.restarts = parsed.1;
            }
        }
    }
    status
}

/// From `launchctl print`: how it last exited, and how many times it ran.
pub fn parse_launchctl(text: &str) -> (Option<String>, Option<u64>) {
    let field = |name: &str| {
        text.lines().find_map(|l| l.trim().strip_prefix(name).and_then(|r| r.trim().strip_prefix('=')).map(str::trim))
    };
    let last = field("last exit code").map(|v| match v {
        "0" => "exit code 0".to_owned(),
        "(never exited)" => "never exited".to_owned(),
        other => format!("exit code {other}"),
    });
    let runs = field("runs").and_then(|v| v.parse::<u64>().ok()).map(|r| r.saturating_sub(1));
    (last, runs)
}

/// From `systemctl show -p Result -p NRestarts -p ExecMainStatus`.
pub fn parse_systemd_show(text: &str) -> (Option<String>, Option<u64>) {
    let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)?.strip_prefix('=').map(str::trim));
    let last = match (field("Result"), field("ExecMainStatus")) {
        (Some("success"), Some(code)) if code != "0" => Some(format!("exit code {code}")),
        (Some("success"), _) => None,
        (Some(result), _) if !result.is_empty() => Some(result.to_owned()),
        _ => None,
    };
    (last, field("NRestarts").and_then(|v| v.parse().ok()))
}

/// `launchctl bootstrap`, retried: a just-removed job may still be settling.
fn bootstrap(domain: &str, file: &str) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..5 {
        match run("launchctl", &["bootstrap", domain, file]) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e;
                std::thread::sleep(Duration::from_millis(200 * (attempt + 1)));
            }
        }
    }
    Err(last)
}

fn loaded(domain: &str, label: &str) -> bool {
    Command::new("launchctl").args(["print", &format!("{domain}/{label}")]).output().is_ok_and(|o| o.status.success())
}

fn active(platform: Platform, unit: &str) -> bool {
    let mut ctl = platform.systemctl();
    ctl.extend(["is-active", "--quiet", unit]);
    Command::new("systemctl").args(&ctl).status().is_ok_and(|s| s.success())
}

/// Whether [user]'s services keep running without a login (systemd's linger).
pub fn linger(user: &str) -> bool {
    !user.is_empty() && Path::new("/var/lib/systemd/linger").join(user).exists()
}

pub fn user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| {
            Command::new("id").arg("-un").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        })
        .unwrap_or_default()
}

fn uid() -> Result<String, String> {
    let out = Command::new("id").arg("-u").output().map_err(|e| format!("id -u: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// `systemctl [--user] args…`.
fn systemctl(platform: Platform, args: &[&str]) -> Result<(), String> {
    let mut all = platform.systemctl();
    all.extend_from_slice(args);
    run("systemctl", &all)
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{program} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::{AGENT, GATEWAY, Kind, Platform, Service, UPDATE, parse_launchctl, parse_systemd_show};
    use std::path::{Path, PathBuf};

    fn agent() -> Service {
        Service {
            name: AGENT,
            description: "Autobot Agent",
            program: PathBuf::from("/home/me/.local/bin/autobot"),
            args: vec!["serve".into()],
            log: PathBuf::from("/home/me/.autobot/logs/agent.log"),
            after: Some(GATEWAY),
            env: vec![("AUTOBOT_HOME".into(), "/home/me/a b".into())],
            kind: Kind::Daemon,
        }
    }

    fn gateway() -> Service {
        Service {
            name: GATEWAY,
            description: "Invincible Gateway",
            program: PathBuf::from("/home/me/.local/bin/invincible"),
            args: vec!["serve".into()],
            log: PathBuf::from("/home/me/.invincible/logs/gateway.log"),
            after: None,
            env: Vec::new(),
            kind: Kind::Daemon,
        }
    }

    fn update() -> Service {
        Service {
            name: UPDATE,
            description: "Invincible update check",
            program: PathBuf::from("/home/me/.local/bin/invincible"),
            args: vec!["update".into(), "--scheduled".into()],
            log: PathBuf::from("/home/me/.invincible/logs/update.log"),
            after: None,
            env: Vec::new(),
            kind: Kind::Daily { hour: 4, minute: 17 },
        }
    }

    /// The generated files, compared with the snapshots in tests/snapshots (UPDATE_SNAPSHOTS=1
    /// rewrites them).
    fn snapshot(name: &str, text: &str) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots").join(name);
        if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
        }
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(text, expected, "{name} changed; UPDATE_SNAPSHOTS=1 cargo test rewrites the snapshot");
    }

    #[test]
    fn systemd_units() {
        let home = Path::new("/home/me");
        // Stopping the gateway signals it alone: it stops its engines once answers in flight are done.
        let gateway_unit = gateway().render(Platform::SystemdUser, "/usr/bin");
        assert!(gateway_unit.contains("TimeoutStopSec=20\nKillMode=mixed\n"), "{gateway_unit}");
        let agent_unit = agent().render(Platform::SystemdUser, "/usr/bin");
        assert!(!agent_unit.contains("KillMode"), "{agent_unit}");
        snapshot("invincible.user.service", &gateway().render(Platform::SystemdUser, "/usr/bin"));
        snapshot(
            "invincible.system.service",
            &gateway().files(Platform::SystemdSystem, Path::new("/root"), "/usr/bin")[0].1,
        );
        snapshot("sh.invincible.gateway.plist", &gateway().render(Platform::Launchd, "/usr/bin"));
        let files = agent().files(Platform::SystemdUser, home, "/usr/bin:/a b");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, PathBuf::from("/home/me/.config/systemd/user/autobot.service"));
        snapshot("autobot.user.service", &files[0].1);
        let unit = &files[0].1;
        assert!(unit.contains("ExecStart=/home/me/.local/bin/autobot serve\n"), "{unit}");
        assert!(unit.contains("After=network-online.target invincible.service\nWants=invincible.service\n"), "{unit}");
        assert!(unit.contains("Environment=\"PATH=/usr/bin:/a b\"\n"), "{unit}");
        assert!(unit.contains("Restart=always\n") && unit.contains("WatchdogSec=180\n"), "{unit}");

        let system = agent().files(Platform::SystemdSystem, Path::new("/root"), "/usr/bin");
        assert_eq!(system[0].0, PathBuf::from("/etc/systemd/system/autobot.service"));
        snapshot("autobot.system.service", &system[0].1);
        assert!(system[0].1.contains("WantedBy=multi-user.target"));

        let timer = update().files(Platform::SystemdUser, home, "/usr/bin");
        assert_eq!(timer[0].0, PathBuf::from("/home/me/.config/systemd/user/invincible-update.service"));
        assert_eq!(timer[1].0, PathBuf::from("/home/me/.config/systemd/user/invincible-update.timer"));
        snapshot("invincible-update.service", &timer[0].1);
        snapshot("invincible-update.timer", &timer[1].1);
    }

    #[test]
    fn launchd_agents() {
        let plist = agent().render(Platform::Launchd, "/opt/homebrew/bin:/usr/bin");
        snapshot("sh.invincible.autobot.plist", &plist);
        assert!(plist.contains("<string>/home/me/.local/bin/autobot</string>\n        <string>serve</string>"));
        assert!(plist.contains("<key>KeepAlive</key>\n    <true/>"));
        assert_eq!(
            agent().path(Platform::Launchd, Path::new("/Users/me")),
            PathBuf::from("/Users/me/Library/LaunchAgents/sh.invincible.autobot.plist")
        );
        let daily = update().files(Platform::Launchd, Path::new("/Users/me"), "/usr/bin");
        assert_eq!(daily.len(), 1);
        snapshot("sh.invincible.update.plist", &daily[0].1);
        assert!(daily[0].1.contains("<key>StartCalendarInterval</key>"));
    }

    #[test]
    fn reads_how_a_service_last_stopped() {
        let launchd = "\tstate = running\n\truns = 3\n\tlast exit code = 70\n";
        assert_eq!(parse_launchctl(launchd), (Some("exit code 70".into()), Some(2)));
        assert_eq!(
            parse_launchctl("runs = 1\nlast exit code = (never exited)\n"),
            (Some("never exited".into()), Some(0))
        );
        let systemd = "Result=watchdog\nNRestarts=4\nExecMainStatus=6\n";
        assert_eq!(parse_systemd_show(systemd), (Some("watchdog".into()), Some(4)));
        assert_eq!(parse_systemd_show("Result=success\nNRestarts=0\nExecMainStatus=0\n"), (None, Some(0)));
    }
}
