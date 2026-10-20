//! Speech and pictures the agent made, delivered natively against stand-ins for each platform's
//! API: a Slack file upload in the thread, a Signal attachment, Matrix media, WhatsApp media.

use std::sync::{Arc, Mutex};

use autobot::media::{Kind, Made};
use axum::Json;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method};
use serde_json::{Value, json};

/// (method, path and query, content type, body) of every request.
type Seen = Arc<Mutex<Vec<(String, String, String, Vec<u8>)>>>;

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// A stand-in that records every request and answers with [answer] (by path).
async fn stand_in(answer: fn(&str, &str) -> Value) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let app = axum::Router::new().fallback(
        move |State((seen, base)): State<(Seen, Arc<Mutex<String>>)>,
              method: Method,
              OriginalUri(uri): OriginalUri,
              headers: HeaderMap,
              body: axum::body::Bytes| async move {
            let kind = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            let path = uri.path_and_query().map(|p| p.to_string()).unwrap_or_default();
            seen.lock().unwrap().push((method.to_string(), path.clone(), kind, body.to_vec()));
            let base = base.lock().unwrap().clone();
            Json(answer(&path, &base))
        },
    );
    let base: Arc<Mutex<String>> = Arc::default();
    let url = listen(app.with_state((seen.clone(), base.clone()))).await;
    *base.lock().unwrap() = url.clone();
    (url, seen)
}

fn files(tag: &str) -> (std::path::PathBuf, Made, Made) {
    let dir = std::env::temp_dir().join(format!("autobot-media-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let voice = dir.join("speech-1.mp3");
    std::fs::write(&voice, b"ID3 spoken").unwrap();
    let picture = dir.join("image-1.png");
    std::fs::write(&picture, b"\x89PNG drawn").unwrap();
    (
        dir,
        Made { kind: Kind::Speech, path: voice, mime: "audio/mpeg".into() },
        Made { kind: Kind::Image, path: picture, mime: "image/png".into() },
    )
}

fn text(body: &[u8]) -> String {
    String::from_utf8_lossy(body).into_owned()
}

#[tokio::test]
async fn slack_uploads_the_file_into_the_thread() {
    let (url, seen) = stand_in(|path, base| {
        if path.starts_with("/api/files.getUploadURLExternal") {
            json!({ "ok": true, "upload_url": format!("{base}/upload/F1"), "file_id": "F1" })
        } else {
            json!({ "ok": true })
        }
    })
    .await;
    let (dir, voice, _) = files("slack");
    let client =
        autobot::slack::Client::new(reqwest::Client::new(), &format!("{url}/api"), "xapp-APP", "xoxb-BOT").unwrap();
    client.upload("C1/171.5", &voice).await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3, "{seen:?}");
    assert_eq!(seen[0].1, "/api/files.getUploadURLExternal");
    assert_eq!(seen[0].2, "application/x-www-form-urlencoded");
    assert_eq!(text(&seen[0].3), "filename=speech-1.mp3&length=10");
    assert_eq!(
        (seen[1].1.as_str(), seen[1].2.as_str(), seen[1].3.as_slice()),
        ("/upload/F1", "audio/mpeg", b"ID3 spoken".as_slice())
    );
    assert_eq!(seen[2].1, "/api/files.completeUploadExternal");
    let done = text(&seen[2].3);
    assert!(done.contains("channel_id=C1") && done.contains("thread_ts=171.5") && done.contains("%22F1%22"), "{done}");
    drop(seen);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn slack_refuses_an_upload_address_off_slack() {
    let (url, _) = stand_in(|path, _| {
        if path.starts_with("/api/files.getUploadURLExternal") {
            json!({ "ok": true, "upload_url": "https://evil.example.org/up", "file_id": "F1" })
        } else {
            json!({ "ok": true })
        }
    })
    .await;
    let (dir, voice, _) = files("slack-off");
    let client =
        autobot::slack::Client::new(reqwest::Client::new(), &format!("{url}/api"), "xapp-APP", "xoxb-BOT").unwrap();
    assert!(client.upload("C1", &voice).await.unwrap_err().contains("off Slack"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn signal_sends_an_inline_attachment() {
    let (url, seen) = stand_in(|_, _| json!({ "jsonrpc": "2.0", "id": "0", "result": { "timestamp": 5 } })).await;
    let (dir, _, picture) = files("signal");
    let client = autobot::signal::Client::new(&url).unwrap();
    client.send_file("+15550001", &picture).await.unwrap();
    let seen = seen.lock().unwrap();
    let rpc: Value = serde_json::from_slice(&seen[0].3).unwrap();
    assert_eq!(rpc["method"], "send");
    assert_eq!(rpc["params"]["recipient"], json!(["+15550001"]));
    assert_eq!(rpc["params"]["attachments"][0], "data:image/png;filename=image-1.png;base64,iVBORyBkcmF3bg==");
    drop(seen);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn matrix_uploads_media_and_sends_a_voice_message() {
    let (url, seen) = stand_in(|path, _| {
        if path.starts_with("/_matrix/media/v3/upload") {
            json!({ "content_uri": "mxc://example.org/abc" })
        } else {
            json!({ "event_id": "$e1" })
        }
    })
    .await;
    let (dir, voice, picture) = files("matrix");
    let client = autobot::matrix::Client::new(reqwest::Client::new(), &url, "TOKEN").unwrap();
    assert_eq!(client.send_file("!room:example.org", &voice).await.unwrap().as_deref(), Some("$e1"));
    client.send_file("!room:example.org", &picture).await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].1, "/_matrix/media/v3/upload?filename=speech-1.mp3");
    assert_eq!((seen[0].2.as_str(), seen[0].3.as_slice()), ("audio/mpeg", b"ID3 spoken".as_slice()));
    assert!(seen[1].1.starts_with("/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.message/"));
    let event: Value = serde_json::from_slice(&seen[1].3).unwrap();
    assert_eq!(event["msgtype"], "m.audio");
    assert_eq!(event["url"], "mxc://example.org/abc");
    assert_eq!(event["info"], json!({ "mimetype": "audio/mpeg", "size": 10 }));
    assert!(event.get("org.matrix.msc3245.voice").is_some());
    let image: Value = serde_json::from_slice(&seen[3].3).unwrap();
    assert_eq!((image["msgtype"].as_str(), image["body"].as_str()), (Some("m.image"), Some("image-1.png")));
    drop(seen);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn whatsapp_uploads_media_then_sends_it_and_leaves_types_it_cannot_take() {
    let (url, seen) = stand_in(|path, _| {
        if path.ends_with("/media") { json!({ "id": "M1" }) } else { json!({ "messages": [{ "id": "wamid.1" }] }) }
    })
    .await;
    let (dir, voice, picture) = files("whatsapp");
    let client = autobot::whatsapp::Client::new(reqwest::Client::new(), &url, "1234", "TOKEN").unwrap();
    assert!(client.send_file("15550001", &voice).await.unwrap());
    assert!(client.send_file("15550001", &picture).await.unwrap());
    let wav = Made { kind: Kind::Speech, path: voice.path.clone(), mime: "audio/wav".into() };
    assert!(!client.send_file("15550001", &wav).await.unwrap(), "WhatsApp takes no WAV");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 4, "nothing sent for the WAV: {seen:?}");
    assert_eq!(seen[0].1, "/1234/media");
    assert!(seen[0].2.starts_with("multipart/form-data; boundary="));
    let upload = text(&seen[0].3);
    assert!(
        upload.contains("name=\"messaging_product\"\r\n\r\nwhatsapp\r\n")
            && upload.contains("name=\"type\"\r\n\r\naudio/mpeg\r\n")
    );
    assert!(upload.contains("name=\"file\"; filename=\"speech-1.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nID3 spoken"));
    let message: Value = serde_json::from_slice(&seen[1].3).unwrap();
    assert_eq!((message["to"].as_str(), message["type"].as_str()), (Some("15550001"), Some("audio")));
    assert_eq!(message["audio"], json!({ "id": "M1" }));
    let image: Value = serde_json::from_slice(&seen[3].3).unwrap();
    assert_eq!(image["image"], json!({ "id": "M1" }));
    drop(seen);
    std::fs::remove_dir_all(dir).unwrap();
}
