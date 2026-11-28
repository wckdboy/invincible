#if os(iOS)
import SwiftUI

/*
 * Settings on an iPhone and an iPad, from Home's gear (the owner's word of 28 November 2026: "a settings menu for adding
 * connectors, keys, providers, permissions etc."): one list of eight, each a page of its own. What the agents work with
 * (connectors, keys, providers, permissions), then this app (notifications, appearance, this device, about). Providers and
 * Permissions are read-only in this build (the lead's ruling: adding and editing come next). A Mac keeps its own (MoreView).
 */
struct SettingsList: View {
    let app: AppModel
    let session: Session

    var body: some View {
        List {
            Section {
                if session.can("mind:read") {
                    NavigationLink { ConnectorsView(session: session) } label: { Label("Connectors", systemImage: "point.3.connected.trianglepath.dotted") }
                        .accessibilityIdentifier("settings.connectors")
                }
                if session.can("vault:read") {
                    NavigationLink { KeysView(session: session) } label: { Label("Keys", systemImage: "key") }
                        .accessibilityIdentifier("settings.keys")
                }
                if session.can("mind:read") {
                    NavigationLink { ProvidersPage(session: session) } label: { Label("Providers", systemImage: "cpu") }
                        .accessibilityIdentifier("settings.providers")
                    NavigationLink { PermissionsPage(session: session) } label: { Label("Permissions", systemImage: "checkmark.shield") }
                        .accessibilityIdentifier("settings.permissions")
                }
            }
            Section {
                if session.can("mind:read") {
                    NavigationLink { NotificationsPage(session: session) } label: { Label("Notifications", systemImage: "bell") }
                        .accessibilityIdentifier("settings.notifications")
                }
                NavigationLink { AppearancePage() } label: { Label("Appearance", systemImage: "circle.lefthalf.filled") }
                    .accessibilityIdentifier("settings.appearance")
                NavigationLink { ThisDevicePage(app: app, session: session) } label: { Label("This device", systemImage: ThisDevice.kind == "iPad" ? "ipad" : "iphone") }
                    .accessibilityIdentifier("settings.device")
                NavigationLink { AboutView(session: session) } label: {
                    LabeledContent { Text(MoreView<EmptyView>.version) } label: { Label("About", systemImage: "info.circle") }
                }
                .accessibilityIdentifier("settings.about")
            }
        }
        .screen("settings.screen")
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Notifications on this device: on or off, and a test.
private struct NotificationsPage: View {
    let session: Session

    var body: some View {
        List { NotificationsSection(session: session) }
            .screen("settings.notifications.screen")
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// How this app looks on this device: light, dark or as the system is, and your agent's mark.
private struct AppearancePage: View {
    @AppStorage(Appearance.themeKey) private var theme = Appearance.system
    /// How your agent's mark is drawn on this device (GuardianMark): ink, until the owner chooses, or pearl glass.
    @AppStorage("invincible.guardian-mark") private var guardian = "mono"

    var body: some View {
        List {
            Picker("Theme", selection: $theme) {
                Text("System").tag(Appearance.system)
                Text("Light").tag(Appearance.light)
                Text("Dark").tag(Appearance.dark)
            }
            .accessibilityIdentifier("settings.theme")
            Picker("Your agent's mark", selection: $guardian) {
                Text("Ink").tag("mono")
                Text("Pearl glass").tag("pearl")
            }
            .accessibilityIdentifier("settings.guardian-mark")
        }
        .screen("settings.appearance.screen")
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The app's light or dark, as chosen on this device (Settings → Appearance), for the window's root.
enum Appearance {
    static let themeKey = "invincible.theme"
    static let system = "system"
    static let light = "light"
    static let dark = "dark"

    static func scheme(_ theme: String) -> ColorScheme? {
        switch theme {
        case light: .light
        case dark: .dark
        default: nil
        }
    }
}

/// This device as the node knows it: its name, its key, what it may do, the node it talks to; and forgetting it.
private struct ThisDevicePage: View {
    let app: AppModel
    let session: Session
    @State private var forgetting = false
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                LabeledContent("Name", value: session.node.name)
                LabeledContent("Device") { Text(String(session.key.device.dropFirst(2).prefix(8))).font(.body.monospaced()) }
                LabeledContent("Key", value: session.key.storage == .secureEnclave ? "In the Secure Enclave" : "In the Keychain")
                if let scopes = session.whoami?.scopes {
                    LabeledContent("May") { Text(scopes.joined(separator: ", ")).font(.footnote.monospaced()).multilineTextAlignment(.trailing) }
                }
                LabeledContent("Node", value: session.whoami?.nodeName ?? session.node.nodeName ?? "—")
            }
            Section {
                // In the ink: red is for what went wrong. What can't be undone is asked again, in the system's red there.
                Button("Forget this device…") { forgetting = true }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("settings.forget")
            }
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
        }
        .screen("settings.device.screen")
        .navigationTitle("This device")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Forget this device?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Forget this device", role: .destructive) {
                do {
                    try app.forget()
                } catch {
                    problem = error.localizedDescription
                }
            }
        } message: {
            Text("Its key is deleted and can't be brought back: pairing again makes a new device.")
        }
    }
}

/// The models your agents use: the providers with their keys, your coding plans, your seats, and what they cost lately.
/// Read-only in this build.
private struct ProvidersPage: View {
    let session: Session
    @State private var providers: ProvidersView?
    @State private var seats: [SeatView]?
    @State private var problem: String?

    private struct Seats: Decodable { let seats: [SeatView] }

    var body: some View {
        List {
            if session.usage != nil {
                Section { UsageMeterView(session: session) }
            }
            Section {
                if let providers {
                    if providers.providers.isEmpty {
                        Text("None yet: a key you add in Keys sets up its provider.").foregroundStyle(.secondary)
                    }
                    ForEach(providers.providers) { provider in
                        let plan = providers.presets.first { $0.id == provider.id }?.plan
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.label ?? provider.id).font(.body)
                            Text([plan.map { "Coding plan: \($0.name)" } ?? provider.kind, provider.hasKey ? "key sealed" : "no key"].joined(separator: " · "))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } else if problem == nil {
                    ProgressView()
                }
            } header: {
                SectionHead("Providers")
            }
            if let seats, !seats.isEmpty {
                Section {
                    ForEach(seats) { seat in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(seat.label).font(.body)
                            Text("\(seat.kindWords) · \(seat.stateWords)").font(.footnote).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    SectionHead("Seats")
                }
            }
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
        }
        .screen("settings.providers.screen")
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
        .task { await read() }
        .refreshable { await read() }
    }

    private func read() async {
        do {
            providers = try await session.client.get("/api/providers", as: ProvidersView.self)
            problem = nil
        } catch {
            problem = "Your providers couldn't be read: \(error.localizedDescription)"
        }
        seats = try? await session.client.get("/api/seats", as: Seats.self).seats
    }
}

/// What the agents may do without asking you: what always asks, your rules on the commands their work runs, and the
/// hand-offs one node may make to another's agents. Read-only in this build.
private struct PermissionsPage: View {
    let session: Session
    @State private var rules: [RuleView]?
    @State private var grants: [HandoffGrantView]?
    @State private var problem: String?

    private struct Rules: Decodable { let rules: [RuleView] }
    private struct Grants: Decodable { let grants: [HandoffGrantView] }

    var body: some View {
        List {
            Section {
                Label("Money, legal steps and anything that can't be undone always ask you first.", systemImage: "hand.raised")
                    .font(.subheadline)
            }
            Section {
                if let rules {
                    if rules.isEmpty {
                        Text("None yet. A rule can halt the work, or refuse a command, whose words match a glob of yours.").foregroundStyle(.secondary)
                    }
                    ForEach(rules) { rule in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rule.name).font(.body.monospaced())
                            Text(rule.rule.map(Permissions.sentence) ?? "A newer node's rule: not applied here.").font(.footnote).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } else if problem == nil {
                    ProgressView()
                }
            } header: {
                SectionHead("Rules")
            }
            if let grants, !grants.isEmpty {
                Section {
                    ForEach(grants) { grant in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(grant.from.name) → \(grant.to.name)").font(.body)
                            Text(Permissions.terms(grant)).font(.footnote).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    SectionHead("Hand-offs without asking")
                }
            }
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
        }
        .screen("settings.permissions.screen")
        .navigationTitle("Permissions")
        .navigationBarTitleDisplayMode(.inline)
        .task { await read() }
        .refreshable { await read() }
    }

    private func read() async {
        do {
            rules = try await session.client.get("/api/rules", as: Rules.self).rules
            problem = nil
        } catch {
            problem = "Your rules couldn't be read: \(error.localizedDescription)"
        }
        // (Yours alone to read: a device without fleet:admin shows none.)
        if session.can("fleet:admin") { grants = try? await session.client.get("/api/fabric/grants", as: Grants.self).grants }
    }
}
#endif
