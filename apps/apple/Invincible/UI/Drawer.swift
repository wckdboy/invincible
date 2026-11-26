#if os(iOS)
import SwiftUI

/*
 * The drawer (X2's navigation, 26 November 2026: "Home, a bar and a drawer", no tab bar, Home the primary): everything
 * beyond Home, from the left edge (a swipe from it on Home, or a tap on the I-beam), so every place is two taps from
 * Home: a new chat and your latest chats with the primary, what needs you and the agents with their counts, all your
 * chats, keys, connectors and Settings. Notifications are asked for here, once and compactly, never as a banner on Home.
 */
struct Drawer: View {
    let session: Session
    /// Goes to a place, the drawer closed first.
    let go: (Place) -> Void
    /// One of the primary's chats (nil: a new one), the drawer closed first.
    let chat: (String?) -> Void
    let close: () -> Void
    @State private var chats: [ConversationSummary]?
    @State private var push = PushCenter.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s6) {
                head
                VStack(alignment: .leading, spacing: 0) {
                    if session.can("chat") {
                        row("New chat", symbol: "square.and.pencil", id: "drawer.new-chat") { chat(nil) }
                        ForEach((chats ?? []).prefix(5)) { one in
                            row(one.title.isEmpty ? "A chat" : one.title, symbol: "bubble.left", id: "drawer.chat.\(one.id)", quiet: true) { chat(one.id) }
                        }
                        if chats == nil {
                            Text("Your chats…").font(.subheadline).foregroundStyle(.tertiary).padding(.leading, Metrics.iconColumn + Space.s3).frame(minHeight: Metrics.touch)
                        }
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    row("Needs you", symbol: "tray", id: "drawer.needs", count: session.needsYou) { go(.inbox) }
                    row("Agents", symbol: "person.3", id: "drawer.agents", count: session.rows.count, quietCount: true) { go(.agents) }
                    if session.can("chat") { row("All chats", symbol: "bubble.left.and.bubble.right", id: "drawer.chats") { go(.chats) } }
                    if session.can("vault:read") { row("Keys", symbol: "key", id: "drawer.keys") { go(.keys) } }
                    if session.can("mind:read") { row("Connectors", symbol: "point.3.connected.trianglepath.dotted", id: "drawer.connectors") { go(.connectors) } }
                    row("Settings", symbol: "gearshape", id: "drawer.settings") { go(.more) }
                }
                if push.reach == .turnOn || push.reach == .settings {
                    Divider()
                    notifications
                }
            }
            .padding(.horizontal, Metrics.margin)
            .padding(.vertical, Space.s4)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(.background)
        .task { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("drawer")
    }

    private var head: some View {
        HStack(spacing: Space.s3) {
            AppMark(size: 36)
            VStack(alignment: .leading, spacing: Space.line) {
                Text(Primary.name).font(.title3.weight(.bold))
                Text(session.whoami?.nodeName ?? session.node.nodeName ?? "Your node").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: close) {
                Image(systemName: "xmark").font(.footnote.weight(.semibold)).frame(width: 30, height: 30)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel("Close")
        }
    }

    /// Notifications, asked for once and compactly: off, or turned off in the iPhone's Settings.
    private var notifications: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "bell.slash").foregroundStyle(.secondary).frame(width: Metrics.iconColumn)
            Text(push.reach == .settings ? "Notifications are off in the iPhone's Settings" : "Notifications are off").font(.subheadline).foregroundStyle(.secondary)
            Spacer(minLength: Space.s2)
            Button(push.reach == .settings ? "Open" : "Turn on") {
                if push.reach == .settings {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } else {
                    Task { try? await PushCenter.shared.turnOn(session) }
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.borderless)
            .frame(minHeight: Metrics.touch)
        }
    }

    private func row(_ title: String, symbol: String, id: String, count: Int? = nil, quietCount: Bool = false, quiet: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.s3) {
                Image(systemName: symbol).font(.body).foregroundStyle(quiet ? .tertiary : .secondary).frame(width: Metrics.iconColumn)
                Text(title).font(quiet ? .subheadline : .body.weight(.semibold)).foregroundStyle(quiet ? .secondary : .primary).lineLimit(1)
                Spacer(minLength: Space.s2)
                if let count, count > 0 {
                    Text("\(count)").font(.subheadline.weight(quietCount ? .regular : .bold)).monospacedDigit().foregroundStyle(quietCount ? .secondary : .primary)
                }
            }
            .frame(minHeight: Metrics.touch)
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .accessibilityIdentifier(id)
    }

    private func load() async {
        struct Listed: Decodable { let conversations: [ConversationSummary] }
        let listed = try? await session.client.get("/api/conversations", as: Listed.self).conversations
        chats = (listed ?? []).sorted { $0.updatedAt > $1.updatedAt }
    }
}

/// The drawer over what is under it, from the left edge: what is under it dimmed, a tap on that or a swipe back to the
/// left closes it.
struct DrawerHost<Content: View>: View {
    @Binding var open: Bool
    let session: Session
    let go: (Place) -> Void
    let chat: (String?) -> Void
    @ViewBuilder let content: Content
    @GestureState private var dragging: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .leading) {
            content
            if open {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { close() }
                    .accessibilityLabel("Close the drawer")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
                // (Its width from the window's own, without a reader round what is under it: Home lays out once.)
                Drawer(session: session, go: { place in close(); go(place) }, chat: { id in close(); chat(id) }, close: close)
                    .containerRelativeFrame(.horizontal) { width, _ in min(340, width * 0.86) }
                    .clipShape(.rect(bottomTrailingRadius: 24, topTrailingRadius: 24, style: .continuous))
                    .shadow(color: .black.opacity(0.18), radius: 24, x: 6)
                    .offset(x: min(0, dragging))
                    .gesture(DragGesture(minimumDistance: 12).updating($dragging) { value, state, _ in state = value.translation.width }.onEnded { value in
                        if value.translation.width < -110 { close() }
                    })
                    .transition(reduceMotion ? .opacity : .move(edge: .leading))
                    .ignoresSafeArea(edges: .bottom)
            }
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.9)) { open = false }
    }
}
#endif
