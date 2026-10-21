//! A scripted model for the harness tests (`tests/harness.rs`) and benchmarks
//! (`tests/perf_harness.rs`): a stand-in gateway on loopback whose every answer is chosen by a
//! function of the request, so a scenario says exactly what the model does: tool calls (good,
//! malformed, huge), streams that stop half-way, hangs, errors and rate limits.

#![allow(dead_code)]

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use autobot::agent::{Agent, Event};
use autobot::approval::{Action, Answer, Approver};
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

/// What the model does for one call.
pub enum Reply {
    /// A whole answer: status and body (plus headers).
    Json(u16, Value, Vec<(&'static str, String)>),
    /// Server-sent events, each piece after [Duration]; [bool]: end with `[DONE]`.
    Stream(Vec<(Duration, Value)>, bool),
    /// A stream that sends [Value]s, then nothing more for [Duration], then breaks.
    StreamThenStall(Vec<Value>, Duration),
    /// No answer for this long, then a short one.
    Hang(Duration),
}

/// What a request looked like when it came.
#[derive(Clone)]
pub struct Seen {
    pub body: Value,
    /// Its length as sent (the bytes of the body).
    pub bytes: usize,
    pub at: Instant,
    /// When its answer was handed back (whole answers only).
    pub answered: Option<Instant>,
}

type Script = dyn Fn(usize, &Value) -> Reply + Send + Sync;

pub struct Model {
    pub url: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl Model {
    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

struct Shared {
    script: Box<Script>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

/// A model whose [script] answers call n (from 0) given its request body.
pub async fn model(script: impl Fn(usize, &Value) -> Reply + Send + Sync + 'static) -> Model {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    serve(listener, script)
}

/// [model] on [port] (a gateway that comes up late).
pub async fn model_on(port: u16, script: impl Fn(usize, &Value) -> Reply + Send + Sync + 'static) -> Model {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    serve(listener, script)
}

fn serve(listener: tokio::net::TcpListener, script: impl Fn(usize, &Value) -> Reply + Send + Sync + 'static) -> Model {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(Shared { script: Box::new(script), seen: seen.clone() });
    let app = axum::Router::new()
        .route("/v1/chat/completions", axum::routing::post(completions))
        .route("/health", axum::routing::get(|| async { "ok" }))
        .with_state(shared);
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Model { url, seen }
}

async fn completions(State(shared): State<Arc<Shared>>, bytes: Bytes) -> Response {
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let n = {
        let mut seen = shared.seen.lock().unwrap();
        seen.push(Seen { body: body.clone(), bytes: bytes.len(), at: Instant::now(), answered: None });
        seen.len() - 1
    };
    let reply = (shared.script)(n, &body);
    let receipt = format!("req{}", n + 1);
    match reply {
        Reply::Json(status, value, headers) => {
            let mut response = (StatusCode::from_u16(status).unwrap(), axum::Json(value)).into_response();
            if status == 200 {
                response.headers_mut().insert("invincible-request-id", receipt.parse().unwrap());
            }
            for (k, v) in headers {
                response.headers_mut().insert(k, v.parse().unwrap());
            }
            shared.seen.lock().unwrap()[n].answered = Some(Instant::now());
            response
        }
        Reply::Hang(wait) => {
            tokio::time::sleep(wait).await;
            axum::Json(say_body("late")).into_response()
        }
        Reply::Stream(pieces, done) => {
            let stream = futures_util::stream::unfold((pieces.into_iter(), done), |(mut it, done)| async move {
                match it.next() {
                    Some((wait, chunk)) => {
                        if !wait.is_zero() {
                            tokio::time::sleep(wait).await;
                        }
                        let line = Bytes::from(format!("data: {chunk}\n\n"));
                        Some((Ok::<_, std::convert::Infallible>(line), (it, done)))
                    }
                    None if done => Some((Ok(Bytes::from("data: [DONE]\n\n")), (Vec::new().into_iter(), false))),
                    None => None,
                }
            });
            sse(Body::from_stream(stream), &receipt)
        }
        Reply::StreamThenStall(pieces, stall) => {
            let stream =
                futures_util::stream::unfold((pieces.into_iter(), false), move |(mut it, stalled)| async move {
                    match it.next() {
                        Some(chunk) => Some((Ok(Bytes::from(format!("data: {chunk}\n\n"))), (it, stalled))),
                        None if !stalled => {
                            tokio::time::sleep(stall).await;
                            Some((Err(std::io::Error::other("the stand-in breaks the stream")), (it, true)))
                        }
                        None => None,
                    }
                });
            sse(Body::from_stream(stream), &receipt)
        }
    }
}

fn sse(body: Body, receipt: &str) -> Response {
    let mut response = Response::new(body);
    response.headers_mut().insert("content-type", "text/event-stream".parse().unwrap());
    response.headers_mut().insert("invincible-request-id", receipt.parse().unwrap());
    response
}

fn say_body(text: &str) -> Value {
    json!({ "choices": [{ "message": { "role": "assistant", "content": text } }] })
}

/// The model answers in words.
pub fn say(text: &str) -> Reply {
    Reply::Json(200, say_body(text), Vec::new())
}

/// The model calls one tool, its arguments as given (a string is sent as it is, malformed or not).
pub fn call(id: &str, name: &str, arguments: impl Into<Value>) -> Reply {
    calls(&[(id, name, arguments.into())])
}

/// The model calls several tools in one answer.
pub fn calls(list: &[(&str, &str, Value)]) -> Reply {
    let calls: Vec<Value> = list
        .iter()
        .map(|(id, name, arguments)| {
            let arguments = match arguments {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } })
        })
        .collect();
    Reply::Json(
        200,
        json!({ "choices": [{ "message": { "role": "assistant", "content": "", "tool_calls": calls } }] }),
        Vec::new(),
    )
}

/// [reply] with the router's decision naming [model] (as the gateway sends on answers and errors).
pub fn routed(reply: Reply, model: &str) -> Reply {
    match reply {
        Reply::Json(status, body, mut headers) => {
            headers
                .push(("invincible-decision", json!({ "action": "run", "model": model, "tier": "node" }).to_string()));
            Reply::Json(status, body, headers)
        }
        other => other,
    }
}

/// An error answer, the way an OpenAI-compatible server words one.
pub fn error(status: u16, message: &str) -> Reply {
    Reply::Json(status, json!({ "error": { "message": message } }), Vec::new())
}

/// Streamed text pieces, sent at once, ending with `[DONE]`.
pub fn streamed(pieces: &[&str]) -> Reply {
    Reply::Stream(
        pieces
            .iter()
            .map(|p| (Duration::ZERO, json!({ "choices": [{ "index": 0, "delta": { "content": p } }] })))
            .collect(),
        true,
    )
}

/// Approves everything (or nothing) and counts what it was asked.
pub struct Owner {
    pub answer: Answer,
    pub asked: Mutex<Vec<Action>>,
    /// Waits this long before answering.
    pub wait: Duration,
}

impl Owner {
    pub fn new(answer: Answer) -> Self {
        Self { answer, asked: Mutex::new(Vec::new()), wait: Duration::ZERO }
    }
}

impl Approver for Owner {
    fn approve<'a>(
        &'a self,
        action: &'a Action,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Answer> + Send + 'a>> {
        self.asked.lock().unwrap().push(action.clone());
        let (answer, wait) = (self.answer.clone(), self.wait);
        Box::pin(async move {
            tokio::time::sleep(wait).await;
            answer
        })
    }
}

/// A fresh directory for one test.
pub fn dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-harness-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("work")).unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    dir.canonicalize().unwrap()
}

/// An agent on [url] working in `<dir>/work` with its home in `<dir>/home`, approvals answered
/// by the policy [mode].
pub fn agent(url: &str, dir: &std::path::Path, mode: ApprovalMode) -> Agent {
    Agent {
        // Retries come quickly here.
        gateway: Gateway::new(url, "secret", "auto", true).unwrap().with_retries(3, Duration::from_millis(20)),
        tools: Tools::new(dir.join("work"), Duration::from_secs(5)).with_home(dir.join("home")),
        approvals: ApprovalConfig { mode, allow: vec!["echo".into(), "printf".into(), "cat".into()] },
        max_steps: 24,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    }
}

pub fn quiet(_: Event) {}

pub fn grants() -> HashSet<Action> {
    HashSet::new()
}

/// The tool results of request [body], in order.
pub fn tool_results(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// The last tool result in request [body].
pub fn last_result(body: &Value) -> String {
    tool_results(body).pop().unwrap_or_default()
}

/// Tool results in the current turn of request [body] (after its last user message).
pub fn results_this_turn(body: &Value) -> usize {
    let messages = body["messages"].as_array().unwrap();
    let start = messages.iter().rposition(|m| m["role"] == "user").unwrap_or(0);
    messages[start..].iter().filter(|m| m["role"] == "tool").count()
}

/// Every tool call in [messages] answered by exactly one result, right after it, and no result
/// without its call: a conversation every model takes.
pub fn assert_consistent(messages: &[Value]) {
    let mut open: Vec<String> = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        match m["role"].as_str() {
            Some("tool") => {
                let id = m["tool_call_id"].as_str().unwrap_or_default();
                let at = open.iter().position(|o| o == id);
                assert!(at.is_some(), "message {i}: a result for {id:?}, which is not an open call: {messages:#?}");
                open.remove(at.unwrap());
            }
            _ => {
                assert!(open.is_empty(), "message {i}: calls {open:?} have no result: {messages:#?}");
                if let Some(calls) = m["tool_calls"].as_array() {
                    open = calls.iter().map(|c| c["id"].as_str().unwrap_or_default().to_owned()).collect();
                }
            }
        }
    }
}
