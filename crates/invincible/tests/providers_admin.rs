//! The gateway's provider admin: a provider added from the panel is written to the config,
//! hot-loaded into the running router, and removed without a restart. Keys are never returned.

use std::sync::Arc;

use axum::Router;
use invincible::providers_admin::ProviderAdmin;
use invincible::server::{AppState, app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "provider-token";

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

fn temp(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("invincible-providers-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("keys")).unwrap();
    dir
}

/// A gateway with an empty cloud list and the admin attached to [home]/config.toml.
async fn node(home: &std::path::Path) -> String {
    std::fs::write(home.join("config.toml"), "[node]\nnetwork = \"direct\"\negress = \"auto\"\n").unwrap();
    let settings = NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto };
    let state = AppState::new(Vec::new(), settings, TOKEN.to_owned());
    let admin = Arc::new(ProviderAdmin::new(home.to_owned(), home.join("config.toml"), state.cloud.clone()));
    let state = state.with_provider_admin(admin);
    serve(app(Arc::new(state))).await
}

#[tokio::test]
async fn a_provider_is_added_hot_loaded_and_removed() {
    let home = temp("add");
    let url = node(&home).await;
    let client = reqwest::Client::new();
    let body = json!({
        "id": "acme",
        "provider": "custom",
        "base_url": "https://api.example.com/v1",
        "upstream_model": "acme-chat-1",
        "api_key": "sk-test-value",
        "context": 32768,
        "data_policy": "no-retention",
        "vision": true,
    });
    let added = client.post(format!("{url}/v1/admin/providers")).bearer_auth(TOKEN).json(&body).send().await.unwrap();
    let status = added.status();
    let added: Value = added.json().await.unwrap();
    assert_eq!(status, 200, "{added}");
    assert_eq!(added["id"], "acme");
    assert_eq!(added["key"], "set");
    assert_eq!(added["loaded"], true);
    assert_eq!(added["host"], "api.example.com");
    assert!(added.get("api_key").is_none());
    assert!(!added.to_string().contains("sk-test-value"));

    // The key is on disk, private, and the model is in the running router at once.
    let key = std::fs::read_to_string(home.join("keys/acme")).unwrap();
    assert_eq!(key, "sk-test-value");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.join("keys/acme")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let models: Value =
        client.get(format!("{url}/v1/models")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    assert!(models["data"].as_array().unwrap().iter().any(|m| m["id"] == "acme"), "{models}");

    // An update without a key keeps the key and changes the model.
    let update = json!({ "id": "acme", "upstream_model": "acme-chat-2", "context": 65536 });
    let updated =
        client.post(format!("{url}/v1/admin/providers")).bearer_auth(TOKEN).json(&update).send().await.unwrap();
    assert_eq!(updated.status(), 200);
    let updated: Value = updated.json().await.unwrap();
    assert_eq!(updated["upstream_model"], "acme-chat-2");
    assert_eq!(updated["context"], 65536);
    assert_eq!(updated["key"], "set");
    let text = std::fs::read_to_string(home.join("config.toml")).unwrap();
    assert_eq!(text.matches("[[cloud]]").count(), 1, "{text}");

    let removed = client.delete(format!("{url}/v1/admin/providers/acme")).bearer_auth(TOKEN).send().await.unwrap();
    assert_eq!(removed.status(), 200);
    assert!(!home.join("keys/acme").exists());
    let models: Value =
        client.get(format!("{url}/v1/models")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    assert!(!models["data"].as_array().unwrap().iter().any(|m| m["id"] == "acme"), "{models}");
    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test]
async fn an_environment_key_survives_an_update() {
    let home = temp("env");
    std::fs::write(
        home.join("config.toml"),
        "[node]\nnetwork = \"direct\"\negress = \"auto\"\n\n[[cloud]]\nid = \"cheap\"\nbase_url = \"https://llm.example.com/v1\"\nupstream_model = \"cheap\"\napi_key_env = \"CLOUD_API_KEY\"\ncontext = 8192\ndata_policy = \"unknown\"\n",
    )
    .unwrap();
    let settings = NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto };
    let state = AppState::new(Vec::new(), settings, TOKEN.to_owned());
    let admin = Arc::new(ProviderAdmin::new(home.clone(), home.join("config.toml"), state.cloud.clone()));
    let state = state.with_provider_admin(admin);
    let url = serve(app(Arc::new(state))).await;
    let client = reqwest::Client::new();
    let listed: Value =
        client.get(format!("{url}/v1/admin/providers")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["providers"][0]["key"], "environment");
    let update = json!({ "id": "cheap", "upstream_model": "cheap-2" });
    let updated =
        client.post(format!("{url}/v1/admin/providers")).bearer_auth(TOKEN).json(&update).send().await.unwrap();
    assert_eq!(updated.status(), 200);
    let text = std::fs::read_to_string(home.join("config.toml")).unwrap();
    assert!(text.contains("api_key_env = \"CLOUD_API_KEY\""), "{text}");
    assert!(!text.contains("api_key_file"), "{text}");
    let _ = std::fs::remove_dir_all(home);
}
