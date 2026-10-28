//! What a client that knows nothing of Invincible needs from its API: the token in the header its
//! SDK sends (`x-api-key` for Anthropic's), the context window where OpenAI-compatible clients
//! look for it, and an `ask` it can act on from the error body alone.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::{any, post};
use invincible::cloud::CloudModel;
use invincible::devices::{Devices, StaticKey};
use invincible::engine::Engine;
use invincible::remote::{self, Pairing, PairingCode};
use invincible::server::{AppState, DECISION_HEADER, app, device_app};
use invincible::synth::Backend;
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings, Tier};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "test-token";

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// An engine that answers both APIs with the body it was sent.
async fn stub_engine() -> String {
    let echo = |body: Bytes| async move {
        axum::Json(json!({ "engine_saw": serde_json::from_slice::<Value>(&body).unwrap() })).into_response()
    };
    serve(Router::new().route("/v1/chat/completions", post(echo)).route("/v1/messages", post(echo))).await
}

/// A node offline and closed to the cloud, with [engines].
fn state(engines: Vec<Engine>) -> AppState {
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    AppState::new(engines, settings, TOKEN.to_owned())
}

fn decision(response: &reqwest::Response) -> Value {
    serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap()
}

fn hello() -> Value {
    json!({ "model": "small", "max_tokens": 16, "messages": [{ "role": "user", "content": "hello" }] })
}

#[tokio::test]
async fn the_token_works_as_x_api_key_as_well_as_bearer() {
    let node = serve(app(Arc::new(state(vec![Engine::attached("small", &stub_engine().await, None, true)])))).await;
    let client = reqwest::Client::new();
    let models = |headers: &[(&str, &str)]| {
        let mut request = client.get(format!("{node}/v1/models"));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request
    };
    let status = |r: reqwest::Response| r.status().as_u16();

    // Anthropic's SDKs (and Polykrom's Anthropic protocol) send the key as `x-api-key`.
    assert_eq!(status(models(&[("x-api-key", TOKEN)]).send().await.unwrap()), 200);
    assert_eq!(status(models(&[("authorization", &format!("Bearer {TOKEN}"))]).send().await.unwrap()), 200);
    // The same token both ways is the same token.
    let both = models(&[("x-api-key", TOKEN), ("authorization", &format!("Bearer {TOKEN}"))]);
    assert_eq!(status(both.send().await.unwrap()), 200);
    // A bearer token wins: Anthropic's SDKs and Claude Code add `x-api-key` from ANTHROPIC_API_KEY
    // next to it, and that key is not read.
    let sdk = models(&[("x-api-key", "sk-ant-someone-elses"), ("authorization", &format!("Bearer {TOKEN}"))]);
    assert_eq!(status(sdk.send().await.unwrap()), 200);

    // Fail closed: the header that counts must carry the token.
    for refused in [
        vec![],
        vec![("x-api-key", "nope")],
        vec![("x-api-key", "")],
        vec![("x-api-key", "Bearer test-token")],
        vec![("x-api-key", "test-token2")],
        vec![("x-api-key", TOKEN), ("authorization", "Bearer nope")],
        vec![("x-api-key", TOKEN), ("authorization", "Basic dGVzdC10b2tlbg==")],
        vec![("authorization", "test-token")],
    ] {
        let response = models(&refused).send().await.unwrap();
        assert_eq!(response.status(), 401, "{refused:?}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "invalid_api_key", "{refused:?}");
    }
    // Two `x-api-key` headers: both must be the token.
    let twice = client.get(format!("{node}/v1/models")).header("x-api-key", TOKEN).header("x-api-key", "nope");
    assert_eq!(status(twice.send().await.unwrap()), 401);

    // Both inference APIs, and the operator's own routes, take it the same way.
    let messages = client.post(format!("{node}/v1/messages")).header("x-api-key", TOKEN).json(&hello());
    let response = messages.send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(decision(&response)["model"], "small");
    assert_eq!(response.json::<Value>().await.unwrap()["engine_saw"], hello());
    let chat = client.post(format!("{node}/v1/chat/completions")).header("x-api-key", TOKEN).json(&hello());
    assert_eq!(status(chat.send().await.unwrap()), 200);
    let wrong = client.post(format!("{node}/v1/messages")).header("x-api-key", "nope").json(&hello());
    assert_eq!(status(wrong.send().await.unwrap()), 401);
    assert_eq!(status(client.get(format!("{node}/v1/audit")).header("x-api-key", TOKEN).send().await.unwrap()), 200);
}

#[tokio::test]
async fn the_device_api_takes_no_token_in_either_header() {
    // A device is its pinned key; the operator's token, however it is sent, grants nothing there.
    // Without a session behind the request nothing is granted, so every route is the fallback's 404.
    let device =
        serve(device_app(Arc::new(state(vec![Engine::attached("small", "http://127.0.0.1:9", None, true)])))).await;
    let client = reqwest::Client::new();
    for path in ["/v1/models", "/v1/audit", "/v1/admin/devices"] {
        let response =
            client.get(format!("{device}{path}")).header("x-api-key", TOKEN).bearer_auth(TOKEN).send().await.unwrap();
        assert_eq!(response.status(), 404, "{path}");
    }
}

/// A Noise listener that answers every request with the headers it arrived with, so a test can
/// see what the tunnel's door lets through.
async fn header_echo_node(dir: &std::path::Path) -> (Arc<Pairing>, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let pairing = Arc::new(Pairing::new(
        StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
        "studio".into(),
        vec![addr.clone()],
        Devices::load(&dir.join("devices.json")).unwrap(),
    ));
    let echo = Router::new().fallback(any(|headers: HeaderMap| async move {
        let names: Vec<String> = headers.keys().map(|k| k.as_str().to_owned()).collect();
        axum::Json(json!({ "headers": names }))
    }));
    tokio::spawn(remote::serve(listener, pairing.clone(), echo));
    (pairing, addr)
}

#[tokio::test]
async fn the_tunnel_takes_x_api_key_and_keeps_the_token_on_this_machine() {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    let dir = std::env::temp_dir().join(format!("invincible-client-api-{n:x}"));
    std::fs::create_dir_all(&dir).unwrap();
    let (pairing, addr) = header_echo_node(&dir).await;
    let laptop = StaticKey::load_or_create(&dir.join("device.key")).unwrap();
    remote::pair(&PairingCode::decode(&pairing.start().unwrap().encode()).unwrap(), &laptop, "laptop").await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let door = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(remote::tunnel(listener, vec![addr], pairing.key.public.clone(), laptop, "door-token".into()));

    let client = reqwest::Client::new();
    for headers in [
        vec![("x-api-key", "door-token")],
        vec![("authorization", "Bearer door-token")],
        vec![("x-api-key", "door-token"), ("authorization", "Bearer door-token")],
    ] {
        let mut request = client.get(format!("{door}/v1/models"));
        for (name, value) in &headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 200, "{headers:?}");
        let seen: Value = response.json().await.unwrap();
        let seen: Vec<&str> = seen["headers"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        // The node knows the device by its key: this machine's token, in either header, stays here.
        assert!(
            !seen.contains(&"authorization") && !seen.contains(&"x-api-key"),
            "{headers:?} reached the node: {seen:?}"
        );
    }
    for headers in [vec![("x-api-key", "nope")], vec![("x-api-key", "door-token"), ("authorization", "Bearer nope")]] {
        let mut request = client.get(format!("{door}/v1/models"));
        for (name, value) in &headers {
            request = request.header(*name, *value);
        }
        assert_eq!(request.send().await.unwrap().status(), 401, "{headers:?}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn models_carry_the_context_window_at_the_top_level_when_it_is_known() {
    let cloud = CloudModel::new(
        "claude",
        "claude-upstream",
        "http://127.0.0.1:9/v1",
        Some("sk-test".into()),
        Some(200_000),
        DataPolicy::Retention { days: 30 },
    );
    let unsized_cloud = CloudModel::new("mine", "m", "http://127.0.0.1:9/v1", None, None, DataPolicy::NoRetention);
    let state = state(vec![
        Engine::attached("small", "http://127.0.0.1:9", Some(8192), true),
        Engine::attached("other", "http://127.0.0.1:9", None, true),
    ])
    .with_cloud(vec![cloud, unsized_cloud]);
    let node = serve(app(Arc::new(state))).await;
    let body: Value = reqwest::Client::new()
        .get(format!("{node}/v1/models"))
        .header("x-api-key", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let models = body["data"].as_array().unwrap();
    let by_id = |id: &str| models.iter().find(|m| m["id"] == id).unwrap().clone();

    // Hermes Agent, Niobium and other OpenAI-compatible clients read only top-level keys.
    let small = by_id("small");
    assert_eq!(small["context_length"], 8192);
    // The node's own block stays exactly as it was.
    assert_eq!(
        small["invincible"],
        json!({ "tier": "node", "healthy": true, "context": 8192, "data_policy": "owned", "vision": null })
    );
    assert_eq!(by_id("claude")["context_length"], 200_000);
    assert_eq!(by_id("claude")["invincible"]["context"], 200_000);
    // Unknown is absent, never a guess.
    for id in ["other", "mine"] {
        let model = by_id(id);
        assert!(model.get("context_length").is_none(), "{model}");
        assert_eq!(model["invincible"]["context"], Value::Null);
    }
    // The node knows no model's output limit, so it states none.
    assert!(models.iter().all(|m| m.get("max_completion_tokens").is_none()), "{body}");
}

#[tokio::test]
async fn an_ask_carries_its_decision_and_the_header_that_answers_it_in_the_body() {
    let cloud = CloudModel::new(
        "claude",
        "claude-upstream",
        "http://127.0.0.1:9/v1",
        Some("sk-test".into()),
        Some(200_000),
        DataPolicy::NoRetention,
    );
    let image_backend = Backend::with_tier(
        "img",
        "gpt-image-1",
        "http://127.0.0.1:9/v1",
        Some("sk-test".into()),
        DataPolicy::NoRetention,
        Tier::Cloud,
    );
    let settings = NodeSettings { network: NetworkMode::Direct, egress: Egress::Ask };
    let state = AppState::new(Vec::new(), settings, TOKEN.to_owned())
        .with_cloud(vec![cloud])
        .with_media(Vec::new(), vec![image_backend]);
    let node = serve(app(Arc::new(state))).await;
    let body = json!({ "model": "claude", "messages": [{ "role": "user", "content": "hi" }] });
    let response = reqwest::Client::new()
        .post(format!("{node}/v1/chat/completions"))
        .header("x-api-key", TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    let header = decision(&response);
    let answer: Value = response.json().await.unwrap();
    let error = &answer["error"];
    // What was there stays: the OpenAI error shape, the code and the sentence.
    assert_eq!(error["type"], "confirmation_required");
    assert_eq!(error["code"], "confirmation_required");
    assert_eq!(error["message"], "cloud use needs confirmation; send again with `invincible-confirmed: 1`");
    // An SDK that shows only the body still has the reason and what to send back.
    assert_eq!(error["decision"], header, "the body's decision is the header's");
    assert_eq!(
        error["decision"],
        json!({ "action": "ask", "model": "claude", "tier": "cloud", "reason": "egress-ask" })
    );
    assert_eq!(error["confirm_header"], "invincible-confirmed");

    // Speech and images ask the same way.
    let images = reqwest::Client::new()
        .post(format!("{node}/v1/images/generations"))
        .bearer_auth(TOKEN)
        .json(&json!({ "prompt": "a cat" }))
        .send()
        .await
        .unwrap();
    assert_eq!(images.status(), 409);
    let header = decision(&images);
    let error = images.json::<Value>().await.unwrap()["error"].clone();
    assert_eq!(error["type"], "confirmation_required");
    assert_eq!(error["decision"], header);
    assert_eq!(error["decision"]["model"], "img");
    assert_eq!(error["confirm_header"], "invincible-confirmed");
}
