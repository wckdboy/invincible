import SwiftUI

/// A timeline's title in its bar (the primary's chat, an agent's, a room's): whose it is, and one line of where it stands
/// under it, in amber when it needs you. The line is always there, so the title doesn't move when it comes; the
/// bar gives the two the room between its buttons, and a long line ends in an ellipsis there.
struct TimelineTitle: View {
    let title: String
    let line: String?
    var needs = false
    /// Centred alone in the bar; leading beside a face (the primary's orb).
    var alignment: HorizontalAlignment = .center
    /// Where it stands, as a still dot before its line (nil, or at rest: no dot).
    var standing: Standing? = nil

    var body: some View {
        VStack(alignment: alignment, spacing: Space.line) {
            Text(title).font(.headline).foregroundStyle(.primary)
            HStack(spacing: 5) {
                if let standing, standing.shown != nil {
                    Circle().fill(Self.ink(StateLabel.tone(standing.tone))).frame(width: 6, height: 6).accessibilityHidden(true)
                }
                Text(line ?? " ")
                    .font(.caption)
                    .foregroundStyle(needs ? Color.needs : .secondary)
                    .lineLimit(1)
            }
        }
    }

    private static func ink(_ tone: StateLabel.Tone) -> Color {
        switch tone {
        case .active: .primary
        case .quiet: .secondary
        case .failed: .danger
        }
    }
}

/// What a timeline with nothing in it yet says: whose it is, its face, and what to do here.
struct TimelineWelcome<Face: View>: View {
    let title: String
    let words: String
    @ViewBuilder let face: Face

    var body: some View {
        VStack(spacing: Space.s3) {
            face
            Text(title).font(.title2.bold())
            Text(words)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Space.s10)
        .padding(.horizontal, Space.s6)
    }
}

/// Who is writing a reply now, under the speakers' faces' column, where the reply will be.
struct WritingLine: View {
    let words: String

    var body: some View {
        HStack(spacing: Space.s2) {
            LiveDot(color: .secondary)
            Text(words)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, Metrics.speakerFace + Space.s2)
    }
}

extension View {
    /// A conversation's scrolling: it opens at the latest, and once you've scrolled well back from it, a button takes you
    /// down to it again.
    func keepingLatest() -> some View { modifier(KeepingLatest()) }
}

private struct KeepingLatest: ViewModifier {
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var away = false

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY > 320
            } action: { _, now in
                away = now
            }
            // What is under the conversation grew (what is under way came above the message box, or the box grew a
            // line): at the latest, the latest stays in sight above it rather than slipping under it.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentInsets.bottom
            } action: { before, now in
                if now > before && !away { position.scrollTo(edge: .bottom) }
            }
            // Just above the message box (an inset of no height, so the conversation never moves for it).
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: 0)
                    .overlay(alignment: .bottomTrailing) {
                        if away {
                            Button {
                                withAnimation(.snappy) { position.scrollTo(edge: .bottom) }
                            } label: {
                                Image(systemName: "arrow.down").font(.body.weight(.semibold)).frame(width: 36, height: 36)
                            }
                            .buttonStyle(.glass)
                            .buttonBorderShape(.circle)
                            .padding(.trailing, Metrics.margin)
                            .padding(.bottom, Space.s2)
                            .accessibilityLabel("Go to the latest")
                            .accessibilityIdentifier("latest")
                        }
                    }
            }
    }
}

/// The agents an @ being typed may name, above a room's message box: one tap writes its handle.
struct MentionChoices: View {
    @Binding var draft: String
    let seats: [Mentions.Seat]

    var body: some View {
        if let typed = Mentions.typing(draft) {
            let shown = Mentions.matches(typed, in: seats)
            if !shown.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.s2) {
                        ForEach(shown, id: \.id) { seat in
                            Button {
                                draft = Mentions.complete(draft, with: seat)
                            } label: {
                                HStack(spacing: Space.s1) {
                                    Text(seat.name).font(.callout.weight(.semibold))
                                    Text("@\(seat.id)").font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, Space.s3)
                                .padding(.vertical, Space.s2)
                            }
                            .buttonStyle(.glass)
                            .accessibilityLabel("Name \(seat.name)")
                        }
                    }
                }
                .accessibilityLabel("Agents to name")
            }
        }
    }
}
