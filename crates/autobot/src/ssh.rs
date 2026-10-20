//! Commands and files on another machine (`[agent.ssh]`): the agent's terminal and file tools
//! run there, over the system's `ssh`, in a working directory on that machine. One connection
//! is kept open and shared (ControlMaster, for ten minutes after the last use), so each tool
//! call costs a round trip, not a new login. Logins never prompt (BatchMode): use a key the
//! ssh agent or `~/.ssh/config` provides.
//!
//! ```toml
//! [agent.ssh]
//! host = "me@build-box"      # anything ssh takes: user@host, or a Host from ~/.ssh/config
//! workdir = "/home/me/work"  # there; default: the same path as here
//! port = 22                  # optional
//! args = ["-o", "StrictHostKeyChecking=accept-new"]
//! ```

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Ssh {
    pub host: String,
    /// The working directory there (absolute).
    #[serde(default)]
    pub workdir: Option<PathBuf>,
    #[serde(default)]
    pub port: Option<u16>,
    /// A private key file for this host.
    #[serde(default)]
    pub identity: Option<PathBuf>,
    /// More `ssh` options.
    #[serde(default)]
    pub args: Vec<String>,
    /// The ssh program [default: `ssh` on the PATH].
    #[serde(default = "ssh")]
    pub program: String,
}

fn ssh() -> String {
    "ssh".to_owned()
}

/// [s] quoted for a POSIX shell.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Most a remote file read or a search hands back (bytes).
const MOST: usize = 4 * 1024 * 1024;

impl Ssh {
    /// Refuses a host that would be read as an option, or that has spaces in it.
    pub fn check(&self) -> Result<(), String> {
        let host = self.host.trim();
        if host.is_empty() || host.starts_with('-') || host.contains(char::is_whitespace) {
            return Err(format!("[agent.ssh] host = {:?}: user@host or a Host from ~/.ssh/config", self.host));
        }
        if let Some(dir) = &self.workdir
            && !dir.is_absolute()
        {
            return Err(format!("[agent.ssh] workdir = {:?}: an absolute path on {host}", dir.display()));
        }
        Ok(())
    }

    /// The shared connection's socket: in a private directory here (short, for the socket
    /// path limit).
    fn control_path() -> PathBuf {
        let uid = rustix::process::getuid().as_raw();
        std::env::temp_dir().join(format!("autobot-ssh-{uid}"))
    }

    /// `ssh` with the options and the host; the remote command comes after.
    pub fn base(&self) -> tokio::process::Command {
        let dir = Self::control_path();
        if std::fs::create_dir_all(&dir).is_ok() {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let mut command = tokio::process::Command::new(&self.program);
        command
            .args(["-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", "ControlPersist=600"])
            .arg("-o")
            .arg(format!("ControlPath={}/%C", dir.display()))
            .args(["-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=15"]);
        if let Some(port) = self.port {
            command.arg("-p").arg(port.to_string());
        }
        if let Some(identity) = &self.identity {
            command.arg("-i").arg(crate::config::expand(identity));
        }
        command.args(&self.args).arg("--").arg(self.host.trim());
        // It runs from somewhere that exists here (the working directory is over there).
        command.current_dir(std::env::temp_dir());
        command
    }

    /// The remote command for [shell] in [workdir], stopped there after [timeout] seconds
    /// (where it has `timeout`).
    pub fn remote(shell: &str, workdir: &Path, timeout: Option<u64>) -> String {
        let dir = quote(&workdir.display().to_string());
        let shell = quote(shell);
        match timeout {
            Some(secs) => format!(
                "cd {dir} && if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 {secs} sh -c {shell}; else exec sh -c {shell}; fi"
            ),
            None => format!("cd {dir} && exec sh -c {shell}"),
        }
    }

    pub fn command(&self, shell: &str, workdir: &Path, timeout: Option<u64>) -> tokio::process::Command {
        let mut command = self.base();
        command.arg(Self::remote(shell, workdir, timeout));
        command
    }

    /// A background command: its shell's pid goes to [pidfile] there, to stop it later.
    pub fn background(&self, shell: &str, workdir: &Path, pidfile: &str) -> tokio::process::Command {
        let mut command = self.base();
        command.arg(format!(
            "cd {} && echo $$ > {} && exec sh -c {}",
            quote(&workdir.display().to_string()),
            quote(pidfile),
            quote(shell)
        ));
        command
    }

    /// What stops a [Ssh::background] command there: its shell and its children.
    pub fn stop_command(&self, pidfile: &str) -> Vec<String> {
        let script = format!(
            "p=$(cat {f} 2>/dev/null) || exit 0; pkill -TERM -P $p 2>/dev/null; kill -TERM $p 2>/dev/null; sleep 2; pkill -KILL -P $p 2>/dev/null; kill -KILL $p 2>/dev/null; rm -f {f}",
            f = quote(pidfile)
        );
        let base = self.base();
        let std = base.as_std();
        std::iter::once(std.get_program().to_string_lossy().into_owned())
            .chain(std.get_args().map(|a| a.to_string_lossy().into_owned()))
            .chain(std::iter::once(script))
            .collect()
    }

    /// Runs [script] there with [input] on its stdin: its output, error output and exit code.
    pub async fn run(
        &self,
        script: &str,
        input: Option<&[u8]>,
        wait: Duration,
    ) -> Result<(Vec<u8>, String, i32), String> {
        let mut command = self.base();
        command
            .arg(script)
            .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| format!("{}: {e}", self.program))?;
        if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin.write_all(bytes).await.map_err(|e| format!("ssh: {e}"))?;
            drop(stdin);
        }
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let run = async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let mut limited = (&mut stdout).take(MOST as u64);
            let (a, b) = tokio::join!(limited.read_to_end(&mut out), stderr.read_to_end(&mut err));
            a.and(b).map_err(|e| e.to_string())?;
            let status = child.wait().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((out, String::from_utf8_lossy(&err).trim().to_owned(), status.code().unwrap_or(-1)))
        };
        let (out, err, code) = tokio::time::timeout(wait, run)
            .await
            .map_err(|_| format!("{}: no answer in {}s", self.host, wait.as_secs()))??;
        // 255: ssh itself failed (could not connect, or log in).
        if code == 255 {
            return Err(format!("ssh {}: {}", self.host, err.lines().last().unwrap_or("could not connect")));
        }
        Ok((out, err, code))
    }

    /// The bytes of [path] there.
    pub async fn read(&self, path: &Path) -> Result<Vec<u8>, String> {
        let shown = path.display().to_string();
        let (out, err, code) = self.run(&format!("cat -- {}", quote(&shown)), None, Duration::from_secs(60)).await?;
        if code != 0 {
            return Err(format!("{shown}: {}", err.trim_start_matches("cat: ").rsplit(": ").next().unwrap_or(&err)));
        }
        Ok(out)
    }

    /// [content] into [path] there (its directory made), never through a link.
    pub async fn write(&self, path: &Path, content: &[u8]) -> Result<(), String> {
        let shown = path.display().to_string();
        let file = quote(&shown);
        let dir = quote(&path.parent().map(|p| p.display().to_string()).unwrap_or_else(|| "/".into()));
        let script = format!(
            "mkdir -p -- {dir} && if [ -L {file} ]; then echo 'is a symbolic link; not writing through it' >&2; exit 3; fi && cat > {file}"
        );
        let (_, err, code) = self.run(&script, Some(content), Duration::from_secs(60)).await?;
        if code != 0 {
            return Err(format!("{shown}: {err}"));
        }
        Ok(())
    }

    /// The entries of [path] there, directories with a `/`.
    pub async fn list(&self, path: &Path) -> Result<String, String> {
        let shown = path.display().to_string();
        let (out, err, code) =
            self.run(&format!("ls -1Ap -- {}", quote(&shown)), None, Duration::from_secs(60)).await?;
        if code != 0 {
            return Err(format!("{shown}: {err}"));
        }
        let text = String::from_utf8_lossy(&out).trim_end().to_owned();
        Ok(if text.is_empty() { "(empty)".to_owned() } else { text })
    }

    /// Lines matching [pattern] under [path] there: ripgrep where it is installed, grep -E else.
    pub async fn search(
        &self,
        path: &Path,
        pattern: &str,
        glob: Option<&str>,
        ignore_case: bool,
    ) -> Result<String, String> {
        let p = quote(&path.display().to_string());
        let pat = quote(pattern);
        let i = if ignore_case { " -i" } else { "" };
        let (rg_glob, grep_glob) = match glob {
            Some(g) => {
                (format!(" -g {}", quote(g)), format!(" --include={}", quote(g.rsplit('/').next().unwrap_or(g))))
            }
            None => (String::new(), String::new()),
        };
        let script = format!(
            "if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never{i}{rg_glob} -e {pat} -- {p}; else grep -rnI{i}{grep_glob} --exclude-dir=.git -E -e {pat} -- {p}; fi | head -n 200"
        );
        let (out, err, _) = self.run(&script, None, Duration::from_secs(120)).await?;
        let text = String::from_utf8_lossy(&out).trim_end().to_owned();
        let root = format!("{}/", path.display());
        let text: Vec<String> = text.lines().map(|l| l.strip_prefix(&root).unwrap_or(l).to_owned()).collect();
        if text.is_empty() {
            return Ok(if err.is_empty() { "no matches".to_owned() } else { format!("no matches ({err})") });
        }
        Ok(text.join("\n"))
    }

    /// Files under [path] there whose relative path matches [pattern] (a glob).
    pub async fn find(&self, path: &Path, pattern: &str) -> Result<String, String> {
        let glob = globset::Glob::new(pattern).map_err(|e| format!("{pattern:?}: {e}"))?.compile_matcher();
        let script = format!(
            "cd {} && (rg --files --hidden -g '!.git' 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\\./||') | head -n 50000",
            quote(&path.display().to_string())
        );
        let (out, err, code) = self.run(&script, None, Duration::from_secs(120)).await?;
        if code != 0 && out.is_empty() {
            return Err(format!("{}: {err}", path.display()));
        }
        let found: Vec<&str> =
            std::str::from_utf8(&out).unwrap_or_default().lines().filter(|l| glob.is_match(l)).take(500).collect();
        Ok(if found.is_empty() { "no files match".to_owned() } else { found.join("\n") })
    }

    /// The text of [path] there now, for a diff before a change (blocking; one round trip on
    /// the shared connection). None when it cannot be read.
    pub fn read_now(&self, path: &Path) -> Option<String> {
        let mut command = self.base();
        command.arg(format!("cat -- {}", quote(&path.display().to_string())));
        let out = command.as_std_mut().stdin(std::process::Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_quoting() {
        let ssh = |host: &str| Ssh {
            host: host.into(),
            workdir: None,
            port: None,
            identity: None,
            args: vec![],
            program: ssh(),
        };
        assert!(ssh("me@box").check().is_ok());
        assert!(ssh("-oProxyCommand=evil").check().is_err());
        assert!(ssh("a b").check().is_err());
        let mut relative = ssh("box");
        relative.workdir = Some("work".into());
        assert!(relative.check().is_err());
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(Ssh::remote("echo 'hi'", Path::new("/w d"), None), r"cd '/w d' && exec sh -c 'echo '\''hi'\'''");
        assert!(Ssh::remote("ls", Path::new("/w"), Some(5)).contains("exec timeout -k 5 5 sh -c 'ls'"));
        let args: Vec<String> = ssh("me@box")
            .command("ls", Path::new("/w"), None)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"BatchMode=yes".to_owned()) && args.contains(&"ControlMaster=auto".to_owned()));
        let at = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[at + 1..], ["me@box", "cd '/w' && exec sh -c 'ls'"]);
        let config: Ssh = toml::from_str("host = \"me@box\"\nworkdir = \"/srv/w\"\nport = 2222").unwrap();
        assert_eq!(config.port, Some(2222));
        assert!(toml::from_str::<Ssh>("host = \"x\"\nbogus = 1").is_err());
    }
}
