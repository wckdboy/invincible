//! The agent harness under a model that misbehaves, and a world that does: malformed tool calls,
//! huge outputs, commands that hang, turns stopped mid-tool and mid-stream, a gateway that fails,
//! rate-limits or goes away, a conversation longer than the context, a model going round in
//! circles, team members that fail, many conversations at once, and crashes mid-write. Each was
//! a failure once (or would have been); each is a scripted scenario here.

mod scripted;

use std::time::{Duration, Instant};

use autobot::approval::Answer;
use autobot::config::ApprovalMode;
use autobot::session::Session;
use scripted::*;
use serde_json::{Value, json};

fn sessions(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("home/sessions")
}

/// Whether process [pid] is gone (or a zombie on its way out), waiting up to two seconds.
fn gone(pid: u32) -> bool {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let stat = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if stat.is_empty() || stat.starts_with('Z') {
            return true;
        }
        if Instant::now() > until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test]
async fn malformed_tool_calls_are_read_as_meant_or_explained() {
    let model = model(|n, body| match n {
        0 => calls(&[
            // A raw line break inside a string (small models write them).
            ("a", "write_file", json!("{\"path\": \"n.txt\", \"content\": \"line one\nline two\"}")),
            // In a code fence, with a trailing comma.
            ("b", "write_file", json!("```json\n{\"path\": \"m.txt\", \"content\": \"x\",}\n```")),
            ("c", "read_file", json!("not json at all")),
            ("d", "read_file", json!({})),
            ("e", "functions.list_dir", json!({})),
            ("f", "nope_tool", json!({})),
            ("g", "list_dir", json!("null")),
        ]),
        _ => {
            let _ = body;
            say("done")
        }
    })
    .await;
    let dir = dir("malformed");
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let outcome = agent.turn(&mut session, "go", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "done");
    assert_eq!(std::fs::read_to_string(dir.join("work/n.txt")).unwrap(), "line one\nline two");
    assert_eq!(std::fs::read_to_string(dir.join("work/m.txt")).unwrap(), "x");
    let results = tool_results(&model.requests()[1].body);
    assert_eq!(results.len(), 7);
    assert!(
        results[2].contains("the arguments are not JSON") && results[2].contains("read_file takes path (required)"),
        "{}",
        results[2]
    );
    assert!(results[3].contains("`path` is missing; read_file takes path (required)"), "{}", results[3]);
    assert!(results[4].contains("n.txt"), "functions.list_dir is list_dir: {}", results[4]);
    assert!(results[5].contains("there is no tool named \"nope_tool\"; the tools are: terminal"), "{}", results[5]);
    assert!(results[6].contains("m.txt"), "{}", results[6]);
    assert_consistent(&session.messages);
}

#[tokio::test]
async fn a_command_that_prints_gigabytes_is_cut_without_holding_it_all() {
    let model = model(|n, _| match n {
        0 => {
            call("c", "terminal", json!({ "command": "yes 0123456789abcdef | head -c 200000000; echo; echo the end" }))
        }
        _ => say("ok"),
    })
    .await;
    let dir = dir("huge");
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.tools = autobot::tools::Tools::new(dir.join("work"), Duration::from_secs(60)).with_home(dir.join("home"));
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let started = Instant::now();
    agent.turn(&mut session, "go", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    let result = last_result(&model.requests()[1].body);
    assert!(result.len() < 20 * 1024, "{} bytes", result.len());
    assert!(result.contains("bytes cut"), "{}", &result[..200]);
    assert!(result.ends_with("the end\n[exit code 0]"), "{}", &result[result.len() - 100..]);
    assert!(result.starts_with("0123456789abcdef"));
    assert!(started.elapsed() < Duration::from_secs(30));
}

#[tokio::test]
async fn a_hung_command_is_stopped_with_what_it_printed_and_what_it_started() {
    let model = model(|n, _| match n {
        0 => call("c", "terminal", json!({ "command": "sleep 300 & echo $! > child.pid; echo started; sleep 300" })),
        1 => call("d", "terminal", json!({ "command": "sleep 300 > /dev/null 2>&1 & echo done" })),
        _ => say("ok"),
    })
    .await;
    let dir = dir("hung");
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.tools = autobot::tools::Tools::new(dir.join("work"), Duration::from_secs(1)).with_home(dir.join("home"));
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let started = Instant::now();
    agent.turn(&mut session, "go", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    let requests = model.requests();
    let hung = last_result(&requests[1].body);
    assert!(hung.starts_with("started\n[stopped after 1 seconds"), "{hung}");
    let child: u32 = std::fs::read_to_string(dir.join("work/child.pid")).unwrap().trim().parse().unwrap();
    assert!(gone(child), "what the command started in the background is stopped with it");
    // Done, though what it started keeps running (and is left to run): no wait for it.
    let done = last_result(&requests[2].body);
    assert_eq!(done, "done\n[exit code 0]");
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}

#[tokio::test]
async fn a_turn_stopped_mid_tool_stops_the_tool_and_the_conversation_goes_on() {
    let model = model(|n, body| match n {
        0 => call("c1", "terminal", json!({ "command": "sleep 300 & echo $! > child.pid; sleep 300" })),
        _ => {
            assert_consistent(body["messages"].as_array().unwrap());
            say("ok")
        }
    })
    .await;
    let dir = dir("cancel-tool");
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let owner = Owner::new(Answer::Once);
    // Stopped once the command runs (what it started is on disk).
    let started = async {
        while !dir.join("work/child.pid").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let mut granted = grants();
    tokio::select! {
        _ = agent.turn(&mut session, "go", &owner, &mut granted, &quiet) => panic!("the turn ended by itself"),
        () = started => {}
    }
    let child: u32 = std::fs::read_to_string(dir.join("work/child.pid")).unwrap().trim().parse().unwrap();
    assert!(gone(child), "what the tool started is stopped with the turn");
    // From disk, as after a restart: the call gets its answer, and the next turn goes.
    let mut again = Session::open(&sessions(&dir), "s").unwrap();
    assert_eq!(again.messages.len(), 2);
    let outcome = agent.turn(&mut again, "and now?", &owner, &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "ok");
    assert_consistent(&again.messages);
    let reloaded = Session::open(&sessions(&dir), "s").unwrap();
    assert_eq!(reloaded.messages, again.messages, "nothing lost or doubled on disk");
}

#[tokio::test]
async fn a_turn_stopped_mid_stream_keeps_no_half_answer() {
    let model = model(|n, _| match n {
        0 => Reply::StreamThenStall(
            vec![json!({ "choices": [{ "index": 0, "delta": { "content": "half an ans" } }] })],
            Duration::from_secs(30),
        ),
        _ => streamed(&["all ", "of it"]),
    })
    .await;
    let dir = dir("cancel-stream");
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.gateway = agent.gateway.with_stream(true);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let owner = Owner::new(Answer::Once);
    let stopped =
        tokio::time::timeout(Duration::from_millis(300), agent.turn(&mut session, "go", &owner, &mut grants(), &quiet))
            .await;
    assert!(stopped.is_err());
    assert_eq!(session.messages.len(), 1, "only the request: {:?}", session.messages);
    let outcome = agent.turn(&mut session, "again", &owner, &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "all of it");
    assert_eq!(Session::open(&sessions(&dir), "s").unwrap().messages, session.messages);
}

#[tokio::test]
async fn overloads_and_rate_limits_are_tried_again_and_real_errors_are_not() {
    let model = model(|n, _| match n {
        0 => error(503, "overloaded"),
        1 => Reply::Json(429, json!({ "error": { "message": "slow down" } }), vec![("retry-after", "0".into())]),
        2 => say("answered"),
        3 => error(400, "bad request: unknown field"),
        _ => say("unexpected"),
    })
    .await;
    let dir = dir("retry");
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let owner = Owner::new(Answer::Once);
    let outcome = agent.turn(&mut session, "one", &owner, &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "answered");
    assert_eq!(outcome.receipts, vec!["req3"]);
    let e = agent.turn(&mut session, "two", &owner, &mut grants(), &quiet).await.err().unwrap();
    assert!(e.contains("400") && e.contains("unknown field"), "{e}");
    assert_eq!(model.count(), 4, "a 400 is not tried again");
    // Three tries more at most, then the error.
    let always = scripted::model(|_, _| error(502, "bad gateway")).await;
    let agent = scripted::agent(&always.url, &dir, ApprovalMode::Ask);
    let e = agent.turn(&mut session, "three", &owner, &mut grants(), &quiet).await.err().unwrap();
    assert!(e.contains("502"), "{e}");
    assert_eq!(always.count(), 4);
}

#[tokio::test]
async fn a_gateway_that_comes_up_late_still_gets_the_turn() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let dir = dir("late");
    let mut agent = agent(&format!("http://127.0.0.1:{port}/v1"), &dir, ApprovalMode::Ask);
    agent.gateway = agent.gateway.with_retries(6, Duration::from_millis(100));
    let late = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        model_on(port, |_, _| say("here now")).await
    });
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let outcome = agent.turn(&mut session, "hello?", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "here now");
    assert_eq!(late.await.unwrap().count(), 1);
}

#[tokio::test]
async fn a_broken_stream_is_tried_again_unless_some_was_shown_and_a_hang_ends() {
    let model = model(|n, _| match n {
        // Cut before anything came: tried again.
        0 => Reply::StreamThenStall(Vec::new(), Duration::from_millis(10)),
        1 => streamed(&["whole"]),
        // Cut after some was shown: not sent twice.
        2 => Reply::StreamThenStall(
            vec![json!({ "choices": [{ "index": 0, "delta": { "content": "hal" } }] })],
            Duration::from_millis(10),
        ),
        // Nothing at all for longer than the idle limit.
        _ => Reply::Hang(Duration::from_secs(20)),
    })
    .await;
    let dir = dir("stream-retry");
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.gateway = agent.gateway.with_stream(true).with_idle_timeout(Duration::from_millis(300));
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let owner = Owner::new(Answer::Once);
    let shown = std::sync::Mutex::new(String::new());
    let events = |e: autobot::agent::Event| {
        if let autobot::agent::Event::Text(t) = e {
            shown.lock().unwrap().push_str(t);
        }
    };
    let outcome = agent.turn(&mut session, "one", &owner, &mut grants(), &events).await.unwrap();
    assert_eq!(outcome.text, "whole");
    let e = agent.turn(&mut session, "two", &owner, &mut grants(), &events).await.err().unwrap();
    assert!(e.contains("stopped"), "{e}");
    assert_eq!(model.count(), 3);
    assert_eq!(*shown.lock().unwrap(), "wholehal", "nothing shown twice");
    let started = Instant::now();
    let e = agent.turn(&mut session, "three", &owner, &mut grants(), &events).await.err().unwrap();
    assert!(e.contains("sent nothing for 300 ms"), "{e}");
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_consistent(&session.messages);
}

#[tokio::test]
async fn a_request_too_long_for_the_model_is_made_smaller_and_sent_again() {
    // The model takes 45 000 bytes at most (whatever the agent thinks its context is).
    let model = model(|_, body| {
        if !body["tools"].is_array() {
            return say("Earlier: the owner asked about many things, all answered.");
        }
        if body.to_string().len() > 45_000 {
            return error(400, "the request exceeds the available context size, try increasing it");
        }
        say("fits")
    })
    .await;
    let dir = dir("overflow");
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.options.context_kib = Some(64);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    for i in 0..40 {
        session.push(json!({ "role": "user", "content": format!("question {i}") })).unwrap();
        session.push(json!({ "role": "assistant", "content": format!("answer {i}: {}", "x".repeat(3000)) })).unwrap();
    }
    let outcome = agent.turn(&mut session, "one more", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "fits");
    let requests = model.requests();
    let refused = requests.iter().filter(|r| r.body["tools"].is_array() && r.body.to_string().len() > 45_000).count();
    assert!((1..=3).contains(&refused), "{refused}");
    assert!(requests.iter().any(|r| !r.body["tools"].is_array()), "what left the window was summarized");
    assert!(session.summary().is_some());
    assert!(session.budget < 64 * 1024);
    assert_consistent(&session.messages);
}

#[tokio::test]
async fn a_turn_of_many_steps_stays_within_the_budget() {
    const STEPS: usize = 30;
    let model = model(|_, body| {
        let done = results_this_turn(body);
        if done < STEPS {
            call(&format!("r{done}"), "read_file", json!({ "path": format!("f{done}.txt") }))
        } else {
            say("read")
        }
    })
    .await;
    let dir = dir("long-turn");
    for i in 0..STEPS {
        std::fs::write(dir.join(format!("work/f{i}.txt")), format!("file {i}\n{}", "data ".repeat(1000))).unwrap();
    }
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.max_steps = 100;
    agent.options.context_kib = Some(32);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let outcome =
        agent.turn(&mut session, "read them", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "read");
    let requests = model.requests();
    // Without clearing, the last request would hold all 30 results (150 KiB).
    let largest = requests.iter().map(|r| r.bytes).max().unwrap();
    let base = requests[0].bytes;
    assert!(largest - base < 32 * 1024 + 32 * 1024 / 8 + 2048, "{largest} bytes ({base} at the start)");
    let last = &requests.last().unwrap().body;
    let results = tool_results(last);
    assert_eq!(results.len(), STEPS, "every call keeps its result");
    assert!(results[0].starts_with(autobot::session::CLEARED), "{}", &results[0]);
    for (i, r) in results.iter().enumerate().skip(STEPS - 3) {
        assert!(r.starts_with(&format!("file {i}\n")), "the newest are whole");
    }
    assert_consistent(last["messages"].as_array().unwrap());
    // On disk, everything is whole.
    let kept = Session::open(&sessions(&dir), "s").unwrap();
    assert!(
        kept.messages.iter().all(|m| !m["content"].as_str().is_some_and(|c| c.starts_with(autobot::session::CLEARED)))
    );
}

#[tokio::test]
async fn a_model_going_round_in_circles_is_told_then_stopped() {
    let model = model(|_, _| call("c", "list_dir", json!({ "path": "." }))).await;
    let dir = dir("circles");
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let outcome = agent.turn(&mut session, "go", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert!(outcome.text.starts_with("Stopped: the same list_dir call"), "{}", outcome.text);
    let requests = model.requests();
    assert_eq!(requests.len(), 6, "stopped long before the step budget (24)");
    assert!(!last_result(&requests[2].body).contains("exact call"));
    assert!(last_result(&requests[3].body).contains("made this exact call 3 times"));
    assert_consistent(&session.messages);
}

#[tokio::test]
async fn edits_forgive_whitespace_and_a_miss_shows_the_closest_lines() {
    let model = model(|n, _| match n {
        0 => call(
            "a",
            "edit_file",
            json!({ "path": "a.py", "old_text": "def f():\n    return 1", "new_text": "def f():\n    return 2" }),
        ),
        1 => call("b", "edit_file", json!({ "path": "a.py", "old_text": "def ff():\n    return 9", "new_text": "x" })),
        _ => say("ok"),
    })
    .await;
    let dir = dir("edits");
    std::fs::write(dir.join("work/a.py"), "def f():   \n    return 1\n\nprint(f())\n").unwrap();
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let diffs = std::sync::Mutex::new(0);
    let events = |e: autobot::agent::Event| {
        if let autobot::agent::Event::Diff(_) = e {
            *diffs.lock().unwrap() += 1;
        }
    };
    agent.turn(&mut session, "go", &Owner::new(Answer::Once), &mut grants(), &events).await.unwrap();
    let requests = model.requests();
    assert!(last_result(&requests[1].body).contains("matched ignoring spaces at line ends"));
    assert_eq!(std::fs::read_to_string(dir.join("work/a.py")).unwrap(), "def f():\n    return 2\n\nprint(f())\n");
    assert_eq!(*diffs.lock().unwrap(), 1, "the loose edit was shown before it was approved");
    let miss = last_result(&requests[2].body);
    assert!(miss.contains("the closest is at line 1") && miss.contains("    1  def f():"), "{miss}");
}

#[tokio::test]
async fn a_member_that_fails_is_reported_to_the_lead_which_carries_on() {
    let model = model(|_, body| {
        let system = body["messages"][0]["content"].as_str().unwrap_or_default();
        if system.contains("a member of Autobot's team") {
            return error(400, "the member's model fell over");
        }
        if results_this_turn(body) == 0 {
            call("d", "delegate", json!({ "agent": "coder", "goal": "Print the date" }))
        } else {
            say("The coder could not do it; here is what I know.")
        }
    })
    .await;
    let dir = dir("member");
    let mut lead = agent(&model.url, &dir, ApprovalMode::Ask);
    let roles = std::collections::BTreeMap::from([(
        "coder".to_owned(),
        autobot::team::RoleConfig {
            description: "Runs commands".into(),
            instructions: None,
            tools: vec!["terminal".into()],
            model: None,
            telegram_token_file: None,
        },
    )]);
    lead.team = std::sync::Arc::new(autobot::team::Team::from_config(&roles, &Default::default()).unwrap());
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let outcome = lead.turn(&mut session, "date?", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert!(outcome.text.starts_with("The coder could not do it"));
    let result = last_result(&model.requests().last().unwrap().body);
    assert!(result.contains("coder could not finish") && result.contains("fell over"), "{result}");
    assert_consistent(&session.messages);
}

#[tokio::test]
async fn a_denied_command_does_not_run_and_asking_again_and_again_ends() {
    let model = model(|_, _| call("c", "terminal", json!({ "command": "touch nope" }))).await;
    let dir = dir("denied");
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let owner = Owner::new(Answer::Deny);
    let outcome = agent.turn(&mut session, "go", &owner, &mut grants(), &quiet).await.unwrap();
    assert!(!dir.join("work/nope").exists());
    assert!(last_result(&model.requests()[1].body).starts_with("refused: the owner did not approve"));
    assert!(outcome.text.starts_with("Stopped: the same terminal call"), "{}", outcome.text);
    assert_eq!(owner.asked.lock().unwrap().len(), 6);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_conversations_at_once_keep_to_themselves() {
    let model = model(|_, body| {
        let done = results_this_turn(body);
        let who = body["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "user").unwrap()["content"]
            .as_str()
            .unwrap()
            .to_owned();
        if done < 3 {
            call(&format!("{who}-{done}"), "todo", json!({ "items": [{ "text": format!("{who} step {done}") }] }))
        } else {
            say(&format!("done {who}"))
        }
    })
    .await;
    let dir = dir("concurrent");
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let owner = Owner::new(Answer::Once);
    let runs = (0..16).map(|i| {
        let (agent, owner, dir) = (&agent, &owner, &dir);
        async move {
            let mut session = Session::open(&sessions(dir), &format!("c{i}")).unwrap();
            let outcome = agent.turn(&mut session, &format!("w{i}"), owner, &mut grants(), &quiet).await.unwrap();
            (i, outcome.text)
        }
    });
    for (i, text) in futures_util::future::join_all(runs).await {
        assert_eq!(text, format!("done w{i}"));
        let kept = Session::open(&sessions(&dir), &format!("c{i}")).unwrap();
        assert_eq!(kept.messages.len(), 8, "{:?}", kept.messages);
        assert_consistent(&kept.messages);
        for m in &kept.messages[1..] {
            let text = m.to_string();
            assert!(text.contains(&format!("w{i}")) || m["role"] == "assistant" && m["tool_calls"].is_null(), "{text}");
        }
    }
    assert_eq!(model.count(), 16 * 4);
}

#[test]
fn a_line_torn_by_a_crash_does_not_take_the_next_one_with_it() {
    let dir = dir("torn");
    let path = sessions(&dir);
    std::fs::create_dir_all(&path).unwrap();
    let mut bytes = Vec::new();
    bytes
        .extend_from_slice(b"{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"assistant\",\"content\":\"hello\"}\n");
    // Cut inside a character, mid-line.
    bytes.extend_from_slice(b"{\"role\":\"user\",\"content\":\"caf\xc3");
    std::fs::write(path.join("t.jsonl"), &bytes).unwrap();
    let mut session = Session::open(&path, "t").unwrap();
    assert_eq!(session.messages.len(), 2);
    session.push(json!({ "role": "user", "content": "after the crash" })).unwrap();
    session.push(json!({ "role": "assistant", "content": "still here" })).unwrap();
    let again = Session::open(&path, "t").unwrap();
    assert_eq!(again.messages.len(), 4, "{:?}", again.messages);
    assert_eq!(again.messages[2]["content"], "after the crash");
}

#[tokio::test]
async fn a_crash_between_a_call_and_its_results_is_answered_on_the_next_turn() {
    let model = model(|_, body| {
        assert_consistent(body["messages"].as_array().unwrap());
        say("carried on")
    })
    .await;
    let dir = dir("crash");
    let path = sessions(&dir);
    std::fs::create_dir_all(&path).unwrap();
    let lines: Vec<Value> = vec![
        json!({ "role": "user", "content": "do two things" }),
        json!({ "role": "assistant", "content": "", "tool_calls": [
            { "id": "c1", "type": "function", "function": { "name": "list_dir", "arguments": "{}" } },
            { "id": "c2", "type": "function", "function": { "name": "list_dir", "arguments": "{}" } },
        ] }),
        json!({ "role": "tool", "tool_call_id": "c1", "content": "(empty)" }),
    ];
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(path.join("s.jsonl"), text).unwrap();
    let agent = agent(&model.url, &dir, ApprovalMode::Ask);
    let mut session = Session::open(&path, "s").unwrap();
    let outcome = agent.turn(&mut session, "go on", &Owner::new(Answer::Once), &mut grants(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "carried on");
    let kept = Session::open(&path, "s").unwrap();
    assert_consistent(&kept.messages);
    assert_eq!(kept.messages.iter().filter(|m| m["tool_call_id"] == "c2").count(), 1);
    assert_eq!(kept.messages.iter().filter(|m| m["tool_call_id"] == "c1").count(), 1);
}
