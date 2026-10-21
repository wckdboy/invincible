//! Cloud backends: OpenAI-compatible chat completion endpoints (OpenAI, Anthropic's compatibility
//! endpoint, DeepSeek, OpenRouter, …). Every request is redacted before it leaves
//! (spec/redaction.md) and restored when it comes back. A backend that fails is marked down for a
//! while, and the router sends its requests elsewhere (spec/routing.md, `cloud-down`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use invincible_policy::DataPolicy;
use serde_json::Value;
use tokio::time::Instant;

use crate::redact::{StreamRestorer, Vault, redact_request, restore_response};

/// How long a failed backend is skipped.
pub const DOWN_FOR: Duration = Duration::from_secs(30);

pub const REDACTED_HEADER: &str = "invincible-redacted";

pub struct CloudModel {
    pub id: String,
    /// The model name the provider expects.
    pub upstream_model: String,
    /// The OpenAI-compatible base, e.g. `https://api.anthropic.com/v1`.
    pub base_url: String,
    pub key: Option<String>,
    pub context: Option<u64>,
    pub data_policy: DataPolicy,
    /// Whether it takes images (None: not known).
    pub vision: Option<bool>,
    /// Unusable for good (no key): never healthy.
    pub disabled: bool,
    down_until: Mutex<Option<Instant>>,
}

impl CloudModel {
    pub fn new(
        id: &str,
        upstream_model: &str,
        base_url: &str,
        key: Option<String>,
        context: Option<u64>,
        data_policy: DataPolicy,
    ) -> Self {
        Self {
            id: id.to_owned(),
            upstream_model: upstream_model.to_owned(),
            base_url: base_url.trim_end_matches('/').to_owned(),
            key,
            context,
            data_policy,
            vision: guess_vision(upstream_model),
            disabled: false,
            down_until: Mutex::new(None),
        }
    }

    /// The same model, taking images or not as configured (None keeps the guess).
    pub fn with_vision(mut self, vision: Option<bool>) -> Self {
        if vision.is_some() {
            self.vision = vision;
        }
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn healthy(&self) -> bool {
        !self.disabled && self.down_until.lock().expect("cloud lock").is_none_or(|until| Instant::now() >= until)
    }

    pub fn mark_down(&self) {
        *self.down_until.lock().expect("cloud lock") = Some(Instant::now() + DOWN_FOR);
    }
}

/// Whether a provider's model [name] takes images, for the well-known families; None when it
/// is not known (the config's `vision` says).
pub fn guess_vision(name: &str) -> Option<bool> {
    let name = name.to_ascii_lowercase();
    let name = name.rsplit('/').next().unwrap_or(&name);
    const SEES: &[&str] = &[
        "claude-",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-turbo",
        "gpt-5",
        "chatgpt-4o",
        "o1",
        "o3",
        "o4",
        "gemini",
        "grok-4",
        "grok-2-vision",
        "pixtral",
        "llava",
        "qwen2.5-vl",
        "qwen2-vl",
        "qwen3-vl",
        "llama-4",
        "gemma-3",
        "mistral-medium",
        "mistral-small-3",
    ];
    const BLIND: &[&str] = &["deepseek-chat", "deepseek-reasoner", "deepseek-coder", "gpt-3.5", "o1-mini", "o3-mini"];
    if BLIND.iter().any(|p| name.starts_with(p)) {
        return Some(false);
    }
    if SEES.iter().any(|p| name.starts_with(p)) || name.contains("-vl") || name.contains("vision") {
        return Some(true);
    }
    None
}

/// How a cloud call ended when it did not produce an answer to pass on.
pub enum CloudError {
    /// Unreachable, overloaded or failing (no connection, 429, 5xx): route elsewhere.
    Failover(String),
}

impl CloudModel {
    /// The host requests go to (for receipts and logs).
    pub fn host(&self) -> String {
        reqwest::Url::parse(&self.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
    }
}

/// The request [forward] sends to [model]: redacted, with the provider's model name, serialised;
/// and the vault that restores the answer.
pub fn prepare(model: &CloudModel, mut body: Value) -> (Vec<u8>, Vault) {
    let vault = redact_request(&mut body);
    body["model"] = Value::String(model.upstream_model.clone());
    // llama.cpp's template switches (thinking on or off) mean nothing to a cloud API, which may refuse them.
    if let Some(object) = body.as_object_mut() {
        object.remove("chat_template_kwargs");
    }
    (serde_json::to_vec(&body).expect("JSON serialises"), vault)
}

/// Sends a [prepare]d request to [model] and returns the restored answer ([streaming]: the
/// request asked for a stream, so the client is not parsed again here). Bytes received from the
/// provider are added to [received].
pub async fn forward(
    client: &reqwest::Client,
    model: &CloudModel,
    body: Vec<u8>,
    vault: Vault,
    received: Arc<AtomicU64>,
    streaming: bool,
) -> Result<Response, CloudError> {
    let mut request = client
        .post(format!("{}/chat/completions", model.base_url))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(key) = &model.key {
        request = request.bearer_auth(key);
    }
    // A streamed answer begins at once and then may pause [SILENCE] between pieces; one not
    // streamed comes whole, so it gets [LOCAL_SILENCE] in all.
    let total = crate::egress::LOCAL_SILENCE;
    let deadline = tokio::time::Instant::now() + if streaming { crate::egress::SILENCE } else { total };
    let quiet = |d: std::time::Duration| CloudError::Failover(format!("no answer in {} minutes", d.as_secs() / 60));
    let upstream = match tokio::time::timeout_at(deadline, request.send()).await {
        Err(_) => return Err(quiet(if streaming { crate::egress::SILENCE } else { total })),
        Ok(sent) => sent.map_err(|e| CloudError::Failover(format!("unreachable: {e}")))?,
    };
    let status = upstream.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        return Err(CloudError::Failover(format!("answered {status}")));
    }
    let found = vault.found();
    tracing::info!(model = %model.id, status = status.as_u16(), redacted = ?found, "cloud request");

    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let mut response = if streaming && status.is_success() {
        let state = (upstream, StreamRestorer::new(vault), false, received);
        let stream = futures_util::stream::unfold(state, |(mut upstream, mut restorer, done, received)| async move {
            if done {
                return None;
            }
            let next = match tokio::time::timeout(crate::egress::SILENCE, upstream.chunk()).await {
                Ok(next) => next,
                Err(_) => {
                    let stalled =
                        format!("the cloud model sent nothing for {} minutes", crate::egress::SILENCE.as_secs() / 60);
                    return Some((Err(std::io::Error::other(stalled)), (upstream, restorer, true, received)));
                }
            };
            match next {
                Ok(Some(bytes)) => {
                    received.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    let out = Bytes::from(restorer.push(&bytes));
                    Some((Ok::<_, std::io::Error>(out), (upstream, restorer, false, received)))
                }
                Ok(None) => Some((Ok(Bytes::from(restorer.finish())), (upstream, restorer, true, received))),
                Err(e) => Some((Err(std::io::Error::other(e)), (upstream, restorer, true, received))),
            }
        });
        Response::new(Body::from_stream(stream))
    } else {
        let bytes = match tokio::time::timeout_at(deadline, upstream.bytes()).await {
            Err(_) => return Err(quiet(total)),
            Ok(bytes) => bytes.map_err(|e| CloudError::Failover(format!("answer cut off: {e}")))?,
        };
        received.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        let body = match serde_json::from_slice::<Value>(&bytes) {
            Ok(mut answer) => {
                restore_response(&vault, &mut answer);
                Body::from(answer.to_string())
            }
            // Not JSON (an error page): pass it on as it came.
            Err(_) => Body::from(bytes),
        };
        Response::new(body)
    };
    *response.status_mut() = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if let Some(content_type) = content_type.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    if !found.is_empty()
        && let Ok(value) = HeaderValue::from_str(&serde_json::to_string(&found).expect("counts serialise"))
    {
        response.headers_mut().insert(REDACTED_HEADER, value);
    }
    Ok(response)
}

/// A provider `invincible cloud add` knows: where its OpenAI-compatible API is, a model to start
/// with, its context, and what it does with what it is sent (from its API terms).
pub struct Preset {
    pub name: &'static str,
    pub base_url: &'static str,
    /// None: the model has to be named (`--model`).
    pub model: Option<&'static str>,
    pub context: Option<u64>,
    pub data_policy: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset {
        name: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        model: Some("deepseek-chat"),
        context: Some(64_000),
        data_policy: "trains",
    },
    Preset {
        name: "anthropic",
        base_url: "https://api.anthropic.com/v1",
        model: Some("claude-sonnet-5-5"),
        context: Some(200_000),
        data_policy: "retention:30",
    },
    Preset {
        name: "openai",
        base_url: "https://api.openai.com/v1",
        model: None,
        context: Some(128_000),
        data_policy: "retention:30",
    },
    Preset {
        name: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        model: None,
        context: None,
        data_policy: "unknown",
    },
];

pub fn preset(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

/// A `[[cloud]]` entry to add to the config.
pub struct Entry<'a> {
    pub id: &'a str,
    pub upstream_model: &'a str,
    pub base_url: &'a str,
    /// Relative to the config's directory.
    pub api_key_file: Option<&'a str>,
    pub context: Option<u64>,
    pub data_policy: &'a str,
}

pub(crate) fn edit(
    config: &std::path::Path,
    change: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<(), String>,
) -> Result<(), String> {
    // A config that cannot be read is an error, never an empty one to write over.
    let text = crate::fsutil::read_optional(config)?.unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("{}: {e}", config.display()))?;
    change(&mut doc)?;
    // The result must still be a config the gateway reads.
    crate::config::Config::parse(&doc.to_string()).map_err(|e| format!("the changed config would not load: {e}"))?;
    crate::fsutil::replace_private(config, &doc.to_string())
}

/// Appends [entry] as a `[[cloud]]` table, keeping the config's comments and layout.
pub fn add_to_config(config: &std::path::Path, entry: &Entry) -> Result<(), String> {
    edit(config, |doc| {
        let clouds = doc
            .entry("cloud")
            .or_insert_with(|| toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()))
            .as_array_of_tables_mut()
            .ok_or("`cloud` is not a list of [[cloud]] tables")?;
        if clouds.iter().any(|t| t.get("id").and_then(|v| v.as_str()) == Some(entry.id)) {
            return Err(format!("a cloud model with id {:?} is already configured", entry.id));
        }
        let mut table = toml_edit::Table::new();
        table.insert("id", toml_edit::value(entry.id));
        table.insert("upstream_model", toml_edit::value(entry.upstream_model));
        table.insert("base_url", toml_edit::value(entry.base_url));
        if let Some(file) = entry.api_key_file {
            table.insert("api_key_file", toml_edit::value(file));
        }
        if let Some(context) = entry.context {
            table.insert("context", toml_edit::value(i64::try_from(context).map_err(|e| e.to_string())?));
        }
        table.insert("data_policy", toml_edit::value(entry.data_policy));
        clouds.push(table);
        Ok(())
    })
}

/// Removes the `[[cloud]]` entry [id]; false when there is none.
pub fn remove_from_config(config: &std::path::Path, id: &str) -> Result<bool, String> {
    let mut found = false;
    edit(config, |doc| {
        if let Some(clouds) = doc.get_mut("cloud").and_then(|c| c.as_array_of_tables_mut()) {
            let before = clouds.len();
            clouds.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(id));
            found = clouds.len() < before;
        }
        Ok(())
    })?;
    Ok(found)
}

/// Sets `[node] egress` (never, ask, auto).
pub fn set_egress(config: &std::path::Path, egress: &str) -> Result<(), String> {
    edit(config, |doc| {
        let node = doc.entry("node").or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
        node.as_table_mut().ok_or("`node` is not a table")?.insert("egress", toml_edit::value(egress));
        Ok(())
    })
}

/// Sets `[update] auto`, keeping the rest of the config as it is.
pub fn set_update_auto(config: &std::path::Path, auto: &str) -> Result<(), String> {
    edit(config, |doc| {
        let update = doc.entry("update").or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
        update.as_table_mut().ok_or("`update` is not a table")?.insert("auto", toml_edit::value(auto));
        Ok(())
    })
}

#[cfg(test)]
mod config_tests {
    use super::{Entry, add_to_config, guess_vision, preset, remove_from_config, set_egress};

    #[test]
    fn well_known_models_say_whether_they_see() {
        for sees in ["claude-sonnet-5-5", "gpt-4o-mini", "gpt-5", "openai/gpt-4.1", "gemini-2.5-pro", "qwen2.5-vl-72b"]
        {
            assert_eq!(guess_vision(sees), Some(true), "{sees}");
        }
        for blind in ["deepseek-chat", "deepseek-reasoner", "o3-mini", "gpt-3.5-turbo"] {
            assert_eq!(guess_vision(blind), Some(false), "{blind}");
        }
        assert_eq!(guess_vision("some-new-model"), None);
    }

    #[test]
    fn cloud_models_are_added_and_removed_keeping_the_rest() {
        let dir = std::env::temp_dir().join(format!("invincible-cloudcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        std::fs::write(&config, "# mine\n[node]\nnetwork = \"direct\"\negress = \"never\"\n").unwrap();
        let p = preset("anthropic").unwrap();
        let entry = Entry {
            id: "claude",
            upstream_model: p.model.unwrap(),
            base_url: p.base_url,
            api_key_file: Some("keys/claude"),
            context: p.context,
            data_policy: p.data_policy,
        };
        add_to_config(&config, &entry).unwrap();
        assert!(add_to_config(&config, &entry).is_err(), "ids are unique");
        set_egress(&config, "ask").unwrap();
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.starts_with("# mine\n"), "{text}");
        let loaded = crate::config::Config::parse(&text).unwrap();
        assert_eq!(loaded.node.egress, "ask");
        assert_eq!(loaded.cloud[0].upstream_model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(loaded.cloud[0].data_policy, "retention:30");
        assert!(remove_from_config(&config, "claude").unwrap());
        assert!(!remove_from_config(&config, "claude").unwrap());
        assert!(crate::config::Config::parse(&std::fs::read_to_string(&config).unwrap()).unwrap().cloud.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
