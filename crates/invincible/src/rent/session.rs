//! One rental on disk, and the transitions it is allowed to take.
//!
//! quoting is the unconfirmed preview: nothing is written. A confirmed create is
//! provisioning → hydrating → ready → draining → stopped. failed is the escape, and a failed
//! session that still has a pod can go back to draining so the sweeper can delete it.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::provider::{Endpoint, Offer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Provisioning,
    Hydrating,
    Ready,
    Draining,
    Stopped,
    Failed,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provisioning => "provisioning",
            Self::Hydrating => "hydrating",
            Self::Ready => "ready",
            Self::Draining => "draining",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }

    pub fn active(self) -> bool {
        matches!(self, Self::Provisioning | Self::Hydrating | Self::Ready | Self::Draining)
    }

    pub fn can_go(self, to: Self) -> bool {
        self == to
            || matches!(
                (self, to),
                (Self::Provisioning, Self::Hydrating | Self::Draining | Self::Failed)
                    | (Self::Hydrating, Self::Ready | Self::Draining | Self::Failed)
                    | (Self::Ready, Self::Draining | Self::Failed)
                    | (Self::Draining, Self::Ready | Self::Stopped | Self::Failed)
                    | (Self::Failed, Self::Draining)
                    // A stop that finished before the pod id existed can be reopened once that pod appears.
                    | (Self::Stopped, Self::Draining)
            )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub at: DateTime<Utc>,
    pub phase: Phase,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub preset_id: String,
    pub hours: f64,
    pub created_at: DateTime<Utc>,
    pub deadline_at: DateTime<Utc>,
    /// Last time the owner touched the session (create, or a status read). The sweeper stops a
    /// ready pod that has been quiet for `idle_minutes`.
    pub last_active: DateTime<Utc>,
    pub phase: Phase,
    pub offer: Offer,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instance_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pod_status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub data_center: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<Endpoint>,
    pub cost_estimate_usd: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cost_actual_usd: f64,
    #[serde(default)]
    pub drain_ok: bool,
    #[serde(default)]
    pub forced: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub warning: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<Event>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

impl Session {
    pub fn note(&mut self, at: DateTime<Utc>, message: impl Into<String>) {
        self.events.push(Event { at, phase: self.phase, message: message.into() });
    }

    pub fn go(&mut self, to: Phase, at: DateTime<Utc>, message: impl Into<String>) -> Result<(), String> {
        if !self.phase.can_go(to) {
            return Err(format!("invalid session transition {} -> {}", self.phase.as_str(), to.as_str()));
        }
        self.phase = to;
        self.note(at, message);
        Ok(())
    }

    /// The JSON a client sees. Events stay on disk.
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "project_id": self.project_id,
            "preset_id": self.preset_id,
            "hours": self.hours,
            "created_at": self.created_at.to_rfc3339(),
            "deadline_at": self.deadline_at.to_rfc3339(),
            "last_active": self.last_active.to_rfc3339(),
            "phase": self.phase.as_str(),
            "offer": self.offer,
            "instance_id": empty_null(&self.instance_id),
            "pod_status": empty_null(&self.pod_status),
            "data_center": empty_null(&self.data_center),
            "endpoints": self.endpoints,
            "cost_estimate_usd": self.cost_estimate_usd,
            "cost_actual_usd": self.cost_actual_usd,
            "drain_ok": self.drain_ok,
            "forced": self.forced,
            "error": empty_null(&self.error),
            "warning": empty_null(&self.warning),
            "ended_at": self.ended_at.map(|at| at.to_rfc3339()),
        })
    }
}

fn empty_null(text: &str) -> Value {
    if text.is_empty() { Value::Null } else { Value::String(text.to_owned()) }
}

static SAVE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self { dir: dir.to_owned() })
    }

    /// Sessions that parsed, and a warning for each file that did not. One bad file does not
    /// hide the rest. A failure to read the directory is the only hard error.
    pub fn list(&self) -> Result<(Vec<Session>, Vec<String>), String> {
        let mut sessions = Vec::new();
        let mut warnings = Vec::new();
        for entry in std::fs::read_dir(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    warnings.push(format!("{}: {err}", self.dir.display()));
                    continue;
                }
            };
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(err) => {
                    warnings.push(format!("{}: {err}", path.display()));
                    continue;
                }
            };
            match serde_json::from_str::<Session>(&text) {
                Ok(session) => sessions.push(session),
                Err(err) => warnings.push(format!("{}: {err}", path.display())),
            }
        }
        sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
        Ok((sessions, warnings))
    }

    pub fn get(&self, id: &str) -> Result<Option<Session>, String> {
        let path = self.path(id);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn save(&self, session: &Session) -> Result<(), String> {
        let path = self.path(&session.id);
        let bytes = serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?;
        let n = SAVE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self.dir.join(format!(".{}.{}.{n}.tmp", session.id, std::process::id()));
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
            file.write_all(&bytes)
                .and_then(|()| file.write_all(b"\n"))
                .map_err(|e| format!("{}: {e}", tmp.display()))?;
        }
        std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
}

pub fn new_id() -> Result<String, String> {
    Ok(format!("sess_{}", crate::token::hex(&crate::token::random::<8>()?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_machine_refuses_a_skip() {
        assert!(Phase::Provisioning.can_go(Phase::Hydrating));
        assert!(!Phase::Provisioning.can_go(Phase::Ready));
        assert!(Phase::Failed.can_go(Phase::Draining));
        assert!(!Phase::Stopped.can_go(Phase::Ready));
    }
}
