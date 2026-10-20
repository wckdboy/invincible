//! Timing and memory benchmarks, ignored by default: run them on a release build with
//! `bench/run.sh` (or `cargo build --release && cargo test --release -p autobot --test perf --
//! --ignored --nocapture --test-threads 1`). Each prints `BENCH <name> <value> <unit>` lines.
//!
//! Everything runs against stand-ins on loopback (a llama.cpp-like engine, a gateway) with
//! isolated homes; nothing here touches a real node.

// The terminal benchmarks run on a pseudo-terminal.
#![cfg(unix)]

mod support;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::json;
use support::*;

/// `invincible serve` with one local model whose engine is the stand-in: the gateway runs a
/// fake `llama-server` that only says which port it was given, and the stand-in listens there.
struct Gateway {
    proc: Proc,
    url: String,
    engine: Mock,
}

async fn gateway(dir: &std::path::Path, homes: &Homes, shape: Shape) -> Gateway {
    let port = free_port();
    let port_file = dir.join("engine.port");
    let fake = dir.join("fake-llama-server");
    // Exits when the gateway does (its parent), so nothing is left behind.
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = --port ] && echo \"$2\" > '{}'; shift; done\nwhile kill -0 $PPID 2>/dev/null; do sleep 1; done\n",
            port_file.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(dir.join("model.gguf"), b"not a model").unwrap();
    let config = format!(
        "listen = \"127.0.0.1:{port}\"\n\n[engine]\nllama_server = \"{}\"\n\n[[models]]\nid = \"mock\"\npath = \"{}\"\ncontext = 8192\n",
        fake.display(),
        dir.join("model.gguf").display()
    );
    std::fs::write(homes.invincible.join("config.toml"), config).unwrap();
    let proc = spawn(
        {
            let mut c = homes.command(&binary("invincible"));
            c.arg("serve");
            c
        },
        &dir.join("gateway.log"),
    );
    let until = Instant::now() + Duration::from_secs(20);
    let engine_port: u16 = loop {
        if let Some(p) = std::fs::read_to_string(&port_file).ok().and_then(|t| t.trim().parse().ok()) {
            break p;
        }
        assert!(Instant::now() < until, "the gateway did not start its engine: {}", dir.join("gateway.log").display());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let engine = mock(([127, 0, 0, 1], engine_port).into(), shape).await;
    let url = format!("http://127.0.0.1:{port}");
    wait_healthy(&format!("{url}/health"), Duration::from_secs(20)).await;
    // The engine counts once its health check passed (every 500 ms).
    let client = reqwest::Client::new();
    loop {
        let models: serde_json::Value =
            client.get(format!("{url}/v1/models")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
        if models["data"][0]["invincible"]["healthy"] == true {
            break;
        }
        assert!(Instant::now() < until, "the engine never became healthy: {models}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Gateway { proc, url, engine }
}

fn chat_body(stream: bool) -> serde_json::Value {
    json!({ "model": "mock", "stream": stream, "messages": [{ "role": "user", "content": "say something short" }] })
}

/// One whole request: its time.
async fn timed(client: &reqwest::Client, url: &str, stream: bool) -> Duration {
    let started = Instant::now();
    let response = client.post(format!("{url}/v1/chat/completions")).bearer_auth(TOKEN).json(&chat_body(stream)).send();
    let body = response.await.unwrap().bytes().await.unwrap();
    assert!(!body.is_empty());
    started.elapsed()
}

/// A streamed request: the time to its first content piece (`tok`).
async fn first_token(client: &reqwest::Client, url: &str) -> Duration {
    use futures_util::StreamExt;
    let started = Instant::now();
    let response = client
        .post(format!("{url}/v1/chat/completions"))
        .bearer_auth(TOKEN)
        .json(&chat_body(true))
        .send()
        .await
        .unwrap();
    let mut stream = response.bytes_stream();
    let mut seen = Vec::new();
    let mut at = None;
    while let Some(chunk) = stream.next().await {
        seen.extend_from_slice(&chunk.unwrap());
        if at.is_none() && seen.windows(3).any(|w| w == b"tok") {
            at = Some(started.elapsed());
        }
    }
    at.expect("a content piece")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark: bench/run.sh"]
async fn gateway_added_latency_and_memory() {
    let dir = temp("gateway");
    let homes = Homes::new(&dir);
    // Pieces 1 ms apart, as a fast local model streams.
    let g = gateway(&dir, &homes, Shape { chunks: 16, delay: Duration::from_millis(1) }).await;
    let pid = g.proc.pid();
    tokio::time::sleep(Duration::from_millis(500)).await;
    report("gateway.rss_idle", rss_kib(pid) as f64 / 1024.0, "MiB");
    report("gateway.fds_idle", fds(pid) as f64, "fds");
    let client = reqwest::Client::new();
    let engine = g.engine.url();
    // Warm both paths up (connections, caches).
    for _ in 0..20 {
        timed(&client, &engine, false).await;
        timed(&client, &g.url, false).await;
    }
    let n = 400;
    let (mut direct, mut via) = (Vec::new(), Vec::new());
    for _ in 0..n {
        direct.push(timed(&client, &engine, false).await);
        via.push(timed(&client, &g.url, false).await);
    }
    let (d50, v50) = (quantile_ms(&mut direct, 0.5), quantile_ms(&mut via, 0.5));
    let (d99, v99) = (quantile_ms(&mut direct, 0.99), quantile_ms(&mut via, 0.99));
    report("gateway.direct_p50", d50, "ms");
    report("gateway.via_p50", v50, "ms");
    report("gateway.added_p50", v50 - d50, "ms");
    report("gateway.added_p99", v99 - d99, "ms");
    let (mut direct, mut via) = (Vec::new(), Vec::new());
    for _ in 0..100 {
        direct.push(first_token(&client, &engine).await);
        via.push(first_token(&client, &g.url).await);
    }
    let (d50, v50) = (quantile_ms(&mut direct, 0.5), quantile_ms(&mut via, 0.5));
    report("gateway.first_token_direct_p50", d50, "ms");
    report("gateway.first_token_via_p50", v50, "ms");
    report("gateway.first_token_added_p50", v50 - d50, "ms");
    let (mut direct, mut via) = (Vec::new(), Vec::new());
    for _ in 0..100 {
        direct.push(timed(&client, &engine, true).await);
        via.push(timed(&client, &g.url, true).await);
    }
    report("gateway.stream_added_p50", quantile_ms(&mut via, 0.5) - quantile_ms(&mut direct, 0.5), "ms");
    // 1000 requests through the gateway in all, 8 at a time for the rest.
    let done = 20 + n + 100 + 100;
    let rest: Vec<_> = (done..1000)
        .map(|i| {
            let (client, url) = (client.clone(), g.url.clone());
            async move { timed(&client, &url, i % 2 == 0).await }
        })
        .collect();
    let started = Instant::now();
    futures_util::stream::iter(rest).buffer_unordered(8).collect::<Vec<_>>().await;
    report("gateway.throughput_8", (1000 - done) as f64 / started.elapsed().as_secs_f64(), "req/s");
    tokio::time::sleep(Duration::from_millis(500)).await;
    report("gateway.rss_after_1000", rss_kib(pid) as f64 / 1024.0, "MiB");
    report("gateway.fds_after_1000", fds(pid) as f64, "fds");
    g.engine.stop().await;
}

use futures_util::StreamExt;

/// `autobot` (the chat, outside a repository) in a terminal: until the composer is drawn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "benchmark: bench/run.sh"]
async fn agent_cold_start_to_first_composer_frame() {
    let dir = temp("cold");
    let homes = Homes::new(&dir);
    let gw = mock(([127, 0, 0, 1], 0).into(), Shape::default()).await;
    homes.agent_config(&gw.url(), free_port(), true);
    std::fs::create_dir_all(homes.home.join("work")).unwrap();
    let mut samples = Vec::new();
    for _ in 0..15 {
        let mut command = homes.command(&binary("autobot"));
        command.arg("chat").env("TERM", "xterm-256color").current_dir(&homes.home);
        let took = tokio::task::spawn_blocking(move || time_to_output(command, "╭", Duration::from_secs(20)))
            .await
            .unwrap()
            .unwrap();
        samples.push(took);
    }
    report("agent.cold_start_composer_p50", quantile_ms(&mut samples, 0.5), "ms");
    report("agent.cold_start_composer_min", quantile_ms(&mut samples, 0.0), "ms");
    let mut version = Vec::new();
    for _ in 0..15 {
        let started = Instant::now();
        homes.command(&binary("autobot")).arg("--version").output().unwrap();
        version.push(started.elapsed());
    }
    report("agent.exec_version_p50", quantile_ms(&mut version, 0.5), "ms");
    gw.stop().await;
}

/// `autobot run` against a gateway that answers at once: the whole process, per turn; and the
/// agent loop alone, in one conversation 1000 turns long.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "benchmark: bench/run.sh"]
async fn agent_run_overhead_per_turn() {
    let dir = temp("run");
    let homes = Homes::new(&dir);
    let gw = mock(([127, 0, 0, 1], 0).into(), Shape { chunks: 8, delay: Duration::ZERO }).await;
    homes.agent_config(&gw.url(), free_port(), true);
    let mut samples = Vec::new();
    for i in 0..15 {
        let started = Instant::now();
        let out = homes
            .command(&binary("autobot"))
            .args(["run", "--session", &format!("r{i}"), "say hi"])
            .current_dir(&homes.home)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        samples.push(started.elapsed());
    }
    report("agent.run_process_p50", quantile_ms(&mut samples, 0.5), "ms");

    // In process: the loop's own cost, without the process start.
    let token_file = homes.invincible.join("token");
    let config: autobot::config::Config = toml::from_str(&format!(
        "[gateway]\nurl = \"{}/v1\"\nmodel = \"mock\"\ntoken_file = \"{}\"\n[agent]\nworkdir = \"{}\"\n",
        gw.url(),
        token_file.display(),
        homes.home.join("work").display()
    ))
    .unwrap();
    let agent = autobot::agent(&config, &homes.autobot).unwrap();
    let mut session = autobot::session::Session::open(&homes.autobot.join("sessions"), "long").unwrap();
    let approver = autobot::approval::Refuse;
    let quiet = |_: autobot::agent::Event| {};
    let mut times = Vec::new();
    // More with BENCH_TURNS (to profile the loop).
    let n: usize = std::env::var("BENCH_TURNS").ok().and_then(|n| n.parse().ok()).unwrap_or(1000).max(1000);
    for i in 0..n {
        let started = Instant::now();
        agent
            .turn(&mut session, &format!("message {i}: say something"), &approver, &mut HashSet::new(), &quiet)
            .await
            .unwrap();
        times.push(started.elapsed());
    }
    let mean = |s: &[Duration]| s.iter().map(Duration::as_secs_f64).sum::<f64>() / s.len() as f64 * 1000.0;
    report("agent.turn_first100_mean", mean(&times[..100]), "ms");
    report("agent.turn_last100_mean", mean(&times[n - 100..]), "ms");
    // Model calls per turn, once the conversation is long (summaries of what left the window).
    let before = gw.requests.load(std::sync::atomic::Ordering::Relaxed);
    for i in 0..100 {
        agent.turn(&mut session, &format!("more {i}"), &approver, &mut HashSet::new(), &quiet).await.unwrap();
    }
    let calls = gw.requests.load(std::sync::atomic::Ordering::Relaxed) - before;
    report("agent.model_calls_per_long_turn", calls as f64 / 100.0, "calls");
    gw.stop().await;
}

/// `autobot serve` (two bots) idle, and after 1000 turns over its API in 250 conversations.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark: bench/run.sh"]
async fn agent_serve_memory() {
    let dir = temp("serve");
    let homes = Homes::new(&dir);
    let gw = mock(([127, 0, 0, 1], 0).into(), Shape::default()).await;
    let port = free_port();
    homes.agent_config(&gw.url(), port, true);
    homes.add_bot("other");
    let proc = spawn(
        {
            let mut c = homes.command(&binary("autobot"));
            c.arg("serve").current_dir(&homes.home);
            c
        },
        &dir.join("agent.log"),
    );
    let agent = format!("http://127.0.0.1:{port}");
    wait_healthy(&format!("{agent}/healthz"), Duration::from_secs(20)).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let pid = proc.pid();
    report("serve.rss_idle", rss_kib(pid) as f64 / 1024.0, "MiB");
    report("serve.fds_idle", fds(pid) as f64, "fds");
    report("serve.threads_idle", threads(pid) as f64, "threads");
    let client = reqwest::Client::new();
    let started = Instant::now();
    let turns: Vec<_> = (0..1000)
        .map(|i| {
            let (client, agent) = (client.clone(), agent.clone());
            async move {
                let bot = if i % 2 == 0 { None } else { Some("other") };
                let last = api_turn(&client, &agent, &format!("s{}", i % 250), bot, "say hi").await;
                (i, last)
            }
        })
        .collect();
    // One turn per conversation at a time: 250 conversations, 4 turns each, in order.
    let mut by_session: Vec<Vec<_>> = (0..250).map(|_| Vec::new()).collect();
    for (i, t) in turns.into_iter().enumerate() {
        by_session[i % 250].push(t);
    }
    let lanes = by_session.into_iter().map(|lane| async move {
        let mut out = Vec::new();
        for t in lane {
            out.push(t.await);
        }
        out
    });
    let results: Vec<_> = futures_util::stream::iter(lanes).buffer_unordered(16).collect::<Vec<_>>().await;
    let answered = results.iter().flatten().filter(|(_, r)| r.as_ref().is_ok_and(|v| v["type"] == "answer")).count();
    assert_eq!(
        answered,
        1000,
        "{:?}",
        results.iter().flatten().find(|(_, r)| r.as_ref().map_or(true, |v| v["type"] != "answer"))
    );
    report("serve.busy_retries", BUSY.load(std::sync::atomic::Ordering::Relaxed) as f64, "retries");
    report("serve.turns_per_s_16", 1000.0 / started.elapsed().as_secs_f64(), "turns/s");
    tokio::time::sleep(Duration::from_millis(500)).await;
    report("serve.rss_after_1000", rss_kib(pid) as f64 / 1024.0, "MiB");
    report("serve.fds_after_1000", fds(pid) as f64, "fds");
    report("serve.threads_after_1000", threads(pid) as f64, "threads");
    drop(proc);
    gw.stop().await;
}
