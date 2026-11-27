import SwiftUI

/*
 * Work's parts (Home's, X2's, 26 November 2026): what needs you, decisions only, three at most, each with its one answer
 * in place and the rest a swipe away.
 */

/// A thing that needs you, as Home shows it: who asks and what, in two lines, and its one answer in place. The rest of
/// its answers are a swipe away; a tap on the row opens all of it.
struct Decision: Identifiable {
    enum Lead { case agent(id: String, avatar: JSONValue?), symbol(String) }
    let id: String
    let lead: Lead
    let who: String
    let what: String
    /// Its one answer, in place: its words, and what it does.
    let answer: (title: String, run: () -> Void)?
    /// The rest, a swipe away: each its words, whether it can't be undone, and what it does.
    let rest: [(title: String, destructive: Bool, run: () -> Void)]
    /// All of it (its card, or its task).
    let open: () -> Void
}

/// A row of "Needs you". At the accessibility sizes its answer stands under its words, whole, rather than squeezing them.
struct DecisionRow: View {
    let decision: Decision
    var busy = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let large = typeSize.isAccessibilitySize
        let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: Space.s2)) : AnyLayout(HStackLayout(alignment: .center, spacing: Space.s3))
        layout {
            Button(action: decision.open) {
                HStack(alignment: large ? .top : .center, spacing: Space.s3) {
                    lead
                    VStack(alignment: .leading, spacing: Space.line) {
                        Text(decision.who).font(.footnote).foregroundStyle(.secondary).lineLimit(large ? 3 : 1)
                        Text(decision.what).font(.subheadline.weight(.semibold)).lineLimit(large ? nil : 2)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("decision.\(decision.id)")
            if let answer = decision.answer {
                Button(answer.title, action: answer.run)
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.regular)
                    .tint(.primary)
                    .disabled(busy)
                    .fixedSize()
                    .frame(minHeight: Metrics.touch)
                    .accessibilityIdentifier("decision.\(decision.id).answer")
            }
        }
        .padding(.vertical, Space.s1)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            ForEach(Array(decision.rest.enumerated()), id: \.offset) { _, action in
                Button(action.title, role: action.destructive ? .destructive : nil, action: action.run)
            }
        }
    }

    @ViewBuilder private var lead: some View {
        switch decision.lead {
        case .agent(let id, let avatar): AgentFace(id: id, profile: avatar, size: 28)
        case .symbol(let symbol):
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .background(.fill.tertiary, in: .circle)
                .accessibilityHidden(true)
        }
    }
}
