//! Running in the background: launchd agents on macOS, systemd user units on Linux. The gateway
//! always; the agent when a channel (Telegram) is on. Both restart if they die and start at boot
//! (on Linux that takes "linger", which `install` turns on).

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Launchd,
    Systemd,
}

impl Platform {
    pub fn current() -> Result<Self, String> {
        match std::env::consts::OS {
            "macos" => Ok(Self::Launchd),
            "linux" => Ok(Self::Systemd),
            other => Err(format!("no service manager support on {other}")),
        }
    }
}

/// One background service.
#[derive(Clone, Debug)]
pub struct Service {
    /// launchd label / systemd unit name.
    pub name: &'static str,
    pub description: &'static str,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub log: PathBuf,
    /// The services this one needs started first.
    pub after: Option<&'static str>,
}

pub const GATEWAY: &str = "sh.invincible.gateway";
pub const AGENT: &str = "sh.invincible.autobot";

/// The systemd unit for a launchd label: `invincible.service`, `autobot.service`.
fn unit(label: &str) -> String {
    match label {
        GATEWAY => "invincible.service".to_owned(),
        other => format!("{}.service", other.rsplit('.').next().unwrap_or(other)),
    }
}

impl Service {
    fn unit_name(&self) -> String {
        unit(self.name)
    }

    /// Where its definition goes, under [home] (the user's home directory).
    pub fn path(&self, platform: Platform, home: &Path) -> PathBuf {
        match platform {
            Platform::Launchd => home.join("Library/LaunchAgents").join(format!("{}.plist", self.name)),
            Platform::Systemd => home.join(".config/systemd/user").join(self.unit_name()),
        }
    }

    /// The definition, with [path_env] as the service's PATH (so it finds llama-server).
    pub fn render(&self, platform: Platform, path_env: &str) -> String {
        let mut command = vec![self.program.display().to_string()];
        command.extend(self.args.iter().cloned());
        match platform {
            Platform::Launchd => {
                let args: String = command.iter().map(|a| format!("        <string>{}</string>\n", xml(a))).collect();
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
        <key>PATH</key>
        <string>{path}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
                    label = self.name,
                    path = xml(path_env),
                    log = xml(&self.log.display().to_string()),
                )
            }
            Platform::Systemd => {
                let exec: Vec<String> = command.iter().map(|a| systemd_quote(a)).collect();
                let after = self.after.map(unit);
                format!(
                    "[Unit]\nDescription={description}\nAfter=network-online.target{after}\n{wants}\n[Service]\nExecStart={exec}\nEnvironment={path}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
                    description = self.description,
                    after = after.as_ref().map(|a| format!(" {a}")).unwrap_or_default(),
                    wants = after.as_ref().map(|a| format!("Wants={a}\n")).unwrap_or_default(),
                    exec = exec.join(" "),
                    path = systemd_quote(&format!("PATH={path_env}")),
                )
            }
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

/// Writes [services] and starts them; returns what was done, line by line.
pub fn install(platform: Platform, home: &Path, services: &[Service]) -> Result<Vec<String>, String> {
    let path_env = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned());
    let mut done = Vec::new();
    for service in services {
        let file = service.path(platform, home);
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        if let Some(dir) = service.log.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::write(&file, service.render(platform, &path_env)).map_err(|e| format!("{}: {e}", file.display()))?;
        done.push(format!("wrote {}", file.display()));
    }
    match platform {
        Platform::Launchd => {
            let domain = format!("gui/{}", uid()?);
            for service in services {
                let file = service.path(platform, home);
                // Replace a running copy; "not loaded" is fine.
                let _ = run("launchctl", &["bootout", &domain, &file.display().to_string()]);
                run("launchctl", &["bootstrap", &domain, &file.display().to_string()])?;
                done.push(format!("started {}", service.name));
            }
        }
        Platform::Systemd => {
            run("systemctl", &["--user", "daemon-reload"])?;
            for service in services {
                run("systemctl", &["--user", "enable", "--now", &service.unit_name()])?;
                run("systemctl", &["--user", "restart", &service.unit_name()])?;
                done.push(format!("started {}", service.unit_name()));
            }
            // Without linger, user services stop at logout: on a VPS, when SSH closes.
            let user = std::env::var("USER").unwrap_or_default();
            match run("loginctl", &["enable-linger", &user]) {
                Ok(()) => done.push(format!("enabled linger for {user} (services run without a login)")),
                Err(e) => done.push(format!("could not enable linger ({e}); run `sudo loginctl enable-linger {user}`")),
            }
        }
    }
    Ok(done)
}

/// Stops and removes [services].
pub fn uninstall(platform: Platform, home: &Path, services: &[Service]) -> Result<Vec<String>, String> {
    let mut done = Vec::new();
    for service in services {
        let file = service.path(platform, home);
        if !file.exists() {
            continue;
        }
        match platform {
            Platform::Launchd => {
                let _ = run("launchctl", &["bootout", &format!("gui/{}", uid()?), &file.display().to_string()]);
            }
            Platform::Systemd => {
                let _ = run("systemctl", &["--user", "disable", "--now", &service.unit_name()]);
            }
        }
        std::fs::remove_file(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        done.push(format!("removed {}", file.display()));
    }
    Ok(done)
}

/// Whether each of [services] is installed and running.
pub fn status(platform: Platform, home: &Path, services: &[Service]) -> Vec<(String, bool, bool)> {
    services
        .iter()
        .map(|s| {
            let installed = s.path(platform, home).exists();
            let running = installed
                && match platform {
                    Platform::Launchd => uid().is_ok_and(|uid| {
                        Command::new("launchctl").args(["print", &format!("gui/{uid}/{}", s.name)]).output().is_ok_and(
                            |o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("state = running"),
                        )
                    }),
                    Platform::Systemd => Command::new("systemctl")
                        .args(["--user", "is-active", "--quiet", &s.unit_name()])
                        .status()
                        .is_ok_and(|s| s.success()),
                };
            (s.name.to_owned(), installed, running)
        })
        .collect()
}

fn uid() -> Result<String, String> {
    let out = Command::new("id").arg("-u").output().map_err(|e| format!("id -u: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
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
    use super::{AGENT, GATEWAY, Platform, Service};
    use std::path::{Path, PathBuf};

    fn agent() -> Service {
        Service {
            name: AGENT,
            description: "Autobot Agent",
            program: PathBuf::from("/home/me/.local/bin/autobot"),
            args: vec!["serve".into()],
            log: PathBuf::from("/home/me/.autobot/logs/agent.log"),
            after: Some(GATEWAY),
        }
    }

    #[test]
    fn systemd_units() {
        let unit = agent().render(Platform::Systemd, "/usr/bin:/a b");
        assert!(unit.contains("ExecStart=/home/me/.local/bin/autobot serve\n"), "{unit}");
        assert!(unit.contains("After=network-online.target invincible.service\nWants=invincible.service\n"), "{unit}");
        assert!(unit.contains("Environment=\"PATH=/usr/bin:/a b\"\n"), "{unit}");
        assert_eq!(
            agent().path(Platform::Systemd, Path::new("/home/me")),
            PathBuf::from("/home/me/.config/systemd/user/autobot.service")
        );
    }

    #[test]
    fn launchd_agents() {
        let plist = agent().render(Platform::Launchd, "/opt/homebrew/bin:/usr/bin");
        assert!(plist.contains("<string>sh.invincible.autobot</string>"));
        assert!(plist.contains("<string>/home/me/.local/bin/autobot</string>\n        <string>serve</string>"));
        assert!(plist.contains("<key>KeepAlive</key>\n    <true/>"));
        assert_eq!(
            agent().path(Platform::Launchd, Path::new("/Users/me")),
            PathBuf::from("/Users/me/Library/LaunchAgents/sh.invincible.autobot.plist")
        );
    }
}
