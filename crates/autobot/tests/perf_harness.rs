//! Benchmarks of the agent harness itself, against a scripted model that answers at once, so the
//! numbers are the harness's own and the same every run. Ignored by default: `bench/run.sh`
//! runs them (or `cargo test --release -p autobot --test perf_harness -- --ignored --nocapture
//! --test-threads 1`). Each prints `BENCH <name> <value> <unit>` lines.
//!
//! - `harness.first_request_*`: from a turn's start to its first request at the model (the
//!   system prompt, the tools, the window, compaction checks, the request's serialization).
//! - `harness.step_*`: from a model's answer to the next request (the tool call parsed, run and
//!   kept, the next prompt built), with a tool that does nothing slow (`todo`).
//! - `harness.reprefill_*`: what a model with a prompt cache (llama.cpp's, a provider's) has to
//!   read again per step of a long tool-heavy turn: the request's bytes after where it first
//!   differs from the request before. And the largest request of that turn, against its budget.
//! - `session.*`: opening, appending to and windowing long conversations, and their memory.

mod scripted;
mod support;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use autobot::config::ApprovalMode;
use autobot::session::Session;
use scripted::*;
use serde_json::json;
use support::{quantile_ms, report};

/// A home and working directory as a used agent has them: a git repository with AGENTS.md, 30
/// skills, 60 remembered facts and a profile.
fn lived_in(dir: &std::path::Path) {
    let work = dir.join("work");
    std::fs::create_dir_all(work.join(".git")).unwrap();
    std::fs::write(work.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(work.join("AGENTS.md"), "# Agents\n\nRun `cargo test` before you finish.\n".repeat(40)).unwrap();
    let home = dir.join("home");
    for i in 0..30 {
        let skill = home.join("skills").join(format!("skill-{i}"));
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            format!(
                "---\nname: skill-{i}\ndescription: How to do task {i} on this machine\n---\n\n{}",
                "step\n".repeat(200)
            ),
        )
        .unwrap();
    }
    let memory = autobot::memory::Memory::new(&home);
    for i in 0..60 {
        memory.add(&format!("fact number {i} about the owner's machine and projects")).unwrap();
    }
    std::fs::write(home.join("USER.md"), "- prefers short answers\n- uses fish\n".repeat(10)).unwrap();
}

/// A conversation [n] messages long (turns of a request, a tool call, its result and an
/// answer), with a summary of all but its last 40 messages, as compaction leaves one.
fn long_session(dir: &std::path::Path, id: &str, n: usize) -> Session {
    let mut text = String::new();
    let mut i = 0;
    while i < n {
        for m in [
            json!({ "role": "user", "content": format!("request {i}: look at the logs and tell me what failed") }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": format!("c{i}"), "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"log.txt\"}" } }] }),
            json!({ "role": "tool", "tool_call_id": format!("c{i}"), "content": "line of a log\n".repeat(30) }),
            json!({ "role": "assistant", "content": "The build failed in step 3 because the cache was stale; I cleared it." }),
        ] {
            text.push_str(&m.to_string());
            text.push('\n');
            i += 1;
        }
    }
    let upto = n.saturating_sub(40);
    text.push_str(&json!({ "role": "system", "autobot": "summary", "upto": upto, "content": "The owner asked about failed builds; all were stale caches." }).to_string());
    text.push('\n');
    let sessions = dir.join("home/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join(format!("{id}.jsonl")), text).unwrap();
    Session::open(&sessions, id).unwrap()
}

fn micros(samples: &mut [Duration], q: f64) -> f64 {
    quantile_ms(samples, q) * 1000.0
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "benchmark: bench/run.sh"]
async fn harness_prompt_and_step_overhead() {
    const STEPS: usize = 8;
    let model = model(|_, body| {
        if !body["tools"].is_array() {
            return say("A summary of the earlier work.");
        }
        let done = results_this_turn(body);
        if done < STEPS {
            call(
                &format!("t{done}"),
                "todo",
                json!({ "items": [{ "text": format!("step {done}"), "status": "doing" }] }),
            )
        } else {
            say("done")
        }
    })
    .await;
    for (label, messages) in [("fresh", 0), ("long", 5000)] {
        let dir = dir(&format!("overhead-{label}"));
        lived_in(&dir);
        let agent = agent(&model.url, &dir, ApprovalMode::Ask);
        let mut session = if messages == 0 {
            Session::open(&dir.join("home/sessions"), "s").unwrap()
        } else {
            long_session(&dir, "s", messages)
        };
        let owner = Owner::new(autobot::approval::Answer::Once);
        let (mut first, mut steps) = (Vec::new(), Vec::new());
        for turn in 0..30 {
            let before = model.count();
            let started = Instant::now();
            agent.turn(&mut session, &format!("turn {turn}"), &owner, &mut HashSet::new(), &quiet).await.unwrap();
            let seen = model.requests();
            let this: Vec<_> = seen[before..].iter().filter(|s| s.body["tools"].is_array()).collect();
            assert_eq!(this.len(), STEPS + 1);
            if turn >= 5 {
                first.push(this[0].at - started);
                for pair in this.windows(2) {
                    steps.push(pair[1].at - pair[0].answered.unwrap());
                }
            }
        }
        if messages == 0 {
            let mut prompts = Vec::new();
            let mut tools = Vec::new();
            for _ in 0..100 {
                let started = Instant::now();
                assert!(!agent.system_prompt().is_empty());
                prompts.push(started.elapsed());
                let started = Instant::now();
                assert!(agent.tools.definitions().is_array());
                tools.push(started.elapsed());
            }
            report("harness.system_prompt_p50", micros(&mut prompts, 0.5), "us");
            report("harness.tool_definitions_p50", micros(&mut tools, 0.5), "us");
        }
        report(&format!("harness.first_request_{label}_p50"), micros(&mut first, 0.5), "us");
        report(&format!("harness.step_{label}_p50"), micros(&mut steps, 0.5), "us");
        report(&format!("harness.step_{label}_p90"), micros(&mut steps, 0.9), "us");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// A long coding turn on a model with a 32k context (a 64 KiB budget): 40 steps, each reading
/// a different 6 KiB file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "benchmark: bench/run.sh"]
async fn harness_prompt_cache_reuse_in_a_long_turn() {
    const STEPS: usize = 40;
    let model = model(|_, body| {
        if !body["tools"].is_array() {
            return say("A summary of the earlier work.");
        }
        let done = results_this_turn(body);
        if done < STEPS {
            call(&format!("r{done}"), "read_file", json!({ "path": format!("src/f{done}.rs") }))
        } else {
            say("read them all")
        }
    })
    .await;
    let dir = dir("reprefill");
    lived_in(&dir);
    std::fs::create_dir_all(dir.join("work/src")).unwrap();
    for i in 0..STEPS {
        std::fs::write(dir.join(format!("work/src/f{i}.rs")), format!("// file {i}\n{}", "let x = 1;\n".repeat(560)))
            .unwrap();
    }
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.max_steps = 100;
    agent.options.context_kib = Some(64);
    // Earlier turns first, so the conversation is long before this one.
    let mut session = long_session(&dir, "s", 400);
    let owner = Owner::new(autobot::approval::Answer::Once);
    agent.turn(&mut session, "read every file in src", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    let seen = model.requests();
    let wire: Vec<String> =
        seen.iter().filter(|s| s.body["tools"].is_array()).map(|s| s.body["messages"].to_string()).collect();
    let mut again = Vec::new();
    for pair in wire.windows(2) {
        let common = pair[0].bytes().zip(pair[1].bytes()).take_while(|(a, b)| a == b).count();
        again.push((pair[1].len() - common) as f64);
    }
    if std::env::var_os("BENCH_VERBOSE").is_some() {
        eprintln!("{:?}", again.iter().map(|a| (*a / 1024.0) as u64).collect::<Vec<_>>());
    }
    let mean = again.iter().sum::<f64>() / again.len() as f64;
    report("harness.reprefill_kib_per_step", mean / 1024.0, "KiB");
    report("harness.reprefill_kib_total", again.iter().sum::<f64>() / 1024.0, "KiB");
    let peak = seen.iter().map(|s| s.bytes).max().unwrap_or(0);
    report("harness.long_turn_peak_request_kib", peak as f64 / 1024.0, "KiB");
    report("harness.long_turn_model_calls", seen.len() as f64, "calls");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "benchmark: bench/run.sh"]
async fn session_open_push_window_memory() {
    let dir = dir("sessions");
    for n in [1_000, 10_000] {
        long_session(&dir, &format!("s{n}"), n);
        let mut opens = Vec::new();
        for _ in 0..10 {
            let started = Instant::now();
            let s = Session::open(&dir.join("home/sessions"), &format!("s{n}")).unwrap();
            opens.push(started.elapsed());
            assert!(s.messages.len() > n);
        }
        report(&format!("session.open_{n}_p50"), quantile_ms(&mut opens, 0.5), "ms");
    }
    let mut s = Session::open(&dir.join("home/sessions"), "s10000").unwrap();
    let mut windows = Vec::new();
    for _ in 0..50 {
        let started = Instant::now();
        let w = s.window();
        let _ = s.summary();
        let _ = s.compaction();
        windows.push(started.elapsed());
        assert!(!w.is_empty());
    }
    report("session.window_10000_p50", micros(&mut windows, 0.5), "us");
    let mut pushes = Vec::new();
    for i in 0..200 {
        let started = Instant::now();
        s.push(json!({ "role": "assistant", "content": format!("more {i}") })).unwrap();
        pushes.push(started.elapsed());
    }
    report("session.push_at_10000_p50", micros(&mut pushes, 0.5), "us");
    drop(s);
    // What 20 long conversations held open at once take (a server with many chats): live heap
    // where the system says (macOS), else resident memory.
    let pid = std::process::id();
    let memory = || support::live_heap_kib(pid).unwrap_or_else(|| support::rss_kib(pid));
    let before = memory();
    let held: Vec<Session> = (0..20).map(|_| Session::open(&dir.join("home/sessions"), "s10000").unwrap()).collect();
    let after = memory();
    let bytes: u64 = std::fs::metadata(dir.join("home/sessions/s10000.jsonl")).unwrap().len();
    report("session.memory_per_10000_session", (after.saturating_sub(before)) as f64 / 1024.0 / 20.0, "MiB");
    report("session.file_10000", bytes as f64 / 1048576.0, "MiB");
    drop(held);
    let _ = std::fs::remove_dir_all(&dir);
}
