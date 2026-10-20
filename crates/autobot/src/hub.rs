//! The skills hub: `autobot skills search <query>` and `autobot skills install <name>`.
//!
//! agentskills.io is the format's specification, not a registry: it has no index to search. The
//! public directory of skills in that format is skills.sh (`GET /api/search?q=`), which names
//! each skill by where it lives on GitHub (`owner/repo/skill`). When it cannot be reached, or
//! finds nothing, GitHub's repository search for the `agent-skills` topic is asked instead
//! (without a token: 10 searches a minute).
//!
//! Installing fetches the skill's directory from GitHub (its tree, then each file, at most
//! [MAX_FILES] files and 4 MiB), shows where it comes from, its SKILL.md in full and its files
//! (scripts marked), and installs only when the owner says yes. Nothing in it runs: files are
//! written without the executable bit, and a script is a file the agent may read and, like any
//! command, ask to run.
//!
//! Every request follows the node's network mode (offline: no hub).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

/// Files fetched for one skill at most.
pub const MAX_FILES: usize = 64;
/// Bytes fetched for one skill at most.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Where the hub is asked.
#[derive(Clone)]
pub struct Hub {
    client: reqwest::Client,
    /// skills.sh.
    pub directory: String,
    /// GitHub's REST API.
    pub github: String,
    /// GitHub's raw files.
    pub raw: String,
}

/// A skill the hub knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    /// What `install` takes: `owner/repo/skill`, or `owner/repo` for a repository of skills.
    pub id: String,
    pub name: String,
    /// Where it lives: `owner/repo` on GitHub.
    pub source: String,
    /// Installs (skills.sh) or stars (GitHub).
    pub count: u64,
    pub what: &'static str,
    pub description: String,
}

/// A skill fetched for review, in a directory of its own (removed when this is dropped).
pub struct Fetched {
    pub name: String,
    /// The directory on GitHub it came from.
    pub url: String,
    /// Where it is now.
    pub dir: PathBuf,
    pub skill_md: String,
    /// Its files (relative), their sizes, and whether each is a script.
    pub files: Vec<(String, u64, bool)>,
    /// Files left out (too many, too large).
    pub left_out: Vec<String>,
    root: PathBuf,
}

impl Drop for Fetched {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Whether [path] (and its mode on GitHub) is something that runs.
fn script(path: &str, mode: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    mode == "100755"
        || [".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd", ".php", ".lua"]
            .iter()
            .any(|e| lower.ends_with(e))
}

/// One plain segment of an id: no `.`, `..`, slashes or anything URL-special.
fn segment(text: &str) -> bool {
    !text.is_empty()
        && text != "."
        && text != ".."
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl Hub {
    /// The public hub, reached under the node's network mode.
    pub fn public() -> Result<Self, String> {
        let client = invincible::egress::client(&crate::network()?)?;
        let env = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_owned());
        Ok(Self::at(
            client,
            &env("AUTOBOT_SKILLS_DIRECTORY", "https://skills.sh"),
            &env("AUTOBOT_GITHUB_API", "https://api.github.com"),
            &env("AUTOBOT_GITHUB_RAW", "https://raw.githubusercontent.com"),
        ))
    }

    /// A hub at these addresses (tests use stand-ins).
    pub fn at(client: reqwest::Client, directory: &str, github: &str, raw: &str) -> Self {
        let trim = |s: &str| s.trim_end_matches('/').to_owned();
        Self { client, directory: trim(directory), github: trim(github), raw: trim(raw) }
    }

    async fn get(&self, url: &str) -> Result<reqwest::Response, String> {
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .header("user-agent", "autobot")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("{}: {}", host(url), e.without_url()))?;
        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(format!("{}: {status} (rate limited; try again in a minute)", host(url)));
        }
        if !status.is_success() {
            return Err(format!("{}: {status}", host(url)));
        }
        Ok(response)
    }

    async fn json(&self, url: &str) -> Result<Value, String> {
        self.get(url).await?.json().await.map_err(|e| format!("{}: {}", host(url), e.without_url()))
    }

    /// Skills for [query]: the directory's, else GitHub's `agent-skills` repositories.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<Found>, String> {
        let q = encode(query.trim());
        let directory = self.json(&format!("{}/api/search?q={q}&limit={limit}", self.directory)).await;
        let found: Vec<Found> = match &directory {
            Ok(answer) => answer["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| {
                    let source = s["source"].as_str()?.to_owned();
                    let skill = s["skillId"].as_str().or(s["name"].as_str())?.to_owned();
                    Some(Found {
                        id: format!("{source}/{skill}"),
                        name: s["name"].as_str().unwrap_or(&skill).to_owned(),
                        source,
                        count: s["installs"].as_u64().unwrap_or(0),
                        what: "installs",
                        description: String::new(),
                    })
                })
                .take(limit)
                .collect(),
            Err(_) => Vec::new(),
        };
        if !found.is_empty() {
            return Ok(found);
        }
        let url = format!("{}/search/repositories?q={q}+topic:agent-skills&sort=stars&per_page={limit}", self.github);
        let answer = match self.json(&url).await {
            Ok(answer) => answer,
            // Both failed: say why the first one did.
            Err(e) => return Err(directory.err().map_or(e.clone(), |d| format!("{d}; {e}"))),
        };
        Ok(answer["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                let full = r["full_name"].as_str()?.to_owned();
                Some(Found {
                    id: full.clone(),
                    name: r["name"].as_str().unwrap_or_default().to_owned(),
                    source: full,
                    count: r["stargazers_count"].as_u64().unwrap_or(0),
                    what: "stars",
                    description: r["description"].as_str().unwrap_or_default().chars().take(120).collect(),
                })
            })
            .take(limit)
            .collect())
    }

    /// [id] as owner, repository and skill: `owner/repo/skill`, `owner/repo`, or a skill's
    /// name, looked up in the directory (the most installed of that name).
    pub async fn resolve(&self, id: &str) -> Result<(String, String, Option<String>), String> {
        let parts: Vec<&str> = id.trim().trim_matches('/').split('/').collect();
        if !parts.iter().all(|p| segment(p)) {
            return Err(format!("{id:?}: owner/repo/skill, owner/repo, or a skill's name"));
        }
        match parts.as_slice() {
            [owner, repo, skill] => Ok(((*owner).to_owned(), (*repo).to_owned(), Some((*skill).to_owned()))),
            [owner, repo] => Ok(((*owner).to_owned(), (*repo).to_owned(), None)),
            [name] => {
                let found = self.search(name, 20).await?;
                let exact: Vec<&Found> =
                    found.iter().filter(|f| f.id.rsplit('/').next() == Some(*name) && f.what == "installs").collect();
                let best = exact.iter().max_by_key(|f| f.count).ok_or_else(|| {
                    let ids: Vec<&str> = found.iter().take(5).map(|f| f.id.as_str()).collect();
                    if ids.is_empty() {
                        format!("no skill named {name:?} in the hub")
                    } else {
                        format!("no skill named exactly {name:?}; did you mean {}?", ids.join(", "))
                    }
                })?;
                let mut it = best.id.splitn(3, '/');
                let (owner, repo, skill) = (it.next(), it.next(), it.next());
                match (owner, repo, skill) {
                    (Some(o), Some(r), Some(s)) => Ok((o.to_owned(), r.to_owned(), Some(s.to_owned()))),
                    _ => Err(format!("the hub's id {:?} is not owner/repo/skill", best.id)),
                }
            }
            _ => Err(format!("{id:?}: owner/repo/skill, owner/repo, or a skill's name")),
        }
    }

    /// Fetches [id]'s directory from GitHub into a fresh directory under [scratch], for review.
    pub async fn fetch(&self, id: &str, scratch: &Path) -> Result<Fetched, String> {
        let (owner, repo, skill) = self.resolve(id).await?;
        let tree = self.json(&format!("{}/repos/{owner}/{repo}/git/trees/HEAD?recursive=1", self.github)).await?;
        let blobs: Vec<(String, u64, String)> = tree["tree"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["type"] == "blob")
            .filter_map(|e| {
                Some((e["path"].as_str()?.to_owned(), e["size"].as_u64().unwrap_or(0), e["mode"].as_str()?.to_owned()))
            })
            .collect();
        let skill_dirs: Vec<String> = blobs
            .iter()
            .filter_map(|(p, _, _)| match p.rsplit_once('/') {
                Some((dir, "SKILL.md")) => Some(dir.to_owned()),
                None if p == "SKILL.md" => Some(String::new()),
                _ => None,
            })
            .collect();
        let dir = match &skill {
            Some(skill) => {
                let named: Vec<&String> = skill_dirs
                    .iter()
                    .filter(|d| d.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(skill)))
                    .collect();
                match named.as_slice() {
                    [one] => (*one).clone(),
                    [] => return Err(format!("{owner}/{repo} has no skill {skill:?} (no {skill}/SKILL.md)")),
                    _ => named.iter().min_by_key(|d| d.len()).map(|d| (*d).clone()).unwrap_or_default(),
                }
            }
            None => match skill_dirs.as_slice() {
                [one] => one.clone(),
                [] => return Err(format!("{owner}/{repo} has no SKILL.md")),
                many => {
                    let names: Vec<&str> = many.iter().take(12).map(|d| d.rsplit('/').next().unwrap_or(d)).collect();
                    return Err(format!(
                        "{owner}/{repo} has {} skills; name one: {}",
                        many.len(),
                        names.iter().map(|n| format!("{owner}/{repo}/{n}")).collect::<Vec<_>>().join(", ")
                    ));
                }
            },
        };
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        let name = if dir.is_empty() { repo.clone() } else { dir.rsplit('/').next().unwrap_or(&dir).to_owned() };
        let stamp = invincible::token::hex(&invincible::token::random::<6>()?);
        let root = scratch.join(format!("autobot-hub-{stamp}"));
        let target = root.join(&name);
        std::fs::create_dir_all(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        let mut fetched = Fetched {
            name: name.clone(),
            url: format!("https://github.com/{owner}/{repo}/tree/HEAD/{dir}"),
            dir: target.clone(),
            skill_md: String::new(),
            files: Vec::new(),
            left_out: Vec::new(),
            root,
        };
        let mut budget = MAX_BYTES;
        for (path, size, mode) in blobs.iter().filter(|(p, _, _)| p.starts_with(&prefix)) {
            let rel = &path[prefix.len()..];
            // Plain relative paths only, two levels deep at most, no dot names.
            let parts: Vec<&str> = rel.split('/').collect();
            if parts.len() > 3 || !parts.iter().all(|p| segment(p) && !p.starts_with('.')) {
                fetched.left_out.push(format!("{rel} (not a plain path)"));
                continue;
            }
            if fetched.files.len() >= MAX_FILES || *size > budget {
                fetched.left_out.push(format!("{rel} ({size} bytes; over the limit)"));
                continue;
            }
            let url = format!(
                "{}/{owner}/{repo}/HEAD/{}",
                self.raw,
                path.split('/').map(encode).collect::<Vec<_>>().join("/")
            );
            let bytes = self.get(&url).await?.bytes().await.map_err(|e| format!("{rel}: {}", e.without_url()))?;
            if bytes.len() as u64 > budget {
                fetched.left_out.push(format!("{rel} (over the limit)"));
                continue;
            }
            budget -= bytes.len() as u64;
            let to = target.join(rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            // Written plain: nothing it brings is executable.
            std::fs::write(&to, &bytes).map_err(|e| format!("{}: {e}", to.display()))?;
            if rel == "SKILL.md" {
                fetched.skill_md = String::from_utf8_lossy(&bytes).into_owned();
            }
            fetched.files.push((rel.to_owned(), bytes.len() as u64, script(rel, mode)));
        }
        if fetched.skill_md.is_empty() {
            return Err(format!("{}: its SKILL.md could not be fetched", fetched.url));
        }
        Ok(fetched)
    }
}

fn host(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_else(|| url.to_owned())
}

/// [text] for a URL's query or path.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_owned(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// What the owner reads before saying yes: where it is from, its files, its SKILL.md.
pub fn review(fetched: &Fetched) -> String {
    let mut out = format!("{}\n  from {}\n\n  files\n", fetched.name, fetched.url);
    for (path, size, script) in &fetched.files {
        let mark = if *script { "  (script: never run on its own; the agent asks like any command)" } else { "" };
        out.push_str(&format!("    {path}  {size} bytes{mark}\n"));
    }
    for why in &fetched.left_out {
        out.push_str(&format!("    left out: {why}\n"));
    }
    out.push_str("\n  SKILL.md\n");
    for line in fetched.skill_md.lines() {
        out.push_str(&format!("  │ {line}\n"));
    }
    out
}

/// Installs a [fetched] skill (after the owner's yes), with where it came from in `.source`.
pub fn install(home: &Path, fetched: &Fetched) -> Result<(Vec<String>, Vec<String>), String> {
    let (installed, skipped) = crate::skills::install(home, &fetched.dir.display().to_string())?;
    for name in &installed {
        let source = serde_json::json!({ "source": fetched.url, "installed": chrono::Local::now().to_rfc3339() });
        let _ = std::fs::write(home.join("skills").join(name).join(".source"), source.to_string());
    }
    Ok((installed, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_ids_and_encoding() {
        assert!(script("scripts/run.sh", "100644"));
        assert!(script("bin/tool", "100755"));
        assert!(!script("reference.md", "100644"));
        assert!(segment("agent-skills") && segment("v1.2"));
        assert!(!segment("..") && !segment("a/b") && !segment("") && !segment("a?b"));
        assert_eq!(encode("pdf forms & más"), "pdf+forms+%26+m%C3%A1s");
    }
}
