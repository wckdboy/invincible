import SwiftUI

/// Everything else (the roster's foot; the web's More index): the places the roster doesn't list, each with what is there
/// in a line, among those this device may see.
struct EverythingView: View {
    let session: Session
    let go: (Place) -> Void

    var body: some View {
        GroupedList {
            Section {
                ForEach(EverythingView.places(can: session.can), id: \.place) { one in
                    Button { go(one.place) } label: {
                        HStack(spacing: Space.s3) {
                            Image(systemName: one.symbol)
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .frame(width: Metrics.iconColumn)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(one.title).foregroundStyle(.primary)
                                Text(one.about).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: Space.s2)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: Metrics.touch)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("everything.\(one.id)")
                }
            }
        }
        .screen("everything.screen")
        .navigationTitle("Everything else")
    }

    /// A place it lists.
    struct Entry {
        let id: String
        let place: Place
        let title: String
        let symbol: String
        let about: String
    }

    /// What it lists for a device with these scopes: the agents' board, every chat, keys, connectors (the web's words).
    static func places(can: (String) -> Bool) -> [Entry] {
        [
            Entry(id: "agents", place: .agents, title: "Agents", symbol: "person.3", about: "The agents: who works on what, their rooms"),
            can("chat") ? Entry(id: "chats", place: .chats, title: "All chats", symbol: "bubble.left.and.bubble.right", about: "Every chat with your agent") : nil,
            can("vault:read") ? Entry(id: "keys", place: .keys, title: "Keys", symbol: "key", about: "Sealed keys; no model ever sees one") : nil,
            can("mind:read") ? Entry(id: "connectors", place: .connectors, title: "Connectors", symbol: "point.3.connected.trianglepath.dotted", about: "Services and MCP servers it may call") : nil,
        ].compactMap { $0 }
    }
}
