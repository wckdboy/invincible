import SwiftUI

/*
 * Everything else, under "…" (the PWA's views/places.ts; your words, 26 November 2026: on a phone no tab bar, "a '…' sheet
 * for everything else"): a task to give and a new chat at its head, then every place beyond Home with a line saying what
 * is there, only what this device may see: its conversation, the agents (the agents and their rooms), the Inbox (with
 * its count), Keys, Connectors and Settings. What the tabs held is all here.
 */
struct EverythingSheet: View {
    let session: Session
    /// Gives a task to the agents (nil: this device may not).
    var give: (() -> Void)? = nil
    /// Goes to a place, the sheet put away first.
    let go: (Place) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            GroupedList {
                Section {
                    HStack(spacing: Space.s3) {
                        if let give {
                            NeedButton(title: "Give a task", prominent: true, action: give)
                        }
                        if session.can("chat") {
                            NeedButton(title: "New chat") {
                                if !session.chat.answering { session.chat.startNew() }
                                go(.primary)
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    place(.primary, Primary.name, "bubble.left.and.text.bubble.right", "Its conversations: what you asked it, and its answers.")
                    place(.agents, "Agents", "person.3", "Your agents, what each is doing, and their rooms.", trail: session.rows.isEmpty ? nil : "\(session.rows.count)")
                    place(.inbox, "Inbox", "tray", "Approvals, keys it asked for, devices asking to join, what was noticed.", trail: session.inboxCount > 0 ? "\(session.inboxCount)" : nil, needs: session.inboxCount > 0)
                }
                Section {
                    if session.can("vault:read") {
                        NavigationLink { KeysView(session: session) } label: {
                            Row(title: "Keys", symbol: "key", about: "Sealed for your full nodes; no model ever sees one.")
                        }
                    }
                    if session.can("mind:read") {
                        NavigationLink { ConnectorsView(session: session) } label: {
                            Row(title: "Connectors", symbol: "point.3.connected.trianglepath.dotted", about: "Your services: what's sent out or deleted asks you first.")
                        }
                    }
                    place(.more, "Settings", "gearshape", "This \(ThisDevice.kind.lowercased()), its notifications, its node and fleet.")
                }
            }
            .navigationTitle("Everything else")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func place(_ place: Place, _ title: String, _ symbol: String, _ about: String, trail: String? = nil, needs: Bool = false) -> some View {
        Button { go(place) } label: {
            HStack {
                Row(title: title, symbol: symbol, about: about)
                Spacer(minLength: Space.s2)
                if let trail {
                    Text(trail)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(needs ? Color.needs : .secondary)
                }
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(.rect)
        }
        .tint(.primary)
    }

    private struct Row: View {
        let title: String
        let symbol: String
        let about: String

        var body: some View {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                    Text(about).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } icon: {
                Image(systemName: symbol)
            }
            .padding(.vertical, Space.s1)
        }
    }
}
