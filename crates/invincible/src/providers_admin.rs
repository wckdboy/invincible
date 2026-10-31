//! The gateway's provider admin: add, change and remove cloud backends while it runs.
//!
//! The config file stays the source of truth (`[[cloud]]` tables, key files under `keys/`, mode
//! 0600); this only edits it and swaps the running model list. A request already in flight keeps
//! the model it chose. A key is written once and never returned; the panel sees whether one is
//! set, not its value.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cloud::{Clouds, Entry};
use crate::config::Config;

/// A provider add or update. Omitted fields keep an existing provider's values; a preset fills
/// the ones it knows. An empty or missing `api_key` keeps the key already configured.
#[derive(Debug, Default, Deserialize)]
pub struct ProviderBody {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub upstream_model: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub context: Option<u64>,
    #[serde(default)]
    pub data_policy: Option<String>,
    #[serde(default)]
    pub vision: Option<bool>,
}

pub struct ProviderAdmin {
    home: PathBuf,
    config: PathBuf,
    clouds: Clouds,
    lock: Mutex<()>,
}

impl ProviderAdmin {
    pub fn new(home: PathBuf, config: PathBuf, clouds: Clouds) -> Self {
        Self { home, config, clouds, lock: Mutex::new(()) }
    }

    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lock.lock().map_err(|_| "the provider admin lock is poisoned".to_owned())
    }

    /// The config as the gateway would read it; an absent file is the empty config, so the first
    /// provider can be added before any `config.toml` exists.
    fn config(&self) -> Result<Config, String> {
        match crate::fsutil::read_optional(&self.config)? {
            Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", self.config.display())),
            None => Config::parse(""),
        }
    }

    /// Every configured provider, without its key, and the node's egress policy.
    pub fn list(&self) -> Result<Value, String> {
        let _guard = self.guard()?;
        let config = self.config()?;
        let providers: Vec<Value> = config.cloud.iter().map(|c| self.view(c)).collect();
        Ok(json!({
            "providers": providers,
            "egress": config.node.egress,
            "network": config.node.network,
        }))
    }

    fn view(&self, c: &crate::config::CloudConfig) -> Value {
        let loaded = self.clouds.find(&c.id);
        let key = if c.api_key_env.is_some() {
            "environment"
        } else {
            match c.key(&self.home) {
                Ok(Some(_)) => "set",
                Ok(None) => "none",
                Err(_) => "missing",
            }
        };
        json!({
            "id": c.id,
            "upstream_model": c.upstream_model.clone().unwrap_or_else(|| c.id.clone()),
            "base_url": c.base_url,
            "host": reqwest::Url::parse(&c.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default(),
            "context": c.context,
            "data_policy": c.data_policy,
            "vision": c.vision,
            "key": key,
            "loaded": loaded.is_some(),
            "healthy": loaded.as_ref().is_none_or(|model| model.healthy()),
        })
    }

    /// Adds a provider, or updates one with the same id. Writes the key only when one is given.
    pub fn upsert(&self, body: &ProviderBody) -> Result<Value, String> {
        let _guard = self.guard()?;
        let preset = match body.provider.as_deref() {
            Some("custom") | None => None,
            Some(name) => Some(crate::cloud::preset(name).ok_or_else(|| {
                let names: Vec<&str> = crate::cloud::PRESETS.iter().map(|p| p.name).collect();
                format!("{name:?}: one of {}, or custom with a base URL", names.join(", "))
            })?),
        };
        let id = body
            .id
            .as_deref()
            .or(body.provider.as_deref())
            .filter(|id| !id.is_empty())
            .ok_or("a provider needs an id")?
            .to_owned();
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) || id == "." || id == ".." {
            return Err(format!("{id:?}: an id is letters, digits, -, _ and ."));
        }
        let config = self.config()?;
        if config.models.iter().any(|m| m.id == id) {
            return Err(format!("a local model already uses the id {id:?}"));
        }
        let existing = config.cloud.iter().find(|c| c.id == id);
        let base_url = body
            .base_url
            .clone()
            .or_else(|| preset.map(|p| p.base_url.to_owned()))
            .or_else(|| existing.map(|c| c.base_url.clone()))
            .ok_or("a provider needs an OpenAI-compatible base URL (e.g. https://host/v1)")?;
        crate::egress::check(&base_url).map_err(|e| format!("base URL: {e}"))?;
        let upstream_model = body
            .upstream_model
            .clone()
            .or_else(|| preset.and_then(|p| p.model.map(str::to_owned)))
            .or_else(|| existing.and_then(|c| c.upstream_model.clone()))
            .filter(|model| !model.trim().is_empty())
            .ok_or_else(|| format!("{id} needs the provider's model name"))?;
        let context =
            body.context.or_else(|| preset.and_then(|p| p.context)).or_else(|| existing.and_then(|c| c.context));
        let data_policy = body
            .data_policy
            .clone()
            .or_else(|| preset.map(|p| p.data_policy.to_owned()))
            .or_else(|| existing.map(|c| c.data_policy.clone()))
            .unwrap_or_else(|| "unknown".to_owned());
        let vision = body.vision.or_else(|| existing.and_then(|c| c.vision));
        // Not in the body: an update keeps what the config says.
        let include_usage = existing.and_then(|c| c.include_usage);

        let given = body.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty());
        let (api_key_file, api_key_env) = match given {
            Some(key) => {
                let dir = self.config.parent().map(Path::to_path_buf).unwrap_or_else(|| self.home.clone());
                let keys = dir.join("keys");
                std::fs::create_dir_all(&keys).map_err(|e| format!("{}: {e}", keys.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o700));
                }
                let path = keys.join(&id);
                crate::fsutil::replace_private(&path, key)?;
                (Some(path.display().to_string()), None)
            }
            None => match existing {
                Some(c) if c.api_key_env.is_some() => (None, c.api_key_env.clone()),
                Some(c) => (c.api_key_file.as_ref().map(|p| p.display().to_string()), None),
                None => return Err("a new provider needs an API key".to_owned()),
            },
        };
        crate::cloud::upsert_to_config(
            &self.config,
            &Entry {
                id: &id,
                upstream_model: &upstream_model,
                base_url: &base_url,
                api_key_file: api_key_file.as_deref(),
                api_key_env: api_key_env.as_deref(),
                context,
                data_policy: &data_policy,
                vision,
                include_usage,
            },
        )?;
        self.reload()?;
        let config = Config::load(&self.config)?;
        config
            .cloud
            .iter()
            .find(|c| c.id == id)
            .map(|c| self.view(c))
            .ok_or_else(|| "the provider did not save".to_owned())
    }

    /// Removes a provider and its key when the key lives in the gateway's `keys/` directory.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let _guard = self.guard()?;
        let config = self.config()?;
        let key = config.cloud.iter().find(|c| c.id == id).and_then(|c| c.api_key_file.clone());
        if !crate::cloud::remove_from_config(&self.config, id)? {
            return Ok(false);
        }
        let dir = self.config.parent().map(Path::to_path_buf).unwrap_or_else(|| self.home.clone());
        if let Some(key) = key {
            let path = if key.is_absolute() { key } else { dir.join(key) };
            if path.parent() == Some(dir.join("keys").as_path()) {
                let _ = std::fs::remove_file(path);
            }
        }
        self.reload()?;
        Ok(true)
    }

    fn reload(&self) -> Result<(), String> {
        let config = self.config()?;
        self.clouds.replace(crate::cloud::models(&config, &self.home));
        Ok(())
    }
}
