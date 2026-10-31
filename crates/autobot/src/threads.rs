//! Threads: a conversation with a checkout of its own.
//!
//! A thread is a session plus a git worktree and a branch. Creating one runs
//! `git worktree add` from the project's repository, so parallel agents cannot step on each
//! other; the agent's tools and project map are pointed at that worktree for the thread's turns.
//! Diffing, committing, pushing and opening a pull request are the same thread's finishing moves.
//!
//! The registry is `$AUTOBOT_HOME/threads.json`, written whole and readable only by the owner.
//! Every operation reads it fresh, so `autobot thread …` and a running `autobot serve` agree.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The largest diff returned to a client, in bytes.
const DIFF_LIMIT: usize = 512 * 1024;

/// One thread.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    /// The conversation it runs in.
    pub session: String,
    /// The repository the worktree was made from (its top level).
    pub repo: PathBuf,
    pub worktree: PathBuf,
    pub branch: String,
    /// The branch or commit the worktree was made from.
    pub base: String,
    #[serde(default)]
    pub name: String,
    pub created_at: u64,
    #[serde(default)]
    pub pr_url: Option<String>,
    #[serde(default)]
    pub pr_number: Option<u64>,
    #[serde(default)]
    pub compare_url: Option<String>,
}

/// A thread's checkout, ready for the network steps of opening a pull request.
pub struct PreparedPr {
    pub thread: Thread,
    pub title: String,
    pub body: String,
    pub base: String,
    pub commit: Option<String>,
    pub remote: Option<String>,
    pub pushed: bool,
    pub ahead: u64,
}

/// What opening a pull request did. A branch can be pushed without a PR (no GitHub remote, no
/// `gh`, no token): `compare_url` is then the link a person can open to make it.
#[derive(Debug, Serialize)]
pub struct PrOutcome {
    pub branch: String,
    pub commit: Option<String>,
    pub pushed: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<u64>,
    pub compare_url: Option<String>,
    pub message: String,
}

/// The registry in `$AUTOBOT_HOME/threads.json`.
pub struct Threads {
    home: PathBuf,
    lock: Mutex<()>,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    threads: Vec<Thread>,
    /// Threads whose worktree was removed: their sessions must not fall back to the bot's project.
    #[serde(default)]
    removed: Vec<String>,
}

impl Threads {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), lock: Mutex::new(()) }
    }

    fn file(&self) -> PathBuf {
        self.home.join("threads.json")
    }

    fn load_registry(&self) -> Result<Registry, String> {
        let Some(text) = invincible::fsutil::read_optional(&self.file())? else {
            return Ok(Registry::default());
        };
        if text.trim().is_empty() {
            return Ok(Registry::default());
        }
        let value: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.file().display()))?;
        if value.is_array() {
            return Ok(Registry {
                threads: serde_json::from_value(value).map_err(|e| e.to_string())?,
                removed: Vec::new(),
            });
        }
        serde_json::from_value(value).map_err(|e| format!("{}: {e}", self.file().display()))
    }

    fn load(&self) -> Result<Vec<Thread>, String> {
        Ok(self.load_registry()?.threads)
    }

    fn save(&self, registry: &Registry) -> Result<(), String> {
        let text = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&self.file(), &format!("{text}\n"))
    }

    pub fn list(&self) -> Result<Vec<Thread>, String> {
        self.load()
    }

    pub fn get(&self, id: &str) -> Result<Option<Thread>, String> {
        Ok(self.load()?.into_iter().find(|t| t.id == id))
    }

    /// Whether [id] was a thread whose worktree has been removed: a turn in that session must
    /// not silently fall back to the bot's main project.
    pub fn is_removed(&self, id: &str) -> Result<bool, String> {
        Ok(self.load_registry()?.removed.iter().any(|removed| removed == id))
    }

    /// Creates the worktree from [repo] at [base] (the checked-out branch by default) and keeps
    /// the thread under a new [name]. The repository is resolved to its top level; a path that
    /// is not a repository is refused.
    pub fn create(&self, repo: &Path, base: Option<&str>, name: &str) -> Result<Thread, String> {
        let _guard = self.lock.lock().map_err(|_| "the thread registry lock is poisoned".to_owned())?;
        let repo = repo.canonicalize().map_err(|e| format!("{}: {e}", repo.display()))?;
        let toplevel = git(&repo, &["rev-parse", "--show-toplevel"])?;
        let repo = PathBuf::from(toplevel);
        if !repo.is_dir() {
            return Err(format!("{} is not a repository", repo.display()));
        }
        let base = match base {
            Some(base) => base.trim().to_owned(),
            None => git(&repo, &["symbolic-ref", "--short", "HEAD"])
                .map_err(|_| "the repository is not on a branch; name the base branch with --base".to_owned())?,
        };
        validate_base(&repo, &base)?;

        let mut registry = self.load_registry()?;
        let id = loop {
            let id = format!("t-{}", invincible::token::hex(&invincible::token::random::<6>()?));
            if !registry.threads.iter().any(|t| t.id == id) && !registry.removed.iter().any(|r| r == &id) {
                break id;
            }
        };
        let branch = format!("autobot/{id}");
        let worktree = self.home.join("worktrees").join(&id);
        if let Some(parent) = worktree.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        if worktree.exists() {
            return Err(format!("{} already exists", worktree.display()));
        }
        let path = worktree.to_str().ok_or("the worktree path is not UTF-8")?.to_owned();
        git(&repo, &["worktree", "add", "-b", &branch, path.as_str(), &base])
            .map_err(|e| format!("the worktree could not be created: {e}"))?;
        let thread = Thread {
            id,
            session: String::new(),
            repo,
            worktree,
            branch,
            base,
            name: name.trim().to_owned(),
            created_at: now(),
            pr_url: None,
            pr_number: None,
            compare_url: None,
        };
        let mut thread = thread;
        thread.session = thread.id.clone();
        registry.threads.push(thread.clone());
        if let Err(e) = self.save(&registry) {
            let _ = git(&thread.repo, &["worktree", "remove", "--force", path.as_str()]);
            return Err(e);
        }
        Ok(thread)
    }

    /// The worktree's changes against its base, staged first so new files are included.
    pub fn diff(&self, id: &str, stat: bool) -> Result<String, String> {
        let thread = self.get(id)?.ok_or_else(|| format!("there is no thread {id:?}"))?;
        if !thread.worktree.is_dir() {
            return Err(format!("the worktree {} is gone", thread.worktree.display()));
        }
        stage(&thread)?;
        let mut args = vec!["diff", "--cached", "--no-color"];
        if stat {
            args.push("--stat");
        }
        args.push(&thread.base);
        let diff = git(&thread.worktree, &args)?;
        if diff.trim().is_empty() {
            return Ok("no changes".to_owned());
        }
        Ok(capped(diff, DIFF_LIMIT))
    }

    /// Stages, commits, pushes and describes a pull request. No network request is made beyond
    /// the push; [open_pr] makes the PR. A thread with no changes and no commits ahead of its
    /// base is refused.
    pub fn prepare_pr(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
        base: Option<&str>,
    ) -> Result<PreparedPr, String> {
        let thread = self.get(id)?.ok_or_else(|| format!("there is no thread {id:?}"))?;
        if !thread.worktree.is_dir() {
            return Err(format!("the worktree {} is gone", thread.worktree.display()));
        }
        let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
            Some(base) => base.to_owned(),
            None => thread.base.clone(),
        };
        validate_base(&thread.repo, &base)?;
        stage(&thread)?;
        let staged = !git_ok(&thread.worktree, &["diff", "--cached", "--quiet"]);
        let before = rev_count(&thread.worktree, &base)?;
        if !staged && before == 0 {
            return Err("nothing to open a pull request for: the worktree has no changes".to_owned());
        }
        let title = title
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .or_else(|| (!thread.name.trim().is_empty()).then(|| thread.name.trim().to_owned()))
            .unwrap_or_else(|| format!("Autobot: {}", thread.branch));
        let stat = git(&thread.worktree, &["diff", "--cached", "--stat", &base]).unwrap_or_default();
        let body = body.map(str::trim).filter(|b| !b.is_empty()).map(str::to_owned).unwrap_or_else(|| {
            format!(
                "Autobot thread `{}` on `{}`.\n\n{}",
                thread.id,
                thread.branch,
                if stat.trim().is_empty() { "No file changes (commits already made)." } else { stat.trim() }
            )
        });
        if staged {
            git(
                &thread.worktree,
                &["-c", "user.name=Autobot", "-c", "user.email=autobot@localhost", "commit", "-m", &title],
            )?;
        }
        let commit = git(&thread.worktree, &["rev-parse", "--short", "HEAD"]).ok();
        let remote = git(&thread.worktree, &["remote", "get-url", "origin"]).ok();
        let mut pushed = false;
        if let Some(remote) = &remote {
            push_branch(&thread.worktree, &thread.branch, remote)
                .map_err(|e| format!("the branch could not be pushed: {e}"))?;
            pushed = true;
        }
        let ahead = rev_count(&thread.worktree, &base)?;
        Ok(PreparedPr { thread, title, body, base, commit, remote, pushed, ahead })
    }

    /// Records the PR (or the compare link) on the thread.
    pub fn record_pr(&self, id: &str, outcome: &PrOutcome) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "the thread registry lock is poisoned".to_owned())?;
        let mut registry = self.load_registry()?;
        let Some(thread) = registry.threads.iter_mut().find(|t| t.id == id) else {
            return Err(format!("there is no thread {id:?}"));
        };
        thread.pr_url = outcome.pr_url.clone();
        thread.pr_number = outcome.pr_number;
        thread.compare_url = outcome.compare_url.clone();
        self.save(&registry)
    }

    /// Removes the worktree and (when it can) the branch. With [force], uncommitted changes are
    /// discarded; without it, a dirty worktree is refused.
    pub fn remove(&self, id: &str, force: bool) -> Result<Thread, String> {
        let _guard = self.lock.lock().map_err(|_| "the thread registry lock is poisoned".to_owned())?;
        let mut registry = self.load_registry()?;
        let thread = registry
            .threads
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| format!("there is no thread {id:?}"))?;
        if thread.worktree.is_dir() {
            let path = thread.worktree.to_str().ok_or("the worktree path is not UTF-8")?;
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.push(path);
            if let Err(e) = git(&thread.repo, &args) {
                if !force {
                    return Err(format!("{e} (use --force to discard the changes)"));
                }
                // A worktree whose metadata is confused still leaves files; take them out.
                let _ = std::fs::remove_dir_all(&thread.worktree);
                let _ = git(&thread.repo, &["worktree", "prune"]);
            }
        }
        let _ = git(&thread.repo, &["branch", "-D", thread.branch.as_str()]);
        registry.threads.retain(|t| t.id != id);
        if !registry.removed.iter().any(|removed| removed.as_str() == id) {
            registry.removed.push(id.to_owned());
        }
        self.save(&registry)?;
        Ok(thread)
    }

    /// A thread as the API and CLI show it: its stored fields plus the checkout's state.
    pub fn view(&self, thread: &Thread) -> Value {
        let exists = thread.worktree.is_dir();
        let head = exists.then(|| git(&thread.worktree, &["rev-parse", "--short", "HEAD"]).ok()).flatten();
        let dirty =
            exists && git(&thread.worktree, &["status", "--porcelain"]).ok().is_some_and(|s| !s.trim().is_empty());
        let ahead = if exists { rev_count(&thread.worktree, &thread.base).unwrap_or(0) } else { 0 };
        let mut value = serde_json::to_value(thread).unwrap_or_else(|_| json!({}));
        value["worktree_exists"] = json!(exists);
        value["head"] = json!(head);
        value["dirty"] = json!(dirty);
        value["ahead"] = json!(ahead);
        value
    }
}

/// Makes the PR. `gh` is tried first (it uses the machine's own login); then the GitHub API
/// with `GH_TOKEN` or `GITHUB_TOKEN`; when neither is available the branch is still pushed and
/// the compare link is returned, so a person can open the PR in one click.
pub async fn open_pr(prepared: &PreparedPr) -> PrOutcome {
    let mut outcome = PrOutcome {
        branch: prepared.thread.branch.clone(),
        commit: prepared.commit.clone(),
        pushed: prepared.pushed,
        pr_url: None,
        pr_number: None,
        compare_url: None,
        message: String::new(),
    };
    let Some(remote) = prepared.remote.as_deref() else {
        outcome.message = "the worktree has no origin remote; the branch is local".to_owned();
        return outcome;
    };
    let Some((owner, repo)) = github_remote(remote) else {
        outcome.message = if prepared.pushed {
            format!("the branch was pushed to {remote}; it is not GitHub, so no pull request was opened")
        } else {
            format!("the remote {remote} was not pushed to")
        };
        return outcome;
    };
    let base = pr_base(&prepared.base);
    outcome.compare_url = Some(format!(
        "https://github.com/{owner}/{repo}/compare/{}...{}?expand=1",
        encode(&base),
        encode(&prepared.thread.branch)
    ));
    if let Some(url) = gh_create(prepared) {
        outcome.pr_url = Some(url);
        outcome.message = "the pull request was opened with gh".to_owned();
        return outcome;
    }
    if let Some(token) = github_token() {
        match github_create(&owner, &repo, &token, prepared, &base).await {
            Ok((url, number)) => {
                outcome.pr_url = Some(url);
                outcome.pr_number = number;
                outcome.message = "the pull request was opened through the GitHub API".to_owned();
            }
            Err(e) => outcome.message = format!("{e}; the branch is pushed and the compare link is ready"),
        }
        return outcome;
    }
    outcome.message = "the branch was pushed; install gh or set GH_TOKEN to open the pull request automatically, or use the compare link".to_owned();
    outcome
}

fn gh_create(prepared: &PreparedPr) -> Option<String> {
    if !command_exists("gh") {
        return None;
    }
    let base = pr_base(&prepared.base);
    let out = Command::new("gh")
        .current_dir(&prepared.thread.worktree)
        .env("GH_PROMPT_DISABLED", "1")
        .args([
            "pr",
            "create",
            "--title",
            &prepared.title,
            "--body",
            &prepared.body,
            "--base",
            &base,
            "--head",
            &prepared.thread.branch,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    url.starts_with("http").then_some(url)
}

async fn github_create(
    owner: &str,
    repo: &str,
    token: &str,
    prepared: &PreparedPr,
    base: &str,
) -> Result<(String, Option<u64>), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("GitHub client: {e}"))?;
    let response = client
        .post(format!("https://api.github.com/repos/{owner}/{repo}/pulls"))
        .bearer_auth(token)
        .header("User-Agent", "autobot")
        .header("Accept", "application/vnd.github+json")
        .json(&json!({
            "title": prepared.title,
            "head": prepared.thread.branch,
            "base": base,
            "body": prepared.body,
        }))
        .send()
        .await
        .map_err(|e| format!("GitHub: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or_default();
    if status.is_success() {
        let url = value["html_url"].as_str().unwrap_or_default().to_owned();
        if url.is_empty() {
            return Err("GitHub opened the pull request but returned no URL".to_owned());
        }
        Ok((url, value["number"].as_u64()))
    } else {
        let message = value["message"].as_str().unwrap_or("could not open the pull request");
        Err(format!("GitHub: {message} (HTTP {})", status.as_u16()))
    }
}

fn github_token() -> Option<String> {
    ["GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty())
}

fn command_exists(name: &str) -> bool {
    Command::new(name).arg("--version").output().is_ok()
}

/// `owner/repo` from a GitHub remote in the forms git writes.
fn github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_end_matches(".git");
    let rest = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let (owner, repo) = rest.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
}

fn pr_base(base: &str) -> String {
    base.strip_prefix("origin/").unwrap_or(base).to_owned()
}

fn encode(text: &str) -> String {
    text.replace('%', "%25").replace('/', "%2F").replace('#', "%23").replace('?', "%3F")
}

fn stage(thread: &Thread) -> Result<(), String> {
    git(&thread.worktree, &["add", "-A"]).map(|_| ())
}

/// Pushes [branch] to [remote]. For an HTTPS GitHub remote with `GH_TOKEN` or `GITHUB_TOKEN`, a
/// one-shot credential helper reads the token from the environment, so it never appears in the
/// command line or the remote URL.
fn push_branch(worktree: &Path, branch: &str, remote: &str) -> Result<(), String> {
    let token = github_token();
    let mut command = Command::new("git");
    command.arg("-C").arg(worktree).env("GIT_TERMINAL_PROMPT", "0");
    if remote.starts_with("https://github.com/")
        && let Some(token) = token
    {
        command
            .args(["-c", "credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f"])
            .env("GH_TOKEN", token);
    }
    command.args(["push", "-u", "origin", branch]);
    let out = command.output().map_err(|e| format!("git: {e} (is git installed?)"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(())
}

fn rev_count(worktree: &Path, base: &str) -> Result<u64, String> {
    let range = format!("{base}..HEAD");
    git(worktree, &["rev-list", "--count", &range])?.trim().parse().map_err(|e| format!("git rev-list: {e}"))
}

fn validate_base(repo: &Path, base: &str) -> Result<(), String> {
    let base = base.trim();
    if base.is_empty() || base.starts_with('-') || base.chars().any(char::is_whitespace) {
        return Err(format!("{base:?} is not a base branch"));
    }
    git(repo, &["check-ref-format", "--branch", base]).map_err(|_| format!("{base:?} is not a valid branch name"))?;
    git(repo, &["rev-parse", "--verify", &format!("{base}^{{commit}}")])
        .map_err(|_| format!("there is no commit at {base:?}"))?;
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git: {e} (is git installed?)"))?;
    if !out.status.success() {
        let error = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {}: {}", args.join(" "), error.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_owned())
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .is_ok_and(|status| status.success())
}

fn capped(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… diff truncated at {} KiB", &text[..cut], max / 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("autobot-threads-{}-{name}-{}", std::process::id(), now()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "README.md"]).unwrap();
        git(dir, &["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "init"]).unwrap();
    }

    #[test]
    fn creates_a_worktree_diffs_and_removes_it() {
        let root = temp("create");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let home = root.join("home");
        let threads = Threads::new(&home);
        let thread = threads.create(&repo, None, "test thread").unwrap();
        assert_eq!(thread.base, "main");
        assert_eq!(thread.session, thread.id);
        assert!(thread.worktree.is_dir());
        assert_eq!(git(&thread.worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), thread.branch);
        std::fs::write(thread.worktree.join("new.txt"), "new\n").unwrap();
        let diff = threads.diff(&thread.id, false).unwrap();
        assert!(diff.contains("new.txt"), "{diff}");
        assert_eq!(threads.view(&thread)["dirty"], true);
        let removed = threads.remove(&thread.id, true).unwrap();
        assert_eq!(removed.id, thread.id);
        assert!(!thread.worktree.exists());
        assert!(threads.list().unwrap().is_empty());
        assert!(threads.get(&thread.id).unwrap().is_none());
        assert!(threads.is_removed(&thread.id).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepares_commits_and_pushes_a_branch() {
        let root = temp("pr");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare"]).unwrap();
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]).unwrap();
        let threads = Threads::new(root.join("home"));
        let thread = threads.create(&repo, None, "").unwrap();
        std::fs::write(thread.worktree.join("feature.txt"), "feature\n").unwrap();
        let prepared = threads.prepare_pr(&thread.id, Some("Add feature"), None, None).unwrap();
        assert_eq!(prepared.title, "Add feature");
        assert!(prepared.pushed);
        assert_eq!(prepared.ahead, 1);
        let on_remote = git(&bare, &["rev-parse", &thread.branch]).unwrap();
        assert_eq!(on_remote, git(&thread.worktree, &["rev-parse", "HEAD"]).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_non_repository() {
        let root = temp("norepo");
        let threads = Threads::new(root.join("home"));
        assert!(threads.create(&root, None, "").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_github_remotes() {
        assert_eq!(
            github_remote("git@github.com:wckdboy/invincible.git"),
            Some(("wckdboy".into(), "invincible".into()))
        );
        assert_eq!(github_remote("https://github.com/WCKDai/platform.git"), Some(("WCKDai".into(), "platform".into())));
        assert_eq!(github_remote("https://gitlab.com/a/b.git"), None);
    }
}
