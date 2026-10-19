//! `POST /v1/fetch`: a web page for the agent, through the node's network policy (offline
//! refuses; Tor and SOCKS5 carry it; HTTPS only), receipted and in the audit log like a cloud
//! request. Only on the loopback API: paired devices cannot use the node as a proxy.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;

/// Most bytes read from a page.
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Most text handed back.
pub const MAX_TEXT: usize = 32 * 1024;

pub struct Page {
    pub status: u16,
    pub content_type: String,
    pub text: String,
    pub truncated: bool,
}

/// Fetches [url] with [client] (the egress client), counting what arrives into [received].
pub async fn get(client: &reqwest::Client, url: &str, received: Arc<AtomicU64>) -> Result<Page, String> {
    let url = crate::egress::check(url)?;
    if url.scheme() != "https" {
        return Err(format!("{url}: only HTTPS pages"));
    }
    let response = client
        .get(url.clone())
        .header("accept", "text/html, text/plain, application/json;q=0.9, */*;q=0.5")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("{url}: {}", e.without_url()))?;
    let status = response.status().as_u16();
    let content_type =
        response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    let mut cut = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{url}: {}", e.without_url()))?;
        received.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            body.truncate(MAX_BYTES);
            cut = true;
            break;
        }
    }
    let raw = String::from_utf8_lossy(&body);
    let text = if content_type.contains("html") || raw.trim_start().starts_with('<') {
        readable(&raw)
    } else {
        raw.into_owned()
    };
    let truncated = cut || text.len() > MAX_TEXT;
    Ok(Page { status, content_type, text: text.chars().take(MAX_TEXT).collect(), truncated })
}

/// The readable text of an HTML page: no scripts, styles or tags; links kept as `text (url)`;
/// blocks on lines of their own.
pub fn readable(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 3);
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    let mut href: Option<String> = None;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let end = match html[i..].find('>') {
                Some(e) => i + e,
                None => break,
            };
            let tag = &lower[i + 1..end];
            let name: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            // Skip what is not text at all.
            if !tag.starts_with('/') && matches!(name.as_str(), "script" | "style" | "noscript" | "svg" | "head") {
                let close = format!("</{name}");
                i = lower[end..].find(&close).map_or(bytes.len(), |c| end + c);
                continue;
            }
            if tag.starts_with("!--") {
                i = html[i..].find("-->").map_or(bytes.len(), |c| i + c + 3);
                continue;
            }
            if name == "a" && !tag.starts_with('/') {
                href = attribute(&html[i + 1..end], "href").filter(|h| h.starts_with("http"));
            } else if name == "a"
                && let Some(link) = href.take()
            {
                out.push_str(&format!(" ({link})"));
            }
            let opens_line = matches!(name.as_str(), "li" | "tr") && !tag.starts_with('/');
            if opens_line
                || matches!(
                    name.as_str(),
                    "p" | "div"
                        | "br"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "pre"
                        | "section"
                        | "article"
                        | "header"
                        | "footer"
                        | "table"
                        | "ul"
                        | "ol"
                )
            {
                out.push('\n');
            }
            if name == "li" && !tag.starts_with('/') {
                out.push_str("- ");
            }
            i = end + 1;
        } else {
            let next = html[i..].find('<').map_or(bytes.len(), |n| i + n);
            out.push_str(&entities(&html[i..next]));
            i = next;
        }
    }
    // Collapse runs of whitespace; at most one blank line.
    let mut clean = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank == 1 && !clean.is_empty() {
                clean.push('\n');
            }
        } else {
            blank = 0;
            clean.push_str(&line);
            clean.push('\n');
        }
    }
    // The page's title (in the head, which is skipped) leads.
    let title = lower.find("<title").and_then(|start| {
        let open = start + html[start..].find('>')? + 1;
        let close = open + lower[open..].find("</title")?;
        Some(entities(html[open..close].trim()))
    });
    match title.filter(|t| !t.is_empty() && !clean.trim_start().starts_with(t.as_str())) {
        Some(title) => format!("{title}\n\n{}", clean.trim()),
        None => clean.trim().to_owned(),
    }
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[at..];
    let value = match rest.chars().next()? {
        q @ ('"' | '\'') => rest[1..].split(q).next()?,
        _ => rest.split(|c: char| c.is_whitespace() || c == '>').next()?,
    };
    Some(entities(value))
}

fn entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::readable;

    #[test]
    fn html_becomes_readable_text() {
        let html = r#"<html><head><title>Notes &amp; news</title><style>p{}</style></head><body>
            <script>alert(1)</script><!-- note -->
            <h1>Release&nbsp;notes</h1><p>Fixed the <a href="https://example.com/bug">bug</a> &amp; more.</p>
            <ul><li>one</li><li>two</li></ul></body></html>"#;
        assert_eq!(
            readable(html),
            "Notes & news\n\nRelease notes\n\nFixed the bug (https://example.com/bug) & more.\n\n- one\n- two"
        );
    }
}
