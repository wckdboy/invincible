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
//! Every install is pinned: `.source` in the skill's directory keeps its repository, the commit
//! it came from, its directory's tree on GitHub and a digest of its files. `autobot skills check`
//! asks GitHub whether that directory changed since (and whether the files here were edited);
//! `update` fetches the new one and shows it the same way, with what changed, before it replaces
//! the old. Every review carries the skills guard's scan and trust level ([crate::guard]).
//!
//! Every request follows the node's network mode (offline: no hub).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

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

/// Which skill directory of a repository is wanted.
enum Want<'a> {
    /// The one of this name (None: the only one there is).
    Named(Option<String>),
    /// The one at this path ("" for the root).
    At(&'a str),
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
    /// Where it is pinned: repository, revision, directory and its tree.
    pub pin: Source,
    root: PathBuf,
}

/// Where an installed skill came from (its `.source`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    /// The directory on GitHub, at the revision installed.
    pub source: String,
    /// `owner/repo/skill` or `owner/repo`: what `install` and `update` take.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub repo: String,
    /// The skill's directory in the repository ("" for its root).
    #[serde(default)]
    pub path: String,
    /// The commit installed.
    #[serde(default)]
    pub rev: String,
    /// The directory's tree id at that commit: the same while the skill is.
    #[serde(default)]
    pub tree: String,
    /// The files' digest when installed ([digest]).
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub installed: String,
}

impl Source {
    /// One from before pins were kept: only the URL, which says the rest.
    fn fill(mut self) -> Self {
        if self.owner.is_empty()
            && let Some(rest) = self.source.strip_prefix("https://github.com/")
        {
            let mut parts = rest.splitn(5, '/');
            if let (Some(owner), Some(repo), Some("tree"), Some(rev)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            {
                let path = parts.next().unwrap_or_default().trim_end_matches('/').to_owned();
                self.id = match path.rsplit('/').next() {
                    Some(last) if !last.is_empty() => format!("{owner}/{repo}/{last}"),
                    _ => format!("{owner}/{repo}"),
                };
                (self.owner, self.repo, self.rev, self.path) = (owner.into(), repo.into(), rev.into(), path);
            }
        }
        self
    }
}

/// Where the installed skill [name] came from; None for one not from the hub.
pub fn source(home: &Path, name: &str) -> Option<Source> {
    let text = std::fs::read_to_string(home.join("skills").join(name).join(".source")).ok()?;
    let source: Source = serde_json::from_str(&text).ok()?;
    let source = source.fill();
    (!source.owner.is_empty()).then_some(source)
}

/// A digest of [dir]'s files (their paths and contents, hidden ones too, `.source` left out):
/// changed by any edit.
pub fn digest(dir: &Path) -> String {
    fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, Vec<u8>)>) {
        if depth > 4 {
            return;
        }
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Autobot's own record; anything else here, hidden or not, is the owner's.
            if depth == 0 && name == ".source" {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                walk(root, &entry.path(), depth + 1, out);
            } else if kind.is_file() {
                let rel = entry.path().strip_prefix(root).map(|r| r.display().to_string()).unwrap_or(name);
                out.push((rel, std::fs::read(entry.path()).unwrap_or_default()));
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, 0, &mut files);
    files.sort();
    let mut hash = Sha256::new();
    for (rel, bytes) in files {
        hash.update((rel.len() as u64).to_le_bytes());
        hash.update(rel.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(&bytes);
    }
    invincible::token::hex(&hash.finalize())
}

/// What `autobot skills check` found for an installed skill.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Its directory is as installed (the repository may have moved on).
    Current,
    /// Its directory changed at this commit.
    Changed(String),
    /// Its directory is no longer there.
    Gone,
    /// Not installed from the hub: nothing to check against.
    Unpinned,
    /// GitHub could not say.
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct Checked {
    pub name: String,
    pub status: Status,
    /// Its files were edited here since it was installed; also when that cannot be told (a skill
    /// installed before digests were kept), so an update asks rather than erase edits.
    pub modified: bool,
    /// No digest to tell edits by.
    pub untracked: bool,
    pub trust: crate::guard::Trust,
    pub source: Option<Source>,
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

    /// The repository's latest commit.
    async fn head(&self, owner: &str, repo: &str) -> Result<String, String> {
        let commit = self.json(&format!("{}/repos/{owner}/{repo}/commits/HEAD", self.github)).await?;
        Ok(commit["sha"]
            .as_str()
            .filter(|s| s.len() >= 7 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .ok_or(format!("{owner}/{repo}: GitHub gave no revision"))?
            .to_owned())
    }

    async fn tree(&self, owner: &str, repo: &str, rev: &str) -> Result<Value, String> {
        self.json(&format!("{}/repos/{owner}/{repo}/git/trees/{rev}?recursive=1", self.github)).await
    }

    /// Whether the skill pinned at [pin] changed on GitHub since.
    pub async fn status(&self, pin: &Source) -> Status {
        let result: Result<Status, String> = async {
            let rev = self.head(&pin.owner, &pin.repo).await?;
            if rev == pin.rev {
                return Ok(Status::Current);
            }
            let tree = self.tree(&pin.owner, &pin.repo, &rev).await?;
            let now = if pin.path.is_empty() {
                tree["sha"].as_str().map(str::to_owned)
            } else {
                tree["tree"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|e| e["type"] == "tree" && e["path"].as_str() == Some(pin.path.as_str()))
                    .and_then(|e| e["sha"].as_str().map(str::to_owned))
            };
            Ok(match now {
                None => Status::Gone,
                // Pinned before trees were kept: only the commit says.
                Some(_) if pin.tree.is_empty() => Status::Changed(rev),
                Some(now) if now == pin.tree => Status::Current,
                Some(_) => Status::Changed(rev),
            })
        }
        .await;
        result.unwrap_or_else(Status::Failed)
    }

    /// Fetches [id]'s directory from GitHub into a fresh directory under [scratch], for review.
    pub async fn fetch(&self, id: &str, scratch: &Path) -> Result<Fetched, String> {
        let (owner, repo, skill) = self.resolve(id).await?;
        self.fetch_in(&owner, &repo, Want::Named(skill), scratch).await
    }

    /// Fetches the skill pinned at [pin] as its directory is now: the same directory of the same
    /// repository, whatever else the repository has since.
    pub async fn fetch_pinned(&self, pin: &Source, scratch: &Path) -> Result<Fetched, String> {
        let plain = segment(&pin.owner)
            && segment(&pin.repo)
            && (pin.path.is_empty() || pin.path.split('/').all(|p| segment(p) && !p.starts_with('.')));
        if !plain {
            return Err(format!("{:?}: not a plain repository and directory", pin.source));
        }
        self.fetch_in(&pin.owner, &pin.repo, Want::At(&pin.path), scratch).await
    }

    async fn fetch_in(&self, owner: &str, repo: &str, want: Want<'_>, scratch: &Path) -> Result<Fetched, String> {
        let (owner, repo) = (owner.to_owned(), repo.to_owned());
        // One revision for the tree and every file, so they belong together.
        let rev = self.head(&owner, &repo).await?;
        let tree = self.tree(&owner, &repo, &rev).await?;
        let blobs: Vec<(String, u64, String)> = tree["tree"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["type"] == "blob")
            .filter_map(|e| {
                Some((e["path"].as_str()?.to_owned(), e["size"].as_u64().unwrap_or(0), e["mode"].as_str()?.to_owned()))
            })
            .collect();
        let trees: Vec<(String, String)> = tree["tree"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["type"] == "tree")
            .filter_map(|e| Some((e["path"].as_str()?.to_owned(), e["sha"].as_str()?.to_owned())))
            .collect();
        let root_tree = tree["sha"].as_str().unwrap_or_default().to_owned();
        let skill_dirs: Vec<String> = blobs
            .iter()
            .filter_map(|(p, _, _)| match p.rsplit_once('/') {
                Some((dir, "SKILL.md")) => Some(dir.to_owned()),
                None if p == "SKILL.md" => Some(String::new()),
                _ => None,
            })
            .collect();
        let dir = match want {
            Want::At(path) if skill_dirs.iter().any(|d| d == path) => path.to_owned(),
            Want::At(path) => return Err(format!("{owner}/{repo} no longer has {path}/SKILL.md")),
            Want::Named(Some(skill)) => {
                let named: Vec<&String> = skill_dirs
                    .iter()
                    .filter(|d| d.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(&skill)))
                    .collect();
                match named.as_slice() {
                    [one] => (*one).clone(),
                    [] => return Err(format!("{owner}/{repo} has no skill {skill:?} (no {skill}/SKILL.md)")),
                    _ => named.iter().min_by_key(|d| d.len()).map(|d| (*d).clone()).unwrap_or_default(),
                }
            }
            Want::Named(None) => match skill_dirs.as_slice() {
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
        let dir_tree = if dir.is_empty() {
            root_tree
        } else {
            trees.iter().find(|(p, _)| *p == dir).map(|(_, s)| s.clone()).unwrap_or_default()
        };
        let url = format!("https://github.com/{owner}/{repo}/tree/{rev}/{dir}");
        let pin = Source {
            source: url.clone(),
            id: if dir.is_empty() { format!("{owner}/{repo}") } else { format!("{owner}/{repo}/{name}") },
            owner: owner.clone(),
            repo: repo.clone(),
            path: dir.clone(),
            rev: rev.clone(),
            tree: dir_tree,
            digest: String::new(),
            installed: String::new(),
        };
        let mut fetched = Fetched {
            name: name.clone(),
            url,
            pin,
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
                "{}/{owner}/{repo}/{rev}/{}",
                self.raw,
                path.split('/').map(encode).collect::<Vec<_>>().join("/")
            );
            // Read in pieces, and no further than what is left of the budget.
            let mut response = self.get(&url).await?;
            let mut bytes = Vec::new();
            let mut over = false;
            while let Some(chunk) = response.chunk().await.map_err(|e| format!("{rel}: {}", e.without_url()))? {
                if (bytes.len() + chunk.len()) as u64 > budget {
                    over = true;
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            if over {
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

/// `autobot skills check`: every installed skill (or [only]) against where it is pinned, on
/// [hub] (or why it cannot be reached).
pub async fn check(hub: Result<&Hub, &str>, home: &Path, only: Option<&str>) -> Result<Vec<Checked>, String> {
    let skills: Vec<crate::skills::Skill> =
        crate::skills::list(home).into_iter().filter(|s| only.is_none_or(|o| s.name == o)).collect();
    if let Some(name) = only
        && skills.is_empty()
    {
        return Err(format!("there is no skill {name:?}"));
    }
    let mut out = Vec::new();
    for skill in skills {
        let pin = source(home, &skill.name);
        let untracked = pin.as_ref().is_some_and(|p| p.digest.is_empty());
        let modified = match (&pin, skill.dir()) {
            (Some(pin), Some(dir)) if !pin.digest.is_empty() => digest(dir) != pin.digest,
            (Some(_), _) => true,
            (None, _) => false,
        };
        let status = match &pin {
            Some(pin) => match hub {
                Ok(hub) => hub.status(pin).await,
                Err(why) => Status::Failed(why.to_owned()),
            },
            None => Status::Unpinned,
        };
        let trust = crate::guard::Trust::of(pin.as_ref().map(|p| p.owner.as_str()));
        out.push(Checked { name: skill.name, status, modified, untracked, trust, source: pin });
    }
    Ok(out)
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
    out.push_str(&format!("\n{}", guard(fetched)));
    out
}

/// The skills guard's word on [fetched]: its trust level and what its files may do.
pub fn guard(fetched: &Fetched) -> String {
    crate::guard::report(fetched.trust(), &crate::guard::audit(&fetched.dir), 20)
}

impl Fetched {
    pub fn trust(&self) -> crate::guard::Trust {
        crate::guard::Trust::of(Some(&self.pin.owner))
    }

    /// Whether going in unasked needs `--force`: something dangerous, not from an official source.
    pub fn needs_force(&self) -> bool {
        crate::guard::needs_force(self.trust(), &crate::guard::audit(&self.dir))
    }
}

/// What an update of the installed skill [name] to [fetched] changes: files added, removed and
/// changed, and SKILL.md's diff.
pub fn changes(home: &Path, name: &str, fetched: &Fetched) -> String {
    let here = home.join("skills").join(name);
    let mut out = format!("{name}: what changes\n");
    let old: Vec<String> = crate::skills::find(home, name).map(|s| s.files()).unwrap_or_default().into_iter().collect();
    let new: Vec<&str> = fetched.files.iter().map(|(p, _, _)| p.as_str()).filter(|p| *p != "SKILL.md").collect();
    for path in &new {
        match std::fs::read(here.join(path)) {
            Err(_) => out.push_str(&format!("    added    {path}\n")),
            Ok(bytes) if std::fs::read(fetched.dir.join(path)).ok().as_deref() != Some(&bytes[..]) => {
                out.push_str(&format!("    changed  {path}\n"))
            }
            Ok(_) => {}
        }
    }
    for path in old.iter().filter(|p| !new.contains(&p.as_str())) {
        out.push_str(&format!("    removed  {path}\n"));
    }
    let before = std::fs::read_to_string(here.join("SKILL.md")).unwrap_or_default();
    let diff = crate::diff::unified(&before, &fetched.skill_md, "SKILL.md");
    if diff.is_empty() {
        out.push_str("    SKILL.md is the same\n");
    } else {
        for line in diff.lines() {
            out.push_str(&format!("  │ {line}\n"));
        }
    }
    out
}

/// Installs a [fetched] skill (after the owner's yes), with where it came from in `.source`.
pub fn install(home: &Path, fetched: &Fetched) -> Result<(Vec<String>, Vec<String>), String> {
    let (installed, skipped) = crate::skills::install(home, &fetched.dir.display().to_string())?;
    for name in &installed {
        pin(home, name, fetched)?;
    }
    Ok((installed, skipped))
}

/// Writes the installed skill [name]'s `.source`: where [fetched] came from, and its digest now.
fn pin(home: &Path, name: &str, fetched: &Fetched) -> Result<(), String> {
    let dir = home.join("skills").join(name);
    let pin = Source { digest: digest(&dir), installed: chrono::Local::now().to_rfc3339(), ..fetched.pin.clone() };
    let text = serde_json::to_string_pretty(&pin).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".source"), text).map_err(|e| format!("{}: {e}", dir.display()))
}

/// Replaces the installed skill [name] with [fetched] (after the owner's yes): the old one is
/// kept aside until the new one is in, and put back if it does not go in.
pub fn update(home: &Path, name: &str, fetched: &Fetched) -> Result<(), String> {
    let dir = home.join("skills").join(name);
    if !dir.join("SKILL.md").is_file() {
        return Err(format!("{name} is not a skill directory from the hub"));
    }
    let aside = home.join(format!(".skill-update-{name}"));
    let _ = std::fs::remove_dir_all(&aside);
    std::fs::rename(&dir, &aside).map_err(|e| format!("{}: {e}", dir.display()))?;
    let result = crate::skills::install(home, &fetched.dir.display().to_string());
    let back = |why: String| {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::rename(&aside, &dir);
        Err(why)
    };
    match result {
        Ok((installed, _)) if installed == [name] => {}
        Ok((installed, skipped)) => {
            for other in installed.iter().filter(|n| *n != name) {
                let _ = crate::skills::remove(home, other);
            }
            return back(format!("the new version is not {name:?}: {}", [installed, skipped].concat().join("; ")));
        }
        Err(e) => return back(e),
    }
    if let Err(e) = pin(home, name, fetched) {
        return back(e);
    }
    let _ = std::fs::remove_dir_all(&aside);
    Ok(())
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
