#if os(iOS)
import SwiftUI

/// What needs you in a chat, at its foot (the owner's word of 28 November 2026, Grok Bot's action cards answered in
/// place): its first decision with its one answer, and how many more wait there, a tap from Needs you. Nothing while
/// nothing does. In an agent's chat, that agent's own approvals (its proposals are answered on its tasks' rows there); in
/// your agent's, everything that is no agent's: a device asking to join, a key it asked for, a question, an approval no
/// agent stands for.
struct NeedsCard: View {
    let session: Session
    /// The agent whose chat it is; nil: your agent's.
    var agent: String? = nil
    @State private var desk = DecisionDesk()
    @Environment(\.openPlace) private var openPlace
    @Environment(\.showInbox) private var showInbox

    var body: some View {
        if let work = session.attended {
            let decisions = Self.mine(desk.decisions(session, work, go: { openPlace?($0) }), agent: agent)
            if let first = decisions.first {
                VStack(alignment: .leading, spacing: 0) {
                    DecisionRow(decision: first, busy: desk.busy.contains(first.id))
                    if decisions.count > 1 {
                        Divider()
                        Button { showInbox?() } label: {
                            HStack {
                                Text("\(decisions.count - 1) more need you").font(.subheadline.weight(.semibold))
                                Spacer(minLength: Space.s2)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                            .frame(minHeight: Metrics.touch)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat.needs.more")
                    }
                }
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s1)
                .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: ComposerBoxMetrics.radius, style: .continuous))
                // As wide as the message box under it and what is under way: on an iPad the conversation's column.
                .padding(.horizontal, Metrics.margin)
                .readingWidth()
                .modifier(DecisionDeskSheets(desk: desk, session: session))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat.needs")
            }
        }
    }

    /// The decisions that wait in this chat: an agent's approvals in its own; everything that is no agent's in your
    /// agent's.
    static func mine(_ decisions: [Decision], agent: String?) -> [Decision] {
        decisions.filter { decision in
            switch decision.lead {
            case .agent(let id, _): agent == id && decision.id.hasPrefix("action:")
            case .symbol: agent == nil
            }
        }
    }
}
#endif
