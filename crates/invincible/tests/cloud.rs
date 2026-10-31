//! Cloud backends end to end, against a stub provider on loopback: what leaves is redacted, what
//! comes back is restored, failures fall back to the node, and the routing rules keep private,
//! offline and unconfirmed requests away from the cloud.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::cloud::{CloudModel, REDACTED_HEADER};
use invincible::engine::Engine;
use invincible::server::{AppState, DECISION_HEADER, app};
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

/// What the stub provider saw.
#[derive(Default)]
struct Seen {
    bodies: Vec<Value>,
    auth: Vec<String>,
}

/// A stub provider. `mode`: "echo" answers with the last user message; "stream" streams it with a
/// placeholder split across chunks; "call" answers with reasoning and a tool call that name the
/// last message's placeholder; "call-stream" streams them, the placeholder split in each, and the
/// usage when asked for it in a chunk of its own (as OpenAI's), "call-stream-last" with it on the
/// last chunk (as DeepSeek's); "fail" answers 500; "deny" answers 401.
async fn provider(mode: &'static str) -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, body: Bytes| {
            let record = record.clone();
            async move {
                let body: Value = serde_json::from_slice(&body).unwrap();
                let said = body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap_or("").to_owned();
                {
                    let mut seen = record.lock().unwrap();
                    seen.bodies.push(body);
                    seen.auth.push(headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default());
                }
                match mode {
                    "fail" => (StatusCode::INTERNAL_SERVER_ERROR, "down").into_response(),
                    "deny" => (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": { "message": "bad key" } })))
                        .into_response(),
                    "call" | "call-stream" | "call-stream-last" => {
                        let at = said.find('[').unwrap();
                        let placeholder = &said[at..at + said[at..].find(']').unwrap() + 1];
                        if mode == "call" {
                            return axum::Json(json!({ "choices": [{ "index": 0, "finish_reason": "tool_calls", "message": {
                                "role": "assistant",
                                "content": null,
                                "reasoning_content": format!("Sending to {placeholder}."),
                                "tool_calls": [{ "id": "c1", "type": "function", "function": {
                                    "name": "send",
                                    "arguments": json!({ "to": placeholder }).to_string(),
                                } }],
                            } }] }))
                            .into_response();
                        }
                        let (a, rest) = placeholder.split_at(4);
                        let (b, c) = rest.split_at(3);
                        // As OpenAI's: asked for usage, every chunk says `"usage": null` until the last.
                        let usage = record.lock().unwrap().bodies.last().unwrap()["stream_options"]["include_usage"]
                            == json!(true);
                        let delta = |d: Value| {
                            let mut chunk = json!({ "choices": [{ "index": 0, "delta": d }] });
                            if usage {
                                chunk["usage"] = Value::Null;
                            }
                            format!("data: {chunk}\n\n")
                        };
                        let args = |s: &str| json!({ "tool_calls": [{ "index": 0, "function": { "arguments": s } }] });
                        let tokens = json!({ "prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19 });
                        let mut finish = json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] });
                        let on_last = mode == "call-stream-last";
                        if usage && on_last {
                            finish["usage"] = tokens.clone();
                        }
                        let mut events = [
                            delta(json!({ "role": "assistant", "reasoning_content": format!("Sending to {a}") })),
                            delta(json!({ "reasoning_content": format!("{b}{c}.") })),
                            delta(json!({ "tool_calls": [{ "index": 0, "id": "c1", "type": "function",
                                "function": { "name": "send", "arguments": format!("{{\"to\":\"{a}") } }] })),
                            delta(args(b)),
                            delta(args(&format!("{c}\"}}"))),
                            format!("data: {finish}\n\n"),
                        ]
                        .concat();
                        if usage && !on_last {
                            events.push_str(&format!("data: {}\n\n", json!({ "choices": [], "usage": tokens })));
                        }
                        events.push_str("data: [DONE]\n\n");
                        ([("content-type", "text/event-stream")], events).into_response()
                    }
                    "stream" => {
                        // "You said: [EMAIL_1]" with the placeholder split in three.
                        let (head, tail) = said.split_at(said.find('[').unwrap() + 3);
                        let (mid, end) = tail.split_at(4);
                        let chunk = |s: &str| format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "content": s } }] }));
                        let events = format!("{}{}{}{}data: [DONE]\n\n", chunk(&format!("You said: {head}")), chunk(mid), chunk(end), "");
                        ([("content-type", "text/event-stream")], events).into_response()
                    }
                    _ => axum::Json(json!({
                        "choices": [{ "index": 0, "message": { "role": "assistant", "content": format!("You said: {said}") } }]
                    }))
                    .into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1"), seen)
}

/// A local engine that answers "local".
async fn local_engine() -> String {
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|| async { axum::Json(json!({ "choices": [{ "message": { "content": "local" } }] })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A node with a small local model (context 64) and one cloud model.
async fn node(cloud_url: &str, network: NetworkMode, egress: Egress, policy: DataPolicy) -> String {
    let engine = Engine::attached("local", &local_engine().await, Some(64), true);
    // As a preset's API: streams ask for usage.
    let cloud = CloudModel::new("claude", "claude-upstream", cloud_url, Some("sk-test".into()), Some(200_000), policy)
        .with_include_usage(Some(true));
    let state = AppState::new(vec![engine], NodeSettings { network, egress }, "token".into()).with_cloud(vec![cloud]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(Arc::new(state))).await.unwrap() });
    format!("http://{addr}")
}

async fn open_node(cloud_url: &str) -> String {
    node(cloud_url, NetworkMode::Direct, Egress::Auto, DataPolicy::Retention { days: 30 }).await
}

fn chat(node: &str, body: Value) -> reqwest::RequestBuilder {
    reqwest::Client::new().post(format!("{node}/v1/chat/completions")).bearer_auth("token").json(&body)
}

fn decision(response: &reqwest::Response) -> Value {
    serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap()
}

fn say(model: &str, text: &str) -> Value {
    json!({ "model": model, "messages": [{ "role": "user", "content": text }] })
}

#[tokio::test]
async fn the_cloud_sees_placeholders_and_the_client_sees_values() {
    let (url, seen) = provider("echo").await;
    let node = open_node(&url).await;
    let response = chat(&node, say("claude", "mail alice@proton.me, call +44 20 7946 0958")).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        decision(&response),
        json!({ "action": "run", "model": "claude", "tier": "cloud", "reason": "requested", "redact": true })
    );
    assert_eq!(response.headers()[REDACTED_HEADER], r#"{"EMAIL":1,"PHONE":1}"#);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "You said: mail alice@proton.me, call +44 20 7946 0958");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.bodies[0]["messages"][0]["content"], "mail [EMAIL_1], call [PHONE_1]");
    assert_eq!(seen.bodies[0]["model"], "claude-upstream");
    assert_eq!(seen.auth[0], "Bearer sk-test");
}

#[tokio::test]
async fn streamed_answers_are_restored_across_chunks() {
    let (url, _) = provider("stream").await;
    let node = open_node(&url).await;
    let mut body = say("claude", "my mail is bob@posteo.de");
    body["stream"] = json!(true);
    let text = chat(&node, body).send().await.unwrap().text().await.unwrap();
    let content: String = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter(|d| *d != "[DONE]")
        .map(|d| {
            serde_json::from_str::<Value>(d).unwrap()["choices"][0]["delta"]["content"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    assert_eq!(content, "You said: my mail is bob@posteo.de");
    assert!(!text.contains("[EMAIL_1]"));
    assert!(text.trim_end().ends_with("data: [DONE]"));
}

#[tokio::test]
async fn auto_goes_to_the_cloud_only_when_the_node_cannot() {
    let (url, seen) = provider("echo").await;
    let node = open_node(&url).await;
    let short = chat(&node, say("auto", "hi")).send().await.unwrap();
    assert_eq!(decision(&short)["reason"], "local-first");
    let long = chat(&node, say("auto", &"long ".repeat(100))).send().await.unwrap();
    assert_eq!(decision(&long)["reason"], "too-long");
    assert_eq!(decision(&long)["tier"], "cloud");
    assert_eq!(seen.lock().unwrap().bodies.len(), 1);
}

#[tokio::test]
async fn a_failing_cloud_falls_back_to_the_node_and_stays_down() {
    let (url, seen) = provider("fail").await;
    let node = open_node(&url).await;
    let first = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(first.status(), 200);
    assert_eq!(
        decision(&first),
        json!({ "action": "run", "model": "local", "tier": "node", "reason": "cloud-down", "fallback": true })
    );
    assert_eq!(first.json::<Value>().await.unwrap()["choices"][0]["message"]["content"], "local");
    // Marked down: the next request does not even try.
    let second = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(decision(&second)["reason"], "cloud-down");
    assert_eq!(seen.lock().unwrap().bodies.len(), 1);
}

#[tokio::test]
async fn a_refused_key_is_passed_on_not_failed_over() {
    let (url, _) = provider("deny").await;
    let node = open_node(&url).await;
    let response = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(decision(&response)["tier"], "cloud");
}

#[tokio::test]
async fn private_requests_never_reach_the_cloud() {
    let (url, seen) = provider("echo").await;
    let node = open_node(&url).await;
    let response = chat(&node, say("claude", "hi")).header("invincible-private", "1").send().await.unwrap();
    assert_eq!(decision(&response)["reason"], "private");
    assert_eq!(decision(&response)["tier"], "node");
    let long = chat(&node, say("auto", &"long ".repeat(100))).header("invincible-private", "1").send().await.unwrap();
    assert_eq!(long.status(), 403);
    assert!(seen.lock().unwrap().bodies.is_empty());
}

#[tokio::test]
async fn an_offline_node_never_reaches_the_cloud() {
    let (url, seen) = provider("echo").await;
    let node = node(&url, NetworkMode::Offline, Egress::Auto, DataPolicy::NoRetention).await;
    let response = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(decision(&response)["reason"], "offline");
    assert!(seen.lock().unwrap().bodies.is_empty());
}

#[tokio::test]
async fn asking_first_until_confirmed() {
    let (url, seen) = provider("echo").await;
    let ask = node(&url, NetworkMode::Direct, Egress::Ask, DataPolicy::NoRetention).await;
    let first = chat(&ask, say("claude", "hi")).send().await.unwrap();
    assert_eq!(first.status(), 409);
    assert_eq!(decision(&first)["reason"], "egress-ask");
    assert!(seen.lock().unwrap().bodies.is_empty());
    let confirmed = chat(&ask, say("claude", "hi")).header("invincible-confirmed", "1").send().await.unwrap();
    assert_eq!(confirmed.status(), 200);

    let auto = open_node(&url).await;
    let sensitive =
        chat(&auto, say("auto", &"long ".repeat(100))).header("invincible-risk", "health").send().await.unwrap();
    assert_eq!(sensitive.status(), 409);
    assert_eq!(decision(&sensitive)["reason"], "sensitive");
}

#[tokio::test]
async fn a_model_that_trains_on_prompts_asks_first() {
    let (url, seen) = provider("echo").await;
    let node = node(&url, NetworkMode::Direct, Egress::Auto, DataPolicy::Trains).await;
    let response = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(response.status(), 409);
    assert_eq!(decision(&response)["reason"], "trains");
    assert!(seen.lock().unwrap().bodies.is_empty());
}

/// One agent turn with personal data everywhere a request carries text: the `user` field, a
/// tool's description and its parameters' descriptions, the model's earlier reasoning and tool
/// call, and the messages.
fn agent_turn(stream: bool) -> Value {
    json!({
        "model": "claude",
        "stream": stream,
        "user": "bob@posteo.de",
        "tools": [{ "type": "function", "function": {
            "name": "send",
            "description": "Sends mail as hannah@posteo.de",
            "parameters": { "type": "object", "properties": {
                "to": { "type": "string", "description": "whom to, like alice@proton.me" },
                "description": { "type": "string", "description": "a note; the property is called description" }
            } }
        } }],
        "messages": [
            { "role": "user", "content": "my mail is bob@posteo.de" },
            { "role": "assistant", "content": null, "reasoning_content": "Bob is bob@posteo.de", "tool_calls": [
                { "id": "c0", "type": "function", "function": { "name": "send", "arguments": "{\"to\":\"bob@posteo.de\"}" } }
            ] },
            { "role": "tool", "tool_call_id": "c0", "content": "sent" },
            { "role": "assistant", "content": "Done.", "reasoning": "carol@posteo.de was not asked" },
            { "role": "user", "content": "send it to bob@posteo.de again" }
        ]
    })
}

/// The events of a streamed answer: the reasoning and each tool call's arguments put back
/// together, and how many chunks carried no choice (a usage chunk).
fn assemble(sse: &str) -> (String, Vec<String>, usize) {
    let (mut reasoning, mut calls, mut empty) = (String::new(), Vec::<String>::new(), 0);
    for data in sse.lines().filter_map(|l| l.strip_prefix("data: ")).filter(|d| *d != "[DONE]") {
        let chunk: Value = serde_json::from_str(data).unwrap();
        if chunk["choices"].as_array().unwrap().is_empty() {
            empty += 1;
            continue;
        }
        let delta = &chunk["choices"][0]["delta"];
        reasoning.push_str(delta["reasoning_content"].as_str().unwrap_or(""));
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = call["index"].as_u64().unwrap() as usize;
            calls.resize(calls.len().max(index + 1), String::new());
            calls[index].push_str(call["function"]["arguments"].as_str().unwrap_or(""));
        }
    }
    (reasoning, calls, empty)
}

#[tokio::test]
async fn everything_personal_in_a_request_leaves_redacted() {
    let (url, seen) = provider("call").await;
    let node = open_node(&url).await;
    let response = chat(&node, agent_turn(false)).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let seen = seen.lock().unwrap();
    let sent = &seen.bodies[0];
    // What stays the same for the whole conversation is numbered first.
    assert_eq!(sent["user"], "[EMAIL_1]");
    let function = &sent["tools"][0]["function"];
    assert_eq!(function["description"], "Sends mail as [EMAIL_2]");
    assert_eq!(function["parameters"]["properties"]["to"]["description"], "whom to, like [EMAIL_3]");
    assert_eq!(function["parameters"]["properties"]["description"]["type"], "string");
    assert_eq!(function["name"], "send");
    assert_eq!(sent["messages"][0]["content"], "my mail is [EMAIL_1]");
    assert_eq!(sent["messages"][1]["reasoning_content"], "Bob is [EMAIL_1]");
    assert_eq!(sent["messages"][1]["tool_calls"][0]["function"]["arguments"], r#"{"to":"[EMAIL_1]"}"#);
    assert_eq!(sent["messages"][3]["reasoning"], "[EMAIL_4] was not asked");
    assert_eq!(sent["messages"][4]["content"], "send it to [EMAIL_1] again");
    assert!(!sent.to_string().contains("posteo") && !sent.to_string().contains("proton"), "{sent}");
}

#[tokio::test]
async fn whole_answers_restore_reasoning_and_tool_calls() {
    let (url, _) = provider("call").await;
    let node = open_node(&url).await;
    let body: Value = chat(&node, agent_turn(false)).send().await.unwrap().json().await.unwrap();
    let message = &body["choices"][0]["message"];
    assert_eq!(message["reasoning_content"], "Sending to bob@posteo.de.");
    assert_eq!(message["tool_calls"][0]["function"]["arguments"], r#"{"to":"bob@posteo.de"}"#);
}

#[tokio::test]
async fn streamed_tool_calls_and_reasoning_are_restored_across_chunks() {
    let (url, seen) = provider("call-stream").await;
    let node = open_node(&url).await;
    let response = chat(&node, agent_turn(true)).send().await.unwrap();
    let id = response.headers()["invincible-request-id"].to_str().unwrap().to_owned();
    let text = response.text().await.unwrap();
    let (reasoning, calls, empty) = assemble(&text);
    assert_eq!(reasoning, "Sending to bob@posteo.de.");
    assert_eq!(calls, [r#"{"to":"bob@posteo.de"}"#]);
    assert!(!text.contains("[EMAIL_1]") && !text.contains("[EMA"), "{text}");
    assert!(text.trim_end().ends_with("data: [DONE]"), "{text}");

    // The node asked for usage, for the receipt; the client did not, so it does not get the
    // extra chunk.
    assert_eq!(seen.lock().unwrap().bodies[0]["stream_options"], json!({ "include_usage": true }));
    assert_eq!(empty, 0, "{text}");
    assert!(!text.contains("usage"), "{text}");
    let receipt = receipt_of(&node, &id).await;
    assert_eq!(receipt["receipt"]["tokens"], json!({ "input": 12, "output": 7 }), "{receipt}");
}

/// The receipt of request [id].
async fn receipt_of(node: &str, id: &str) -> Value {
    let url = format!("{node}/v1/receipts/{id}");
    reqwest::Client::new().get(url).bearer_auth("token").send().await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn usage_on_the_last_chunk_is_kept_back_and_the_chunk_sent() {
    let (url, seen) = provider("call-stream-last").await;
    let node = open_node(&url).await;
    let response = chat(&node, agent_turn(true)).send().await.unwrap();
    let id = response.headers()["invincible-request-id"].to_str().unwrap().to_owned();
    let text = response.text().await.unwrap();
    assert_eq!(seen.lock().unwrap().bodies[0]["stream_options"], json!({ "include_usage": true }));
    // The finished choice still comes, without the usage the client did not ask for.
    let (reasoning, calls, empty) = assemble(&text);
    assert_eq!(reasoning, "Sending to bob@posteo.de.");
    assert_eq!(calls, [r#"{"to":"bob@posteo.de"}"#]);
    assert_eq!(empty, 0, "{text}");
    assert!(text.contains(r#""finish_reason":"tool_calls""#) && !text.contains("usage"), "{text}");
    let receipt = receipt_of(&node, &id).await;
    assert_eq!(receipt["receipt"]["tokens"], json!({ "input": 12, "output": 7 }), "{receipt}");

    // A client that asked gets the last chunk as it came.
    let mut body = agent_turn(true);
    body["stream_options"] = json!({ "include_usage": true });
    let response = chat(&node, body).send().await.unwrap();
    let id = response.headers()["invincible-request-id"].to_str().unwrap().to_owned();
    let text = response.text().await.unwrap();
    let last = text.lines().rfind(|l| l.contains("finish_reason")).unwrap_or_default();
    assert!(last.contains(r#""finish_reason":"tool_calls""#) && last.contains(r#""prompt_tokens":12"#), "{text}");
    let receipt = receipt_of(&node, &id).await;
    assert_eq!(receipt["receipt"]["tokens"], json!({ "input": 12, "output": 7 }), "{receipt}");
}

#[tokio::test]
async fn a_client_that_asks_for_usage_gets_it() {
    let (url, seen) = provider("call-stream").await;
    let node = open_node(&url).await;
    let mut body = agent_turn(true);
    body["stream_options"] = json!({ "include_usage": true });
    let text = chat(&node, body).send().await.unwrap().text().await.unwrap();
    let (_, calls, empty) = assemble(&text);
    assert_eq!(calls, [r#"{"to":"bob@posteo.de"}"#]);
    assert_eq!(empty, 1, "{text}");
    assert!(text.contains(r#""prompt_tokens":12"#), "{text}");
    assert_eq!(seen.lock().unwrap().bodies[0]["stream_options"], json!({ "include_usage": true }));

    // Options of its own are left as they are: no usage asked for, none added.
    let (url, seen) = provider("call-stream").await;
    let node = open_node(&url).await;
    let mut body = agent_turn(true);
    body["stream_options"] = json!({ "include_usage": false });
    let text = chat(&node, body).send().await.unwrap().text().await.unwrap();
    assert_eq!(assemble(&text).2, 0, "{text}");
    assert_eq!(seen.lock().unwrap().bodies[0]["stream_options"], json!({ "include_usage": false }));
}

#[tokio::test]
async fn a_value_given_to_a_tool_stays_hidden_when_the_tool_echoes_it() {
    let (url, seen) = provider("call").await;
    let node = open_node(&url).await;
    let address = "Hauptstraße 12a,\n10115 Berlin";
    let ask = json!({ "role": "user", "content": format!("Ship to {address} please") });
    let body: Value =
        chat(&node, json!({ "model": "claude", "messages": [ask] })).send().await.unwrap().json().await.unwrap();
    let call = body["choices"][0]["message"]["tool_calls"][0].clone();
    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).expect("valid JSON");
    assert_eq!(args["to"], address);

    // The tool answers in JSON, so the line break comes back escaped, and so does one before it.
    let result =
        json!({ "shipped_to": args["to"], "label": format!("Recipient:\n{address}"), "from": "From:\nbob@posteo.de" })
            .to_string();
    let turn = json!({ "model": "claude", "messages": [
        ask,
        { "role": "assistant", "content": null, "tool_calls": [call] },
        { "role": "tool", "tool_call_id": "c1", "content": result }
    ] });
    let response = chat(&node, turn).send().await.unwrap();
    assert_eq!(response.headers()[REDACTED_HEADER], r#"{"ADDRESS":1,"EMAIL":1}"#);
    let seen = seen.lock().unwrap();
    let sent = &seen.bodies[1];
    assert_eq!(sent["messages"][1]["tool_calls"][0]["function"]["arguments"], r#"{"to":"[ADDRESS_1]"}"#);
    let result: Value = serde_json::from_str(sent["messages"][2]["content"].as_str().unwrap()).expect("still JSON");
    assert_eq!(
        result,
        json!({ "shipped_to": "[ADDRESS_1]", "label": "Recipient:\n[ADDRESS_1]", "from": "From:\n[EMAIL_1]" })
    );
    let sent = sent.to_string();
    assert!(!sent.contains("Berlin") && !sent.contains("10115") && !sent.contains("posteo"), "{sent}");
}
