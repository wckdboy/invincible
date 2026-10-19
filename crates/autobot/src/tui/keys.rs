//! The keyboard while a turn runs: what the owner types shows under the spinner and, on Enter,
//! goes to the agent before its next step (steering); Esc stops the turn; an approval question
//! takes the next key. The terminal stays in non-canonical, no-echo mode for the turn (output
//! processing is kept, so the rest of the screen prints as usual) and is put back after.

use std::os::fd::{AsFd, BorrowedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rustix::termios::{self, LocalModes, OptionalActions, QueueSelector, SpecialCodeIndex};

/// What a key press is for, while a turn runs.
#[derive(Default)]
struct Shared {
    /// A question is waiting for one key.
    answer: Option<tokio::sync::oneshot::Sender<char>>,
    /// What is being typed (not yet sent).
    typing: String,
}

pub struct TurnKeys {
    shared: Arc<Mutex<Shared>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    saved: termios::Termios,
}

/// What the keyboard asks of the turn.
pub enum Key {
    /// Esc: stop the turn.
    Stop,
    /// Enter after text: send it to the agent.
    Steer(String),
    /// The text being typed changed (to redraw it).
    Typing,
}

impl TurnKeys {
    /// Starts reading the keyboard (None when stdin is not a terminal); what it asks for comes
    /// on the returned channel.
    pub fn start() -> Option<(Self, tokio::sync::mpsc::UnboundedReceiver<Key>)> {
        let stdin = std::io::stdin();
        let fd = stdin.as_fd();
        if !termios::isatty(fd) {
            return None;
        }
        let saved = termios::tcgetattr(fd).ok()?;
        let mut raw = saved.clone();
        // Keys one at a time, not shown; ctrl+c still interrupts (ISIG), output as usual.
        raw.local_modes.remove(LocalModes::ICANON | LocalModes::ECHO);
        raw.special_codes[SpecialCodeIndex::VMIN] = 1;
        raw.special_codes[SpecialCodeIndex::VTIME] = 0;
        termios::tcsetattr(fd, OptionalActions::Now, &raw).ok()?;
        // Whatever was typed before the turn started is not for it.
        let _ = termios::tcflush(fd, QueueSelector::IFlush);
        let shared = Arc::new(Mutex::new(Shared::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let thread = {
            let (shared, stop) = (shared.clone(), stop.clone());
            std::thread::spawn(move || read(std::io::stdin().as_fd(), &shared, &stop, &tx))
        };
        Some((Self { shared, stop, thread: Some(thread), saved }, rx))
    }

    /// The next key, for a question (y, a, n…); None when the keyboard stopped.
    pub async fn answer(&self) -> Option<char> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut shared = self.shared.lock().expect("keys");
            shared.answer = Some(tx);
        }
        // Drop anything typed ahead of the question.
        let _ = termios::tcflush(std::io::stdin().as_fd(), QueueSelector::IFlush);
        rx.await.ok()
    }

    /// What is being typed now.
    pub fn typing(&self) -> String {
        self.shared.lock().expect("keys").typing.clone()
    }
}

impl Drop for TurnKeys {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = termios::tcsetattr(std::io::stdin().as_fd(), OptionalActions::Now, &self.saved);
    }
}

/// Reads keys until [stop]: polls, so it notices [stop] within a tenth of a second.
fn read(fd: BorrowedFd, shared: &Mutex<Shared>, stop: &AtomicBool, tx: &tokio::sync::mpsc::UnboundedSender<Key>) {
    let mut pending: Vec<u8> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        let Some(byte) = next_byte(fd, 100) else { continue };
        let mut s = shared.lock().expect("keys");
        // A question takes the next key, whatever it is.
        if let Some(answer) = s.answer.take() {
            let key = match byte {
                0x1b => {
                    // An escape sequence (an arrow key) is not an answer; a lone Esc is no.
                    drop(s);
                    drain_sequence(fd);
                    'n'
                }
                b'\r' | b'\n' => 'n',
                b => (b as char).to_ascii_lowercase(),
            };
            let _ = answer.send(key);
            continue;
        }
        match byte {
            0x1b => {
                drop(s);
                // A lone Esc stops the turn; an escape sequence (arrows) is ignored.
                if !drain_sequence(fd) {
                    let _ = tx.send(Key::Stop);
                }
            }
            b'\r' | b'\n' => {
                let text = std::mem::take(&mut s.typing);
                pending.clear();
                if !text.trim().is_empty() {
                    let _ = tx.send(Key::Steer(text.trim().to_owned()));
                }
            }
            0x7f | 0x08 => {
                s.typing.pop();
                let _ = tx.send(Key::Typing);
            }
            // ctrl+u: start the line over.
            0x15 => {
                s.typing.clear();
                let _ = tx.send(Key::Typing);
            }
            b if b < 0x20 => {}
            b => {
                pending.push(b);
                match std::str::from_utf8(&pending) {
                    Ok(text) => {
                        s.typing.push_str(text);
                        pending.clear();
                        let _ = tx.send(Key::Typing);
                    }
                    Err(e) if e.error_len().is_some() => pending.clear(),
                    Err(_) => {} // the rest of a character is coming
                }
            }
        }
    }
}

/// One byte from [fd], waiting at most [ms].
fn next_byte(fd: BorrowedFd, ms: i64) -> Option<u8> {
    let mut fds = [rustix::event::PollFd::new(&fd, rustix::event::PollFlags::IN)];
    let timeout = rustix::event::Timespec { tv_sec: 0, tv_nsec: ms * 1_000_000 };
    if rustix::event::poll(&mut fds, Some(&timeout)).ok()? == 0 {
        return None;
    }
    let mut byte = [0u8];
    (rustix::io::read(fd, &mut byte).ok()? == 1).then_some(byte[0])
}

/// After an Esc: reads the rest of an escape sequence if one follows at once; whether there
/// was one.
fn drain_sequence(fd: BorrowedFd) -> bool {
    let mut any = false;
    while next_byte(fd, 25).is_some() {
        any = true;
    }
    any
}
