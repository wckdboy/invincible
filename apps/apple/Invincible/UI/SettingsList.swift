#if os(iOS)
import SwiftUI

/*
 * Settings on an iPhone and an iPad (the owner's word of 28 November 2026: as simple as Grok's and T3 Code's), from the
 * drawer's foot: a short list. Notifications; your agent's mark; keys and connectors; its computer, while it has one;
 * the node it talks to; About; and forgetting this device. Nothing else (a Mac keeps its own Settings, MoreView).
 */
struct SettingsList: View {
    let app: AppModel
    let session: Session
    @AppStorage("invincible.guardian-mark") private var guardian = "mono"
    @State private var forgetting = false
    @State private var problem: String?
    /// Its own computer, watched from here: its screen, its terminal, its files.
    @State private var watching = false
    @State private var inTerminal = false
    @State private var inFiles = false

    var body: some View {
        List {
            if session.can("mind:read") {
                NotificationsSection(session: session)
            }
            Section {
                Picker("Your agent's mark", selection: $guardian) {
                    Text("Ink").tag("mono")
                    Text("Pearl glass").tag("pearl")
                }
                .accessibilityIdentifier("settings.guardian-mark")
                if session.can("vault:read") {
                    NavigationLink { KeysView(session: session) } label: { Label("Keys", systemImage: "key") }
                        .accessibilityIdentifier("settings.keys")
                }
                if session.can("mind:read") {
                    NavigationLink { ConnectorsView(session: session) } label: { Label("Connectors", systemImage: "point.3.connected.trianglepath.dotted") }
                        .accessibilityIdentifier("settings.connectors")
                }
            }
            // Your agent's own computer, once it has one (made from the web app or a terminal, as an agent's VM is).
            if session.team?.computer != nil && session.can("sandbox") {
                Section {
                    Button { watching = true } label: { Label("Its screen", systemImage: "display") }
                    Button { inTerminal = true } label: { Label("Its terminal", systemImage: "apple.terminal") }
                    Button { inFiles = true } label: { Label("Its files", systemImage: "folder") }
                }
                .tint(.primary)
            }
            Section {
                LabeledContent("Node", value: session.whoami?.nodeName ?? session.node.nodeName ?? "—")
                NavigationLink { AboutView(session: session) } label: {
                    LabeledContent("About Invincible", value: MoreView<EmptyView>.version)
                }
                .accessibilityIdentifier("settings.about")
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
        .screen("settings.screen")
        .navigationTitle("Settings")
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
        .navigationDestination(isPresented: $watching) {
            if let computer = session.team?.computer { AgentScreenView(session: session, agent: VMSeat(computer: computer)) }
        }
        .cover(isPresented: $inTerminal) {
            if let computer = session.team?.computer { AgentTerminalView(session: session, agent: VMSeat(computer: computer)) }
        }
        .sheet(isPresented: $inFiles) { WorkspaceView(session: session, id: "primary", name: Primary.name) }
    }
}
#endif
