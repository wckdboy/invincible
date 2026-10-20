//! `invincible update`: the latest release of a channel, checked exactly as install.sh checks it,
//! swapped in atomically.
//!
//! 1. `SHA256SUMS` and `SHA256SUMS.sig` from the release; the signature must be the pinned
//!    release key's (an SSH signature, [crate::sshsig]).
//! 2. `VERSION` (listed in the signed `SHA256SUMS`) says what the release is, so an install that
//!    is up to date downloads nothing more.
//! 3. The archive for this platform, resumable, kept only when its SHA-256 is the signed one.
//! 4. The new `invincible` and `autobot` are unpacked next to the old ones (same file system),
//!    run once (`--version`), then renamed over them: a reader sees the old binary or the new
//!    one, never half of one. What did not change is left alone.
//!
//! Nothing here runs unless asked: `invincible update`, or the daily job `[update] auto` turns on.
//! Releases come from GitHub (`https://github.com/wckdboy/invincible/releases`) through the node's
//! `[node] network`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::version::{Channel, Decision, decide};

/// Where releases are: `latest/download/…`, `download/<tag>/…` under it.
pub const RELEASES: &str = "https://github.com/wckdboy/invincible/releases";
/// The release key (install.sh pins the same one).
pub const RELEASE_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo";
pub const NAMESPACE: &str = "invincible-release";
/// The programs in a release archive.
pub const PROGRAMS: [&str; 2] = ["invincible", "autobot"];

/// This machine's release platform.
pub fn platform() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        (os, arch) => Err(format!("no releases for {os}/{arch} (macOS on Apple silicon, Linux on x86_64 or arm64)")),
    }
}

/// What to install.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// The newest build of a channel.
    Latest(Channel),
    /// One release, by version (`0.0.11`): also to go back.
    Version(String),
}

impl Target {
    pub fn channel(&self) -> Channel {
        match self {
            Self::Latest(channel) => *channel,
            Self::Version(v) => crate::version::Version::parse(v).map_or(Channel::Stable, |v| v.channel()),
        }
    }
}

/// Where releases come from, and the key that signs them.
#[derive(Clone, Debug)]
pub struct Source {
    pub root: String,
    pub key: String,
}

impl Default for Source {
    fn default() -> Self {
        Self { root: RELEASES.to_owned(), key: RELEASE_KEY.to_owned() }
    }
}

impl Source {
    /// GitHub, unless `INVINCIBLE_RELEASES` points at a test release on loopback; only then may
    /// `INVINCIBLE_RELEASE_KEY` replace the pinned key.
    pub fn from_env() -> Result<Self, String> {
        let Some(root) = std::env::var("INVINCIBLE_RELEASES").ok().filter(|r| !r.is_empty()) else {
            return Ok(Self::default());
        };
        let url = crate::egress::check(&root)?;
        let loopback = url.scheme() == "http";
        let key = match std::env::var("INVINCIBLE_RELEASE_KEY").ok().filter(|k| !k.is_empty()) {
            Some(key) if loopback => key,
            Some(_) => return Err("INVINCIBLE_RELEASE_KEY is only for a test release on loopback".to_owned()),
            None => RELEASE_KEY.to_owned(),
        };
        Ok(Self { root: root.trim_end_matches('/').to_owned(), key })
    }

    /// The directory a release's files download from.
    pub fn base(&self, target: &Target) -> String {
        match target {
            Target::Latest(Channel::Stable) => format!("{}/latest/download", self.root),
            Target::Latest(Channel::Edge) => format!("{}/download/edge", self.root),
            Target::Version(v) => format!("{}/download/v{}", self.root, v.trim_start_matches('v')),
        }
    }
}

/// `<sha256>  <file>` lines (`*<file>` for binary mode, as `sha256sum -b` writes them).
pub fn parse_sums(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (sha, name) = line.split_once(char::is_whitespace)?;
            let name = name.trim_start().trim_start_matches('*').trim();
            (sha.len() == 64 && !name.is_empty()).then(|| (name.to_owned(), sha.to_ascii_lowercase()))
        })
        .collect()
}

/// A release whose `SHA256SUMS` carries the release key's signature.
#[derive(Clone, Debug)]
pub struct Release {
    pub base: String,
    /// What `VERSION` says, when the release has one.
    pub version: Option<String>,
    /// For an older stable release without VERSION: its tag, from where `latest` leads. Only a
    /// hint for "is there anything new"; what is installed is still checked by its signature.
    pub tag: Option<String>,
    pub archive: String,
    pub archive_sha256: String,
}

async fn get(client: &reqwest::Client, url: &str) -> Result<Option<Vec<u8>>, String> {
    let response = client.get(url).send().await.map_err(|e| format!("{url}: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("{url}: {}", response.status()));
    }
    Ok(Some(response.bytes().await.map_err(|e| format!("{url}: {e}"))?.to_vec()))
}

/// The release [target] names, its signature checked.
pub async fn find(
    client: &reqwest::Client,
    source: &Source,
    target: &Target,
    platform: &str,
) -> Result<Release, String> {
    let base = source.base(target);
    let (sums_url, sig_url) = (format!("{base}/SHA256SUMS"), format!("{base}/SHA256SUMS.sig"));
    let (sums, sig) = tokio::join!(get(client, &sums_url), get(client, &sig_url));
    let what = match target {
        Target::Latest(channel) => format!("the {channel} channel"),
        Target::Version(v) => format!("v{}", v.trim_start_matches('v')),
    };
    let sums = sums?.ok_or(format!("no release for {what} ({base})"))?;
    let sig = sig?.ok_or(format!("the release for {what} is not signed (no SHA256SUMS.sig); not using it"))?;
    crate::sshsig::verify(&source.key, NAMESPACE, &sums, &String::from_utf8_lossy(&sig)).map_err(|e| {
        format!("the release's SHA256SUMS is not signed with the Invincible release key ({e}); not using it")
    })?;
    let listed = parse_sums(&String::from_utf8_lossy(&sums));
    let archive = format!("invincible-{platform}.tar.gz");
    let archive_sha256 = listed.get(&archive).cloned().ok_or(format!("the release has nothing for {platform}"))?;
    let version = match listed.get("VERSION") {
        Some(expected) => {
            let text =
                get(client, &format!("{base}/VERSION")).await?.ok_or("the release lists VERSION but has none")?;
            let got = crate::token::hex(&Sha256::digest(&text));
            if &got != expected {
                return Err(format!("VERSION: SHA-256 {got}, the signed one is {expected}; not using the release"));
            }
            Some(String::from_utf8_lossy(&text).trim().to_owned())
        }
        None => None,
    };
    let tag = match (&version, target) {
        (None, Target::Latest(Channel::Stable)) => latest_tag(client, source).await,
        _ => None,
    };
    Ok(Release { base, version, tag, archive, archive_sha256 })
}

/// Where `<releases>/latest` leads: `…/releases/tag/v0.0.12` → `0.0.12`.
async fn latest_tag(client: &reqwest::Client, source: &Source) -> Option<String> {
    let response = client.head(format!("{}/latest", source.root)).send().await.ok()?;
    let last = response.url().path_segments()?.next_back()?.to_owned();
    let version = last.strip_prefix('v')?;
    crate::version::Version::parse(version).ok().map(|_| version.to_owned())
}

/// What `invincible update` (and install.sh) record about the binaries they installed:
/// `$INVINCIBLE_HOME/installed`, `key=value` lines.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Installed {
    pub fields: Vec<(String, String)>,
}

impl Installed {
    pub fn path(home: &Path) -> PathBuf {
        home.join("installed")
    }

    pub fn load(home: &Path) -> Self {
        let text = std::fs::read_to_string(Self::path(home)).unwrap_or_default();
        let fields = text
            .lines()
            .filter_map(|l| l.split_once('=').map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())))
            .collect();
        Self { fields }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, key: &str, value: &str) {
        self.fields.retain(|(k, _)| k != key);
        self.fields.push((key.to_owned(), value.to_owned()));
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        let text: String = self.fields.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
        std::fs::create_dir_all(home).map_err(|e| format!("{}: {e}", home.display()))?;
        let path = Self::path(home);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
    }
}

pub fn sha256_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(crate::token::hex(&hasher.finalize()))
}

/// One update.
pub struct Options<'a> {
    pub client: &'a reqwest::Client,
    pub source: &'a Source,
    pub target: Target,
    pub platform: &'a str,
    /// Where `invincible` and `autobot` are.
    pub bin: PathBuf,
    /// `$INVINCIBLE_HOME`: the record of what is installed, and the download cache.
    pub home: PathBuf,
    /// What is installed now.
    pub current: String,
    /// Only say what would happen.
    pub check: bool,
    /// Install even when the versions say there is nothing to do.
    pub force: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to do: [version] is installed (or newer, when [ahead]).
    UpToDate { version: String, ahead: bool },
    /// `--check`: [version] (or a build of unknown version) is there to install.
    Available { version: Option<String> },
    /// Installed: the programs that changed.
    Updated { from: String, to: String, changed: Vec<String> },
}

/// Runs one update; see the module docs for the steps.
pub async fn run(options: Options<'_>) -> Result<Outcome, String> {
    let channel = options.target.channel();
    let release = find(options.client, options.source, &options.target, options.platform).await?;
    let installed = Installed::load(&options.home);
    // Known to be the same bytes: nothing to fetch.
    let same_archive = installed.get("archive_sha256") == Some(release.archive_sha256.as_str())
        && PROGRAMS.iter().all(|p| {
            sha256_file(&options.bin.join(p)).is_some_and(|sha| installed.get(&format!("{p}_sha256")) == Some(&sha))
        });
    if !options.force {
        let decision = match (&release.version, &options.target) {
            (Some(v), Target::Version(_)) if v == &options.current => Decision::UpToDate,
            (Some(_), Target::Version(_)) => Decision::Update,
            (Some(v), Target::Latest(_)) => decide(&options.current, v, channel),
            (None, _) if same_archive => Decision::UpToDate,
            (None, _) => match &release.tag {
                Some(tag) => decide(&options.current, tag, channel),
                None => Decision::Update,
            },
        };
        match decision {
            Decision::UpToDate => {
                return Ok(Outcome::UpToDate { version: options.current.clone(), ahead: false });
            }
            Decision::Ahead => return Ok(Outcome::UpToDate { version: options.current.clone(), ahead: true }),
            Decision::Update => {}
        }
    }
    if options.check {
        return Ok(Outcome::Available { version: release.version.clone().or(release.tag.clone()) });
    }

    let cache = options.home.join("cache");
    let archive = cache.join(format!("{}-{}", &release.archive_sha256[..12], release.archive));
    crate::models::download(
        options.client,
        &format!("{}/{}", release.base, release.archive),
        &archive,
        &release.archive_sha256,
        |_, _| {},
    )
    .await
    .map_err(|e| format!("{}: {e}", release.archive))?;

    let unpacked = unpack(&archive, &options.bin)?;
    let result = swap(&unpacked, &options, &release);
    let _ = std::fs::remove_dir_all(&unpacked);
    let _ = std::fs::remove_file(&archive);
    let changed = result?;
    let to = release.version.clone().unwrap_or_else(|| version_of(&options.bin.join("invincible")));
    let mut record = installed;
    record.set("version", &to);
    record.set("channel", channel.name());
    record.set("bin", &options.bin.display().to_string());
    record.set("archive_sha256", &release.archive_sha256);
    for p in PROGRAMS {
        if let Some(sha) = sha256_file(&options.bin.join(p)) {
            record.set(&format!("{p}_sha256"), &sha);
        }
    }
    record.save(&options.home)?;
    if changed.is_empty() {
        return Ok(Outcome::UpToDate { version: to, ahead: false });
    }
    Ok(Outcome::Updated { from: options.current.clone(), to, changed })
}

/// The version a program says it is (`invincible 0.0.12` → `0.0.12`).
pub fn version_of(program: &Path) -> String {
    std::process::Command::new(program)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().nth(1).map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Unpacks [archive] into a new directory in [bin] (so the final rename stays on one file system).
fn unpack(archive: &Path, bin: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin).map_err(|e| format!("{}: {e}", bin.display()))?;
    let suffix = crate::token::hex(&crate::token::random::<4>()?);
    let dir = bin.join(format!(".invincible-update-{suffix}"));
    std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let out = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&dir)
        .output()
        .map_err(|e| format!("tar: {e}"));
    match out {
        Ok(o) if o.status.success() => Ok(dir),
        Ok(o) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(format!("tar: {}", String::from_utf8_lossy(&o.stderr).trim()))
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// Puts the unpacked programs in place of the installed ones; returns those that changed.
fn swap(unpacked: &Path, options: &Options<'_>, release: &Release) -> Result<Vec<String>, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = unpacked.join(format!("invincible-{}", options.platform));
    let mut ready = Vec::new();
    for program in PROGRAMS {
        let new = dir.join(program);
        let sha = sha256_file(&new).ok_or(format!("the release's archive has no {program}"))?;
        if sha256_file(&options.bin.join(program)).as_deref() == Some(sha.as_str()) {
            continue;
        }
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("{}: {e}", new.display()))?;
        // It must run here before it replaces anything.
        let ran = std::process::Command::new(&new).arg("--version").output();
        if !ran.as_ref().is_ok_and(|o| o.status.success()) {
            return Err(format!("the new {program} does not run on this machine; nothing was replaced"));
        }
        if let Some(expected) = &release.version {
            let said = String::from_utf8_lossy(&ran.map(|o| o.stdout).unwrap_or_default()).to_string();
            if said.split_whitespace().nth(1) != Some(expected.as_str()) {
                return Err(format!(
                    "the new {program} says it is {:?}, the release says {expected}; nothing was replaced",
                    said.trim()
                ));
            }
        }
        ready.push((program, new));
    }
    let mut changed = Vec::new();
    for (program, new) in ready {
        let dest = options.bin.join(program);
        std::fs::rename(&new, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        changed.push(program.to_owned());
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::{Installed, Source, Target, parse_sums};
    use crate::version::Channel;

    #[test]
    fn reads_sha256sums() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let text = format!("{a}  invincible-linux-x64.tar.gz\n{b} *VERSION\nnot a line\n");
        let sums = parse_sums(&text);
        assert_eq!(sums.get("invincible-linux-x64.tar.gz"), Some(&a));
        assert_eq!(sums.get("VERSION"), Some(&"b".repeat(64)));
        assert_eq!(sums.len(), 2);
    }

    #[test]
    fn finds_each_channel() {
        let s = Source::default();
        let root = "https://github.com/wckdboy/invincible/releases";
        assert_eq!(s.base(&Target::Latest(Channel::Stable)), format!("{root}/latest/download"));
        assert_eq!(s.base(&Target::Latest(Channel::Edge)), format!("{root}/download/edge"));
        assert_eq!(s.base(&Target::Version("v0.0.11".into())), format!("{root}/download/v0.0.11"));
        assert_eq!(Target::Version("0.0.12-edge.abc".into()).channel(), Channel::Edge);
    }

    #[test]
    fn records_what_is_installed() {
        let dir = std::env::temp_dir().join(format!("invincible-installed-{}", std::process::id()));
        let mut record = Installed::load(&dir);
        assert_eq!(record.get("version"), None);
        record.set("version", "0.0.1");
        record.set("version", "0.0.2");
        record.save(&dir).unwrap();
        let loaded = Installed::load(&dir);
        assert_eq!(loaded.get("version"), Some("0.0.2"));
        assert_eq!(loaded.fields.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
