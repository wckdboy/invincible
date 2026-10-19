//! The team board: work that outlives a turn. The lead plans tasks for its members with
//! dependencies (`board_plan`); `autobot serve` runs each as soon as what it depends on is done
//! (at most `[team] max_parallel` at once), handing the member the results it builds on. A
//! member that needs the owner asks (`ask_owner`): its task waits, the question goes to the
//! chat that asked for the plan, and the answer (`/board answer`, the app) sends it on. When a
//! plan is finished, its results go to that chat.
//!
//! Board runs have nobody watching, so they follow the unattended rules, like scheduled tasks:
//! allowlisted commands and writes in the working directory only (unless the mode is `trust`).
//!
//! `$AUTOBOT_HOME/board.json` holds the tasks.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Todo,
    Running,
    /// Waiting for the owner's answer.
    Blocked,
    Done,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    /// The plan it belongs to: tasks made by one `board_plan` call.
    pub plan: String,
    pub agent: String,
    pub goal: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub status: Status,
    #[serde(default)]
    pub result: Option<String>,
    /// The member's question while blocked; the questions and answers so far (handed to it again).
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub answers: Vec<String>,
    #[serde(default)]
    pub receipts: Vec<String>,
    /// Where the plan was asked for: its conversation, and the Telegram chat to tell.
    pub origin: String,
    #[serde(default)]
    pub notify: Option<i64>,
    /// Unix seconds.
    pub created: i64,
    pub updated: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Board {
    #[serde(default)]
    pub tasks: Vec<Task>,
}

/// One task as the lead plans it: [key] names it for [depends_on] within the plan.
#[derive(Clone, Debug, Deserialize)]
pub struct Planned {
    pub key: String,
    pub agent: String,
    pub goal: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// Plans kept on the board after they finish (older ones are dropped).
const KEEP_PLANS: usize = 50;

fn path(home: &Path) -> PathBuf {
    home.join("board.json")
}

fn now() -> i64 {
    chrono::Local::now().timestamp()
}

impl Board {
    pub fn load(home: &Path) -> Result<Self, String> {
        match invincible::fsutil::read_optional(&path(home))? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path(home).display())),
            None => Ok(Self::default()),
        }
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        invincible::fsutil::replace_private(
            &path(home),
            &serde_json::to_string_pretty(self).map_err(|e| e.to_string())?,
        )
    }

    pub fn get(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id == id)
    }

    /// Adds a plan: the tasks with ids, their keys' dependencies resolved. Checks members,
    /// unknown keys and cycles first. Returns the plan id and the tasks' ids, by key.
    pub fn plan(
        &mut self,
        team: &crate::team::Team,
        planned: &[Planned],
        origin: &str,
        notify: Option<i64>,
    ) -> Result<(String, Vec<(String, String)>), String> {
        if planned.is_empty() {
            return Err("a plan needs at least one task".to_owned());
        }
        if planned.len() > 12 {
            return Err("at most 12 tasks in a plan".to_owned());
        }
        for p in planned {
            if team.get(&p.agent).is_none() {
                return Err(format!("{:?}: there is no team member {:?}", p.key, p.agent));
            }
            if p.goal.trim().is_empty() {
                return Err(format!("{:?}: the goal is empty", p.key));
            }
            if let Some(unknown) = p.depends_on.iter().find(|d| !planned.iter().any(|q| &q.key == *d)) {
                return Err(format!("{:?} depends on {unknown:?}, which is not in the plan", p.key));
            }
        }
        // Cycles: every task must be reachable in dependency order.
        let mut placed: Vec<&str> = Vec::new();
        while placed.len() < planned.len() {
            let next = planned.iter().find(|p| {
                !placed.contains(&p.key.as_str()) && p.depends_on.iter().all(|d| placed.contains(&d.as_str()))
            });
            match next {
                Some(p) => placed.push(&p.key),
                None => return Err("the plan's dependencies go in a circle".to_owned()),
            }
        }
        let number = |prefix: &str| {
            (1..).map(|n| format!("{prefix}{n}")).find(|id| !self.tasks.iter().any(|t| &t.id == id || &t.plan == id))
        };
        let plan = number("p").expect("a free id");
        let mut ids = Vec::new();
        for p in planned {
            let id = (1..)
                .map(|n| format!("b{n}"))
                .find(|id| {
                    !self.tasks.iter().any(|t| &t.id == id) && !ids.iter().any(|(_, i): &(String, String)| i == id)
                })
                .expect("a free id");
            ids.push((p.key.clone(), id));
        }
        let id_of = |key: &str| ids.iter().find(|(k, _)| k == key).map(|(_, id)| id.clone()).unwrap_or_default();
        let at = now();
        for p in planned {
            self.tasks.push(Task {
                id: id_of(&p.key),
                plan: plan.clone(),
                agent: p.agent.clone(),
                goal: p.goal.trim().to_owned(),
                context: p.context.trim().to_owned(),
                depends_on: p.depends_on.iter().map(|d| id_of(d)).collect(),
                status: Status::Todo,
                result: None,
                question: None,
                answers: Vec::new(),
                receipts: Vec::new(),
                origin: origin.to_owned(),
                notify,
                created: at,
                updated: at,
            });
        }
        self.forget_old_plans();
        Ok((plan, ids))
    }

    fn forget_old_plans(&mut self) {
        let mut finished: Vec<(i64, String)> = Vec::new();
        for task in &self.tasks {
            let plan_done = self
                .tasks
                .iter()
                .filter(|t| t.plan == task.plan)
                .all(|t| matches!(t.status, Status::Done | Status::Failed));
            if plan_done && !finished.iter().any(|(_, p)| p == &task.plan) {
                finished.push((task.updated, task.plan.clone()));
            }
        }
        finished.sort();
        let drop = finished.len().saturating_sub(KEEP_PLANS);
        let gone: Vec<String> = finished.into_iter().take(drop).map(|(_, p)| p).collect();
        self.tasks.retain(|t| !gone.contains(&t.plan));
    }

    /// Tasks ready to run: to do, everything they depend on done. Tasks whose dependency failed
    /// fail too (said why).
    pub fn ready(&mut self) -> Vec<Task> {
        let failed: Vec<String> =
            self.tasks.iter().filter(|t| t.status == Status::Failed).map(|t| t.id.clone()).collect();
        let at = now();
        for task in self.tasks.iter_mut().filter(|t| t.status == Status::Todo) {
            if let Some(dep) = task.depends_on.iter().find(|d| failed.contains(d)) {
                task.status = Status::Failed;
                task.result = Some(format!("not started: {dep}, which it builds on, failed"));
                task.updated = at;
            }
        }
        let done: Vec<String> = self.tasks.iter().filter(|t| t.status == Status::Done).map(|t| t.id.clone()).collect();
        self.tasks
            .iter()
            .filter(|t| t.status == Status::Todo && t.depends_on.iter().all(|d| done.contains(d)))
            .cloned()
            .collect()
    }

    /// What a member is handed for [task]: its goal, the plan's context, the results it builds
    /// on, and the owner's answers to its questions.
    pub fn brief(&self, task: &Task) -> String {
        let mut brief = format!("Goal: {}", task.goal);
        if !task.context.is_empty() {
            brief.push_str("\n\nContext:\n");
            brief.push_str(&task.context);
        }
        for dep in &task.depends_on {
            if let Some(d) = self.get(dep) {
                brief.push_str(&format!(
                    "\n\nResult of {} ({}: {}):\n{}",
                    d.id,
                    d.agent,
                    d.goal,
                    d.result.as_deref().unwrap_or("(none)")
                ));
            }
        }
        for exchange in &task.answers {
            brief.push_str("\n\n");
            brief.push_str(exchange);
        }
        brief
    }

    pub fn set(&mut self, id: &str, status: Status, result: Option<String>, receipts: Vec<String>) {
        if let Some(task) = self.get_mut(id) {
            task.status = status;
            if result.is_some() {
                task.result = result;
            }
            task.receipts.extend(receipts);
            task.updated = now();
        }
    }

    /// The member running [id] needs the owner: the task waits for [answer].
    pub fn block(&mut self, id: &str, question: &str) -> Result<(), String> {
        let task = self.get_mut(id).ok_or(format!("there is no board task {id:?}"))?;
        task.status = Status::Blocked;
        task.question = Some(question.trim().chars().take(1000).collect());
        task.updated = now();
        Ok(())
    }

    /// The owner's answer to [id]'s question: it runs again with it.
    pub fn answer(&mut self, id: &str, answer: &str) -> Result<(), String> {
        let task = self.get_mut(id).ok_or(format!("there is no board task {id:?}"))?;
        if task.status != Status::Blocked {
            return Err(format!("{id} is not waiting for an answer"));
        }
        let answer: String = answer.trim().chars().take(2000).collect();
        task.answers.push(format!(
            "You asked the owner: {}\nThe owner answered: {answer}",
            task.question.take().unwrap_or_default()
        ));
        task.status = Status::Todo;
        task.updated = now();
        Ok(())
    }

    /// Whether every task of [plan] is done or failed.
    pub fn finished(&self, plan: &str) -> bool {
        self.tasks.iter().filter(|t| t.plan == plan).all(|t| matches!(t.status, Status::Done | Status::Failed))
    }

    /// A short listing: one line per task, newest plans last.
    pub fn listing(&self) -> String {
        if self.tasks.is_empty() {
            return "The board is empty.".to_owned();
        }
        self.tasks
            .iter()
            .map(|t| {
                let mark = match t.status {
                    Status::Todo => "·",
                    Status::Running => "▸",
                    Status::Blocked => "?",
                    Status::Done => "✓",
                    Status::Failed => "✗",
                };
                let after = if t.depends_on.is_empty() {
                    String::new()
                } else {
                    format!(" (after {})", t.depends_on.join(", "))
                };
                let extra = match t.status {
                    Status::Blocked => format!("\n    asks: {}", t.question.as_deref().unwrap_or("")),
                    Status::Done | Status::Failed => {
                        format!(
                            "\n    {}",
                            t.result
                                .as_deref()
                                .unwrap_or("")
                                .lines()
                                .next()
                                .unwrap_or("")
                                .chars()
                                .take(200)
                                .collect::<String>()
                        )
                    }
                    _ => String::new(),
                };
                format!("{mark} {} [{}] {}: {}{after}{extra}", t.id, t.plan, t.agent, t.goal)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The lead's board tools.
pub fn lead_tools(team: &crate::team::Team) -> Vec<serde_json::Value> {
    let names: Vec<&str> = team.roles.iter().map(|r| r.name.as_str()).collect();
    vec![
        serde_json::json!({ "type": "function", "function": {
            "name": "board_plan",
            "description": "Plan work for your team that runs in the background, beyond this conversation: tasks for members, each starting when the tasks it depends on are done, and getting their results. Independent tasks run at the same time. When all are done, the results come to the owner. Use delegate instead for something quick you need now.",
            "parameters": { "type": "object", "properties": { "tasks": { "type": "array", "items": { "type": "object", "properties": {
                "key": { "type": "string", "description": "A short name for this task, for depends_on" },
                "agent": { "type": "string", "enum": names },
                "goal": { "type": "string" },
                "context": { "type": "string", "description": "What it needs to know" },
                "depends_on": { "type": "array", "items": { "type": "string" }, "description": "Keys of tasks whose results it needs" },
            }, "required": ["key", "agent", "goal"] } } }, "required": ["tasks"] },
        }}),
        serde_json::json!({ "type": "function", "function": {
            "name": "board_status",
            "description": "The team board: every task, its member, status and result.",
            "parameters": { "type": "object", "properties": {} },
        }}),
    ]
}

/// A member's tool while it works on a board task.
pub fn ask_owner_tool() -> serde_json::Value {
    serde_json::json!({ "type": "function", "function": {
        "name": "ask_owner",
        "description": "Ask the owner something you cannot decide or find yourself. Your task waits for the answer, then you get it and go on.",
        "parameters": { "type": "object", "properties": { "question": { "type": "string" } }, "required": ["question"] },
    }})
}

/// `board_plan`: adds the plan, for the chat this turn is in.
pub fn plan_tool(home: &Path, team: &crate::team::Team, arguments: &str) -> String {
    #[derive(Deserialize)]
    struct Args {
        tasks: Vec<Planned>,
    }
    let Ok(args) = serde_json::from_str::<Args>(arguments) else {
        return "error: board_plan takes {\"tasks\": [{\"key\", \"agent\", \"goal\", \"context\", \"depends_on\"}]}"
            .to_owned();
    };
    let turn = crate::tools::TURN.try_with(Clone::clone).ok().unwrap_or_default();
    let planned = Board::load(home).and_then(|mut board| {
        let made = board.plan(team, &args.tasks, &turn.session, turn.telegram_chat)?;
        board.save(home)?;
        Ok(made)
    });
    match planned {
        Ok((plan, ids)) => format!(
            "planned {plan}: {}; it runs in the background and the results come to the owner when it is done",
            ids.iter().map(|(key, id)| format!("{key} = {id}")).collect::<Vec<_>>().join(", ")
        ),
        Err(e) => format!("error: {e}"),
    }
}

/// Runs ready board tasks until the process stops (inside `autobot serve`). Questions and
/// finished plans go to the plan's Telegram chat (members' own bots post their results there).
pub async fn dispatcher(
    agent: std::sync::Arc<crate::agent::Agent>,
    home: PathBuf,
    telegram: Option<(crate::telegram::Bot, std::sync::Arc<crate::telegram::Bots>)>,
) {
    // The tasks being worked on now (an answered task must not start twice while its last run ends).
    let running: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Default::default();
    // A restart finds tasks it was running: they run again.
    if let Ok(mut board) = Board::load(&home) {
        for task in board.tasks.iter_mut().filter(|t| t.status == Status::Running) {
            task.status = Status::Todo;
        }
        let _ = board.save(&home);
    }
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if agent.team.is_empty() {
            continue;
        }
        let mut board = match Board::load(&home) {
            Ok(board) => board,
            Err(e) => {
                tracing::warn!("board: {e}");
                continue;
            }
        };
        let busy = running.lock().expect("running").clone();
        let ready: Vec<Task> = board.ready().into_iter().filter(|t| !busy.contains(&t.id)).collect();
        let free = agent.team.max_parallel.saturating_sub(busy.len());
        let starting: Vec<Task> = ready.into_iter().take(free).collect();
        for task in &starting {
            board.set(&task.id, Status::Running, None, Vec::new());
        }
        // Tasks that failed because what they build on failed may finish a plan.
        if let Err(e) = board.save(&home) {
            tracing::warn!("board: {e}");
            continue;
        }
        for task in starting {
            running.lock().expect("running").insert(task.id.clone());
            let (agent, home, telegram, running) = (agent.clone(), home.clone(), telegram.clone(), running.clone());
            tokio::spawn(async move {
                work(&agent, &home, &task, telegram.as_ref()).await;
                running.lock().expect("running").remove(&task.id);
            });
        }
    }
}

/// One board task: the member works it, unattended; then the board says how it went.
async fn work(
    agent: &crate::agent::Agent,
    home: &Path,
    task: &Task,
    telegram: Option<&(crate::telegram::Bot, std::sync::Arc<crate::telegram::Bots>)>,
) {
    let Some(role) = agent.team.get(&task.agent).cloned() else {
        if let Ok(mut board) = Board::load(home) {
            board.set(
                &task.id,
                Status::Failed,
                Some(format!("there is no team member {:?} any more", task.agent)),
                vec![],
            );
            let _ = board.save(home);
        }
        return;
    };
    let brief = Board::load(home).map(|b| b.brief(task)).unwrap_or_else(|_| format!("Goal: {}", task.goal));
    let mut unattended = agent.clone();
    if unattended.approvals.mode != crate::config::ApprovalMode::Trust {
        unattended.approvals.mode = crate::config::ApprovalMode::Allowlist;
    }
    unattended.tools = unattended.tools.clone().unattended();
    let post = |member: Option<&str>, text: String| {
        let telegram = telegram.cloned();
        let chat = task.notify;
        let member = member.map(str::to_owned);
        async move {
            let (Some((bot, bots)), Some(chat)) = (telegram, chat) else { return };
            let own = member.as_ref().and_then(|m| bots.members.get(m));
            if let Some(own) = own
                && own.send(chat, &text).await.is_ok()
            {
                return;
            }
            let text = match member {
                Some(m) => format!("[{m}] {text}"),
                None => text,
            };
            let _ = bot.send(chat, &text).await;
        }
    };
    tracing::info!(task = %task.id, agent = %task.agent, "board: working");
    let session = format!("board-{}-{}", task.id, task.answers.len());
    let context =
        crate::tools::TurnContext { session: session.clone(), telegram_chat: task.notify, ..Default::default() };
    let run = unattended.run_member(&role, &session, &brief, &crate::approval::Refuse, &|_| {}, Some(task.id.clone()));
    let outcome = crate::tools::TURN.scope(context, run).await;
    let Ok(mut board) = Board::load(home) else { return };
    // It asked the owner during this run: the task waits (or, answered already, runs again);
    // the run's own answer ("waiting…") is not the task's result.
    let asked =
        board.get(&task.id).is_some_and(|t| t.status == Status::Blocked || t.answers.len() > task.answers.len());
    if asked {
        if let Some(t) = board.get(&task.id).filter(|t| t.status == Status::Blocked) {
            let question = t.question.clone().unwrap_or_default();
            post(
                Some(&task.agent),
                format!("❓ {} asks: {question}\n\nAnswer with /board answer {} <your answer>", task.id, task.id),
            )
            .await;
        }
        return;
    }
    match outcome {
        Ok(outcome) => {
            post(Some(&task.agent), format!("✓ {}: {}", task.id, outcome.text)).await;
            board.set(&task.id, Status::Done, Some(outcome.text), outcome.receipts);
        }
        Err(e) => {
            post(Some(&task.agent), format!("✗ {}: {e}", task.id)).await;
            board.set(&task.id, Status::Failed, Some(e), vec![]);
        }
    }
    // Dependents of a failed task fail too; a plan may be done now.
    let _ = board.ready();
    if let Err(e) = board.save(home) {
        tracing::warn!("board: {e}");
    }
    if board.finished(&task.plan) {
        let lines: Vec<String> = board
            .tasks
            .iter()
            .filter(|t| t.plan == task.plan)
            .map(|t| {
                let mark = if t.status == Status::Done { "✓" } else { "✗" };
                let result = t.result.as_deref().unwrap_or_default();
                format!("{mark} {} {}: {}\n{}", t.id, t.agent, t.goal, result.chars().take(600).collect::<String>())
            })
            .collect();
        post(None, format!("📋 Plan {} is done:\n\n{}", task.plan, lines.join("\n\n"))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{Board, Planned, Status};

    fn team() -> crate::team::Team {
        let roles = std::collections::BTreeMap::from([
            (
                "researcher".to_owned(),
                crate::team::RoleConfig {
                    description: "r".into(),
                    instructions: None,
                    tools: vec![],
                    model: None,
                    telegram_token_file: None,
                },
            ),
            (
                "writer".to_owned(),
                crate::team::RoleConfig {
                    description: "w".into(),
                    instructions: None,
                    tools: vec![],
                    model: None,
                    telegram_token_file: None,
                },
            ),
        ]);
        crate::team::Team::from_config(&roles, &Default::default()).unwrap()
    }

    fn planned(key: &str, agent: &str, after: &[&str]) -> Planned {
        Planned {
            key: key.into(),
            agent: agent.into(),
            goal: format!("do {key}"),
            context: String::new(),
            depends_on: after.iter().map(|a| (*a).to_owned()).collect(),
        }
    }

    #[test]
    fn plans_run_in_dependency_order_with_results_handed_on() {
        let mut board = Board::default();
        let (plan, ids) = board
            .plan(
                &team(),
                &[
                    planned("find", "researcher", &[]),
                    planned("draft", "writer", &["find"]),
                    planned("check", "researcher", &[]),
                ],
                "lead",
                Some(7),
            )
            .unwrap();
        assert_eq!(plan, "p1");
        assert_eq!(ids, [("find".into(), "b1".into()), ("draft".into(), "b2".into()), ("check".into(), "b3".into())]);
        let ready: Vec<String> = board.ready().into_iter().map(|t| t.id).collect();
        assert_eq!(ready, ["b1", "b3"], "independent tasks run at once");
        board.set("b1", Status::Done, Some("Found: /srv/backup".into()), vec!["r1".into()]);
        let ready = board.ready();
        assert_eq!(ready[0].id, "b2");
        let brief = board.brief(&ready[0]);
        assert!(
            brief.starts_with("Goal: do draft")
                && brief.contains("Result of b1 (researcher: do find):\nFound: /srv/backup"),
            "{brief}"
        );
        // A question waits for the owner, then the task runs again with the answer.
        board.block("b2", "Which format?").unwrap();
        assert!(board.ready().iter().all(|t| t.id != "b2"));
        assert!(board.answer("b3", "x").is_err(), "not waiting");
        board.answer("b2", "Markdown").unwrap();
        let again = board.ready().into_iter().find(|t| t.id == "b2").unwrap();
        assert!(board.brief(&again).contains("You asked the owner: Which format?\nThe owner answered: Markdown"));
        assert!(!board.finished(&plan));
        board.set("b2", Status::Done, Some("ok".into()), vec![]);
        board.set("b3", Status::Done, Some("ok".into()), vec![]);
        assert!(board.finished(&plan));
    }

    #[test]
    fn bad_plans_are_refused_and_failures_spread() {
        let mut board = Board::default();
        assert!(board.plan(&team(), &[planned("a", "nobody", &[])], "l", None).unwrap_err().contains("no team member"));
        assert!(
            board.plan(&team(), &[planned("a", "writer", &["x"])], "l", None).unwrap_err().contains("not in the plan")
        );
        assert!(
            board
                .plan(&team(), &[planned("a", "writer", &["b"]), planned("b", "writer", &["a"])], "l", None)
                .unwrap_err()
                .contains("circle")
        );
        assert!(board.plan(&team(), &[], "l", None).is_err());
        board.plan(&team(), &[planned("a", "writer", &[]), planned("b", "writer", &["a"])], "l", None).unwrap();
        board.set("b1", Status::Failed, Some("broke".into()), vec![]);
        assert!(board.ready().is_empty());
        assert_eq!(board.get("b2").unwrap().status, Status::Failed);
        assert!(board.get("b2").unwrap().result.as_deref().unwrap().contains("b1, which it builds on, failed"));
        assert!(board.listing().contains("✗ b2 [p1] writer: do b (after b1)"));
    }
}
