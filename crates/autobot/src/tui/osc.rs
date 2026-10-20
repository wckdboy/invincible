//! What the chat says to the terminal itself rather than on the screen: the window's title
//! (saved and put back), a notification when something wants the owner, the clipboard (OSC 52),
//! and the kitty keyboard protocol's push and pop. Each is a string built here (so it can be
//! tested) and written by [super::term]; inside tmux the ones tmux would swallow go through its
//! passthrough.

/// The kitty keyboard protocol: push "disambiguate escape codes" (Esc, alt+key and shift+enter
/// arrive as their own sequences), and pop it.
pub const KITTY_PUSH: &str = "\x1b[>1u";
pub const KITTY_POP: &str = "\x1b[<1u";

/// The title stack (xterm's, which iTerm2, kitty, WezTerm, Ghostty and tmux keep too): the
/// title before ours is saved, then put back.
pub const TITLE_SAVE: &str = "\x1b[22;0t";
pub const TITLE_RESTORE: &str = "\x1b[23;0t";

/// Focus reporting: the terminal says when its window gains (`CSI I`) and loses (`CSI O`) focus.
pub const FOCUS_ON: &str = "\x1b[?1004h";
pub const FOCUS_OFF: &str = "\x1b[?1004l";

/// [text] without control characters (an escape in a title or a notification would end it, or
/// start something else), on one line.
fn clean(text: &str, max: usize) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect::<String>().trim().to_owned()
}

/// The window and tab title (OSC 0): `autobot · <project>`.
pub fn title(text: &str) -> String {
    format!("\x1b]0;{}\x07", clean(text, 120))
}

/// How a notification reaches the owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notify {
    /// A desktop notification (OSC 9): iTerm2, Ghostty, WezTerm, kitty.
    Osc9,
    /// The bell: the terminal's own way (a sound, a badge, a bounce).
    Bell,
    Off,
}

/// Which terminal this is, from the environment it set ([var]); what notifies there.
pub fn notify_kind(var: impl Fn(&str) -> Option<String>) -> Notify {
    let is = |name: &str, values: &[&str]| var(name).is_some_and(|v| values.iter().any(|x| v.eq_ignore_ascii_case(x)));
    let osc9 = is("TERM_PROGRAM", &["iTerm.app", "WezTerm", "ghostty"])
        // Through tmux (and ssh) these stay set by the terminal outside.
        || is("LC_TERMINAL", &["iTerm2"])
        || is("TERM", &["xterm-kitty", "xterm-ghostty"])
        || var("KITTY_WINDOW_ID").is_some()
        || var("GHOSTTY_RESOURCES_DIR").is_some()
        || var("WEZTERM_PANE").is_some();
    if osc9 { Notify::Osc9 } else { Notify::Bell }
}

/// The sequence for a notification saying [text]; inside tmux ([tmux]), passed through.
pub fn notification(kind: Notify, text: &str, tmux: bool) -> String {
    match kind {
        Notify::Off => String::new(),
        // tmux passes the bell on itself (and marks the window).
        Notify::Bell => "\x07".to_owned(),
        Notify::Osc9 => {
            let seq = format!("\x1b]9;{}\x07", clean(text, 200));
            if tmux { passthrough(&seq) } else { seq }
        }
    }
}

/// [text] onto the system clipboard (OSC 52); inside tmux, passed through.
pub fn clipboard(text: &str, tmux: bool) -> String {
    let seq = format!("\x1b]52;c;{}\x07", base64(text.as_bytes()));
    if tmux { passthrough(&seq) } else { seq }
}

/// [seq] wrapped for tmux to hand to the terminal outside (`allow-passthrough on`): in a DCS,
/// its escapes doubled.
pub fn passthrough(seq: &str) -> String {
    format!("\x1bPtmux;{}\x1b\\", seq.replace('\x1b', "\x1b\x1b"))
}

/// Standard base64, padded.
pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ABC[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Notify, base64, clipboard, notification, notify_kind, passthrough, title};

    #[test]
    fn base64_is_the_standard_one() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64("ñ ✓".as_bytes()), "w7Eg4pyT");
    }

    #[test]
    fn titles_and_notifications_are_one_clean_line() {
        assert_eq!(title("autobot · app"), "\x1b]0;autobot · app\x07");
        assert_eq!(title("a\x1b]0;evil\x07b\n"), "\x1b]0;a ]0;evil b\x07", "no escapes get through");
        assert_eq!(notification(Notify::Osc9, "autobot: done", false), "\x1b]9;autobot: done\x07");
        assert_eq!(notification(Notify::Bell, "x", true), "\x07");
        assert_eq!(notification(Notify::Off, "x", false), "");
        assert_eq!(
            notification(Notify::Osc9, "hi", true),
            "\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\",
            "through tmux, wrapped with its escapes doubled"
        );
    }

    #[test]
    fn the_clipboard_goes_through_tmux() {
        assert_eq!(clipboard("hi", false), "\x1b]52;c;aGk=\x07");
        assert_eq!(clipboard("hi", true), passthrough("\x1b]52;c;aGk=\x07"));
        assert_eq!(passthrough("\x1b]52;c;aGk=\x07"), "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
    }

    #[test]
    fn terminals_that_show_notifications_are_known() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
        };
        assert_eq!(notify_kind(env(&[("TERM_PROGRAM", "iTerm.app")])), Notify::Osc9);
        assert_eq!(notify_kind(env(&[("TERM_PROGRAM", "ghostty")])), Notify::Osc9);
        assert_eq!(notify_kind(env(&[("TERM", "xterm-kitty")])), Notify::Osc9);
        assert_eq!(notify_kind(env(&[("TERM_PROGRAM", "tmux"), ("LC_TERMINAL", "iTerm2")])), Notify::Osc9);
        assert_eq!(notify_kind(env(&[("TERM_PROGRAM", "Apple_Terminal")])), Notify::Bell);
        assert_eq!(notify_kind(env(&[])), Notify::Bell);
    }
}
