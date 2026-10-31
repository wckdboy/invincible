//! Delegated turns: the owner hands a task over and walks away.
//!
//! A delegated turn may continue itself a bounded number of times when it stops to ask a
//! routine question, and it never accepts an approval: every safety check is declined with a
//! redirect that tells the agent to take a safer way or skip it. A turn that produces nothing
//! for `stall_seconds` is stopped and nudged once; a usage limit that clears within
//! [`MAX_LIMIT_WAIT`] is waited out, a longer one pauses the run with the retry time.
//!
//! Nothing here widens what the agent may do. It only decides whether the same agent, with the
//! same approver and the same tool policy, gets another turn.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The most nudges one delegated turn may add.
pub const MAX_NUDGES: u8 = 5;
/// The most turns one request may run, whatever the nudges and limits.
pub const MAX_ATTEMPTS: u8 = 8;
/// The longest a usage limit is waited out inside the request. A longer one pauses, with its
/// retry time, so the owner can decide when to resume; a client cannot be kept open for hours.
pub const MAX_LIMIT_WAIT: u64 = 300;
/// The shortest stall limit (a test may use a shorter one directly on [idle_limit]).
pub const MIN_STALL: u64 = 30;
pub const MAX_STALL: u64 = 3600;

/// The default: two nudges, fifteen quiet minutes per turn (longer while a tool runs).
pub fn default_scope() -> Scope {
    Scope { max_nudges: 2, stall_seconds: 900, until: None }
}

/// `"delegated": true`, or the scope: `{"max_nudges": 2, "stall_seconds": 600, "until": "…"}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Request {
    Enabled(bool),
    Scope(Scope),
}

impl Request {
    /// The scope, or None when delegation is explicitly off.
    pub fn scope(self) -> Result<Option<Scope>, String> {
        match self {
            Self::Enabled(false) => Ok(None),
            Self::Enabled(true) => Ok(Some(default_scope())),
            Self::Scope(scope) => {
                scope.check()?;
                Ok(Some(scope))
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    /// How many times the run may tell the agent to keep going.
    #[serde(default = "default_nudges")]
    pub max_nudges: u8,
    /// Stop a turn that produced no event for this many seconds.
    #[serde(default = "default_stall")]
    pub stall_seconds: u64,
    /// The owner's end condition, in their words, shown to the agent and in reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

fn default_nudges() -> u8 {
    default_scope().max_nudges
}

fn default_stall() -> u64 {
    default_scope().stall_seconds
}

impl Scope {
    pub fn check(&self) -> Result<(), String> {
        if self.max_nudges > MAX_NUDGES {
            return Err(format!("max_nudges is at most {MAX_NUDGES}"));
        }
        if !(MIN_STALL..=MAX_STALL).contains(&self.stall_seconds) {
            return Err(format!("stall_seconds is between {MIN_STALL} and {MAX_STALL}"));
        }
        if let Some(until) = &self.until
            && (until.chars().count() > 500 || until.chars().any(char::is_control))
        {
            return Err("until is at most 500 characters and has no control characters".to_owned());
        }
        Ok(())
    }

    pub fn started(&self, owner_controls: bool) -> Value {
        json!({
            "v": 1,
            "type": "delegate.started",
            "max_nudges": self.max_nudges,
            "stall_seconds": self.stall_seconds,
            "until": self.until,
            "approvals": "declined",
            "questions": if owner_controls { "owner" } else { "routine" },
        })
    }

    fn until_line(&self) -> String {
        match self.until.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            Some(until) => format!(" The owner's end condition: {until}."),
            None => String::new(),
        }
    }
}

/// Whether the owner's own words say to wait, not guess, or confirm. Delegation must not override
/// an explicit instruction with a nudge: these tasks stop for the owner at the first question.
pub fn owner_controls(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const PHRASES: &[&str] = &[
        "wait for my",
        "wait for me",
        "wait until i",
        "do not guess",
        "don't guess",
        "ask me",
        "ask first",
        "check with me",
        "let me decide",
        "confirm with me",
        "do not decide",
        "don't decide",
        "before writing anything, ask",
        "before doing anything, ask",
        "my answer",
        "my approval",
    ];
    PHRASES.iter().any(|phrase| lower.contains(phrase))
}

/// Whether the agent used the marker that says it needs the owner (and has stopped).
pub fn needs_owner(text: &str) -> bool {
    text.to_ascii_uppercase().contains("DELEGATION: NEED_OWNER")
}

/// Why the agent looks like it is waiting for the owner, if it does.
pub fn waiting_reason(text: &str) -> Option<&'static str> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some("the previous turn ended without an answer");
    }
    if needs_owner(trimmed) {
        return None;
    }
    if let Some(last) = trimmed.lines().rev().map(str::trim).find(|line| !line.is_empty()) {
        if last.starts_with("```") {
            return None;
        }
        let last = last.trim_end_matches(['`', '"', '\'', '*', '_', ' ']);
        let lower = last.to_lowercase();
        let questions =
            ["which", "what", "should", "would", "could", "can you", "do you", "how", "when", "where", "who"];
        if last.ends_with('?') || (last.contains('?') && questions.iter().any(|word| lower.contains(word))) {
            return Some("the previous answer asked a question");
        }
    }
    // Only the end of the answer: a question in the middle of a finished report does not stop
    // the agent. These are the ways an agent asks the owner to decide.
    let tail = trimmed.chars().rev().take(400).collect::<String>().chars().rev().collect::<String>().to_lowercase();
    const PHRASES: &[&str] = &[
        "should i ",
        "should we ",
        "would you like me to",
        "do you want me to",
        "please confirm",
        "can you confirm",
        "which would you prefer",
        "waiting for your",
        "awaiting your",
        "tell me which",
        "tell me what",
        "i need your ",
    ];
    PHRASES.iter().any(|phrase| tail.contains(phrase)).then_some("the previous answer waits for the owner")
}

/// The message that continues a paused delegated run in a fresh process: the conversation has
/// the request and its work, so it only has to look at the state and go on.
pub fn resume_task(scope: &Scope) -> String {
    let until = scope
        .until
        .as_deref()
        .map(|until| format!(" The owner's end condition still stands: {until}."))
        .unwrap_or_default();
    format!(
        "[delegated] The provider's usage limit has lifted and this task is resuming automatically. \
         The conversation has the request and the work so far. Check the current state of the \
         worktree, then continue from there. Do not repeat completed work, do not wait for the \
         owner, and do not ask for confirmation of routine steps.{until}"
    )
}

/// The message that gives the agent another turn. It is a user message like any other, so the
/// transcript shows exactly what delegation added.
pub fn nudge(scope: &Scope, number: u8, reason: &str) -> String {
    let reason = match reason.chars().next() {
        Some(first) => format!("{}{}", first.to_uppercase(), &reason[first.len_utf8()..]),
        None => "The previous answer stopped early".to_owned(),
    };
    format!(
        "[delegated] Do not wait for the owner. Decide routine details yourself and continue the task. \
         {reason}. Do not ask for confirmation of routine steps. If this needs a decision on product \
         direction, money, publishing, or something the owner reserved, stop and answer with one line \
         beginning `DELEGATION: NEED_OWNER` and say what you need. If the owner's original message \
         says to wait, not to guess, or to confirm, follow that instead. This is nudge {number} of {}.{}",
        scope.max_nudges,
        scope.until_line()
    )
}

/// After a stall: check what the stopped turn may have left behind before doing it again.
pub fn stall_nudge(seconds: u64) -> String {
    format!(
        "[delegated] The previous attempt produced nothing for {seconds} s and was stopped. Inspect the \
         current state (files and running commands) before continuing; do not repeat a step that may have \
         partly run. Then continue the task with a shorter step."
    )
}

/// After a usage limit cleared.
pub fn resume_nudge() -> String {
    "[delegated] The usage limit has cleared. Continue the task from where it stopped; check the \
     current state before repeating anything."
        .to_owned()
}

/// The seconds a gateway asked us to wait, from its error text
/// (`… (the gateway asks to wait 120 s before trying again)`).
pub fn wait_seconds(error: &str) -> Option<u64> {
    for marker in ["asks to wait ", "try again in ", "retry after ", "retry-after: "] {
        let Some((_, rest)) = error.split_once(marker) else { continue };
        let digits = rest.trim_start().chars().take_while(char::is_ascii_digit).collect::<String>();
        if let Ok(seconds) = digits.parse::<u64>() {
            return Some(seconds);
        }
    }
    None
}

/// Whether an error is a provider usage limit (429, quota, too many requests) even when it gave
/// no retry time.
pub fn is_usage_limit(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("usage limit")
        || lower.contains("too many requests")
        || lower.contains("quota")
}

/// The event that says the run is paused until [at] (unix seconds), when a client should try
/// again; None when the gateway did not say. With a [job_id] the run is persisted and resumes by
/// itself, so a client does not need to resend it.
pub fn paused(seconds: Option<u64>, job_id: Option<&str>, auto_resume: bool, resumes: u8) -> Value {
    let at = seconds.map(|s| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()).saturating_add(s)
    });
    let local = at.map(|at| {
        chrono::DateTime::from_timestamp(at as i64, 0)
            .map(|t| t.with_timezone(&chrono::Local).to_rfc3339())
            .unwrap_or_default()
    });
    json!({
        "v": 1,
        "type": "delegate.paused",
        "reason": "usage_limit",
        "retry_after_seconds": seconds,
        "retry_at": at,
        "retry_at_local": local,
        "job_id": job_id,
        "auto_resume": auto_resume,
        "resumes": resumes,
    })
}

/// POSTs one run's outcome to the configured webhook. The URL and the secret file are the
/// operator's; an error never names the URL, which may carry its own token.
pub async fn post(
    url: &str,
    home: &Path,
    config: &crate::config::DelegateConfig,
    report: &Value,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "the delegate webhook is not a URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("the delegate webhook must be http or https".to_owned());
    }
    let body = serde_json::to_vec(report).map_err(|e| format!("the delegate webhook body: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("the delegate webhook client: {e}"))?;
    let mut request = client
        .post(parsed)
        .header("content-type", "application/json")
        .header("user-agent", "invincible-autobot")
        .body(body.clone());
    if let Some(secret) = signature_secret(home, config) {
        let hex: String = crate::hooks::hmac(secret.as_bytes(), &body).iter().map(|b| format!("{b:02x}")).collect();
        request = request.header("x-invincible-signature", format!("sha256={hex}"));
    }
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            "the delegate webhook timed out".to_owned()
        } else {
            "the delegate webhook could not be reached".to_owned()
        }
    })?;
    if !response.status().is_success() {
        return Err(format!("the delegate webhook answered {}", response.status()));
    }
    Ok(())
}

/// The HMAC key, when the operator left one. A secret that is too short is ignored (the
/// payload is still sent, unsigned, rather than failing the run).
fn signature_secret(home: &Path, config: &crate::config::DelegateConfig) -> Option<String> {
    let path = config
        .webhook_secret_file
        .as_deref()
        .map(crate::config::expand)
        .map(|p| if p.is_absolute() { p } else { home.join(p) })
        .unwrap_or_else(|| home.join("delegate-webhook.secret"));
    let text = std::fs::read_to_string(path).ok()?;
    let secret = text.trim().to_owned();
    (secret.len() >= 8).then_some(secret)
}

/// Waits for [limit] with no tick; the caller spawns this and aborts it when the turn ends.
/// A tick is one event from the turn: a model that streams reasoning keeps it alive. A tool
/// that is running gets [TOOL_FACTOR] times as long, because a build or a test may be busy
/// without producing events; a tool that hangs still ends the turn eventually.
pub async fn idle_limit(
    mut ticks: tokio::sync::mpsc::UnboundedReceiver<()>,
    limit: Duration,
    in_tool: Arc<AtomicBool>,
) {
    loop {
        let wait = if in_tool.load(Ordering::Relaxed) { limit.saturating_mul(TOOL_FACTOR) } else { limit };
        tokio::select! {
            _ = tokio::time::sleep(wait) => return,
            tick = ticks.recv() => {
                if tick.is_none() {
                    return;
                }
            }
        }
    }
}

/// How much longer a running tool may take than the model between events.
const TOOL_FACTOR: u32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_question_at_the_end_waits_but_a_report_does_not() {
        assert_eq!(waiting_reason("Which file should I write?"), Some("the previous answer asked a question"));
        assert_eq!(
            waiting_reason("Done. Tests pass.\nWould you like me to open a PR?"),
            Some("the previous answer asked a question")
        );
        assert_eq!(waiting_reason("Done. All 42 tests pass."), None);
        assert_eq!(
            waiting_reason("Which filename do you want? (e.g. `delegated.txt` or `DELEGATED.md`)"),
            Some("the previous answer asked a question")
        );
        assert_eq!(waiting_reason("Done.\n\n```\nwhat?\n```"), None);
        assert_eq!(waiting_reason("I need your call on the license."), Some("the previous answer waits for the owner"));
        assert_eq!(waiting_reason("DELEGATION: NEED_OWNER the price is the owner's call"), None);
        assert!(needs_owner("DELEGATION: NEED_OWNER the price is the owner's call"));
        assert!(owner_controls("Ask me which file, then wait for my answer. Do not guess."));
        assert!(!owner_controls("Fix the failing test and run it once."));
        assert_eq!(waiting_reason("  "), Some("the previous turn ended without an answer"));
    }

    #[test]
    fn a_wait_is_read_from_the_gateway_error() {
        assert_eq!(
            wait_seconds("the gateway refused (429): busy (the gateway asks to wait 120 s before trying again)"),
            Some(120)
        );
        assert_eq!(wait_seconds("try again in 7 seconds"), Some(7));
        assert_eq!(wait_seconds("no time here"), None);
        assert!(is_usage_limit("the gateway refused (429): too many requests"));
        assert!(is_usage_limit("the provider's usage limit is reached"));
        assert!(!is_usage_limit("the file does not exist"));
    }

    #[test]
    fn the_scope_is_bounded() {
        let mut scope = default_scope();
        assert!(scope.check().is_ok());
        scope.max_nudges = MAX_NUDGES + 1;
        assert!(scope.check().is_err());
        scope = default_scope();
        scope.stall_seconds = MIN_STALL - 1;
        assert!(scope.check().is_err());
        scope = default_scope();
        scope.until = Some("x".repeat(501));
        assert!(scope.check().is_err());
        assert!(Request::Enabled(false).scope().unwrap().is_none());
        assert_eq!(Request::Enabled(true).scope().unwrap().unwrap().max_nudges, 2);
    }

    #[test]
    fn the_nudge_says_what_delegation_allows() {
        let scope = Scope { max_nudges: 2, stall_seconds: 600, until: Some("until the tests pass".into()) };
        let text = nudge(&scope, 1, "the previous answer asked a question");
        assert!(text.contains("nudge 1 of 2"));
        assert!(text.contains("The previous answer"), "{text}");
        assert!(text.contains("until the tests pass"));
        assert!(text.contains("DELEGATION: NEED_OWNER"));
        assert!(stall_nudge(600).contains("600 s"));
    }

    #[tokio::test(start_paused = true)]
    async fn the_idle_limit_resets_on_events() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(idle_limit(rx, Duration::from_secs(30), Arc::new(AtomicBool::new(false))));
        for _ in 0..4 {
            tokio::time::advance(Duration::from_secs(20)).await;
            tx.send(()).unwrap();
            tokio::task::yield_now().await;
        }
        assert!(!task.is_finished(), "events kept the turn alive");
        drop(tx);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(task.is_finished());
    }

    #[test]
    fn a_short_webhook_secret_is_ignored() {
        let dir = std::env::temp_dir().join(format!("autobot-delegate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::DelegateConfig::default();
        std::fs::write(dir.join("delegate-webhook.secret"), "short\n").unwrap();
        assert!(signature_secret(&dir, &config).is_none());
        std::fs::write(dir.join("delegate-webhook.secret"), "a long enough secret\n").unwrap();
        assert_eq!(signature_secret(&dir, &config).as_deref(), Some("a long enough secret"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn a_running_tool_gets_longer() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let in_tool = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(idle_limit(rx, Duration::from_secs(30), in_tool.clone()));
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished(), "a tool gets three times the idle limit");
        in_tool.store(false, Ordering::Relaxed);
        tx.send(()).unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(31)).await;
        tokio::task::yield_now().await;
        assert!(task.is_finished());
    }
}
