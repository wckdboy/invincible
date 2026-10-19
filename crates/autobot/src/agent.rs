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
        // Tools that act later know which conversation (and Telegram chat) this turn is for.
        let outer = crate::tools::TURN.try_with(Clone::clone).ok().unwrap_or_default();
        let context = crate::tools::TurnContext { session: session.id.clone(), ..outer };
        crate::tools::TURN.scope(context, self.turn_inner(session, text, approver, grants, events)).await
    }

    async fn turn_inner(
        &self,
        session: &mut Session,
        text: &str,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> Result<Outcome, String> {
        session.push(json!({ "role": "user", "content": text }))?;
        let mut definitions = self.tools.definitions();
        if self.leads_team()
            && let Some(list) = definitions.as_array_mut()
        {
            list.push(self.team.definition());
        }
        let mut receipts = Vec::new();
        let mut confirmed = false;
        let mut steps = 0;
        loop {
            steps += 1;
            if steps > self.max_steps {
                let note = format!("Stopped after {} steps ([agent] max_steps).", self.max_steps);
                session.push(json!({ "role": "assistant", "content": note }))?;
                return Ok(Outcome { text: note, receipts });
            }
            let mut messages = vec![Value::Null];
            if steps == 1 {
                self.compact(session, events).await;
            }
            let mut system = self.system_prompt();
            if let Some(summary) = session.summary() {
                system.push_str("\n\nEarlier in this conversation (a summary; the recent part follows):\n");
                system.push_str(summary);
            }
            messages[0] = json!({ "role": "system", "content": system });
            messages.extend(session.window());
            let reply = match self.gateway.chat(&messages, &definitions, confirmed).await {
                Ok(reply) => reply,
                Err(GatewayError::Confirm(why)) if !confirmed => {
                    let action = Action::Cloud(why);
                    if self.allowed(&session.id, &action, approver, grants, events).await {
                        confirmed = true;
                        steps -= 1;
                        continue;
                    }
                    return Err("Not sent: the cloud model was not approved.".to_owned());
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
            let mut message = reply.message;
            if let Some(object) = message.as_object_mut() {
                // Reasoning is not part of the conversation the model sees again.
                object.remove("reasoning_content");
            }
            let calls = tool_calls(&mut message);
            session.push(message.clone())?;
            if calls.is_empty() {
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
            for (id, name, arguments) in own {
                let result = self.call(&session.id, &name, &arguments, approver, grants, events).await;
                session.push(json!({ "role": "tool", "tool_call_id": id, "content": result }))?;
            }
        }
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
        let Some(home) = self.tools.home() else {
            return ("error: a team needs the agent's home for its conversations".to_owned(), Vec::new());
        };
        let mut member = self.clone();
        member.tools = member.tools.clone().only(crate::tools::tools_for(&role.tools));
        if let Some(model) = &role.model {
            member.gateway = member.gateway.with_model(model);
        }
        // Its own conversation for this task: `<parent>--<member>-<stamp><n>`.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 100_000)
            .unwrap_or_default();
        let id: String = format!("{parent}--{}-{stamp}{n}", role.name).chars().take(64).collect();
        let mut session = match Session::open(&home.join("sessions"), &id) {
            Ok(session) => session,
            Err(e) => return (format!("error: {e}"), Vec::new()),
        };
        let mut task = format!("Goal: {goal}");
        if let Some(context) = context {
            task.push_str(&format!(
                "

Context:
{context}"
            ));
        }
        // Its tool progress shows under its name.
        let label = role.name.clone();
        let tagged = |event: Event| match event {
            Event::Tool(what) => events(Event::Tool(&format!("[{label}] {what}"))),
            Event::Refused(why) => events(Event::Refused(&format!("[{label}] {why}"))),
            other => events(other),
        };
        events(Event::Tool(&format!("[{label}] ← {}", goal.chars().take(160).collect::<String>())));
        let outer = crate::tools::TURN.try_with(Clone::clone).ok().unwrap_or_default();
        let context = crate::tools::TurnContext { session: id.clone(), agent: Some(role.name.clone()), ..outer };
        // No grants from the lead: its "always" answers were for its own conversation.
        let mut grants = HashSet::new();
        let run = member.turn_inner(&mut session, &task, approver, &mut grants, &tagged);
        match crate::tools::TURN.scope(context, run).await {
            Ok(outcome) => (
                format!(
                    "{} answered:
{}",
                    role.name, outcome.text
                ),
                outcome.receipts,
            ),
            Err(e) => (format!("{} could not finish: {e}", role.name), Vec::new()),
        }
    }

    async fn call(
        &self,
        session: &str,
        name: &str,
        arguments: &str,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> String {
        let call = match self.tools.parse(name, arguments) {
            Ok(call) => call,
            Err(e) => return format!("error: {e}"),
        };
        if let Some(action) = self.tools.action(&call) {
            if !self.allowed(session, &action, approver, grants, events).await {
                return format!("refused: the owner did not approve this ({})", action.describe());
            }
            events(Event::Tool(&action.describe()));
        } else {
            events(Event::Tool(&format!("{name} {arguments}")));
        }
        self.tools.run(&call).await
    }

    /// Summarizes what left the window, so it is not simply forgotten. On the gateway like any
    /// call (private turns stay local), with its receipt; when it fails, the old part is dropped
    /// as before.
    async fn compact(&self, session: &mut Session, events: &(dyn Fn(Event) + Send + Sync)) {
        let Some((previous, pending)) = session.compaction() else { return };
        let mut transcript = String::new();
        if let Some(previous) = &previous {
            transcript.push_str("Summary so far:\n");
            transcript.push_str(previous);
            transcript.push_str("\n\nThen:\n");
        }
        for m in &pending {
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
        match self.gateway.chat(&ask, &json!([]), false).await {
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
                if !text.is_empty()
                    && let Err(e) = session.add_summary(&text)
                {
                    tracing::warn!("summary not kept: {e}");
                }
            }
            Err(e) => tracing::warn!("conversation not summarized: {e}"),
        }
    }

    /// Whether [action] may run, asking [approver] when the policy says to; logged either way.
    async fn allowed(
        &self,
        session: &str,
        action: &Action,
        approver: &dyn Approver,
        grants: &mut HashSet<Action>,
        events: &(dyn Fn(Event) + Send + Sync),
    ) -> bool {
        let granted = grants.contains(action);
        let verdict = if granted { Verdict::Run } else { approval::check(&self.approvals, action) };
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
        ran
    }

    fn system_prompt(&self) -> String {
        let mut prompt = format!(
            "You are Autobot, an agent running on its owner's own machine ({os}). Your model is served by \
             Invincible Gateway on that machine.\n\
             Working directory: {dir}\n\
             You can run shell commands and read, write and list files with your tools. Commands, file \
             writes and reads outside the working directory need the owner's approval; if one is refused, \
             do not retry it, say what you would need instead.\n\
             To do something later or regularly (a reminder, a check), use schedule_task, never the \
             system crontab, at or launchd. \
             Work step by step, check results, and answer briefly in plain text.",
            os = std::env::consts::OS,
            dir = self.tools.workdir().display(),
        );
        // A member: who it is, before the rest; it reports back to the lead.
        let member = crate::tools::TURN.try_with(|t| t.agent.clone()).ok().flatten();
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
        if let Some(home) = self.tools.home() {
            if let Some(facts) = crate::memory::Memory::new(home).prompt() {
                prompt
                    .push_str("\n\nWhat you remembered from earlier conversations (keep new facts with `remember`):\n");
                prompt.push_str(&facts);
            }
            if let Some(skills) = crate::skills::prompt(home) {
                prompt.push_str("\n\nThe owner's skills (read one with `read_skill` when it fits the task):\n");
                prompt.push_str(&skills);
            }
        }
        prompt
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
