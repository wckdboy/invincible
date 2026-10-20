//! Voice messages: a Telegram voice note, an audio file in Discord or Slack, a Signal voice
//! message becomes text before the agent sees it, transcribed on this machine.
//!
//! ```toml
//! [voice]
//! # A local speech-to-text server with the OpenAI shape (whisper.cpp's server, faster-whisper,
//! # speaches …): the audio is posted as multipart `file`, the answer is {"text": …}.
//! url = "http://127.0.0.1:8080/v1/audio/transcriptions"
//! # Or whisper.cpp's command line (default: whisper-cli, whisper-cpp or whisper on the PATH)
//! # with a ggml model; ffmpeg turns the audio into the 16 kHz WAV it reads.
//! command = "whisper-cli"
//! model_file = "~/.autobot/whisper/ggml-base.bin"
//! language = "auto"
//! ```
//!
//! Invincible Gateway has no speech-to-text of its own yet; nothing is sent to a cloud service.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

/// The largest audio taken (a voice note of many minutes fits).
pub const MAX_AUDIO: usize = 25 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// A transcription endpoint in the OpenAI shape, on this machine or over HTTPS.
    #[serde(default)]
    pub url: Option<String>,
    /// The `model` field sent to [VoiceConfig::url] [default: `whisper-1`].
    #[serde(default)]
    pub model: Option<String>,
    /// whisper.cpp's command line.
    #[serde(default)]
    pub command: Option<PathBuf>,
    /// The ggml model for whisper.cpp [default: `$AUTOBOT_HOME/whisper/ggml-base.bin`].
    #[serde(default)]
    pub model_file: Option<PathBuf>,
    /// The spoken language (`en`, `de`, …) [default: `auto`].
    #[serde(default)]
    pub language: Option<String>,
    /// Seconds a transcription may take.
    #[serde(default = "timeout")]
    pub timeout: u64,
}

fn yes() -> bool {
    true
}

fn timeout() -> u64 {
    180
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            url: None,
            model: None,
            command: None,
            model_file: None,
            language: None,
            timeout: timeout(),
        }
    }
}

/// Audio as a platform hands it over.
#[derive(Clone, Debug)]
pub struct Audio {
    pub bytes: Vec<u8>,
    /// `audio/ogg`, `audio/mpeg`, …
    pub mime: String,
    pub name: String,
}

/// Whether a file a platform describes is audio.
pub fn is_audio(mime: &str, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    mime.starts_with("audio/")
        || [".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".aac", ".flac"].iter().any(|e| name.ends_with(e))
}

/// Downloads [url] (at most [MAX_AUDIO]), with [auth] as the `Authorization` header.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    auth: Option<&str>,
    mime: &str,
    name: &str,
) -> Result<Audio, String> {
    let mut request = client.get(url).timeout(Duration::from_secs(120));
    if let Some(auth) = auth {
        request = request.header("authorization", auth);
    }
    let response = request.send().await.map_err(|e| format!("the audio: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("the audio: {}", response.status()));
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_AUDIO) {
        return Err("the audio is larger than 25 MB".to_owned());
    }
    let bytes = response.bytes().await.map_err(|e| format!("the audio: {}", e.without_url()))?;
    if bytes.len() > MAX_AUDIO {
        return Err("the audio is larger than 25 MB".to_owned());
    }
    Ok(Audio { bytes: bytes.to_vec(), mime: mime.to_owned(), name: name.to_owned() })
}

/// Whether speech can become text here: a server, or whisper.cpp with its model and ffmpeg.
pub fn available(config: &VoiceConfig, home: &Path) -> bool {
    if !config.enabled {
        return false;
    }
    if config.url.is_some() {
        return true;
    }
    let command = match &config.command {
        Some(command) => crate::config::expand(command).is_file(),
        None => ["whisper-cli", "whisper-cpp", "whisper"].iter().any(|n| crate::find_on_path(n).is_some()),
    };
    let model =
        config.model_file.as_deref().map(crate::config::expand).unwrap_or_else(|| home.join("whisper/ggml-base.bin"));
    command && model.is_file() && crate::find_on_path("ffmpeg").is_some()
}

/// The text spoken in [audio].
pub async fn transcribe(config: &VoiceConfig, home: &Path, audio: Audio) -> Result<String, String> {
    if !config.enabled {
        return Err("voice messages are off here ([voice] enabled = false)".to_owned());
    }
    if let Some(url) = &config.url {
        return by_server(config, url, audio).await;
    }
    let command = match &config.command {
        Some(command) => Some(crate::config::expand(command)),
        None => ["whisper-cli", "whisper-cpp", "whisper"].iter().find_map(|n| crate::find_on_path(n)),
    };
    let Some(command) = command else {
        return Err("no speech-to-text here: set [voice] url (a local whisper server) or install whisper.cpp (whisper-cli) and ffmpeg".to_owned());
    };
    by_command(config, home, &command, audio).await
}

async fn by_server(config: &VoiceConfig, url: &str, audio: Audio) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("[voice] url: {e}"))?;
    let local = parsed
        .host_str()
        .is_some_and(|h| h == "localhost" || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    let client = if local {
        reqwest::Client::new()
    } else if parsed.scheme() == "https" {
        invincible::egress::client(&crate::network()?)?
    } else {
        return Err("[voice] url: http:// only on this machine; https:// elsewhere".to_owned());
    };
    let model = config.model.as_deref().unwrap_or("whisper-1");
    let mut fields = vec![("model", model), ("response_format", "json")];
    if let Some(language) = config.language.as_deref().filter(|l| *l != "auto") {
        fields.push(("language", language));
    }
    let name = if audio.name.chars().any(|c| c.is_ascii_alphanumeric()) { audio.name.as_str() } else { "voice.ogg" };
    let (content_type, body) = crate::media::multipart(&fields, ("file", name, &audio.mime, &audio.bytes))?;
    let response = client
        .post(url)
        .header("content-type", content_type)
        .body(body)
        .timeout(Duration::from_secs(config.timeout))
        .send()
        .await
        .map_err(|e| format!("speech-to-text: {}", e.without_url()))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("speech-to-text: {}", e.without_url()))?;
    if !status.is_success() {
        return Err(format!("speech-to-text: {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "text": text }));
    Ok(value["text"].as_str().unwrap_or_default().trim().to_owned())
}

async fn by_command(config: &VoiceConfig, home: &Path, command: &Path, audio: Audio) -> Result<String, String> {
    let model =
        config.model_file.as_deref().map(crate::config::expand).unwrap_or_else(|| home.join("whisper/ggml-base.bin"));
    if !model.is_file() {
        return Err(format!("whisper.cpp needs a model: {} (or set [voice] model_file)", model.display()));
    }
    let ffmpeg = crate::find_on_path("ffmpeg").ok_or("whisper.cpp needs ffmpeg to read voice messages")?;
    let dir = std::env::temp_dir()
        .join(format!("autobot-voice-{}", invincible::token::hex(&invincible::token::random::<8>()?)));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let result = async {
        let input = dir.join("in");
        tokio::fs::write(&input, &audio.bytes).await.map_err(|e| e.to_string())?;
        let wav = dir.join("in.wav");
        let limit = Duration::from_secs(config.timeout);
        let converted = tokio::time::timeout(
            limit,
            tokio::process::Command::new(&ffmpeg)
                .args(["-nostdin", "-loglevel", "error", "-y", "-i"])
                .arg(&input)
                .args(["-ar", "16000", "-ac", "1", "-f", "wav"])
                .arg(&wav)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "ffmpeg took too long".to_owned())?
        .map_err(|e| format!("ffmpeg: {e}"))?;
        if !converted.status.success() {
            return Err(format!("ffmpeg: {}", String::from_utf8_lossy(&converted.stderr).trim()));
        }
        let base = dir.join("out");
        let language = config.language.clone().unwrap_or_else(|| "auto".to_owned());
        let ran = tokio::time::timeout(
            limit,
            tokio::process::Command::new(command)
                .arg("-m")
                .arg(&model)
                .arg("-f")
                .arg(&wav)
                .args(["-l", &language, "-nt", "-otxt", "-of"])
                .arg(&base)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "whisper.cpp took too long".to_owned())?
        .map_err(|e| format!("{}: {e}", command.display()))?;
        if !ran.status.success() {
            return Err(format!(
                "{}: {}",
                command.display(),
                String::from_utf8_lossy(&ran.stderr).trim().chars().take(300).collect::<String>()
            ));
        }
        let text = std::fs::read_to_string(base.with_extension("txt"))
            .unwrap_or_else(|_| String::from_utf8_lossy(&ran.stdout).into_owned());
        Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
    }
    .await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_is_known_by_type_or_name() {
        assert!(is_audio("audio/ogg", ""));
        assert!(is_audio("", "voice.OPUS"));
        assert!(is_audio("application/octet-stream", "memo.m4a"));
        assert!(!is_audio("image/png", "a.png"));
    }

    #[tokio::test]
    async fn a_local_server_transcribes() {
        use axum::body::Bytes;
        let app = axum::Router::new().route(
            "/v1/audio/transcriptions",
            axum::routing::post(|headers: axum::http::HeaderMap, body: Bytes| async move {
                let kind = headers["content-type"].to_str().unwrap().to_owned();
                let text = String::from_utf8_lossy(&body).into_owned();
                assert!(kind.starts_with("multipart/form-data; boundary="));
                assert!(text.contains("name=\"file\"; filename=\"voice.ogg\""));
                assert!(text.contains("OGGDATA"));
                assert!(text.contains("name=\"language\"\r\n\r\nde"));
                axum::Json(serde_json::json!({ "text": " check the disk " }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = VoiceConfig { url: Some(url), language: Some("de".into()), ..Default::default() };
        let audio = Audio { bytes: b"OGGDATA".to_vec(), mime: "audio/ogg".into(), name: "voice.ogg".into() };
        assert_eq!(transcribe(&config, Path::new("/nonexistent"), audio.clone()).await.unwrap(), "check the disk");
        let off = VoiceConfig { enabled: false, ..Default::default() };
        assert!(transcribe(&off, Path::new("/x"), audio.clone()).await.is_err());
        let plain = VoiceConfig { url: Some("http://example.com/stt".into()), ..Default::default() };
        assert!(transcribe(&plain, Path::new("/x"), audio).await.unwrap_err().contains("https"));
    }
}
