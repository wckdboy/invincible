//! Email: the agent reads its mailbox over IMAP (IDLE where the server has it, else every
//! `poll` seconds) and answers over SMTP, in the same thread. A thread is a conversation; a
//! reply quotes what it answers.
//!
//! - Only senders in `allow` (or approved with `autobot email approve <code>`, when `pairing`
//!   is on) are answered; everyone else is ignored, so strangers get no mail back. With `verify`
//!   (the default), a sender also has to pass the receiving server's SPF, DKIM or DMARC check
//!   (its `Authentication-Results`), since anyone can write any `From`.
//! - An approval is a mail of its own, with a one-time code in the subject: answer `yes`,
//!   `always` or `no` (or `no, <what to do instead>`) in a reply that keeps the code.
//! - Auto-replies, lists and bulk mail are never answered, and the agent's own mails are marked
//!   `Auto-Submitted`, so no two robots write to each other forever.
//! - Audio attachments (a voice memo) are transcribed ([crate::voice]); speech and pictures the
//!   agent makes are attached to its answer (up to 18 MB in all).
//! - IMAP and SMTP go under the node's network mode (Tor included), over TLS (port 993 and
//!   465), or STARTTLS (143, 587); plain only to this machine (a local bridge).
//!
//! ```toml
//! [email]
//! enabled = true
//! address = "bot@example.org"
//! imap = "imap.example.org:993"
//! smtp = "smtp.example.org:465"
//! # username = "bot@example.org"    # default: the address
//! # password in $AUTOBOT_HOME/email.password (or password_file)
//! allow = ["me@example.com"]
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::bots::Runtime;
use crate::channel::{Asking, BoxFuture, Incoming, Progress, Question, Transport};

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmailConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The bot's own address.
    #[serde(default)]
    pub address: String,
    /// `host:port` of the IMAP server.
    #[serde(default)]
    pub imap: String,
    /// `host:port` of the SMTP server.
    #[serde(default)]
    pub smtp: String,
    /// The login [default: the address].
    #[serde(default)]
    pub username: Option<String>,
    /// [default: `$AUTOBOT_HOME/email.password`]
    #[serde(default)]
    pub password_file: Option<PathBuf>,
    #[serde(default = "inbox")]
    pub folder: String,
    /// Seconds between checks when the server has no IDLE.
    #[serde(default = "poll")]
    pub poll: u64,
    /// Senders answered without pairing.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Strangers get a pairing code by mail (off: they are ignored).
    #[serde(default)]
    pub pairing: bool,
    /// Senders must pass SPF, DKIM or DMARC at the receiving server.
    #[serde(default = "yes")]
    pub verify: bool,
}

fn inbox() -> String {
    "INBOX".to_owned()
}

fn poll() -> u64 {
    60
}

fn yes() -> bool {
    true
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            address: String::new(),
            imap: String::new(),
            smtp: String::new(),
            username: None,
            password_file: None,
            folder: inbox(),
            poll: poll(),
            allow: Vec::new(),
            pairing: false,
            verify: true,
        }
    }
}

impl EmailConfig {
    pub fn password(&self, home: &Path) -> Result<String, String> {
        let path =
            self.password_file.as_deref().map(crate::config::expand).unwrap_or_else(|| home.join("email.password"));
        let path = if path.is_absolute() { path } else { home.join(path) };
        let text = std::fs::read_to_string(&path).map_err(|e| format!("the mail password {}: {e}", path.display()))?;
        Ok(text.trim_end_matches(['\r', '\n']).to_owned())
    }

    pub fn username(&self) -> String {
        self.username.clone().unwrap_or_else(|| self.address.clone())
    }

    fn check(&self) -> Result<(), String> {
        if !self.address.contains('@') {
            return Err("[email] address is missing".to_owned());
        }
        server(&self.imap, 993).map_err(|e| format!("[email] imap: {e}"))?;
        server(&self.smtp, 465).map_err(|e| format!("[email] smtp: {e}"))?;
        Ok(())
    }
}

/// `host:port` (the port defaulting to [default]).
fn server(text: &str, default: u16) -> Result<(String, u16), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("no server".to_owned());
    }
    match text.rsplit_once(':') {
        Some((host, port)) => Ok((host.to_owned(), port.parse().map_err(|_| format!("{text:?}: not a port"))?)),
        None => Ok((text.to_owned(), default)),
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// How a connection is secured: TLS at once, STARTTLS, or plain (this machine only).
fn security(host: &str, port: u16, tls_port: u16) -> &'static str {
    if port == tls_port {
        "tls"
    } else if crate::net::loopback(host) {
        "plain"
    } else {
        "starttls"
    }
}

/// A connection after TLS (or plain to this machine).
async fn open(
    host: &str,
    port: u16,
    tls_port: u16,
    network: &invincible_policy::NetworkMode,
    starttls: impl AsyncFnOnce(&mut BufReader<tokio::net::TcpStream>) -> Result<(), String>,
) -> Result<BufReader<Box<dyn Io>>, String> {
    let stream = crate::net::tcp(host, port, network).await?;
    match security(host, port, tls_port) {
        "tls" => Ok(BufReader::new(Box::new(crate::net::tls(stream, host).await?) as Box<dyn Io>)),
        "plain" => Ok(BufReader::new(Box::new(stream) as Box<dyn Io>)),
        _ => {
            let mut plain = BufReader::new(stream);
            starttls(&mut plain).await?;
            if !plain.buffer().is_empty() {
                return Err(format!("{host}: data before TLS"));
            }
            Ok(BufReader::new(Box::new(crate::net::tls(plain.into_inner(), host).await?) as Box<dyn Io>))
        }
    }
}

async fn line<R: AsyncBufReadExt + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut line = String::new();
    let read = tokio::time::timeout(Duration::from_secs(120), reader.read_line(&mut line))
        .await
        .map_err(|_| "the server stopped answering".to_owned())?
        .map_err(|e| e.to_string())?;
    if read == 0 {
        return Err("the server closed the connection".to_owned());
    }
    if line.len() > 1 << 20 {
        return Err("the server sent a line too long".to_owned());
    }
    Ok(line)
}

/// A string IMAP takes: quoted, with `\` and `"` escaped.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// An IMAP connection, as much as reading a mailbox needs.
pub struct Imap {
    io: BufReader<Box<dyn Io>>,
    tag: u32,
    pub idle: bool,
}

impl Imap {
    pub async fn connect(host: &str, port: u16, network: &invincible_policy::NetworkMode) -> Result<Self, String> {
        let io = open(host, port, 993, network, async |plain: &mut BufReader<tokio::net::TcpStream>| {
            line(plain).await?;
            plain.get_mut().write_all(b"S0 STARTTLS\r\n").await.map_err(|e| e.to_string())?;
            loop {
                let reply = line(plain).await?;
                if reply.starts_with("S0 OK") {
                    return Ok(());
                }
                if reply.starts_with("S0 ") {
                    return Err(format!("STARTTLS: {}", reply.trim()));
                }
            }
        })
        .await?;
        let mut imap = Self { io, tag: 0, idle: false };
        if security(host, port, 993) != "starttls" {
            let greeting = line(&mut imap.io).await?;
            if !greeting.starts_with("* OK") && !greeting.starts_with("* PREAUTH") {
                return Err(format!("IMAP: {}", greeting.trim()));
            }
        }
        Ok(imap)
    }

    /// Sends [command]; the untagged lines (with literals inline) until the tagged OK.
    async fn command(&mut self, command: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        self.tag += 1;
        let tag = format!("A{}", self.tag);
        self.io.get_mut().write_all(format!("{tag} {command}\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
        self.read_until(&tag).await
    }

    async fn read_until(&mut self, tag: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut out = Vec::new();
        loop {
            let mut text = line(&mut self.io).await?;
            let mut literal = Vec::new();
            // `{123}` at the end: that many bytes follow, then the rest of the line.
            while let Some(size) = literal_size(&text) {
                if size > 50 << 20 {
                    return Err("IMAP: a message larger than 50 MB".to_owned());
                }
                let mut bytes = vec![0u8; size];
                self.io.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
                literal.extend_from_slice(&bytes);
                text = line(&mut self.io).await?;
            }
            if let Some(rest) = text.strip_prefix(&format!("{tag} ")) {
                return if rest.starts_with("OK") { Ok(out) } else { Err(format!("IMAP: {}", rest.trim())) };
            }
            out.push((text, literal));
        }
    }

    pub async fn login(&mut self, user: &str, password: &str) -> Result<(), String> {
        self.command(&format!("LOGIN {} {}", quoted(user), quoted(password)))
            .await
            .map_err(|_| "IMAP: the login was refused".to_owned())?;
        let caps = self.command("CAPABILITY").await?;
        self.idle = caps.iter().any(|(l, _)| l.to_ascii_uppercase().split_whitespace().any(|w| w == "IDLE"));
        Ok(())
    }

    pub async fn select(&mut self, folder: &str) -> Result<(), String> {
        self.command(&format!("SELECT {}", quoted(folder))).await.map(drop)
    }

    /// The unread messages' UIDs.
    pub async fn unseen(&mut self) -> Result<Vec<u32>, String> {
        let lines = self.command("UID SEARCH UNSEEN").await?;
        Ok(lines
            .iter()
            .filter_map(|(l, _)| l.strip_prefix("* SEARCH"))
            .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()).collect::<Vec<u32>>())
            .collect())
    }

    /// A message's bytes, leaving it unread.
    pub async fn fetch(&mut self, uid: u32) -> Result<Vec<u8>, String> {
        let lines = self.command(&format!("UID FETCH {uid} (BODY.PEEK[])")).await?;
        lines
            .into_iter()
            .find(|(_, literal)| !literal.is_empty())
            .map(|(_, l)| l)
            .ok_or_else(|| format!("IMAP: no message {uid}"))
    }

    pub async fn seen(&mut self, uid: u32) -> Result<(), String> {
        self.command(&format!("UID STORE {uid} +FLAGS.SILENT (\\Seen)")).await.map(drop)
    }

    /// Waits for new mail (IDLE) at most [wait].
    pub async fn wait(&mut self, wait: Duration) -> Result<(), String> {
        self.tag += 1;
        let tag = format!("A{}", self.tag);
        self.io.get_mut().write_all(format!("{tag} IDLE\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
        let ready = line(&mut self.io).await?;
        if !ready.starts_with('+') {
            return Err(format!("IMAP IDLE: {}", ready.trim()));
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let mut text = String::new();
            match tokio::time::timeout_at(deadline, self.io.read_line(&mut text)).await {
                Err(_) => break,
                Ok(Err(e)) => return Err(e.to_string()),
                Ok(Ok(0)) => return Err("the server closed the connection".to_owned()),
                Ok(Ok(_)) if text.contains("EXISTS") || text.contains("RECENT") => break,
                Ok(Ok(_)) => {}
            }
        }
        self.io.get_mut().write_all(b"DONE\r\n").await.map_err(|e| e.to_string())?;
        self.read_until(&tag).await.map(drop)
    }

    pub async fn logout(&mut self) {
        let _ = self.command("LOGOUT").await;
    }
}

fn literal_size(line: &str) -> Option<usize> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let open = trimmed.strip_suffix('}')?.rfind('{')?;
    trimmed[open + 1..trimmed.len() - 1].parse().ok()
}

/// Reads an SMTP reply (all its lines); its code and the last line.
async fn smtp_reply<R: AsyncBufReadExt + Unpin>(reader: &mut R) -> Result<(u16, String), String> {
    let mut lines = Vec::new();
    loop {
        let text = line(reader).await?;
        let code = text.get(..3).and_then(|c| c.parse::<u16>().ok()).ok_or_else(|| format!("SMTP: {}", text.trim()))?;
        let more = text.as_bytes().get(3) == Some(&b'-');
        lines.push(text.trim().to_owned());
        if !more {
            return Ok((code, lines.join(" ")));
        }
    }
}

async fn smtp_step(io: &mut BufReader<Box<dyn Io>>, command: &str, want: &[u16]) -> Result<String, String> {
    if !command.is_empty() {
        io.get_mut().write_all(format!("{command}\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let (code, text) = smtp_reply(io).await?;
    if !want.contains(&code) {
        let shown = if command.starts_with("AUTH") { "AUTH" } else { command };
        return Err(format!("SMTP {shown}: {text}"));
    }
    Ok(text)
}

/// Sends [message] (headers and body, CRLF lines) from [from] to [to].
pub async fn send_mail(
    config: &EmailConfig,
    password: &str,
    network: &invincible_policy::NetworkMode,
    to: &str,
    message: &str,
) -> Result<(), String> {
    let (host, port) = server(&config.smtp, 465)?;
    let mut io = open(&host, port, 465, network, async |plain: &mut BufReader<tokio::net::TcpStream>| {
        let (code, _) = smtp_reply(plain).await?;
        if code != 220 {
            return Err("SMTP: no greeting".to_owned());
        }
        plain.get_mut().write_all(b"EHLO autobot\r\n").await.map_err(|e| e.to_string())?;
        let (_, caps) = smtp_reply(plain).await?;
        if !caps.to_ascii_uppercase().contains("STARTTLS") {
            return Err("SMTP: the server offers no STARTTLS".to_owned());
        }
        plain.get_mut().write_all(b"STARTTLS\r\n").await.map_err(|e| e.to_string())?;
        let (code, text) = smtp_reply(plain).await?;
        if code != 220 {
            return Err(format!("SMTP STARTTLS: {text}"));
        }
        Ok(())
    })
    .await?;
    if security(&host, port, 465) != "starttls" {
        smtp_step(&mut io, "", &[220]).await?;
    }
    smtp_step(&mut io, "EHLO autobot", &[250]).await?;
    if !password.is_empty() {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("\0{}\0{password}", config.username()));
        smtp_step(&mut io, &format!("AUTH PLAIN {token}"), &[235]).await?;
    }
    smtp_step(&mut io, &format!("MAIL FROM:<{}>", config.address), &[250]).await?;
    smtp_step(&mut io, &format!("RCPT TO:<{to}>"), &[250, 251]).await?;
    smtp_step(&mut io, "DATA", &[354]).await?;
    // Lines starting with a dot get another one (RFC 5321).
    let body: String = message
        .split("\r\n")
        .map(|l| if l.starts_with('.') { format!(".{l}\r\n") } else { format!("{l}\r\n") })
        .collect();
    io.get_mut().write_all(body.as_bytes()).await.map_err(|e| e.to_string())?;
    smtp_step(&mut io, ".", &[250]).await?;
    let _ = smtp_step(&mut io, "QUIT", &[221]).await;
    Ok(())
}

/// A thread the bot takes part in: whom to answer, and how to stay in the thread.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Thread {
    with: String,
    subject: String,
    last: Option<String>,
    references: Vec<String>,
    /// What the other side wrote last, to quote.
    quoted: String,
}

/// The threads, kept in `$AUTOBOT_HOME/email-threads.json` so answers find them after a restart.
#[derive(Default, Serialize, Deserialize)]
struct Threads {
    threads: HashMap<String, Thread>,
}

/// A thread's short name: what a conversation and `email:<name>` addresses use.
pub fn thread_key(thread: &str) -> String {
    invincible::token::hex(&<sha2::Sha256 as sha2::Digest>::digest(thread.as_bytes())[..6])
}

/// Bytes attached to one mail at most: most servers take 25 MB, and base64 with its line breaks
/// makes 37% more (15 MiB is about 21.6 MB sent). A server that takes less refuses it, and the
/// answer then goes without the files.
const MAX_ATTACHED: u64 = 15 * 1024 * 1024;

/// [files] read as attachments, up to [MAX_ATTACHED] in all; those left over (too large, or
/// unreadable: they go on their own, or are said where they are).
type Taken = (Vec<crate::mail::Attachment>, Vec<crate::media::Made>, Vec<crate::media::Made>);

/// [files] as attachments up to [MAX_ATTACHED] in all: the attachments, the files they are, and
/// the rest.
fn attachments(files: Vec<crate::media::Made>) -> Taken {
    let (mut taken, mut made, mut rest, mut total) = (Vec::new(), Vec::new(), Vec::new(), 0u64);
    for file in files {
        let size = std::fs::metadata(&file.path).map(|m| m.len()).unwrap_or(u64::MAX);
        if total.saturating_add(size) > MAX_ATTACHED {
            rest.push(file);
            continue;
        }
        match file.bytes() {
            Ok(bytes) => {
                total += bytes.len() as u64;
                taken.push(crate::mail::Attachment { name: file.name(), mime: file.mime.clone(), bytes });
                made.push(file);
            }
            _ => rest.push(file),
        }
    }
    (taken, made, rest)
}

/// Email as [crate::channel] sees it.
struct Channel {
    config: EmailConfig,
    password: String,
    network: invincible_policy::NetworkMode,
    home: PathBuf,
    name: String,
    threads: Mutex<Threads>,
}

impl Channel {
    fn thread(&self, key: &str) -> Option<Thread> {
        self.threads.lock().expect("threads").threads.get(key).cloned()
    }

    fn save(&self) {
        let text = serde_json::to_string(&*self.threads.lock().expect("threads")).unwrap_or_default();
        if let Err(e) = invincible::fsutil::replace_private(&self.home.join("email-threads.json"), &text) {
            tracing::warn!("email: {e}");
        }
    }

    /// Sends [text] in the thread [chat], or as a new mail to [chat] when it is an address; with
    /// [subject] instead of the thread's.
    async fn mail(&self, chat: &str, text: &str, subject: Option<&str>) -> Result<Option<String>, String> {
        self.mail_with(chat, text, subject, &[]).await
    }

    /// [Channel::mail] with files attached.
    async fn mail_with(
        &self,
        chat: &str,
        text: &str,
        subject: Option<&str>,
        attachments: &[crate::mail::Attachment],
    ) -> Result<Option<String>, String> {
        let domain = self.config.address.rsplit('@').next().unwrap_or("localhost");
        let id = format!("<{}@{domain}>", invincible::token::hex(&invincible::token::random::<12>()?));
        let (to, thread_subject, parent, references, quoted) = match self.thread(chat) {
            Some(t) => (t.with, crate::mail::reply_subject(&t.subject), t.last, t.references, t.quoted),
            None if chat.contains('@') => {
                let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("A message");
                (
                    chat.to_owned(),
                    format!("{}: {}", self.name, crate::channel::cut(first, 60)),
                    None,
                    Vec::new(),
                    String::new(),
                )
            }
            None => return Err(format!("no mail thread {chat:?}")),
        };
        let mut body = text.to_owned();
        if !quoted.is_empty() {
            body.push_str("\n\n");
            body.push_str(&crate::mail::quote(&to, &quoted));
        }
        let subject = subject.map(str::to_owned).unwrap_or(thread_subject);
        let message = crate::mail::compose(&crate::mail::Outgoing {
            from: &self.config.address,
            from_name: &self.name,
            to: &to,
            subject: &subject,
            text: &body,
            in_reply_to: parent.as_deref(),
            references: &references,
            message_id: &id,
            attachments,
        });
        send_mail(&self.config, &self.password, &self.network, &to, &message).await?;
        // The next answer follows this one in the thread.
        let mut threads = self.threads.lock().expect("threads");
        if let Some(t) = threads.threads.get_mut(chat) {
            if let Some(parent) = &parent
                && !t.references.contains(parent)
            {
                t.references.push(parent.clone());
            }
            t.last = Some(id.clone());
        }
        drop(threads);
        self.save();
        Ok(Some(id))
    }
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "email"
    }

    fn limit(&self) -> usize {
        200_000
    }

    fn progress(&self) -> Progress {
        Progress::Quiet
    }

    fn asking(&self) -> Asking {
        Asking::Code
    }

    fn format(&self, markdown: &str) -> String {
        crate::markdown::to_plain(markdown)
    }

    fn footer(&self, route: &str) -> String {
        format!("\n\n-- \n{route}")
    }

    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { self.mail(chat, text, None).await })
    }

    /// One mail per answer, however long.
    fn answer<'a>(&'a self, chat: &'a str, markdown: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.mail(chat, &crate::markdown::to_plain(markdown), None).await.map(drop) })
    }

    /// The answer with the turn's files attached, up to [MAX_ATTACHED] in all; the rest after it.
    fn answer_with<'a>(
        &'a self,
        chat: &'a str,
        markdown: &'a str,
        files: Vec<crate::media::Made>,
    ) -> BoxFuture<'a, Result<Vec<crate::media::Made>, String>> {
        Box::pin(async move {
            let (attachments, made, mut rest) = attachments(files);
            let text = crate::markdown::to_plain(markdown);
            if let Err(e) = self.mail_with(chat, &text, None, &attachments).await {
                if attachments.is_empty() {
                    return Err(e);
                }
                // The server may refuse the size: the answer goes on its own, and the files after
                // it one by one (each attached, or where it is saved).
                tracing::warn!("email: the answer with its files was refused ({e}); sending it without them");
                self.mail(chat, &text, None).await?;
                rest.splice(0..0, made);
            }
            Ok(rest)
        })
    }

    /// A file on its own: a mail in the thread with it attached.
    fn send_file<'a>(&'a self, chat: &'a str, file: &'a crate::media::Made) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            let attachment =
                crate::mail::Attachment { name: file.name(), mime: file.mime.clone(), bytes: file.bytes()? };
            if attachment.bytes.len() as u64 > MAX_ATTACHED {
                return Ok(false);
            }
            self.mail_with(chat, &format!("Attached: {}", file.name()), None, &[attachment]).await.map(|_| true)
        })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let subject = format!("{} [{}]", crate::channel::cut(&question.text, 70), question.code);
            let text = format!(
                "{}\n\nReply with yes, always (for this conversation) or no; or \"no, …\" with what to do instead. Keep the code {} in the subject. Nobody answering in 10 minutes means no.",
                question.text, question.code
            );
            self.mail(chat, &text, Some(&subject)).await.map(drop)
        })
    }

    fn pairing_text(&self, code: &str) -> String {
        format!(
            "This agent is private. To let this address in, its owner runs on the machine:\n\n    autobot email approve {code}\n\nThe code works for {} minutes.",
            crate::pairing::CODE_LIFETIME / 60
        )
    }
}

/// The email channel of [runtime], as its config says: off (Err) when it cannot start.
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let config = runtime.config.email.clone();
    config.check()?;
    let password = config.password(&runtime.home)?;
    let network = crate::network()?;
    serve(runtime, config, password, network).await
}

/// Reads [runtime]'s mailbox and answers until the process stops; Err when the login is refused.
pub async fn serve(
    runtime: Arc<Runtime>,
    config: EmailConfig,
    password: String,
    network: invincible_policy::NetworkMode,
) -> Result<(), String> {
    // The configured senders are allowed, as if paired.
    let mut users = crate::pairing::Users::load(&runtime.home, "email")?;
    let mut added = false;
    for address in &config.allow {
        let address = address.trim().to_ascii_lowercase();
        if !address.is_empty() && !users.allows(&address) {
            users.allowed.push(crate::pairing::User { id: address.clone(), name: address });
            added = true;
        }
    }
    if added {
        users.save(&runtime.home, "email")?;
    }
    let threads = invincible::fsutil::read_optional(&runtime.home.join("email-threads.json"))?
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let channel = Arc::new(Channel {
        config: config.clone(),
        password: password.clone(),
        network: network.clone(),
        home: runtime.home.clone(),
        name: runtime.name.clone(),
        threads: Mutex::new(threads),
    });
    let transport: Arc<dyn Transport> = channel.clone();
    runtime.register(transport.clone());
    runtime.channel_account("email", &config.address);
    let (host, port) = server(&config.imap, 993)?;
    let mut backoff = Duration::from_secs(5);
    let mut first = true;
    loop {
        let started = std::time::Instant::now();
        let result = session(&runtime, &channel, &transport, &config, &password, &host, port, &network).await;
        match result {
            Err(e) if first && e.contains("login was refused") => return Err(e),
            Err(e) => {
                tracing::warn!(bot = %runtime.name, "email: {e}; again in {}s", backoff.as_secs());
                runtime.channel_state("email", &format!("retrying: {e}"));
            }
            Ok(()) => {}
        }
        first = false;
        // A session that ran a while was healthy: the next try is quick again.
        if started.elapsed() > Duration::from_secs(300) {
            backoff = Duration::from_secs(5);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(300));
    }
}

#[allow(clippy::too_many_arguments)]
async fn session(
    runtime: &Arc<Runtime>,
    channel: &Arc<Channel>,
    transport: &Arc<dyn Transport>,
    config: &EmailConfig,
    password: &str,
    host: &str,
    port: u16,
    network: &invincible_policy::NetworkMode,
) -> Result<(), String> {
    let mut imap = Imap::connect(host, port, network).await?;
    imap.login(&config.username(), password).await?;
    imap.select(&config.folder).await?;
    runtime.channel_state("email", "connected");
    tracing::info!(bot = %runtime.name, "email: reading {} as {}", config.folder, config.address);
    loop {
        for uid in imap.unseen().await? {
            let raw = imap.fetch(uid).await?;
            imap.seen(uid).await?;
            let mail = crate::mail::parse(&raw);
            if let Some(incoming) = incoming(channel, config, mail) {
                let (runtime, transport) = (runtime.clone(), transport.clone());
                tokio::spawn(async move {
                    if let Err(e) = crate::channel::handle(&runtime, &transport, incoming).await {
                        tracing::warn!(bot = %runtime.name, "email: {e}");
                    }
                });
            }
        }
        if imap.idle {
            imap.wait(Duration::from_secs(config.poll.max(60) * 20).min(Duration::from_secs(25 * 60))).await?;
        } else {
            tokio::time::sleep(Duration::from_secs(config.poll.max(5))).await;
            // A NOOP keeps the connection and lets the server report new mail.
            imap.command("NOOP").await?;
        }
    }
}

/// [mail] as a message for the bot, when it is one: remembers its thread for the answer.
fn incoming(channel: &Channel, config: &EmailConfig, mail: crate::mail::Mail) -> Option<Incoming> {
    if mail.automatic || mail.from.is_empty() || mail.from == config.address.to_ascii_lowercase() {
        return None;
    }
    // Strangers are ignored unless pairing is on: no mail goes back to them.
    if !config.pairing && !crate::pairing::allows(&channel.home, "email", &mail.from).unwrap_or(false) {
        tracing::info!("email: a mail from {}, who is not allowed; ignored", mail.from);
        return None;
    }
    if config.verify && !mail.authenticated {
        tracing::warn!("email: {} did not pass SPF, DKIM or DMARC here; ignored ([email] verify)", mail.from);
        return None;
    }
    let key = thread_key(&mail.thread());
    let first = mail.in_reply_to.is_none() && mail.references.is_empty();
    let answers_question = mail.subject.to_ascii_lowercase().contains("approve?");
    // A new thread's subject is part of the task; a reply's code is in its subject.
    let text = if answers_question {
        format!("{}\n{}", mail.text, mail.subject)
    } else if first && !mail.subject.trim().is_empty() {
        format!("{}\n\n{}", mail.subject.trim(), mail.text)
    } else {
        mail.text.clone()
    };
    {
        let mut threads = channel.threads.lock().expect("threads");
        let thread = threads.threads.entry(key.clone()).or_insert_with(|| Thread {
            with: mail.from.clone(),
            subject: mail.subject.clone(),
            ..Default::default()
        });
        thread.with.clone_from(&mail.from);
        thread.last.clone_from(&mail.message_id);
        for r in mail.references.iter().chain(mail.in_reply_to.iter()) {
            if !thread.references.contains(r) {
                thread.references.push(r.clone());
            }
        }
        thread.quoted = mail.text.chars().take(4000).collect();
        // A thread kept forever would grow without bound: the newest 500.
        if threads.threads.len() > 500
            && let Some(old) = threads.threads.keys().next().cloned()
        {
            threads.threads.remove(&old);
        }
    }
    channel.save();
    let audio = mail.audio.map(|(mime, name, bytes)| {
        Box::pin(async move { Ok(crate::voice::Audio { bytes, mime, name }) }) as BoxFuture<'static, _>
    });
    Some(Incoming {
        chat: key.clone(),
        place: format!("email-{key}"),
        user: crate::pairing::User { id: mail.from.clone(), name: mail.from_name.clone() },
        text,
        direct: config.pairing,
        audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SMTP that refuses a message with attachments (552, too large) and takes plain ones.
    async fn picky_smtp(taken: Arc<Mutex<Vec<String>>>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let taken = taken.clone();
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut read = BufReader::new(read);
                    write.write_all(b"220 picky\r\n").await.unwrap();
                    loop {
                        let mut line = String::new();
                        if read.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let upper = line.to_ascii_uppercase();
                        let reply = if upper.starts_with("EHLO") {
                            "250-picky\r\n250 AUTH PLAIN\r\n".to_owned()
                        } else if upper.starts_with("AUTH") {
                            "235 ok\r\n".to_owned()
                        } else if upper.starts_with("DATA") {
                            write.write_all(b"354 go\r\n").await.unwrap();
                            let mut message = String::new();
                            loop {
                                let mut l = String::new();
                                read.read_line(&mut l).await.unwrap();
                                if l == ".\r\n" {
                                    break;
                                }
                                message.push_str(&l);
                            }
                            if message.contains("multipart/mixed") {
                                "552 message too large\r\n".to_owned()
                            } else {
                                taken.lock().unwrap().push(message);
                                "250 queued\r\n".to_owned()
                            }
                        } else if upper.starts_with("QUIT") {
                            write.write_all(b"221 bye\r\n").await.unwrap();
                            return;
                        } else {
                            "250 ok\r\n".to_owned()
                        };
                        write.write_all(reply.as_bytes()).await.unwrap();
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn an_answer_whose_files_are_refused_goes_without_them() {
        let home = std::env::temp_dir().join(format!("autobot-email-refused-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let file = home.join("speech-1.mp3");
        std::fs::write(&file, b"ID3 audio").unwrap();
        let taken: Arc<Mutex<Vec<String>>> = Arc::default();
        let port = picky_smtp(taken.clone()).await;
        let channel = Channel {
            config: EmailConfig {
                address: "bot@x.org".into(),
                smtp: format!("127.0.0.1:{port}"),
                ..Default::default()
            },
            password: "pw".into(),
            network: invincible_policy::NetworkMode::Offline,
            home: home.clone(),
            name: "autobot".into(),
            threads: Mutex::default(),
        };
        let made =
            crate::media::Made { kind: crate::media::Kind::Speech, path: file.clone(), mime: "audio/mpeg".into() };
        let left = channel.answer_with("ann@example.com", "Here it is.", vec![made]).await.unwrap();
        assert_eq!(left.len(), 1, "the file goes after the answer, on its own");
        assert_eq!(left[0].path, file);
        let taken = taken.lock().unwrap();
        assert_eq!(taken.len(), 1);
        assert!(taken[0].contains("Here it is."), "{}", taken[0]);
        drop(taken);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn servers_and_security() {
        assert_eq!(server("imap.x.org:993", 993).unwrap(), ("imap.x.org".into(), 993));
        assert_eq!(server("smtp.x.org", 465).unwrap(), ("smtp.x.org".into(), 465));
        assert!(server("", 1).is_err());
        assert!(server("x:y", 1).is_err());
        assert_eq!(security("imap.x.org", 993, 993), "tls");
        assert_eq!(security("imap.x.org", 143, 993), "starttls");
        assert_eq!(security("127.0.0.1", 1143, 993), "plain");
        assert_eq!(literal_size("* 1 FETCH (UID 4 BODY[] {1234}\r\n"), Some(1234));
        assert_eq!(literal_size("* 1 FETCH (FLAGS ())\r\n"), None);
        assert_eq!(quoted("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn config_is_checked() {
        let mut config = EmailConfig {
            address: "bot@x.org".into(),
            imap: "imap.x.org".into(),
            smtp: "smtp.x.org:587".into(),
            ..Default::default()
        };
        assert!(config.check().is_ok());
        config.address = "bot".into();
        assert!(config.check().is_err());
        assert_eq!(EmailConfig { username: Some("u".into()), ..Default::default() }.username(), "u");
    }
}
