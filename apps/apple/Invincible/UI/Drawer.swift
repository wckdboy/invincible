#if os(iOS)
import SwiftUI

/*
 * The drawer (the owner's word of 27 November 2026: "openmausbot/grokbot on mobile"; the web's phone): the roster from the
 * left edge, under the app's mark and the node it talks to. Notifications are asked for at its foot, once and compactly.
 */
struct Drawer: View {
    let session: Session
    /// The place on screen: its row is marked.
    let current: Place?
    /// Goes to a place, the drawer closed first.
    let go: (Place) -> Void
    let close: () -> Void
    @State private var push = PushCenter.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
                .padding(.horizontal, Metrics.margin)
                .padding(.top, Space.s4)
                .padding(.bottom, Space.s2)
            RosterList(session: session, current: current, go: go) {
                if push.reach == .turnOn || push.reach == .settings {
                    notifications.listRowBackground(Color.clear).selectionDisabled()
                }
            }
            .scrollContentBackground(.hidden)
        }
        .background(.background)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("drawer")
    }

    private var head: some View {
        HStack(spacing: Space.s3) {
            AppMark(size: 32)
            VStack(alignment: .leading, spacing: Space.line) {
                // (A name, never broken across lines: smaller instead, at the largest sizes.)
                Text(verbatim: "Invincible").font(Typeset.title).lineLimit(1).minimumScaleFactor(0.6)
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
            DrawerGlyph(symbol: "bell.slash", quiet: false)
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
}

/// The chat's back arrow where the roster is a drawer: it opens the roster, and counts what needs you beside it, as
/// Messages' back arrow counts what is unread.
struct RosterButton: View {
    let needs: Int
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.s1) {
                Image(systemName: "chevron.left").font(.body.weight(.semibold))
                if needs > 0 {
                    Text("\(needs)")
                        .font(.footnote.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(Color.onAccent)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Color.ink, in: .capsule)
                }
            }
            .frame(minHeight: 30)
        }
        .accessibilityLabel("Your agents")
        .accessibilityValue(needs > 0 ? PrimaryNow.needsYou(needs) : "Nothing needs you")
        .accessibilityIdentifier("roster.open")
    }
}

/// A place's glyph in the drawer's column: every one fitted to the same box (the people of the agents are wider than a
/// key or a gear, and stood out of the column, I9's screenshots), so their middles and edges line up, growing with the
/// text.
private struct DrawerGlyph: View {
    let symbol: String
    let quiet: Bool
    @ScaledMetric(relativeTo: .body) private var box: CGFloat = 22

    var body: some View {
        Image(systemName: symbol)
            .resizable()
            .scaledToFit()
            .fontWeight(.regular)
            .foregroundStyle(quiet ? .tertiary : .secondary)
            .frame(width: box, height: box)
            .frame(width: max(Metrics.iconColumn, box + 6))
            .accessibilityHidden(true)
    }
}

/// The drawer over what is under it, from the left edge: what is under it dimmed, a tap on that or a swipe back to the
/// left closes it.
struct DrawerHost<Content: View>: View {
    @Binding var open: Bool
    let session: Session
    /// The place on screen under it: its row is marked.
    let current: Place?
    let go: (Place) -> Void
    @ViewBuilder let content: Content
    @GestureState private var dragging: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

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
                // (Its width from the window's own, without a reader round what is under it: the chat lays out once. At
                // the accessibility sizes nearly all of it, where 340 points cut every name to a word.)
                let large = typeSize.isAccessibilitySize
                Drawer(session: session, current: current, go: { place in close(); go(place) }, close: close)
                    .containerRelativeFrame(.horizontal) { width, _ in large ? width * 0.94 : min(340, width * 0.86) }
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
