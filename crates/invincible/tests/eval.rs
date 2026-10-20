//! `invincible eval` as the owner runs it, against a stand-in gateway: a node model and a cloud
//! one answer, each run is kept, and `--history` shows the runs and the gap between them.

use axum::Json;
use serde_json::{Value, json};

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("invincible-eval-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A gateway with `small` on the node (it knows only 2 + 2) and `big` in the cloud (it knows all).
async fn gateway() -> std::net::SocketAddr {
    let app = axum::Router::new()
        .route(
            "/v1/models",
            axum::routing::get(|| async {
                Json(json!({ "object": "list", "data": [
                    { "id": "small", "invincible": { "tier": "node" } },
                    { "id": "big", "invincible": { "tier": "cloud" } },
                ] }))
            }),
        )
        .route(
            "/v1/chat/completions",
            axum::routing::post(|Json(body): Json<Value>| async move {
                let prompt = body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_owned();
                let answer = match (body["model"].as_str().unwrap(), prompt.as_str()) {
                    (_, "2 + 2?") => "4",
                    ("big", "3 + 3?") => "6",
                    _ => "no idea",
                };
                Json(json!({ "choices": [{ "message": { "role": "assistant", "content": answer }, "finish_reason": "stop" }] }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

fn invincible(home: &std::path::Path, args: &[&str]) -> (bool, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(args)
        .env("INVINCIBLE_HOME", home)
        .env("HOME", home)
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_are_kept_and_the_gap_is_shown() {
    let dir = temp("history");
    let addr = gateway().await;
    std::fs::write(dir.join("config.toml"), format!("listen = \"{addr}\"\n")).unwrap();
    let tasks = dir.join("sums.jsonl");
    std::fs::write(
        &tasks,
        concat!(
            "{\"id\": \"two\", \"prompt\": \"2 + 2?\", \"checks\": [{\"type\": \"equals\", \"value\": \"4\"}]}\n",
            "{\"id\": \"three\", \"prompt\": \"3 + 3?\", \"checks\": [{\"type\": \"equals\", \"value\": \"6\"}]}\n",
        ),
    )
    .unwrap();
    let file = tasks.display().to_string();
    let home = dir.clone();
    let (ok, out) = tokio::task::spawn_blocking(move || {
        invincible(&home, &["eval", &file, "--model", "small", "--model", "big", "--confirm"])
    })
    .await
    .unwrap();
    assert!(ok, "{out}");
    assert!(out.contains("kept in"), "{out}");
    let home = dir.clone();
    let (ok, out) = tokio::task::spawn_blocking(move || invincible(&home, &["eval", "--history"])).await.unwrap();
    assert!(ok, "{out}");
    assert!(out.contains("sums (2 tasks"), "{out}");
    assert!(out.contains("small [node] 1/2 · big [cloud] 2/2"), "{out}");
    assert!(out.contains("gap +50 points (small → big)"), "{out}");
    // Not kept when asked not to.
    let (file, home) = (tasks.display().to_string(), dir.clone());
    tokio::task::spawn_blocking(move || invincible(&home, &["eval", &file, "--model", "small", "--no-record"]))
        .await
        .unwrap();
    let lines = std::fs::read_to_string(dir.join("evals/history.jsonl")).unwrap().lines().count();
    assert_eq!(lines, 1);
    let _ = std::fs::remove_dir_all(dir);
}
