#if os(macOS)
import SwiftUI

/// Settings (⌘,): This Mac (its node, when it is one; then this app's own device, forgotten from here), Keys and
/// Connectors, as a Mac's settings are. The three tabs are always there, each saying what it waits for when it can't show
/// itself yet: a settings window doesn't take tabs added to it once it has shown (measured: a tab view of three put in
/// place of one of one, after pairing, left the window with the first's single tab, drawn blank).
struct MacSettings: View {
    let mac: MacApp

    var body: some View {
        TabView {
            Tab("This Mac", systemImage: ThisMacFoot.symbol) {
                NavigationStack {
                    if let session = mac.session {
                        MoreView(app: mac.app, session: session, places: false) { ThisMacSections(mac: mac) }
                    } else {
                        GroupedList {
                            ThisMacSections(mac: mac)
                            Section {
                                Text("This app isn't in a fleet yet: join it in Invincible's window, and its settings are here.").foregroundStyle(.secondary)
                            }
                        }
                        .navigationTitle("This Mac")
                    }
                }
            }
            Tab("Keys", systemImage: "key") {
                if let session = mac.session, session.can("vault:read") {
                    NavigationStack { KeysView(session: session) }
                } else {
                    Waiting(session: mac.session, may: "see the vault's keys")
                }
            }
            Tab("Connectors", systemImage: "point.3.connected.trianglepath.dotted") {
                if let session = mac.session, session.can("mind:read") {
                    NavigationStack { ConnectorsView(session: session) }
                } else {
                    Waiting(session: mac.session, may: "see your connectors")
                }
            }
        }
        .frame(width: 680, height: 620)
        .tint(.ink)
        .formStyle(.grouped)
        // This Mac is read again every few seconds while Settings is open.
        .task {
            while !Task.isCancelled {
                await mac.thisMac.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}

/// A tab that can't show itself yet: this app isn't in a fleet, or this device may not do what the tab does.
private struct Waiting: View {
    let session: Session?
    let may: String

    var body: some View {
        if session == nil {
            ContentUnavailableView("Not in a fleet yet", systemImage: "person.2.slash", description: Text("Join your fleet in Invincible's window, or make this Mac a node: then its settings are here."))
        } else {
            ContentUnavailableView("Not on this device", systemImage: "lock", description: Text("This Mac was paired without leave to \(may)."))
        }
    }
}
#endif
