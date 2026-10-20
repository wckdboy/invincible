//! Backups of the autobot home (`autobot backup`, `autobot restore`, `[backup] every`).
//!
//! One `.tar.gz` (plain ustar, so `tar tzf` reads it too): every file of the home under `home/`,
//! then `MANIFEST.json` with each file's size, mode and SHA-256, and what was left out and why.
//! Secrets (`*.token`, `*.password`, `*.secret`, `*.key`, `*.pem`, `.env`, `secrets/`) stay out
//! unless asked for; logs, backups, the working directory, downloaded speech models and links
//! stay out always. A restore checks every file against the manifest before it touches the
//! home, builds the new home beside it, keeps what the backup does not cover (the secrets it
//! left out, the working directory, the logs) and keeps the old home as it was, to go back to.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The manifest's format; a restore refuses newer ones.
pub const FORMAT: u32 = 1;
const MANIFEST: &str = "MANIFEST.json";
const PREFIX: &str = "home/";
/// The largest file a backup takes in (and a restore reads).
const MAX_FILE: u64 = 4 << 30;

/// Directories a backup leaves out, in the home and in each bot's (`bots/<name>/…`).
const SKIPPED: &[(&str, &str)] = &[
    ("logs", "logs"),
    ("backups", "backups"),
    ("work", "the working directory"),
    ("whisper", "speech models (downloaded again)"),
];

/// Files a backup leaves out: state of this machine's running agent.
const MACHINE: &[&str] = &["alerts.json"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub format: u32,
    /// When it was made (RFC 3339).
    pub created: String,
    /// The autobot that made it.
    pub version: String,
    /// The home it was made from.
    pub home: String,
    /// Whether the secrets are in it.
    pub secrets: bool,
    pub files: Vec<Entry>,
    pub excluded: Vec<Excluded>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub mode: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Excluded {
    pub path: String,
    pub why: String,
}

/// Configuration: `[backup]`.
///
/// ```toml
/// [backup]
/// every = "1d"            # a backup this often while `autobot serve` runs; "off" (the default)
/// keep = 7                # the newest this many in `dir`; older ones are removed
/// dir = "~/backups"       # [default: $AUTOBOT_HOME/backups]
/// secrets = false         # the tokens and passwords too
/// ```
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BackupConfig {
    #[serde(default = "off")]
    pub every: String,
    #[serde(default = "keep")]
    pub keep: usize,
    #[serde(default)]
    pub dir: Option<PathBuf>,
    #[serde(default)]
    pub secrets: bool,
}

fn off() -> String {
    "off".to_owned()
}

fn keep() -> usize {
    7
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self { every: off(), keep: keep(), dir: None, secrets: false }
    }
}

impl BackupConfig {
    /// How often; None when scheduled backups are off.
    pub fn every(&self) -> Result<Option<std::time::Duration>, String> {
        let text = self.every.trim();
        if text == "off" {
            return Ok(None);
        }
        match crate::cron::When::parse(&format!("every {text}")) {
            Ok(crate::cron::When::Every(every)) => Ok(Some(every.max(std::time::Duration::from_secs(3600)))),
            _ => Err(format!("[backup] every = {text:?}: an interval like 1d or 12h, or off")),
        }
    }

    pub fn dir(&self, home: &Path) -> PathBuf {
        self.dir.as_deref().map(crate::config::expand).unwrap_or_else(|| home.join("backups"))
    }
}

/// Whether [rel] (a path in the home) is a secret.
pub fn is_secret(rel: &Path) -> bool {
    if rel.components().any(|c| c.as_os_str() == "secrets") {
        return true;
    }
    let name = rel.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let ext = rel.extension().and_then(|e| e.to_str()).unwrap_or_default();
    name == ".env" || ["token", "password", "secret", "key", "pem"].contains(&ext)
}

/// Why a directory or file at [rel] is never backed up; None when it is.
fn skipped(rel: &Path) -> Option<&'static str> {
    let parts: Vec<&std::ffi::OsStr> = rel.components().map(Component::as_os_str).collect();
    let (name, top) = match parts.as_slice() {
        [name] => (*name, true),
        [bots, _, name] if *bots == "bots" => (*name, true),
        _ => (parts.last().copied().unwrap_or_default(), false),
    };
    if top && let Some((_, why)) = SKIPPED.iter().find(|(n, _)| name == *n) {
        return Some(why);
    }
    if top && MACHINE.iter().any(|n| name == *n) {
        return Some("this machine's alert state");
    }
    None
}

/// What a backup of [home] takes in: the files (relative paths), and what it leaves out.
pub struct Contents {
    pub files: Vec<PathBuf>,
    pub excluded: Vec<Excluded>,
}

/// Walks [home]: what a backup takes (secrets only with [secrets]); [also_skip]: absolute paths
/// left out too (where the backups go).
pub fn contents(home: &Path, secrets: bool, also_skip: &[PathBuf]) -> Result<Contents, String> {
    let mut found = Contents { files: Vec::new(), excluded: Vec::new() };
    walk(home, Path::new(""), secrets, also_skip, &mut found)?;
    found.files.sort();
    found.excluded.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

fn walk(home: &Path, rel: &Path, secrets: bool, also_skip: &[PathBuf], found: &mut Contents) -> Result<(), String> {
    let dir = home.join(rel);
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .map(|e| e.file_name())
        .collect();
    entries.sort();
    for name in entries {
        let rel = rel.join(&name);
        let path = home.join(&rel);
        let shown = crate::slash(&rel);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        let exclude = |why: &str, found: &mut Contents| {
            let path = if meta.is_dir() { format!("{shown}/") } else { shown.clone() };
            found.excluded.push(Excluded { path, why: why.to_owned() });
        };
        if also_skip.iter().any(|s| s == &path) {
            exclude("backups", found);
        } else if shown.contains('\\') {
            // Kept as written, a name with a backslash would not come back the same.
            exclude("a name with a backslash", found);
        } else if let Some(why) = skipped(&rel) {
            exclude(why, found);
        } else if meta.file_type().is_symlink() {
            exclude("a link", found);
        } else if meta.is_dir() {
            if !secrets && is_secret(&rel) {
                exclude("secrets (--include-secrets takes them)", found);
            } else {
                walk(home, &rel, secrets, also_skip, found)?;
            }
        } else if !meta.is_file() {
            exclude("not a regular file", found);
        } else if !secrets && is_secret(&rel) {
            exclude("a secret (--include-secrets takes it)", found);
        } else if meta.len() > MAX_FILE {
            exclude("over 4 GiB", found);
        } else if std::str::from_utf8(rel.as_os_str().as_encoded_bytes()).is_err() {
            exclude("a name that is not UTF-8", found);
        } else {
            found.files.push(rel);
        }
    }
    Ok(())
}

fn mode_of(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0o600
    }
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o777))
            .map_err(|e| format!("{}: {e}", path.display()))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// The SHA-256 of what [reader] gives, read in pieces, and how many bytes it gave.
fn hash_reader(
    reader: &mut dyn Read,
    mut also: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0u64;
    loop {
        let got = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(got) => got,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        };
        hasher.update(&buf[..got]);
        also(&buf[..got])?;
        n += got as u64;
    }
    Ok((n, invincible::token::hex(&hasher.finalize())))
}

/// [path]'s SHA-256, read in pieces.
fn hash_file(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    hash_reader(&mut file, |_| Ok(())).ok().map(|(_, sha)| sha)
}

/// [path], or what it resolves to.
fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_owned())
}

/// A file for the archive, only the owner can read it.
fn private_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The usual name for a backup made [at]: `autobot-backup-20261020-031500.tar.gz`.
pub fn file_name(at: chrono::DateTime<chrono::Local>) -> String {
    format!("autobot-backup-{}.tar.gz", at.format("%Y%m%d-%H%M%S"))
}

/// Writes a backup of [home] to [out] (through a temporary file beside it; never over an
/// existing file): its manifest.
pub fn write(home: &Path, out: &Path, secrets: bool, also_skip: &[PathBuf]) -> Result<Manifest, String> {
    if out.exists() {
        return Err(format!("{} already exists", out.display()));
    }
    let mut skip = also_skip.to_vec();
    if let Some(dir) = out.parent().and_then(|d| d.canonicalize().ok()) {
        skip.push(dir.join(out.file_name().unwrap_or_default()));
    }
    let home_real = home.canonicalize().map_err(|e| format!("{}: {e}", home.display()))?;
    let skip: Vec<PathBuf> = skip.iter().map(|p| canon(p)).collect();
    let found = contents(&home_real, secrets, &skip)?;
    let tmp = out.with_extension(format!("partial-{}", std::process::id()));
    let result = (|| {
        let file = private_file(&tmp)?;
        let mut tar = Tar(flate2::write::GzEncoder::new(std::io::BufWriter::new(file), flate2::Compression::default()));
        let mut manifest = Manifest {
            format: FORMAT,
            created: chrono::Local::now().to_rfc3339(),
            version: invincible::version::VERSION.to_owned(),
            home: home.display().to_string(),
            secrets,
            files: Vec::new(),
            excluded: found.excluded,
        };
        for rel in &found.files {
            let path = home_real.join(rel);
            let opened = std::fs::File::open(&path).and_then(|f| f.metadata().map(|m| (f, m)));
            let (mut file, meta) = match opened {
                Ok(found) => found,
                // Gone since the walk (a session pruned, a temporary file renamed): left out.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("{}: {e}", path.display())),
            };
            let name = crate::slash(rel);
            let mode = mode_of(&meta);
            // As much as it had when opened (a log or a conversation may grow meanwhile).
            let size = meta.len();
            let sha256 = tar
                .file_from(&format!("{PREFIX}{name}"), mode, size, &mut (&mut file).take(size))
                .map_err(|e| format!("{}: {e}", path.display()))?;
            manifest.files.push(Entry { path: name, size, mode, sha256 });
        }
        let text = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        tar.file(MANIFEST, 0o600, &text)?;
        let file = tar.finish()?.into_inner().map_err(|e| format!("{}: {e}", tmp.display()))?;
        file.sync_all().map_err(|e| format!("{}: {e}", tmp.display()))?;
        Ok(manifest)
    })();
    match result {
        Ok(manifest) => {
            std::fs::rename(&tmp, out).map_err(|e| format!("{}: {e}", out.display()))?;
            Ok(manifest)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Reads the backup at [archive], calling [each] with every file (its path in the home, mode
/// and contents, to read) as it comes; then checks them against the manifest (every file
/// there, with its checksum and mode, and nothing else): the manifest, when they all match.
pub fn read(
    archive: &Path,
    mut each: impl FnMut(&str, u32, &mut dyn Read) -> Result<(), String>,
) -> Result<Manifest, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    let mut reader = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut seen: BTreeMap<String, (u64, String, u32)> = BTreeMap::new();
    let mut manifest: Option<Manifest> = None;
    let not_backup = |why: String| format!("{} is not a whole autobot backup: {why}", archive.display());
    read_tar(&mut reader, |name, mode, data| {
        if name == MANIFEST {
            let mut text = Vec::new();
            data.take(256 << 20).read_to_end(&mut text).map_err(|e| format!("{MANIFEST}: {e}"))?;
            let m: Manifest = serde_json::from_slice(&text).map_err(|e| format!("{MANIFEST}: {e}"))?;
            if m.format > FORMAT {
                return Err(format!("made by a newer autobot ({}, format {}); update first", m.version, m.format));
            }
            manifest = Some(m);
            return Ok(());
        }
        let rel = name.strip_prefix(PREFIX).ok_or_else(|| format!("{name}: outside home/"))?;
        if !safe(rel) {
            return Err(format!("{name}: not a plain path in the home"));
        }
        if seen.contains_key(rel) {
            return Err(format!("{name}: twice"));
        }
        // What [each] reads is hashed on the way, and the rest after it.
        let mut hashing = Hashing { inner: data, hasher: Sha256::new(), n: 0 };
        each(rel, mode, &mut hashing)?;
        std::io::copy(&mut hashing, &mut std::io::sink()).map_err(|e| e.to_string())?;
        let sha = invincible::token::hex(&hashing.hasher.finalize());
        seen.insert(rel.to_owned(), (hashing.n, sha, mode & 0o777));
        Ok(())
    })
    .map_err(not_backup)?;
    let manifest = manifest.ok_or_else(|| not_backup(format!("no {MANIFEST}")))?;
    let listed: BTreeSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    for entry in &manifest.files {
        match seen.get(&entry.path) {
            None => return Err(not_backup(format!("{} is missing", entry.path))),
            Some((size, sha, _)) if *size != entry.size || *sha != entry.sha256 => {
                return Err(not_backup(format!("{} does not match its checksum", entry.path)));
            }
            Some((_, _, mode)) if *mode != entry.mode & 0o777 => {
                return Err(not_backup(format!("{} does not have the mode the manifest says", entry.path)));
            }
            Some(_) => {}
        }
    }
    if let Some(extra) = seen.keys().find(|k| !listed.contains(k.as_str())) {
        return Err(not_backup(format!("{extra} is not in the manifest")));
    }
    Ok(manifest)
}

/// A reader that hashes and counts what goes through it.
struct Hashing<'a> {
    inner: &'a mut dyn Read,
    hasher: Sha256,
    n: u64,
}

impl Read for Hashing<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let got = self.inner.read(buf)?;
        self.hasher.update(&buf[..got]);
        self.n += got as u64;
        Ok(got)
    }
}

/// Whether [rel] is a relative path of plain names (no `..`, no root, nothing empty).
fn safe(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\0')
        && !rel.contains('\\')
        && rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
        && Path::new(rel).components().all(|c| matches!(c, Component::Normal(_)))
}

/// What a restore of a backup would do to the home.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Files the home does not have now.
    pub added: Vec<String>,
    /// Files the home has, different.
    pub changed: Vec<String>,
    /// Files the home has that the backup does not: not there after the restore.
    pub removed: Vec<String>,
    pub same: usize,
    /// What stays as it is (not in the backup): secrets it left out, the working directory, logs.
    pub kept: Vec<String>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }
}

/// Checks the backup at [archive] and compares it with [home] now; [also_skip]: paths in the
/// home backups leave out too (a backup directory of its own, `[backup] dir`).
pub fn plan(archive: &Path, home: &Path, also_skip: &[PathBuf]) -> Result<(Manifest, Plan), String> {
    let manifest = read(archive, |_, _, _| Ok(()))?;
    let (ours, kept) = if home.exists() {
        let skip: Vec<PathBuf> = also_skip.iter().map(|p| canon(p)).collect();
        let now = contents(&canon(home), manifest.secrets, &skip)?;
        (now.files, now.excluded.into_iter().map(|e| e.path).collect())
    } else {
        (Vec::new(), Vec::new())
    };
    let mut plan = Plan { kept, ..Plan::default() };
    let ours: BTreeMap<String, PathBuf> = ours.into_iter().map(|rel| (crate::slash(&rel), home.join(rel))).collect();
    for entry in &manifest.files {
        match ours.get(&entry.path) {
            None => plan.added.push(entry.path.clone()),
            Some(path) => {
                let mode = std::fs::metadata(path).map(|m| mode_of(&m)).ok();
                if hash_file(path).as_deref() == Some(entry.sha256.as_str()) && mode == Some(entry.mode & 0o777) {
                    plan.same += 1;
                } else {
                    plan.changed.push(entry.path.clone());
                }
            }
        }
    }
    let theirs: BTreeSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    plan.removed = ours.keys().filter(|k| !theirs.contains(k.as_str())).cloned().collect();
    Ok((manifest, plan))
}

/// What a restore did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Restored {
    /// The home as it was: `<home>.before-restore-<time>` (None: there was none).
    pub previous: Option<PathBuf>,
    /// Moved from it into the restored home: what backups leave out (`work/`, the logs, …).
    pub moved: Vec<String>,
    /// What could not be moved, and why: still in [previous].
    pub left: Vec<String>,
}

/// Restores [home] from the backup at [archive]: built beside it, checked whole, then swapped
/// in; until the swap the home is not touched, and a failure leaves it as it was. What the
/// backup does not cover comes from the home as it was: secrets and links are copied before
/// the swap; the directories backups leave out (the working directory can be large) are moved
/// after it. [also_skip]: as for [plan].
pub fn restore(archive: &Path, home: &Path, also_skip: &[PathBuf]) -> Result<Restored, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let name = home.file_name().ok_or("the home has no name")?.to_string_lossy().into_owned();
    let parent = home.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    // Two restores in a second: `-2`, `-3`, … after the second one.
    let (staging, previous) = (1..100)
        .map(|n| {
            let stamp = if n == 1 { stamp.clone() } else { format!("{stamp}-{n}") };
            (parent.join(format!("{name}.restoring-{stamp}")), parent.join(format!("{name}.before-restore-{stamp}")))
        })
        .find(|(staging, previous)| !staging.exists() && !previous.exists())
        .ok_or_else(|| format!("{name}.before-restore-{stamp}: too many already"))?;
    create_private_dir(&staging)?;
    let built = (|| {
        let manifest = read(archive, |rel, mode, data| {
            let path = staging.join(rel);
            if let Some(dir) = path.parent() {
                create_private_dir(dir)?;
            }
            let mut file = private_file(&path)?;
            std::io::copy(data, &mut file).map_err(|e| format!("{}: {e}", path.display()))?;
            set_mode(&path, mode)
        })?;
        if home.exists() { copy_over(home, &staging, manifest.secrets, also_skip) } else { Ok(Vec::new()) }
    })();
    let to_move = match built {
        Ok(to_move) => to_move,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    if !home.exists() {
        std::fs::rename(&staging, home).map_err(|e| format!("{}: {e}", home.display()))?;
        return Ok(Restored::default());
    }
    std::fs::rename(home, &previous).map_err(|e| format!("{}: {e}", home.display()))?;
    if let Err(e) = std::fs::rename(&staging, home) {
        let _ = std::fs::rename(&previous, home);
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("{}: {e}", home.display()));
    }
    let mut done = Restored { previous: Some(previous.clone()), ..Restored::default() };
    for rel in to_move {
        let (from, to) = (previous.join(&rel), home.join(&rel));
        let moved = to
            .parent()
            .map_or(Ok(()), create_private_dir)
            .and_then(|()| std::fs::rename(&from, &to).map_err(|e| e.to_string()));
        match moved {
            Ok(()) => done.moved.push(rel),
            Err(e) => done.left.push(format!("{rel}: {e}")),
        }
    }
    Ok(done)
}

/// Copies into [staging] the secrets and links of [home] the backup does not cover; what else
/// it does not cover, to move after the swap.
fn copy_over(
    home: &Path,
    staging: &Path,
    secrets_in_backup: bool,
    also_skip: &[PathBuf],
) -> Result<Vec<String>, String> {
    let skip: Vec<PathBuf> = also_skip.iter().map(|p| canon(p)).collect();
    let home = canon(home);
    let now = contents(&home, secrets_in_backup, &skip)?;
    let mut to_move = Vec::new();
    for excluded in now.excluded {
        let rel = excluded.path.trim_end_matches('/').to_owned();
        let (from, to) = (home.join(&rel), staging.join(&rel));
        if std::fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&from) else { continue };
        let copy = meta.file_type().is_symlink() || is_secret(Path::new(&rel));
        if !copy {
            to_move.push(rel);
            continue;
        }
        if let Some(dir) = to.parent() {
            create_private_dir(dir)?;
        }
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            {
                let target = std::fs::read_link(&from).map_err(|e| format!("{}: {e}", from.display()))?;
                std::os::unix::fs::symlink(target, &to).map_err(|e| format!("{}: {e}", to.display()))?;
            }
        } else if meta.is_dir() {
            copy_dir(&from, &to)?;
        } else if meta.is_file() {
            std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    Ok(to_move)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    create_private_dir(to)?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?.flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let Ok(meta) = std::fs::symlink_metadata(&src) else { continue };
        if meta.is_dir() {
            copy_dir(&src, &dst)?;
        } else if meta.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        }
    }
    Ok(())
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir).map_err(|e| format!("{}: {e}", dir.display()))
}

/// The backups in [dir] this module made, oldest first.
pub fn list(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("autobot-backup-") && n.ends_with(".tar.gz"))
        })
        .collect();
    found.sort();
    found
}

/// Removes the oldest backups in [dir] beyond the newest [keep]: the ones removed.
pub fn prune(dir: &Path, keep: usize) -> Vec<PathBuf> {
    let all = list(dir);
    let extra = all.len().saturating_sub(keep.max(1));
    all.into_iter().take(extra).filter(|p| std::fs::remove_file(p).is_ok()).collect()
}

/// A scheduled backup when the newest in the backup directory is older than [every]: where
/// it went, and the old ones removed. None when none was due.
pub fn scheduled(home: &Path, config: &BackupConfig, now: std::time::SystemTime) -> Result<Option<PathBuf>, String> {
    let Some(every) = config.every()? else { return Ok(None) };
    let dir = config.dir(home);
    let newest = list(&dir).last().and_then(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    if newest.is_some_and(|t| now.duration_since(t).unwrap_or_default() < every) {
        return Ok(None);
    }
    create_private_dir(&dir)?;
    let out = dir.join(file_name(chrono::Local::now()));
    write(home, &out, config.secrets, std::slice::from_ref(&dir))?;
    prune(&dir, config.keep);
    Ok(Some(out))
}

/// Runs scheduled backups while `autobot serve` runs: a failure is an alert.
pub async fn scheduler(root: PathBuf) {
    loop {
        let config = crate::bots::load_default(&root).map(|d| d.config.backup);
        let done = match config {
            Ok(config) => {
                let root = root.clone();
                tokio::task::spawn_blocking(move || scheduled(&root, &config, std::time::SystemTime::now()))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()))
            }
            Err(e) => Err(e),
        };
        match done {
            Ok(Some(path)) => {
                tracing::info!("backup: {}", path.display());
                crate::alerts::raise(crate::alerts::Alert::cleared(
                    crate::alerts::Kind::Backup,
                    "backup",
                    "Scheduled backups work again.",
                ));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("backup: {e}");
                crate::alerts::raise(crate::alerts::Alert::new(
                    crate::alerts::Kind::Backup,
                    "backup",
                    format!("The scheduled backup failed: {e}"),
                ));
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
    }
}

/// A tar (ustar, with a PAX header for long names) being written.
struct Tar<W: Write>(flate2::write::GzEncoder<W>);

impl<W: Write> Tar<W> {
    fn file(&mut self, name: &str, mode: u32, data: &[u8]) -> Result<(), String> {
        let mut reader = data;
        self.file_from(name, mode, data.len() as u64, &mut reader).map(drop)
    }

    /// An entry of [size] bytes from [reader], streamed: their SHA-256.
    fn file_from(&mut self, name: &str, mode: u32, size: u64, reader: &mut dyn Read) -> Result<String, String> {
        if size > MAX_FILE {
            return Err(format!("{name}: over 4 GiB"));
        }
        if name.len() > 100 {
            let record = pax_record("path", name);
            let header = header("././@PaxHeader", 0o600, record.len() as u64, b'x');
            self.write(&header)?;
            self.write(record.as_bytes())?;
            self.pad(record.len() as u64)?;
        }
        let short: String = if name.len() > 100 {
            // The PAX path is what counts; this is for readers without PAX.
            let mut end = 100;
            while !name.is_char_boundary(end) {
                end -= 1;
            }
            name[..end].to_owned()
        } else {
            name.to_owned()
        };
        self.write(&header(&short, mode, size, b'0'))?;
        let (got, sha) = hash_reader(reader, |piece| self.write(piece))?;
        if got != size {
            return Err(format!("{name}: shorter than when it was opened ({got} of {size} bytes)"));
        }
        self.pad(size)?;
        Ok(sha)
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.write_all(bytes).map_err(|e| format!("the backup: {e}"))
    }

    fn pad(&mut self, size: u64) -> Result<(), String> {
        let rest = (512 - size % 512) % 512;
        self.write(&vec![0u8; rest as usize])
    }

    fn finish(mut self) -> Result<W, String> {
        self.write(&[0u8; 1024])?;
        self.0.finish().map_err(|e| format!("the backup: {e}"))
    }
}

/// `<length> <key>=<value>\n`, the length counting itself.
fn pax_record(key: &str, value: &str) -> String {
    let body = format!(" {key}={value}\n");
    let mut len = body.len() + 1;
    while format!("{len}{body}").len() != len {
        len += 1;
    }
    format!("{len}{body}")
}

fn header(name: &str, mode: u32, size: u64, kind: u8) -> [u8; 512] {
    let mut h = [0u8; 512];
    h[..name.len().min(100)].copy_from_slice(&name.as_bytes()[..name.len().min(100)]);
    octal(&mut h[100..108], u64::from(mode));
    octal(&mut h[108..116], 0);
    octal(&mut h[116..124], 0);
    octal(&mut h[124..136], size);
    octal(&mut h[136..148], 0);
    h[156] = kind;
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].fill(b' ');
    let sum: u32 = h.iter().map(|b| u32::from(*b)).sum();
    octal(&mut h[148..155], u64::from(sum));
    h
}

/// [value] in octal, zero-padded, NUL-terminated, in [field].
fn octal(field: &mut [u8], value: u64) {
    let width = field.len() - 1;
    let text = format!("{value:0width$o}");
    field[..width].copy_from_slice(&text.as_bytes()[text.len() - width..]);
    field[width] = 0;
}

fn parse_octal(field: &[u8]) -> Result<u64, String> {
    let text: String = field.iter().take_while(|b| **b != 0).map(|b| *b as char).collect();
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).map_err(|_| format!("a bad number in a header: {text:?}"))
}

/// Reads a tar from [reader]: every regular file to [each] (name, mode, contents to read; what
/// it leaves unread is skipped). Directories are skipped; anything else (links, devices) is
/// refused.
fn read_tar(
    reader: &mut impl Read,
    mut each: impl FnMut(&str, u32, &mut dyn Read) -> Result<(), String>,
) -> Result<(), String> {
    let mut long_name: Option<String> = None;
    loop {
        let mut h = [0u8; 512];
        if !read_block(reader, &mut h)? || h.iter().all(|b| *b == 0) {
            return Ok(());
        }
        let stored: u32 = parse_octal(&h[148..156])? as u32;
        let mut copy = h;
        copy[148..156].fill(b' ');
        if copy.iter().map(|b| u32::from(*b)).sum::<u32>() != stored {
            return Err("a header's checksum does not match".to_owned());
        }
        let size = parse_octal(&h[124..136])?;
        if size > MAX_FILE {
            return Err("an entry over 4 GiB".to_owned());
        }
        let field = |range: std::ops::Range<usize>| -> String {
            String::from_utf8_lossy(&h[range]).trim_end_matches('\0').to_owned()
        };
        let name = {
            let (prefix, name) = (field(345..500), field(0..100));
            if prefix.is_empty() { name } else { format!("{prefix}/{name}") }
        };
        let mut entry = reader.by_ref().take(size);
        match h[156] {
            b'x' => {
                let mut data = Vec::new();
                entry.by_ref().take(1 << 20).read_to_end(&mut data).map_err(|e| e.to_string())?;
                long_name = pax_path(&data);
            }
            b'g' => {}
            b'0' | 0 => {
                let name = long_name.take().unwrap_or_else(|| name.clone());
                each(&name, parse_octal(&h[100..108])? as u32, &mut entry)?;
            }
            b'5' => long_name = None,
            other => return Err(format!("{name}: an entry of type {:?}, not a file", other as char)),
        }
        std::io::copy(&mut entry, &mut std::io::sink()).map_err(|e| format!("cut short: {e}"))?;
        if entry.limit() > 0 {
            return Err(format!("{name}: cut short"));
        }
        let rest = (512 - size % 512) % 512;
        let padding =
            std::io::copy(&mut reader.by_ref().take(rest), &mut std::io::sink()).map_err(|e| e.to_string())?;
        if padding != rest {
            return Err("cut short".to_owned());
        }
    }
}

fn read_block(reader: &mut impl Read, block: &mut [u8; 512]) -> Result<bool, String> {
    let mut n = 0;
    while n < block.len() {
        match reader.read(&mut block[n..]) {
            Ok(0) if n == 0 => return Ok(false),
            Ok(0) => return Err("cut short".to_owned()),
            Ok(got) => n += got,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(true)
}

fn pax_path(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    let mut rest = text;
    while !rest.is_empty() {
        let (len, _) = rest.split_once(' ')?;
        let len: usize = len.parse().ok()?;
        let record = rest.get(..len)?;
        rest = &rest[len..];
        let (_, kv) = record.split_once(' ')?;
        if let Some(path) = kv.trim_end_matches('\n').strip_prefix("path=") {
            return Some(path.to_owned());
        }
    }
    None
}

/// What `autobot backup` says about a backup it wrote.
pub fn summary(out: &Path, manifest: &Manifest) -> Vec<String> {
    let bytes: u64 = manifest.files.iter().map(|f| f.size).sum();
    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    let mut lines = vec![format!(
        "backed up {} file(s), {} ({} compressed), to {}",
        manifest.files.len(),
        human_bytes(bytes),
        human_bytes(size),
        out.display()
    )];
    let secrets: Vec<&Excluded> = manifest.excluded.iter().filter(|e| e.why.starts_with("a secret")).collect();
    if manifest.secrets {
        lines.push("secrets included: keep this file as safe as the tokens it holds".to_owned());
    } else if !secrets.is_empty() {
        lines.push(format!(
            "left out {} secret(s) (--include-secrets takes them): {}",
            secrets.len(),
            secrets.iter().map(|e| e.path.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    let others: Vec<String> = manifest
        .excluded
        .iter()
        .filter(|e| !e.why.starts_with("a secret"))
        .map(|e| format!("{} ({})", e.path, e.why))
        .collect();
    if !others.is_empty() {
        lines.push(format!("left out: {}", others.join(", ")));
    }
    lines
}

pub fn human_bytes(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{:.1} KiB", n as f64 / 1024.0),
        1_048_576..1_073_741_824 => format!("{:.1} MiB", n as f64 / 1_048_576.0),
        _ => format!("{:.1} GiB", n as f64 / 1_073_741_824.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("autobot-backup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(home: &Path, rel: &str, text: &str) {
        let path = home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn sample(home: &Path) {
        put(home, "config.toml", "[telegram]\nenabled = true\n");
        put(home, "SOUL.md", "Be brief.");
        put(home, "telegram.token", "123:abc");
        put(home, "secrets/openai.key", "sk-1");
        put(home, "sessions/cli.jsonl", "{\"role\":\"user\"}\n");
        put(home, "sessions/.recall/ab.txt", "summary");
        put(home, "skills/deploy/SKILL.md", "# Deploy");
        put(home, "telegram-users.json", "{}");
        put(home, "memory.jsonl", "{\"fact\":\"x\"}\n");
        put(home, "bots/ops/bot.toml", "[bot]\n");
        put(home, "bots/ops/slack-bot.token", "xoxb");
        put(home, "bots/ops/work/big.bin", "scratch");
        put(home, "logs/agent.log", "log");
        put(home, "work/repo/file.rs", "fn main() {}");
        put(home, "alerts.json", "{}");
        let deep = format!("sessions/{}/x.jsonl", "d".repeat(120));
        put(home, &deep, "deep");
    }

    #[test]
    fn what_is_left_out() {
        let home = tmp("contents");
        sample(&home);
        let found = contents(&home, false, &[]).unwrap();
        let files: Vec<String> = found.files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        assert!(files.contains(&"config.toml".to_owned()));
        assert!(files.contains(&"sessions/.recall/ab.txt".to_owned()));
        assert!(files.contains(&"bots/ops/bot.toml".to_owned()));
        for out in ["telegram.token", "bots/ops/slack-bot.token", "logs/agent.log", "work/repo/file.rs", "alerts.json"]
        {
            assert!(!files.iter().any(|f| f == out), "{out}");
        }
        let excluded: Vec<&str> = found.excluded.iter().map(|e| e.path.as_str()).collect();
        assert!(excluded.contains(&"telegram.token"));
        assert!(excluded.contains(&"secrets/"));
        assert!(excluded.contains(&"bots/ops/work/"));
        assert!(excluded.contains(&"logs/"));
        let with = contents(&home, true, &[]).unwrap();
        assert!(with.files.iter().any(|f| f == Path::new("telegram.token")));
        assert!(with.files.iter().any(|f| f == Path::new("secrets/openai.key")));
        assert!(!with.files.iter().any(|f| f.starts_with("logs")));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn round_trip_with_checksums() {
        let dir = tmp("roundtrip");
        let home = dir.join("home");
        sample(&home);
        let out = dir.join("b.tar.gz");
        let manifest = write(&home, &out, false, &[]).unwrap();
        assert!(!manifest.secrets);
        assert!(manifest.excluded.iter().any(|e| e.path == "telegram.token"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&out).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut got = BTreeMap::new();
        let read_back = read(&out, |rel, _, data| {
            let mut bytes = Vec::new();
            data.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            got.insert(rel.to_owned(), bytes);
            Ok(())
        })
        .unwrap();
        assert_eq!(read_back, manifest);
        assert_eq!(got["SOUL.md"], b"Be brief.");
        let deep = format!("sessions/{}/x.jsonl", "d".repeat(120));
        assert_eq!(got[&deep], b"deep", "long names survive (PAX)");
        assert!(!got.contains_key("telegram.token"));
        // `tar` reads it too.
        if let Ok(o) = std::process::Command::new("tar").arg("tzf").arg(&out).output()
            && o.status.success()
        {
            let listing = String::from_utf8_lossy(&o.stdout);
            assert!(listing.contains("home/SOUL.md") && listing.contains(MANIFEST), "{listing}");
            assert!(listing.contains(&deep), "{listing}");
        }
        assert!(write(&home, &out, false, &[]).is_err(), "never over an existing file");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tampering_is_found() {
        let dir = tmp("tamper");
        let home = dir.join("home");
        put(&home, "SOUL.md", "Be brief.");
        put(&home, "memory.jsonl", "x");
        let out = dir.join("b.tar.gz");
        write(&home, &out, false, &[]).unwrap();
        // The same archive with one file's contents changed (same length).
        let mut entries = Vec::new();
        let file = std::fs::File::open(&out).unwrap();
        read_tar(&mut flate2::read::GzDecoder::new(file), |name, mode, data| {
            let mut bytes = Vec::new();
            data.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            entries.push((name.to_owned(), mode, bytes));
            Ok(())
        })
        .unwrap();
        let rewrite = |entries: &[(String, u32, Vec<u8>)], path: &Path| {
            let file = std::fs::File::create(path).unwrap();
            let mut tar = Tar(flate2::write::GzEncoder::new(file, flate2::Compression::fast()));
            for (name, mode, data) in entries {
                tar.file(name, *mode, data).unwrap();
            }
            tar.finish().unwrap();
        };
        let mut changed = entries.clone();
        changed.iter_mut().find(|e| e.0 == "home/SOUL.md").unwrap().2 = b"Be rude!!".to_vec();
        let bad = dir.join("bad.tar.gz");
        rewrite(&changed, &bad);
        let e = read(&bad, |_, _, _| Ok(())).unwrap_err();
        assert!(e.contains("SOUL.md does not match its checksum"), "{e}");
        let mut missing = entries.clone();
        missing.retain(|e| e.0 != "home/memory.jsonl");
        rewrite(&missing, &bad);
        assert!(read(&bad, |_, _, _| Ok(())).unwrap_err().contains("memory.jsonl is missing"));
        let mut escaping = entries.clone();
        escaping.insert(0, ("home/../evil".to_owned(), 0o644, b"x".to_vec()));
        rewrite(&escaping, &bad);
        assert!(read(&bad, |_, _, _| Ok(())).unwrap_err().contains("not a plain path"));
        let mut extra = entries.clone();
        extra.insert(0, ("home/extra".to_owned(), 0o644, b"x".to_vec()));
        rewrite(&extra, &bad);
        assert!(read(&bad, |_, _, _| Ok(())).unwrap_err().contains("not in the manifest"));
        let no_manifest: Vec<_> = entries.iter().filter(|e| e.0 != MANIFEST).cloned().collect();
        rewrite(&no_manifest, &bad);
        assert!(read(&bad, |_, _, _| Ok(())).unwrap_err().contains("no MANIFEST.json"));
        std::fs::write(&bad, b"not gzip").unwrap();
        assert!(read(&bad, |_, _, _| Ok(())).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restore_keeps_what_the_backup_does_not_cover() {
        let dir = tmp("restore");
        let home = dir.join("home");
        sample(&home);
        let out = dir.join("b.tar.gz");
        write(&home, &out, false, &[]).unwrap();
        // Then the home changes.
        put(&home, "SOUL.md", "Be loud.");
        put(&home, "new-note.md", "later");
        std::fs::remove_file(home.join("memory.jsonl")).unwrap();
        put(&home, "telegram.token", "456:new");
        put(&home, "work/later.txt", "kept");

        let (_, plan) = plan(&out, &home, &[]).unwrap();
        assert_eq!(plan.changed, vec!["SOUL.md"]);
        assert_eq!(plan.added, vec!["memory.jsonl"]);
        assert_eq!(plan.removed, vec!["new-note.md"]);
        assert!(plan.kept.contains(&"telegram.token".to_owned()));
        assert!(plan.kept.contains(&"work/".to_owned()));

        let done = restore(&out, &home, &[]).unwrap();
        let previous = done.previous.clone().unwrap();
        assert!(done.moved.contains(&"work".to_owned()) && done.left.is_empty(), "{done:?}");
        assert_eq!(std::fs::read_to_string(home.join("SOUL.md")).unwrap(), "Be brief.");
        assert!(home.join("memory.jsonl").exists());
        assert!(!home.join("new-note.md").exists());
        // Not in the backup: as they were just before.
        assert_eq!(std::fs::read_to_string(home.join("telegram.token")).unwrap(), "456:new");
        assert_eq!(std::fs::read_to_string(home.join("secrets/openai.key")).unwrap(), "sk-1");
        assert_eq!(std::fs::read_to_string(home.join("work/later.txt")).unwrap(), "kept");
        assert!(home.join("logs/agent.log").exists());
        // The old home, to go back to.
        assert_eq!(std::fs::read_to_string(previous.join("SOUL.md")).unwrap(), "Be loud.");
        assert_eq!(std::fs::read_to_string(previous.join("telegram.token")).unwrap(), "456:new");
        assert!(previous.join("new-note.md").exists());
        let (_, again) = super::plan(&out, &home, &[]).unwrap();
        assert!(again.is_empty(), "{again:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restore_onto_a_new_machine_and_a_failed_one_changes_nothing() {
        let dir = tmp("fresh");
        let home = dir.join("home");
        sample(&home);
        let out = dir.join("b.tar.gz");
        write(&home, &out, true, &[]).unwrap();
        let elsewhere = dir.join("elsewhere");
        assert_eq!(restore(&out, &elsewhere, &[]).unwrap(), Restored::default());
        assert_eq!(std::fs::read_to_string(elsewhere.join("telegram.token")).unwrap(), "123:abc");
        assert!(!elsewhere.join("logs").exists());

        std::fs::write(&out, b"broken").unwrap();
        assert!(restore(&out, &home, &[]).is_err());
        assert_eq!(std::fs::read_to_string(home.join("SOUL.md")).unwrap(), "Be brief.");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".restoring-"))
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scheduled_backups_and_retention() {
        let dir = tmp("schedule");
        let home = dir.join("home");
        put(&home, "SOUL.md", "x");
        let config = BackupConfig { every: "1d".into(), keep: 2, ..Default::default() };
        let first = scheduled(&home, &config, std::time::SystemTime::now()).unwrap().unwrap();
        assert!(first.starts_with(home.join("backups")));
        assert_eq!(scheduled(&home, &config, std::time::SystemTime::now()).unwrap(), None, "not due yet");
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(2 * 86400);
        // Names carry the second: make the next one's differ.
        std::fs::rename(&first, home.join("backups/autobot-backup-20000101-000000.tar.gz")).unwrap();
        let second = scheduled(&home, &config, later).unwrap().unwrap();
        // The backups are not in the backup.
        let m = read(&second, |_, _, _| Ok(())).unwrap();
        assert!(m.files.iter().all(|f| !f.path.starts_with("backups")));
        put(&home, "backups/autobot-backup-19990101-000000.tar.gz", "old");
        let removed = prune(&home.join("backups"), 2);
        assert_eq!(removed.len(), 1);
        assert!(removed[0].ends_with("autobot-backup-19990101-000000.tar.gz"));
        assert_eq!(list(&home.join("backups")).len(), 2);
        assert_eq!(BackupConfig::default().every().unwrap(), None);
        assert!(BackupConfig { every: "soon".into(), ..Default::default() }.every().is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_restore_leaves_the_home_whole() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("failed-restore");
        let home = dir.join("home");
        sample(&home);
        let out = dir.join("b.tar.gz");
        write(&home, &out, false, &[]).unwrap();
        put(&home, "work/big.txt", "kept");
        // A secret it cannot copy: the restore fails before the swap.
        put(&home, "secrets/locked.key", "x");
        std::fs::set_permissions(home.join("secrets/locked.key"), std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(home.join("secrets/locked.key")).is_ok() {
            // Running as root: nothing is unreadable.
            std::fs::remove_dir_all(dir).unwrap();
            return;
        }
        assert!(restore(&out, &home, &[]).is_err());
        assert_eq!(std::fs::read_to_string(home.join("work/big.txt")).unwrap(), "kept");
        assert!(home.join("logs/agent.log").exists());
        let names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.contains(".restoring-") && !n.contains(".before-restore-")), "{names:?}");
        // Nor does a backup leave out a file it cannot read.
        let e = write(&home, &dir.join("c.tar.gz"), true, &[]).unwrap_err();
        assert!(e.contains("locked.key"), "{e}");
        std::fs::set_permissions(home.join("secrets/locked.key"), std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn modes_names_and_a_backup_dir_of_its_own() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("modes");
        let home = dir.join("home");
        put(&home, "SOUL.md", "x");
        put(&home, "skills/run/run.sh", "#!/bin/sh");
        std::fs::set_permissions(home.join("skills/run/run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        put(&home, "odd\\name.md", "y");
        put(&home, "archives/autobot-backup-20000101-000000.tar.gz", "old");
        let archives = home.join("archives");
        let out = dir.join("b.tar.gz");
        let manifest = write(&home, &out, false, std::slice::from_ref(&archives)).unwrap();
        assert!(manifest.files.iter().all(|f| !f.path.contains('\\') && !f.path.starts_with("archives")));
        assert!(manifest.excluded.iter().any(|e| e.path.contains('\\')));
        // Only its mode changed: a change.
        std::fs::set_permissions(home.join("skills/run/run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
        let (_, plan) = plan(&out, &home, std::slice::from_ref(&archives)).unwrap();
        assert_eq!(plan.changed, vec!["skills/run/run.sh"]);
        assert!(plan.removed.is_empty(), "{plan:?}");
        restore(&out, &home, std::slice::from_ref(&archives)).unwrap();
        let mode = std::fs::metadata(home.join("skills/run/run.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert!(home.join("archives/autobot-backup-20000101-000000.tar.gz").exists(), "carried over");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn paths_and_pax() {
        assert!(safe("sessions/a.jsonl"));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b"] {
            assert!(!safe(bad), "{bad}");
        }
        let record = pax_record("path", "x");
        assert_eq!(record, "9 path=x\n");
        // 102 bytes and three digits: 105, which counts itself.
        assert!(pax_record("path", &"y".repeat(95)).starts_with("105 "));
        assert_eq!(pax_record("path", &"y".repeat(95)).len(), 105);
        assert_eq!(pax_path(record.as_bytes()).as_deref(), Some("x"));
        let long = "p".repeat(200);
        assert_eq!(pax_path(pax_record("path", &long).as_bytes()), Some(long));
    }
}
