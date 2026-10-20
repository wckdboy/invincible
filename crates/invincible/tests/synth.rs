//! Speech and images through the node (`/v1/audio/speech`, `/v1/images/generations`), against
//! stub backends on loopback: the routing rules, redaction off the machine, and receipts.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::receipts::REQUEST_ID_HEADER;
use invincible::server::{AppState, DECISION_HEADER, app};
use invincible::synth::Backend;
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings, Tier};
use serde_json::{Value, json};

type Seen = Arc<Mutex<Vec<(String, Value)>>>;

/// A server with OpenAI's speech and image routes: audio bytes, and one image in base64.
async fn backend() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let (a, b) = (seen.clone(), seen.clone());
    let router = Router::new()
        .route(
            "/v1/audio/speech",
            post(move |headers: HeaderMap, body: Bytes| {
                let seen = a.clone();
                async move {
                    let auth = headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
                    seen.lock().unwrap().push((auth, serde_json::from_slice(&body).unwrap()));
                    ([("content-type", "audio/mpeg")], b"ID3 fake mp3".to_vec()).into_response()
                }
            }),
        )
        .route(
            "/v1/images/generations",
            post(move |headers: HeaderMap, body: Bytes| {
                let seen = b.clone();
                async move {
                    let auth = headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
                    seen.lock().unwrap().push((auth, serde_json::from_slice(&body).unwrap()));
                    axum::Json(json!({ "created": 1, "data": [{ "b64_json": "iVBORw0KGgo=" }] })).into_response()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1"), seen)
}

async fn node(speech: Vec<Backend>, images: Vec<Backend>, egress: Egress) -> String {
    let settings = NodeSettings { network: NetworkMode::Direct, egress };
    let state = AppState::new(Vec::new(), settings, "t".into()).with_media(speech, images);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(Arc::new(state))).await.unwrap() });
    format!("http://{addr}")
}

async fn post_json(url: &str, body: Value, headers: &[(&str, &str)]) -> reqwest::Response {
    let mut request = reqwest::Client::new().post(url).bearer_auth("t").json(&body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

async fn receipt(node: &str, response: reqwest::Response) -> (Vec<u8>, Value) {
    let id = response.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let bytes = response.bytes().await.unwrap().to_vec();
    let envelope: Value = reqwest::Client::new()
        .get(format!("{node}/v1/receipts/{id}"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (bytes, envelope["receipt"].clone())
}

#[tokio::test]
async fn speech_on_the_node_stays_and_takes_the_default_voice() {
    let (url, seen) = backend().await;
    let kokoro = Backend::new("kokoro", "kokoro-82m", &url, None, DataPolicy::Unknown).with_voice(Some("af".into()));
    let node = node(vec![kokoro], Vec::new(), Egress::Never).await;
    let info: Value = reqwest::Client::new()
        .get(format!("{node}/v1/node"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["speech"][0]["id"], "kokoro");
    assert_eq!(info["speech"][0]["tier"], "node");
    assert_eq!(info["images"], json!([]));
    let response = post_json(
        &format!("{node}/v1/audio/speech"),
        json!({ "input": "The build is green.", "response_format": "mp3" }),
        &[("invincible-private", "1")],
    )
    .await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "audio/mpeg");
    let decision: Value = serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap();
    assert_eq!(decision["tier"], "node");
    let (bytes, receipt) = receipt(&node, response).await;
    assert_eq!(bytes, b"ID3 fake mp3");
    assert_eq!(receipt["data_policy"], "owned");
    assert_eq!(receipt["egress"], json!([]), "nothing left the machine");
    let (auth, body) = seen.lock().unwrap()[0].clone();
    assert_eq!(auth, "");
    assert_eq!(body["model"], "kokoro-82m");
    assert_eq!(body["voice"], "af");
    assert_eq!(body["input"], "The build is green.");
}

#[tokio::test]
async fn images_off_the_machine_follow_the_rules_and_are_redacted() {
    let (url, seen) = backend().await;
    let cloud =
        || Backend::with_tier("img", "gpt-image-1", &url, Some("sk-test".into()), DataPolicy::NoRetention, Tier::Cloud);
    let prompt = json!({ "prompt": "A birthday card for anna.berg@proton.me", "size": "1024x1024" });

    // Private: never to the cloud, and there is nothing local.
    let private = node(Vec::new(), vec![cloud()], Egress::Auto).await;
    let refused =
        post_json(&format!("{private}/v1/images/generations"), prompt.clone(), &[("invincible-private", "1")]).await;
    assert_eq!(refused.status(), 403);
    assert!(refused.text().await.unwrap().contains("private"));

    // `egress = "ask"`: the owner's yes first.
    let asking = node(Vec::new(), vec![cloud()], Egress::Ask).await;
    let asked = post_json(&format!("{asking}/v1/images/generations"), prompt.clone(), &[]).await;
    assert_eq!(asked.status(), 409);
    assert!(seen.lock().unwrap().is_empty(), "nothing was sent");
    let response =
        post_json(&format!("{asking}/v1/images/generations"), prompt.clone(), &[("invincible-confirmed", "1")]).await;
    assert_eq!(response.status(), 200);
    let (bytes, receipt) = receipt(&asking, response).await;
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answer["data"][0]["b64_json"], "iVBORw0KGgo=");
    assert_eq!(receipt["data_policy"], "no-retention");
    assert_eq!(receipt["egress"][0]["ok"], true);
    assert_eq!(receipt["redactions"]["EMAIL"], 1, "{receipt}");
    let (auth, body) = seen.lock().unwrap()[0].clone();
    assert_eq!(auth, "Bearer sk-test");
    assert_eq!(body["model"], "gpt-image-1");
    assert_eq!(body["response_format"], "b64_json", "the image comes back in the answer");
    assert!(!body["prompt"].as_str().unwrap().contains("anna.berg"), "{body}");
}

#[tokio::test]
async fn without_a_backend_or_text_the_node_says_so() {
    let node = node(Vec::new(), Vec::new(), Egress::Never).await;
    let none = post_json(&format!("{node}/v1/audio/speech"), json!({ "input": "hi" }), &[]).await;
    assert_eq!(none.status(), 404);
    assert!(none.text().await.unwrap().contains("[[speech]]"));
    let (url, _) = backend().await;
    let node = self::node(vec![Backend::new("k", "k", &url, None, DataPolicy::Owned)], Vec::new(), Egress::Never).await;
    let empty = post_json(&format!("{node}/v1/audio/speech"), json!({ "input": " " }), &[]).await;
    assert_eq!(empty.status(), 400);
    let long = post_json(&format!("{node}/v1/audio/speech"), json!({ "input": "a".repeat(5000) }), &[]).await;
    assert_eq!(long.status(), 400);
    let unknown = post_json(&format!("{node}/v1/audio/speech"), json!({ "input": "hi", "model": "nope" }), &[]).await;
    assert_eq!(unknown.status(), 404);
    let anonymous = reqwest::Client::new().post(format!("{node}/v1/audio/speech")).json(&json!({ "input": "hi" }));
    assert_eq!(anonymous.send().await.unwrap().status(), 401, "the token, as for chat");
}
