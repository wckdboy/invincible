//! Speech to text through the node (`/v1/audio/transcriptions`), against a stub backend on
//! loopback: the multipart body goes through as it came, a backend off the machine is never
//! used, and the receipt says nothing left.

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

type Seen = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// A stand-in for whisper.cpp's server: `/v1/audio/transcriptions` answering a fixed text, and
/// keeping the content type and body it was sent.
async fn backend() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let s = seen.clone();
    let router = Router::new().route(
        "/v1/audio/transcriptions",
        post(move |headers: HeaderMap, body: Bytes| {
            let seen = s.clone();
            async move {
                let content_type =
                    headers.get("content-type").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
                seen.lock().unwrap().push((content_type, body.to_vec()));
                axum::Json(json!({ "text": "the build is green" })).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1"), seen)
}

async fn node(transcription: Vec<Backend>) -> String {
    let settings = NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto };
    let state = AppState::new(Vec::new(), settings, "t".into()).with_transcription(transcription);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(Arc::new(state))).await.unwrap() });
    format!("http://{addr}")
}

/// A multipart body with a fake WAV file, the model and the language, built by hand (the test
/// needs no multipart feature): the content type with its boundary, and the bytes.
fn audio() -> (&'static str, Vec<u8>) {
    let boundary = "----invincible-test-boundary";
    let mut body = Vec::new();
    let part = |body: &mut Vec<u8>, headers: &str, content: &[u8]| {
        body.extend_from_slice(format!("--{boundary}\r\n{headers}\r\n\r\n").as_bytes());
        body.extend_from_slice(content);
        body.extend_from_slice(b"\r\n");
    };
    part(
        &mut body,
        "Content-Disposition: form-data; name=\"file\"; filename=\"note.wav\"\r\nContent-Type: audio/wav",
        b"RIFF....WAVEfmt fake",
    );
    part(&mut body, "Content-Disposition: form-data; name=\"model\"", b"whisper-1");
    part(&mut body, "Content-Disposition: form-data; name=\"language\"", b"en");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    ("multipart/form-data; boundary=----invincible-test-boundary", body)
}

/// Posts [audio] to the node's transcription route.
async fn transcribe(node: &str, headers: &[(&str, &str)]) -> reqwest::Response {
    let (content_type, body) = audio();
    let mut request = reqwest::Client::new()
        .post(format!("{node}/v1/audio/transcriptions"))
        .bearer_auth("t")
        .header("content-type", content_type)
        .body(body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn audio_is_transcribed_on_the_node_and_the_body_goes_through_as_it_came() {
    let (url, seen) = backend().await;
    let whisper = Backend::new("whisper", "whisper-1", &url, None, DataPolicy::Unknown);
    let node = node(vec![whisper]).await;
    let response = transcribe(&node, &[("invincible-private", "1")]).await;
    assert_eq!(response.status(), 200);
    let decision: Value = serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap();
    assert_eq!(decision["tier"], "node");
    assert_eq!(decision["model"], "whisper");
    let id = response.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["text"], "the build is green");
    let envelope: Value = reqwest::Client::new()
        .get(format!("{node}/v1/receipts/{id}"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(envelope["receipt"]["data_policy"], "owned");
    assert_eq!(envelope["receipt"]["egress"], json!([]), "nothing left the machine");
    let (content_type, bytes) = seen.lock().unwrap()[0].clone();
    assert!(content_type.starts_with("multipart/form-data; boundary="), "{content_type}");
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("name=\"file\"") && text.contains("fake") && text.contains("whisper-1"), "{text}");
}

#[tokio::test]
async fn a_backend_off_the_machine_is_listed_but_never_used() {
    let (url, seen) = backend().await;
    let cloud =
        Backend::with_tier("cloud-stt", "whisper-1", &url, Some("sk".into()), DataPolicy::NoRetention, Tier::Cloud);
    let node = node(vec![cloud]).await;
    let info: Value = reqwest::Client::new()
        .get(format!("{node}/v1/node"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["transcription"][0]["tier"], "cloud");
    let response = transcribe(&node, &[]).await;
    assert_eq!(response.status(), 403);
    let error: Value = response.json().await.unwrap();
    assert!(error["error"]["message"].as_str().unwrap().contains("audio_not_redactable"));
    assert!(seen.lock().unwrap().is_empty(), "nothing was sent");
}

#[tokio::test]
async fn not_multipart_and_no_backend_are_refused() {
    let (url, _) = backend().await;
    let with = node(vec![Backend::new("whisper", "whisper-1", &url, None, DataPolicy::Unknown)]).await;
    let json = reqwest::Client::new()
        .post(format!("{with}/v1/audio/transcriptions"))
        .bearer_auth("t")
        .json(&json!({ "file": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(json.status(), 400);
    let bare = node(Vec::new()).await;
    let none = transcribe(&bare, &[]).await;
    assert_eq!(none.status(), 404);
}
