//! `speak` and `generate_image`: speech and pictures made by the node's backends (Invincible's
//! `/v1/audio/speech` and `/v1/images/generations`, spec/agent.md), saved in
//! `$AUTOBOT_HOME/attachments`, and sent with the answer on a channel that can carry them: a
//! Telegram voice message or photo, a Discord or email attachment, a Slack file, a Signal
//! attachment, Matrix media, a WhatsApp audio or image message.
//!
//! The tools are offered only when the node has such a backend. A backend on the node is used
//! without asking; one off the machine is asked for first, like a cloud model, and then the
//! request goes out (redacted by the node, with a receipt).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{Value, json};

/// What a backend makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Speech,
    Image,
}

/// A file made for the turn, to go with its answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Made {
    pub kind: Kind,
    pub path: PathBuf,
    pub mime: String,
}

/// Files made during a turn, for the chat it came from ([crate::tools::TurnContext::outbox]).
pub type Outbox = Arc<Mutex<Vec<Made>>>;

/// One of the node's backends, as `GET /v1/node` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Backend {
    pub id: String,
    /// `node` (this machine) or `cloud`.
    pub tier: String,
    pub host: String,
    pub healthy: bool,
}

/// The node's speech and image backends.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NodeMedia {
    pub speech: Vec<Backend>,
    pub images: Vec<Backend>,
}

impl NodeMedia {
    pub fn parse(node: &Value) -> Self {
        let list = |key: &str| {
            node[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| {
                    Some(Backend {
                        id: b["id"].as_str()?.to_owned(),
                        tier: b["tier"].as_str().unwrap_or("cloud").to_owned(),
                        host: b["host"].as_str().unwrap_or_default().to_owned(),
                        healthy: b["healthy"].as_bool().unwrap_or(true),
                    })
                })
                .collect()
        };
        Self { speech: list("speech"), images: list("images") }
    }

    pub fn of(&self, kind: Kind) -> &[Backend] {
        match kind {
            Kind::Speech => &self.speech,
            Kind::Image => &self.images,
        }
    }

    /// Where a request of [kind] would go: None when it stays on the machine (a healthy backend
    /// on the node, which the router takes first), else the host it leaves for.
    pub fn leaves_for(&self, kind: Kind) -> Option<String> {
        let backends = self.of(kind);
        if backends.iter().any(|b| b.tier == "node" && b.healthy) {
            return None;
        }
        let cloud = backends.iter().find(|b| b.healthy).or(backends.first());
        Some(cloud.map_or_else(|| "a cloud service".to_owned(), |b| b.host.clone()))
    }
}

/// What the node has, asked at most once a minute.
#[derive(Clone, Default)]
pub struct Cache(Arc<Mutex<Option<(Instant, NodeMedia)>>>);

impl Cache {
    pub async fn get(&self, gateway: &crate::gateway::Gateway) -> NodeMedia {
        if let Some((at, media)) = &*self.0.lock().expect("media cache")
            && at.elapsed() < Duration::from_secs(60)
        {
            return media.clone();
        }
        // A node from before these routes, or none answering: nothing to offer.
        let media = match tokio::time::timeout(Duration::from_secs(3), gateway.node()).await {
            Ok(Ok(node)) => NodeMedia::parse(&node),
            _ => NodeMedia::default(),
        };
        *self.0.lock().expect("media cache") = Some((Instant::now(), media.clone()));
        media
    }
}

/// The tool definitions for what [media] has.
pub fn definitions(media: &NodeMedia) -> Vec<Value> {
    let mut out = Vec::new();
    if !media.speech.is_empty() {
        out.push(json!({ "type": "function", "function": {
            "name": "speak",
            "description": "Say something out loud: the text becomes speech (an audio file), sent as a voice message where the chat can take one. For when the owner asks to hear it, or a voice answer fits; not for every answer.",
            "parameters": { "type": "object", "properties": {
                "text": { "type": "string", "description": "What to say, as it should be spoken (no Markdown)." },
                "voice": { "type": "string", "description": "A voice the speech server knows (optional)." },
            }, "required": ["text"] },
        }}));
    }
    if !media.images.is_empty() {
        out.push(json!({ "type": "function", "function": {
            "name": "generate_image",
            "description": "Draw a picture from a description (an image file), sent with the answer where the chat can show it.",
            "parameters": { "type": "object", "properties": {
                "prompt": { "type": "string", "description": "What the picture shows, in detail." },
                "size": { "type": "string", "description": "e.g. 1024x1024 (optional)." },
            }, "required": ["prompt"] },
        }}));
    }
    out
}

/// The extension for [mime].
pub(crate) fn extension(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or_default().trim() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "bin",
    }
}

/// The type of an image's [bytes], from their first ones.
pub fn image_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Keeps [bytes] in [dir] as `<what>-<time>-<random>.<ext>`, a new file (two turns at once never
/// share one); where.
pub fn save(dir: &Path, what: &str, mime: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write as _;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let random = invincible::token::hex(&invincible::token::random::<4>()?);
    let path = dir.join(format!("{what}-{stamp}-{random}.{}", extension(mime)));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// The first image in an images answer: its bytes (from `b64_json`), or its link (`url`).
pub fn first_image(answer: &Value) -> Result<Result<Vec<u8>, String>, String> {
    let first = &answer["data"][0];
    if let Some(data) = first["b64_json"].as_str() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("the image is not base64: {e}"))?;
        return Ok(Ok(bytes));
    }
    match first["url"].as_str() {
        Some(url) => Ok(Err(url.to_owned())),
        None => Err("the image backend gave no image".to_owned()),
    }
}

/// A multipart/form-data body: [fields], then one file; its content type and bytes.
pub fn multipart(fields: &[(&str, &str)], file: (&str, &str, &str, &[u8])) -> Result<(String, Vec<u8>), String> {
    let boundary = format!("autobot{}", invincible::token::hex(&invincible::token::random::<12>()?));
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    let (field, name, mime, bytes) = file;
    let name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || ".-_".contains(*c)).collect();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\nContent-Type: {}\r\n\r\n",
            if mime.is_empty() { "application/octet-stream" } else { mime }
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

/// The most a file sent to a chat can be (each platform has its own limit below this).
pub const MAX_SEND: u64 = 50 * 1024 * 1024;

impl Made {
    /// Its file name, as a platform shows it.
    pub fn name(&self) -> String {
        self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".to_owned())
    }

    /// Its bytes, for sending: at most [MAX_SEND].
    pub fn bytes(&self) -> Result<Vec<u8>, String> {
        let size = std::fs::metadata(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?.len();
        if size > MAX_SEND {
            return Err(format!("{} is larger than {} MB", self.path.display(), MAX_SEND >> 20));
        }
        std::fs::read(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))
    }
}

/// Hands [made] to the turn's chat, when the turn came from one.
pub fn deliver(made: Made) {
    let outbox = crate::tools::TURN.try_with(|t| t.outbox.clone()).ok().flatten();
    if let Some(outbox) = outbox {
        outbox.lock().expect("outbox").push(made);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_node_has_and_where_it_goes() {
        let node = json!({ "name": "n", "speech": [
            { "id": "kokoro", "tier": "node", "host": "127.0.0.1", "healthy": true },
        ], "images": [
            { "id": "img", "tier": "cloud", "host": "api.openai.com", "healthy": true },
        ] });
        let media = NodeMedia::parse(&node);
        assert_eq!(media.leaves_for(Kind::Speech), None);
        assert_eq!(media.leaves_for(Kind::Image).as_deref(), Some("api.openai.com"));
        let names: Vec<String> =
            definitions(&media).iter().map(|d| d["function"]["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["speak", "generate_image"]);
        assert!(definitions(&NodeMedia::parse(&json!({ "name": "old node" }))).is_empty());
        // A node backend that is down: the router goes elsewhere.
        let down = NodeMedia::parse(&json!({ "speech": [
            { "id": "k", "tier": "node", "host": "127.0.0.1", "healthy": false },
            { "id": "c", "tier": "cloud", "host": "tts.example.org", "healthy": true },
        ] }));
        assert_eq!(down.leaves_for(Kind::Speech).as_deref(), Some("tts.example.org"));
    }

    #[test]
    fn files_are_named_by_type_and_images_read_from_the_answer() {
        assert_eq!(extension("audio/mpeg"), "mp3");
        assert_eq!(extension("audio/ogg; codecs=opus"), "ogg");
        assert_eq!(image_mime(&[0x89, b'P', b'N', b'G', 1]), "image/png");
        assert_eq!(image_mime(b"RIFF1234WEBPVP8"), "image/webp");
        let answer = json!({ "data": [{ "b64_json": "iVBORw0KGgo=" }] });
        assert_eq!(first_image(&answer).unwrap().unwrap()[..4], [0x89, b'P', b'N', b'G']);
        let link = json!({ "data": [{ "url": "https://img.example.org/1.png" }] });
        assert_eq!(first_image(&link).unwrap().unwrap_err(), "https://img.example.org/1.png");
        assert!(first_image(&json!({ "data": [] })).is_err());
        let dir = std::env::temp_dir().join(format!("autobot-media-{}", std::process::id()));
        let path = save(&dir, "speech", "audio/mpeg", b"ID3").unwrap();
        assert!(path.extension().is_some_and(|e| e == "mp3"));
        assert_eq!(std::fs::read(&path).unwrap(), b"ID3");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn multipart_bodies() {
        let (kind, body) = multipart(&[("chat_id", "42")], ("voice", "a b.mp3", "audio/mpeg", b"ID3")).unwrap();
        let boundary = kind.strip_prefix("multipart/form-data; boundary=").unwrap();
        let text = String::from_utf8(body).unwrap();
        assert!(
            text.starts_with(&format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n42\r\n"
            ))
        );
        assert!(text.contains("name=\"voice\"; filename=\"ab.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nID3\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }
}
