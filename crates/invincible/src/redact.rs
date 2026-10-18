//! Redaction before a request leaves the node (spec/redaction.md): the high-precision subset of
//! Autobot's `PiiDetector`, placeholders `[KIND_N]`, and restoring them in answers (streams too).
//!
//! The `regex` crate has no look-around or back-references, so each pattern matches its one
//! character of context instead and captures the core in group 1. Leftmost-first matching picks
//! the same core a backtracking engine with look-around would.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Email,
    Iban,
    Card,
    Phone,
}

impl Kind {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::Iban => "IBAN",
            Self::Card => "CARD",
            Self::Phone => "PHONE",
        }
    }

    fn priority(self) -> u8 {
        match self {
            Self::Email => 0,
            Self::Iban => 1,
            Self::Card => 2,
            Self::Phone => 5,
        }
    }

    fn parse(tag: &str) -> Option<Self> {
        [Self::Email, Self::Iban, Self::Card, Self::Phone].into_iter().find(|k| k.tag() == tag)
    }
}

/// One finding: byte range and kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("redaction pattern")
}

// `\w` here is ASCII, as in Autobot (Java regex without UNICODE_CHARACTER_CLASS).
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^\p{L}\p{N}._%+-])([\p{L}\p{N}][\p{L}\p{N}._%+-]*@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.\p{L}{2,24})(?:$|[^\p{L}\p{N}-])",
    )
});
static IBAN: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){10,32})"));
static CARD: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9_.\-])([0-9](?:[ \-]?[0-9]){12,18})(?:$|[^A-Za-z0-9_\-.]|\.(?:$|[^0-9]))"));
static PHONE_INTL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^A-Za-z0-9_+])(\+[0-9]{1,3}(?:[ .\-]?\([0-9]{1,4}\))?(?:[ .\-]?[0-9]{1,5}){2,5})(?:$|[^A-Za-z0-9_.\-]|[.\-](?:$|[^0-9]))",
    )
});
static PHONE_NANP_PAREN: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?:^|[^A-Za-z0-9_)])(\([0-9]{3}\) ?[0-9]{3}[ .\-][0-9]{4})(?:$|[^A-Za-z0-9_.\-]|[.\-](?:$|[^0-9]))")
});
static PHONE_NANP: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^A-Za-z0-9_.\-/])([0-9]{3}\.[0-9]{3}\.[0-9]{4}|[0-9]{3}-[0-9]{3}-[0-9]{4})(?:$|[^A-Za-z0-9_.\-/]|[.\-/](?:$|[^0-9]))",
    )
});
static PHONE_NATIONAL: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?:^|[^A-Za-z0-9_.\-+/:])(0[0-9]{2,4}(?:[ /\-][0-9]{2,8}){1,3})(?:$|[^A-Za-z0-9_.\-/:]|[.\-/:](?:$|[^0-9]))")
});
static PHONE_NATIONAL_PLAIN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9_.\-+/:])(0[1-9][0-9]{8,9})(?:$|[^A-Za-z0-9_.\-/:]|[.\-/:](?:$|[^0-9]))"));
static DATE_LIKE: LazyLock<Regex> =
    LazyLock::new(|| re(r"\b[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}\b|\b[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4}\b"));
static IP_LIKE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$"));
static TIME_LIKE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,2}[:.][0-9]{2}(?:[:.][0-9]{2})?$"));
static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)```.*?(?:```|\z)|~~~.*?(?:~~~|\z)"));
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| re(r"`[^`\n]+`"));
static LINK: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)\b(?:https?|ftp|file|wss?)://[^\s<>"'`)\]]+|\bwww\.[^\s<>"'`)\]]+"#));
static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| re(r"\[(EMAIL|IBAN|CARD|PHONE)_([0-9]+)\]"));

const FILE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "heic", "ico", "bmp"];
const SERVICE_LOCALS: &[&str] =
    &["git", "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster"];
const EXAMPLE_DOMAINS: &[&str] = &["example.com", "example.org", "example.net", "example.edu", "example"];

const IBAN_LENGTHS: &str = "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DK18 \
    DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 \
    LB28 LC32 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 \
    SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20";

fn iban_length(country: &str) -> Option<usize> {
    IBAN_LENGTHS.split_whitespace().find(|e| &e[..2] == country).and_then(|e| e[2..].parse().ok())
}

/// The cores of [re]'s matches (group 1), scanning on after each core.
fn cores(re: &Regex, text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at <= text.len() {
        let Some(caps) = re.captures_at(text, at) else { break };
        let core = caps.get(1).expect("group 1");
        out.push((core.start(), core.end()));
        at = if core.end() > at { core.end() } else { at + 1 };
        while !text.is_char_boundary(at) && at < text.len() {
            at += 1;
        }
    }
    out
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.bytes().rev().enumerate() {
        let mut d = u32::from(c - b'0');
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    digits.len() >= 2 && sum % 10 == 0
}

fn iban_valid(compact: &str) -> bool {
    let Some(length) = compact.get(..2).and_then(iban_length) else { return false };
    let b = compact.as_bytes();
    if compact.len() != length
        || !b.iter().all(u8::is_ascii_alphanumeric)
        || !b[2].is_ascii_digit()
        || !b[3].is_ascii_digit()
    {
        return false;
    }
    let moved = format!("{}{}", &compact[4..], &compact[..4]);
    let mut rem: u32 = 0;
    for c in moved.bytes() {
        rem = if c.is_ascii_digit() {
            (rem * 10 + u32::from(c - b'0')) % 97
        } else {
            (rem * 100 + u32::from(c.to_ascii_uppercase() - b'A' + 10)) % 97
        };
    }
    rem == 1
}

/// Personal data in [text], non-overlapping, in order.
pub fn detect(text: &str) -> Vec<Span> {
    let code: Vec<(usize, usize)> = {
        let mut code: Vec<(usize, usize)> = FENCE.find_iter(text).map(|m| (m.start(), m.end())).collect();
        for m in INLINE_CODE.find_iter(text) {
            if !code.iter().any(|&(s, e)| m.start() >= s && m.start() < e) {
                code.push((m.start(), m.end()));
            }
        }
        code
    };
    let links: Vec<(usize, usize)> = LINK.find_iter(text).map(|m| (m.start(), m.end())).collect();
    let blocked = |s: usize, e: usize| code.iter().chain(&links).any(|&(a, b)| s < b && a < e);

    let mut found: Vec<Span> = Vec::new();
    let mut add = |start: usize, end: usize, kind: Kind| {
        let s = &text[start..end];
        let lead = s.len() - s.trim_start().len();
        let trimmed = s.trim_end_matches(|c: char| c.is_whitespace() || c == ',');
        if trimmed.len() > lead {
            found.push(Span { start: start + lead, end: start + trimmed.len(), kind });
        }
    };

    for (s, e) in cores(&EMAIL, text) {
        let value = text[s..e].to_lowercase();
        let (local, domain) = value.split_once('@').expect("an @");
        let tld = domain.rsplit('.').next().unwrap_or("");
        let example = EXAMPLE_DOMAINS.iter().any(|d| domain == *d || domain.ends_with(&format!(".{d}")));
        let reserved = [".invalid", ".test", ".localhost"].iter().any(|t| domain.ends_with(t));
        if FILE_EXTENSIONS.contains(&tld) || SERVICE_LOCALS.contains(&local) || example || reserved {
            continue;
        }
        add(s, e, Kind::Email);
    }
    for (s, e) in cores(&IBAN, text) {
        let Some(length) = iban_length(&text[s..s + 2]) else { continue };
        let mut count = 0;
        let mut cut = None;
        let mut compact = String::new();
        for (i, c) in text[s..e].char_indices() {
            if c == ' ' {
                continue;
            }
            compact.push(c);
            count += 1;
            if count == length {
                cut = Some(s + i + c.len_utf8());
                break;
            }
        }
        let Some(cut) = cut else { continue };
        if text[cut..].chars().next().is_some_and(char::is_alphanumeric) {
            continue;
        }
        if iban_valid(&compact) {
            add(s, cut, Kind::Iban);
        }
    }
    for (s, e) in cores(&CARD, text) {
        if blocked(s, e) {
            continue;
        }
        let digits: String = text[s..e].chars().filter(char::is_ascii_digit).collect();
        let first = digits.as_bytes()[0];
        if !(13..=19).contains(&digits.len()) || !(b'2'..=b'6').contains(&first) || digits.bytes().all(|d| d == first) {
            continue;
        }
        if luhn(&digits) {
            add(s, e, Kind::Card);
        }
    }
    let phones: [(&Regex, usize, usize); 5] = [
        (&PHONE_INTL, 8, 15),
        (&PHONE_NANP_PAREN, 10, 10),
        (&PHONE_NANP, 10, 10),
        (&PHONE_NATIONAL, 9, 12),
        (&PHONE_NATIONAL_PLAIN, 10, 11),
    ];
    for (pattern, min, max) in phones {
        for (s, e) in cores(pattern, text) {
            if blocked(s, e) {
                continue;
            }
            let value = &text[s..e];
            let digits = value.chars().filter(char::is_ascii_digit).count();
            if !(min..=max).contains(&digits)
                || DATE_LIKE.is_match(value)
                || IP_LIKE.is_match(value.trim())
                || TIME_LIKE.is_match(value.trim())
            {
                continue;
            }
            add(s, e, Kind::Phone);
        }
    }

    // The most reliable first, then the longest, then the earliest; keep what does not overlap.
    found.sort_by_key(|c| (c.kind.priority(), std::cmp::Reverse(c.end - c.start), c.start));
    let mut taken: Vec<Span> = Vec::new();
    for c in found {
        if !taken.iter().any(|t| c.start < t.end && t.start < c.end) {
            taken.push(c);
        }
    }
    taken.sort_by_key(|c| c.start);
    taken
}

/// The placeholders of one request.
#[derive(Default, Debug)]
pub struct Vault {
    by_key: HashMap<(Kind, String), String>,
    values: HashMap<String, String>,
    reserved: HashSet<String>,
    next: HashMap<Kind, u32>,
    found: BTreeMap<Kind, usize>,
}

fn key(kind: Kind, value: &str) -> String {
    match kind {
        Kind::Email => value.to_lowercase(),
        Kind::Phone | Kind::Card => value.chars().filter(char::is_ascii_digit).collect(),
        Kind::Iban => value.chars().filter(|c| *c != ' ').collect::<String>().to_uppercase(),
    }
}

impl Vault {
    /// Reserves the placeholder-shaped text in [text], so no real value is given its number.
    pub fn reserve(&mut self, text: &str) {
        for m in PLACEHOLDER.find_iter(text) {
            self.reserved.insert(m.as_str().to_owned());
        }
    }

    fn placeholder(&mut self, kind: Kind, value: &str) -> String {
        if let Some(p) = self.by_key.get(&(kind, key(kind, value))) {
            return p.clone();
        }
        let n = self.next.entry(kind).or_insert(0);
        let placeholder = loop {
            *n += 1;
            let candidate = format!("[{}_{}]", kind.tag(), n);
            if !self.reserved.contains(&candidate) {
                break candidate;
            }
        };
        self.by_key.insert((kind, key(kind, value)), placeholder.clone());
        self.values.insert(placeholder.clone(), value.to_owned());
        *self.found.entry(kind).or_insert(0) += 1;
        placeholder
    }

    /// [text] with its personal data replaced. Call [Vault::reserve] on every text of the
    /// request first.
    pub fn redact(&mut self, text: &str) -> String {
        let spans = detect(text);
        if spans.is_empty() {
            return text.to_owned();
        }
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        for span in spans {
            out.push_str(&text[at..span.start]);
            out.push_str(&self.placeholder(span.kind, &text[span.start..span.end]));
            at = span.end;
        }
        out.push_str(&text[at..]);
        out
    }

    /// [text] with the placeholders this vault handed out turned back into their values.
    pub fn restore(&self, text: &str) -> String {
        if self.values.is_empty() || !text.contains('[') {
            return text.to_owned();
        }
        PLACEHOLDER
            .replace_all(text, |caps: &regex::Captures| {
                self.values.get(&caps[0]).cloned().unwrap_or_else(|| caps[0].to_owned())
            })
            .into_owned()
    }

    /// Distinct values found, per kind tag.
    pub fn found(&self) -> BTreeMap<&'static str, usize> {
        self.found.iter().map(|(k, n)| (k.tag(), *n)).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

/// The texts of a chat completion request that redaction covers.
fn request_texts(body: &mut Value) -> Vec<&mut String> {
    let mut texts = Vec::new();
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else { return texts };
    for message in messages {
        let Some(message) = message.as_object_mut() else { continue };
        for (field, value) in message.iter_mut() {
            match (field.as_str(), value) {
                ("tool_calls", Value::Array(calls)) => {
                    for call in calls {
                        if let Some(Value::String(args)) = call.pointer_mut("/function/arguments") {
                            texts.push(args);
                        }
                    }
                }
                ("content", Value::String(s)) => texts.push(s),
                ("content", Value::Array(parts)) => {
                    for part in parts {
                        if let Some(Value::String(s)) = part.get_mut("text") {
                            texts.push(s);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    texts
}

/// Redacts a chat completion request in place; the vault restores the answer.
pub fn redact_request(body: &mut Value) -> Vault {
    let mut vault = Vault::default();
    for text in request_texts(body) {
        vault.reserve(text);
    }
    for text in request_texts(body) {
        *text = vault.redact(text);
    }
    vault
}

/// Restores a whole (non-streamed) chat completion response in place.
pub fn restore_response(vault: &Vault, body: &mut Value) {
    let Some(choices) = body.get_mut("choices").and_then(Value::as_array_mut) else { return };
    for choice in choices {
        if let Some(Value::String(s)) = choice.pointer_mut("/message/content") {
            *s = vault.restore(s);
        }
        if let Some(calls) = choice.pointer_mut("/message/tool_calls").and_then(Value::as_array_mut) {
            for call in calls {
                if let Some(Value::String(args)) = call.pointer_mut("/function/arguments") {
                    *args = vault.restore(args);
                }
            }
        }
    }
}

/// Restores streamed (SSE) chat completion chunks. A placeholder split across chunks is held back
/// until it is whole or its choice finishes.
pub struct StreamRestorer {
    vault: Vault,
    line: Vec<u8>,
    carry: BTreeMap<u64, String>,
}

/// The longest tail of [text] that could still grow into a placeholder (`[`, `[EMA`, `[EMAIL_1`).
fn open_tail(text: &str) -> usize {
    let Some(i) = text.rfind('[') else { return 0 };
    let tail = &text[i + 1..];
    let could_grow = tail.len() <= 12
        && match tail.find('_') {
            None => {
                tail.bytes().all(|b| b.is_ascii_uppercase())
                    && ["EMAIL", "IBAN", "CARD", "PHONE"].iter().any(|t| t.starts_with(tail))
            }
            Some(u) => Kind::parse(&tail[..u]).is_some() && tail[u + 1..].bytes().all(|b| b.is_ascii_digit()),
        };
    if could_grow { text.len() - i } else { 0 }
}

impl StreamRestorer {
    pub fn new(vault: Vault) -> Self {
        Self { vault, line: Vec::new(), carry: BTreeMap::new() }
    }

    /// Feeds bytes from the upstream stream; returns the bytes to send on.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for &b in bytes {
            self.line.push(b);
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                out.extend(self.line_out(&line));
            }
        }
        out
    }

    /// The end of the upstream stream: whatever is still held back.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            out.extend(self.line_out(&line));
        }
        out.extend(self.flush_all());
        out
    }

    fn flush_all(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for (index, text) in std::mem::take(&mut self.carry) {
            if !text.is_empty() {
                let chunk = serde_json::json!({ "choices": [{ "index": index, "delta": { "content": self.vault.restore(&text) } }] });
                out.extend(format!("data: {chunk}\n\n").into_bytes());
            }
        }
        out
    }

    fn line_out(&mut self, line: &[u8]) -> Vec<u8> {
        let Ok(text) = std::str::from_utf8(line) else { return line.to_vec() };
        let Some(data) = text.strip_prefix("data:") else { return line.to_vec() };
        let data = data.trim();
        if data == "[DONE]" {
            let mut out = self.flush_all();
            out.extend_from_slice(line);
            return out;
        }
        let Ok(mut chunk) = serde_json::from_str::<Value>(data) else { return line.to_vec() };
        if let Some(choices) = chunk.get_mut("choices").and_then(Value::as_array_mut) {
            for choice in choices {
                let index = choice.get("index").and_then(Value::as_u64).unwrap_or(0);
                let finished = choice.get("finish_reason").is_some_and(|f| !f.is_null());
                let held = self.carry.remove(&index).unwrap_or_default();
                let delta = choice.pointer_mut("/delta/content");
                let mut text = held;
                if let Some(Value::String(s)) = &delta {
                    text.push_str(s);
                }
                let keep = if finished { 0 } else { open_tail(&text) };
                let (send, hold) = text.split_at(text.len() - keep);
                if !hold.is_empty() {
                    self.carry.insert(index, hold.to_owned());
                }
                let restored = self.vault.restore(send);
                match delta {
                    Some(slot) => *slot = Value::String(restored),
                    None if !restored.is_empty() => {
                        if let Some(obj) = choice.as_object_mut() {
                            let d = obj.entry("delta").or_insert_with(|| serde_json::json!({}));
                            if let Some(d) = d.as_object_mut() {
                                d.insert("content".into(), Value::String(restored));
                            }
                        }
                    }
                    None => {}
                }
            }
        }
        format!("data: {chunk}\n").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::{StreamRestorer, Vault, open_tail, redact_request, restore_response};
    use serde_json::json;

    #[test]
    fn open_tails() {
        assert_eq!(open_tail("hello ["), 1);
        assert_eq!(open_tail("hello [EMA"), 4);
        assert_eq!(open_tail("hello [EMAIL_1"), 8);
        assert_eq!(open_tail("hello [EMAIL_1]"), 0);
        assert_eq!(open_tail("a [link] b"), 0);
        assert_eq!(open_tail("x [Hello"), 0);
        assert_eq!(open_tail("no bracket"), 0);
    }

    #[test]
    fn requests_and_responses_round_trip() {
        let mut body = json!({
            "model": "x",
            "messages": [
                { "role": "system", "content": "be brief" },
                { "role": "user", "content": [{ "type": "text", "text": "mail alice@proton.me" }] },
                { "role": "assistant", "tool_calls": [{ "function": { "name": "send", "arguments": "{\"to\":\"alice@proton.me\"}" } }] }
            ]
        });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][1]["content"][0]["text"], "mail [EMAIL_1]");
        assert_eq!(body["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"to\":\"[EMAIL_1]\"}");
        let mut answer = json!({ "choices": [{ "message": { "content": "Sent to [EMAIL_1]. [EMAIL_9] stays." } }] });
        restore_response(&vault, &mut answer);
        assert_eq!(answer["choices"][0]["message"]["content"], "Sent to alice@proton.me. [EMAIL_9] stays.");
    }

    #[test]
    fn streams_restore_split_placeholders() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("call +44 20 7946 0958"), "call [PHONE_1]");
        let mut restorer = StreamRestorer::new(vault);
        let chunk =
            |s: &str| format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "content": s } }] }));
        let mut out = Vec::new();
        for part in ["Your number is [PH", "ONE_", "1] and [x] ok"] {
            out.extend(restorer.push(chunk(part).as_bytes()));
        }
        out.extend(restorer.push(b"data: [DONE]\n\n"));
        out.extend(restorer.finish());
        let text: String = String::from_utf8(out)
            .unwrap()
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .map(|d| {
                serde_json::from_str::<serde_json::Value>(d).unwrap()["choices"][0]["delta"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            })
            .collect();
        assert_eq!(text, "Your number is +44 20 7946 0958 and [x] ok");
    }

    #[test]
    fn a_held_tail_is_flushed_when_the_choice_finishes() {
        let mut restorer = StreamRestorer::new(Vault::default());
        let out = restorer.push(
            format!("data: {}\n", json!({ "choices": [{ "index": 0, "delta": { "content": "x [EM" } }] })).as_bytes(),
        );
        assert!(!String::from_utf8_lossy(&out).contains("[EM"));
        let out = restorer.push(
            format!("data: {}\n", json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }))
                .as_bytes(),
        );
        assert!(String::from_utf8_lossy(&out).contains("[EM"));
    }
}
