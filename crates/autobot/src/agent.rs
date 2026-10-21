//! The agent loop: ask the gateway, run the tool calls it answers with (approved first), hand back
//! the results, and repeat until the model answers in words or the step budget runs out.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::approval::{self, Action, Answer, Approver, Verdict};
use crate::config::ApprovalConfig;
use crate::gateway::{Gateway, GatewayError};
use crate::session::Session;
use crate::tools::Tools;

#[derive(Clone)]
pub struct Agent {
    pub gateway: Gateway,
    pub tools: Tools,
    pub approvals: ApprovalConfig,
    pub max_steps: usize,
    /// Members the agent can hand work to (empty: no `delegate` tool).
    pub team: std::sync::Arc<crate::team::Team>,
    /// MCP servers whose tools it has.
    pub mcp: std::sync::Arc<crate::mcp::Hub>,
    /// Where finished turns are kept for fine-tuning ([crate::trajectory]); None: not kept.
    pub trajectories: Option<std::sync::Arc<crate::trajectory::Recorder>>,
    pub options: Options,
}

/// How the agent works, beyond its tools and approvals.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// KiB of recent conversation sent per call (default [crate::session::CHAR_BUDGET]).
    pub context_kib: Option<usize>,
    /// Whether the model takes images (None: not known); images are not sent when it does not.
    pub vision: Option<bool>,
    /// The personality for this conversation (`/personality`); None: the one in use
    /// ([crate::personality::active]); `none` for none.
    pub personality: Option<String>,
    /// Every this many turns, [Agent::nudge] looks for what to keep (0: never).
    pub nudge_every: usize,
    /// Who this bot is, when it is not the default one ([crate::bots]). Its `SOUL.md` is in its
    /// own home ([crate::personality]).
    pub persona: Option<Persona>,
    /// The model that summarizes earlier conversations for `search_sessions` (None: the agent's
    /// own; `off`: no summaries) ([crate::recall]).
    pub recall_model: Option<String>,
}

/// A bot's name.
#[derive(Clone, Debug, Default)]
pub struct Persona {
    pub name: Option<String>,
}

/// What happens during a turn, for whoever is watching (a terminal, a chat).
#[derive(Debug)]
pub enum Event<'a> {
    /// A tool is about to run.
    Tool(&'a str),
    /// A tool call was refused, by policy or by the owner.
    Refused(&'a str),
    /// A model call finished; its receipt can be fetched from the gateway.
    Receipt { id: &'a str, model: Option<&'a str>, tier: Option<&'a str> },
    /// A team member finished the task it was handed: its answer to the lead.
    Member { name: &'a str, text: &'a str },
    /// Part of the answer, as it streams in (when the gateway streams).
    Text(&'a str),
    /// Part of the model's reasoning, as it streams in.
    Reasoning(&'a str),
    /// What a write or an edit changes, as a unified diff: before it is approved.
    Diff(&'a str),
    /// The same change whole, right after its [Event::Diff]: the file, its text before (empty
    /// when it is new) and after (for an editor that shows changes itself, [crate::acp]).
    Change { path: &'a std::path::Path, before: &'a str, after: &'a str },
    /// What a tool handed back to the model.
    Output { name: &'a str, text: &'a str },
    /// Tokens one model call used: input (of which cached), output.
    Usage { input: u64, output: u64, cached: u64 },
}

/// What a refused tool call hands back to the model: that the owner said no, and what they said
/// to do instead when they said it.
pub fn refusal(action: &Action, instead: Option<String>) -> String {
    let base = format!("refused: the owner did not approve this ({})", action.describe());
    match instead {
        Some(text) => format!("{base}. Instead, the owner says: {}", text.trim()),
        None => base,
    }
}

pub struct Outcome {
    pub text: String,
    pub receipts: Vec<String>,
}

impl Agent {
    /// One turn: [text] from the owner, the answer back. Everything is kept in [session];
    /// [grants] holds what the owner said "always" to in this session.
    pub async fn turn(
        &self,
        session: &mut Session,
        text: &str,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<Outcome, String> {
        self.turn_with(session, text, &[], approver, grants, events).await
    }

    /// [Agent::turn] with [images] shown beside the owner's [text] ([crate::images]).
    pub async fn turn_with(
        &self,
        session: &mut Session,
        text: &str,
        images: &[crate::images::Attachment],
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<Outcome, String> {
        // Tools that act later know which conversation (and Telegram chat) this turn is for.
        let outer = crate::tools::TURN.try_with(Clone::clone).ok().unwrap_or_default();
        // The main agent's turns go into the turn log ([crate::insights]); one that is stopped
        // (dropped mid-way) is logged as stopped.
        let pending = TurnLog {
            log: self.tools.home().filter(|_| outer.agent.is_none()).map(crate::insights::Log::new),
            tally: crate::insights::Tally::default(),
            session: session.id.clone(),
            project: self.tools.workdir().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            started: std::time::Instant::now(),
            done: false,
        };
        let seen = |event: Event| {
            pending.tally.see(&event);
            events(event)
        };
        let context = crate::tools::TurnContext { session: session.id.clone(), ..outer };
        let result =
            crate::tools::TURN.scope(context, self.turn_inner(session, text, images, approver, grants, &seen)).await;
        let mut pending = pending;
        pending.finish(match &result {
            Ok(outcome) if outcome.text.starts_with("Stopped after ") => "stopped",
            Ok(_) => "answer",
            Err(_) => "error",
        });
        result
    }

    /// Whether a conversation now [messages] is at a nudge: every [Options::nudge_every] turns,
    /// for an agent with a home to keep things in.
    pub fn nudge_due(&self, messages: &[Value]) -> bool {
        let every = self.options.nudge_every;
        let turns = messages.iter().filter(|m| crate::session::is_request(m)).count();
        self.tools.home().is_some() && every > 0 && turns > 0 && turns.is_multiple_of(every)
    }

    /// The short look back every [Options::nudge_every] turns: one cheap call over the recent
    /// conversation for durable facts about the owner and their work, kept in the profile
    /// (USER.md) and memory through the same checks as the tools (never secrets or personal data).
    /// What it kept, a line each (`profile: …`, `memory: …`); nothing when it is not time, the
    /// call fails, or nothing is worth keeping.
    pub async fn nudge(&self, messages: &[Value], events: &(dyn Fn(Event) + Send + Sync)) -> Vec<String> {
        let Some(home) = self.tools.home() else { return Vec::new() };
        if !self.nudge_due(messages) {
            return Vec::new();
        }
        let every = self.options.nudge_every;
        let turns: Vec<usize> =
            messages.iter().enumerate().filter(|(_, m)| crate::session::is_request(m)).map(|(i, _)| i).collect();
        let from = turns[turns.len().saturating_sub(every)];
        let mut transcript = String::new();
        for m in &messages[from..] {
            let (Some(role @ ("user" | "assistant")), Some(text)) = (m["role"].as_str(), m["content"].as_str()) else {
                continue;
            };
            if !text.trim().is_empty() {
                transcript.push_str(&format!("{role}: {}\n", text.chars().take(1500).collect::<String>()));
            }
        }
        let known_profile = crate::profile::prompt(home).unwrap_or_else(|| "(empty)".into());
        let known_memory = crate::memory::Memory::new(home).prompt().unwrap_or_else(|| "(empty)".into());
        let ask = [
            json!({ "role": "system", "content": "You keep an assistant's long-term notes about its owner. From the conversation, pick at most 3 durable things worth keeping that are not known yet: how the owner works or wants things done (\"profile\": preferences, tools, style), or facts about their machine, projects and decisions (\"memory\"). Skip one-off details, anything already known, secrets and personal data. Each item is one short line. Answer with JSON only: {\"profile\": [...], \"memory\": [...]}, empty lists when nothing is worth keeping." }),
            json!({ "role": "user", "content": format!(
                "Known profile:\n{known_profile}\n\nKnown memory:\n{known_memory}\n\nConversation:\n{}",
                transcript.chars().take(16_000).collect::<String>()
            ) }),
        ];
        let reply = match self.gateway.chat(&ask, &json!([]), false).await {
            Ok(reply) => reply,
            Err(e) => {
                tracing::debug!("no nudge: {e}");
                return Vec::new();
            }
        };
        if let Some(id) = &reply.request_id {
            let decision = reply.decision.as_ref();
            events(Event::Receipt {
                id,
                model: decision.and_then(|d| d["model"].as_str()),
                tier: decision.and_then(|d| d["tier"].as_str()),
            });
        }
        let text = reply.message["content"].as_str().unwrap_or_default();
        let Some(found) = text
            .find('{')
            .zip(text.rfind('}'))
            .and_then(|(a, b)| (a < b).then(|| serde_json::from_str::<Value>(&text[a..=b]).ok()).flatten())
        else {
            return Vec::new();
        };
        let items = |key: &str| -> Vec<String> {
            found[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_owned()))
                .filter(|s| !s.is_empty())
                .take(3)
                .collect()
        };
        let mut kept = Vec::new();
        for entry in items("profile") {
            let change = crate::profile::Change::Add(entry.clone());
            if crate::profile::update(home, &change).is_ok_and(|r| !r.starts_with("already")) {
                kept.push(format!("profile: {entry}"));
            }
        }
        let memory = crate::memory::Memory::new(home);
        for fact in items("memory") {
            let known = memory.list().iter().any(|f| f.text == fact);
            if !known && crate::profile::sensitive(&fact).is_none() && memory.add(&fact).is_ok() {
                kept.push(format!("memory: {fact}"));
            }
        }
        kept
    }

    async fn turn_inner(
        &self,
        session: &mut Session,
        text: &str,
        images: &[crate::images::Attachment],
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<Outcome, String> {
        // What the trajectory notes: the models that answered and what was refused.
        let refused = std::sync::atomic::AtomicU64::new(0);
        let models = std::sync::Mutex::new(Vec::<String>::new());
        let outer_events = events;
        let counted = |event: Event| {
            match &event {
                Event::Refused(_) => {
                    refused.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                Event::Receipt { model: Some(model), .. } => {
                    let mut models = models.lock().expect("models");
                    if !models.iter().any(|m| m == model) {
                        models.push((*model).to_owned());
                    }
                }
                _ => {}
            }
            outer_events(event)
        };
        let events: &(dyn Fn(Event) + Send + Sync) = &counted;
        let started = std::time::Instant::now();
        let session_name = session.id.clone();
        let record =
            |sent: &[Value], definitions: &Value, last: Value, outcome: &str, steps: usize, receipts: &[String]| {
                let Some(recorder) = &self.trajectories else { return };
                let mut messages = sent.to_vec();
                messages.push(last);
                let agent = crate::tools::TURN.try_with(|t| t.agent.clone()).ok().flatten();
                recorder.record(json!({
                    "messages": messages,
                    "tools": definitions,
                    "meta": {
                        "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                        "session": session_name,
                        "agent": agent,
                        "models": *models.lock().expect("models"),
                        "receipts": receipts,
                        "steps": steps,
                        "refused": refused.load(std::sync::atomic::Ordering::Relaxed),
                        "seconds": started.elapsed().as_secs(),
                        "outcome": outcome,
                        "source": "turn",
                    },
                }));
            };
        session.close_dangling()?;
        if let Some(kib) = self.options.context_kib {
            session.budget = kib.max(8) * 1024;
        }
        session.push(crate::images::message(text, images))?;
        let mut definitions = self.tools.definitions();
        if self.leads_team()
            && let Some(list) = definitions.as_array_mut()
        {
            list.push(self.team.definition());
        }
        if let Some(list) = definitions.as_array_mut() {
            if self.leads_team() && self.team.configured() && self.tools.home().is_some() {
                list.extend(crate::board::lead_tools(&self.team));
            }
            if crate::tools::TURN.try_with(|t| t.board_task.is_some()).unwrap_or(false) {
                list.push(crate::board::ask_owner_tool());
            }
        }
        // Speech and pictures, when the node can make them ([crate::media]).
        if self.tools.offers("speak") || self.tools.offers("generate_image") {
            let media = self.tools.media().get(&self.gateway).await;
            if let Some(list) = definitions.as_array_mut() {
                list.extend(
                    crate::media::definitions(&media)
                        .into_iter()
                        .filter(|d| self.tools.offers(d["function"]["name"].as_str().unwrap_or_default())),
                );
            }
        }
        if !self.mcp.is_empty()
            && self.tools.offers("mcp")
            && let Some(list) = definitions.as_array_mut()
        {
            let (tools, problems) = self.mcp.tools().await;
            for problem in problems {
                tracing::warn!("{problem}");
            }
            for tool in tools {
                list.push(json!({ "type": "function", "function": {
                    "name": tool.qualified(), "description": tool.description, "parameters": tool.schema,
                }}));
            }
        }
        // The instructions are read once a turn (its files: memory, skills, the project's
        // notes): the same for every step, so a model's prompt cache keeps the whole prefix, and
        // no step waits on the disk for them again.
        let instructions = self.system_prompt();
        let mut receipts = Vec::new();
        let mut confirmed = false;
        // Times the window was made smaller after the model said the request was too long.
        let mut shrunk = 0;
        let mut steps = 0;
        let mut sent: Vec<Value> = Vec::new();
        let mut loops = Loops::default();
        loop {
            steps += 1;
            if steps > self.max_steps {
                let note =
                    format!("Stopped after {} steps ([agent] max_steps); say \"continue\" to go on.", self.max_steps);
                let last = json!({ "role": "assistant", "content": note });
                session.push(last.clone())?;
                // What was sent last, its tool results, and the stop.
                let mut tail = sent.clone();
                if let Some(at) =
                    session.messages.iter().rposition(|m| m["role"] == "assistant" && m["tool_calls"].is_array())
                {
                    tail.extend(session.messages[at..session.messages.len() - 1].iter().cloned());
                }
                record(&tail, &definitions, last, "stopped", steps - 1, &receipts);
                return Ok(Outcome { text: note, receipts });
            }
            // What the owner added while it works (the lead only: members get their brief).
            let added: Vec<String> = crate::tools::TURN
                .try_with(|t| {
                    t.agent.is_none().then(|| t.inbox.as_ref().map(|i| std::mem::take(&mut *i.lock().expect("inbox"))))
                })
                .ok()
                .flatten()
                .flatten()
                .unwrap_or_default();
            for text in added {
                session
                    .push(json!({ "role": "user", "content": format!("(The owner adds, while you work:) {text}") }))?;
            }
            let mut messages = vec![Value::Null];
            // Again after a cloud model is confirmed: the summary goes to the same model.
            if steps == 1 {
                self.compact(session, confirmed, events).await;
            }
            let mut system = instructions.clone();
            if let Some(summary) = session.summary() {
                system.push_str("\n\nEarlier in this conversation (a summary; the recent part follows):\n");
                system.push_str(summary);
            }
            messages[0] = json!({ "role": "system", "content": system });
            messages.extend(session.window());
            // What was sent, kept only for a trajectory.
            if self.trajectories.is_some() {
                sent.clone_from(&messages);
            }
            let streamed = |delta: crate::gateway::Delta| match delta {
                crate::gateway::Delta::Text(text) => events(Event::Text(text)),
                crate::gateway::Delta::Reasoning(text) => events(Event::Reasoning(text)),
            };
            // Images go as parts, read from their files now; the session and trajectories keep
            // only their references.
            // (Reading and scaling them is slow work: off the task that draws the terminal.)
            let expanded;
            let wire: &[Value] = if crate::images::any(&messages) {
                let (owned, vision) = (messages.clone(), self.options.vision);
                expanded = tokio::task::spawn_blocking(move || crate::images::expand(&owned, vision))
                    .await
                    .map_err(|e| format!("the images: {e}"))?;
                &expanded
            } else {
                &messages
            };
            let reply = match self.gateway.chat_with(wire, &definitions, confirmed, &streamed).await {
                Ok(reply) => reply,
                Err(GatewayError::Confirm(why)) if !confirmed => {
                    let action = Action::Cloud(why);
                    if self.allowed(&session.id, &action, approver, grants, events).await.is_ok() {
                        confirmed = true;
                        steps -= 1;
                        continue;
                    }
                    return Err("Not sent: the cloud model was not approved.".to_owned());
                }
                // Longer than the model takes: a smaller window (what leaves it is summarized,
                // long results cleared), and the same step again; a few times at most.
                Err(GatewayError::Failed(e)) if crate::gateway::overflow(&e) && shrunk < 3 => {
                    shrunk += 1;
                    session.budget = (session.budget * 2 / 3).max(8 * 1024);
                    tracing::warn!("{e}: sending less of the conversation ({} KiB)", session.budget / 1024);
                    self.compact(session, confirmed, events).await;
                    steps -= 1;
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            if let Some(id) = &reply.request_id {
                receipts.push(id.clone());
                let decision = reply.decision.as_ref();
                events(Event::Receipt {
                    id,
                    model: decision.and_then(|d| d["model"].as_str()),
                    tier: decision.and_then(|d| d["tier"].as_str()),
                });
            }
            if let Some((input, output, cached)) = reply.usage.as_ref().and_then(crate::gateway::tokens) {
                events(Event::Usage { input, output, cached });
            }
            let mut message = reply.message;
            if let Some(object) = message.as_object_mut() {
                // Reasoning is not part of the conversation the model sees again.
                object.remove("reasoning_content");
            }
            let calls = tool_calls(&mut message);
            session.push(message.clone())?;
            if calls.is_empty() {
                record(&sent, &definitions, message.clone(), "answer", steps, &receipts);
                let text = message["content"].as_str().unwrap_or_default().trim().to_owned();
                return Ok(Outcome { text: if text.is_empty() { "(no answer)".to_owned() } else { text }, receipts });
            }
            // Hand-offs to the team in one reply work at the same time (bounded); the rest in order.
            let (delegated, own): (Vec<_>, Vec<_>) =
                calls.into_iter().partition(|(_, name, _)| name == "delegate" && self.leads_team());
            if !delegated.is_empty() {
                let gate = tokio::sync::Semaphore::new(self.team.max_parallel.max(1));
                let runs = delegated.iter().enumerate().map(|(n, (_, _, arguments))| {
                    let gate = &gate;
                    let parent = session.id.clone();
                    async move {
                        let _permit = gate.acquire().await.ok();
                        self.delegate(&parent, n, arguments, approver, events).await
                    }
                });
                let results = futures_util::future::join_all(runs).await;
                for ((id, _, _), (text, child_receipts)) in delegated.iter().zip(results) {
                    receipts.extend(child_receipts);
                    session.push(json!({ "role": "tool", "tool_call_id": id, "content": text }))?;
                }
            }
            // Reads that need no approval, next to each other, run at the same time; the rest in
            // order. Results go back in the order the model asked.
            let mut screenshots: Vec<crate::images::Attachment> = Vec::new();
            let mut rest = own.into_iter().peekable();
            while let Some(first) = rest.next() {
                let mut batch = vec![first];
                while batch.iter().all(|(_, n, a)| self.reads_freely(n, a))
                    && rest.peek().is_some_and(|(_, n, a)| self.reads_freely(n, a))
                {
                    batch.extend(rest.next());
                }
                if batch.len() > 1 {
                    let quiet = |event: Event| {
                        if !matches!(event, Event::Tool(_)) {
                            events(event)
                        }
                    };
                    let at = session.messages.len();
                    let runs = batch.iter().map(|(_, name, arguments)| {
                        let quiet = &quiet;
                        let id = session.id.clone();
                        async move { self.call(&id, at, name, arguments, approver, &mut HashSet::new(), quiet).await }
                    });
                    let results = futures_util::future::join_all(runs).await;
                    for ((id, name, arguments), result) in batch.iter().zip(results) {
                        events(Event::Tool(&format!("{name} {arguments}")));
                        events(Event::Output { name, text: &result });
                        let result = loops.note(name, arguments, result);
                        session.push(json!({ "role": "tool", "tool_call_id": id, "content": result }))?;
                    }
                    continue;
                }
                let (id, name, arguments) = batch.remove(0);
                let at = session.messages.len();
                let result = self.call(&session.id, at, &name, &arguments, approver, grants, events).await;
                events(Event::Output { name: &name, text: &result });
                let result = loops.note(&name, &arguments, result);
                session.push(json!({ "role": "tool", "tool_call_id": id, "content": result }))?;
                // A browser screenshot is shown to a model that can see (a tool result cannot
                // carry an image; a message of its own can).
                if name == "browser"
                    && self.options.vision != Some(false)
                    && let Some(path) = result.strip_prefix("saved a screenshot").and_then(|r| r.rsplit_once(": "))
                    && let Ok(image) = crate::images::attach(std::path::Path::new(path.1.trim()))
                {
                    screenshots.push(image);
                }
            }
            if !screenshots.is_empty() {
                let note = format!("{}: what the page looks like now)", crate::session::SCREENSHOT_NOTE);
                session.push(crate::images::message(&note, &std::mem::take(&mut screenshots)))?;
            }
            // Going round in circles: the same call, the same result, again and again.
            if let Some(name) = loops.stuck() {
                let note = format!(
                    "Stopped: the same {name} call kept giving the same result ({STUCK} times), so it was going \
                     round in circles; say what to try instead."
                );
                let last = json!({ "role": "assistant", "content": note });
                session.push(last.clone())?;
                record(&sent, &definitions, last, "stopped", steps, &receipts);
                return Ok(Outcome { text: note, receipts });
            }
        }
    }

    /// A call that only reads in the working directory: nothing to approve, safe to run beside
    /// others.
    fn reads_freely(&self, name: &str, arguments: &str) -> bool {
        matches!(name, "read_file" | "list_dir" | "search" | "find_files")
            && self.tools.parse(name, arguments).is_ok_and(|call| self.tools.action(&call).is_none())
    }

    /// Whether this agent hands work to a team: it has members, and it is not one itself.
    fn leads_team(&self) -> bool {
        !self.team.is_empty() && crate::tools::TURN.try_with(|t| t.agent.is_none()).unwrap_or(true)
    }

    /// One `delegate` call: the member works the task in a fresh conversation of its own, with
    /// its tools and instructions, asking the owner through [approver]; its answer and receipts.
    async fn delegate(
        &self,
        parent: &str,
        n: usize,
        arguments: &str,
        approver: &dyn Approver,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> (String, Vec<String>) {
        let args: Value = serde_json::from_str(arguments).unwrap_or_default();
        let name = args["agent"].as_str().unwrap_or_default();
        let Some(role) = self.team.get(name) else {
            let names: Vec<&str> = self.team.roles.iter().map(|r| r.name.as_str()).collect();
            return (format!("error: there is no team member {name:?} (members: {})", names.join(", ")), Vec::new());
        };
        let Some(goal) = args["goal"].as_str().map(str::trim).filter(|g| !g.is_empty()) else {
            return ("error: `goal` is missing".to_owned(), Vec::new());
        };
        let context = args["context"].as_str().map(str::trim).filter(|c| !c.is_empty());
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 100_000)
            .unwrap_or_default();
        // Its own conversation for this task: `<parent>--<member>-<stamp><n>`.
        let id: String = format!("{parent}--{}-{stamp}{n}", role.name).chars().take(64).collect();
        let mut task = format!("Goal: {goal}");
        if let Some(context) = context {
            task.push_str("\n\nContext:\n");
            task.push_str(context);
        }
        events(Event::Tool(&format!("[{}] ← {}", role.name, goal.chars().take(160).collect::<String>())));
        match self.run_member(role, &id, &task, approver, events, None).await {
            Ok(outcome) => {
                events(Event::Member { name: &role.name, text: &outcome.text });
                (format!("{} answered:\n{}", role.name, outcome.text), outcome.receipts)
            }
            Err(e) => {
                let text = format!("could not finish: {e}");
                events(Event::Member { name: &role.name, text: &text });
                (format!("{} {text}", role.name), Vec::new())
            }
        }
    }

    /// [role] works [task] in conversation [session_id]: with its tools, model and instructions,
    /// asking the owner through [approver], its progress tagged with its name, and no grants
    /// from the lead. [board_task]: the board task it works on (it may then `ask_owner`).
    pub async fn run_member(
        &self,
        role: &crate::team::Role,
        session_id: &str,
        task: &str,
        approver: &dyn Approver,
        events: &(dyn Fn(Event) + Send + Sync),
        board_task: Option<String>,
    ) -> Result<Outcome, String> {
        let home = self.tools.home().ok_or("a team needs the agent's home for its conversations")?;
        let mut member = self.clone();
        member.tools = member.tools.clone().only(crate::tools::tools_for(&role.tools));
        if let Some(model) = &role.model {
            member.gateway = member.gateway.with_model(model);
        }
        let mut session = Session::open(&home.join("sessions"), session_id)?;
        let label = role.name.clone();
        let tagged = |event: Event| match event {
            Event::Tool(what) => events(Event::Tool(&format!("[{label}] {what}"))),
            Event::Refused(why) => events(Event::Refused(&format!("[{label}] {why}"))),
            other => events(other),
        };
        let outer = crate::tools::TURN.try_with(Clone::clone).ok().unwrap_or_default();
        let context = crate::tools::TurnContext {
            session: session_id.to_owned(),
            agent: Some(role.name.clone()),
            board_task,
            ..outer
        };
        let mut grants = HashSet::new();
        let run = member.turn_inner(&mut session, task, &[], approver, &mut grants, &tagged);
        crate::tools::TURN.scope(context, run).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn call(
        &self,
        session: &str,
        at: usize,
        name: &str,
        arguments: &str,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> String {
        // The board: the lead plans and reads it; a member on a board task asks the owner.
        if let Some(home) = self.tools.home() {
            let board_task = crate::tools::TURN.try_with(|t| t.board_task.clone()).ok().flatten();
            match name {
                "board_plan" if self.leads_team() => {
                    events(Event::Tool("board_plan"));
                    return crate::board::plan_tool(home, &self.team, arguments);
                }
                "board_status" if self.leads_team() => {
                    return crate::board::Board::load(home).map_or_else(|e| format!("error: {e}"), |b| b.listing());
                }
                "ask_owner" if board_task.is_some() => {
                    let question = serde_json::from_str::<Value>(arguments)
                        .ok()
                        .and_then(|a| a["question"].as_str().map(str::to_owned));
                    let Some(question) = question.filter(|q| !q.trim().is_empty()) else {
                        return "error: `question` is missing".to_owned();
                    };
                    let id = board_task.unwrap_or_default();
                    let blocked = crate::board::Board::load(home).and_then(|mut b| {
                        b.block(&id, &question)?;
                        b.save(home)
                    });
                    return match blocked {
                        Ok(()) => {
                            "asked the owner: stop here and answer that you are waiting for their answer".to_owned()
                        }
                        Err(e) => format!("error: {e}"),
                    };
                }
                _ => {}
            }
        }
        // An MCP server's tool: `<server>__<tool>`, asked for like a command.
        if let Some((server, tool)) = name.split_once("__")
            && !self.mcp.is_empty()
            && self.tools.offers("mcp")
        {
            let action = Action::Mcp { tool: format!("{server}/{tool}"), arguments: arguments.to_owned() };
            if let Err(instead) = self.allowed(session, &action, approver, grants, events).await {
                return refusal(&action, instead);
            }
            events(Event::Tool(&action.describe()));
            let args: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
            return match self.mcp.call(server, tool, args).await {
                Ok(text) => crate::tools::cut(text),
                Err(e) => format!("error: {e}"),
            };
        }
        let call = match self.tools.parse(name, arguments) {
            Ok(call) => call,
            Err(e) => return format!("error: {e}"),
        };
        if matches!(call, crate::tools::Call::Speak { .. } | crate::tools::Call::Image { .. }) {
            return self.make(session, &call, approver, grants, events).await;
        }
        // A change in a directory with instructions of its own: those first, then the change.
        if matches!(call, crate::tools::Call::WriteFile { .. } | crate::tools::Call::EditFile { .. }) {
            let notes = self.tools.nested_notes(&call, session);
            if !notes.is_empty() {
                return format!(
                    "not changed yet: this directory has instructions of its own; follow them and call again.{notes}"
                );
            }
        }
        // What a write or an edit changes, from the file as it will find it (an editor's buffer,
        // [crate::acp]); the profile and skills from their own previews.
        match self.tools.change_now(&call).await {
            Some((path, before, after)) => {
                let diff = self.tools.diff(&path, &before, &after);
                if !diff.is_empty() {
                    events(Event::Diff(&diff));
                    events(Event::Change { path: &path, before: &before, after: &after });
                }
            }
            None => {
                if let Some(diff) = self.tools.preview(&call).filter(|d| !d.is_empty()) {
                    events(Event::Diff(&diff));
                }
            }
        }
        if let Some(action) = self.tools.action(&call) {
            if let Err(instead) = self.allowed(session, &action, approver, grants, events).await {
                return refusal(&action, instead);
            }
            match &call {
                crate::tools::Call::Background { command } => {
                    events(Event::Tool(&format!("run in the background: {command}")))
                }
                _ => events(Event::Tool(&action.describe())),
            }
        } else {
            events(Event::Tool(&format!("{name} {arguments}")));
        }
        if let crate::tools::Call::ExecuteCode { language, code } = &call {
            return self.execute(session, *language, code, approver, grants, events).await;
        }
        if let (crate::tools::Call::SearchSessions { query }, Some(home)) = (&call, self.tools.home()) {
            return crate::tools::cut(
                crate::recall::recall(self, &home.join("sessions"), query, session, events).await,
            );
        }
        if let crate::tools::Call::Fetch { url } = &call {
            return match self.gateway.fetch(url).await {
                Ok((text, receipt)) => {
                    if let Some(id) = &receipt {
                        events(Event::Receipt { id, model: Some("fetch"), tier: Some("web") });
                    }
                    crate::tools::cut(text)
                }
                Err(e) => format!("error: {e}"),
            };
        }
        // What a change replaces, for `/undo`.
        if let (Some(home), Some((path, before))) = (self.tools.home(), self.tools.before(&call))
            && let Err(e) = Session::checkpoint(&home.join("sessions"), session, at, &path, before.as_deref())
        {
            tracing::warn!("no undo for {}: {e}", path.display());
        }
        let result = self.tools.run(&call).await;
        // A subdirectory's own instructions, the first time a tool gets there.
        let notes = self.tools.nested_notes(&call, session);
        if notes.is_empty() { result } else { format!("{result}{notes}") }
    }

    /// `speak` and `generate_image` ([crate::media]): made by the node, asked for first when the
    /// backend is off the machine, kept in the attachments and handed to the turn's chat.
    async fn make(
        &self,
        session: &str,
        call: &crate::tools::Call,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> String {
        use crate::media::Kind;
        use crate::tools::Call;
        let (kind, path, body, what) = match call {
            Call::Speak { text, voice } => {
                let mut body = json!({ "input": text, "response_format": "mp3" });
                if let Some(voice) = voice {
                    body["voice"] = json!(voice);
                }
                (Kind::Speech, "/audio/speech", body, "speak")
            }
            Call::Image { prompt, size } => {
                let mut body = json!({ "prompt": prompt, "n": 1, "response_format": "b64_json" });
                if let Some(size) = size {
                    body["size"] = json!(size);
                }
                (Kind::Image, "/images/generations", body, "generate_image")
            }
            _ => return "error: not a media call".to_owned(),
        };
        let shown: String = body[if kind == Kind::Speech { "input" } else { "prompt" }]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect();
        let media = self.tools.media().get(&self.gateway).await;
        // Unless the owner said yes to sending it off the machine, it is private: the node's
        // backend or nothing, whatever the gateway's settings (a local backend that fails must
        // not fall back to a cloud one unasked).
        let mut confirmed = false;
        if let Some(host) = media.leaves_for(kind) {
            let action = Action::Cloud(format!("{what} sends \"{shown}\" to {host}"));
            if let Err(instead) = self.allowed(session, &action, approver, grants, events).await {
                return refusal(&action, instead);
            }
            confirmed = true;
        }
        events(Event::Tool(&format!("{what}: {shown}")));
        let mut answer = self.gateway.make(path, &body, !confirmed, confirmed).await;
        // The node's own backend failed, and there is one off the machine: ask, then send there.
        let cloud = media.of(kind).iter().find(|b| b.tier != "node").map(|b| b.host.clone());
        if let (Err(e), false, Some(host)) = (&answer, confirmed, cloud) {
            let action = Action::Cloud(format!("{what} sends \"{shown}\" to {host} (the node's own failed: {e})"));
            if let Err(instead) = self.allowed(session, &action, approver, grants, events).await {
                return refusal(&action, instead);
            }
            answer = self.gateway.make(path, &body, false, true).await;
        }
        let (bytes, mime, receipt, decision) = match answer {
            Ok(answer) => answer,
            Err(e) => return format!("error: {e}"),
        };
        if let Some(id) = &receipt {
            events(Event::Receipt {
                id,
                model: decision.as_ref().and_then(|d| d["model"].as_str()),
                tier: decision.as_ref().and_then(|d| d["tier"].as_str()),
            });
        }
        let dir = self.tools.home().map_or_else(std::env::temp_dir, |h| h.join("attachments"));
        let (bytes, mime) = match kind {
            Kind::Speech => (bytes, if mime.is_empty() { "audio/mpeg".to_owned() } else { mime }),
            Kind::Image => {
                let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                match crate::media::first_image(&answer) {
                    Ok(Ok(image)) => {
                        let mime = crate::media::image_mime(&image).to_owned();
                        (image, mime)
                    }
                    Ok(Err(url)) => return format!("the image is at {url} (the backend gave a link, not the file)"),
                    Err(e) => return format!("error: {e}"),
                }
            }
        };
        let saved = match crate::media::save(&dir, if kind == Kind::Speech { "speech" } else { "image" }, &mime, &bytes)
        {
            Ok(path) => path,
            Err(e) => return format!("error: {e}"),
        };
        crate::media::deliver(crate::media::Made { kind, path: saved.clone(), mime });
        let made = if kind == Kind::Speech { "spoke it" } else { "drew it" };
        format!(
            "{made}: saved to {} ({} KiB); in a chat it is sent with your answer",
            saved.display(),
            bytes.len().div_ceil(1024)
        )
    }

    /// `execute_code`, approved already: the script runs where commands run, and its calls to
    /// the read-only tools are answered here (reads outside the working directory refused,
    /// fetches asked for like any fetch).
    #[allow(clippy::too_many_arguments)]
    async fn execute(
        &self,
        session: &str,
        language: crate::script::Language,
        code: &str,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> String {
        let command = match crate::script::command_line(language, code) {
            Ok(line) => self.tools.shell_command(&line).await,
            Err(e) => Err(e),
        };
        let command = match command {
            Ok(command) => command,
            Err(e) => return format!("error: {e}"),
        };
        let mut rpc = ScriptCalls { agent: self, session, approver, grants, events };
        let timeout = self.tools.timeout();
        match crate::script::run(command, language, timeout, self.tools.limit(), &mut rpc).await {
            Ok(text) => text,
            Err(e) => format!("error: {e}"),
        }
    }

    /// Summarizes what left the window, so it is not simply forgotten. On the gateway like any
    /// call (private turns stay local), with its receipt; when it fails, the old part is dropped
    /// as before.
    async fn compact(&self, session: &mut Session, confirmed: bool, events: &(dyn Fn(Event) + Send + Sync)) {
        let Some((previous, pending)) = session.compaction() else { return };
        if let Err(e) = self.summarize(session, previous, &pending, None, confirmed, events).await {
            tracing::warn!("conversation not summarized: {e}");
        }
    }

    /// Folds everything but the last turn into the summary now (`/compact`); how many messages
    /// it folded. [confirmed]: the owner said yes to a cloud model that keeps prompts.
    pub async fn compact_now(
        &self,
        session: &mut Session,
        confirmed: bool,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<usize, GatewayError> {
        let Some((previous, pending, cut)) = session.compaction_all() else { return Ok(0) };
        self.summarize(session, previous, &pending, Some(cut), confirmed, events).await?;
        Ok(pending.len())
    }

    async fn summarize(
        &self,
        session: &mut Session,
        previous: Option<String>,
        pending: &[Value],
        upto: Option<usize>,
        confirmed: bool,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<(), GatewayError> {
        let mut transcript = String::new();
        if let Some(previous) = &previous {
            transcript.push_str("Summary so far:\n");
            transcript.push_str(previous);
            transcript.push_str("\n\nThen:\n");
        }
        for m in pending {
            let text = match m["content"].as_str() {
                Some(text) => text.chars().take(2000).collect::<String>(),
                None if m.get("tool_calls").is_some() => format!("(calls {})", m["tool_calls"]),
                None => continue,
            };
            transcript.push_str(&format!("{}: {text}\n", m["role"].as_str().unwrap_or("?")));
        }
        let ask = [
            json!({ "role": "system", "content": "You summarize an agent's conversation for its own later use. Keep: what the owner asked for, decisions, facts learned, file and path names, commands that worked, and what is still open. At most 200 words, plain text, no preamble." }),
            json!({ "role": "user", "content": transcript.chars().take(24_000).collect::<String>() }),
        ];
        match self.gateway.chat(&ask, &json!([]), confirmed).await {
            Ok(reply) => {
                if let Some(id) = &reply.request_id {
                    let decision = reply.decision.as_ref();
                    events(Event::Receipt {
                        id,
                        model: decision.and_then(|d| d["model"].as_str()),
                        tier: decision.and_then(|d| d["tier"].as_str()),
                    });
                }
                let text = reply.message["content"].as_str().unwrap_or_default().trim().to_owned();
                if text.is_empty() {
                    return Err(GatewayError::Failed("the model gave no summary".to_owned()));
                }
                match upto {
                    Some(upto) => session.add_summary_upto(&text, upto),
                    None => session.add_summary(&text),
                }
                .map_err(GatewayError::Failed)
            }
            Err(e) => Err(e),
        }
    }

    /// Whether [action] may run, asking [approver] when the policy says to; logged either way.
    /// Refused, with what the owner said to do instead when they said it.
    async fn allowed(
        &self,
        session: &str,
        action: &Action,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<(), Option<String>> {
        let granted = grants.contains(action);
        let verdict = if granted { Verdict::Run } else { approval::check(&self.approvals, action) };
        let mut instead = None;
        let (ran, by) = match verdict {
            Verdict::Run => (true, if granted { "grant" } else { "policy" }),
            Verdict::Refuse(why) => {
                events(Event::Refused(&why));
                (false, "policy")
            }
            Verdict::Ask => match approver.approve(action).await {
                Answer::Once => (true, approver.channel()),
                Answer::Always => {
                    grants.insert(action.clone());
                    (true, approver.channel())
                }
                Answer::Deny => {
                    events(Event::Refused(&action.describe()));
                    (false, approver.channel())
                }
                Answer::Instead(text) => {
                    events(Event::Refused(&action.describe()));
                    instead = Some(text).filter(|t| !t.trim().is_empty());
                    (false, approver.channel())
                }
            },
        };
        if let Some(home) = self.tools.home() {
            let entry = crate::actions::Entry {
                at: crate::actions::now(),
                session: session.to_owned(),
                kind: action.kind().to_owned(),
                action: action.describe(),
                ran,
                by: by.to_owned(),
            };
            if let Err(e) = crate::actions::ActionLog::new(home).append(&entry) {
                tracing::warn!("action log not written: {e}");
            }
        }
        if ran { Ok(()) } else { Err(instead) }
    }

    pub fn system_prompt(&self) -> String {
        let persona = self.options.persona.as_ref();
        let who = match persona.and_then(|p| p.name.as_deref()) {
            Some(name) => format!("You are {name}, an Autobot agent"),
            None => "You are Autobot, an agent".to_owned(),
        };
        let mut prompt = format!(
            "{who} running on its owner's own machine ({os}). Your model is served by \
             Invincible Gateway on that machine.\n\
             Working directory: {dir}\n\
             You can run shell commands and read, write and list files with your tools. Commands, file \
             writes and reads outside the working directory need the owner's approval; if one is refused, \
             do not retry it, say what you would need instead (when the owner says what to do instead, \
             do that).\n\
             To do something later or regularly (a reminder, a check), use schedule_task, never the \
             system crontab, at or launchd. When the owner refers to something from before, \
             search_sessions finds it. After a task that took many steps, worked, and will come up \
             again, write down how with create_skill before you answer; when a skill you followed was \
             wrong or out of date, fix it with improve_skill. When you learn how the owner likes to \
             work (a preference, their tools, their style), keep it with update_user_profile. \
             Work step by step, check results, and answer briefly in plain text.",
            os = std::env::consts::OS,
            dir = self.tools.workdir().display(),
        );
        if let Some(ssh) = self.tools.ssh() {
            prompt.push_str(&format!(
                "\nCommands and the file tools run on another machine, {host}, over SSH (the working directory \
                 is there); files there have no undo, so change them with care.",
                host = ssh.host,
            ));
        }
        if let Some(docker) = self.tools.docker() {
            prompt.push_str(&format!(
                "\nCommands run in a Linux container ({image}, network {net}) with the working directory \
                 mounted at the same path: what you install there stays in the container, the files are \
                 the owner's.",
                image = docker.image,
                net = docker.network,
            ));
        }
        prompt.push_str(
            "\nFor something that keeps running (a dev server, a watcher), use terminal with background: \
             true, then the process tool to read its output or stop it; never end a command with `&`.",
        );
        // A member: who it is, before the rest; it reports back to the lead.
        let member = crate::tools::TURN.try_with(|t| t.agent.clone()).ok().flatten();
        // The lead's character: SOUL.md and the personality, after the rules they cannot change.
        if member.is_none()
            && let Some(home) = self.tools.home()
            && let Some(soul) = crate::personality::prompt(home, self.options.personality.as_deref())
        {
            prompt.push_str("\n\n");
            prompt.push_str(&soul);
        }
        if let Some(role) = member.as_deref().and_then(|name| self.team.get(name)) {
            let mut lead = format!(
                "You are {}, a member of Autobot's team on the owner's machine: {}. The lead agent gave you \
                 one task; do it with your tools, then answer the lead with your result: what you found or \
                 did, with paths and facts, briefly. Do not ask questions; say what is missing instead.",
                role.name, role.description
            );
            if let Some(instructions) = &role.instructions {
                lead.push('\n');
                lead.push_str(instructions);
            }
            prompt = format!("{lead}\n\n{prompt}");
        } else if self.leads_team() {
            prompt.push_str(
                "\n\nYour team (hand them work with `delegate`; several delegate calls in one reply run at the \
                 same time; each starts fresh, so give it the goal and all the context it needs):\n",
            );
            prompt.push_str(&self.team.prompt());
        }
        if let Some(branch) = self.tools.git_branch() {
            prompt.push_str(&format!(
                "\n\nThe working directory is a git repository (branch {branch}). Work on it like a careful \
                 senior engineer: find your way with `search` and `find_files`, read the code before you change \
                 it, change it with `edit_file` (small, exact edits), keep to the project's style, then run its \
                 build, linter and tests and fix what you broke. Never commit, push, or rewrite history unless \
                 the owner asks. When done, say what you changed and how you checked it, briefly."
            ));
        }
        if let Some(notes) = self.tools.project_notes() {
            prompt.push_str("\n\nThe project's instructions for agents (follow them):\n");
            prompt.push_str(&notes);
        }
        if let Some(home) = self.tools.home() {
            if let Some(facts) = crate::memory::Memory::new(home).prompt() {
                let whose = if member.is_some() {
                    "What the agent knows about the owner"
                } else {
                    "What you remembered from earlier conversations (keep new facts with `remember`)"
                };
                prompt.push_str(&format!("\n\n{whose}:\n"));
                prompt.push_str(&facts);
            }
            // A member's own notes, from its earlier tasks.
            if let Some(name) = &member
                && let Some(own) = crate::memory::Memory::member(home, name).prompt()
            {
                prompt.push_str("\n\nWhat you remembered from your earlier tasks (keep new facts with `remember`):\n");
                prompt.push_str(&own);
            }
            if member.is_none()
                && let Some(profile) = crate::profile::prompt(home)
            {
                prompt.push_str(
                    "\n\nAbout the owner (their profile, USER.md; keep it current with update_user_profile):\n",
                );
                prompt.push_str(&profile);
            }
            if let Some(skills) = crate::skills::prompt(home) {
                prompt.push_str("\n\nThe owner's skills (read one with `read_skill` when it fits the task):\n");
                prompt.push_str(&skills);
            }
        }
        prompt
    }
}

/// What answers a script's calls ([Agent::execute]): the read-only tools, under the turn's
/// approvals.
struct ScriptCalls<'a> {
    agent: &'a Agent,
    session: &'a str,
    approver: &'a dyn Approver,
    grants: &'a mut HashSet<Action>,
    events: &'a (dyn Fn(Event) + Send + Sync),
}

impl crate::script::Rpc for ScriptCalls<'_> {
    fn call<'a>(
        &'a mut self,
        tool: String,
        args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            let (agent, events) = (self.agent, self.events);
            let call = agent.tools.parse(&tool, &args.to_string())?;
            let shown: String = format!("{tool} {args}").chars().take(160).collect();
            events(Event::Tool(&format!("script → {shown}")));
            if let crate::tools::Call::Fetch { url } = &call {
                let action = Action::Fetch(url.clone());
                if let Err(instead) = agent.allowed(self.session, &action, self.approver, self.grants, events).await {
                    return Err(refusal(&action, instead));
                }
                let (text, receipt) = agent.gateway.fetch(url).await?;
                if let Some(id) = &receipt {
                    events(Event::Receipt { id, model: Some("fetch"), tier: Some("web") });
                }
                return Ok(crate::tools::cut(text));
            }
            if let Some(action) = agent.tools.action(&call) {
                return Err(format!("{}: not from a script; ask with the tool itself", action.describe()));
            }
            let result = agent.tools.run(&call).await;
            match result.strip_prefix("error: ") {
                Some(e) => Err(e.to_owned()),
                None => Ok(result),
            }
        })
    }
}

/// The same call with the same result this many times in a turn: the model is told.
const REPEATED: usize = 3;
/// And this many: the turn stops (it would only spend the step budget).
const STUCK: usize = 6;

/// The calls of one turn, to see a model going round in circles: by call (its tool and its
/// arguments, as JSON reads them), how many times in a row it gave the same result.
#[derive(Default)]
struct Loops {
    seen: std::collections::HashMap<u64, (u64, usize)>,
    stuck: Option<String>,
}

impl Loops {
    /// [result] for [name] called with [arguments], with a word to the model when it is the
    /// same as the last [REPEATED] times or more.
    fn note(&mut self, name: &str, arguments: &str, result: String) -> String {
        use std::hash::{Hash, Hasher};
        let hash = |parts: &[&str]| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            parts.hash(&mut h);
            h.finish()
        };
        let canonical =
            serde_json::from_str::<Value>(arguments).map_or_else(|_| arguments.to_owned(), |v| v.to_string());
        let (call, outcome) = (hash(&[name, &canonical]), hash(&[&result]));
        let entry = self.seen.entry(call).or_insert((outcome, 0));
        if entry.0 == outcome {
            entry.1 += 1;
        } else {
            *entry = (outcome, 1);
        }
        let times = entry.1;
        if times >= STUCK {
            self.stuck = Some(name.to_owned());
        }
        if times < REPEATED {
            return result;
        }
        format!(
            "{result}\n[You have now made this exact call {times} times this turn, with this same result each time. \
             Do not repeat it: try something different, or answer with what you have.]"
        )
    }

    /// The tool that was called [STUCK] times over with the same result, if one was.
    fn stuck(&mut self) -> Option<String> {
        self.stuck.take()
    }
}

/// A turn on its way into the turn log: written when it ends, or as stopped when it is dropped.
struct TurnLog {
    log: Option<crate::insights::Log>,
    tally: crate::insights::Tally,
    session: String,
    project: String,
    started: std::time::Instant,
    done: bool,
}

impl TurnLog {
    fn finish(&mut self, outcome: &str) {
        if std::mem::replace(&mut self.done, true) {
            return;
        }
        let Some(log) = &self.log else { return };
        let record = self.tally.finish(&self.session, &self.project, self.started.elapsed().as_secs_f64(), outcome);
        if let Err(e) = log.append(&record) {
            tracing::warn!("turn log not written: {e}");
        }
    }
}

impl Drop for TurnLog {
    fn drop(&mut self) {
        self.finish("stopped");
    }
}

/// The tool calls in an assistant [message] as (id, name, arguments), with missing ids filled in
/// (the tool results must name them) and object arguments turned into the usual JSON string.
fn tool_calls(message: &mut Value) -> Vec<(String, String, String)> {
    let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else { return Vec::new() };
    let mut found = Vec::new();
    for (i, call) in calls.iter_mut().enumerate() {
        if call["id"].as_str().is_none_or(str::is_empty) {
            call["id"] = json!(format!("call_{i}"));
        }
        if !call["function"]["arguments"].is_string() {
            let arguments = call["function"]["arguments"].to_string();
            call["function"]["arguments"] = json!(if arguments == "null" { "{}".to_owned() } else { arguments });
        }
        found.push((
            call["id"].as_str().unwrap_or_default().to_owned(),
            call["function"]["name"].as_str().unwrap_or_default().to_owned(),
            call["function"]["arguments"].as_str().unwrap_or_default().to_owned(),
        ));
    }
    if found.is_empty()
        && let Some(object) = message.as_object_mut()
    {
        object.remove("tool_calls");
    }
    found
}

#[cfg(test)]
mod tests {
    use super::tool_calls;
    use serde_json::json;

    #[test]
    fn tool_calls_get_ids_and_string_arguments() {
        let mut message = json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {"type": "function", "function": {"name": "terminal", "arguments": {"command": "ls"}}},
                {"id": "x", "type": "function", "function": {"name": "list_dir", "arguments": "{}"}},
            ],
        });
        let calls = tool_calls(&mut message);
        assert_eq!(calls[0], ("call_0".into(), "terminal".into(), r#"{"command":"ls"}"#.into()));
        assert_eq!(calls[1].0, "x");
        assert_eq!(message["tool_calls"][0]["id"], "call_0");
        let mut empty = json!({"role": "assistant", "content": "hi", "tool_calls": []});
        assert!(tool_calls(&mut empty).is_empty());
        assert!(empty.get("tool_calls").is_none());
    }
}
