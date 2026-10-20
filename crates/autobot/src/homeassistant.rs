//! Home Assistant, both ways.
//!
//! **As tools:** the agent's `home` tool lists entities and their states, reads one, lists the
//! services, and calls one. Reading asks nothing; a call changes the house, so it is an approval
//! of its own kind (`home`), allowlisted per service (`home:light.turn_on`, `home:light.*`).
//!
//! ```toml
//! [homeassistant]
//! url = "http://homeassistant.local:8123"
//! entities = ["light.*", "climate.living_room"]   # optional: only these are seen and changed
//! ```
//!
//! The long-lived access token (Home Assistant: your profile, Security) is in
//! `homeassistant.token` in the bot's directory (else in `$AUTOBOT_HOME`), readable by you alone
//! (0600). Home Assistant is reached directly on your network, not through the gateway.
//!
//! **As a channel:** Home Assistant's conversation agent (Assist, voice) can talk to a bot through
//! an OpenAI-compatible endpoint: `POST /v1/agent/openai/v1/chat/completions` on the agent API
//! (`model` names the bot), and `POST /hooks/homeassistant/v1/chat/completions`
//! (`/hooks/<bot>/homeassistant/…`) on the hooks listener, whose API key is the hook secret
//! `autobot hooks new homeassistant` makes. Nobody is there to approve, so its turns follow the
//! unattended rules: what is allowlisted runs, the rest is refused.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::bots::Runtime;

/// Most entities one listing shows.
const LISTED: usize = 300;

#[derive(Clone, Debug, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct HomeAssistantConfig {
    /// Home Assistant's address; none: no `home` tool.
    #[serde(default)]
    pub url: Option<String>,
    /// The token's file [default: `homeassistant.token` in the bot's directory, else in
    /// `$AUTOBOT_HOME`].
    #[serde(default)]
    pub token_file: Option<PathBuf>,
    /// Only these entities (globs: `light.*`), when set: the others are neither shown nor changed.
    #[serde(default)]
    pub entities: Option<Vec<String>>,
}

impl HomeAssistantConfig {
    /// Where the token is for the bot whose directory is [home].
    pub fn token_path(&self, home: &Path) -> PathBuf {
        if let Some(file) = &self.token_file {
            let file = crate::config::expand(file);
            return if file.is_absolute() { file } else { home.join(file) };
        }
        let own = home.join("homeassistant.token");
        if own.is_file() {
            return own;
        }
        crate::config::home().map(|root| root.join("homeassistant.token")).ok().filter(|p| p.is_file()).unwrap_or(own)
    }

    /// The token, from a file only its owner can read.
    pub fn token(&self, home: &Path) -> Result<String, String> {
        let path = self.token_path(home);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("the Home Assistant token {}: {e} (`autobot homeassistant setup`)", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).map(|m| m.permissions().mode()).unwrap_or(0);
            if mode & 0o077 != 0 {
                return Err(format!("{} can be read by others: `chmod 600 {}`", path.display(), path.display()));
            }
        }
        let token = text.trim();
        if token.is_empty() {
            return Err(format!("{} is empty", path.display()));
        }
        Ok(token.to_owned())
    }
}

/// One Home Assistant, as the agent sees it.
#[derive(Clone, Debug)]
pub struct Home {
    http: reqwest::Client,
    url: String,
    token: String,
    only: Option<globset::GlobSet>,
}

impl Home {
    pub fn new(url: &str, token: &str, entities: Option<&[String]>) -> Result<Self, String> {
        let parsed = reqwest::Url::parse(url).map_err(|e| format!("[homeassistant] url: {e}"))?;
        if !["http", "https"].contains(&parsed.scheme()) {
            return Err("[homeassistant] url: http:// or https://".to_owned());
        }
        let only = match entities {
            Some(globs) => {
                let mut set = globset::GlobSetBuilder::new();
                for glob in globs {
                    set.add(globset::Glob::new(glob).map_err(|e| format!("[homeassistant] entities: {glob}: {e}"))?);
                }
                Some(set.build().map_err(|e| format!("[homeassistant] entities: {e}"))?)
            }
            None => None,
        };
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| format!("Home Assistant: {e}"))?;
        Ok(Self { http, url: url.trim_end_matches('/').to_owned(), token: token.to_owned(), only })
    }

    /// The one [config] describes for the bot in [home]; None when there is none.
    pub fn from_config(config: &HomeAssistantConfig, home: &Path) -> Result<Option<Self>, String> {
        let Some(url) = config.url.as_deref().filter(|u| !u.trim().is_empty()) else { return Ok(None) };
        Self::new(url, &config.token(home)?, config.entities.as_deref()).map(Some)
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Whether [entity] may be seen and changed.
    pub fn allows(&self, entity: &str) -> bool {
        self.only.as_ref().is_none_or(|set| set.is_match(entity))
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let reply = self
            .http
            .get(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("Home Assistant: {e}"))?;
        let status = reply.status();
        if !status.is_success() {
            return Err(format!("Home Assistant {path}: {status}{}", hint(status)));
        }
        reply.json().await.map_err(|e| format!("Home Assistant {path}: {e}"))
    }

    /// Its name and version, which also checks the token.
    pub async fn about(&self) -> Result<String, String> {
        let config = self.get("/api/config").await?;
        Ok(format!(
            "{} (Home Assistant {})",
            config["location_name"].as_str().unwrap_or("Home"),
            config["version"].as_str().unwrap_or("?")
        ))
    }

    /// `light.kitchen: on (Kitchen light)` a line, of [domain] and matching [search] when given.
    pub async fn list(&self, domain: Option<&str>, search: Option<&str>) -> Result<String, String> {
        let states = self.get("/api/states").await?;
        let search = search.map(str::to_lowercase);
        let mut lines: Vec<String> = states
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                let id = s["entity_id"].as_str()?;
                let name = s["attributes"]["friendly_name"].as_str().unwrap_or("");
                let state = s["state"].as_str().unwrap_or("?");
                let in_domain = domain.is_none_or(|d| id.split('.').next() == Some(d.trim_end_matches('.')));
                let found = search
                    .as_ref()
                    .is_none_or(|q| id.to_lowercase().contains(q.as_str()) || name.to_lowercase().contains(q.as_str()));
                (in_domain && found && self.allows(id))
                    .then(|| if name.is_empty() { format!("{id}: {state}") } else { format!("{id}: {state} ({name})") })
            })
            .collect();
        lines.sort();
        let total = lines.len();
        lines.truncate(LISTED);
        if total > LISTED {
            lines.push(format!("… {} more; narrow it with domain or search", total - LISTED));
        }
        Ok(if lines.is_empty() { "no such entities".to_owned() } else { lines.join("\n") })
    }

    /// One entity: its state and attributes.
    pub async fn state(&self, entity: &str) -> Result<String, String> {
        check_entity(entity)?;
        if !self.allows(entity) {
            return Err(format!("{entity} is not one of the entities this agent may use ([homeassistant] entities)"));
        }
        let state = self.get(&format!("/api/states/{entity}")).await?;
        serde_json::to_string_pretty(&json!({
            "entity_id": state["entity_id"],
            "state": state["state"],
            "attributes": state["attributes"],
            "last_changed": state["last_changed"],
        }))
        .map_err(|e| e.to_string())
    }

    /// The services, by domain (only [domain]'s when given).
    pub async fn services(&self, domain: Option<&str>) -> Result<String, String> {
        let services = self.get("/api/services").await?;
        let lines: Vec<String> = services
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| domain.is_none_or(|want| d["domain"] == want))
            .filter_map(|d| {
                let names: Vec<&str> = d["services"].as_object()?.keys().map(String::as_str).collect();
                Some(format!("{}: {}", d["domain"].as_str()?, names.join(", ")))
            })
            .collect();
        Ok(if lines.is_empty() { "no such services".to_owned() } else { lines.join("\n") })
    }

    /// Calls [service] (`light.turn_on`) with [data] (its `entity_id` among them); what changed.
    pub async fn call(&self, service: &str, data: &Value) -> Result<String, String> {
        let (domain, name) = split_service(service)?;
        for entity in entities(data) {
            check_entity(&entity)?;
            if !self.allows(&entity) {
                return Err(format!(
                    "{entity} is not one of the entities this agent may use ([homeassistant] entities)"
                ));
            }
        }
        if self.only.is_some() && entities(data).is_empty() {
            return Err("name the entity_id: this agent may use only some entities".to_owned());
        }
        let reply = self
            .http
            .post(format!("{}/api/services/{domain}/{name}", self.url))
            .bearer_auth(&self.token)
            .json(data)
            .send()
            .await
            .map_err(|e| format!("Home Assistant: {e}"))?;
        let status = reply.status();
        if !status.is_success() {
            let text = reply.text().await.unwrap_or_default();
            return Err(format!(
                "Home Assistant {service}: {status}{} {}",
                hint(status),
                text.chars().take(300).collect::<String>()
            ));
        }
        let changed: Value = reply.json().await.unwrap_or_default();
        let lines: Vec<String> = changed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| Some(format!("{}: {}", s["entity_id"].as_str()?, s["state"].as_str().unwrap_or("?"))))
            .collect();
        Ok(if lines.is_empty() {
            format!("called {service}")
        } else {
            format!("called {service}; now:\n{}", lines.join("\n"))
        })
    }
}

fn hint(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => " (the token is not accepted: make a new long-lived token)",
        404 => " (no such entity or service)",
        _ => "",
    }
}

fn check_entity(entity: &str) -> Result<(), String> {
    let ok = entity.split_once('.').is_some_and(|(d, o)| {
        !d.is_empty()
            && !o.is_empty()
            && entity.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
    });
    if ok { Ok(()) } else { Err(format!("{entity:?} is not an entity id (domain.object_id)")) }
}

/// `light.turn_on` as (`light`, `turn_on`).
pub fn split_service(service: &str) -> Result<(&str, &str), String> {
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    match service.split_once('.') {
        Some((domain, name)) if plain(domain) && plain(name) => Ok((domain, name)),
        _ => Err(format!("{service:?} is not a service (domain.service, like light.turn_on)")),
    }
}

/// The entities a service call's data names.
fn entities(data: &Value) -> Vec<String> {
    match &data["entity_id"] {
        Value::String(s) => s.split(',').map(|e| e.trim().to_owned()).filter(|e| !e.is_empty()).collect(),
        Value::Array(list) => list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        _ => Vec::new(),
    }
}

/// What the agent asked the `home` tool for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HomeCall {
    List {
        domain: Option<String>,
        search: Option<String>,
    },
    Get {
        entity: String,
    },
    Services {
        domain: Option<String>,
    },
    /// A service with its data (`entity_id` in it).
    Call {
        service: String,
        data: Value,
    },
}

impl HomeCall {
    pub fn parse(args: &Value) -> Result<Self, String> {
        let opt =
            |key: &str| args.get(key).and_then(Value::as_str).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        Ok(match args.get("action").and_then(Value::as_str).unwrap_or("list") {
            "list" => Self::List { domain: opt("domain"), search: opt("search") },
            "get" => Self::Get { entity: opt("entity_id").ok_or("`entity_id` is missing")? },
            "services" => Self::Services { domain: opt("domain") },
            "call" => {
                let service = match (opt("service"), opt("domain")) {
                    (Some(s), _) if s.contains('.') => s,
                    (Some(s), Some(d)) => format!("{d}.{s}"),
                    _ => return Err("`service` is missing (light.turn_on, or domain and service)".to_owned()),
                };
                split_service(&service)?;
                let mut data = args.get("data").filter(|d| d.is_object()).cloned().unwrap_or_else(|| json!({}));
                if let Some(entity) = opt("entity_id") {
                    data["entity_id"] = json!(entity);
                }
                Self::Call { service, data }
            }
            other => return Err(format!("unknown action {other:?} (list, get, services or call)")),
        })
    }

    /// What a call needs approved: its service, entities and data.
    pub fn action(&self) -> Option<crate::approval::Action> {
        let Self::Call { service, data } = self else { return None };
        let mut rest = data.clone();
        if let Some(o) = rest.as_object_mut() {
            o.remove("entity_id");
        }
        Some(crate::approval::Action::Home {
            service: service.clone(),
            entities: entities(data).join(", "),
            data: if rest.as_object().is_some_and(|o| o.is_empty()) { String::new() } else { rest.to_string() },
        })
    }

    pub async fn run(&self, home: &Home) -> Result<String, String> {
        match self {
            Self::List { domain, search } => home.list(domain.as_deref(), search.as_deref()).await,
            Self::Get { entity } => home.state(entity).await,
            Self::Services { domain } => home.services(domain.as_deref()).await,
            Self::Call { service, data } => home.call(service, data).await,
        }
    }
}

/// The `home` tool, in the OpenAI shape.
pub fn definition() -> Value {
    json!({ "type": "function", "function": {
        "name": "home",
        "description": "The owner's Home Assistant: list entities and their states (list, by domain like light or a search word), read one entity's state and attributes (get), list the services (services), or call a service (call, e.g. light.turn_on with entity_id light.kitchen and data {\"brightness_pct\": 40}). A call changes the house and asks the owner first.",
        "parameters": { "type": "object", "properties": {
            "action": { "type": "string", "enum": ["list", "get", "services", "call"] },
            "domain": { "type": "string", "description": "light, switch, climate, cover, media_player …" },
            "search": { "type": "string", "description": "For list: part of an entity's id or name." },
            "entity_id": { "type": "string", "description": "For get and call: light.kitchen (several, comma-separated, for call)." },
            "service": { "type": "string", "description": "For call: domain.service, like light.turn_on." },
            "data": { "type": "object", "description": "For call: the service's fields." },
        }, "required": ["action"] },
    }})
}

/// The text of the last user message of an OpenAI chat request.
fn last_user_text(body: &Value) -> Option<String> {
    let message = body["messages"].as_array()?.iter().rev().find(|m| m["role"] == "user")?;
    let text = match &message["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// No one is there to ask: allowlisted actions run (the policy's own yes), the rest is refused.
struct Unattended;

impl crate::approval::Approver for Unattended {
    fn approve<'a>(
        &'a self,
        _: &'a crate::approval::Action,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = crate::approval::Answer> + Send + 'a>> {
        Box::pin(async { crate::approval::Answer::Deny })
    }

    fn channel(&self) -> &'static str {
        "homeassistant"
    }
}

fn openai_error(status: axum::http::StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": { "message": message, "type": "invalid_request_error" } }))).into_response()
}

/// `POST …/v1/chat/completions` from Home Assistant's conversation agent: the last user message
/// is a turn of [runtime] in its conversation `homeassistant-<user>` (`user` from the request,
/// else one for the whole house); the answer in the OpenAI shape, streamed when asked.
pub async fn conversation(runtime: Arc<Runtime>, body: &[u8]) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return openai_error(axum::http::StatusCode::BAD_REQUEST, "the body is an OpenAI chat request");
    };
    let Some(text) = last_user_text(&body) else {
        return openai_error(axum::http::StatusCode::BAD_REQUEST, "no user message");
    };
    let who = body["user"].as_str().filter(|u| !u.trim().is_empty()).unwrap_or("house");
    let session = crate::channel::session_name(&format!("homeassistant-{who}"));
    let answer = match crate::channel::converse(&runtime, &session, &text, &Unattended).await {
        Ok(answer) => answer,
        Err(e) => {
            runtime.error(&format!("homeassistant: {e}"));
            format!("Sorry, that failed: {e}")
        }
    };
    let model = runtime.name.clone();
    let created = chrono::Local::now().timestamp();
    let id = format!(
        "chatcmpl-{}",
        invincible::token::random::<8>().map(|b| invincible::token::hex(&b)).unwrap_or_default()
    );
    if body["stream"] == true {
        let chunk = |delta: Value, finish: Value| {
            json!({ "id": id, "object": "chat.completion.chunk", "created": created, "model": model,
                    "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] })
        };
        let text = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            chunk(json!({ "role": "assistant", "content": answer }), Value::Null),
            chunk(json!({}), json!("stop"))
        );
        return ([(axum::http::header::CONTENT_TYPE, "text/event-stream")], text).into_response();
    }
    axum::Json(json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": answer }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
    }))
    .into_response()
}

/// `GET …/v1/models`: the bots, as models to pick.
pub fn models(names: &[String]) -> Response {
    let data: Vec<Value> =
        names.iter().map(|n| json!({ "id": n, "object": "model", "created": 0, "owned_by": "autobot" })).collect();
    axum::Json(json!({ "object": "list", "data": data })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_parse_and_ask_as_home_actions() {
        let call = HomeCall::parse(&json!({ "action": "call", "service": "light.turn_on", "entity_id": "light.kitchen", "data": { "brightness_pct": 40 } })).unwrap();
        assert_eq!(
            call.action(),
            Some(crate::approval::Action::Home {
                service: "light.turn_on".into(),
                entities: "light.kitchen".into(),
                data: "{\"brightness_pct\":40}".into()
            })
        );
        let call = HomeCall::parse(&json!({ "action": "call", "domain": "switch", "service": "toggle" })).unwrap();
        assert_eq!(call, HomeCall::Call { service: "switch.toggle".into(), data: json!({}) });
        assert!(HomeCall::parse(&json!({ "action": "call", "service": "turn_on" })).is_err());
        assert!(HomeCall::parse(&json!({ "action": "call", "service": "light.turn_on;rm" })).is_err());
        assert!(HomeCall::parse(&json!({ "action": "get" })).is_err());
        assert_eq!(HomeCall::parse(&json!({ "action": "list", "domain": "light" })).unwrap().action(), None);
        assert!(check_entity("light.kitchen").is_ok());
        assert!(check_entity("../api").is_err() && check_entity("light").is_err());
    }

    #[test]
    fn the_entities_filter_limits_what_is_seen() {
        let home = Home::new("http://127.0.0.1:8123", "t", Some(&["light.*".to_owned()])).unwrap();
        assert!(home.allows("light.kitchen") && !home.allows("lock.front_door"));
        assert!(Home::new("ftp://x", "t", None).is_err());
    }

    #[test]
    fn the_last_user_message_is_the_turn() {
        let body = json!({ "messages": [
            { "role": "system", "content": "You are a voice assistant for Home Assistant." },
            { "role": "user", "content": "first" },
            { "role": "assistant", "content": "ok" },
            { "role": "user", "content": [{ "type": "text", "text": "turn on the kitchen light" }] },
        ] });
        assert_eq!(last_user_text(&body).as_deref(), Some("turn on the kitchen light"));
        assert_eq!(last_user_text(&json!({ "messages": [] })), None);
    }
}
