import SwiftUI
import WebKit

/**
 * A terminal in an agent's VM (the PWA's): a login shell on a real terminal, drawn by the node's own emulator (/term.js,
 * the PWA's), with the keys a phone's keyboard lacks below it. What its sign-ins print to open (Claude Code's page,
 * Codex's) is a button: the vendor's own sign-in, done in its own tool in the VM, so what it signs in stays there and
 * The primary never holds it. One already open in the VM is taken up again; Done closes it, and with it its shell.
 */
struct AgentTerminalView: View {
    let session: Session
    let agent: VMSeat
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var terminal: AgentTerminal
    @State private var bridge: TerminalBridge

    init(session: Session, agent: VMSeat) {
        self.session = session
        self.agent = agent
        _terminal = State(initialValue: AgentTerminal(sandbox: agent.sandbox ?? ""))
        _bridge = State(initialValue: TerminalBridge(origin: session.node.origin))
    }

    /// Keys a phone's keyboard lacks, as a terminal takes them (the PWA's).
    private static let keys: [(label: String, keys: String, name: String)] = [
        ("esc", "\u{1b}", "Escape"), ("tab", "\t", "Tab"), ("^C", "\u{03}", "Control C"), ("^D", "\u{04}", "Control D"),
        ("←", "\u{1b}[D", "Left"), ("↑", "\u{1b}[A", "Up"), ("↓", "\u{1b}[B", "Down"), ("→", "\u{1b}[C", "Right"),
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TerminalScreen(bridge: bridge)
                    .background(Color(red: 6 / 255, green: 6 / 255, blue: 7 / 255))
                if let link = terminal.link {
                    Button { openURL(link) } label: {
                        Label("Open \(link.host() ?? "the page") to sign in", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.ink)
                    .padding(.horizontal, Metrics.margin)
                    .padding(.top, Space.s2)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.s2) {
                        ForEach(Self.keys, id: \.name) { key in
                            Button(key.label) { terminal.type(key.keys); bridge.focus() }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .accessibilityLabel(key.name)
                        }
                        Button { if let text = Pasteboard.text { terminal.type(text) } } label: { Label("Paste", systemImage: "doc.on.clipboard") }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    .padding(.horizontal, Metrics.margin)
                    .padding(.vertical, Space.s2)
                }
                .disabled(terminal.ended)
                if !terminal.status.isEmpty {
                    Text(terminal.status).font(.caption).foregroundStyle(.secondary).padding(.bottom, Space.s2)
                }
            }
            .navigationTitle("\(agent.name)'s terminal")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        terminal.close(with: session.client)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .barLeading) {
                    Menu {
                        // The vendors' own sign-ins, typed for you into this shell: they run in the VM, and keep what they sign in there.
                        Button("Sign Claude Code in") { terminal.type("claude auth login\r") }
                        Button("Sign Codex in") { terminal.type("codex login --device-auth\r") }
                    } label: {
                        Label("Sign a tool in", systemImage: "person.badge.key")
                    }
                    .disabled(terminal.ended)
                }
            }
        }
        .sheetSize(width: 860, height: 600)
        // A terminal is dark whatever the phone's appearance: its bar and keys with it.
        .preferredColorScheme(.dark)
        .task { await terminal.run(with: session.client, on: bridge) }
        // Its keys (esc, tab, ^C) are pressed between what you type: they keep the keyboard.
        .holdsKeyboard()
    }
}

/**
 * A terminal shown and typed into: the node's emulator, the PWA's own, in a page of its own that loads it from the
 * node and nothing else (no cookies kept, no navigating away). What is typed comes back here; what to show goes in.
 */
@MainActor final class TerminalBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    var onKeys: (String) -> Void = { _ in }
    var onSize: (TerminalSize) -> Void = { _ in }
    /// Its size in characters, once the emulator has fitted it to its box.
    private(set) var size: TerminalSize?
    private var waiting: [String] = []
    private var started = false

    private static let page = """
    <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <style>html,body{margin:0;height:100%;background:#060607;overflow:hidden}#s{position:absolute;inset:6px}</style>
    <div id="s"></div>
    <script type="module">
    const post = (name, value) => window.webkit.messageHandlers[name].postMessage(value);
    try {
      const { mountEmulator } = await import("/term.js");
      const box = document.getElementById("s");
      const em = mountEmulator(box);
      window.terminal = {
        write: (b) => em.write(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))),
        reset: () => em.reset(),
        focus: () => em.focus(),
      };
      em.onKeys((data) => post("keys", data));
      new ResizeObserver(() => post("size", em.fit())).observe(box);
      post("ready", em.fit());
    } catch (error) { post("failed", String(error)); }
    </script>
    """

    init(origin: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        let relay = Relay(self)
        for name in ["keys", "size", "ready", "failed"] { configuration.userContentController.add(relay, name: name) }
        webView.navigationDelegate = self
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 6 / 255, green: 6 / 255, blue: 7 / 255, alpha: 1)
        webView.scrollView.isScrollEnabled = false
        #else
        // (A Mac's web view has no scroll view of its own to stop: the page itself never scrolls.)
        webView.underPageBackgroundColor = NSColor(srgbRed: 6 / 255, green: 6 / 255, blue: 7 / 255, alpha: 1)
        #endif
        webView.loadHTMLString(Self.page, baseURL: origin)
    }

    var failed: (String) -> Void = { _ in }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "keys": if let data = message.body as? String { onKeys(data) }
        case "failed": failed(message.body as? String ?? "The terminal couldn't be drawn.")
        default:
            guard let body = message.body as? [String: Any], let cols = body["cols"] as? Int, let rows = body["rows"] as? Int else { return }
            size = TerminalSize(cols: cols, rows: rows)
            if message.name == "ready" {
                started = true
                for chunk in waiting { run("terminal.write('\(chunk)')") }
                waiting.removeAll()
            }
            onSize(TerminalSize(cols: cols, rows: rows))
        }
    }

    /// What the terminal shows next, as the node sent it (base64: nothing in it can break out of the call).
    func write(_ base64: String) {
        guard base64.wholeMatch(of: #/[A-Za-z0-9+\/=]*/#) != nil else { return }
        if started { run("terminal.write('\(base64)')") } else { waiting.append(base64) }
    }

    func reset() { if started { run("terminal.reset()") } else { waiting.removeAll() } }
    func focus() { if started { run("terminal.focus()") } }

    private func run(_ script: String) { webView.evaluateJavaScript(script, completionHandler: nil) }

    // Only the page itself is loaded: nothing it shows can take the view elsewhere.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.navigationType == .other && action.targetFrame?.isMainFrame == true && action.request.url?.scheme != "javascript" && !started ? .allow : .cancel
    }

    /// Holds the bridge weakly, so the page's handlers don't keep it alive.
    private final class Relay: NSObject, WKScriptMessageHandler {
        weak var bridge: TerminalBridge?
        init(_ bridge: TerminalBridge) { self.bridge = bridge }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            MainActor.assumeIsolated { bridge?.userContentController(controller, didReceive: message) }
        }
    }
}

/// The terminal's web view, as SwiftUI shows it.
#if os(iOS)
struct TerminalScreen: UIViewRepresentable {
    let bridge: TerminalBridge
    func makeUIView(context: Context) -> WKWebView { bridge.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
struct TerminalScreen: NSViewRepresentable {
    let bridge: TerminalBridge
    func makeNSView(context: Context) -> WKWebView { bridge.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif

/// A terminal in an agent's VM, as this app holds it: opened (or the one already open taken up again), watched (and
/// watched again when that drops), typed into in order, and closed.
@MainActor @Observable final class AgentTerminal {
    let sandbox: String
    private(set) var status = "Opening…"
    private(set) var ended = false
    /// The latest web address it showed: a sign-in's page, to open on this phone.
    private(set) var link: URL?
    private var id: String?
    private var queue: TerminalInputQueue?
    /// What it showed lately, as text, for the addresses in it.
    private var lately = ""
    /// A folder to start in (a project's checkout): typed as a `cd` into a terminal this opened, never into one already
    /// open, where something may be running.
    let startIn: String?

    init(sandbox: String, startIn: String? = nil) {
        self.sandbox = sandbox
        self.startIn = startIn
    }

    func type(_ data: String) { if !ended { queue?.type(data) } }

    func close(with client: NodeClient) {
        guard let id, !ended else { return }
        struct Close: Encodable { let terminal: String }
        Task { _ = try? await client.post("/api/terminals/close", Close(terminal: id), as: JSONValue.self) }
    }

    func run(with client: NodeClient, on bridge: TerminalBridge) async {
        bridge.failed = { [weak self] why in self?.status = why }
        // The emulator fits itself first, so the shell starts at the size it is shown at.
        for _ in 0..<50 where bridge.size == nil { try? await Task.sleep(for: .milliseconds(100)) }
        let opened: TerminalRecord
        var fresh = false
        do {
            struct Listed: Decodable { let terminals: [TerminalRecord] }
            struct Open: Encodable { let sandbox: String; let size: TerminalSize }
            struct Opened: Decodable { let terminal: TerminalRecord }
            let open = try await client.get("/api/terminals", as: Listed.self).terminals.first { $0.sandbox == sandbox && $0.exitCode == nil }
            fresh = open == nil
            if let open { opened = open } else { opened = try await client.post("/api/terminals", Open(sandbox: sandbox, size: bridge.size ?? TerminalSize(cols: 80, rows: 24)), as: Opened.self).terminal }
        } catch {
            status = error.localizedDescription
            return
        }
        let id = opened.id
        self.id = id
        let queue = TerminalInputQueue(send: { input in
            struct Body: Encodable { let terminal: String; let data: String?; let size: TerminalSize? }
            _ = try await client.post("/api/terminals/input", Body(terminal: id, data: input.data, size: input.size), as: JSONValue.self)
        }, failed: { [weak self] error in if self?.ended == false { self?.status = error.localizedDescription } })
        self.queue = queue
        bridge.onKeys = { [weak self] data in self?.type(data) }
        bridge.onSize = { [weak self] size in if self?.ended == false { queue.resize(size) } }
        bridge.focus()

        var tries = 0
        while !ended, !Task.isCancelled {
            do {
                struct Watch: Encodable { let terminal: String }
                var first = true
                for try await event in client.payloads("/api/terminals/watch", Watch(terminal: id), as: TerminalEvent.init(json:)) {
                    // Taken up (again): what the node kept is drawn on a clean screen, and the shell is told its size.
                    if first {
                        first = false
                        tries = 0
                        bridge.reset()
                        lately = ""
                        if let size = bridge.size { queue.resize(size) }
                        status = ""
                        if fresh, let startIn {
                            fresh = false
                            queue.type("cd '\(startIn.replacingOccurrences(of: "'", with: "'\\''"))' && clear\r")
                        }
                    }
                    switch event {
                    case .output(let data):
                        bridge.write(data)
                        notice(data)
                    case .exit(let code):
                        ended = true
                        status = "Its shell ended (exit \(code)). Done closes this."
                    }
                }
            } catch let error as NodeError where error.status == 404 {
                ended = true
                status = "This terminal is gone: it was closed, or nobody watched it for 15 minutes."
                return
            } catch {
                if Task.isCancelled { return }
            }
            if ended { return }
            status = "Reconnecting…"
            try? await Task.sleep(for: .milliseconds(min(10_000, 500 * (1 << min(tries, 5)))))
            tries += 1
        }
    }

    private func notice(_ base64: String) {
        guard let bytes = Data(base64Encoded: base64) else { return }
        lately = String((lately + String(decoding: bytes, as: UTF8.self)).suffix(16_000))
        if let found = Terminals.links(in: lately).last { link = found }
    }
}
