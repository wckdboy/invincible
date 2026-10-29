//! Delegated runs that outlive a request.
//!
//! A provider can ask a delegated run to wait longer than an event stream should stay open. The
//! run is written here as a paused job; `autobot serve` wakes at `retry_at`, opens the same
//! conversation and continues. The store is `$AUTOBOT_HOME/delegations.json`, mode 0600, whole
//! file, so it survives a restart. A resumed run is a fresh bounded delegated run in the same
//! conversation: its first message says to check the state and continue.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The most times one paused job is resumed automatically.
pub const MAX_RESUMES: u8 = 5;
/// How long after a restart an interrupted job waits before it is tried again.
pub const RECOVER_AFTER: u64 = 60;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    #[default]
    Paused,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub session: String,
    pub bot: String,
    /// The owner's request, kept so the panel can say what the run is. Not the whole
    /// conversation: that stays in the session's own file.
    #[serde(default)]
    pub task: String,
    pub scope: crate::delegate::Scope,
    pub retry_at: u64,
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub state: State,
    #[serde(default)]
    pub resumes: u8,
    #[serde(default)]
    pub owner_controls: bool,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub final_text: Option<String>,
}

impl Job {
    pub fn new(
        session: &str,
        bot: &str,
        task: &str,
        scope: crate::delegate::Scope,
        retry_at: u64,
        owner_controls: bool,
    ) -> Result<Self, String> {
        let id = format!("d-{}", invincible::token::hex(&invincible::token::random::<8>()?));
        let now = now();
        Ok(Self {
            id,
            session: session.to_owned(),
            bot: bot.to_owned(),
            task: task.chars().take(500).collect(),
            scope,
            retry_at,
            created_at: now,
            updated_at: now,
            state: State::Paused,
            resumes: 0,
            owner_controls,
            last_error: None,
            final_text: None,
        })
    }

    pub fn view(&self) -> Value {
        json!({
            "id": self.id,
            "session": self.session,
            "bot": self.bot,
            "task": self.task,
            "state": self.state,
            "retry_at": self.retry_at,
            "retry_at_local": local(self.retry_at),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "resumes": self.resumes,
            "max_resumes": MAX_RESUMES,
            "owner_controls": self.owner_controls,
            "max_nudges": self.scope.max_nudges,
            "until": self.scope.until,
            "last_error": self.last_error,
            "final_text": self.final_text,
        })
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn local(at: u64) -> String {
    chrono::DateTime::from_timestamp(at as i64, 0)
        .map(|t| t.with_timezone(&chrono::Local).to_rfc3339())
        .unwrap_or_default()
}

pub struct Jobs {
    home: PathBuf,
    lock: Mutex<()>,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    jobs: Vec<Job>,
}

impl Jobs {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), lock: Mutex::new(()) }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    fn file(&self) -> PathBuf {
        self.home.join("delegations.json")
    }

    fn load(&self) -> Result<Vec<Job>, String> {
        let Some(text) = invincible::fsutil::read_optional(&self.file())? else {
            return Ok(Vec::new());
        };
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let registry: Registry = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.file().display()))?;
        Ok(registry.jobs)
    }

    fn save(&self, jobs: &[Job]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&Registry { jobs: jobs.to_vec() }).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&self.file(), &format!("{text}\n"))
    }

    /// Every job, newest first.
    pub fn list(&self) -> Result<Vec<Job>, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        jobs.sort_by_key(|job| std::cmp::Reverse(job.created_at));
        Ok(jobs)
    }

    pub fn get(&self, id: &str) -> Result<Option<Job>, String> {
        Ok(self.list()?.into_iter().find(|job| job.id == id))
    }

    /// Adds a paused job, or replaces the one with the same id. Another paused job in the same
    /// conversation is older news: it is cancelled, so two runs never resume in one session.
    pub fn pause(&self, mut job: Job) -> Result<Job, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        job.updated_at = now();
        for old in jobs.iter_mut().filter(|old| old.session == job.session && old.id != job.id) {
            if old.state == State::Paused {
                old.state = State::Cancelled;
                old.last_error = Some("replaced by a newer delegated request in this conversation".to_owned());
                old.updated_at = now();
            }
        }
        match jobs.iter_mut().find(|old| old.id == job.id) {
            Some(old) => *old = job.clone(),
            None => jobs.push(job.clone()),
        }
        self.save(&jobs)?;
        Ok(job)
    }

    /// Claims a due paused job for one runner, counting the resume. None when it is not due,
    /// not paused, or has used every automatic resume.
    pub fn claim(&self, id: &str, at: u64) -> Result<Option<Job>, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        let claimed = {
            let Some(job) = jobs.iter_mut().find(|job| job.id == id) else { return Ok(None) };
            if job.state != State::Paused || job.retry_at > at || job.resumes >= MAX_RESUMES {
                return Ok(None);
            }
            job.state = State::Running;
            job.resumes += 1;
            job.updated_at = now();
            job.clone()
        };
        self.save(&jobs)?;
        Ok(Some(claimed))
    }

    pub fn release(&self, id: &str, retry_at: u64, error: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        if let Some(job) = jobs.iter_mut().find(|job| job.id == id) {
            job.state = State::Paused;
            job.retry_at = retry_at;
            job.last_error = Some(error.chars().take(400).collect());
            job.updated_at = now();
        }
        self.save(&jobs)
    }

    pub fn finish(&self, id: &str, state: State, text: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        if let Some(job) = jobs.iter_mut().find(|job| job.id == id) {
            job.state = state;
            job.updated_at = now();
            match state {
                State::Done => job.final_text = Some(text.chars().take(16_000).collect()),
                State::Failed => job.last_error = Some(text.chars().take(400).collect()),
                _ => {}
            }
        }
        self.save(&jobs)
    }

    /// Cancels a paused job. A running one is left to finish.
    pub fn cancel(&self, id: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        let Some(job) = jobs.iter_mut().find(|job| job.id == id) else { return Ok(false) };
        if job.state != State::Paused {
            return Ok(false);
        }
        job.state = State::Cancelled;
        job.updated_at = now();
        self.save(&jobs)?;
        Ok(true)
    }

    /// Makes a paused job due now (the panel's **Resume now**).
    pub fn retry_now(&self, id: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        let Some(job) = jobs.iter_mut().find(|job| job.id == id) else { return Ok(false) };
        if job.state != State::Paused {
            return Ok(false);
        }
        job.retry_at = now();
        job.updated_at = now();
        self.save(&jobs)?;
        Ok(true)
    }

    pub fn due(&self, at: u64) -> Result<Vec<Job>, String> {
        Ok(self.list()?.into_iter().filter(|job| job.state == State::Paused && job.retry_at <= at).collect())
    }

    /// After a restart, a job that was running has no runner: try it again.
    pub fn recover(&self, at: u64) -> Result<u8, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let mut jobs = self.load()?;
        let mut recovered = 0;
        for job in jobs.iter_mut().filter(|job| job.state == State::Running) {
            job.state = State::Paused;
            job.retry_at = at + RECOVER_AFTER;
            job.last_error = Some("the run was interrupted by a restart; it will try again".to_owned());
            job.updated_at = now();
            recovered += 1;
        }
        if recovered > 0 {
            self.save(&jobs)?;
        }
        Ok(recovered)
    }

    /// Drops finished jobs older than [days], so the file does not grow forever.
    pub fn prune(&self, days: u64) -> Result<usize, String> {
        let _guard = self.lock.lock().map_err(|_| "the delegation registry lock is poisoned".to_owned())?;
        let cutoff = now().saturating_sub(days.saturating_mul(86_400));
        let mut jobs = self.load()?;
        let before = jobs.len();
        jobs.retain(|job| {
            !matches!(job.state, State::Done | State::Failed | State::Cancelled) || job.updated_at >= cutoff
        });
        if jobs.len() != before {
            self.save(&jobs)?;
        }
        Ok(before - jobs.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "autobot-delegations-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn scope() -> crate::delegate::Scope {
        crate::delegate::Scope { max_nudges: 2, stall_seconds: 600, until: Some("until done".into()) }
    }

    #[test]
    fn a_paused_job_survives_and_resumes() {
        let dir = dir();
        let jobs = Jobs::new(&dir);
        let job = Job::new("s1", "default", "fix the test", scope(), now() + 3600, false).unwrap();
        let id = job.id.clone();
        jobs.pause(job).unwrap();
        assert_eq!(jobs.get(&id).unwrap().unwrap().state, State::Paused);
        assert!(jobs.due(now()).unwrap().is_empty());
        assert!(jobs.claim(&id, now()).unwrap().is_none());
        assert!(jobs.retry_now(&id).unwrap());
        assert_eq!(jobs.due(now()).unwrap().len(), 1);
        assert!(jobs.claim(&id, now()).unwrap().is_some());
        assert_eq!(jobs.get(&id).unwrap().unwrap().state, State::Running);
        assert!(jobs.claim(&id, now()).unwrap().is_none());
        jobs.finish(&id, State::Done, "done").unwrap();
        assert_eq!(jobs.get(&id).unwrap().unwrap().final_text.as_deref(), Some("done"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancel_and_a_restart_are_handled() {
        let dir = dir();
        let jobs = Jobs::new(&dir);
        let a = Job::new("s1", "default", "one", scope(), now() + 10, false).unwrap();
        let b = Job::new("s2", "default", "two", scope(), now() + 10, true).unwrap();
        let (aid, bid) = (a.id.clone(), b.id.clone());
        jobs.pause(a).unwrap();
        jobs.pause(b).unwrap();
        assert!(jobs.cancel(&aid).unwrap());
        assert_eq!(jobs.get(&aid).unwrap().unwrap().state, State::Cancelled);
        assert!(!jobs.cancel(&aid).unwrap());
        assert!(jobs.claim(&bid, now() + 10).unwrap().is_some());
        assert_eq!(jobs.recover(now()).unwrap(), 1);
        let recovered = jobs.get(&bid).unwrap().unwrap();
        assert_eq!(recovered.state, State::Paused);
        assert!(recovered.retry_at > now());
        let _ = std::fs::remove_dir_all(dir);
    }
}
