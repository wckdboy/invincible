import SwiftUI

/**
 * Your connectors (the PWA's Connectors): the services the primary reaches for you, each with where its key or its sign-in
 * stands; and those in the node's catalog to add, the hosted MCP servers it ships among them (core mcp-library.ts).
 * One opens to what it can do, who may use it, its key or its sign-in (Google's, Microsoft's or the MCP server's own
 * page, which comes back to your node), and to remove it.
 */
struct ConnectorsView: View {
    let session: Session
    @State private var connectors: [ConnectorView]?
    @State private var problem: String?

    private var installed: [ConnectorView] { (connectors ?? []).filter(\.installed) }
    private var catalog: [ConnectorView] { (connectors ?? []).filter { !$0.installed } }

    var body: some View {
        GroupedList {
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
            if !installed.isEmpty {
                Section("Connected") {
                    ForEach(installed) { connector in
                        NavigationLink { ConnectorDetail(session: session, id: connector.id) { await load() } } label: { ConnectorRow(connector: connector) }
                    }
                }
            }
            if !catalog.isEmpty {
                Section {
                    ForEach(catalog) { connector in
                        NavigationLink { ConnectorDetail(session: session, id: connector.id) { await load() } } label: { ConnectorRow(connector: connector) }
                    }
                } header: {
                    Text("Add")
                } footer: {
                    Text("Each reaches its service as you allow: reading, making and changing run freely, and anything sent out or deleted asks you first.")
                }
            }
        }
        .navigationTitle("Connectors")
        .overlay { if connectors == nil, problem == nil { ProgressView() } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        struct Listed: Decodable { let connectors: [ConnectorView] }
        do {
            connectors = try await session.client.get("/api/connectors", as: Listed.self).connectors.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
            problem = nil
        } catch {
            problem = "The connectors couldn't be read: \(error.localizedDescription)"
        }
    }
}

/// A connector in a line: its name, what it is for, and where its key or sign-in stands.
private struct ConnectorRow: View {
    let connector: ConnectorView

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: Space.line) {
                Text(connector.label).font(.headline)
                if let description = connector.description { Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer(minLength: Space.s2)
            if connector.installed, let state = Connectors.state(key: connector.key, signIn: connector.oauth?.provider) {
                StateBadge(text: state.label, tone: state.tone)
            }
        }
        .padding(.vertical, Space.s1)
        .accessibilityElement(children: .combine)
    }
}

/// A word in a tone, as the PWA's badges are: a connector's key, a task's state. Its words are its baseline, so it sits on
/// the line of what it is beside.
struct StateBadge: View {
    let text: String
    let tone: String
    /// Work in hand: a live dot before the words, sending out a wave of its light (LiveDot).
    var busy = false
    /// On the row an iPad shows selected, in the list's tint: white, as the row's words are, whatever its tone.
    var selected = false

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.leading, busy ? Space.s4 : 0)
            .overlay(alignment: .leading) {
                if busy { LiveDot(color: color) }
            }
            .padding(.horizontal, Space.s2)
            .padding(.vertical, Space.s1)
            .background(color.opacity(selected ? 0.22 : 0.12), in: .capsule)
    }

    private var color: Color {
        if selected { return .white }
        return switch tone {
        case "ok": .done
        case "warn", "needs": .needs
        case "work": .working
        case "failed": .failed
        case "danger": .danger
        case "accent": .ink
        default: .secondary
        }
    }
}

/// One connector: what it can do and who may use it, its key or its sign-in, and adding or removing it.
struct ConnectorDetail: View {
    let session: Session
    let id: String
    let changed: () async -> Void
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var connector: ConnectorView?
    @State private var origin = ""
    @State private var key = ""
    @State private var client = ""
    @State private var clientSecret = ""
    @State private var working = false
    @State private var problem: String?
    /// A started sign-in: Microsoft's code to type at its page, or Google's page opened; the node says when it's done.
    @State private var started: Started?
    @State private var removing = false

    enum Started: Equatable { case page, code(String, URL) }

    private var google: Bool { connector?.oauth?.provider == "google" }
    /// A hosted MCP server's own sign-in: no app of yours, its page back to your node as Google's is.
    private var mcp: Bool { connector?.oauth?.provider == "mcp" }
    private var who: String { mcp ? connector?.label ?? "it" : google ? "Google" : "Microsoft" }

    var body: some View {
        Form {
            if let connector {
                Section {
                    if let description = connector.description { Text(description) }
                    if connector.installed, let state = Connectors.state(key: connector.key, signIn: connector.oauth?.provider) {
                        HStack {
                            StateBadge(text: state.label, tone: state.tone)
                            if let account = connector.oauth?.account { Text(account).font(.footnote).foregroundStyle(.secondary) }
                        }
                        if connector.oauth == nil, let explain = Connectors.keyState[connector.key]?.explain { Text(explain).font(.footnote).foregroundStyle(.secondary) }
                    }
                    if let problem = connector.problem { Label(problem, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Color.danger) }
                }
                if !connector.installed {
                    add(connector)
                } else if connector.oauth != nil {
                    signIn(connector)
                } else if ["missing", "optional-missing", "wrong-origin"].contains(connector.key), session.can("vault:write") {
                    sealKey(connector)
                }
                if connector.access != nil || connector.private {
                    Section("Who may use it") {
                        if let access = connector.access {
                            Label(access.allowed.isEmpty ? "\(Primary.name)'s alone" : "\(Primary.name)'s, and \(ListFormatter.localizedString(byJoining: access.allowed))'s", systemImage: "shield.lefthalf.filled")
                        }
                        if connector.private { Label("What it reads stays in the answer that read it.", systemImage: "eye.slash").font(.footnote) }
                    }
                }
                if !connector.tools.isEmpty {
                    Section("What it can do") {
                        ForEach(connector.tools) { tool in
                            VStack(alignment: .leading, spacing: Space.line) {
                                HStack {
                                    Text(tool.name).font(.callout.monospaced())
                                    Spacer()
                                    Text(Connectors.classLine(tool)).font(.caption).foregroundStyle(tool.asks ? Color.orange : .secondary)
                                }
                                if !tool.description.isEmpty { Text(tool.description).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                            }
                        }
                    }
                }
                if connector.installed, session.can("brain:write") {
                    Section { Button("Remove \(connector.label)", role: .destructive) { removing = true } }
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(connector?.label ?? "Connector")
        .inlineTitle()
        .confirmationDialog("Remove \(connector?.label ?? "it")?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await remove() } }
        } message: {
            Text("\(Primary.name) can't reach it until you add it again. Its key or sign-in stays in the vault.")
        }
        .task { await load() }
        // While a sign-in is open, the node is asked again until it says you're in.
        .task(id: started) {
            guard started != nil else { return }
            for _ in 0..<200 where !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await load()
                guard connector?.key == "ready" else { continue }
                // An MCP server's tools are listed just after you sign in: a few seconds' grace for them.
                for _ in 0..<6 where mcp && connector?.tools.isEmpty == true && !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    await load()
                }
                started = nil
                await changed()
                return
            }
        }
    }

    @ViewBuilder private func add(_ connector: ConnectorView) -> some View {
        Section {
            if connector.needsOrigin {
                // A plain string: as a localized key, its address would be made a link drawn in the tint.
                FormField("Its address, e.g. http://homeassistant.local:8123" as String, text: $origin)
                    .keyboard(.url)
                    .capitals(.never)
                    .autocorrectionDisabled()
            }
            Button("Add \(connector.label)") { Task { await install() } }
                .disabled(working || !session.can("brain:write") || (connector.needsOrigin && origin.trimmingCharacters(in: .whitespaces).isEmpty))
        } footer: {
            if let help = connector.keyHelp {
                Text(help)
            } else if connector.kind == "mcp", let url = connector.url {
                // A plain string: as a localized key, its address would be made a link drawn in the tint.
                Text(verbatim: "Its own server, \(url.replacingOccurrences(of: "https://", with: "")), and only that. " + (connector.oauth != nil ? "You sign in as yourself next: no key and no app of yours." : "It needs no sign-in."))
            }
        }
    }

    @ViewBuilder private func signIn(_ connector: ConnectorView) -> some View {
        if mcp, connector.key != "ready" {
            // No app of yours: the primary registers itself with the server when you sign in.
            Section {
                signInButton("Sign in to \(who)")
            } footer: {
                Text("As yourself, through \(who)'s own page: no key and no app of yours. The node keeps the sign-in, sealed, and lists its tools then; nothing of it comes back to this device.")
            }
        } else if connector.key == "missing" || connector.key == "wrong-origin" {
            Section {
                FormField(google ? "1234-abc.apps.googleusercontent.com" : "00000000-0000-0000-0000-000000000000", text: $client)
                    .font(.body.monospaced())
                    .capitals(.never)
                    .autocorrectionDisabled()
                if google {
                    FormField("Its client secret", text: $clientSecret, secure: true).capitals(.never).autocorrectionDisabled()
                }
                Button("Seal the app") { Task { await sealApp() } }
                    .disabled(working || client.isEmpty || (google && clientSecret.isEmpty) || !session.can("vault:write"))
            } header: {
                Text("The app you registered with \(who)")
            } footer: {
                Text(google
                    ? "Its redirect URI is \(Connectors.callback(origin: session.node.origin)). The secret is sealed in the vault and never shown again."
                    : "An app for any organization's and personal accounts, with public client flows on. Its id is sealed in the vault.")
            }
        } else if connector.key == "ready" {
            Section {
                Button("Sign out", role: .destructive) { Task { await signOut() } }.disabled(working || !session.can("brain:write"))
            } footer: {
                Text(mcp ? "Sign in again any time." : "The app you registered stays: sign in again any time.")
            }
        } else {
            Section {
                signInButton("Sign in with \(who)")
            } footer: {
                Text("As yourself, through \(who)'s own page: the node keeps the sign-in, sealed, and nothing of it comes back to this device.")
            }
        }
    }

    /// Sign in, and what to do while it's open: finish at the page, or type the code at Microsoft's.
    @ViewBuilder private func signInButton(_ title: String) -> some View {
        Button(title) { Task { await startSignIn() } }
            .buttonStyle(.borderedProminent)
            .tint(.ink)
            .disabled(working || !session.can("brain:write"))
        switch started {
        case .page:
            Text("Finish in the page that opened: choose your account and allow it. This page says when you're signed in.").font(.footnote)
        case .code(let code, let url):
            VStack(alignment: .leading, spacing: Space.s2) {
                Text("Open \(url.host() ?? url.absoluteString), sign in, and type this code:").font(.footnote)
                HStack {
                    Text(code).font(.title2.monospaced().weight(.semibold)).textSelection(.enabled)
                    Spacer()
                    Button("Copy") { Pasteboard.copy(code) }.buttonStyle(.bordered).controlSize(.small)
                    Button("Open") { openURL(url) }.buttonStyle(.bordered).controlSize(.small)
                }
            }
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder private func sealKey(_ connector: ConnectorView) -> some View {
        Section {
            FormField("Paste its key", text: $key, secure: true).capitals(.never).autocorrectionDisabled()
            Button("Seal it") { Task { await seal() } }.disabled(working || key.isEmpty || connector.secret == nil)
        } header: {
            Text("Its key")
        } footer: {
            Text(connector.keyHelp ?? "Sealed for your full nodes, pinned to \(connector.label)'s own address, never shown again.")
        }
    }

    private func load() async {
        struct Listed: Decodable { let connectors: [ConnectorView] }
        do {
            connector = try await session.client.get("/api/connectors", as: Listed.self).connectors.first { $0.id == id }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// One request, its failure said, then the connector as the node has it now.
    private func run(_ request: () async throws -> Void) async {
        working = true
        defer { working = false }
        do {
            try await request()
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
        await load()
        await changed()
    }

    private func install() async {
        struct Add: Encodable { let id: String; let origin: String? }
        let address = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        await run { _ = try await session.client.post("/api/connectors", Add(id: id, origin: address.isEmpty ? nil : address), as: JSONValue.self) }
    }

    private func remove() async {
        struct Remove: Encodable { let id: String }
        await run { _ = try await session.client.post("/api/connectors/remove", Remove(id: id), as: JSONValue.self) }
        dismiss()
    }

    private func seal() async {
        guard let secret = connector?.secret else { return }
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        // Cleared before anything is sent: never shown back.
        key = ""
        struct Secret: Encodable { let name: String; let value: String; let provider: String }
        await run { _ = try await session.client.post("/api/secrets", Secret(name: secret, value: value, provider: id), as: JSONValue.self) }
    }

    private func sealApp() async {
        struct App: Encodable { let connector: String; let client: String; let secret: String? }
        let app = App(connector: id, client: client.trimmingCharacters(in: .whitespacesAndNewlines), secret: google ? clientSecret.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
        clientSecret = ""
        await run { _ = try await session.client.post("/api/oauth/app", app, as: JSONValue.self) }
    }

    private func startSignIn() async {
        struct Start: Encodable { let connector: String; let redirect: String? }
        struct Started: Decodable { let flow: String; let url: String; let code: String? }
        working = true
        defer { working = false }
        do {
            let answer = try await session.client.post("/api/oauth/start", Start(connector: id, redirect: google || mcp ? Connectors.callback(origin: session.node.origin) : nil), as: Started.self)
            guard let url = URL(string: answer.url), ["https", "http"].contains(url.scheme ?? "") else { problem = "The node gave no page to sign in at."; return }
            if answer.flow == "device", let code = answer.code {
                started = .code(code, url)
            } else {
                // Google's (or the MCP server's) own page, in Safari: it comes back to your node, which says when you're in.
                started = .page
                openURL(url)
            }
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    private func signOut() async {
        struct Out: Encodable { let connector: String }
        await run { _ = try await session.client.post("/api/oauth/signout", Out(connector: id), as: JSONValue.self) }
    }
}
