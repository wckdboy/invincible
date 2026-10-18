//! `invincible model add`: fetch open weights, verify them, check they fit, add them to the config.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::egress;

/// Where a model comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// `hf:<owner>/<repo>/<path in repo>` — a file on Hugging Face, `main` branch.
    HuggingFace { repo: String, file: String },
    /// An HTTPS URL; needs `--sha256`.
    Url(String),
}

impl Source {
    pub fn parse(text: &str) -> Result<Self, String> {
        if let Some(rest) = text.strip_prefix("hf:") {
            let mut parts = rest.splitn(3, '/');
            match (parts.next(), parts.next(), parts.next()) {
                (Some(owner), Some(repo), Some(file)) if !owner.is_empty() && !repo.is_empty() && !file.is_empty() => {
                    if file.split('/').any(|p| p == ".." || p.is_empty()) {
                        return Err(format!("{text}: bad file path"));
                    }
                    Ok(Self::HuggingFace { repo: format!("{owner}/{repo}"), file: file.to_owned() })
                }
                _ => Err(format!("{text}: expected hf:<owner>/<repo>/<file>")),
            }
        } else {
            egress::check(text)?;
            Ok(Self::Url(text.to_owned()))
        }
    }

    pub fn url(&self) -> String {
        match self {
            Self::HuggingFace { repo, file } => format!("https://huggingface.co/{repo}/resolve/main/{file}"),
            Self::Url(url) => url.clone(),
        }
    }

    /// The local file name: the last path segment, cleaned.
    pub fn file_name(&self) -> Result<String, String> {
        let url = self.url();
        let last = url.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
        let name: String =
            last.chars().map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
        if name.is_empty() || name.starts_with('.') {
            return Err(format!("{url}: no file name"));
        }
        Ok(name)
    }
}

/// What Hugging Face lists for a file: its SHA-256 and size (from the LFS pointer).
pub async fn hugging_face_listing(
    client: &reqwest::Client,
    repo: &str,
    file: &str,
) -> Result<(String, Option<u64>), String> {
    let dir = file.rsplit_once('/').map(|(d, _)| format!("/{d}")).unwrap_or_default();
    let url = format!("https://huggingface.co/api/models/{repo}/tree/main{dir}");
    let listing: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("{url}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let entry = listing
        .as_array()
        .and_then(|entries| entries.iter().find(|e| e["path"] == file))
        .ok_or(format!("{repo} has no file {file}"))?;
    let sha = entry["lfs"]["oid"].as_str().ok_or(format!("{file}: Hugging Face lists no SHA-256 for it"))?;
    Ok((sha.to_ascii_lowercase(), entry["lfs"]["size"].as_u64().or(entry["size"].as_u64())))
}

/// Downloads [url] to [dest], resuming a `<dest>.partial` left by an earlier attempt, and keeps the
/// file only when its SHA-256 is [sha256]. [progress] gets (bytes so far, total if known).
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    egress::check(url)?;
    let partial = PathBuf::from(format!("{}.partial", dest.display()));
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }

    // Hash what an earlier attempt already fetched, then ask for the rest.
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if let Ok(mut file) = std::fs::File::open(&partial) {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("{}: {e}", partial.display()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }
    let mut request = client.get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    if have > 0 && status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // The partial file is already whole (or wrong); start over to be sure.
        let _ = std::fs::remove_file(&partial);
        return Box::pin(download(client, url, dest, sha256, progress)).await;
    }
    if !status.is_success() {
        return Err(format!("{url}: {status}"));
    }
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if have > 0 && !resumed {
        // The server ignored the range: it is sending the whole file again.
        hasher = Sha256::new();
        have = 0;
    }
    let total = response.content_length().map(|len| len + have);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&partial)
        .map_err(|e| format!("{}: {e}", partial.display()))?;
    progress(have, total);
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("{url}: {e} (run again to resume)"))? {
        file.write_all(&chunk).map_err(|e| format!("{}: {e}", partial.display()))?;
        hasher.update(&chunk);
        have += chunk.len() as u64;
        progress(have, total);
    }
    file.sync_all().map_err(|e| format!("{}: {e}", partial.display()))?;

    let got = crate::token::hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("SHA-256 mismatch: expected {sha256}, got {got}; the download was deleted"));
    }
    std::fs::rename(&partial, dest).map_err(|e| format!("{}: {e}", dest.display()))
}

/// Memory a model can use on this machine, in bytes, and where the number comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Budget {
    pub bytes: u64,
    pub source: String,
}

/// Rough by design: NVIDIA → 90% of all VRAM (full offload); Apple silicon → 70% of unified memory
/// (Metal's default working-set limit is around there); otherwise → 80% of RAM.
pub fn memory_budget() -> Option<Budget> {
    if let Some(vram) = nvidia_vram() {
        return Some(Budget { bytes: vram / 10 * 9, source: format!("90% of {} NVIDIA VRAM", gib(vram)) });
    }
    let ram = total_ram()?;
    if cfg!(target_os = "macos") {
        Some(Budget { bytes: ram / 10 * 7, source: format!("70% of {} unified memory", gib(ram)) })
    } else {
        Some(Budget { bytes: ram / 10 * 8, source: format!("80% of {} RAM", gib(ram)) })
    }
}

/// What a model of [file_size] bytes needs: the weights, 10% for buffers, and 512 MiB for the
/// context cache and the engine. The real cache depends on the architecture and context size.
pub fn needed(file_size: u64) -> u64 {
    file_size + file_size / 10 + (512 << 20)
}

pub fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / (1u64 << 30) as f64)
}

fn nvidia_vram() -> Option<u64> {
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mib: u64 = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<u64>().ok()).sum();
    (mib > 0).then_some(mib << 20)
}

fn total_ram() -> Option<u64> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        return String::from_utf8_lossy(&out.stdout).trim().parse().ok();
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kib: u64 = meminfo.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib << 10)
}

/// Appends a `[[models]]` entry to the config file, keeping its comments and layout.
pub fn add_to_config(config: &Path, id: &str, path: &Path, context: Option<u64>) -> Result<(), String> {
    let text = std::fs::read_to_string(config).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("{}: {e}", config.display()))?;
    let models = doc
        .entry("models")
        .or_insert_with(|| toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()))
        .as_array_of_tables_mut()
        .ok_or(format!("{}: `models` is not a list of [[models]] tables", config.display()))?;
    if models.iter().any(|t| t.get("id").and_then(|v| v.as_str()) == Some(id)) {
        return Err(format!("a model with id {id:?} is already configured"));
    }
    let mut table = toml_edit::Table::new();
    table.insert("id", toml_edit::value(id));
    table.insert("path", toml_edit::value(path.display().to_string()));
    if let Some(context) = context {
        table.insert("context", toml_edit::value(i64::try_from(context).map_err(|e| e.to_string())?));
    }
    models.push(table);
    // Write through a temporary file so a crash never leaves half a config.
    let tmp = config.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, config).map_err(|e| format!("{}: {e}", config.display()))
}

#[cfg(test)]
mod tests {
    use super::{Source, add_to_config, needed};

    #[test]
    fn sources() {
        assert_eq!(
            Source::parse("hf:Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf").unwrap(),
            Source::HuggingFace { repo: "Qwen/Qwen3-0.6B-GGUF".into(), file: "Qwen3-0.6B-Q8_0.gguf".into() }
        );
        let nested = Source::parse("hf:a/b/sub/dir/m.gguf").unwrap();
        assert_eq!(nested.url(), "https://huggingface.co/a/b/resolve/main/sub/dir/m.gguf");
        assert_eq!(nested.file_name().unwrap(), "m.gguf");
        assert!(Source::parse("hf:a/b").is_err());
        assert!(Source::parse("hf:a/b/../x.gguf").is_err());
        assert!(Source::parse("http://example.com/m.gguf").is_err());
        assert_eq!(Source::parse("https://x.org/m%20v2.gguf?dl=1").unwrap().file_name().unwrap(), "m_20v2.gguf");
    }

    #[test]
    fn needs_weights_plus_headroom() {
        assert_eq!(needed(1 << 30), (1 << 30) + (1 << 30) / 10 + (512 << 20));
    }

    #[test]
    fn config_entries_are_appended_with_comments_kept() {
        let dir = std::env::temp_dir().join(format!("invincible-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        std::fs::write(&config, "# my node\nlisten = \"127.0.0.1:7777\" # loopback\n").unwrap();
        add_to_config(&config, "small", &dir.join("small.gguf"), Some(4096)).unwrap();
        add_to_config(&config, "large", &dir.join("large.gguf"), None).unwrap();
        assert!(add_to_config(&config, "small", &dir.join("x.gguf"), None).unwrap_err().contains("already"));
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.starts_with("# my node\nlisten = \"127.0.0.1:7777\" # loopback\n"));
        let parsed = crate::config::Config::parse(&text).unwrap();
        assert_eq!(parsed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["small", "large"]);
        assert_eq!(parsed.models[0].context, Some(4096));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
