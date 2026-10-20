//! Images shown to the agent: attached in the terminal (`@shot.png`, a dragged or pasted path,
//! `/image <path>`, ctrl+v), kept in the conversation as a reference (path, hash, size, type; never
//! the bytes), and sent as OpenAI-style parts (`{"type": "image_url", "image_url": {"url":
//! "data:image/png;base64,…"}}`) beside the message's text, downscaled to [MAX_SIDE] on the
//! longest side when bigger.
//!
//! An image goes out again with every call while its message is in the window, read from its file
//! each time: when the file is gone or changed (its hash differs), a short note goes instead. So a
//! resumed conversation sends what is still on disk, unchanged, and says what is not.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The longest side sent, in pixels (what the large providers scale to anyway).
pub const MAX_SIDE: u32 = 1568;
/// Bytes of one image sent at most (5 MB as base64, the strictest provider's limit per image).
const MAX_SEND: usize = 3_750_000;
/// Files bigger than this are not read.
const MAX_FILE: u64 = 64 * 1024 * 1024;
/// Characters one image counts for in the conversation's budget (about the tokens it costs).
pub const BUDGET_CHARS: usize = 6 * 1024;
/// The key a user message keeps its images under in the session file.
pub const KEY: &str = "autobot_images";
/// The file names taken for images.
pub const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

/// An image attached to a message: where it is and what it was when attached.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    /// Absolute.
    pub path: PathBuf,
    /// The file's name, as shown.
    pub name: String,
    /// SHA-256 of the file, hex.
    pub sha256: String,
    pub bytes: u64,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

impl Attachment {
    /// How the composer shows it: `[image 1: shot.png 1280×720]`.
    pub fn label(&self, n: usize) -> String {
        format!("[image {n}: {} {}×{}]", self.name, self.width, self.height)
    }

    /// How the message's text names it for the model: `[image 1: shot.png]`.
    pub fn marker(&self, n: usize) -> String {
        format!("[image {n}: {}]", self.name)
    }

    /// `shot.png · 1280×720 · 412 KiB`.
    pub fn describe(&self) -> String {
        format!("{} · {}×{} · {}", self.name, self.width, self.height, size(self.bytes))
    }
}

fn size(bytes: u64) -> String {
    match bytes {
        0..1024 => format!("{bytes} B"),
        1024..1_048_576 => format!("{} KiB", bytes / 1024),
        _ => format!("{:.1} MiB", bytes as f64 / 1_048_576.0),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether [path] is named like an image.
pub fn is_image(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// The format of [bytes], by their first bytes: PNG, JPEG, WebP or GIF.
fn sniff(bytes: &[u8]) -> Option<(ImageFormat, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some((ImageFormat::Png, "image/png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some((ImageFormat::Jpeg, "image/jpeg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some((ImageFormat::WebP, "image/webp"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some((ImageFormat::Gif, "image/gif"))
    } else {
        None
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_FILE {
        return Err(format!("{} is over {} MiB", path.display(), MAX_FILE / 1_048_576));
    }
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Attaches the image at [path]: checked to be a PNG, JPEG, WebP or GIF, measured and hashed.
pub fn attach(path: &Path) -> Result<Attachment, String> {
    let path = path.canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{}: no such file", path.display()),
        _ => format!("{}: {e}", path.display()),
    })?;
    let bytes = read(&path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (format, mime) = sniff(&bytes).ok_or_else(|| format!("{name} is not a PNG, JPEG, WebP or GIF image"))?;
    let (width, height) =
        ImageReader::with_format(Cursor::new(&bytes), format).into_dimensions().map_err(|e| format!("{name}: {e}"))?;
    Ok(Attachment {
        path,
        name,
        sha256: hex(&Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        mime: mime.to_owned(),
        width,
        height,
    })
}

/// What is sent for an image: as it is when small enough (its type, its bytes), else decoded,
/// scaled down to [MAX_SIDE] and encoded again: PNG when it has transparency and stays small, JPEG
/// otherwise.
pub fn prepare(bytes: &[u8]) -> Result<(&'static str, Vec<u8>), String> {
    let (format, mime) = sniff(bytes).ok_or("not a PNG, JPEG, WebP or GIF image")?;
    let (width, height) =
        ImageReader::with_format(Cursor::new(bytes), format).into_dimensions().map_err(|e| e.to_string())?;
    if width.max(height) <= MAX_SIDE && bytes.len() <= MAX_SEND {
        return Ok((mime, bytes.to_vec()));
    }
    let mut picture = image::load_from_memory_with_format(bytes, format).map_err(|e| e.to_string())?;
    if width.max(height) > MAX_SIDE {
        picture = picture.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle);
    }
    if picture.color().has_alpha() {
        let png = encode(&picture, ImageFormat::Png)?;
        if png.len() <= MAX_SEND {
            return Ok(("image/png", png));
        }
    }
    // JPEG has no alpha: what is transparent goes on white.
    let rgb = flatten(&picture);
    for quality in [85, 70, 55] {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;
        if out.len() <= MAX_SEND || quality == 55 {
            return Ok(("image/jpeg", out));
        }
    }
    unreachable!("the last quality returns")
}

fn encode(picture: &DynamicImage, format: ImageFormat) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    picture.write_to(&mut out, format).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

fn flatten(picture: &DynamicImage) -> DynamicImage {
    if !picture.color().has_alpha() {
        return DynamicImage::ImageRgb8(picture.to_rgb8());
    }
    let rgba = picture.to_rgba8();
    let rgb = image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let over = |c: u8| ((u16::from(c) * u16::from(a) + 255 * (255 - u16::from(a))) / 255) as u8;
        image::Rgb([over(r), over(g), over(b)])
    });
    DynamicImage::ImageRgb8(rgb)
}

/// Why an attached image is not sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Unsent {
    Gone,
    Changed,
    Unreadable(String),
}

impl Unsent {
    fn note(&self) -> String {
        match self {
            Self::Gone => "no longer on disk".to_owned(),
            Self::Changed => "the file changed since it was attached".to_owned(),
            Self::Unreadable(why) => why.clone(),
        }
    }
}

/// Prepared images by hash, so each is read and encoded once per run (the last few kept).
static PREPARED: LazyLock<Mutex<HashMap<String, Arc<String>>>> = LazyLock::new(Mutex::default);

/// The `data:` URL sent for [image]: from its file, which must be as it was attached.
pub fn data_url(image: &Attachment) -> Result<Arc<String>, Unsent> {
    if let Some(url) = PREPARED.lock().expect("prepared images").get(&image.sha256) {
        // Still there and the same size: the same file (a full check would read it again).
        if std::fs::metadata(&image.path).is_ok_and(|m| m.len() == image.bytes) {
            return Ok(url.clone());
        }
    }
    let bytes = match std::fs::read(&image.path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Unsent::Gone),
        Err(e) => return Err(Unsent::Unreadable(e.to_string())),
    };
    if hex(&Sha256::digest(&bytes)) != image.sha256 {
        return Err(Unsent::Changed);
    }
    let (mime, data) = prepare(&bytes).map_err(Unsent::Unreadable)?;
    let url = Arc::new(format!("data:{mime};base64,{}", STANDARD.encode(data)));
    let mut prepared = PREPARED.lock().expect("prepared images");
    if prepared.len() >= 16 {
        prepared.clear();
    }
    prepared.insert(image.sha256.clone(), url.clone());
    Ok(url)
}

/// The images a message carries (from the session file).
pub fn of(message: &Value) -> Vec<Attachment> {
    message.get(KEY).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

/// A user message: [text] with [images] beside it.
pub fn message(text: &str, images: &[Attachment]) -> Value {
    let mut message = json!({ "role": "user", "content": text });
    if !images.is_empty() {
        message[KEY] = json!(images);
    }
    message
}

/// Whether any of [messages] has images.
pub fn any(messages: &[Value]) -> bool {
    messages.iter().any(|m| m.get(KEY).is_some())
}

/// [messages] as they are sent: a message with images becomes text and image parts, each image
/// read from its file. An image is not sent when the model cannot see ([vision] false), or its
/// file is gone or changed; a note in the text says so instead.
pub fn expand(messages: &[Value], vision: Option<bool>) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let images = of(message);
            if message.get(KEY).is_none() {
                return message.clone();
            }
            let mut out = message.clone();
            if let Some(object) = out.as_object_mut() {
                object.remove(KEY);
            }
            if images.is_empty() {
                return out;
            }
            let mut text = message["content"].as_str().unwrap_or_default().to_owned();
            let mut parts = Vec::new();
            for (i, image) in images.iter().enumerate() {
                let why = if vision == Some(false) {
                    Some("this model can't see images".to_owned())
                } else {
                    match data_url(image) {
                        Ok(url) => {
                            parts.push(json!({ "type": "image_url", "image_url": { "url": url.as_str() } }));
                            None
                        }
                        Err(why) => Some(why.note()),
                    }
                };
                if let Some(why) = why {
                    text.push_str(&format!("\n({} not sent: {why})", image.marker(i + 1)));
                }
            }
            if parts.is_empty() {
                out["content"] = json!(text);
            } else {
                parts.insert(0, json!({ "type": "text", "text": text }));
                out["content"] = json!(parts);
            }
            out
        })
        .collect()
}

/// Image files in a paste: the whole paste is one or more paths to existing images (a terminal
/// pastes a dragged file's path, quoted or with `\ ` for spaces, or as a `file://` URL), relative
/// ones from [cwd]. None when it is anything else.
pub fn pasted_paths(text: &str, cwd: &Path) -> Option<Vec<PathBuf>> {
    let text = text.trim();
    if text.is_empty() || text.len() > 8192 {
        return None;
    }
    let words = shell_words(text)?;
    if words.is_empty() {
        return None;
    }
    words
        .iter()
        .map(|word| {
            let word = match word.strip_prefix("file://") {
                Some(rest) => percent_decode(rest.strip_prefix("localhost").unwrap_or(rest))?,
                None => word.clone(),
            };
            let path = match word.strip_prefix("~/") {
                Some(rest) => PathBuf::from(std::env::var_os("HOME")?).join(rest),
                None => PathBuf::from(&word),
            };
            let path = if path.is_absolute() { path } else { cwd.join(path) };
            (is_image(&path) && path.is_file()).then_some(path)
        })
        .collect()
}

/// [text] split as a shell would: by spaces, with `'…'`, `"…"` and `\` escapes. None when a quote
/// is left open.
fn shell_words(text: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                started = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => word.push(c),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => word.push(chars.next()?),
                        c => word.push(c),
                    }
                }
            }
            '\\' => {
                started = true;
                word.push(chars.next()?);
            }
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            c => {
                started = true;
                word.push(c);
            }
        }
    }
    if started {
        words.push(word);
    }
    Some(words)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(text.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The image on the clipboard, saved in [dir] (as `clipboard-<hash>.png`, so the conversation
/// can name it later): with `pngpaste` or `osascript` on macOS, `wl-paste` or `xclip` elsewhere.
pub fn from_clipboard(dir: &Path) -> Result<PathBuf, String> {
    let bytes = clipboard_png()?;
    sniff(&bytes).ok_or("the clipboard holds no image")?;
    let sha = hex(&Sha256::digest(&bytes));
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("clipboard-{}.png", &sha[..12]));
    if !path.exists() {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        std::io::Write::write_all(&mut file, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(path)
}

fn run(program: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    (out.status.success() && !out.stdout.is_empty()).then_some(out.stdout)
}

fn clipboard_png() -> Result<Vec<u8>, String> {
    let none = "the clipboard holds no image";
    if cfg!(target_os = "macos") {
        if let Some(pngpaste) = crate::find_on_path("pngpaste") {
            return run(&pngpaste, &["-"]).ok_or_else(|| none.to_owned());
        }
        // `«data PNGf89504E47…»`: the PNG in hex.
        let osascript = crate::find_on_path("osascript").ok_or("no osascript to read the clipboard with")?;
        let out = run(&osascript, &["-e", "the clipboard as «class PNGf»"]).ok_or(none)?;
        let text = String::from_utf8_lossy(&out);
        let hex = text.trim().strip_prefix("«data PNGf").and_then(|t| t.strip_suffix('»')).ok_or(none)?;
        return (0..hex.len())
            .step_by(2)
            .map(|i| hex.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| none.to_owned());
    }
    if let Some(wl) = crate::find_on_path("wl-paste") {
        return run(&wl, &["--type", "image/png"]).ok_or_else(|| none.to_owned());
    }
    if let Some(xclip) = crate::find_on_path("xclip") {
        return run(&xclip, &["-selection", "clipboard", "-t", "image/png", "-o"]).ok_or_else(|| none.to_owned());
    }
    Err("no clipboard tool for images (wl-paste or xclip)".to_owned())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A [width]×[height] image in [format] (a gradient, so it does not compress to nothing).
    pub fn picture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let rgb = image::RgbImage::from_fn(width, height, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        encode(&DynamicImage::ImageRgb8(rgb), format).unwrap()
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("autobot-images-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn small_images_go_as_they_are_and_big_ones_are_scaled_down() {
        let small = picture(64, 32, ImageFormat::Png);
        assert_eq!(prepare(&small).unwrap(), ("image/png", small.clone()));
        let big = picture(3000, 2000, ImageFormat::Png);
        let (mime, out) = prepare(&big).unwrap();
        assert_eq!(mime, "image/jpeg", "no transparency: JPEG");
        let scaled = image::load_from_memory(&out).unwrap();
        assert_eq!((scaled.width(), scaled.height()), (MAX_SIDE, 1045));
        // Transparency stays PNG.
        let rgba = image::RgbaImage::from_fn(2000, 400, |x, _| image::Rgba([0, 0, 0, (x % 256) as u8]));
        let clear = encode(&DynamicImage::ImageRgba8(rgba), ImageFormat::Png).unwrap();
        let (mime, out) = prepare(&clear).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(image::load_from_memory(&out).unwrap().width(), MAX_SIDE);
        let jpeg = picture(2400, 2400, ImageFormat::Jpeg);
        assert_eq!(image::load_from_memory(&prepare(&jpeg).unwrap().1).unwrap().height(), MAX_SIDE);
        assert!(prepare(b"GIF89a not really").is_err());
        assert!(prepare(b"hello").is_err());
    }

    #[test]
    fn attached_images_are_sent_beside_the_text_while_their_file_is_as_it_was() {
        let dir = dir("expand");
        let path = dir.join("shot.png");
        std::fs::write(&path, picture(40, 20, ImageFormat::Png)).unwrap();
        let shot = attach(&path).unwrap();
        assert_eq!(
            (shot.name.as_str(), shot.width, shot.height, shot.mime.as_str()),
            ("shot.png", 40, 20, "image/png")
        );
        assert_eq!(shot.label(1), "[image 1: shot.png 40×20]");
        assert!(attach(&dir.join("missing.png")).is_err());
        std::fs::write(dir.join("fake.png"), "not an image").unwrap();
        assert_eq!(attach(&dir.join("fake.png")).unwrap_err(), "fake.png is not a PNG, JPEG, WebP or GIF image");

        let stored = message("what is [image 1: shot.png]?", std::slice::from_ref(&shot));
        assert_eq!(stored[KEY][0]["sha256"], shot.sha256, "the reference, not the bytes");
        assert!(!stored.to_string().contains("base64"));
        let plain = json!({ "role": "assistant", "content": "hi" });
        let sent = expand(&[stored.clone(), plain.clone()], None);
        assert_eq!(sent[1], plain);
        assert!(sent[0].get(KEY).is_none());
        assert_eq!(sent[0]["content"][0], json!({ "type": "text", "text": "what is [image 1: shot.png]?" }));
        let url = sent[0]["content"][1]["image_url"]["url"].as_str().unwrap();
        let data = STANDARD.decode(url.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        assert_eq!(data, std::fs::read(&path).unwrap());
        // A model that cannot see gets the text, and a note.
        let blind = expand(std::slice::from_ref(&stored), Some(false));
        assert_eq!(
            blind[0]["content"],
            "what is [image 1: shot.png]?\n([image 1: shot.png] not sent: this model can't see images)"
        );
        // Changed, then gone: a note instead.
        std::fs::write(&path, picture(41, 20, ImageFormat::Png)).unwrap();
        let changed = expand(std::slice::from_ref(&stored), None);
        assert!(changed[0]["content"].as_str().unwrap().ends_with("not sent: the file changed since it was attached)"));
        std::fs::remove_file(&path).unwrap();
        let gone = expand(std::slice::from_ref(&stored), None);
        assert!(gone[0]["content"].as_str().unwrap().ends_with("not sent: no longer on disk)"));
        assert_eq!(of(&gone[0]), vec![]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pasted_paths_of_images_are_found_quoted_escaped_or_as_urls() {
        let dir = dir("paste");
        std::fs::write(dir.join("Screen Shot.png"), b"x").unwrap();
        std::fs::write(dir.join("b.JPG"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let d = dir.display();
        let one = Some(vec![dir.join("Screen Shot.png")]);
        assert_eq!(pasted_paths(&format!("'{d}/Screen Shot.png'"), &dir), one);
        assert_eq!(pasted_paths(&format!("\"{d}/Screen Shot.png\" "), &dir), one);
        assert_eq!(pasted_paths(&format!("{}/Screen\\ Shot.png", d), &dir), one);
        assert_eq!(pasted_paths(&format!("file://{}/Screen%20Shot.png", d), &dir), one);
        assert_eq!(pasted_paths("b.JPG", &dir), Some(vec![dir.join("b.JPG")]), "relative to the project");
        assert_eq!(
            pasted_paths(&format!("{d}/b.JPG '{d}/Screen Shot.png'"), &dir),
            Some(vec![dir.join("b.JPG"), dir.join("Screen Shot.png")]),
            "several dragged at once"
        );
        for not in ["look at b.JPG", "notes.txt", "missing.png", "", "'open", "b.JPG notes.txt"] {
            assert_eq!(pasted_paths(not, &dir), None, "{not:?}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
