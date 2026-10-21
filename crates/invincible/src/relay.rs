//! A request passed to a local engine, and its answer passed back, with two promises about time.
//!
//! - A streamed answer is never silent for long: while the engine reads a long prompt (a 27B
//!   model on 100k tokens takes more than ten minutes before its first token) the client gets a
//!   `: keep-alive` comment every [KEEP_ALIVE], which SSE readers skip, so no idle timer on the
//!   way (the agent's, a proxy's) takes the wait for a hang.
//! - An engine that sends nothing for [crate::egress::LOCAL_SILENCE] is hung: a streamed answer
//!   then ends with an error event the client can tell from a cut connection (the agent does
//!   not send it again), and an answer not streamed (which comes whole at the end, so the limit
//!   is its total time) is a 504.

use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use futures_util::StreamExt;
use serde_json::json;

use crate::server::error;

/// How often a streamed answer that has nothing new gets a comment.
pub const KEEP_ALIVE: Duration = Duration::from_secs(20);

const COMMENT: &[u8] = b": keep-alive\n\n";

/// Minutes or seconds, for the messages.
fn wait(d: Duration) -> String {
    match d.as_secs() {
        s if s >= 60 && s.is_multiple_of(60) => format!("{} minutes", s / 60),
        s if s >= 1 => format!("{s} seconds"),
        _ => format!("{} ms", d.as_millis()),
    }
}

/// Why an engine's answer was given up on: [silence] with nothing from it.
pub fn stalled(silence: Duration) -> String {
    format!("the engine sent nothing for {}; stopped waiting", wait(silence))
}

/// An error as a server-sent event, readable as OpenAI's (`data` with `error`) and Anthropic's
/// (`event: error`).
fn error_event(kind: &str, message: &str) -> Bytes {
    let data = json!({ "type": "error", "error": { "type": kind, "code": kind, "message": message } });
    Bytes::from(format!("event: error\ndata: {data}\n\n"))
}

/// POSTs [body] to [url] (an engine on this machine) and answers with what it answers.
pub async fn engine(
    client: &reqwest::Client,
    url: &str,
    body: Bytes,
    streaming: bool,
    every: Duration,
    silence: Duration,
) -> Response {
    let send = client.post(url).header(header::CONTENT_TYPE, "application/json").body(body).send();
    let mut send = Box::pin(send);
    let unreachable = |e: reqwest::Error| {
        tracing::warn!(%url, "engine unreachable: {e}");
        error(StatusCode::BAD_GATEWAY, "engine_unreachable", "the engine did not answer")
    };
    // Not streamed: nothing comes until the answer is done, so the limit is a total one.
    let first = if streaming { every } else { silence };
    let upstream = match tokio::time::timeout(first, &mut send).await {
        Ok(Ok(upstream)) => upstream,
        Ok(Err(e)) => return unreachable(e),
        Err(_) if !streaming => return error(StatusCode::GATEWAY_TIMEOUT, "engine_stalled", &stalled(silence)),
        // Streamed, and the engine has not begun: the answer begins here, kept alive until it
        // does. Its status is the stream's from now on; an engine's error comes as an event.
        Err(_) => return early(send, every, silence),
    };
    passed(upstream, streaming, every, silence)
}

/// The engine's answer as it came (status, type, body), its silences filled with comments when
/// streamed and cut short past [silence].
fn passed(upstream: reqwest::Response, streaming: bool, every: Duration, silence: Duration) -> Response {
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let event_stream =
        content_type.as_ref().and_then(|v| v.to_str().ok()).is_some_and(|t| t.starts_with("text/event-stream"));
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    tokio::spawn(pump(upstream, tx, (streaming && event_stream).then_some(every), silence));
    let mut response = Response::new(body(rx));
    *response.status_mut() = status;
    if let Some(content_type) = content_type.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    response
}

/// A streamed answer begun before the engine's: comments until it answers, then its stream (or
/// its error, as an event).
fn early<F>(send: std::pin::Pin<Box<F>>, every: Duration, silence: Duration) -> Response
where
    F: Future<Output = Result<reqwest::Response, reqwest::Error>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut send = send;
        let started = tokio::time::Instant::now();
        let upstream = loop {
            if tx.send(Ok(Bytes::from_static(COMMENT))).await.is_err() {
                return; // The client went away: so does the request.
            }
            let left = silence.saturating_sub(started.elapsed());
            if left.is_zero() {
                let _ = tx.send(Ok(error_event("engine_stalled", &stalled(silence)))).await;
                return;
            }
            match tokio::time::timeout(every.min(left), &mut send).await {
                Err(_) => continue,
                Ok(Err(e)) => {
                    tracing::warn!("engine unreachable: {e}");
                    let _ = tx.send(Ok(error_event("engine_unreachable", "the engine did not answer"))).await;
                    return;
                }
                Ok(Ok(upstream)) => break upstream,
            }
        };
        if !upstream.status().is_success() {
            let status = upstream.status();
            let text = upstream.text().await.unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let message = parsed["error"]["message"].as_str().map(str::to_owned).unwrap_or(text);
            let message = if message.trim().is_empty() { format!("the engine answered {status}") } else { message };
            let _ = tx.send(Ok(error_event("engine_error", &message))).await;
            return;
        }
        pump(upstream, tx, Some(every), silence).await;
    });
    let mut response = Response::new(body(rx));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// Passes [upstream]'s body to [tx]: a comment after each [every] without a byte (when set), and
/// past [silence] without one, an error event (streamed) or a cut (not).
async fn pump(
    upstream: reqwest::Response,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    every: Option<Duration>,
    silence: Duration,
) {
    let mut stream = upstream.bytes_stream();
    let mut heard = tokio::time::Instant::now();
    loop {
        let left = silence.saturating_sub(heard.elapsed());
        let next = match every {
            Some(every) => tokio::time::timeout(every.min(left), stream.next()).await,
            None => tokio::time::timeout(left, stream.next()).await,
        };
        let sent = match next {
            Ok(Some(Ok(bytes))) => {
                heard = tokio::time::Instant::now();
                tx.send(Ok(bytes)).await
            }
            Ok(Some(Err(e))) => {
                let _ = tx.send(Err(std::io::Error::other(e))).await;
                return;
            }
            Ok(None) => return,
            Err(_) if heard.elapsed() >= silence => {
                let _ = match every {
                    Some(_) => tx.send(Ok(error_event("engine_stalled", &stalled(silence)))).await,
                    None => tx.send(Err(std::io::Error::other(stalled(silence)))).await,
                };
                return;
            }
            Err(_) => tx.send(Ok(Bytes::from_static(COMMENT))).await,
        };
        if sent.is_err() {
            return; // The client went away.
        }
    }
}

fn body(rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>) -> Body {
    Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    /// A stand-in engine: waits [think], then answers [status] with [body] (streamed or not).
    async fn engine(think: Duration, status: u16, body: &'static str, streamed: bool) -> String {
        let app = axum::Router::new().route(
            "/x",
            axum::routing::post(move || async move {
                tokio::time::sleep(think).await;
                let kind = if streamed { "text/event-stream" } else { "application/json" };
                (StatusCode::from_u16(status).unwrap(), [("content-type", kind)], body).into_response()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    async fn relayed(url: &str, streaming: bool, every: Duration, silence: Duration) -> (StatusCode, String) {
        let response =
            super::engine(&reqwest::Client::new(), url, Bytes::from_static(b"{}"), streaming, every, silence).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn a_slow_start_is_kept_alive_and_its_answer_passed_through() {
        let url = engine(Duration::from_millis(600), 200, "data: {\"x\":1}\n\ndata: [DONE]\n\n", true).await;
        let (status, body) = relayed(&url, true, Duration::from_millis(100), Duration::from_secs(10)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.starts_with(": keep-alive\n\n"), "{body}");
        assert!(body.ends_with("data: {\"x\":1}\n\ndata: [DONE]\n\n"), "{body}");
    }

    #[tokio::test]
    async fn an_engine_error_after_the_stream_began_is_an_error_event() {
        let url = engine(Duration::from_millis(400), 400, r#"{"error":{"message":"context too long"}}"#, false).await;
        let (status, body) = relayed(&url, true, Duration::from_millis(100), Duration::from_secs(10)).await;
        assert_eq!(status, StatusCode::OK, "begun already");
        assert!(body.contains("event: error\ndata: ") && body.contains("context too long"), "{body}");
        // An error that comes at once keeps its status.
        let url = engine(Duration::ZERO, 400, r#"{"error":{"message":"bad"}}"#, false).await;
        let (status, _) = relayed(&url, true, Duration::from_secs(5), Duration::from_secs(10)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_silent_engine_is_given_up_on_and_says_so() {
        // Streamed: an error event, not a cut (a cut would be tried again).
        let url = engine(Duration::from_secs(30), 200, "", true).await;
        let (status, body) = relayed(&url, true, Duration::from_millis(100), Duration::from_millis(500)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("engine_stalled") && body.contains("sent nothing for 500 ms"), "{body}");
        // Not streamed: the limit is the total time; a 504.
        let (status, body) = relayed(&url, false, Duration::from_millis(100), Duration::from_millis(500)).await;
        assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
        assert!(body.contains("engine_stalled"), "{body}");
        assert_eq!(stalled(Duration::from_secs(30 * 60)), "the engine sent nothing for 30 minutes; stopped waiting");
    }
}
