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
        session.push(json!({ "role": "user", "content": text }))?;
        let definitions = self.tools.definitions();
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
            let mut messages = vec![json!({ "role": "system", "content": self.system_prompt() })];
            messages.extend(session.window().iter().cloned());
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
            for (id, name, arguments) in calls {
                let result = self.call(&session.id, &name, &arguments, approver, grants, events).await;
                session.push(json!({ "role": "tool", "tool_call_id": id, "content": result }))?;
            }
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
             Work step by step, check results, and answer briefly in plain text.",
            os = std::env::consts::OS,
            dir = self.tools.workdir().display(),
        );
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
