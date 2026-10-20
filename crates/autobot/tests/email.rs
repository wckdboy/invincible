//! Email against a stand-in IMAP server (with IDLE) and a stand-in SMTP server, and a stand-in
//! model gateway: an allowed sender's mail runs a task, its command is approved by a reply that
//! carries the question's code, the answer comes back in the thread, quoting the mail; strangers,
//! forged senders and auto-replies get nothing.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::bots::Runtime;
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Default)]
struct Mailbox {
    /// (uid, message, seen)
    messages: Vec<(u32, Vec<u8>, bool)>,
    /// What the SMTP server was given: (recipient, message).
    sent: Vec<(String, String)>,
    logins: Vec<String>,
}

type Shared = Arc<Mutex<Mailbox>>;

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// IMAP, as much as the bot uses: LOGIN, CAPABILITY, SELECT, UID SEARCH/FETCH/STORE, IDLE, NOOP.
async fn imap(mailbox: Shared, new_mail: Arc<tokio::sync::Notify>) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (mailbox, new_mail) = (mailbox.clone(), new_mail.clone());
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut read = BufReader::new(read);
                write.write_all(b"* OK fake IMAP ready\r\n").await.unwrap();
                loop {
                    let mut line = String::new();
                    if read.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let (tag, command) = line.trim_end().split_once(' ').unwrap();
                    let upper = command.to_ascii_uppercase();
                    let reply = if upper.starts_with("LOGIN") {
                        mailbox.lock().unwrap().logins.push(command[6..].to_owned());
                        format!("{tag} OK logged in\r\n")
                    } else if upper.starts_with("CAPABILITY") {
                        format!("* CAPABILITY IMAP4rev1 IDLE\r\n{tag} OK\r\n")
                    } else if upper.starts_with("SELECT") {
                        let n = mailbox.lock().unwrap().messages.len();
                        format!("* {n} EXISTS\r\n{tag} OK [READ-WRITE]\r\n")
                    } else if upper.starts_with("UID SEARCH UNSEEN") {
                        let uids: Vec<String> = mailbox
                            .lock()
                            .unwrap()
                            .messages
                            .iter()
                            .filter(|(_, _, seen)| !seen)
                            .map(|(uid, _, _)| uid.to_string())
                            .collect();
                        format!("* SEARCH {}\r\n{tag} OK\r\n", uids.join(" "))
                    } else if upper.starts_with("UID FETCH") {
                        let uid: u32 = command.split_whitespace().nth(2).unwrap().parse().unwrap();
                        let raw = mailbox.lock().unwrap().messages.iter().find(|m| m.0 == uid).unwrap().1.clone();
                        let mut out = format!("* {uid} FETCH (UID {uid} BODY[] {{{}}}\r\n", raw.len()).into_bytes();
                        out.extend_from_slice(&raw);
                        out.extend_from_slice(format!(")\r\n{tag} OK\r\n").as_bytes());
                        write.write_all(&out).await.unwrap();
                        continue;
                    } else if upper.starts_with("UID STORE") {
                        let uid: u32 = command.split_whitespace().nth(2).unwrap().parse().unwrap();
                        if let Some(m) = mailbox.lock().unwrap().messages.iter_mut().find(|m| m.0 == uid) {
                            m.2 = true;
                        }
                        format!("{tag} OK\r\n")
                    } else if upper.starts_with("IDLE") {
                        write.write_all(b"+ idling\r\n").await.unwrap();
                        let mut done = String::new();
                        tokio::select! {
                            () = new_mail.notified() => {
                                let n = mailbox.lock().unwrap().messages.len();
                                write.write_all(format!("* {n} EXISTS\r\n").as_bytes()).await.unwrap();
                                read.read_line(&mut done).await.unwrap();
                            }
                            _ = read.read_line(&mut done) => {}
                        }
                        assert_eq!(done.trim(), "DONE");
                        format!("{tag} OK IDLE done\r\n")
                    } else if upper.starts_with("LOGOUT") {
                        write.write_all(format!("* BYE\r\n{tag} OK\r\n").as_bytes()).await.unwrap();
                        return;
                    } else {
                        format!("{tag} OK\r\n")
                    };
                    write.write_all(reply.as_bytes()).await.unwrap();
                }
            });
        }
    });
    port
}

/// SMTP: EHLO, AUTH PLAIN, MAIL, RCPT, DATA (dots undone), QUIT.
async fn smtp(mailbox: Shared) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mailbox = mailbox.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut read = BufReader::new(read);
                write.write_all(b"220 fake SMTP\r\n").await.unwrap();
                let mut to = String::new();
                loop {
                    let mut line = String::new();
                    if read.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let upper = line.to_ascii_uppercase();
                    let reply = if upper.starts_with("EHLO") {
                        "250-fake\r\n250 AUTH PLAIN\r\n".to_owned()
                    } else if upper.starts_with("AUTH PLAIN") {
                        "235 ok\r\n".to_owned()
                    } else if upper.starts_with("MAIL FROM") {
                        "250 ok\r\n".to_owned()
                    } else if upper.starts_with("RCPT TO") {
                        to = line.trim()[9..].trim_matches(['<', '>']).to_owned();
                        "250 ok\r\n".to_owned()
                    } else if upper.starts_with("DATA") {
                        write.write_all(b"354 go\r\n").await.unwrap();
                        let mut message = String::new();
                        loop {
                            let mut l = String::new();
                            read.read_line(&mut l).await.unwrap();
                            if l == ".\r\n" {
                                break;
                            }
                            message.push_str(l.strip_prefix('.').unwrap_or(&l));
                        }
                        mailbox.lock().unwrap().sent.push((to.clone(), message));
                        "250 queued\r\n".to_owned()
                    } else if upper.starts_with("QUIT") {
                        write.write_all(b"221 bye\r\n").await.unwrap();
                        return;
                    } else {
                        "500 what\r\n".to_owned()
                    };
                    write.write_all(reply.as_bytes()).await.unwrap();
                }
            });
        }
    });
    port
}

fn mail(from: &str, subject: &str, id: &str, refs: &[&str], body: &str, authenticated: bool) -> Vec<u8> {
    let mut head = vec![];
    if authenticated {
        head.push("Authentication-Results: mx.x.org; dmarc=pass; dkim=pass header.d=example.com".to_owned());
    }
    head.push(format!("From: Ann <{from}>"));
    head.push("To: bot@x.org".to_owned());
    head.push(format!("Subject: {subject}"));
    head.push(format!("Message-ID: {id}"));
    if let Some(last) = refs.last() {
        head.push(format!("In-Reply-To: {last}"));
        head.push(format!("References: {}", refs.join(" ")));
    }
    head.push("Content-Type: text/plain; charset=utf-8".to_owned());
    format!("{}\r\n\r\n{}\r\n", head.join("\r\n"), body.replace('\n', "\r\n")).into_bytes()
}

/// Waits until a sent mail matches [pred]; returns it.
async fn sent(
    mailbox: &Shared,
    pred: impl Fn(&str, &autobot::mail::Mail) -> bool,
) -> (String, autobot::mail::Mail, String) {
    for _ in 0..400 {
        let found = mailbox.lock().unwrap().sent.iter().find_map(|(to, raw)| {
            let mail = autobot::mail::parse(raw.as_bytes());
            pred(to, &mail).then(|| (to.clone(), mail, raw.clone()))
        });
        if let Some(found) = found {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never sent; sent: {:#?}", mailbox.lock().unwrap().sent);
}

#[tokio::test]
async fn a_task_by_mail_approved_by_reply() {
    let home = std::env::temp_dir().join(format!("autobot-email-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let answers = Arc::new(Mutex::new(VecDeque::from([
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "terminal", "arguments": "{\"command\":\"echo from-the-tool\"}" } }] }),
        json!({ "role": "assistant", "content": "The disk is **42%** full." }),
    ])));
    let model = listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(|State(a): State<Arc<Mutex<VecDeque<Value>>>>| async move {
                    let message = a.lock().unwrap().pop_front().unwrap();
                    (
                        [
                            ("invincible-request-id", "abcdef123456"),
                            ("invincible-decision", r#"{"model":"qwen","tier":"node"}"#),
                        ],
                        Json(json!({ "choices": [{ "message": message }] })),
                    )
                }),
            )
            .with_state(answers),
    )
    .await;
    let mailbox: Shared = Arc::default();
    let new_mail = Arc::new(tokio::sync::Notify::new());
    let deliver = |raw: Vec<u8>| {
        let mut m = mailbox.lock().unwrap();
        let uid = m.messages.len() as u32 + 1;
        m.messages.push((uid, raw, false));
        drop(m);
        new_mail.notify_one();
    };
    // Waiting before it starts: a stranger, a forged sender, an auto-reply, and the owner.
    deliver(mail("eve@evil.org", "hi", "<s1@evil.org>", &[], "let me in", true));
    deliver(mail("ann@example.com", "forged", "<f1@evil.org>", &[], "rm everything", false));
    let mut auto = mail("ann@example.com", "Out of office", "<o1@example.com>", &[], "away", true);
    auto.splice(0..0, b"Auto-Submitted: auto-replied\r\n".iter().copied());
    deliver(auto);
    deliver(mail("ann@example.com", "Disk check", "<m1@example.com>", &[], "How full is the disk?", true));

    let imap_port = imap(mailbox.clone(), new_mail.clone()).await;
    let smtp_port = smtp(mailbox.clone()).await;
    let agent = Arc::new(Agent {
        gateway: Gateway::new(&format!("{model}/v1"), "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    });
    let runtime = Runtime::standalone("autobot", &home, agent);
    let config = autobot::email::EmailConfig {
        enabled: true,
        address: "bot@x.org".into(),
        imap: format!("127.0.0.1:{imap_port}"),
        smtp: format!("127.0.0.1:{smtp_port}"),
        allow: vec!["Ann@Example.com".into()],
        ..Default::default()
    };
    tokio::spawn(autobot::email::serve(
        runtime.clone(),
        config,
        "secret pw".into(),
        invincible_policy::NetworkMode::Offline,
    ));

    // The approval: a mail of its own in the thread, with a code in the subject.
    let (to, question, _) = sent(&mailbox, |_, m| m.subject.starts_with("Approve?")).await;
    assert_eq!(to, "ann@example.com");
    assert!(question.subject.contains("run: echo from-the-tool"), "{}", question.subject);
    assert_eq!(question.in_reply_to.as_deref(), Some("<m1@example.com>"));
    let code = question.subject.rsplit('[').next().unwrap().trim_end_matches(']').to_owned();
    assert_eq!(code.len(), 4);

    // "yes" without the code is not an answer by mail; with it in the subject, it is.
    let question_id = question.message_id.clone().unwrap();
    deliver(mail(
        "ann@example.com",
        &format!("Re: {}", question.subject),
        "<m2@example.com>",
        &["<m1@example.com>", &question_id],
        &format!("yes\n\nOn Mon, Autobot <bot@x.org> wrote:\n> {}", question.text.lines().next().unwrap()),
        true,
    ));
    let (_, allowed, _) = sent(&mailbox, |_, m| m.text.starts_with("→ Allowed")).await;
    assert_eq!(allowed.references.first().map(String::as_str), Some("<m1@example.com>"));

    // The answer: in the thread, in plain text, quoting the mail it answers.
    let (to, answer, raw) = sent(&mailbox, |_, m| m.text.starts_with("The disk is")).await;
    assert_eq!(to, "ann@example.com");
    assert_eq!(answer.subject, "Re: Disk check");
    assert!(answer.text.starts_with("The disk is 42% full."), "{}", answer.text);
    assert!(raw.contains("qwen · node · receipt abcdef12") || raw.contains("qwen =C2=B7 node"), "{raw}");
    assert!(answer.references.contains(&"<m1@example.com>".to_owned()));
    assert!(raw.contains("Auto-Submitted: auto-replied"));

    let m = mailbox.lock().unwrap();
    assert!(
        m.sent.iter().all(|(to, _)| to == "ann@example.com"),
        "nothing to the stranger, the forger or the auto-reply"
    );
    assert_eq!(m.sent.len(), 3, "{:#?}", m.sent);
    assert!(m.messages.iter().all(|(_, _, seen)| *seen), "every mail was read");
    assert_eq!(m.logins[0], "\"bot@x.org\" \"secret pw\"");
    drop(m);
    std::fs::remove_dir_all(home).unwrap();
}
