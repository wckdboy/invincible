//! Model downloads against a local file server: verification, resuming, and servers that ignore
//! ranges.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use invincible::models::download;
use invincible_policy::NetworkMode;
use sha2::{Digest, Sha256};

fn blob() -> Vec<u8> {
    (0..3_000_000u32).map(|i| (i % 251) as u8).collect()
}

fn sha(bytes: &[u8]) -> String {
    invincible::token::hex(&Sha256::digest(bytes))
}

/// Serves [blob] at `/m.gguf`, honouring `Range: bytes=N-` unless [ranges] is false. Counts
/// ranged requests.
async fn file_server(ranges: bool) -> (String, Arc<AtomicUsize>) {
    let ranged = Arc::new(AtomicUsize::new(0));
    let counter = ranged.clone();
    let router = Router::new().route(
        "/m.gguf",
        get(move |headers: HeaderMap| {
            let counter = counter.clone();
            async move {
                let data = blob();
                let start = headers
                    .get(header::RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("bytes="))
                    .and_then(|v| v.strip_suffix('-'))
                    .and_then(|v| v.parse::<usize>().ok());
                match start {
                    Some(start) if ranges => {
                        counter.fetch_add(1, Ordering::Relaxed);
                        if start >= data.len() {
                            return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                        }
                        (StatusCode::PARTIAL_CONTENT, data[start..].to_vec()).into_response()
                    }
                    _ => (StatusCode::OK, data).into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/m.gguf"), ranged)
}

fn temp(tag: &str) -> std::path::PathBuf {
    let n = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-dl-{tag}-{n:x}"))
}

fn client() -> reqwest::Client {
    invincible::egress::client(&NetworkMode::Direct).unwrap()
}

#[tokio::test]
async fn downloads_and_verifies() {
    let (url, _) = file_server(true).await;
    let dir = temp("ok");
    let dest = dir.join("m.gguf");
    let mut last = (0, None);
    download(&client(), &url, &dest, &sha(&blob()), |have, total| last = (have, total)).await.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), blob());
    assert_eq!(last, (3_000_000, Some(3_000_000)));
    assert!(!dir.join("m.gguf.partial").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_wrong_hash_keeps_nothing() {
    let (url, _) = file_server(true).await;
    let dir = temp("bad");
    let dest = dir.join("m.gguf");
    let err = download(&client(), &url, &dest, &"0".repeat(64), |_, _| {}).await.unwrap_err();
    assert!(err.contains("mismatch"), "{err}");
    assert!(!dest.exists());
    assert!(!dir.join("m.gguf.partial").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn resumes_a_partial_download() {
    let (url, ranged) = file_server(true).await;
    let dir = temp("resume");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("m.gguf.partial"), &blob()[..1_234_567]).unwrap();
    let dest = dir.join("m.gguf");
    download(&client(), &url, &dest, &sha(&blob()), |_, _| {}).await.unwrap();
    assert_eq!(ranged.load(Ordering::Relaxed), 1);
    assert_eq!(std::fs::read(&dest).unwrap(), blob());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_server_that_ignores_ranges_still_gives_the_right_file() {
    let (url, _) = file_server(false).await;
    let dir = temp("norange");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("m.gguf.partial"), &blob()[..1_000]).unwrap();
    let dest = dir.join("m.gguf");
    download(&client(), &url, &dest, &sha(&blob()), |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), blob());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_complete_partial_file_is_fetched_again() {
    let (url, _) = file_server(true).await;
    let dir = temp("complete");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("m.gguf.partial"), blob()).unwrap();
    let dest = dir.join("m.gguf");
    download(&client(), &url, &dest, &sha(&blob()), |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), blob());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn plain_http_elsewhere_is_refused() {
    let dir = temp("http");
    let err = download(&client(), "http://example.com/m.gguf", &dir.join("m.gguf"), &"0".repeat(64), |_, _| {})
        .await
        .unwrap_err();
    assert!(err.contains("HTTPS"), "{err}");
}
