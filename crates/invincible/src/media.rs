//! Images in requests: found in OpenAI chat parts (`{"type": "image_url", "image_url": {"url":
//! "data:image/png;base64,…"}}`) and Anthropic Messages blocks (`{"type": "image", "source":
//! {"type": "base64", "media_type", "data"}}`). The gateway passes them on as they came; receipts
//! and logs note each one by its hash, size and type, never its bytes.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// One image a request carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    /// SHA-256 of the image's bytes (of the URL, for an image given by link), hex.
    pub sha256: String,
    /// Its size in bytes (decoded); 0 for a link.
    pub bytes: u64,
    /// `image/png`, …; `url` for a link the provider fetches itself.
    pub mime: String,
}

impl Image {
    /// As receipts and the audit log keep it.
    pub fn to_json(&self) -> Value {
        json!({ "sha256": self.sha256, "bytes": self.bytes, "mime": self.mime })
    }

    fn from_base64(mime: &str, data: &str) -> Self {
        // A payload that does not decode is still noted (by the hash of what was sent).
        let bytes = STANDARD.decode(data.trim()).unwrap_or_else(|_| data.as_bytes().to_vec());
        Self { sha256: hex(&Sha256::digest(&bytes)), bytes: bytes.len() as u64, mime: mime.to_owned() }
    }

    fn from_url(url: &str) -> Self {
        // `data:<mime>;base64,<data>`
        if let Some((head, data)) = url.strip_prefix("data:").and_then(|rest| rest.split_once(',')) {
            let mime = head.split(';').next().filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
            if head.ends_with(";base64") {
                return Self::from_base64(mime, data);
            }
            let bytes = data.as_bytes();
            return Self { sha256: hex(&Sha256::digest(bytes)), bytes: bytes.len() as u64, mime: mime.to_owned() };
        }
        Self { sha256: hex(&Sha256::digest(url.as_bytes())), bytes: 0, mime: "url".to_owned() }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Every image in a chat completion or Messages request [body], in order.
pub fn images(body: &Value) -> Vec<Image> {
    let mut found = Vec::new();
    for message in body.get("messages").and_then(Value::as_array).into_iter().flatten() {
        let Some(parts) = message.get("content").and_then(Value::as_array) else { continue };
        for part in parts {
            collect(part, &mut found);
        }
    }
    found
}

fn collect(part: &Value, found: &mut Vec<Image>) {
    match part.get("type").and_then(Value::as_str) {
        // OpenAI: `image_url` is an object with `url`, or (older clients) the URL itself.
        Some("image_url") => {
            let url = part["image_url"]["url"].as_str().or_else(|| part["image_url"].as_str());
            if let Some(url) = url {
                found.push(Image::from_url(url));
            }
        }
        // Anthropic: base64 or a link.
        Some("image") => match part["source"]["type"].as_str() {
            Some("base64") => found.push(Image::from_base64(
                part["source"]["media_type"].as_str().unwrap_or("application/octet-stream"),
                part["source"]["data"].as_str().unwrap_or_default(),
            )),
            Some("url") => found.push(Image::from_url(part["source"]["url"].as_str().unwrap_or_default())),
            _ => {}
        },
        // A tool result's content can hold images too (Messages).
        Some("tool_result") => {
            for inner in part.get("content").and_then(Value::as_array).into_iter().flatten() {
                collect(inner, found);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::images;
    use serde_json::json;

    #[test]
    fn finds_images_in_both_formats_by_hash_size_and_type() {
        // "hello" in base64; its SHA-256.
        let hello = "aGVsbG8=";
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        let chat = json!({ "messages": [
            { "role": "system", "content": "be brief" },
            { "role": "user", "content": [
                { "type": "text", "text": "what is this?" },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{hello}") } },
                { "type": "image_url", "image_url": { "url": "https://example.org/cat.jpg" } },
            ]},
        ]});
        let found = images(&chat);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].sha256.as_str(), found[0].bytes, found[0].mime.as_str()), (sha, 5, "image/png"));
        assert_eq!((found[1].bytes, found[1].mime.as_str()), (0, "url"));
        let messages = json!({ "messages": [{ "role": "user", "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": hello } },
            { "type": "tool_result", "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/webp", "data": hello } },
            ]},
        ]}]});
        let found = images(&messages);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].to_json(), json!({ "sha256": sha, "bytes": 5, "mime": "image/jpeg" }));
        assert_eq!(found[1].mime, "image/webp");
        assert!(images(&json!({ "messages": [{ "role": "user", "content": "plain" }] })).is_empty());
    }
}
