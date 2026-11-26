import SwiftUI

/// This device and its node: what it is called, where its key is kept, what it may do; and forgetting it.
struct MoreView<Leading: View>: View {
    let app: AppModel
    let session: Session
    /// Keys and Connectors as places of their own, opened from here (not in a Mac's Settings, where they are tabs).
    var places = true
    /// What comes before this device's own rows: on a Mac that is a node, the node.
    let leading: Leading
    @State private var forgetting = false
    @State private var problem: String?

    init(app: AppModel, session: Session, places: Bool = true, @ViewBuilder leading: () -> Leading) {
        (self.app, self.session, self.places, self.leading) = (app, session, places, leading())
    }

    var body: some View {
        GroupedList {
            leading
            Section("This device") {
                LabeledContent("Name", value: session.node.name)
                LabeledContent("Device") { Text(String(session.key.device.dropFirst(2).prefix(8))).font(.body.monospaced()) }
                LabeledContent("Key", value: session.key.storage == .secureEnclave ? "In the Secure Enclave" : "In the Keychain")
                if let scopes = session.whoami?.scopes {
                    LabeledContent("May") { Text(scopes.joined(separator: ", ")).font(.footnote.monospaced()).multilineTextAlignment(.trailing) }
                }
            }
            #if os(iOS)
            if session.can("mind:read") {
                NotificationsSection(session: session)
            }
            #endif
            if places, session.can("vault:read") {
                Section {
                    NavigationLink { KeysView(session: session) } label: {
                        Label("Keys", systemImage: "key")
                    }
                } footer: {
                    Text("Sealed for your full nodes, each pinned to the one address it may go to; no model ever sees one.")
                }
            }
            if places, session.can("mind:read") {
                Section {
                    NavigationLink { ConnectorsView(session: session) } label: {
                        Label("Connectors", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                } footer: {
                    Text("Your services: what's sent out or deleted asks you first.")
                }
            }
            Section("Its node") {
                LabeledContent("Node", value: session.whoami?.nodeName ?? session.node.nodeName ?? "—")
                LabeledContent("Fleet", value: session.whoami?.fleetName ?? session.node.fleetName ?? "—")
                LabeledContent("Address") { Text(session.node.origin.absoluteString).font(.footnote.monospaced()) }
            }
            Section {
                Button("Forget this device", role: .destructive) { forgetting = true }
            } footer: {
                Text("Deletes this device's key, which can't be recovered: pairing again makes a new device. Revoke the old one on your node too.")
            }
            if let problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger) }
            }
            Section {
                // The app's mark on nothing (AppMark: no tile on a light page), as the PWA's About row has it.
                HStack(spacing: Space.s3) {
                    AppMark(size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Invincible").font(.body.weight(.semibold))
                        Text("Version \(Self.version)").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .screen("settings.screen")
        .navigationTitle(places ? "More" : "This \(ThisDevice.kind)")
        .confirmationDialog("Forget this device?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Forget this device", role: .destructive) {
                do {
                    try app.forget()
                } catch {
                    problem = error.localizedDescription
                }
            }
        } message: {
            Text("Its key is deleted and can't be brought back.")
        }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }
}

extension MoreView where Leading == EmptyView {
    init(app: AppModel, session: Session, places: Bool = true) {
        self.init(app: app, session: session, places: places) { EmptyView() }
    }
}
