//! The `browser` tool: a headless Chrome, Chromium, Edge or Brave on this machine, driven over
//! the Chrome DevTools Protocol (a WebSocket on loopback), for pages `web_fetch` cannot read
//! (scripts, logins, forms) and for looking at a dev server. One browser per agent process,
//! started on first use with a throwaway profile and stopped with the session's processes.
//!
//! Actions: `navigate` (to a new site asks first, like a fetch; under the node's network mode),
//! `text` (the page's text), `snapshot` (the elements to act on, numbered), `click` (by number,
//! CSS selector or visible text; never a form's submit button or a link to another site),
//! `type` and `submit` (ask first: they send what is typed), `screenshot` (a PNG under
//! `$AUTOBOT_HOME/attachments`, shown to a model that can see), `close`.
//!
//! The browser's own traffic follows the gateway's network mode: through Tor or the SOCKS5 proxy
//! when it is set, only loopback while the node is offline. It is not receipted.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// How long one DevTools command may take.
const COMMAND_WAIT: Duration = Duration::from_secs(30);
/// How long a page may take to load before what is there is used.
const LOAD_WAIT: Duration = Duration::from_secs(15);

/// One browser action, parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Navigate { url: String },
    Text,
    Snapshot,
    Click { target: Target },
    Type { target: Target, text: String, submit: bool },
    Submit { target: Target },
    Screenshot,
    Close,
}

/// Which element: a number from the snapshot, a CSS selector, or its visible text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Ref(u64),
    Selector(String),
    Text(String),
}

impl Target {
    fn from(args: &Value) -> Result<Self, String> {
        if let Some(n) = args.get("ref").and_then(Value::as_u64) {
            return Ok(Self::Ref(n));
        }
        let text = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        if let Some(selector) = text("selector") {
            return Ok(Self::Selector(selector.to_owned()));
        }
        if let Some(label) = text("element") {
            return Ok(Self::Text(label.to_owned()));
        }
        Err("say which element: ref (a number from snapshot), selector (CSS) or element (its visible text)".to_owned())
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Ref(n) => format!("element [{n}]"),
            Self::Selector(s) => format!("element {s}"),
            Self::Text(t) => format!("\"{t}\""),
        }
    }

    /// `ref, selector, text` for the page's finder.
    fn js_args(&self) -> String {
        let (r, s, t) = match self {
            Self::Ref(n) => (json!(n), json!(null), json!(null)),
            Self::Selector(s) => (json!(null), json!(s), json!(null)),
            Self::Text(t) => (json!(null), json!(null), json!(t)),
        };
        format!("{r}, {s}, {t}")
    }
}

impl Act {
    pub fn parse(args: &Value) -> Result<Self, String> {
        let action = args.get("action").and_then(Value::as_str).unwrap_or_default();
        Ok(match action {
            "navigate" | "open" | "goto" => {
                let url = args.get("url").and_then(Value::as_str).map(str::trim).unwrap_or_default();
                Self::Navigate { url: normalize(url)? }
            }
            "text" | "read" => Self::Text,
            "snapshot" => Self::Snapshot,
            "click" => Self::Click { target: Target::from(args)? },
            "type" => Self::Type {
                target: Target::from(args)?,
                text: args.get("text").and_then(Value::as_str).ok_or("`text` is missing")?.to_owned(),
                submit: args.get("submit").and_then(Value::as_bool).unwrap_or(false),
            },
            "submit" => Self::Submit { target: Target::from(args)? },
            "screenshot" => Self::Screenshot,
            "close" => Self::Close,
            other => {
                return Err(format!(
                    "unknown action {other:?} (navigate, text, snapshot, click, type, submit, screenshot, close)"
                ));
            }
        })
    }
}

/// A URL the browser may open: http or https (`localhost:3000` gets `http://`), or about:blank.
pub fn normalize(url: &str) -> Result<String, String> {
    if url.is_empty() {
        return Err("`url` is missing".to_owned());
    }
    if url == "about:blank" {
        return Ok(url.to_owned());
    }
    let url = if url.contains("://") {
        url.to_owned()
    } else if url.starts_with("localhost") || url.starts_with("127.0.0.1") || url.starts_with("[::1]") {
        format!("http://{url}")
    } else {
        format!("https://{url}")
    };
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("{url}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!("{url}: only http and https pages"));
    }
    Ok(parsed.to_string())
}

/// `scheme://host[:port]` of [url]; None for about:blank and the like.
pub fn origin(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

/// Whether [url] is on this machine.
pub fn loopback(url: &str) -> bool {
    reqwest::Url::parse(url).ok().is_some_and(|u| {
        let host = u.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
        host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    })
}

/// The page the browser shows now, for approvals (a navigation within it does not ask).
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

pub fn current_url() -> Option<String> {
    CURRENT.lock().expect("current page").clone()
}

fn set_current(url: Option<String>) {
    *CURRENT.lock().expect("current page") = url;
}

/// The browser program: `$AUTOBOT_BROWSER`, else the first Chrome, Chromium, Edge or Brave
/// found where they install.
pub fn find() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AUTOBOT_BROWSER").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let mut apps: Vec<PathBuf> = Vec::new();
            if cfg!(target_os = "macos") {
                let bundles = [
                    "Google Chrome.app/Contents/MacOS/Google Chrome",
                    "Chromium.app/Contents/MacOS/Chromium",
                    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                    "Brave Browser.app/Contents/MacOS/Brave Browser",
                ];
                let mut roots = vec![PathBuf::from("/Applications")];
                if let Some(home) = std::env::var_os("HOME") {
                    roots.push(PathBuf::from(home).join("Applications"));
                }
                for root in roots {
                    apps.extend(bundles.iter().map(|b| root.join(b)));
                }
            }
            if let Some(found) = apps.into_iter().find(|p| p.is_file()) {
                return Some(found);
            }
            [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "microsoft-edge",
                "microsoft-edge-stable",
                "brave-browser",
            ]
            .iter()
            .find_map(|name| crate::find_on_path(name))
        })
        .clone()
}

/// The running browser and its page.
struct Browser {
    child: tokio::process::Child,
    socket: Socket,
    session: String,
    next: u64,
    profile: PathBuf,
    /// When it was last used: an idle browser is closed ([IDLE]).
    used: std::time::Instant,
    /// The page's main frame, whose navigations count.
    frame: String,
    /// The page's events read while waiting for a command's answer, oldest first.
    events: std::collections::VecDeque<Value>,
}

/// How many unread page events are kept.
const EVENTS_KEPT: usize = 500;

/// How long the browser stays open unused (in `autobot serve` the process lives on).
const IDLE: Duration = Duration::from_secs(10 * 60);

/// Closes the browser once it has been idle for [IDLE]; ends with it.
async fn reap() {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut slot = slot().lock().await;
        match slot.as_ref() {
            None => return,
            Some(b) if b.used.elapsed() > IDLE => {
                if let Some(browser) = slot.take() {
                    set_current(None);
                    browser.close().await;
                }
                return;
            }
            Some(_) => {}
        }
    }
}

static BROWSER: OnceLock<tokio::sync::Mutex<Option<Browser>>> = OnceLock::new();

fn slot() -> &'static tokio::sync::Mutex<Option<Browser>> {
    BROWSER.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// The proxy flags for the node's network mode: everything but loopback through Tor or SOCKS5,
/// or nowhere while offline (loopback still works: Chrome never proxies it).
fn proxy_args(network: &invincible_policy::NetworkMode) -> Vec<String> {
    use invincible_policy::NetworkMode;
    match network {
        NetworkMode::Direct => Vec::new(),
        NetworkMode::Tor { host, port } | NetworkMode::Socks5 { host, port } => {
            vec![format!("--proxy-server=socks5://{host}:{port}")]
        }
        // A proxy that is not there: nothing leaves.
        NetworkMode::Offline => vec!["--proxy-server=socks5://127.0.0.1:9".to_owned()],
    }
}

impl Browser {
    async fn launch(program: &Path, network: &invincible_policy::NetworkMode) -> Result<Self, String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let profile = std::env::temp_dir().join(format!("autobot-browser-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&profile).map_err(|e| format!("{}: {e}", profile.display()))?;
        let mut child = tokio::process::Command::new(program)
            .args([
                "--headless=new",
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--disable-default-apps",
                "--disable-component-update",
                "--metrics-recording-only",
                "--mute-audio",
                "--window-size=1280,900",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .args(proxy_args(network))
            .arg("about:blank")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("{}: {e}", program.display()))?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        let find_url = async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = line.split_whitespace().find(|w| w.starts_with("ws://")) {
                    return Some(url.to_owned());
                }
            }
            None
        };
        let url = match tokio::time::timeout(Duration::from_secs(20), find_url).await {
            Ok(Some(url)) => url,
            _ => {
                let _ = child.kill().await;
                let _ = std::fs::remove_dir_all(&profile);
                return Err(format!("{} did not start its DevTools endpoint", program.display()));
            }
        };
        // Its log goes nowhere from now on (a full pipe would stall it).
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        let address = url
            .strip_prefix("ws://")
            .and_then(|rest| rest.split('/').next())
            .ok_or(format!("an odd DevTools address: {url}"))?
            .to_owned();
        let stream = tokio::net::TcpStream::connect(&address).await.map_err(|e| format!("DevTools {address}: {e}"))?;
        let (socket, _) =
            tokio_tungstenite::client_async(url.as_str(), stream).await.map_err(|e| format!("DevTools: {e}"))?;
        let mut browser = Self {
            child,
            socket,
            session: String::new(),
            next: 0,
            profile,
            used: std::time::Instant::now(),
            frame: String::new(),
            events: std::collections::VecDeque::new(),
        };
        let target = browser.call(None, "Target.createTarget", json!({ "url": "about:blank" })).await?;
        let target = target["targetId"].as_str().ok_or("no page")?.to_owned();
        let attached =
            browser.call(None, "Target.attachToTarget", json!({ "targetId": target, "flatten": true })).await?;
        browser.session = attached["sessionId"].as_str().ok_or("not attached to the page")?.to_owned();
        browser.page("Page.enable", json!({})).await?;
        let tree = browser.page("Page.getFrameTree", json!({})).await?;
        browser.frame = tree["frameTree"]["frame"]["id"].as_str().ok_or("no main frame")?.to_owned();
        Ok(browser)
    }

    /// Keeps [message] when it is an event of the page.
    fn keep(&mut self, message: Value) {
        if message.get("method").is_some() && message["sessionId"].as_str() == Some(self.session.as_str()) {
            if self.events.len() >= EVENTS_KEPT {
                self.events.pop_front();
            }
            self.events.push_back(message);
        }
    }

    /// The next event of the page, kept or arriving before [deadline]; None when none came.
    async fn next_event(&mut self, deadline: tokio::time::Instant) -> Result<Option<Value>, String> {
        loop {
            if let Some(event) = self.events.pop_front() {
                return Ok(Some(event));
            }
            let message = match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Err(_) => return Ok(None),
                Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(text.as_str()).unwrap_or_default(),
                Ok(Some(Ok(Message::Close(_))) | None) => return Err("the browser went away".to_owned()),
                Ok(Some(Err(e))) => return Err(format!("DevTools: {e}")),
                Ok(Some(Ok(_))) => continue,
            };
            self.keep(message);
        }
    }

    /// Waits for the main frame to finish a navigation: the one with [loader] (Page.navigate's
    /// answer) to commit and load; or, with None, one that starts within [start] (a click, a
    /// form, typing enter): if none starts, or it stays within the document, there is nothing
    /// to wait for. At most [LOAD_WAIT]: then the page is used as it is.
    async fn load(&mut self, loader: Option<&str>, start: Duration) -> Result<(), String> {
        let now = tokio::time::Instant::now();
        let (deadline, start_by) = (now + LOAD_WAIT, now + start);
        let mut started = loader.is_some();
        let mut committed = loader.is_none();
        loop {
            let Some(event) = self.next_event(if started { deadline } else { start_by }).await? else {
                return Ok(());
            };
            let p = &event["params"];
            let main = |id: &Value| id.as_str() == Some(self.frame.as_str());
            match event["method"].as_str().unwrap_or_default() {
                "Page.frameStartedLoading" if main(&p["frameId"]) => started = true,
                "Page.frameNavigated"
                    if main(&p["frame"]["id"]) && loader.is_none_or(|l| p["frame"]["loaderId"].as_str() == Some(l)) =>
                {
                    started = true;
                    committed = true;
                }
                "Page.navigatedWithinDocument" if main(&p["frameId"]) && loader.is_none() && !started => return Ok(()),
                "Page.frameStoppedLoading" if main(&p["frameId"]) && committed => return Ok(()),
                "Page.loadEventFired" if committed => return Ok(()),
                _ => {}
            }
        }
    }

    /// Goes to [url] and waits until that page has committed and loaded.
    async fn navigate(&mut self, url: &str) -> Result<(), String> {
        // What came before is not this navigation.
        self.events.clear();
        let result = self.page("Page.navigate", json!({ "url": url })).await?;
        if let Some(error) = result["errorText"].as_str().filter(|e| !e.is_empty()) {
            return Err(format!("{url}: {error}"));
        }
        match result["loaderId"].as_str().map(str::to_owned) {
            Some(loader) => self.load(Some(&loader), LOAD_WAIT).await,
            // Within the same document (a #fragment): nothing loads.
            None => self.load(None, Duration::from_millis(300)).await,
        }
    }

    /// One DevTools command ([session]: on the page); its result.
    async fn call(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.socket.send(Message::text(message.to_string())).await.map_err(|e| format!("DevTools: {e}"))?;
        let wait = async {
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(reply) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        if reply["id"].as_u64() != Some(id) {
                            // An event of the page: kept for whoever waits for one.
                            self.keep(reply);
                            continue;
                        }
                        if let Some(error) = reply.get("error") {
                            return Err(format!("{method}: {}", error["message"].as_str().unwrap_or("failed")));
                        }
                        return Ok(reply["result"].clone());
                    }
                    Some(Ok(Message::Close(_))) | None => return Err("the browser went away".to_owned()),
                    Some(Err(e)) => return Err(format!("DevTools: {e}")),
                    Some(Ok(_)) => {}
                }
            }
        };
        tokio::time::timeout(COMMAND_WAIT, wait).await.map_err(|_| format!("{method}: no answer in 30 seconds"))?
    }

    async fn page(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let session = self.session.clone();
        self.call(Some(&session), method, params).await
    }

    /// [expression]'s value in the page (promises awaited).
    async fn eval(&mut self, expression: &str) -> Result<Value, String> {
        let result = self
            .page("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }))
            .await?;
        if let Some(e) = result.get("exceptionDetails") {
            let text = e["exception"]["description"].as_str().or(e["text"].as_str()).unwrap_or("an error");
            return Err(format!("the page: {}", text.lines().next().unwrap_or(text)));
        }
        Ok(result["result"]["value"].clone())
    }

    /// Waits for a navigation an action started (a click, a form, enter) to load, then notes
    /// where the page is: the committed document's address, which approvals go by.
    async fn settle(&mut self) -> Result<(String, String), String> {
        self.load(None, Duration::from_millis(500)).await?;
        self.here().await
    }

    /// Where the page is now, and its title; noted for approvals.
    async fn here(&mut self) -> Result<(String, String), String> {
        let here = self.eval("[location.href, document.title]").await?;
        let url = here[0].as_str().unwrap_or_default().to_owned();
        set_current(Some(url.clone()));
        Ok((url, here[1].as_str().unwrap_or_default().to_owned()))
    }

    async fn close(mut self) {
        let _ = self.call(None, "Browser.close", json!({})).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        let _ = self.child.kill().await;
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

/// Finds an element: `(ref, selector, text)`; null when nothing matches.
const FIND: &str = r#"(function(ref, sel, text) {
  if (ref !== null) return document.querySelector('[data-autobot-ref="' + ref + '"]');
  if (sel) return document.querySelector(sel);
  const t = text.toLowerCase().trim();
  const all = [...document.querySelectorAll('a,button,input,textarea,select,label,summary,option,[role],[onclick],[contenteditable]')];
  const name = e => (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || e.title || '').trim().toLowerCase();
  let el = all.find(e => name(e) === t) || all.find(e => name(e).includes(t));
  if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  return el || null;
})"#;

/// Numbers what can be acted on and lists it, with the headings, a line each.
const SNAPSHOT: &str = r#"(function() {
  const out = [];
  let n = 0;
  const seen = new Set();
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = e => {
    let t = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.alt || e.name || '').replace(/\s+/g, ' ').trim();
    if (!t && e.id) { const l = document.querySelector('label[for="' + e.id + '"]'); if (l) t = l.innerText.trim(); }
    return t.slice(0, 80);
  };
  for (const e of document.querySelectorAll('h1,h2,h3,a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true]')) {
    if (seen.has(e) || !visible(e)) continue;
    seen.add(e);
    const tag = e.tagName.toLowerCase();
    if (/^h[1-3]$/.test(tag)) { out.push('# ' + label(e)); continue; }
    n += 1;
    e.setAttribute('data-autobot-ref', String(n));
    let kind = e.getAttribute('role') || tag;
    if (tag === 'input') kind = 'input ' + (e.type || 'text');
    let extra = '';
    if (tag === 'a') { try { const u = new URL(e.href); extra = u.origin === location.origin ? ' → ' + u.pathname : ' → ' + u.origin; } catch (_) {} }
    if ((tag === 'input' || tag === 'textarea') && e.type !== 'password' && e.value) extra += ' = "' + e.value.slice(0, 40) + '"';
    if (e.type === 'password') extra += ' (password)';
    out.push('[' + n + '] ' + kind + ' "' + label(e) + '"' + extra);
    if (n >= 200) { out.push('… more not listed'); break; }
  }
  return out.join('\n');
})()"#;

/// Runs [act] in the browser, starting it if it is not running; [shots]: where screenshots go.
/// What it gives back, and the screenshot file when it took one.
pub async fn run(act: &Act, shots: &Path, limit: usize) -> Result<(String, Option<PathBuf>), String> {
    let mut slot = slot().lock().await;
    if *act == Act::Close {
        set_current(None);
        return Ok(match slot.take() {
            Some(browser) => {
                browser.close().await;
                ("closed the browser".to_owned(), None)
            }
            None => ("the browser is not running".to_owned(), None),
        });
    }
    if slot.is_none() {
        let program = find().ok_or(
            "no browser here: install Chrome, Chromium, Edge or Brave (or set AUTOBOT_BROWSER to one), or use web_fetch",
        )?;
        let network = crate::network().unwrap_or_default();
        *slot = Some(Browser::launch(&program, &network).await?);
        tokio::spawn(reap());
    }
    let browser = slot.as_mut().expect("started");
    browser.used = std::time::Instant::now();
    let result = act_on(browser, act, shots, limit).await;
    // A browser that went away is started again next time.
    if result.as_ref().is_err_and(|e| e.contains("the browser went away") || e.starts_with("DevTools")) {
        if let Some(browser) = slot.take() {
            browser.close().await;
        }
        set_current(None);
    }
    result
}

async fn act_on(b: &mut Browser, act: &Act, shots: &Path, limit: usize) -> Result<(String, Option<PathBuf>), String> {
    let text = |s: String| Ok((s, None));
    match act {
        Act::Navigate { url } => {
            b.navigate(url).await?;
            let (now, title) = b.here().await?;
            // Approvals go by where the page is: never the blank page it left.
            if now == "about:blank" && url != "about:blank" {
                set_current(None);
                return Err(format!("{url} did not load in {} seconds", LOAD_WAIT.as_secs()));
            }
            let url = now;
            let body = b.eval("document.body ? document.body.innerText : ''").await?;
            let body = body.as_str().unwrap_or_default();
            let head: String = body.chars().take(2000).collect();
            let more = if body.chars().count() > 2000 { "\n[… more: text reads it all]" } else { "" };
            text(format!(
                "opened {url}\ntitle: {title}\n\n{head}{more}\n\n(snapshot lists what can be clicked or typed into)"
            ))
        }
        Act::Text => {
            let (url, title) = b.here().await?;
            let body = b.eval("document.body ? document.body.innerText : ''").await?;
            text(crate::tools::cut_to(format!("{url}\ntitle: {title}\n\n{}", body.as_str().unwrap_or_default()), limit))
        }
        Act::Snapshot => {
            let (url, title) = b.here().await?;
            let list = b.eval(SNAPSHOT).await?;
            let list = list.as_str().unwrap_or_default();
            let list = if list.is_empty() { "(nothing to act on)" } else { list };
            text(crate::tools::cut_to(format!("{url}\ntitle: {title}\n\n{list}"), limit))
        }
        Act::Click { target } => {
            let script = format!(
                r#"(function() {{
                  const el = {FIND}({args});
                  if (!el) return {{ error: 'nothing matches' }};
                  const button = el.closest('button,input[type=submit],input[type=image]');
                  if (button && button.form && (button.type === 'submit' || button.type === 'image')) return {{ error: 'it submits a form: use submit (the owner is asked first)' }};
                  const link = el.closest('a[href]');
                  if (link) {{ try {{ const u = new URL(link.href); if (u.origin !== location.origin && /^https?:$/.test(u.protocol)) return {{ error: 'it leads to ' + u.origin + ': navigate there instead (a new site is asked for)' }}; }} catch (_) {{}} }}
                  el.scrollIntoView({{ block: 'center' }});
                  el.click();
                  return {{ ok: (el.innerText || el.value || el.tagName).toString().trim().slice(0, 80) }};
                }})()"#,
                args = target.js_args()
            );
            let done = b.eval(&script).await?;
            if let Some(e) = done["error"].as_str() {
                return Err(format!("{}: {e}", target.describe()));
            }
            let (url, title) = b.settle().await?;
            text(format!("clicked \"{}\"; now at {url} ({title})", done["ok"].as_str().unwrap_or_default()))
        }
        Act::Type { target, text: typed, submit } => {
            let script = format!(
                r#"(function() {{
                  const el = {FIND}({args});
                  if (!el) return {{ error: 'nothing matches' }};
                  el.scrollIntoView({{ block: 'center' }});
                  el.focus();
                  if ('value' in el) {{ el.value = ''; el.dispatchEvent(new Event('input', {{ bubbles: true }})); }}
                  return {{ ok: true }};
                }})()"#,
                args = target.js_args()
            );
            let found = b.eval(&script).await?;
            if let Some(e) = found["error"].as_str() {
                return Err(format!("{}: {e}", target.describe()));
            }
            b.page("Input.insertText", json!({ "text": typed })).await?;
            if *submit {
                for kind in ["keyDown", "keyUp"] {
                    b.page(
                        "Input.dispatchKeyEvent",
                        json!({ "type": kind, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r" }),
                    )
                    .await?;
                }
            }
            let (url, title) = b.settle().await?;
            let sent = if *submit { " and pressed enter" } else { "" };
            text(format!(
                "typed {} characters into {}{sent}; at {url} ({title})",
                typed.chars().count(),
                target.describe()
            ))
        }
        Act::Submit { target } => {
            let script = format!(
                r#"(function() {{
                  const el = {FIND}({args});
                  if (!el) return {{ error: 'nothing matches' }};
                  const form = el.form || el.closest('form');
                  if (el.click && (el.type === 'submit' || el.tagName === 'BUTTON')) {{ el.click(); return {{ ok: true }}; }}
                  if (!form) return {{ error: 'it is not in a form' }};
                  if (form.requestSubmit) form.requestSubmit(); else form.submit();
                  return {{ ok: true }};
                }})()"#,
                args = target.js_args()
            );
            let done = b.eval(&script).await?;
            if let Some(e) = done["error"].as_str() {
                return Err(format!("{}: {e}", target.describe()));
            }
            let (url, title) = b.settle().await?;
            text(format!("submitted; now at {url} ({title})"))
        }
        Act::Screenshot => {
            b.here().await?;
            let shot = b.page("Page.captureScreenshot", json!({ "format": "png" })).await?;
            let data = shot["data"].as_str().ok_or("no screenshot")?;
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(shots).map_err(|e| format!("{}: {e}", shots.display()))?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
            let path = shots.join(format!("browser-{stamp}.png"));
            std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
            let size =
                image::load_from_memory(&bytes).map(|i| format!(" ({}×{})", i.width(), i.height())).unwrap_or_default();
            Ok((format!("saved a screenshot{size}: {}", path.display()), Some(path)))
        }
        Act::Close => unreachable!("handled before"),
    }
}

/// Stops the browser, if one runs (the session's end).
pub async fn close() {
    if let Some(slot) = BROWSER.get()
        && let Some(browser) = slot.lock().await.take()
    {
        browser.close().await;
    }
    set_current(None);
}

/// The tool's definition.
pub fn definition() -> Value {
    json!({ "type": "function", "function": {
        "name": "browser",
        "description": "A headless web browser, for pages that need scripts, a login or a form, and for checking a dev server (http://localhost:3000). Actions: navigate (url; a new site asks the owner first), text (the page's text), snapshot (numbered list of what can be clicked or typed into), click (ref, selector or element text; not form submits or links to other sites), type (ref/selector/element, text, submit to press enter; asks first), submit (a form; asks first), screenshot (you see it when your model takes images), close. Prefer web_fetch for plain reading.",
        "parameters": { "type": "object", "properties": {
            "action": { "type": "string", "enum": ["navigate", "text", "snapshot", "click", "type", "submit", "screenshot", "close"] },
            "url": { "type": "string" },
            "ref": { "type": "integer", "description": "An element's number from snapshot." },
            "selector": { "type": "string", "description": "A CSS selector." },
            "element": { "type": "string", "description": "The element's visible text or label." },
            "text": { "type": "string", "description": "For type: what to type." },
            "submit": { "type": "boolean", "description": "For type: press enter after." },
        }, "required": ["action"] },
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_parse_and_urls_are_checked() {
        assert_eq!(
            Act::parse(&json!({"action": "navigate", "url": "localhost:3000/x"})).unwrap(),
            Act::Navigate { url: "http://localhost:3000/x".into() }
        );
        assert_eq!(
            Act::parse(&json!({"action": "navigate", "url": "docs.rs"})).unwrap(),
            Act::Navigate { url: "https://docs.rs/".into() }
        );
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", ""] {
            assert!(Act::parse(&json!({"action": "navigate", "url": bad})).is_err(), "{bad}");
        }
        assert_eq!(Act::parse(&json!({"action": "click", "ref": 3})).unwrap(), Act::Click { target: Target::Ref(3) });
        assert_eq!(
            Act::parse(&json!({"action": "type", "element": "Search", "text": "rust", "submit": true})).unwrap(),
            Act::Type { target: Target::Text("Search".into()), text: "rust".into(), submit: true }
        );
        assert!(Act::parse(&json!({"action": "click"})).is_err());
        assert!(Act::parse(&json!({"action": "type", "ref": 1})).is_err());
        assert!(Act::parse(&json!({"action": "fly"})).is_err());
        assert_eq!(origin("https://docs.rs/serde/latest").as_deref(), Some("https://docs.rs"));
        assert_eq!(origin("http://localhost:3000/a").as_deref(), Some("http://localhost:3000"));
        assert_eq!(origin("about:blank"), None);
        assert!(loopback("http://127.0.0.1:8080/") && loopback("http://localhost/") && !loopback("https://docs.rs/"));
        assert_eq!(Target::Text("Go \"now\"".into()).js_args(), r#"null, null, "Go \"now\"""#);
    }

    #[test]
    fn the_browser_follows_the_network_mode() {
        use invincible_policy::NetworkMode;
        assert!(proxy_args(&NetworkMode::Direct).is_empty());
        assert_eq!(
            proxy_args(&NetworkMode::Tor { host: "127.0.0.1".into(), port: 9050 }),
            ["--proxy-server=socks5://127.0.0.1:9050"]
        );
        assert_eq!(proxy_args(&NetworkMode::Offline), ["--proxy-server=socks5://127.0.0.1:9"]);
    }
}
