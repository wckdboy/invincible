import SwiftUI

extension EnvironmentValues {
    /// Goes to a place in the window (an iPhone's: over Home; an iPad's: the place chosen), where the window can.
    @Entry var openPlace: ((Place) -> Void)? = nil
}

/*
 * What needs you, decisions only, built one way for Home (three at most) and for Needs you (every one): each with its one
 * answer in place, the rest a swipe away, the whole of it a tap (its card, its sheet, or its task). The desk holds what
 * the answers are doing: the sheet open, the approval being confirmed, the rows being answered, what went wrong.
 */
@MainActor @Observable final class DecisionDesk {
    var sheet: NeedsYou.NeedSheet?
    var confirming: ActionView?
    var busy: Set<String> = []
    var trouble: String?

    /// Every decision that waits, as the count counts them (Session.needsYou): each approval once (an agent's under its
    /// task's name), each task only you can move on, devices, keys, questions, asks to use a Mac, loops it drafted and
    /// connectors asked for (the PWA's decisions, in its order).
    func decisions(_ session: Session, _ work: Attended, go: @escaping (Place) -> Void) -> [Decision] {
        let now = Date.now.timeIntervalSince1970 * 1000
        let admin = session.can("fleet:admin")
        let canAct = admin && session.can("chat")
        var shown = Set<String>()
        var out: [Decision] = []
        for row in work.needs {
            if row.word == "Allow?" {
                for action in session.waiting where Roster.agentOfCaller(action.by) == row.agent.id {
                    shown.insert(action.id)
                    out.append(approval(action, row: row, admin: admin, session: session))
                }
            } else {
                out.append(task(row, canAct: canAct, session: session, go: go))
            }
        }
        for action in session.waiting where !shown.contains(action.id) { out.append(approval(action, row: nil, admin: admin, session: session)) }
        for pairing in session.pairings {
            out.append(Decision(id: "pairing:\(pairing.id)", lead: .symbol(pairing.kind == "node" ? "server.rack" : "iphone"), who: pairing.kind == "node" ? "A machine asks to join" : "A device asks to join", what: pairing.name, answer: admin ? ("Compare…", { self.sheet = .pairing(pairing) }) : nil, rest: [], open: { self.sheet = .pairing(pairing) }))
        }
        for request in session.requests {
            out.append(Decision(id: "key:\(request.id)", lead: .symbol("key"), who: "\(Primary.name) asks for a key", what: "\(request.name) · \(request.purpose)", answer: session.can("vault:write") ? ("Add…", { self.sheet = .key(request) }) : nil, rest: [], open: { self.sheet = .key(request) }))
        }
        for question in session.questions where question.expires > now {
            out.append(Decision(id: "question:\(question.id)", lead: .symbol("powerplug"), who: "\(question.label) asks", what: question.message, answer: ("Answer…", { self.sheet = .question(question) }), rest: [], open: { self.sheet = .question(question) }))
        }
        for screen in session.screenSessions {
            let using = screen.state == "allowed"
            out.append(Decision(id: "screen:\(screen.id)", lead: .symbol("display"), who: using ? "\(Primary.name) is using \(screen.nodeName)" : "\(Primary.name) asks to use \(screen.nodeName)", what: screen.why, answer: (using ? "See it…" : "Answer…", { self.sheet = .screen(screen) }), rest: [], open: { self.sheet = .screen(screen) }))
        }
        for draft in session.loopDrafts {
            out.append(Decision(id: "draft:\(draft.id)", lead: .symbol("repeat"), who: "\(Primary.name) drafted a loop", what: draft.label ?? draft.name, answer: ("Review…", { self.sheet = .draft(draft) }), rest: [], open: { self.sheet = .draft(draft) }))
        }
        for request in session.connectorRequests {
            out.append(Decision(id: "connector:\(request.id)", lead: .symbol("powerplug"), who: "\(request.by) asks for a connector", what: request.label ?? request.connector, answer: ("Review…", { self.sheet = .connector(request) }), rest: [], open: { self.sheet = .connector(request) }))
        }
        return out
    }

    /// What the node noticed for you, and facts it noticed about you: news, counted nowhere, each yours to dismiss or keep.
    func news(_ session: Session) -> [Decision] {
        let admin = session.can("fleet:admin")
        var out: [Decision] = []
        for notice in session.notices {
            let id = "notice:\(notice.id)"
            out.append(Decision(id: id, lead: .symbol(notice.severity == "info" ? "bell" : "exclamationmark.triangle"), who: Notices.from(notice.source), what: notice.title, answer: nil, rest: admin ? [("Dismiss", false, { self.run(id) { try await session.dismiss(notice) } })] : [], open: { self.sheet = .notice(notice) }))
        }
        for fact in session.facts {
            let id = "fact:\(fact.id)"
            let canKeep = session.can("mind:write")
            out.append(Decision(id: id, lead: .symbol("person.text.rectangle"), who: "\(Primary.name) noticed about you", what: fact.text.components(separatedBy: "\n").first ?? "", answer: canKeep ? ("Keep", { self.run(id) { try await session.keep(fact) } }) : nil, rest: canKeep ? [("Drop", true, { self.run(id) { try await session.drop(fact) } }), ("In my words", false, { self.sheet = .fact(fact) })] : [], open: { self.sheet = .fact(fact) }))
        }
        return out
    }

    private func approval(_ action: ActionView, row: WorkRow?, admin: Bool, session: Session) -> Decision {
        let destructive = action.kind == "delete"
        let asker = Approval.askedBy(action.by)
        let lead: Decision.Lead = row.map { .agent(id: $0.agent.id, avatar: $0.agent.avatar) } ?? .symbol(Approval.symbol(action.kind))
        let who = row.map { "\($0.agent.name) · \($0.title)" } ?? "\(asker.prefix(1).uppercased())\(asker.dropFirst()) asks"
        let what = "\(Approval.classLine(action.kind).components(separatedBy: ":")[0]) · \(action.connector).\(action.tool) \(action.target)"
        let id = "action:\(action.id)"
        return Decision(
            id: id, lead: lead, who: who, what: what,
            // A delete is approved only in its whole card, by typing what it deletes.
            answer: admin ? (destructive ? "Review…" : "Allow once", { if destructive { self.sheet = .approval(action) } else { self.confirming = action } }) : nil,
            rest: admin ? [("Deny", true, { self.run(id) { try await session.decide(action, approve: false) } }), ("More", false, { self.sheet = .approval(action) })] : [],
            open: { self.sheet = .approval(action) }
        )
    }

    private func task(_ row: WorkRow, canAct: Bool, session: Session, go: @escaping (Place) -> Void) -> Decision {
        let id = "task:\(row.id)"
        let lead = Decision.Lead.agent(id: row.agent.id, avatar: row.agent.avatar)
        let open = { go(.task(row.id)) }
        switch row.word {
        case "Approve?":
            return Decision(id: id, lead: lead, who: "\(row.agent.name) proposes", what: row.title,
                            answer: canAct ? ("Approve", { self.run(id) { try await session.control(task: row.id, "approve") } }) : nil,
                            rest: canAct ? [("Decline", true, { self.run(id) { try await session.control(task: row.id, "stop") } })] : [], open: open)
        case "Interrupted":
            return Decision(id: id, lead: lead, who: "\(row.agent.name) · interrupted", what: row.title,
                            answer: canAct ? ("Resume", { self.run(id) { try await session.control(task: row.id, "resume") } }) : nil, rest: [], open: open)
        case "Agent paused":
            return Decision(id: id, lead: lead, who: "\(row.agent.name) is paused", what: row.title,
                            answer: canAct ? ("Resume", { self.run(id) { try await session.control(agent: row.agent.id, "resume") } }) : nil, rest: [], open: open)
        default:
            return Decision(id: id, lead: lead, who: row.agent.name, what: row.title, answer: nil, rest: [], open: open)
        }
    }

    /// Something answered: its row held while the node is told, and what went wrong said.
    func run(_ id: String, _ work: @escaping @MainActor () async throws -> Void) {
        busy.insert(id)
        Task.immediate {
            defer { self.busy.remove(id) }
            do { try await work() } catch { self.trouble = error.localizedDescription }
        }
    }
}

/// The desk's sheet and its two questions, on the screen that shows its decisions: the whole of one (its card or its
/// sheet), "Approve and send?" before an approval's yes, and what didn't go through.
struct DecisionDeskSheets: ViewModifier {
    @Bindable var desk: DecisionDesk
    let session: Session

    func body(content: Content) -> some View {
        content
            .sheet(item: $desk.sheet) { sheet in NeedSheetView(session: session, sheet: sheet) }
            .alert("Approve and send?", isPresented: .init(get: { desk.confirming != nil }, set: { if !$0 { desk.confirming = nil } }), presenting: desk.confirming) { action in
                Button("Approve and send") { desk.run("action:\(action.id)") { try await session.decide(action, approve: true) } }
                Button("Cancel", role: .cancel) {}
            } message: { action in
                Text("\(session.nodeName(of: action.node)) sends it to \(action.target) once, as soon as you approve. It can't be called back, and if it fails it isn't retried.")
            }
            .alert("That didn't go through", isPresented: .init(get: { desk.trouble != nil }, set: { if !$0 { desk.trouble = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(desk.trouble ?? "")
            }
    }
}
