//! Random inputs for the property tests of the parsers that face the outside (SSE streams,
//! receipts, email, markdown, pastes). Small and dependency-free on purpose: a seeded xorshift,
//! and generators that mix the pieces those formats are made of with arbitrary bytes and text.
//!
//! [cases] runs a property over many seeds (`INVINCIBLE_FUZZ_CASES`, default 300) and names the
//! seed that failed, so a failure can be replayed with `INVINCIBLE_FUZZ_SEED`.

/// A seeded pseudo-random source (xorshift64*).
pub struct Gen {
    state: u64,
}

impl Gen {
    pub fn new(seed: u64) -> Self {
        Self { state: seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1 }
    }

    pub fn number(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A number in `0..n` (0 when n is 0).
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.number() % n as u64) as usize }
    }

    /// True about one time in [n].
    pub fn one_in(&mut self, n: usize) -> bool {
        self.below(n) == 0
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    /// A character: mostly ASCII, sometimes accented, wide, emoji, control or combining.
    pub fn char(&mut self) -> char {
        match self.below(20) {
            0 => *self.pick(&['é', 'ü', 'ß', 'Ж', 'λ']),
            1 => *self.pick(&['中', '文', '한', '日']),
            2 => *self.pick(&['🙂', '🚀', '👍', '❤']),
            3 => *self.pick(&['\t', '\r', '\u{0}', '\u{1b}', '\u{7f}']),
            4 => *self.pick(&['\u{301}', '\u{200b}', '\u{feff}', '\u{2028}']),
            5 => '\n',
            _ => (b' ' + self.below(95) as u8) as char,
        }
    }

    /// Up to [max] characters of [Gen::char].
    pub fn text(&mut self, max: usize) -> String {
        let n = self.below(max + 1);
        (0..n).map(|_| self.char()).collect()
    }

    /// Up to [max] arbitrary bytes.
    pub fn bytes(&mut self, max: usize) -> Vec<u8> {
        let n = self.below(max + 1);
        (0..n).map(|_| self.number() as u8).collect()
    }

    /// Text built from [pieces] (the syntax of a format), with random text between them.
    pub fn assemble(&mut self, pieces: &[&str], max: usize) -> String {
        let n = self.below(max + 1);
        let mut out = String::new();
        for _ in 0..n {
            if self.one_in(3) {
                out.push_str(&self.text(6));
            } else {
                let piece = pieces[self.below(pieces.len())];
                out.push_str(piece);
            }
        }
        out
    }

    /// [bytes] cut at random points (empty pieces included now and then).
    pub fn split<'a>(&mut self, bytes: &'a [u8]) -> Vec<&'a [u8]> {
        let mut parts = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let n = if self.one_in(10) { 0 } else { 1 + self.below(bytes.len() - at) };
            let n = n.min(1 + self.below(16)).min(bytes.len() - at);
            parts.push(&bytes[at..at + n]);
            at += n;
        }
        parts
    }
}

/// Runs [property] with a [Gen] for each case; a failure names its seed.
pub fn cases(name: &str, property: impl Fn(&mut Gen)) {
    let seeds: Vec<u64> = match std::env::var("INVINCIBLE_FUZZ_SEED").ok().and_then(|s| s.parse().ok()) {
        Some(seed) => vec![seed],
        None => {
            let n = std::env::var("INVINCIBLE_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
            (1..=n).collect()
        }
    };
    for seed in seeds {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| property(&mut Gen::new(seed))));
        if let Err(e) = outcome {
            let why = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_default();
            panic!("{name}: failed with INVINCIBLE_FUZZ_SEED={seed}: {why}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Gen, cases};

    #[test]
    fn the_same_seed_gives_the_same_input_and_splits_keep_every_byte() {
        let (mut a, mut b) = (Gen::new(7), Gen::new(7));
        assert_eq!(a.text(40), b.text(40));
        cases("split", |g| {
            let bytes = g.bytes(200);
            let joined: Vec<u8> = g.split(&bytes).concat();
            assert_eq!(joined, bytes);
        });
    }
}
