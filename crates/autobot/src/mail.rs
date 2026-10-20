//! Email messages, as far as the agent needs them: reading one (headers, the text a person
//! wrote above the quoted part, an audio attachment) and writing a reply in the same thread.
//! Plain RFC 5322 and MIME: multipart, quoted-printable and base64, encoded words, UTF-8 and
//! Latin-1. No other crate: what arrives is untrusted, so the parser is small and checked here.

use base64::Engine as _;

/// One message, read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mail {
    /// The sender's address, in lower case.
    pub from: String,
    pub from_name: String,
    pub to: Vec<String>,
    pub subject: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// What the sender wrote, without the quoted message below it.
    pub text: String,
    /// The first audio attachment: (mime type, file name, bytes).
    pub audio: Option<(String, String, Vec<u8>)>,
    /// An auto-reply, a list or bulk mail: never answered (no mail loops).
    pub automatic: bool,
    /// The receiving server says the sender is who they claim (SPF, DKIM or DMARC passed).
    pub authenticated: bool,
}

impl Mail {
    /// The thread this message belongs to: its first reference, else what it replies to, else itself.
    pub fn thread(&self) -> String {
        self.references
            .first()
            .cloned()
            .or_else(|| self.in_reply_to.clone())
            .or_else(|| self.message_id.clone())
            .unwrap_or_else(|| format!("{}|{}", self.from, self.subject))
    }
}

/// A header block: names in lower case, values unfolded.
fn headers(block: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in block.lines() {
        if line.starts_with([' ', '\t']) {
            if let Some((_, value)) = out.last_mut() {
                value.push(' ');
                value.push_str(line.trim());
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            out.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    out
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

/// Splits raw bytes into the header block and the body.
fn split_message(raw: &[u8]) -> (String, &[u8]) {
    let at = find(raw, b"\r\n\r\n").map(|i| (i, 4)).or_else(|| find(raw, b"\n\n").map(|i| (i, 2)));
    match at {
        Some((i, n)) => (latin1_or_utf8(&raw[..i]), &raw[i + n..]),
        None => (latin1_or_utf8(raw), &[]),
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Bytes as text: UTF-8 when they are, else Latin-1.
fn latin1_or_utf8(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// Bytes in [charset] as text.
fn decode_charset(bytes: &[u8], charset: &str) -> String {
    match charset.to_ascii_lowercase().as_str() {
        "iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "iso-8859-15" => {
            bytes.iter().map(|&b| b as char).collect()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// `=?UTF-8?B?…?=` and `=?ISO-8859-1?Q?…?=` words decoded (RFC 2047).
pub fn decode_words(text: &str) -> String {
    let re = regex::Regex::new(r"=\?([^?]+)\?([bBqQ])\?([^?]*)\?=").expect("a valid pattern");
    let mut out = String::new();
    let mut last = 0;
    let mut previous_word = false;
    for m in re.captures_iter(text) {
        let whole = m.get(0).expect("a match");
        let between = &text[last..whole.start()];
        // Space between two encoded words is not part of the text.
        if !(previous_word && between.trim().is_empty()) {
            out.push_str(between);
        }
        let bytes = match &m[2] {
            "b" | "B" => base64::engine::general_purpose::STANDARD.decode(m[3].trim()).unwrap_or_default(),
            _ => quoted_printable(&m[3].replace('_', " "), false),
        };
        out.push_str(&decode_charset(&bytes, m[1].split('*').next().unwrap_or("utf-8")));
        last = whole.end();
        previous_word = true;
    }
    out.push_str(&text[last..]);
    out
}

/// Quoted-printable decoded; [soft] lines (`=` at the end) joined.
fn quoted_printable(text: &str, soft: bool) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' {
            if soft && bytes.get(i + 1) == Some(&b'\r') && bytes.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
            if soft && bytes.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            if let (Some(a), Some(b)) = (bytes.get(i + 1), bytes.get(i + 2))
                && let Ok(byte) = u8::from_str_radix(&format!("{}{}", *a as char, *b as char), 16)
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// A header parameter: `charset` of `text/plain; charset="utf-8"`.
fn param(value: &str, name: &str) -> Option<String> {
    value.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        (k.trim().eq_ignore_ascii_case(name)).then(|| v.trim().trim_matches('"').to_owned())
    })
}

/// An address out of `Ann <ann@example.com>` (lower case), and the name.
pub fn address(value: &str) -> (String, String) {
    let value = decode_words(value);
    match (value.rfind('<'), value.rfind('>')) {
        (Some(a), Some(b)) if a < b => {
            let name = value[..a].trim().trim_matches('"').trim().to_owned();
            (value[a + 1..b].trim().to_ascii_lowercase(), name)
        }
        _ => (value.trim().to_ascii_lowercase(), String::new()),
    }
}

fn ids(value: &str) -> Vec<String> {
    let re = regex::Regex::new(r"<[^<>\s]+>").expect("a valid pattern");
    re.find_iter(value).map(|m| m.as_str().to_owned()).collect()
}

/// A body part, decoded: its type, its disposition's file name, the bytes.
struct Part {
    kind: String,
    name: String,
    attachment: bool,
    bytes: Vec<u8>,
    charset: String,
}

fn parts(headers: &[(String, String)], body: &[u8], depth: usize, out: &mut Vec<Part>) {
    let kind = header(headers, "content-type").unwrap_or("text/plain");
    let base = kind.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    if base.starts_with("multipart/") && depth < 8 {
        let Some(boundary) = param(kind, "boundary") else { return };
        let marker = format!("--{boundary}");
        let text = body;
        let mut pieces: Vec<&[u8]> = Vec::new();
        let mut at = 0;
        while let Some(i) = find(&text[at..], marker.as_bytes()) {
            pieces.push(&text[at..at + i]);
            at += i + marker.len();
            if text[at..].starts_with(b"--") {
                break;
            }
        }
        // The preamble before the first boundary is not a part.
        for piece in pieces.into_iter().skip(1) {
            let piece = piece.strip_prefix(b"\r\n").or_else(|| piece.strip_prefix(b"\n")).unwrap_or(piece);
            let (head, inner) = split_message(piece);
            parts(&self::headers(&head), inner, depth + 1, out);
        }
        return;
    }
    let encoding = header(headers, "content-transfer-encoding").unwrap_or("7bit").trim().to_ascii_lowercase();
    let bytes = match encoding.as_str() {
        "base64" => {
            let clean: String = latin1_or_utf8(body).chars().filter(|c| !c.is_whitespace()).collect();
            base64::engine::general_purpose::STANDARD.decode(clean).unwrap_or_default()
        }
        "quoted-printable" => quoted_printable(&latin1_or_utf8(body), true),
        _ => body.to_vec(),
    };
    let disposition = header(headers, "content-disposition").unwrap_or_default();
    let name =
        param(disposition, "filename").or_else(|| param(kind, "name")).map(|n| decode_words(&n)).unwrap_or_default();
    out.push(Part {
        kind: base,
        name,
        attachment: disposition.trim().to_ascii_lowercase().starts_with("attachment"),
        bytes,
        charset: param(kind, "charset").unwrap_or_else(|| "utf-8".to_owned()),
    });
}

/// What a person wrote, without the message they quote below it.
pub fn unquote(text: &str) -> String {
    let mut kept = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let wrote = trimmed.ends_with("wrote:") || trimmed.ends_with("schrieb:") || trimmed.ends_with("a écrit :");
        let next_quoted = lines.get(i + 1).is_some_and(|l| l.trim_start().starts_with('>'))
            || lines.get(i + 2).is_some_and(|l| l.trim_start().starts_with('>'));
        if (wrote
            && (trimmed.starts_with("On ") || trimmed.starts_with("Am ") || trimmed.starts_with("Le ") || next_quoted))
            || trimmed.starts_with("-----Original Message-----")
            || trimmed == "________________________________"
        {
            break;
        }
        if trimmed.starts_with('>') {
            continue;
        }
        // A signature.
        if *line == "-- " {
            break;
        }
        kept.push(*line);
    }
    kept.join("\n").trim().to_owned()
}

/// Tags out of HTML, for a message with no plain-text part.
fn html_text(html: &str) -> String {
    let breaks = regex::Regex::new(r"(?i)<br\s*/?>|</p>|</div>|</li>").expect("a valid pattern");
    let tags = regex::Regex::new(r"(?s)<style.*?</style>|<script.*?</script>|<[^>]*>").expect("a valid pattern");
    let text = breaks.replace_all(html, "\n");
    let text = tags.replace_all(&text, "");
    text.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&")
}

/// Reads [raw] (as IMAP hands it over).
pub fn parse(raw: &[u8]) -> Mail {
    let (head, body) = split_message(raw);
    let headers = headers(&head);
    let (from, from_name) = address(header(&headers, "from").unwrap_or_default());
    let to = header(&headers, "to").map(|t| t.split(',').map(|a| address(a).0).collect()).unwrap_or_default();
    let mut found = Vec::new();
    parts(&headers, body, 0, &mut found);
    let plain = found.iter().find(|p| p.kind == "text/plain" && !p.attachment);
    let text = match plain {
        Some(p) => decode_charset(&p.bytes, &p.charset),
        None => found
            .iter()
            .find(|p| p.kind == "text/html" && !p.attachment)
            .map(|p| html_text(&decode_charset(&p.bytes, &p.charset)))
            .unwrap_or_default(),
    };
    let audio = found.iter().find(|p| crate::voice::is_audio(&p.kind, &p.name) && !p.bytes.is_empty()).map(|p| {
        (p.kind.clone(), if p.name.is_empty() { "voice".to_owned() } else { p.name.clone() }, p.bytes.clone())
    });
    let automatic = header(&headers, "auto-submitted").is_some_and(|v| !v.eq_ignore_ascii_case("no"))
        || header(&headers, "precedence")
            .is_some_and(|v| ["bulk", "list", "junk"].contains(&v.to_ascii_lowercase().as_str()))
        || header(&headers, "list-id").is_some()
        || header(&headers, "x-autoreply").is_some();
    // The topmost result is the receiving server's own; ones further down could be the sender's.
    let authenticated = header(&headers, "authentication-results").is_some_and(|v| {
        let v = v.to_ascii_lowercase();
        v.contains("dmarc=pass") || v.contains("dkim=pass") || v.contains("spf=pass")
    });
    let references = header(&headers, "references").map(ids).unwrap_or_default();
    Mail {
        from,
        from_name,
        to,
        subject: decode_words(header(&headers, "subject").unwrap_or_default()),
        message_id: header(&headers, "message-id").and_then(|v| ids(v).into_iter().next()),
        in_reply_to: header(&headers, "in-reply-to").and_then(|v| ids(v).into_iter().next()),
        references,
        text: unquote(&text.replace("\r\n", "\n")),
        audio,
        automatic,
        authenticated,
    }
}

/// A subject as a header: plain ASCII as it is, anything else as one encoded word.
fn encode_subject(subject: &str) -> String {
    let subject: String = subject.chars().filter(|c| !c.is_control()).collect();
    if subject.is_ascii() {
        subject
    } else {
        format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(subject.as_bytes()))
    }
}

/// [text] in quoted-printable, lines under 76 characters.
fn encode_qp(text: &str) -> String {
    let mut out = String::new();
    for line in text.replace("\r\n", "\n").split('\n') {
        let mut current = String::new();
        let bytes = line.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            let last = i == bytes.len() - 1;
            let piece = if (b == b' ' || b == b'\t') && last || b == b'=' || !(32..127).contains(&b) && b != b'\t' {
                format!("={b:02X}")
            } else {
                (b as char).to_string()
            };
            if current.len() + piece.len() > 75 {
                out.push_str(&current);
                out.push_str("=\r\n");
                current.clear();
            }
            current.push_str(&piece);
        }
        out.push_str(&current);
        out.push_str("\r\n");
    }
    out
}

/// A message to send.
pub struct Outgoing<'a> {
    pub from: &'a str,
    pub from_name: &'a str,
    pub to: &'a str,
    pub subject: &'a str,
    pub text: &'a str,
    /// The message this answers, and the thread's references.
    pub in_reply_to: Option<&'a str>,
    pub references: &'a [String],
    pub message_id: &'a str,
}

/// [mail] as the bytes SMTP's DATA takes (CRLF lines, dots not yet doubled).
pub fn compose(mail: &Outgoing) -> String {
    let date = chrono::Local::now().to_rfc2822();
    let name = mail.from_name.replace(['"', '\\', '\r', '\n'], "");
    let mut head = vec![
        format!("From: \"{name}\" <{}>", mail.from),
        format!("To: <{}>", mail.to),
        format!("Subject: {}", encode_subject(mail.subject)),
        format!("Date: {date}"),
        format!("Message-ID: {}", mail.message_id),
        "MIME-Version: 1.0".to_owned(),
        "Content-Type: text/plain; charset=utf-8".to_owned(),
        "Content-Transfer-Encoding: quoted-printable".to_owned(),
        "Auto-Submitted: auto-replied".to_owned(),
    ];
    if let Some(parent) = mail.in_reply_to {
        head.push(format!("In-Reply-To: {parent}"));
        let mut refs: Vec<String> = mail.references.to_vec();
        if !refs.iter().any(|r| r == parent) {
            refs.push(parent.to_owned());
        }
        head.push(format!("References: {}", refs.join(" ")));
    }
    format!("{}\r\n\r\n{}", head.join("\r\n"), encode_qp(mail.text))
}

/// `Re: subject`, once.
pub fn reply_subject(subject: &str) -> String {
    let trimmed = subject.trim();
    if trimmed.to_ascii_lowercase().starts_with("re:") { trimmed.to_owned() } else { format!("Re: {trimmed}") }
}

/// [text] quoted, as a reply carries what it answers.
pub fn quote(from: &str, text: &str) -> String {
    let quoted: Vec<String> = text.lines().take(40).map(|l| format!("> {l}")).collect();
    format!("{from} wrote:\n{}", quoted.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str = "Return-Path: <ann@example.com>\r\n\
Authentication-Results: mx.example.org; dkim=pass header.d=example.com; spf=pass\r\n\
From: =?UTF-8?Q?Ann_M=C3=BCller?= <Ann@Example.com>\r\n\
To: bot@example.org\r\n\
Subject: =?UTF-8?B?UmU6IETDtnJ0?= =?UTF-8?B?ZW4=?=\r\n\
Message-ID: <m2@example.com>\r\n\
In-Reply-To: <m1@example.org>\r\n\
References: <m0@example.com>\r\n <m1@example.org>\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
\r\n\
preamble\r\n\
--b1\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
Yes, go ahead =E2=80=94 and also check the lo=\r\n\
gs.\r\n\
\r\n\
On Mon, 19 Oct 2026, Autobot <bot@example.org> wrote:\r\n\
> Approve? run: df -h\r\n\
--b1\r\n\
Content-Type: audio/ogg\r\n\
Content-Disposition: attachment; filename=\"memo.ogg\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
T2dnUw==\r\n\
--b1--\r\n";

    #[test]
    fn a_reply_is_read() {
        let mail = parse(REPLY.as_bytes());
        assert_eq!(mail.from, "ann@example.com");
        assert_eq!(mail.from_name, "Ann Müller");
        assert_eq!(mail.subject, "Re: Dörten");
        assert_eq!(mail.message_id.as_deref(), Some("<m2@example.com>"));
        assert_eq!(mail.in_reply_to.as_deref(), Some("<m1@example.org>"));
        assert_eq!(mail.references, ["<m0@example.com>", "<m1@example.org>"]);
        assert_eq!(mail.thread(), "<m0@example.com>");
        assert_eq!(mail.text, "Yes, go ahead — and also check the logs.");
        assert_eq!(mail.audio, Some(("audio/ogg".into(), "memo.ogg".into(), b"OggS".to_vec())));
        assert!(mail.authenticated);
        assert!(!mail.automatic);
    }

    #[test]
    fn plain_latin1_and_html_mail() {
        let latin = b"From: bob@x.org\nSubject: hi\nContent-Type: text/plain; charset=iso-8859-1\n\ncaf\xe9\n";
        let mail = parse(latin);
        assert_eq!(mail.text, "café");
        assert_eq!(mail.thread(), "bob@x.org|hi");
        assert!(!mail.authenticated);
        let html = b"From: bob@x.org\nContent-Type: text/html\nAuto-Submitted: auto-replied\n\n<p>Hello<br>there &amp; you</p><style>p{}</style>";
        let mail = parse(html);
        assert_eq!(mail.text, "Hello\nthere & you");
        assert!(mail.automatic);
    }

    #[test]
    fn quotes_and_signatures_are_cut() {
        assert_eq!(unquote("Do it.\n\nOn Tue, Bob wrote:\n> old"), "Do it.");
        assert_eq!(unquote("Do it.\n> old\nmore"), "Do it.\nmore");
        assert_eq!(unquote("Do it.\n-- \nBob"), "Do it.");
        assert_eq!(unquote("Do it.\n-----Original Message-----\nFrom: x"), "Do it.");
    }

    #[test]
    fn a_reply_is_written() {
        let refs = vec!["<m0@example.com>".to_owned()];
        let text = compose(&Outgoing {
            from: "bot@example.org",
            from_name: "Ops \"bot\"",
            to: "ann@example.com",
            subject: "Re: Dörten",
            text: "Done — 3 files.\nA line with = and a long tail ".repeat(3).as_str(),
            in_reply_to: Some("<m2@example.com>"),
            references: &refs,
            message_id: "<r1@example.org>",
        });
        assert!(text.contains("From: \"Ops bot\" <bot@example.org>\r\n"));
        assert!(text.contains("Subject: =?UTF-8?B?"));
        assert!(text.contains("References: <m0@example.com> <m2@example.com>\r\n"));
        assert!(text.lines().all(|l| l.len() <= 78), "{text}");
        // What was written reads back the same.
        let back = parse(text.as_bytes());
        assert_eq!(back.subject, "Re: Dörten");
        assert!(back.text.starts_with("Done — 3 files.\nA line with = and a long tail"), "{}", back.text);
        assert!(back.automatic, "the bot's own mail is marked, so no bot answers it");
        assert_eq!(reply_subject("Re: x"), "Re: x");
        assert_eq!(reply_subject("x"), "Re: x");
    }
}
