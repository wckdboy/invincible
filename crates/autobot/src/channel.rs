//! What every messaging platform shares: pairing, commands, steering, approvals, voice, the turn
//! and its progress, long answers in parts. A platform ([crate::telegram], [crate::discord],
//! [crate::slack], [crate::email], [crate::signal], [crate::matrix]) only receives messages,
//! decides which are for the bot, and implements [Transport]: how to send, edit and ask there.
//!
//! - **Pairing:** a stranger in a direct conversation gets a one-time code; nobody gets in until
//!   the owner runs `autobot <platform> approve <code>` ([crate::pairing]).
//! - **One conversation per person:** a direct conversation with someone linked in
//!   [crate::identity] is the same conversation on every platform (`dm-<person>`).
//! - **Steering:** a message while a turn runs is taken in before the agent's next step.
//! - **Approvals:** buttons where the platform has them, else a reply (`yes`, `always`, `no`,
//!   `no, do X instead`); by email, the reply carries the question's code.
//! - **Commands** on every platform: `/help`, `/status`, `/new`, `/stop`, `/model`, `/sethome`,
//!   `/bots`, `/cron`, `/board`, `/actions`, `/memory`, `/skills` (also written `!status`, for
//!   Slack, where `/` belongs to the app's own commands).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Notify, oneshot};

use crate::agent::Event;
use crate::approval::{Action, Answer, Approver};
use crate::bots::Runtime;
use crate::session::Session;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How long an approval waits.
pub const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);

/// How a platform shows the agent's work while a turn runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    /// A short message per step (Telegram).
    Lines,
    /// One message, edited as steps come (Discord, Slack, Matrix).
    Edited,
    /// Nothing until the answer (email, Signal).
    Quiet,
}

/// How a platform asks for an approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asking {
    /// Buttons; a press comes back through [Conversations::press].
    Buttons,
    /// A reply in the conversation: yes, always, no.
    Reply,
    /// A reply that carries the question's one-time code (email: anyone can write "yes").
    Code,
}

/// A question for the owner, as a platform shows it.
pub struct Question {
    /// Unique; buttons carry it.
    pub id: String,
    /// Short, for replies (`yes 7KQM`).
    pub code: String,
    /// The person asked: only they can answer.
    pub user: String,
    /// `Approve? run: ls -la` (with `[member] ` first for a team member).
    pub text: String,
}

/// One platform's way of sending. `chat` is the platform's own address of a conversation (a
/// Telegram chat id, a Slack channel and thread, an email thread).
pub trait Transport: Send + Sync {
    fn platform(&self) -> &'static str;
    /// Characters per message.
    fn limit(&self) -> usize;
    fn progress(&self) -> Progress {
        Progress::Edited
    }
    fn asking(&self) -> Asking {
        Asking::Buttons
    }
    /// An answer's Markdown in the platform's dialect ([crate::markdown]).
    fn format(&self, markdown: &str) -> String {
        markdown.to_owned()
    }
    /// The line under an answer saying which model answered and its receipt.
    fn footer(&self, route: &str) -> String {
        format!("\n\n— {route}")
    }
    /// Sends one message (already under [Transport::limit]); its id, when the platform gives one.
    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>>;
    /// Sends an answer written in Markdown: in parts under the limit, each in the platform's dialect.
    fn answer<'a>(&'a self, chat: &'a str, markdown: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            for part in crate::markdown::split(markdown, self.limit()) {
                self.send(chat, &self.format(&part)).await?;
            }
            Ok(())
        })
    }
    /// Sends an answer with the files the turn made; those it did not take with it, which go
    /// after it one by one ([send_files]). By default, all of them (email attaches them).
    fn answer_with<'a>(
        &'a self,
        chat: &'a str,
        markdown: &'a str,
        files: Vec<crate::media::Made>,
    ) -> BoxFuture<'a, Result<Vec<crate::media::Made>, String>> {
        Box::pin(async move {
            self.answer(chat, markdown).await?;
            Ok(files)
        })
    }
    fn edit<'a>(&'a self, _chat: &'a str, _id: &'a str, _text: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("this platform does not edit messages".to_owned()) })
    }
    fn typing<'a>(&'a self, _chat: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
    /// Sends a file the turn made ([crate::media]): a voice message, a picture. Whether this
    /// platform could (the chat says where the file is when not).
    fn send_file<'a>(&'a self, _chat: &'a str, _file: &'a crate::media::Made) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }
    /// Shows [question] in [chat]: buttons, or how to reply.
    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>>;
    /// A team member's line, posted by its own account when it has one; whether it was.
    fn post_as<'a>(&'a self, _member: &'a str, _chat: &'a str, _text: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }
    /// What a stranger is told.
    fn pairing_text(&self, code: &str) -> String {
        format!(
            "This agent is private. To let this account in, its owner runs on the machine:\n\nautobot {} approve {code}\n\nThe code works for {} minutes.",
            self.platform(),
            crate::pairing::CODE_LIFETIME / 60
        )
    }
    /// The conversation to send to for a user id (a direct message): the id itself by default.
    fn user_chat(&self, user: &str) -> String {
        user.to_owned()
    }
}

/// A message for the bot, after the platform decided it is one.
pub struct Incoming {
    /// Where answers go ([Transport] address).
    pub chat: String,
    /// The conversation's name when it is not a linked direct one (`telegram-123`, `slack-C1-…`).
    pub place: String,
    pub user: crate::pairing::User,
    pub text: String,
    /// A direct conversation (strangers get a pairing code only there).
    pub direct: bool,
    /// A voice note or audio file, fetched only once the sender is known to be allowed.
    pub audio: Option<BoxFuture<'static, Result<crate::voice::Audio, String>>>,
}

/// A conversation, and what was sent to it while a turn runs.
#[derive(Clone)]
struct Slot {
    chat: Arc<tokio::sync::Mutex<Chat>>,
    inbox: crate::tools::Inbox,
    stop: Arc<Notify>,
}

struct Chat {
    session: Session,
    grants: HashSet<Action>,
}

struct Waiting {
    platform: &'static str,
    chat: String,
    user: String,
    code: String,
    tx: oneshot::Sender<Answer>,
}

/// A bot's conversations on every platform, and the questions they wait on.
#[derive(Default)]
pub struct Conversations {
    slots: Mutex<HashMap<String, Slot>>,
    waiting: Mutex<HashMap<String, Waiting>>,
}

/// What a button press did.
#[derive(Debug, PartialEq, Eq)]
pub enum Pressed {
    /// Answered: the note to show (`Allowed`).
    Done(&'static str),
    /// Someone else's question.
    NotYours,
    /// Answered already, or expired.
    Expired,
}

pub fn note(answer: &Answer) -> &'static str {
    match answer {
        Answer::Once => "Allowed",
        Answer::Always => "Allowed for this chat",
        Answer::Deny => "Denied",
        Answer::Instead(_) => "Denied, with what to do instead",
    }
}

/// An approval answered in words: `yes`, `always`, `no`, `no, <what to do instead>`.
pub fn parse_answer(text: &str) -> Option<Answer> {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let lower = first.to_lowercase();
    let word: String = lower.chars().take_while(|c| c.is_alphabetic()).collect();
    let rest = first[word.len().min(first.len())..].trim_start_matches([',', ':', ';', '.', '-', ' ']).trim();
    match word.as_str() {
        "yes" | "y" | "ok" | "allow" | "approve" | "approved" | "sure" => Some(Answer::Once),
        "always" => Some(Answer::Always),
        "no" | "n" | "deny" | "denied" | "nope" | "instead" => {
            // A code alone after "no" is not an instruction.
            let instruction = rest.split_whitespace().filter(|w| !looks_like_code(w)).collect::<Vec<_>>().join(" ");
            if instruction.is_empty() { Some(Answer::Deny) } else { Some(Answer::Instead(instruction)) }
        }
        _ => None,
    }
}

fn looks_like_code(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    w.len() == 4
        && w.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_digit())
}

impl Conversations {
    fn slot(&self, home: &std::path::Path, id: &str) -> Result<Slot, String> {
        let mut slots = self.slots.lock().expect("slots");
        if let Some(slot) = slots.get(id) {
            return Ok(slot.clone());
        }
        let session = Session::open(&home.join("sessions"), id)?;
        let slot = Slot {
            chat: Arc::new(tokio::sync::Mutex::new(Chat { session, grants: HashSet::new() })),
            inbox: Arc::default(),
            stop: Arc::default(),
        };
        slots.insert(id.to_owned(), slot.clone());
        Ok(slot)
    }

    /// Turns running now, and messages waiting to be taken in.
    pub fn load(&self) -> (usize, usize) {
        let slots = self.slots.lock().expect("slots");
        let running = slots.values().filter(|s| s.chat.try_lock().is_err()).count();
        let queued = slots.values().map(|s| s.inbox.lock().expect("inbox").len()).sum();
        (running, queued)
    }

    /// Questions waiting, as (platform, chat, text-free id) for `/status`.
    pub fn waiting(&self) -> usize {
        self.waiting.lock().expect("waiting").len()
    }

    /// A button press by [user] on question [id].
    pub fn press(&self, id: &str, user: &str, answer: Answer) -> Pressed {
        let mut waiting = self.waiting.lock().expect("waiting");
        match waiting.get(id) {
            Some(w) if w.user == user => {
                let w = waiting.remove(id).expect("present");
                let note = note(&answer);
                let _ = w.tx.send(answer);
                Pressed::Done(note)
            }
            Some(_) => Pressed::NotYours,
            None => Pressed::Expired,
        }
    }

    /// A reply in [chat] that answers a waiting question: the note to send back. With
    /// [Asking::Code] the reply must carry the question's code; with [Asking::Reply], it must
    /// when more than one question waits there.
    pub fn reply(&self, platform: &str, chat: &str, user: &str, text: &str, asking: Asking) -> Option<&'static str> {
        let answer = parse_answer(text)?;
        let mut waiting = self.waiting.lock().expect("waiting");
        let here: Vec<String> = waiting
            .iter()
            .filter(|(_, w)| w.platform == platform && w.chat == chat && w.user == user)
            .map(|(id, _)| id.clone())
            .collect();
        let words: Vec<String> =
            text.split(|c: char| !c.is_ascii_alphanumeric()).map(str::to_ascii_uppercase).collect();
        let coded = here.iter().find(|id| words.contains(&waiting[*id].code)).cloned();
        let id = match (asking, coded) {
            (_, Some(id)) => id,
            (Asking::Reply, None) if here.len() == 1 => here[0].clone(),
            _ => return None,
        };
        let w = waiting.remove(&id)?;
        let note = note(&answer);
        let _ = w.tx.send(answer);
        Some(note)
    }
}

/// Removes a question when its approval ends, however it ends (answered, timed out, the turn
/// stopped).
struct Asked<'a> {
    conversations: &'a Conversations,
    id: String,
}

impl Drop for Asked<'_> {
    fn drop(&mut self) {
        self.conversations.waiting.lock().expect("waiting").remove(&self.id);
    }
}

struct ChannelApprover {
    runtime: Arc<Runtime>,
    transport: Arc<dyn Transport>,
    chat: String,
    user: String,
}

impl Approver for ChannelApprover {
    fn channel(&self) -> &'static str {
        self.transport.platform()
    }

    fn approve<'a>(&'a self, action: &'a Action) -> BoxFuture<'a, Answer> {
        Box::pin(async move {
            let Ok(bytes) = invincible::token::random::<8>() else { return Answer::Deny };
            let id = invincible::token::hex(&bytes);
            let code = crate::pairing::new_code().map(|c| c.replace('-', "")[..4].to_owned()).unwrap_or_default();
            // Codes in one conversation differ, so a reply names one question.
            let code = if code.chars().any(|c| c.is_ascii_digit()) { code } else { format!("{}7", &code[..3]) };
            let (tx, rx) = oneshot::channel();
            self.runtime.conversations.waiting.lock().expect("waiting").insert(
                id.clone(),
                Waiting {
                    platform: self.transport.platform(),
                    chat: self.chat.clone(),
                    user: self.user.clone(),
                    code: code.clone(),
                    tx,
                },
            );
            let _asked = Asked { conversations: &self.runtime.conversations, id: id.clone() };
            let question = Question {
                id,
                code,
                user: self.user.clone(),
                text: format!("{}Approve? {}", crate::approval::asker(), action.describe()),
            };
            if let Err(e) = self.transport.ask(&self.chat, &question).await {
                tracing::warn!("{}: {e}", self.transport.platform());
                return Answer::Deny;
            }
            tokio::time::timeout(APPROVAL_WAIT, rx).await.ok().and_then(Result::ok).unwrap_or(Answer::Deny)
        })
    }
}

/// The command in [text] and its arguments: `/status`, `/status@my_bot` (Telegram groups),
/// `!status`; None for anything else.
pub fn command(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let rest = text.strip_prefix('/').or_else(|| text.strip_prefix('!'))?;
    let (word, args) = rest.split_once(char::is_whitespace).map_or((rest, ""), |(w, a)| (w, a.trim()));
    let word = word.split('@').next().unwrap_or_default().to_ascii_lowercase();
    (!word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| (word, args.to_owned()))
}

/// The help text.
pub fn help(bot: &str) -> String {
    format!(
        "Autobot here{bot}, running on your own machine. Send a task, or ask for one later (\"remind me in 10 minutes to …\"). Voice messages work too.\n\n\
         /new: a new conversation\n\
         /stop: stop what I am doing\n\
         /status: model, uptime, queue, last error\n\
         /model: the model (/model <id> to switch)\n\
         /sethome: send scheduled results and notices here\n\
         /cron: scheduled tasks (/cron add <when> | <task>, /cron rm <id>)\n\
         /board: the team's background work (/board answer <id> <text>)\n\
         /actions: what I ran lately, and who allowed it\n\
         /memory: what I remember (/memory forget <id>)\n\
         /recall <what>: what earlier conversations said about it\n\
         /skills: your how-to notes\n\
         /bots: the bots on this machine"
    )
}

/// Handles one message for the bot from [transport].
pub async fn handle(runtime: &Arc<Runtime>, transport: &Arc<dyn Transport>, incoming: Incoming) -> Result<(), String> {
    let result = handle_inner(runtime, transport, incoming).await;
    if let Err(e) = &result {
        runtime.error(&format!("{}: {e}", transport.platform()));
    }
    result
}

async fn handle_inner(
    runtime: &Arc<Runtime>,
    transport: &Arc<dyn Transport>,
    incoming: Incoming,
) -> Result<(), String> {
    let platform = transport.platform();
    let home = runtime.home.clone();
    let Incoming { chat, place, user, text, direct, audio } = incoming;
    if !crate::pairing::allows(&home, platform, &user.id)? {
        // Strangers in a group or channel get nothing; in a direct conversation, a code.
        if !direct {
            return Ok(());
        }
        let code = crate::pairing::code_for(&home, platform, &user)?;
        tracing::info!(bot = %runtime.name, user = %user.id, name = %user.name, "{platform}: pairing code {code} issued");
        transport.send(&chat, &transport.pairing_text(&code)).await?;
        return Ok(());
    }
    let mut text = text.trim().to_owned();
    if let Some(audio) = audio {
        let heard = match audio.await {
            Ok(audio) => crate::voice::transcribe(&runtime.config.voice, &home, audio).await,
            Err(e) => Err(e),
        };
        match heard {
            Ok(heard) if !heard.trim().is_empty() => {
                let heard = heard.trim().to_owned();
                let shown: String = heard.chars().take(300).collect();
                let more = if shown.len() < heard.len() { "…" } else { "" };
                transport.send(&chat, &format!("heard: \"{shown}{more}\"")).await?;
                text = if text.is_empty() { heard } else { format!("{text}\n\n{heard}") };
            }
            Ok(_) => {
                transport.send(&chat, "✗ I heard nothing in that voice message.").await?;
                return Ok(());
            }
            Err(e) => {
                transport.send(&chat, &format!("✗ voice: {e}")).await?;
                return Ok(());
            }
        }
    }
    if text.is_empty() {
        transport.send(&chat, "Only text and voice messages for now.").await?;
        return Ok(());
    }
    // An answer to a question waiting here, in words.
    if transport.asking() != Asking::Buttons
        && let Some(note) = runtime.conversations.reply(platform, &chat, &user.id, &text, transport.asking())
    {
        transport.send(&chat, &format!("→ {note}")).await?;
        return Ok(());
    }
    let address = format!("{platform}:{}", user.id);
    let identities = crate::identity::Identities::load(&runtime.root).unwrap_or_default();
    let owner = identities.is_owner(&address);
    // A direct conversation with a linked person is theirs on every platform.
    let session = match identities.person(&address) {
        Some(person) if direct => format!("dm-{}", person.name),
        _ => session_name(&place),
    };
    let reply_to = format!("{platform}:{chat}");
    let command = command(&text);
    // Commands that never wait for a running turn.
    if let Some((word, args)) = &command {
        let immediate = match word.as_str() {
            "help" | "start" => {
                Some(help(&if runtime.default { String::new() } else { format!(" ({})", runtime.name) }))
            }
            "status" => Some(runtime.status_text()),
            "bots" if owner => Some(runtime.fleet_text()),
            "sethome" if owner => Some(match runtime.set_home_channel(&reply_to) {
                Ok(()) => format!("Home set: scheduled results and notices from {} come here.", runtime.name),
                Err(e) => format!("✗ {e}"),
            }),
            "bots" | "sethome" => Some("Only the owner can do that.".to_owned()),
            "model" => Some(model_command(runtime, args, owner).await),
            // Every conversation of the bot, so the owner's only.
            "recall" if owner && args.trim().is_empty() => Some("/recall <what to look for>".to_owned()),
            "recall" if owner => {
                let dir = home.join("sessions");
                Some(crate::recall::recall(&runtime.agent(), &dir, args.trim(), &session, &|_| {}).await)
            }
            "recall" => Some("Only the owner can do that.".to_owned()),
            "stop" => Some(match runtime.conversations.slots.lock().expect("slots").get(&session) {
                Some(slot) if slot.chat.try_lock().is_err() => {
                    slot.stop.notify_waiters();
                    "Stopping.".to_owned()
                }
                _ => "Nothing is running.".to_owned(),
            }),
            _ => None,
        };
        if let Some(reply) = immediate {
            transport.answer(&chat, &reply).await?;
            return Ok(());
        }
    }
    let slot = runtime.conversations.slot(&home, &session)?;
    let mut guard = match slot.chat.try_lock() {
        Ok(guard) => guard,
        Err(_) if command.is_none() => {
            // Steering: taken in before the agent's next step.
            slot.inbox.lock().expect("inbox").push(text.clone());
            transport.send(&chat, "↪ Noted: I'll take that in before my next step.").await?;
            return Ok(());
        }
        Err(_) if command.as_ref().is_some_and(|(w, _)| w == "new") => {
            transport.send(&chat, "A turn is running: /stop it first.").await?;
            return Ok(());
        }
        Err(_) => slot.chat.lock().await,
    };
    if let Some((word, args)) = &command {
        let reply = match word.as_str() {
            "new" => {
                guard.session.reset()?;
                guard.grants.clear();
                "New conversation.".to_owned()
            }
            "cron" => cron_command(&home, args, platform, &chat),
            "board" => crate::telegram::board_command(&home, args),
            "actions" => crate::telegram::actions_command(&home),
            "memory" => crate::telegram::memory_command(&home, args),
            "skills" => crate::telegram::skills_command(&home, args),
            other => format!("There is no /{other}. /help lists what there is."),
        };
        transport.answer(&chat, &reply).await?;
        return Ok(());
    }

    let agent = runtime.agent();
    let progress = start_progress(transport.clone(), chat.clone(), agent.clone());
    let typing = {
        let (transport, chat) = (transport.clone(), chat.clone());
        tokio::spawn(async move {
            loop {
                transport.typing(&chat).await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        })
    };
    let last_route = Mutex::new(None::<String>);
    let lines = progress.as_ref().map(|(tx, _)| tx.clone());
    let events = |event: Event| {
        let send = |member: Option<String>, line: String| {
            if let Some(tx) = &lines {
                let _ = tx.send((member, line));
            }
        };
        match event {
            Event::Tool(what) => {
                let (member, line) = split_member(&agent, what);
                send(member, format!("› {}", cut(&line, 300)));
            }
            Event::Refused(why) => {
                let (member, line) = split_member(&agent, why);
                send(member, format!("✗ {}", cut(&line, 300)));
            }
            Event::Member { name, text } => send(Some(name.to_owned()), cut(&format!("→ {text}"), 1500)),
            Event::Receipt { id, model, tier } => {
                *last_route.lock().expect("route") = Some(format!(
                    "{} · {} · receipt {}",
                    model.unwrap_or("?"),
                    tier.unwrap_or("?"),
                    &id[..id.len().min(8)]
                ));
            }
            _ => {}
        }
    };
    let approver = ChannelApprover {
        runtime: runtime.clone(),
        transport: transport.clone(),
        chat: chat.clone(),
        user: user.id.clone(),
    };
    let outbox = crate::media::Outbox::default();
    let context = crate::tools::TurnContext {
        session: session.clone(),
        telegram_chat: (platform == "telegram").then(|| chat.parse().ok()).flatten(),
        discord_channel: (platform == "discord").then(|| chat.clone()),
        reply_to: Some(reply_to),
        inbox: Some(slot.inbox.clone()),
        outbox: Some(outbox.clone()),
        ..Default::default()
    };
    runtime.turn_started();
    let stop = slot.stop.clone();
    let stopped = stop.notified();
    let result = {
        let Chat { session, grants } = &mut *guard;
        let turn = crate::tools::TURN.scope(context, agent.turn(session, &text, &approver, grants, &events));
        tokio::select! {
            result = turn => result,
            () = stopped => Err("Stopped.".to_owned()),
        }
    };
    runtime.turn_ended();
    // What is worth keeping, in the background; nothing is said about it in the chat.
    let _ = runtime.nudge(agent.clone(), guard.session.messages.clone());
    typing.abort();
    drop(lines);
    if let Some((tx, task)) = progress {
        drop(tx);
        let _ = task.await;
    }
    let reply = match result {
        Ok(outcome) => match last_route.lock().expect("route").take() {
            Some(route) => format!("{}{}", outcome.text, transport.footer(&route)),
            None => outcome.text,
        },
        Err(e) if e == "Stopped." => e,
        Err(e) => {
            runtime.error(&e);
            format!("✗ {e}")
        }
    };
    let made = std::mem::take(&mut *outbox.lock().expect("outbox"));
    let left = transport.answer_with(&chat, &reply, made).await?;
    send_files(transport.as_ref(), &chat, left).await
}

/// The files a turn made, after its answer: as the platform takes them, else where they are.
pub async fn send_files(transport: &dyn Transport, chat: &str, made: Vec<crate::media::Made>) -> Result<(), String> {
    for file in made {
        match transport.send_file(chat, &file).await {
            Ok(true) => {}
            Ok(false) => {
                transport.send(chat, &format!("(saved on the machine: {})", file.path.display())).await.map(drop)?
            }
            Err(e) => {
                tracing::warn!("{}: file not sent: {e}", transport.platform());
                transport.send(chat, &format!("✗ could not send {}: {e}", file.path.display())).await.map(drop)?;
            }
        }
    }
    Ok(())
}

/// One turn of [runtime] in its conversation [session], for a caller that is not a chat
/// platform (Home Assistant's conversation agent): in turn with others there, asking [approver],
/// with the nudge after it. Its answer.
pub async fn converse(
    runtime: &Arc<Runtime>,
    session: &str,
    text: &str,
    approver: &dyn Approver,
) -> Result<String, String> {
    let slot = runtime.conversations.slot(&runtime.home, session)?;
    let mut guard = slot.chat.lock().await;
    let agent = runtime.agent();
    let context = crate::tools::TurnContext {
        session: session.to_owned(),
        inbox: Some(slot.inbox.clone()),
        ..Default::default()
    };
    runtime.turn_started();
    let result = {
        let Chat { session, grants } = &mut *guard;
        crate::tools::TURN.scope(context, agent.turn(session, text, approver, grants, &|_| {})).await
    };
    runtime.turn_ended();
    let _ = runtime.nudge(agent, guard.session.messages.clone());
    result.map(|outcome| outcome.text)
}

type Lines = tokio::sync::mpsc::UnboundedSender<(Option<String>, String)>;

/// The task that shows progress as the platform does; None when it shows none.
fn start_progress(
    transport: Arc<dyn Transport>,
    chat: String,
    _agent: Arc<crate::agent::Agent>,
) -> Option<(Lines, tokio::task::JoinHandle<()>)> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(Option<String>, String)>();
    let task = match transport.progress() {
        Progress::Quiet => return None,
        // In order, from one task; a member with an account of its own posts its lines itself.
        Progress::Lines => tokio::spawn(async move {
            while let Some((member, line)) = rx.recv().await {
                if let Some(m) = &member
                    && transport.post_as(m, &chat, &line).await
                {
                    continue;
                }
                let line = match &member {
                    Some(m) => format!("[{m}] {line}"),
                    None => line,
                };
                let _ = transport.send(&chat, &cut(&line, transport.limit())).await;
            }
        }),
        // One message, edited as lines come (at most about once a second).
        Progress::Edited => tokio::spawn(async move {
            let mut shown: Vec<String> = Vec::new();
            let mut message: Option<String> = None;
            while let Some((member, line)) = rx.recv().await {
                let tag = |member: &Option<String>, line: String| match member {
                    Some(m) => format!("[{m}] {line}"),
                    None => line,
                };
                shown.push(tag(&member, line));
                tokio::time::sleep(Duration::from_millis(900)).await;
                while let Ok((member, line)) = rx.try_recv() {
                    shown.push(tag(&member, line));
                }
                let start = shown.len().saturating_sub(15);
                let text = cut(&shown[start..].join("\n"), transport.limit());
                message = match message {
                    Some(id) => {
                        if transport.edit(&chat, &id, &text).await.is_err() {
                            // No edits after all: a line per batch.
                            let _ = transport.send(&chat, &text).await;
                        }
                        Some(id)
                    }
                    None => transport.send(&chat, &text).await.ok().flatten(),
                };
            }
        }),
    };
    Some((tx, task))
}

/// `[coder] run: …` from a member: (Some("coder"), "run: …").
fn split_member(agent: &crate::agent::Agent, text: &str) -> (Option<String>, String) {
    if let Some(rest) = text.strip_prefix('[')
        && let Some((name, line)) = rest.split_once("] ")
        && agent.team.get(name).is_some()
    {
        return (Some(name.to_owned()), line.to_owned());
    }
    (None, text.to_owned())
}

pub fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit { text.to_owned() } else { text.chars().take(limit).collect::<String>() + "…" }
}

/// A session id for [place]: letters, digits, `-` and `_`, at most 64.
pub fn session_name(place: &str) -> String {
    let clean: String =
        place.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if clean.len() <= 64 {
        return clean;
    }
    // Long names keep their start and a hash of the whole, so they stay apart.
    let hash = invincible::token::hex(&<sha2::Sha256 as sha2::Digest>::digest(place.as_bytes())[..4]);
    format!("{}-{hash}", &clean[..55])
}

/// `/model`: what the bot uses and what the gateway serves; `/model <id>` switches (the owner).
async fn model_command(runtime: &Arc<Runtime>, args: &str, owner: bool) -> String {
    let agent = runtime.agent();
    let current = agent.gateway.model().to_owned();
    let models = agent.gateway.model_info().await.unwrap_or_default();
    let id = args.trim();
    if id.is_empty() {
        let served: Vec<String> = models.iter().map(|m| m.id.clone()).collect();
        let served = if served.is_empty() { "(the gateway did not say)".to_owned() } else { served.join(", ") };
        return format!("Model: {current}\nThe gateway serves: {served}, and auto.\n/model <id> switches.");
    }
    if !owner {
        return "Only the owner can switch the model.".to_owned();
    }
    let mut next = (*agent).clone();
    match crate::use_model(&mut next, &runtime.config, &models, id) {
        Ok(()) => {
            runtime.set_agent(next);
            format!("Model: {id}, for every conversation of {}, until it restarts.", runtime.name)
        }
        Err(e) => format!("✗ {e}"),
    }
}

/// `/cron`, `/cron add <when> | <task>`, `/cron rm <id>`: tasks added here answer here.
pub fn cron_command(home: &std::path::Path, args: &str, platform: &str, chat: &str) -> String {
    let result = (|| -> Result<String, String> {
        if let Some(rest) = args.strip_prefix("add") {
            let (when, task) = rest.split_once('|').ok_or(
                "/cron add <when> | <task>, for example: /cron add 0 8 * * 1-5 | summarize the overnight logs",
            )?;
            let mut schedules = crate::cron::Schedules::load(home)?;
            let telegram = (platform == "telegram").then(|| chat.parse::<i64>().ok()).flatten();
            let id = schedules.add_for(when, task, false, Some(format!("{platform}:{chat}")), telegram)?;
            if telegram.is_none()
                && let Some(s) = schedules.schedules.iter_mut().find(|s| s.id == id)
            {
                s.to = vec![format!("{platform}:{chat}")];
            }
            schedules.save(home)?;
            return Ok(format!("Added {id}. Answers come here. It runs with allowlisted commands only."));
        }
        if let Some(id) = args.strip_prefix("rm").map(str::trim) {
            let mut schedules = crate::cron::Schedules::load(home)?;
            if !schedules.remove(id) {
                return Err(format!("No scheduled task {id:?}."));
            }
            schedules.save(home)?;
            return Ok(format!("Removed {id}."));
        }
        let listing = crate::cron::listing(home)?;
        let lines: Vec<String> = listing["schedules"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let next = s["next"]
                    .as_i64()
                    .map(|t| crate::cron::local(t).format("%a %H:%M").to_string())
                    .unwrap_or("-".into());
                // A recipe from the phone goes by its name.
                let what = s["name"].as_str().map_or_else(
                    || s["task"].as_str().unwrap_or("").to_owned(),
                    |name| {
                        format!(
                            "{name} (from {})",
                            s["origin"].as_str().unwrap_or("the app").trim_start_matches("device:")
                        )
                    },
                );
                let off = if s["enabled"] == false { " (off)" } else { "" };
                format!(
                    "{} [{}] {what}{off} (next {next})",
                    s["id"].as_str().unwrap_or("?"),
                    s["when"].as_str().unwrap_or("?")
                )
            })
            .collect();
        Ok(if lines.is_empty() { "No scheduled tasks. /cron add <when> | <task>".to_owned() } else { lines.join("\n") })
    })();
    result.unwrap_or_else(|e| format!("✗ {e}"))
}

/// `platform:target`, as schedules, hooks and `/sethome` name where something goes:
/// `telegram:123456`, `slack:#ops`, `slack:C123/1712345678.000100` (a thread),
/// `email:me@example.com`, `signal:+15551234567`, `discord:987654321`, `matrix:!room:server`.
pub fn parse_address(address: &str) -> Result<(String, String), String> {
    let (platform, target) = address
        .trim()
        .split_once(':')
        .ok_or_else(|| format!("{address:?}: write platform:where, like slack:#ops or email:me@example.com"))?;
    let platform = platform.trim().to_ascii_lowercase();
    if !crate::pairing::PLATFORMS.contains(&platform.as_str()) {
        return Err(format!("{address:?}: the platform is one of {}", crate::pairing::PLATFORMS.join(", ")));
    }
    let target = target.trim();
    if target.is_empty() {
        return Err(format!("{address:?}: where on {platform}?"));
    }
    Ok((platform, target.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_in_every_spelling() {
        assert_eq!(command("/status"), Some(("status".into(), String::new())));
        assert_eq!(command("/status@my_bot"), Some(("status".into(), String::new())));
        assert_eq!(command("!model qwen3"), Some(("model".into(), "qwen3".into())));
        assert_eq!(command("  /cron add every 2h | x "), Some(("cron".into(), "add every 2h | x".into())));
        assert_eq!(command("/"), None);
        assert_eq!(command("/usr/bin/ls is where?"), None);
        assert_eq!(command("hello"), None);
    }

    #[test]
    fn approvals_in_words() {
        assert_eq!(parse_answer("yes"), Some(Answer::Once));
        assert_eq!(parse_answer("Yes 7KQM"), Some(Answer::Once));
        assert_eq!(parse_answer("\n  always, thanks"), Some(Answer::Always));
        assert_eq!(parse_answer("no"), Some(Answer::Deny));
        assert_eq!(parse_answer("No 7KQM"), Some(Answer::Deny));
        assert_eq!(parse_answer("no, use rsync instead"), Some(Answer::Instead("use rsync instead".into())));
        assert_eq!(parse_answer("nothing to add"), None);
        assert_eq!(parse_answer("what is this?"), None);
    }

    #[test]
    fn replies_answer_the_right_question() {
        let conversations = Conversations::default();
        let (tx, mut rx) = oneshot::channel();
        conversations.waiting.lock().unwrap().insert(
            "q1".into(),
            Waiting { platform: "signal", chat: "+1".into(), user: "+1".into(), code: "AB3D".into(), tx },
        );
        // Another chat, another user, or not an answer: nothing.
        assert_eq!(conversations.reply("signal", "+2", "+1", "yes", Asking::Reply), None);
        assert_eq!(conversations.reply("signal", "+1", "+9", "yes", Asking::Reply), None);
        assert_eq!(conversations.reply("signal", "+1", "+1", "what?", Asking::Reply), None);
        // By email the code is needed.
        assert_eq!(conversations.reply("signal", "+1", "+1", "yes", Asking::Code), None);
        assert_eq!(conversations.reply("signal", "+1", "+1", "yes ab3d", Asking::Code), Some("Allowed"));
        assert_eq!(rx.try_recv().unwrap(), Answer::Once);
        assert_eq!(conversations.waiting(), 0);
    }

    #[test]
    fn presses_count_only_for_the_one_asked() {
        let conversations = Conversations::default();
        let (tx, mut rx) = oneshot::channel();
        conversations.waiting.lock().unwrap().insert(
            "q1".into(),
            Waiting { platform: "slack", chat: "C1".into(), user: "U1".into(), code: "AB3D".into(), tx },
        );
        assert_eq!(conversations.press("q1", "U2", Answer::Once), Pressed::NotYours);
        assert_eq!(conversations.press("q1", "U1", Answer::Always), Pressed::Done("Allowed for this chat"));
        assert_eq!(rx.try_recv().unwrap(), Answer::Always);
        assert_eq!(conversations.press("q1", "U1", Answer::Once), Pressed::Expired);
    }

    #[test]
    fn session_names_stay_valid() {
        assert_eq!(session_name("telegram-123"), "telegram-123");
        assert_eq!(session_name("slack-C1-1712.0001"), "slack-C1-1712_0001");
        let long = session_name(&format!("email-{}", "x".repeat(100)));
        assert!(long.len() <= 64);
        assert_ne!(long, session_name(&format!("email-{}y", "x".repeat(100))));
    }

    #[test]
    fn addresses() {
        assert_eq!(parse_address("slack:#ops").unwrap(), ("slack".into(), "#ops".into()));
        assert_eq!(parse_address("Email:me@x.org").unwrap(), ("email".into(), "me@x.org".into()));
        assert_eq!(parse_address("matrix:!r:x.org").unwrap(), ("matrix".into(), "!r:x.org".into()));
        assert!(parse_address("fax:1").is_err());
        assert!(parse_address("slack:").is_err());
        assert!(parse_address("ops").is_err());
    }
}
