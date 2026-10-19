//! Scheduled tasks: the agent runs a task on a schedule inside `autobot serve`, with nobody there
//! to ask. Unattended runs follow `allowlist` rules (allowlisted commands and writes in the
//! working directory, nothing else) unless the approval mode is `trust`. Each run's answer is kept
//! in the schedule's own conversation (`cron-<id>`), and sent to Telegram when asked.
//!
//! `$AUTOBOT_HOME/schedules.json` holds the schedules (written by `autobot cron`), and
//! `cron-state.json` holds when each last ran (written by the scheduler). `autobot cron add` works
//! while the scheduler runs. Every run is also kept in `runs/<id>.jsonl` with its full answer and
//! receipt ids, so a phone that handed a recipe to this machine can collect the results.
//!
//! A schedule can come from Autobot as a recipe: it then has a name, the phone's id for it, and
//! the tool groups the recipe allows (only those tools are offered).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, TimeDelta, Timelike};
use serde::{Deserialize, Serialize};

/// When a task runs: a cron expression (`0 8 * * 1-5`, local time; `CRON_TZ=UTC 0 6 * * *` in
/// UTC) or `every <n>m|h|d`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum When {
    Cron(Cron),
    Every(Duration),
}

/// Five fields: minute, hour, day of month, month, day of week (0 or 7 = Sunday).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cron {
    minutes: Vec<bool>,
    hours: Vec<bool>,
    days: Vec<bool>,
    months: Vec<bool>,
    weekdays: Vec<bool>,
    /// Day of month and day of week both restricted: either one matching is enough (cron's rule).
    either_day: bool,
    /// In UTC (`CRON_TZ=UTC`) rather than the machine's local time.
    utc: bool,
}

impl When {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if let Some(rest) = text.strip_prefix("CRON_TZ=UTC ").or_else(|| text.strip_prefix("TZ=UTC ")) {
            return match Self::parse(rest)? {
                Self::Cron(cron) => Ok(Self::Cron(Cron { utc: true, ..cron })),
                Self::Every(_) => Err(format!("{text:?}: CRON_TZ goes with a cron expression")),
            };
        }
        if text.starts_with("CRON_TZ=") || text.starts_with("TZ=") {
            return Err(format!("{text:?}: only CRON_TZ=UTC is understood"));
        }
        let shorthand = match text {
            "@hourly" => Some("0 * * * *"),
            "@daily" | "@midnight" => Some("0 0 * * *"),
            "@weekly" => Some("0 0 * * 0"),
            "@monthly" => Some("0 0 1 * *"),
            _ => None,
        };
        if let Some(cron) = shorthand {
            return Cron::parse(cron).map(Self::Cron);
        }
        if let Some(rest) = text.strip_prefix("every ") {
            let rest = rest.trim();
            let (number, unit) = rest.split_at(rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len()));
            let n: u64 = number.parse().map_err(|_| format!("{text:?}: every <number>m, h or d"))?;
            let secs = match unit.trim() {
                "m" | "min" | "minutes" => 60,
                "h" | "hours" => 3600,
                "d" | "days" => 86400,
                _ => return Err(format!("{text:?}: every <number>m, h or d")),
            };
            if n == 0 {
                return Err(format!("{text:?}: the interval must be more than zero"));
            }
            // At most a year: longer intervals overflow date arithmetic and are surely a mistake.
            let total = n.checked_mul(secs).filter(|t| *t <= 366 * 86400);
            let total = total.ok_or_else(|| format!("{text:?}: at most a year (every 366d)"))?;
            return Ok(Self::Every(Duration::from_secs(total)));
        }
        Cron::parse(text).map(Self::Cron)
    }

    /// Whether a run is due at [now], given the last run (or, for a new schedule, when it was made).
    pub fn due(&self, last: Option<DateTime<Local>>, created: DateTime<Local>, now: DateTime<Local>) -> bool {
        match self {
            Self::Cron(cron) => {
                // Once per matching minute.
                cron.matches(now) && last.is_none_or(|l| minute(l) != minute(now))
            }
            Self::Every(interval) => {
                // In whole minutes, the scheduler's step: made at 10:00:40, `every 1m` runs at 10:01.
                let since = last.unwrap_or(created);
                (minute(now) - minute(since)) * 60 >= interval.as_secs() as i64
            }
        }
    }

    /// The next run after [now] (within a year), for `autobot cron list`.
    pub fn next(
        &self,
        last: Option<DateTime<Local>>,
        created: DateTime<Local>,
        now: DateTime<Local>,
    ) -> Option<DateTime<Local>> {
        match self {
            Self::Cron(cron) => {
                let mut t = now.with_second(0)?.with_nanosecond(0)? + TimeDelta::minutes(1);
                for _ in 0..(366 * 24 * 60) {
                    if cron.matches(t) {
                        return Some(t);
                    }
                    t += TimeDelta::minutes(1);
                }
                None
            }
            Self::Every(interval) => {
                Some(last.unwrap_or(created).checked_add_signed(TimeDelta::from_std(*interval).ok()?)?.max(now))
            }
        }
    }
}

fn minute(t: DateTime<Local>) -> i64 {
    t.timestamp().div_euclid(60)
}

impl Cron {
    pub fn parse(text: &str) -> Result<Self, String> {
        let fields: Vec<&str> = text.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = fields[..] else {
            return Err(format!(
                "{text:?}: a cron expression has five fields (minute hour day month weekday), or use `every 30m`"
            ));
        };
        let mut weekdays = field(weekday, 0, 7).map_err(|e| format!("weekday: {e}"))?;
        // 7 is Sunday too.
        if weekdays[7] {
            weekdays[0] = true;
        }
        weekdays.truncate(7);
        Ok(Self {
            minutes: field(minute, 0, 59).map_err(|e| format!("minute: {e}"))?,
            hours: field(hour, 0, 23).map_err(|e| format!("hour: {e}"))?,
            days: field(day, 1, 31).map_err(|e| format!("day: {e}"))?,
            months: field(month, 1, 12).map_err(|e| format!("month: {e}"))?,
            weekdays,
            either_day: day != "*" && weekday != "*",
            utc: false,
        })
    }

    pub fn matches(&self, t: DateTime<Local>) -> bool {
        if self.utc { self.matches_in(t.with_timezone(&chrono::Utc)) } else { self.matches_in(t) }
    }

    fn matches_in<T: Datelike + Timelike>(&self, t: T) -> bool {
        let day = self.days[t.day() as usize];
        let weekday = self.weekdays[t.weekday().num_days_from_sunday() as usize];
        let day_ok = if self.either_day { day || weekday } else { day && weekday };
        self.minutes[t.minute() as usize] && self.hours[t.hour() as usize] && self.months[t.month() as usize] && day_ok
    }
}

/// One field as a table of allowed values (indexed by value): `*`, `5`, `1-5`, `*/15`, `1-30/2`,
/// and lists of these.
fn field(text: &str, min: usize, max: usize) -> Result<Vec<bool>, String> {
    let mut allowed = vec![false; max + 1];
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, step.parse::<usize>().map_err(|_| format!("bad step in {part:?}"))?),
            None => (part, 1),
        };
        if step == 0 {
            return Err(format!("zero step in {part:?}"));
        }
        let (from, to) = match range {
            "*" => (min, max),
            _ => match range.split_once('-') {
                Some((a, b)) => (number(a, min, max)?, number(b, min, max)?),
                None => {
                    let n = number(range, min, max)?;
                    // `5/15` means from 5 to the end, every 15.
                    (n, if part.contains('/') { max } else { n })
                }
            },
        };
        if from > to {
            return Err(format!("{part:?} runs backwards"));
        }
        for value in (from..=to).step_by(step) {
            allowed[value] = true;
        }
    }
    Ok(allowed)
}

fn number(text: &str, min: usize, max: usize) -> Result<usize, String> {
    let n: usize = text.parse().map_err(|_| format!("{text:?} is not a number"))?;
    if n < min || n > max {
        return Err(format!("{n} is outside {min}-{max}"));
    }
    Ok(n)
}

/// A task on a schedule.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub when: String,
    pub task: String,
    /// Send each answer to the Telegram users who may use the bot.
    #[serde(default)]
    pub telegram: bool,
    /// Unix seconds.
    pub created: i64,
    /// A recipe's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Only the tools in these groups ([crate::tools::GROUPS]); every tool when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// Who handed it over: `device:<name>` for a paired phone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// A schedule as a client sends it (spec/agent.md); [id] set means "create or replace this one".
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScheduleSpec {
    #[serde(default)]
    pub id: Option<String>,
    pub when: String,
    pub task: String,
    #[serde(default)]
    pub telegram: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// One finished run, as `runs/<id>.jsonl` keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunRecord {
    /// Unix seconds.
    pub at: i64,
    pub finished: i64,
    pub ok: bool,
    /// The whole answer, or the error.
    pub result: String,
    /// The gateway receipts of the run's model calls.
    #[serde(default)]
    pub receipts: Vec<String>,
    /// `schedule` or `manual`.
    pub trigger: String,
}

/// Runs kept per schedule.
const KEEP_RUNS: usize = 100;

fn runs_path(home: &Path, id: &str) -> PathBuf {
    home.join("runs").join(format!("{id}.jsonl"))
}

/// Keeps [record] in [id]'s history, the newest [KEEP_RUNS].
pub fn record(home: &Path, id: &str, record: &RunRecord) -> Result<(), String> {
    let mut runs = runs(home, id, i64::MIN);
    runs.push(record.clone());
    let skip = runs.len().saturating_sub(KEEP_RUNS);
    let text: String = runs.iter().skip(skip).filter_map(|r| serde_json::to_string(r).ok()).map(|l| l + "\n").collect();
    invincible::fsutil::replace_private(&runs_path(home, id), &text)
}

/// [id]'s finished runs that started after [after] (unix seconds), oldest first.
pub fn runs(home: &Path, id: &str, after: i64) -> Vec<RunRecord> {
    std::fs::read_to_string(runs_path(home, id))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<RunRecord>(l).ok())
        .filter(|r| r.at > after)
        .collect()
}

/// A schedule id: letters, digits, `-` and `_`, 1 to 64 of them.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Schedules {
    #[serde(default)]
    pub schedules: Vec<Schedule>,
}

/// What the scheduler knows about past runs, by schedule id.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub runs: HashMap<String, Run>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    /// Unix seconds when it started.
    pub at: i64,
    pub ok: bool,
    /// The start of the answer, or the error.
    pub result: String,
}

fn load<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    match invincible::fsutil::read_optional(path)? {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        None => Ok(T::default()),
    }
}

fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    invincible::fsutil::replace_private(path, &serde_json::to_string_pretty(value).map_err(|e| e.to_string())?)
}

impl Schedules {
    pub fn path(home: &Path) -> PathBuf {
        home.join("schedules.json")
    }

    pub fn load(home: &Path) -> Result<Self, String> {
        load(&Self::path(home))
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        save(&Self::path(home), self)
    }

    /// Adds a schedule; checks [when] first. Returns its id.
    pub fn add(&mut self, when: &str, task: &str, telegram: bool) -> Result<String, String> {
        When::parse(when)?;
        if task.trim().is_empty() {
            return Err("the task is empty".to_owned());
        }
        let id =
            (1..).map(|n| format!("t{n}")).find(|id| !self.schedules.iter().any(|s| &s.id == id)).expect("a free id");
        self.schedules.push(Schedule {
            id: id.clone(),
            when: when.trim().to_owned(),
            task: task.trim().to_owned(),
            telegram,
            created: Local::now().timestamp(),
            name: None,
            tools: None,
            origin: None,
            enabled: true,
        });
        Ok(id)
    }

    /// Adds [spec], or replaces the schedule with its id (keeping when it was created, so an
    /// interval does not start over). Returns the id.
    pub fn put(&mut self, spec: ScheduleSpec, origin: Option<String>) -> Result<String, String> {
        When::parse(&spec.when)?;
        if spec.task.trim().is_empty() {
            return Err("the task is empty".to_owned());
        }
        if let Some(groups) = &spec.tools
            && let Some(unknown) = groups
                .iter()
                .find(|g| !["web", "vault"].contains(&g.as_str()) && !crate::tools::GROUPS.iter().any(|(n, _)| n == g))
        {
            return Err(format!("unknown tool group {unknown:?}"));
        }
        let id = match spec.id {
            Some(id) if valid_id(&id) => id,
            Some(id) => return Err(format!("{id:?} is not a schedule id (letters, digits, - and _)")),
            None => (1..)
                .map(|n| format!("t{n}"))
                .find(|id| !self.schedules.iter().any(|s| &s.id == id))
                .expect("a free id"),
        };
        if origin.is_some() && spec.tools.is_none() {
            return Err("a schedule from a device names its tools (\"tools\": [...])".to_owned());
        }
        if let Some(existing) = self.schedules.iter().find(|s| s.id == id)
            && existing.origin != origin
            && origin.is_some()
        {
            return Err(format!("{id} was made elsewhere; a device can replace only its own schedules"));
        }
        let created =
            self.schedules.iter().find(|s| s.id == id).map_or_else(|| Local::now().timestamp(), |s| s.created);
        self.schedules.retain(|s| s.id != id);
        self.schedules.push(Schedule {
            id: id.clone(),
            when: spec.when.trim().to_owned(),
            task: spec.task.trim().to_owned(),
            telegram: spec.telegram,
            created,
            name: spec.name.map(|n| n.trim().chars().take(120).collect()).filter(|n: &String| !n.is_empty()),
            tools: spec.tools,
            origin,
            enabled: spec.enabled,
        });
        Ok(id)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.schedules.len();
        self.schedules.retain(|s| s.id != id);
        before != self.schedules.len()
    }
}

impl State {
    pub fn path(home: &Path) -> PathBuf {
        home.join("cron-state.json")
    }

    pub fn load(home: &Path) -> Result<Self, String> {
        load(&Self::path(home))
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        save(&Self::path(home), self)
    }
}

pub fn local(secs: i64) -> DateTime<Local> {
    DateTime::from_timestamp(secs, 0).unwrap_or_default().with_timezone(&Local)
}

/// The schedules due at [now], with the state as it stands.
pub fn due(schedules: &Schedules, state: &State, now: DateTime<Local>) -> Vec<Schedule> {
    schedules
        .schedules
        .iter()
        .filter(|s| {
            if !s.enabled {
                return false;
            }
            let Ok(when) = When::parse(&s.when) else { return false };
            when.due(state.runs.get(&s.id).map(|r| local(r.at)), local(s.created), now)
        })
        .cloned()
        .collect()
}

/// The schedules as spec/agent.md shows them: with their next run and how the last one went.
pub fn listing(home: &Path) -> Result<serde_json::Value, String> {
    let schedules = Schedules::load(home)?;
    let state = State::load(home)?;
    let now = Local::now();
    let list: Vec<serde_json::Value> = schedules
        .schedules
        .iter()
        .map(|s| {
            let last = state.runs.get(&s.id);
            let next = When::parse(&s.when)
                .ok()
                .filter(|_| s.enabled)
                .and_then(|w| w.next(last.map(|r| local(r.at)), local(s.created), now));
            let mut item = serde_json::json!({
                "id": s.id,
                "when": s.when,
                "task": s.task,
                "telegram": s.telegram,
                "enabled": s.enabled,
                "running": RUNNING.lock().expect("running").contains(&s.id),
                "next": next.map(|t| t.timestamp()),
                "last": last.map(|r| serde_json::json!({ "at": r.at, "ok": r.ok, "result": r.result })),
            });
            for (key, value) in [
                ("name", s.name.clone().map(serde_json::Value::from)),
                ("origin", s.origin.clone().map(serde_json::Value::from)),
                ("tools", s.tools.clone().map(serde_json::Value::from)),
            ] {
                if let Some(value) = value {
                    item[key] = value;
                }
            }
            item
        })
        .collect();
    Ok(serde_json::json!({ "schedules": list }))
}

/// Schedules running now, here (the scheduler's and "run now"'s together).
static RUNNING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

/// Runs [schedule] once, unattended: its answer and the receipts of its model calls.
pub async fn run(agent: &crate::agent::Agent, home: &Path, schedule: &Schedule) -> (Run, Vec<String>) {
    let mut unattended = agent.clone();
    if unattended.approvals.mode != crate::config::ApprovalMode::Trust {
        unattended.approvals.mode = crate::config::ApprovalMode::Allowlist;
    }
    if let Some(groups) = &schedule.tools {
        unattended.tools = unattended.tools.clone().only(crate::tools::tools_for(groups));
    }
    let started = Local::now().timestamp();
    let outcome = async {
        let mut session = crate::session::Session::open(&home.join("sessions"), &format!("cron-{}", schedule.id))?;
        let mut grants = std::collections::HashSet::new();
        unattended.turn(&mut session, &schedule.task, &crate::approval::Refuse, &mut grants, &|_| {}).await
    }
    .await;
    match outcome {
        Ok(outcome) => (Run { at: started, ok: true, result: outcome.text }, outcome.receipts),
        Err(e) => (Run { at: started, ok: false, result: e }, Vec::new()),
    }
}

/// Starts [schedule] in the background unless it is already running (false then): marks it in
/// the state, runs it, records the run, and sends the answer to Telegram when the schedule asks.
pub fn start(
    agent: std::sync::Arc<crate::agent::Agent>,
    home: PathBuf,
    schedule: Schedule,
    trigger: &'static str,
    telegram: Option<crate::telegram::Bot>,
) -> bool {
    if !RUNNING.lock().expect("running").insert(schedule.id.clone()) {
        return false;
    }
    let now = Local::now().timestamp();
    // Mark it now, so a long run is not started again next round.
    let mut state = State::load(&home).unwrap_or_default();
    state.runs.insert(schedule.id.clone(), Run { at: now, ok: true, result: "running".into() });
    if let Err(e) = state.save(&home) {
        tracing::warn!("cron: {e}");
    }
    tokio::spawn(async move {
        tracing::info!(id = %schedule.id, trigger, "cron: running {:?}", schedule.task);
        let (result, receipts) = run(&agent, &home, &schedule).await;
        tracing::info!(id = %schedule.id, ok = result.ok, "cron: done");
        let mut state = State::load(&home).unwrap_or_default();
        state.runs.insert(schedule.id.clone(), Run { result: cut(&result.result), ..result.clone() });
        if let Err(e) = state.save(&home) {
            tracing::warn!("cron: {e}");
        }
        let kept = RunRecord {
            at: result.at,
            finished: Local::now().timestamp(),
            ok: result.ok,
            result: result.result.chars().take(64 * 1024).collect(),
            receipts,
            trigger: trigger.to_owned(),
        };
        if let Err(e) = record(&home, &schedule.id, &kept) {
            tracing::warn!("cron: {e}");
        }
        if schedule.telegram
            && let Some(bot) = telegram
        {
            let text = format!(
                "⏰ {}\n\n{}{}",
                schedule.name.as_deref().unwrap_or(&schedule.task),
                if result.ok { "" } else { "✗ " },
                result.result
            );
            for user in crate::telegram::Users::load(&home).map(|u| u.allowed).unwrap_or_default() {
                if let Err(e) = bot.send(user.id, &text).await {
                    tracing::warn!("cron: Telegram: {e}");
                }
            }
        }
        RUNNING.lock().expect("running").remove(&schedule.id);
    });
    true
}

/// Runs schedules as they come due until the process stops. Re-reads `schedules.json` each round,
/// so `autobot cron add` / `remove` take effect without a restart.
pub async fn scheduler(
    agent: std::sync::Arc<crate::agent::Agent>,
    home: PathBuf,
    telegram: Option<crate::telegram::Bot>,
) {
    loop {
        let now = Local::now();
        match (Schedules::load(&home), State::load(&home)) {
            (Ok(schedules), Ok(state)) => {
                for schedule in due(&schedules, &state, now) {
                    start(agent.clone(), home.clone(), schedule, "schedule", telegram.clone());
                }
            }
            (Err(e), _) | (_, Err(e)) => tracing::warn!("cron: {e}"),
        }
        // Wake at the start of each minute (cron's resolution), a second in.
        let wait = 61 - Local::now().second() as u64;
        tokio::time::sleep(Duration::from_secs(wait.min(60))).await;
    }
}

/// The start of a long answer, for the state file and `autobot cron list`.
fn cut(text: &str) -> String {
    if text.chars().count() <= 2000 { text.to_owned() } else { text.chars().take(2000).collect::<String>() + "…" }
}

#[cfg(test)]
mod tests {
    use super::{Schedules, State, When, due, local};
    use chrono::{Local, TimeZone};
    use std::time::Duration;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    #[test]
    fn cron_expressions() {
        let weekday_mornings = When::parse("0 8 * * 1-5").unwrap();
        let created = at(2026, 10, 1, 0, 0);
        // 2026-10-19 is a Monday, 2026-10-18 a Sunday.
        assert!(weekday_mornings.due(None, created, at(2026, 10, 19, 8, 0)));
        assert!(!weekday_mornings.due(None, created, at(2026, 10, 18, 8, 0)));
        assert!(!weekday_mornings.due(None, created, at(2026, 10, 19, 8, 1)));
        // Once per minute, however often the scheduler looks.
        assert!(!weekday_mornings.due(Some(at(2026, 10, 19, 8, 0)), created, at(2026, 10, 19, 8, 0)));
        assert_eq!(weekday_mornings.next(None, created, at(2026, 10, 17, 9, 30)), Some(at(2026, 10, 19, 8, 0)));

        let quarter = When::parse("*/15 9-17 * * *").unwrap();
        assert!(quarter.due(None, created, at(2026, 10, 18, 9, 45)));
        assert!(!quarter.due(None, created, at(2026, 10, 18, 18, 0)));
        // Day of month or day of week, when both are given (cron's rule): the 1st, or any Sunday.
        let either = When::parse("0 0 1 * 0").unwrap();
        assert!(either.due(None, created, at(2026, 10, 18, 0, 0)));
        assert!(either.due(None, created, at(2026, 11, 1, 0, 0)));
        assert!(!either.due(None, created, at(2026, 11, 2, 0, 0)));
        assert!(When::parse("0 0 * * 7").unwrap().due(None, created, at(2026, 10, 18, 0, 0)));
        assert_eq!(When::parse("@daily").unwrap(), When::parse("0 0 * * *").unwrap());

        for bad in [
            "",
            "* * * *",
            "60 * * * *",
            "* 24 * * *",
            "*/0 * * * *",
            "5-1 * * * *",
            "every",
            "every 0m",
            "every 5 parsecs",
        ] {
            assert!(When::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn utc_cron() {
        let when = When::parse("CRON_TZ=UTC 30 6 * * 1-5").unwrap();
        let utc = chrono::Utc.with_ymd_and_hms(2026, 10, 19, 6, 30, 0).unwrap().with_timezone(&Local);
        assert!(when.due(None, utc - chrono::TimeDelta::days(1), utc));
        assert!(!when.due(None, utc, utc + chrono::TimeDelta::minutes(1)));
        assert!(When::parse("CRON_TZ=Europe/Oslo 0 7 * * *").is_err());
        assert!(When::parse("CRON_TZ=UTC every 5m").is_err());
        assert!(When::parse("every 100000000000d").is_err());
        assert!(When::parse("every 144115188075855872d").is_err());
        assert!(When::parse("every 366d").is_ok());
    }

    #[test]
    fn intervals() {
        let every = When::parse("every 30m").unwrap();
        assert_eq!(every, When::Every(Duration::from_secs(1800)));
        let created = at(2026, 10, 18, 10, 0);
        assert!(!every.due(None, created, at(2026, 10, 18, 10, 29)));
        assert!(every.due(None, created, at(2026, 10, 18, 10, 30)));
        assert!(!every.due(Some(at(2026, 10, 18, 10, 30)), created, at(2026, 10, 18, 10, 59)));
        // Made a few seconds into a minute, a one-minute task still runs at the next minute.
        let minutely = When::parse("every 1m").unwrap();
        let made = at(2026, 10, 18, 10, 0) + chrono::TimeDelta::seconds(40);
        assert!(minutely.due(None, made, at(2026, 10, 18, 10, 1) + chrono::TimeDelta::seconds(1)));
        assert_eq!(When::parse("every 2h").unwrap(), When::Every(Duration::from_secs(7200)));
        assert_eq!(When::parse("every 1d").unwrap(), When::Every(Duration::from_secs(86400)));
    }

    #[test]
    fn schedules_add_check_and_come_due() {
        let mut schedules = Schedules::default();
        assert!(schedules.add("0 25 * * *", "x", false).is_err());
        assert!(schedules.add("@hourly", " ", false).is_err());
        let id = schedules.add("@hourly", "check the disk", true).unwrap();
        assert_eq!(id, "t1");
        assert_eq!(schedules.add("every 5m", "y", false).unwrap(), "t2");
        schedules.schedules[0].created = at(2026, 10, 18, 9, 0).timestamp();
        schedules.schedules[1].created = at(2026, 10, 18, 9, 0).timestamp();
        let state = State::default();
        let now = at(2026, 10, 18, 10, 0);
        assert_eq!(due(&schedules, &state, now).len(), 2);
        assert!(schedules.remove("t1"));
        assert!(!schedules.remove("t1"));
        assert_eq!(local(now.timestamp()), now);
    }
}
