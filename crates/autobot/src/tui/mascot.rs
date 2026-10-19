//! Pip, Autobot's mascot: a small capsule robot with tall eyes, soft cheeks and a bent antenna.
//! The antenna light and the cheeks are the only signal-colored pixels. Drawn with half blocks
//! (`▀`, `▄`), two pixels to a character cell, so a 14×14 frame is 14 columns by 7 rows and the
//! mini one 7 by 3. Nothing is drawn without color: half blocks without it are noise. The same
//! grids are in BRAND.md and the SVGs in assets/brand/mascot.

use invincible::brand::{self, Color};

/// The full frames, 14×14: `R` the light, `O` the light off, `S` the stem, `B` the body, `K`
/// the visor, `E` the eyes, `C` the cheeks.
pub const IDLE: [&str; 14] = [
    "..............",
    "........RR....",
    "........S.....",
    ".......S......",
    "...BBBBBBBB...",
    "..BBBBBBBBBB..",
    ".BBKKKKKKKKBB.",
    ".BBKKEKKEKKBB.",
    ".BBKKEKKEKKBB.",
    ".BBKCKKKKCKBB.",
    "..BBBBBBBBBB..",
    "...BBBBBBBB...",
    "....BB..BB....",
    "..............",
];

pub const HAPPY: [&str; 14] = [
    "..............",
    ".......R..R...",
    "........RR....",
    ".......S......",
    "...BBBBBBBB...",
    "..BBBBBBBBBB..",
    ".BBKKKKKKKKBB.",
    ".BBKEKKKKEKBB.",
    ".BBEKEKKEKEBB.",
    ".BBKCKKKKCKBB.",
    "..BBBBBBBBBB..",
    "...BBBBBBBB...",
    "....BB..BB....",
    "..............",
];

pub const THINK: [&str; 14] = [
    "..............",
    ".........RR...",
    "........S.....",
    ".......S......",
    "...BBBBBBBB...",
    "..BBBBBBBBBB..",
    ".BBKKKEKKEKBB.",
    ".BBKKKEKKEKBB.",
    ".BBKKKKKKKKBB.",
    ".BBKKKKKKKKBB.",
    "..BBBBBBBBBB..",
    "...BBBBBBBB...",
    "....BB..BB....",
    "..............",
];

pub const WORK: [&str; 14] = [
    "..............",
    "........RR....",
    "........S.....",
    ".......S......",
    "...BBBBBBBB...",
    "..BBBBBBBBBB..",
    ".BBKKKKKKKKBB.",
    ".BBKKKKKKKKBB.",
    ".BBKKEKKEKKBB.",
    ".BBKKEKKEKKBB.",
    "..BBBBBBBBBB..",
    "...BBBBBBBB...",
    "....BB..BB....",
    "..............",
];

pub const OOPS: [&str; 14] = [
    "..............",
    "..............",
    ".........O....",
    ".......SS.....",
    "...BBBBBBBB...",
    "..BBBBBBBBBB..",
    ".BBKKKKKKKKBB.",
    ".BBKEKKKKEKBB.",
    ".BBKKEKKEKKBB.",
    ".BBKKKKKKKKBB.",
    "..BBBBBBBBBB..",
    "...BBBBBBBB...",
    "....BB..BB....",
    "..............",
];

/// 7×6, for beside the header's first three lines.
pub const MINI: [&str; 6] = [".....R.", "....S..", ".BBBBB.", "BKEKEKB", "BKKKKKB", ".BBBBB."];

fn color(c: u8, light: Color) -> Option<Color> {
    let rgb = |r, g, b, ansi| Some(Color { rgb: (r, g, b), ansi });
    match c {
        b'R' => Some(light),
        b'O' => rgb(0x4B, 0x49, 0x45, 239),
        // The cheeks: the light, half into the visor.
        b'C' => {
            let (r, g, b) = light.rgb;
            rgb(
                ((u16::from(r) + 0x1C) / 2) as u8,
                ((u16::from(g) + 0x1B) / 2) as u8,
                ((u16::from(b) + 0x19) / 2) as u8,
                60,
            )
        }
        b'S' => Some(brand::ASH),
        b'B' => rgb(0xC9, 0xC3, 0xBA, 251),
        b'K' => rgb(0x1C, 0x1B, 0x19, 234),
        b'E' => rgb(0xEF, 0xEA, 0xE2, 255),
        _ => None,
    }
}

/// The frame as terminal lines (one per two pixel rows); empty without color. [light]: the
/// antenna's color (Autobot's lilac; verdigris on the node).
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
        for frame in [&IDLE[..], &HAPPY[..], &THINK[..], &WORK[..], &OOPS[..]] {
            assert!(frame.len() == 14 && frame.iter().all(|r| r.len() == 14));
        }
        assert!(MINI.iter().all(|r| r.len() == 7));
        // Tests run without color (other tests compare plain text, so color is never turned on here).
        assert!(render(&IDLE, brand::LILAC).is_empty(), "nothing without color");
    }
}
