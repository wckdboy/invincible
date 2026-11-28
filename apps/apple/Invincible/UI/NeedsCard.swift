#if os(iOS)
import SwiftUI

/// What needs you in a chat, as its last message (the owner's word of 28 November 2026, Grok Bot's asks answered in
/// place; the lead's of the same day: no Needs you screen, each ask in its own chat): every decision that waits there,
/// each with its one answer. Nothing while nothing does. In an agent's chat, that agent's own approvals (its proposals are
/// answered on its tasks' rows there); in your agent's, everything that is no agent's: a device asking to join, a key it
/// asked for, a question, an approval no agent stands for. An approval a link or a notification opens (`approval/<id>`)
/// is opened here, in its chat, its yes behind Face ID.
struct NeedsCard: View {
    let session: Session
    /// The agent whose chat it is; nil: your agent's.
    var agent: String? = nil
    @State private var desk = DecisionDesk()
    @State private var open: ActionView?
    @Environment(\.openPlace) private var openPlace

    var body: some View {
        Group {
            if let work = session.attended {
                let decisions = Self.mine(desk.decisions(session, work, go: { openPlace?($0) }), agent: agent)
                if !decisions.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(decisions, id: \.id) { decision in
                            if decision.id != decisions.first?.id { Divider() }
                            DecisionRow(decision: decision, busy: desk.busy.contains(decision.id))
                        }
                    }
                    .padding(.horizontal, Space.s4)
                    .padding(.vertical, Space.s1)
                    // A message of its own in the chat's flow: the quiet ground its answers have.
                    .background(.fill.tertiary, in: .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
                    .modifier(DecisionDeskSheets(desk: desk, session: session))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chat.needs")
                }
            }
        }
        .sheet(item: $open) { action in ApprovalSheet(session: session, action: action, guarded: true) }
        // An approval its link or its notification's Approve asked to see, when it is this chat's: its card, its yes
        // behind Face ID.
        .task(id: session.approvalToOpen) {
            guard let id = session.approvalToOpen else { return }
            if !session.waiting.contains(where: { $0.id == id }) { await session.reread(["actions"], force: true) }
            guard let action = session.waiting.first(where: { $0.id == id }), Self.chat(of: action, work: session.attended) == agent else { return }
            session.approvalToOpen = nil
            open = action
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

    /// The chat an approval waits in, as `mine` places it (DecisionDesk.decisions): its agent's while the team's work says
    /// that agent waits on your Allow, else your agent's (nil).
    static func chat(of action: ActionView, work: Attended?) -> String? {
        guard let agent = Roster.agentOfCaller(action.by), let work, work.needs.contains(where: { $0.word == "Allow?" && $0.agent.id == agent }) else { return nil }
        return agent
    }
}
#endif
