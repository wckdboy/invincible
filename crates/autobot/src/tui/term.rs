//! The terminal while the chat runs: keys one at a time (raw input, output processing kept),
//! bracketed paste, and a live region at the bottom (the composer, what the agent is doing, the
//! status line) redrawn in place. Everything else is printed above it into the normal
//! scrollback: there is no alternate screen. Redraws change only the rows that changed, inside
//! synchronized output where the terminal has it; the terminal is put back on exit, on a panic,
//! and around ctrl+z. Where the terminal speaks the kitty keyboard protocol, it is pushed
//! (shift+enter and a lone Esc then arrive as themselves) and popped whenever the terminal is put
//! back; the window's title says `autobot · <project>` while the chat runs, and is put back too.

use std::io::Write;
use std::os::fd::AsFd;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use super::osc::{self, Notify};
use super::style;

/// What is drawn in the live region now.
#[derive(Default)]
struct Screen {
    /// The terminal is ours (raw, live region drawn); otherwise printing is plain.
    active: bool,
    lines: Vec<String>,
    /// Where the cursor was left: row (from the region's top) and column.
    cursor: (usize, usize),
    show_cursor: bool,
    width: usize,
    /// The scrollback ends with a blank line.
    blank: bool,
}

static SCREEN: Mutex<Screen> = Mutex::new(Screen {
    active: false,
    lines: Vec::new(),
    cursor: (0, 0),
    show_cursor: false,
    width: 80,
    blank: false,
});

/// The input thread leaves the terminal alone while this is set (another reader has it).
static PAUSED: AtomicBool = AtomicBool::new(false);

/// The terminal answered the kitty keyboard protocol's query: it is pushed while the terminal is
/// ours.
static KITTY: AtomicBool = AtomicBool::new(false);

/// The title set while the terminal is ours (the one before is saved and put back).
static TITLE: Mutex<Option<String>> = Mutex::new(None);

/// Whether the window has focus, as the terminal reported it: unknown, yes, no.
static FOCUS: AtomicU8 = AtomicU8::new(0);

/// How notifications reach the owner: [Notify] as a number (Osc9, Bell, Off).
static NOTIFY: AtomicU8 = AtomicU8::new(1);

const SYNC_START: &str = "\x1b[?2026h";
const SYNC_END: &str = "\x1b[?2026l";

fn write_out(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// Rows the region's lines take above the cursor at [width] (lines that fit take one; after a
/// resize the terminal may have wrapped them).
fn rows_above_cursor(s: &Screen, width: usize) -> usize {
    let rows = |line: &str| style::width(line).max(1).div_ceil(width.max(1));
    let above: usize = s.lines.iter().take(s.cursor.0).map(|l| rows(l)).sum();
    above + s.cursor.1 / width.max(1)
}

/// Moves to the top of the drawn region (its first column).
fn to_top(s: &Screen, width: usize, out: &mut String) {
    out.push('\r');
    let up = rows_above_cursor(s, width);
    if up > 0 {
        out.push_str(&format!("\x1b[{up}A"));
    }
}

/// Draws [lines] from the top of the region (where the cursor is), the rows that differ from
/// [old] only, then leaves the cursor at [cursor].
fn paint(old: &[String], lines: &[String], cursor: Option<(usize, usize)>, out: &mut String) {
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push_str("\r\n");
        }
        if old.get(i) != Some(line) {
            out.push('\r');
            out.push_str(line);
            out.push_str("\x1b[K");
        }
    }
    // What is left of a taller region before: the rows under the last one cleared.
    if old.len() > lines.len() {
        out.push_str("\r\n\x1b[J\x1b[1A");
    }
    let last = lines.len().saturating_sub(1);
    let (row, col) = cursor.unwrap_or((last, 0));
    if last > row {
        out.push_str(&format!("\x1b[{}A", last - row));
    }
    out.push('\r');
    if col > 0 {
        out.push_str(&format!("\x1b[{col}C"));
    }
}

/// Draws the live region: [lines] (each at most the width), the cursor at [cursor] (row, column)
/// or hidden.
pub fn draw(lines: Vec<String>, cursor: Option<(usize, usize)>) {
    let mut s = SCREEN.lock().expect("screen");
    if !s.active {
        return;
    }
    if s.lines == lines && s.show_cursor == cursor.is_some() && cursor.is_none_or(|c| c == s.cursor) {
        return;
    }
    let mut out = String::from(SYNC_START);
    out.push_str("\x1b[?25l");
    to_top(&s, s.width, &mut out);
    paint(&s.lines, &lines, cursor, &mut out);
    if cursor.is_some() {
        out.push_str("\x1b[?25h");
    }
    out.push_str(SYNC_END);
    write_out(&out);
    s.cursor = cursor.unwrap_or((lines.len().saturating_sub(1), 0));
    s.show_cursor = cursor.is_some();
    s.lines = lines;
}

/// Prints [text] into the scrollback, above the live region (which is drawn again under it).
pub fn print(text: &str) {
    if text.is_empty() {
        return;
    }
    let mut s = SCREEN.lock().expect("screen");
    s.blank = text == "\n" || text.ends_with("\n\n");
    if !s.active {
        drop(s);
        write_out(text);
        return;
    }
    let mut out = String::from(SYNC_START);
    out.push_str("\x1b[?25l");
    to_top(&s, s.width, &mut out);
    out.push_str("\x1b[J");
    out.push_str(&text.replace("\r\n", "\n").replace('\n', "\r\n"));
    if !text.ends_with('\n') {
        out.push_str("\r\n");
    }
    let lines = std::mem::take(&mut s.lines);
    let cursor = s.show_cursor.then_some(s.cursor);
    paint(&[], &lines, cursor, &mut out);
    if s.show_cursor {
        out.push_str("\x1b[?25h");
    }
    out.push_str(SYNC_END);
    write_out(&out);
    s.lines = lines;
}

/// A line into the scrollback.
pub fn say(line: &str) {
    print(&format!("{line}\n"));
}

/// The terminal changed size: the region is cleared (as the terminal may have re-wrapped it) and
/// drawn again by the next [draw].
pub fn resized(width: usize) {
    let mut s = SCREEN.lock().expect("screen");
    if !s.active {
        return;
    }
    let mut out = String::from(SYNC_START);
    to_top(&s, width, &mut out);
    out.push_str("\x1b[J");
    out.push_str(SYNC_END);
    write_out(&out);
    s.lines.clear();
    s.cursor = (0, 0);
    s.width = width;
}

/// Clears the screen and the scrollback (ctrl+l, /clear); the region is drawn again at the top.
pub fn clear() {
    let mut s = SCREEN.lock().expect("screen");
    write_out("\x1b[H\x1b[2J\x1b[3J");
    s.lines.clear();
    s.cursor = (0, 0);
}

/// Whether the scrollback ends with a blank line (the live region need not start with one).
pub fn after_blank() -> bool {
    SCREEN.lock().expect("screen").blank
}

/// Whether the terminal is ours now.
pub fn active() -> bool {
    SCREEN.lock().expect("screen").active
}

/// The terminal, taken for the chat; put back when this is dropped.
pub struct Terminal {
    _private: (),
}

fn raw_on() -> std::io::Result<()> {
    crossterm::terminal::enable_raw_mode()?;
    // Output processing back on: a stray newline (a library's message) still starts its line.
    let fd = std::io::stdout();
    if let Ok(mut modes) = rustix::termios::tcgetattr(fd.as_fd()) {
        modes.output_modes.insert(rustix::termios::OutputModes::OPOST | rustix::termios::OutputModes::ONLCR);
        let _ = rustix::termios::tcsetattr(fd.as_fd(), rustix::termios::OptionalActions::Now, &modes);
    }
    let mut out = String::from("\x1b[?2004h");
    out.push_str(osc::FOCUS_ON);
    if KITTY.load(Ordering::SeqCst) {
        out.push_str(osc::KITTY_PUSH);
    }
    if let Some(title) = TITLE.lock().map(|t| t.clone()).unwrap_or_default() {
        out.push_str(osc::TITLE_SAVE);
        out.push_str(&osc::title(&title));
    }
    write_out(&out);
    Ok(())
}

fn raw_off() {
    let mut out = String::from("\x1b[?2004l\x1b[?25h");
    out.push_str(osc::FOCUS_OFF);
    if KITTY.load(Ordering::SeqCst) {
        out.push_str(osc::KITTY_POP);
    }
    // A panic while the title was being read holds no lock worth waiting for.
    if TITLE.try_lock().is_ok_and(|t| t.is_some()) {
        out.push_str(osc::TITLE_RESTORE);
    }
    write_out(&out);
    let _ = crossterm::terminal::disable_raw_mode();
}

/// Whether the kitty keyboard protocol is on (shift+enter is its own key).
pub fn kitty() -> bool {
    KITTY.load(Ordering::SeqCst)
}

/// The window gained or lost focus (the terminal said so).
pub fn focused(yes: bool) {
    FOCUS.store(if yes { 1 } else { 2 }, Ordering::SeqCst);
}

/// How notifications reach the owner from now on.
pub fn set_notify(kind: Notify) {
    NOTIFY.store(
        match kind {
            Notify::Osc9 => 0,
            Notify::Bell => 1,
            Notify::Off => 2,
        },
        Ordering::SeqCst,
    );
}

/// Tells the owner [text] wants them (a long turn ended, a question waits): a desktop
/// notification or the bell; nothing without a terminal, or while the window has focus.
pub fn notify(text: &str) {
    let kind = match NOTIFY.load(Ordering::SeqCst) {
        0 => Notify::Osc9,
        1 => Notify::Bell,
        _ => Notify::Off,
    };
    if FOCUS.load(Ordering::SeqCst) == 1 {
        return;
    }
    emit(&osc::notification(kind, text, std::env::var_os("TMUX").is_some()));
}

/// Writes [seq] (nothing on the screen: a title, the clipboard) while the terminal is ours;
/// whether it was written.
pub fn emit(seq: &str) -> bool {
    let s = SCREEN.lock().expect("screen");
    if !s.active || seq.is_empty() {
        return false;
    }
    write_out(seq);
    true
}

impl Terminal {
    /// Takes the terminal (None when stdin or stdout is not one), its window titled [title].
    pub fn take(title: &str) -> Option<Self> {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return None;
        }
        // Asked once (`CSI ? u`, then the device attributes every terminal answers): a terminal
        // that does not know the protocol answers only the second.
        let dumb = std::env::var("TERM").is_ok_and(|t| t == "dumb");
        KITTY.store(!dumb && crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false), Ordering::SeqCst);
        *TITLE.lock().expect("title") = Some(title.to_owned());
        raw_on().ok()?;
        {
            let mut s = SCREEN.lock().expect("screen");
            s.active = true;
            s.width = style::columns();
            s.lines.clear();
            s.cursor = (0, 0);
        }
        // A panic puts the terminal back before it is reported.
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            leave();
            previous(info);
        }));
        Some(Self { _private: () })
    }

    /// ctrl+z: stops the process the way a shell expects, and takes the terminal back on `fg`.
    pub fn stop(&self) {
        suspend();
        let _ = rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::TSTP);
        resume();
    }
}

/// Hands the terminal over (a key asked for, ctrl+z): the region cleared, keys back to lines;
/// [resume] takes it back.
pub fn suspend() {
    PAUSED.store(true, Ordering::SeqCst);
    // The input thread notices within its poll.
    std::thread::sleep(std::time::Duration::from_millis(60));
    leave();
}

pub fn resume() {
    let _ = raw_on();
    let mut s = SCREEN.lock().expect("screen");
    s.active = true;
    s.width = style::columns();
    s.lines.clear();
    s.cursor = (0, 0);
    drop(s);
    PAUSED.store(false, Ordering::SeqCst);
}

/// The terminal put back now (the process is about to end).
pub fn restore() {
    leave();
}

/// The region cleared and the terminal put back.
fn leave() {
    // A panic while the screen was being drawn holds its lock: then the terminal only.
    let mut s = match SCREEN.try_lock() {
        Ok(s) => s,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            raw_off();
            return;
        }
    };
    if s.active {
        let mut out = String::new();
        to_top(&s, s.width, &mut out);
        out.push_str("\x1b[J");
        write_out(&out);
        s.active = false;
        s.lines.clear();
        raw_off();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        leave();
    }
}

/// Reads the keyboard on a thread of its own; what it reads comes on the channel.
pub fn keys() -> tokio::sync::mpsc::UnboundedReceiver<crossterm::event::Event> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        loop {
            if PAUSED.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            match crossterm::event::poll(std::time::Duration::from_millis(40)) {
                Ok(true) => {}
                Ok(false) => {
                    if tx.is_closed() {
                        return;
                    }
                    continue;
                }
                Err(_) => return,
            }
            if PAUSED.load(Ordering::SeqCst) {
                continue;
            }
            match crossterm::event::read() {
                Ok(event) => {
                    if tx.send(event).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::paint;

    #[test]
    fn a_redraw_writes_only_what_changed() {
        let old = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let new = vec!["a".to_owned(), "B".to_owned()];
        let mut out = String::new();
        paint(&old, &new, Some((0, 2)), &mut out);
        assert_eq!(out, "\r\n\rB\x1b[K\r\n\x1b[J\x1b[1A\x1b[1A\r\x1b[2C");
        let mut out = String::new();
        paint(&new, &new, None, &mut out);
        assert_eq!(out, "\r\n\r", "nothing to write, the cursor at the last row");
    }
}
