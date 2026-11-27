import SwiftUI

/*
 * What needs you, each with its answer in place (the PWA's views/needs.ts; your words, 26 November 2026, after
 * OpenMausBot's best idea: "Needs you" with every card's buttons inline, never a trip to another page to answer): an
 * approval's Allow once and Deny, a proposal's Approve and Decline, work cut short's Resume, an agent you paused that work
 * waits behind. What takes more than a tap (comparing a device's code, typing a key, a service's question with fields,
 * keeping a fact in your words) opens the Inbox's own row for it in a sheet. The Inbox is still where all of it is.
 */

/// The items of "Needs you", amber, only when something waits.
struct NeedsYou: View {
    let session: Session
    let work: Attended
    /// Opens a task's thread.
    let open: (String) -> Void
    @Environment(\.showInbox) private var showInbox
    @State private var sheet: NeedSheet?
    @State private var trouble: String?
    @State private var busy: Set<String> = []

    /// What a sheet answers: the Inbox's own row for it.
    enum NeedSheet: Identifiable {
        case approval(ActionView)
        case key(SecretRequestView)
        case fact(Fact)
        case pairing(PairingView)
        case question(QuestionView)
        case screen(ScreenSessionView)
        /// What the node noticed for you: its whole words, to read and dismiss.
        case notice(NoticeView)
        /// A loop it drafted: what it runs and when, to add or dismiss.
        case draft(LoopDraftView)
        /// A connector asked for: to let the asker use it, to add it from Connectors, or to dismiss.
        case connector(ConnectorRequestView)

        var id: String {
            switch self {
            case .approval(let a): "action:\(a.id)"
            case .key(let r): "key:\(r.id)"
            case .fact(let f): "fact:\(f.id)"
            case .pairing(let p): "pairing:\(p.id)"
            case .question(let q): "question:\(q.id)"
            case .screen(let s): "screen:\(s.id)"
            case .notice(let n): "notice:\(n.id)"
            case .draft(let d): "draft:\(d.id)"
            case .connector(let c): "connector:\(c.id)"
            }
        }
    }

    private var admin: Bool { session.can("fleet:admin") }
    private var canAct: Bool { session.can("fleet:admin") && session.can("chat") }

    var body: some View {
        let items = items
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Space.s2) {
                    Circle().fill(Color.needs).frame(width: 8, height: 8)
                    Text("Needs you · \(items.count)").monospacedDigit()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.needs)
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s3)
                .padding(.bottom, Space.s1)
                .accessibilityAddTraits(.isHeader)
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider().padding(.leading, Space.s4) }
                    item.view
                }
            }
            .background(.background.secondary, in: .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).strokeBorder(Color.needs.opacity(0.38), lineWidth: 1))
            .sheet(item: $sheet) { sheet in NeedSheetView(session: session, sheet: sheet) }
            .alert("That didn't go through", isPresented: .init(get: { trouble != nil }, set: { if !$0 { trouble = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(trouble ?? "")
            }
        }
    }

    private struct Item: Identifiable {
        let id: String
        let view: AnyView
    }

    /// Every item, as the count says: each task row that needs you (its agent's asks under it), then what is no task's.
    private var items: [Item] {
        let now = Date.now.timeIntervalSince1970 * 1000
        let waiting = session.waiting
        var shownActions = Set<String>()
        var out: [Item] = []
        for row in work.needs {
            if row.word == "Allow?" {
                for action in waiting where Roster.agentOfCaller(action.by) == row.agent.id {
                    shownActions.insert(action.id)
                    out.append(approval(action, row: row))
                }
            } else {
                out.append(taskItem(row))
            }
        }
        for action in waiting where !shownActions.contains(action.id) { out.append(approval(action, row: nil)) }
        for pairing in session.pairings {
            out.append(item("pairing:\(pairing.id)", icon: pairing.kind == "node" ? "server.rack" : "iphone", who: pairing.kind == "node" ? "A machine asks to join" : "A device asks to join", what: Text(pairing.name)) {
                if admin { primary("Compare codes…") { sheet = .pairing(pairing) } }
            })
        }
        for request in session.requests {
            out.append(item("key:\(request.id)", icon: "key", who: "\(Primary.name) asks for a key", what: Text("\(Text(request.name).font(.subheadline.monospaced())) · \(request.purpose)")) {
                if session.can("vault:write") { primary("Add it…") { sheet = .key(request) } }
            })
        }
        for question in session.questions where question.expires > now {
            out.append(item("question:\(question.id)", icon: "powerplug", who: "\(question.label) asks", what: Text(question.message)) {
                primary("Answer…") { sheet = .question(question) }
            })
        }
        for screen in session.screenSessions {
            let using = screen.state == "allowed"
            out.append(item("screen:\(screen.id)", icon: "display", who: using ? "\(Primary.name) is using \(screen.nodeName)" : "\(Primary.name) asks to use \(screen.nodeName)", what: Text(screen.why)) {
                primary(using ? "See it…" : "Answer…") { sheet = .screen(screen) }
            })
        }
        for notice in session.notices {
            out.append(item("notice:\(notice.id)", icon: notice.severity == "info" ? "bell" : "exclamationmark.triangle", who: "Noticed", what: Text(notice.title)) {
                if admin {
                    secondary("Dismiss", busy: busy.contains(notice.id)) { run(notice.id) { try await session.dismiss(notice) } }
                }
                if let showInbox { secondary("Read") { showInbox() } }
            })
        }
        for fact in session.facts {
            out.append(item("fact:\(fact.id)", icon: "person", who: "\(Primary.name) noticed about you", what: Text(fact.text.components(separatedBy: "\n").first ?? "")) {
                primary("Keep or drop…") { sheet = .fact(fact) }
            })
        }
        return out
    }

    private func approval(_ action: ActionView, row: WorkRow?) -> Item {
        Item(id: "action:\(action.id)", view: AnyView(AskCard(session: session, action: action, row: row)))
    }

    /// A task only you can move on: its proposal, its work cut short, an agent you paused that it waits behind.
    private func taskItem(_ row: WorkRow) -> Item {
        let lead = AnyView(AgentFace(id: row.agent.id, profile: row.agent.avatar, size: 20))
        switch row.word {
        case "Approve?":
            return Item(id: "task:\(row.id)", view: AnyView(NeedItem(lead: lead, who: "\(row.agent.name) proposes", what: Text(row.title)) {
                if canAct {
                    primary("Approve", busy: busy.contains(row.id)) { run(row.id) { try await session.control(task: row.id, "approve") } }
                    secondary("Decline", busy: busy.contains(row.id)) { run(row.id) { try await session.control(task: row.id, "stop") } }
                }
                secondary("Open") { open(row.id) }
            }))
        case "Interrupted":
            return Item(id: "task:\(row.id)", view: AnyView(NeedItem(lead: lead, who: "\(row.agent.name) · interrupted", what: Text(row.title)) {
                if canAct { primary("Resume", busy: busy.contains(row.id)) { run(row.id) { try await session.control(task: row.id, "resume") } } }
                secondary("Open") { open(row.id) }
            }))
        case "Agent paused":
            return Item(id: "task:\(row.id)", view: AnyView(NeedItem(lead: lead, who: "\(row.agent.name) is paused", what: Text(row.title)) {
                if canAct { primary("Resume \(row.agent.name)", busy: busy.contains(row.id)) { run(row.id) { try await session.control(agent: row.agent.id, "resume") } } }
                secondary("Open") { open(row.id) }
            }))
        default:
            return Item(id: "task:\(row.id)", view: AnyView(NeedItem(lead: lead, who: row.agent.name, what: Text(row.title)) {
                secondary("Open") { open(row.id) }
            }))
        }
    }

    private func item(_ id: String, icon: String, who: String, what: Text, @ViewBuilder actions: () -> some View) -> Item {
        Item(id: id, view: AnyView(NeedItem(lead: AnyView(NeedIcon(symbol: icon)), who: who, what: what, actions: actions)))
    }

    private func primary(_ title: String, busy: Bool = false, _ action: @escaping () -> Void) -> some View { NeedButton(title: title, prominent: true, busy: busy, action: action) }

    private func secondary(_ title: String, busy: Bool = false, _ action: @escaping () -> Void) -> some View { NeedButton(title: title, prominent: false, busy: busy, action: action) }

    /// Something answered: its buttons held while the node is told, and what went wrong said.
    private func run(_ id: String, _ work: @escaping @MainActor () async throws -> Void) {
        busy.insert(id)
        Task.immediate {
            defer { busy.remove(id) }
            do { try await work() } catch { trouble = error.localizedDescription }
        }
    }
}

/// An item of "Needs you": who asks (an agent's orb, or what it is), what, a note (and its time to answer), its buttons.
struct NeedItem<Actions: View>: View {
    let lead: AnyView
    let who: String
    let what: Text
    var note = ""
    var warn = false
    var expires: Double? = nil
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(spacing: Space.s2) {
                lead.frame(width: 20, height: 20)
                Text(who).lineLimit(1)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            what
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if !note.isEmpty || expires != nil {
                Group {
                    if let expires {
                        Text("\(note.isEmpty ? "" : "\(note) ")Expires \(Work.relativeTime(expires)); no answer means no.")
                    } else {
                        Text(note)
                    }
                }
                .font(.caption)
                .foregroundStyle(warn ? AnyShapeStyle(Color.needs) : AnyShapeStyle(.secondary))
                .monospacedDigit()
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.s2) { actions }
                VStack(alignment: .leading, spacing: Space.s2) { actions }
            }
            .padding(.top, Space.s1)
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What an item is about, where no agent asks: its symbol on a small round tile.
struct NeedIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: 20, height: 20)
            .background(.fill.tertiary, in: .circle)
            .accessibilityHidden(true)
    }
}

/// The Inbox's own row for an item, in a sheet: closed by itself once the item is answered (it has left the Inbox).
struct NeedSheetView: View {
    let session: Session
    let sheet: NeedsYou.NeedSheet
    @Environment(\.dismiss) private var dismiss
    /// A row holds its sheet open after what it answered has left its list (a loop's webhook secret, said once).
    @State private var holding = false

    var body: some View {
        switch sheet {
        case .approval(let action):
            ApprovalSheet(session: session, action: action)
        default:
            NavigationStack {
                GroupedList {
                    Section {
                        switch sheet {
                        case .key(let request): KeyRequestRow(session: session, request: request)
                        case .fact(let fact): FactRow(session: session, fact: fact)
                        case .pairing(let pairing): JoinRequestRow(session: session, pairing: pairing)
                        case .question(let question): QuestionRow(session: session, question: question)
                        case .screen(let screen): ScreenSessionRow(session: session, screen: screen)
                        case .notice(let notice): NoticeRow(session: session, notice: notice)
                        case .draft(let draft): LoopDraftRow(session: session, draft: draft, holding: $holding)
                        case .connector(let request): ConnectorRequestRow(session: session, request: request)
                        case .approval: EmptyView()
                        }
                    }
                }
                .navigationTitle(title)
                .inlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            }
            .presentationDetents([.medium, .large])
            .sheetSize(width: 520, height: 480)
            // (Held while a loop it just added says its webhook's secret, which it says this once.)
            .onChange(of: present) { if !present && !holding { dismiss() } }
            .onChange(of: holding) { if !holding && !present { dismiss() } }
        }
    }

    private var title: String {
        switch sheet {
        case .key(let request): "A key for \(request.name)"
        case .fact: "A fact about you"
        case .pairing(let pairing): "\(pairing.name) asks to join"
        case .question(let question): "\(question.label) asks"
        case .screen(let screen): screen.nodeName
        case .notice: "Noticed"
        case .draft(let draft): "A loop: \(draft.label ?? draft.name)"
        case .connector(let request): "A connector: \(request.label ?? request.connector)"
        case .approval: ""
        }
    }

    /// Whether it still waits: answered elsewhere or here, it has left its list.
    private var present: Bool {
        switch sheet {
        case .key(let request): session.requests.contains(request)
        case .fact(let fact): session.facts.contains(fact)
        case .pairing(let pairing): session.pairings.contains(pairing)
        case .question(let question): session.questions.contains(question)
        case .screen(let screen): session.screenSessions.contains { $0.id == screen.id }
        case .notice(let notice): session.notices.contains(notice)
        case .draft(let draft): session.loopDrafts.contains(draft)
        case .connector(let request): session.connectorRequests.contains(request)
        case .approval(let action): session.waiting.contains(action)
        }
    }
}

/// A button of an item of "Needs you": the ink's prominent glass for its answer, plain glass for the rest; a capsule a
/// thumb's height (its glass round a 30-point label is 44).
struct NeedButton: View {
    let title: String
    var prominent = false
    var busy = false
    let action: () -> Void

    var body: some View {
        if prominent {
            Button(action: action) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Prominent.label()).frame(minHeight: 30).padding(.horizontal, Space.s1)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.capsule)
            .disabled(busy)
        } else {
            Button(action: action) {
                Text(title).font(.subheadline.weight(.medium)).frame(minHeight: 30).padding(.horizontal, Space.s1)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.capsule)
            .disabled(busy)
        }
    }
}

/// An approval, compact (the PWA's askItem): who asks and what, its target in mono, then Allow once (confirmed, as the
/// Inbox's), Deny, and the whole card (its arguments, your own words in it, its changes). A delete is approved only in the
/// whole card, by typing what it deletes. In "Needs you", and in the thread of the task whose agent asks.
struct AskCard: View {
    let session: Session
    let action: ActionView
    /// The task row its agent's asking stands for (nil: the primary, a loop, a service asks).
    var row: WorkRow? = nil
    @State private var confirming = false
    @State private var whole = false
    @State private var busy = false
    @State private var trouble: String?

    var body: some View {
        let destructive = action.kind == "delete", outward = action.kind == "outward"
        let lead: AnyView = row.map { AnyView(AgentFace(id: $0.agent.id, profile: $0.agent.avatar, size: 20)) } ?? AnyView(NeedIcon(symbol: Approval.symbol(action.kind)))
        let asker = Approval.askedBy(action.by)
        let who = row.map { "\($0.agent.name) · \($0.title)" } ?? "\(asker.prefix(1).uppercased())\(asker.dropFirst()) asks"
        // Its class in a word ("Outward"), the rest of its line in the whole card.
        let what = Text("\(Approval.classLine(action.kind).components(separatedBy: ":")[0]) · \(Text("\(action.connector).\(action.tool)").font(.subheadline.monospaced())) \(Text(action.target).font(.subheadline.monospaced()).foregroundStyle(.secondary))")
        let note = destructive ? "It can't be brought back once deleted." : outward ? "Others can see it once it's sent." : ""
        NeedItem(lead: lead, who: who, what: what, note: note, warn: destructive || outward, expires: action.expires) {
            if session.can("fleet:admin") {
                NeedButton(title: destructive ? "Allow delete…" : "Allow once", prominent: true, busy: busy) {
                    if destructive { whole = true } else { confirming = true }
                }
                NeedButton(title: "Deny", busy: busy) { decide(false) }
            }
            Button { whole = true } label: { Image(systemName: "ellipsis").frame(width: 30, height: 30) }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Everything about it, or your own words in it")
        }
        .sheet(isPresented: $whole) { ApprovalSheet(session: session, action: action) }
        .alert("Approve and send?", isPresented: $confirming) {
            Button("Approve and send") { decide(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(session.nodeName(of: action.node)) sends it to \(action.target) once, as soon as you approve. It can't be called back, and if it fails it isn't retried.")
        }
        .alert("That didn't go through", isPresented: .init(get: { trouble != nil }, set: { if !$0 { trouble = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(trouble ?? "")
        }
    }

    private func decide(_ approve: Bool) {
        busy = true
        Task.immediate {
            defer { busy = false }
            do { try await session.decide(action, approve: approve) } catch { trouble = error.localizedDescription }
        }
    }
}
