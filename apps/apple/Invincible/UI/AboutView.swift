import SwiftUI

/// About Invincible (the PWA's Settings → About, and its "Kept on this device"): the I-beam, the app's name and version,
/// the node that serves it; and what this device keeps of it, each in a line, so nothing it holds is a surprise.
struct AboutView: View {
    let session: Session

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Space.s2) {
                    AppMark(size: 56).padding(.bottom, Space.s2)
                    Text("Invincible").font(Typeset.title)
                    Text("Version \(MoreView<EmptyView>.version) · served by \(session.whoami?.nodeName ?? session.node.nodeName ?? "your node") · one mind, many bodies")
                        .font(Typeset.detail)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, Space.s4)
                .accessibilityElement(children: .combine)
                .listRowSeparator(.hidden)
            }
            Section {
                kept("key", "A device key", session.key.storage == .secureEnclave
                    ? "Made in the Secure Enclave: it can sign, but nothing can read it out, not even this app."
                    : "In the Keychain, for this device only: it signs every request.")
                kept("person.3", "The last of your agents it saw", "In the app's caches, to show at once when it opens: your agents, their tasks' titles, where each stands and what proves it, and your chats' titles; never a brief or an agent's instructions. Replaced by your node's answer.")
                if PhoneKeys.offered {
                    kept("lock", "Copies of keys you chose to keep", "In this \(ThisDevice.kind)'s Keychain, for this device alone, read back only with Face ID or your passcode.")
                }
                kept("bubble.left.and.bubble.right", "Chats: not on this \(ThisDevice.kind)", "Kept privately on your node, and deleted there when you delete them.")
            } header: {
                SectionHead("Kept on this \(ThisDevice.kind)")
            }
        }
        .hairlinePage()
        .screen("about.screen")
        .placeTitle("About")
    }

    private func kept(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: Metrics.iconColumn).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.line) {
                Text(title).font(Typeset.row)
                Text(detail).font(Typeset.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Space.s1)
        .accessibilityElement(children: .combine)
    }
}
