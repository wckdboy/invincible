//! Autobot's mascot: a small square robot whose antenna light is the only signal-colored pixel.
//! Drawn with half blocks (`▀`, `▄`), two pixels to a character cell, so a 12×12 frame is 12
//! columns by 6 rows and the mini one 6 by 3. Nothing is drawn without color: half blocks
//! without it are noise. The same grids are in BRAND.md and the SVGs in assets/brand/mascot.

use invincible::brand::{self, Color};

/// The full frames, 12×12: `R` the antenna light, `S` its stem, `B` the body, `K` the visor,
/// `E` the eyes.
pub const IDLE: [&str; 12] = [
    ".....RR.....",
    ".....SS.....",
    "..BBBBBBBB..",
    ".BBBBBBBBBB.",
    ".BKKKKKKKKB.",
    ".BKEEKKEEKB.",
    ".BKEEKKEEKB.",
    ".BKKKKKKKKB.",
    ".BBBBBBBBBB.",
    "..BBBBBBBB..",
    "..BB....BB..",
    "............",
];

pub const HAPPY: [&str; 12] = [
    ".....RR.....",
    ".....SS.....",
    "..BBBBBBBB..",
    ".BBBBBBBBBB.",
    ".BKKKKKKKKB.",
    ".BKEKKKKEKB.",
    ".BEKEKKEKEB.",
    ".BKKKKKKKKB.",
    ".BBBBBBBBBB.",
    "..BBBBBBBB..",
    "..BB....BB..",
    "............",
];

/// 6×6, for beside the header's first three lines.
pub const MINI: [&str; 6] = ["..RR..", "BBBBBB", "BEKKEB", "BKKKKB", "BBBBBB", ".B..B."];

fn color(c: u8, light: Color) -> Option<Color> {
    let rgb = |r, g, b, ansi| Some(Color { rgb: (r, g, b), ansi });
    match c {
        b'R' => Some(light),
        b'S' => Some(brand::ASH),
        b'B' => rgb(0xC9, 0xC3, 0xBA, 251),
        b'K' => rgb(0x1C, 0x1B, 0x19, 234),
        b'E' => rgb(0xEF, 0xEA, 0xE2, 255),
        _ => None,
    }
}

/// The frame as terminal lines (one per two pixel rows); empty without color. [light]: the
/// antenna's color (Autobot's vermilion; ash when something failed).
pub fn render(frame: &[&str], light: Color) -> Vec<String> {
    if !brand::colored() {
        return Vec::new();
    }
    let fg = |c: Color| esc(38, c);
    let bg = |c: Color| esc(48, c);
    frame
        .chunks(2)
        .map(|rows| {
            let top = rows[0].as_bytes();
            let bottom = rows.get(1).map_or(&[][..], |r| r.as_bytes());
            let mut line = String::new();
            for (x, &pixel) in top.iter().enumerate() {
                let (t, b) = (color(pixel, light), bottom.get(x).and_then(|c| color(*c, light)));
                line.push_str(&match (t, b) {
                    (None, None) => " ".to_owned(),
                    (Some(t), None) => format!("{}▀\x1b[0m", fg(t)),
                    (None, Some(b)) => format!("{}▄\x1b[0m", fg(b)),
                    (Some(t), Some(b)) => format!("{}{}▀\x1b[0m", fg(t), bg(b)),
                });
            }
            line
        })
        .collect()
}

fn esc(layer: u8, c: Color) -> String {
    // The 256-color fallback is close enough for a few pixels.
    if std::env::var("COLORTERM").is_ok_and(|v| v == "truecolor" || v == "24bit") {
        let (r, g, b) = c.rgb;
        format!("\x1b[{layer};2;{r};{g};{b}m")
    } else {
        format!("\x1b[{layer};5;{}m", c.ansi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_square_and_render_to_half_rows() {
        for frame in [&IDLE[..], &HAPPY[..]] {
            assert!(frame.iter().all(|r| r.len() == 12));
        }
        assert!(MINI.iter().all(|r| r.len() == 6));
        // Tests run without color (other tests compare plain text, so color is never turned on here).
        assert!(render(&IDLE, brand::VERMILION).is_empty(), "nothing without color");
    }
}
