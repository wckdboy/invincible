//! Commands in a container (`[agent.docker]`): the agent's shell is a long-lived container with
//! the working directory mounted at the same path, so file tools and commands see the same files
//! while whatever a command installs or breaks stays in the container. One container per
//! working directory (`autobot-<hash>`), made on first use and kept between runs; `docker rm -f`
//! starts it over.
//!
//! ```toml
//! [agent.docker]
//! image = "rust:1.91"   # any image with sh
//! network = "bridge"    # or "none": no network at all
//! ```

use std::path::Path;

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Docker {
    pub image: String,
    #[serde(default = "bridge")]
    pub network: String,
    /// Extra `docker run` arguments when the container is made (`["--memory", "4g"]`).
    #[serde(default)]
    pub args: Vec<String>,
}

fn bridge() -> String {
    "bridge".to_owned()
}

impl Docker {
    /// The container for [workdir].
    pub fn name(&self, workdir: &Path) -> String {
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in workdir.to_string_lossy().bytes().chain(self.image.bytes()) {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("autobot-{:012x}", hash & 0xffff_ffff_ffff)
    }

    /// Makes sure the container for [workdir] runs: started if stopped, made if missing.
    pub async fn ensure(&self, workdir: &Path) -> Result<String, String> {
        let name = self.name(workdir);
        let docker = crate::find_on_path("docker").ok_or("[agent.docker] is set but docker is not installed")?;
        let mut inspect = tokio::process::Command::new(&docker);
        inspect.args(["inspect", "-f", "{{.State.Running}}", &name]);
        let state = output(inspect, std::time::Duration::from_secs(30)).await?;
        let running = String::from_utf8_lossy(&state.stdout).trim().to_owned();
        if state.status.success() && running == "true" {
            return Ok(name);
        }
        // A first run may pull the image: minutes, not forever (a wedged daemon).
        let wait = std::time::Duration::from_secs(15 * 60);
        let output = if state.status.success() {
            let mut start = tokio::process::Command::new(&docker);
            start.args(["start", &name]);
            output(start, wait).await
        } else {
            let dir = workdir.to_str().ok_or("the working directory's path is not UTF-8")?;
            let mut run = tokio::process::Command::new(&docker);
            run.args(["run", "-d", "--init", "--name", &name, "--network", &self.network])
                .args(["--label", "sh.autobot.workdir"])
                .arg("-v")
                .arg(format!("{dir}:{dir}"))
                .args(["-w", dir])
                .args(&self.args)
                .args([&self.image, "sleep", "infinity"]);
            output(run, wait).await
        }?;
        if !output.status.success() {
            return Err(format!(
                "the container {name} ({}) did not start: {}",
                self.image,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(name)
    }

    /// `sh -c [shell]` in the container, in [workdir]; stopped inside the container after
    /// [timeout] seconds (killing the docker client alone would leave it running there).
    pub fn command(&self, name: &str, shell: &str, workdir: &Path, timeout: Option<u64>) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("docker");
        command.args(["exec", "-i", "-w"]).arg(workdir).arg(name);
        match timeout {
            Some(secs) => {
                // `timeout` where the image has it (coreutils, busybox); plain otherwise.
                command.args([
                    "sh",
                    "-c",
                    "if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 \"$0\" sh -c \"$1\"; else exec sh -c \"$1\"; fi",
                ]);
                command.arg(secs.to_string()).arg(shell);
            }
            None => {
                command.args(["sh", "-c", shell]);
            }
        }
        command
    }

    /// A background command: its shell's pid goes to [pidfile] in the container, so it can be
    /// stopped there ([Docker::stop_command]).
    pub fn background(&self, name: &str, shell: &str, workdir: &Path, pidfile: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("docker");
        command.args(["exec", "-i", "-w"]).arg(workdir).arg(name);
        command.args(["sh", "-c", "echo $$ > \"$0\"; exec sh -c \"$1\""]).arg(pidfile).arg(shell);
        command
    }

    /// Stops what [Docker::background] started: the shell and its children.
    pub fn stop_command(name: &str, pidfile: &str) -> Vec<String> {
        let script = format!(
            "p=$(cat '{pidfile}' 2>/dev/null) || exit 0; \
             kids=$(grep -l \"^PPid:[[:space:]]*$p$\" /proc/[0-9]*/status 2>/dev/null | cut -d/ -f3); \
             kill -TERM $p $kids 2>/dev/null; sleep 2; kill -KILL $p $kids 2>/dev/null; rm -f '{pidfile}'"
        );
        ["docker", "exec", name, "sh", "-c", &script].iter().map(|s| (*s).to_owned()).collect()
    }
}

/// What [command] printed, once it ended; stopped (and an error) after [wait].
async fn output(
    mut command: tokio::process::Command,
    wait: std::time::Duration,
) -> Result<std::process::Output, String> {
    command.kill_on_drop(true);
    match tokio::time::timeout(wait, command.output()).await {
        Ok(output) => output.map_err(|e| format!("docker: {e}")),
        Err(_) => Err(format!("docker did not answer in {} seconds (is its daemon stuck?)", wait.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_container_per_workdir_and_image() {
        let d = Docker { image: "alpine".into(), network: bridge(), args: vec![] };
        let a = d.name(Path::new("/w/a"));
        assert!(a.starts_with("autobot-") && a.len() == 20, "{a}");
        assert_eq!(a, d.name(Path::new("/w/a")));
        assert_ne!(a, d.name(Path::new("/w/b")));
        let other = Docker { image: "debian".into(), ..d.clone() };
        assert_ne!(a, other.name(Path::new("/w/a")));
    }

    #[test]
    fn config_parses() {
        let d: Docker = toml::from_str("image = \"rust:1.91\"\nnetwork = \"none\"").unwrap();
        assert_eq!(d.network, "none");
        assert!(toml::from_str::<Docker>("image = \"x\"\nbogus = 1").is_err());
    }
}
