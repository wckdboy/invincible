//! The soak test, ignored by default: `autobot serve` with two bots against a stand-in gateway
//! for `SOAK_SECS` seconds (default 120) of steady traffic, the gateway going away and coming
//! back every `SOAK_RESTART_SECS` (default 20). Every message must get its answer (a turn that
//! failed while the gateway was down is sent again), and what the process holds (memory, file
//! descriptors, tasks, threads) must not grow once it is warm.
//!
//! `cargo build --release && cargo test --release -p autobot --test soak -- --ignored --nocapture`
//! (CI runs it nightly, `.github/workflows/nightly.yml`).

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;
use support::*;

fn env_secs(name: &str, default: u64) -> Duration {
    Duration::from_secs(std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default))
}

/// What the process holds now.
#[derive(Debug, Clone, Copy)]
struct Held {
    rss_kib: u64,
    fds: usize,
    tasks: u64,
    threads: usize,
}

async fn held(client: &reqwest::Client, agent: &str, pid: u32) -> Held {
    let stats: Value =
        client.get(format!("{agent}/v1/agent/stats")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    if std::env::var_os("SOAK_VERBOSE").is_some() {
        println!("stats {stats} pid {pid}");
    }
    Held { rss_kib: rss_kib(pid), fds: fds(pid), tasks: stats["tasks"].as_u64().unwrap(), threads: threads(pid) }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "soak test: minutes long; run on purpose"]
async fn two_bots_under_steady_traffic_and_gateway_restarts() {
    let total = env_secs("SOAK_SECS", 120);
    let restart_every = env_secs("SOAK_RESTART_SECS", 20);
    let dir = temp("soak");
    let homes = Homes::new(&dir);
    let gateway_addr: std::net::SocketAddr = ([127, 0, 0, 1], free_port()).into();
    let requests = Arc::new(AtomicU64::new(0));
    let shape = Shape { chunks: 6, delay: Duration::from_millis(2) };
    let mut gateway = Some(mock_counting(gateway_addr, shape, requests.clone()).await);
    let port = free_port();
    homes.agent_config(&format!("http://{gateway_addr}"), port, true);
    homes.add_bot("other");
    let proc = spawn(
        {
            let mut c = homes.command(&binary("autobot"));
            c.arg("serve").current_dir(&homes.home).env("RUST_LOG", "info");
            c
        },
        &dir.join("agent.log"),
    );
    let pid = proc.pid();
    let agent = format!("http://127.0.0.1:{port}");
    wait_healthy(&format!("{agent}/healthz"), Duration::from_secs(20)).await;
    let client = reqwest::Client::new();

    let started = Instant::now();
    let stop = Arc::new(AtomicBool::new(false));
    let (sent, answered, retried) =
        (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let lost = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    // Four people, each talking to both bots, a message whenever the last was answered: a turn that failed is sent again until it is answered (at most a minute).
    let mut people = Vec::new();
    for person in 0..4 {
        let (client, agent, stop) = (client.clone(), agent.clone(), stop.clone());
        let (sent, answered, retried, lost) = (sent.clone(), answered.clone(), retried.clone(), lost.clone());
        people.push(tokio::spawn(async move {
            let mut n = 0u64;
            while !stop.load(Ordering::Relaxed) {
                n += 1;
                let bot = if n.is_multiple_of(2) { Some("other") } else { None };
                // A conversation lasts 40 messages, then the next starts (old ones are let go).
                let session = format!("p{person}-{}", n / 40);
                let text = format!("message {n} from {person}");
                sent.fetch_add(1, Ordering::Relaxed);
                let until = Instant::now() + Duration::from_secs(60);
                loop {
                    match api_turn(&client, &agent, &session, bot, &text).await {
                        Ok(last)
                            if last["type"] == "answer" && last["text"].as_str().is_some_and(|t| t.contains("tok")) =>
                        {
                            answered.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        other if Instant::now() > until => {
                            lost.lock().unwrap().push(format!("{session} {text}: {other:?}"));
                            break;
                        }
                        _ => {
                            retried.fetch_add(1, Ordering::Relaxed);
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                    }
                }
            }
        }));
    }

    // Warm: after the first restart has come and gone.
    let warm_at = (total / 3).max(restart_every + Duration::from_secs(10)).min(total / 2);
    let mut warm: Option<Held> = None;
    let mut peak = None::<Held>;
    let mut next_restart = started + restart_every;
    let mut restarts = 0;
    while started.elapsed() < total {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if Instant::now() >= next_restart {
            // The gateway goes away for two seconds (an upgrade, a crash) and comes back.
            if let Some(g) = gateway.take() {
                g.stop().await;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            gateway = Some(mock_counting(gateway_addr, shape, requests.clone()).await);
            restarts += 1;
            next_restart = Instant::now() + restart_every;
        }
        if warm.is_none() && started.elapsed() >= warm_at {
            let now = held(&client, &agent, pid).await;
            println!("warm: {now:?}");
            warm = Some(now);
        }
        if started.elapsed().as_secs().is_multiple_of(10) {
            let now = held(&client, &agent, pid).await;
            println!(
                "{:>4}s {now:?} sent {} answered {} retried {}",
                started.elapsed().as_secs(),
                sent.load(Ordering::Relaxed),
                answered.load(Ordering::Relaxed),
                retried.load(Ordering::Relaxed)
            );
            peak = Some(match peak {
                Some(p) => Held {
                    rss_kib: p.rss_kib.max(now.rss_kib),
                    fds: p.fds.max(now.fds),
                    tasks: p.tasks.max(now.tasks),
                    threads: p.threads.max(now.threads),
                },
                None => now,
            });
        }
    }
    stop.store(true, Ordering::Relaxed);
    for person in people {
        person.await.unwrap();
    }
    // Quiet again: what is left once the traffic has stopped.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let end = held(&client, &agent, pid).await;
    let warm = warm.expect("a warm sample");
    let (sent, answered) = (sent.load(Ordering::Relaxed), answered.load(Ordering::Relaxed));
    println!("end: {end:?}; {sent} sent, {answered} answered, {restarts} gateway restarts, peak {peak:?}");
    report("soak.messages", sent as f64, "messages");
    report("soak.rss_warm", warm.rss_kib as f64 / 1024.0, "MiB");
    report("soak.rss_end", end.rss_kib as f64 / 1024.0, "MiB");
    report("soak.fds_warm", warm.fds as f64, "fds");
    report("soak.fds_end", end.fds as f64, "fds");
    report("soak.tasks_warm", warm.tasks as f64, "tasks");
    report("soak.tasks_end", end.tasks as f64, "tasks");

    let lost = lost.lock().unwrap().clone();
    assert!(lost.is_empty(), "{} replies lost: {:?}", lost.len(), &lost[..lost.len().min(5)]);
    assert_eq!(sent, answered, "every message answered");
    assert!(restarts >= 1 || total < restart_every, "the gateway was restarted");
    assert!(sent > 50, "steady traffic: only {sent} messages");
    // No growth once warm: memory within a quarter (and 8 MiB) of where it was, the rest about
    // where they were (a pooled connection or two may come and go).
    assert!(
        end.rss_kib <= warm.rss_kib + (warm.rss_kib / 4).max(8 * 1024),
        "memory grew: {} KiB warm, {} KiB at the end",
        warm.rss_kib,
        end.rss_kib
    );
    assert!(end.fds <= warm.fds + 8, "file descriptors grew: {} warm, {} at the end", warm.fds, end.fds);
    assert!(end.tasks <= warm.tasks + 4, "tasks grew: {} warm, {} at the end", warm.tasks, end.tasks);
    assert!(end.threads <= warm.threads + 4, "threads grew: {} warm, {} at the end", warm.threads, end.threads);
    drop(proc);
    if let Some(g) = gateway {
        g.stop().await;
    }
}
