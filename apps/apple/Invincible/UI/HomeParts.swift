import SwiftUI

/*
 * Home's parts (X2's Home, 26 November 2026: what needs you and what is proven, on one screen): the agents in a strip,
 * their orbs the only colour on the page, each a tap from its page; what needs you, decisions only, three at most, each
 * with its one answer in place and the rest a swipe away; and the bar at the foot, always in reach of a thumb: search and
 * ask, the primary's message box, and a task to give.
 */

/// The agents in a strip, what needs you first, then what is at work: each its orb (still: only the orb you are looking
/// at moves), its name, and where it stands in a word. One tap opens its page.
struct AgentStrip: View {
    let session: Session
    let rows: [RosterRow]
    let open: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: Space.s3) {
                ForEach(Self.ordered(rows)) { row in
                    Button { open(row.id) } label: { AgentChip(row: row, avatar: session.drawn(row.id)?.avatar) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("agent.\(row.id)")
                }
            }
            .padding(.horizontal, Metrics.margin)
            .padding(.vertical, Space.s2)
        }
        .scrollClipDisabled()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your agents")
    }

    /// What needs you first, then at work, then the rest, each in the node's order.
    static func ordered(_ rows: [RosterRow]) -> [RosterRow] {
        let ranked: [(rank: Int, at: Int, row: RosterRow)] = rows.enumerated().map { (rank($0.element), $0.offset, $0.element) }
        return ranked.sorted { ($0.rank, $0.at) < ($1.rank, $1.at) }.map(\.row)
    }

    private static func rank(_ row: RosterRow) -> Int {
        if row.needs || row.standing == .needs { return 0 }
        switch row.standing {
        case .working: return 1
        case .failed: return 2
        case .queued: return 3
        default: return 4
        }
    }

    /// Where an agent stands, in a word under its name: never a colour alone.
    static func word(_ row: RosterRow) -> String {
        if row.standing == .failed { return "Failed" }
        if row.needs { return "Asks you" }
        switch row.standing {
        case .working: return "Working"
        case .needs: return "Asks you"
        case .failed: return "Failed"
        case .paused: return "Paused"
        case .queued: return "Queued"
        case .verified, .unread: return "New"
        case .resting: return "Idle"
        }
    }
}

private struct AgentChip: View {
    let row: RosterRow
    let avatar: JSONValue?
    /// As wide as its words need at the size you read at (72 points at the default), so a name isn't cut to its first letter.
    @ScaledMetric(relativeTo: .footnote) private var width: CGFloat = 72

    var body: some View {
        let word = AgentStrip.word(row)
        VStack(spacing: Space.s1) {
            AgentFace(id: row.id, profile: avatar, size: 44)
            Text(row.name)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
            HStack(spacing: 3) {
                if row.standing == .working { LiveDot(color: .ink) }
                Text(word)
            }
            .font(.caption2.weight(row.standing != .failed && (row.needs || row.standing == .needs) ? .bold : .regular))
            .foregroundStyle(row.standing == .failed ? AnyShapeStyle(Color.danger) : row.needs || row.standing == .needs ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .lineLimit(1)
        }
        .frame(width: width)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.name), \(word)")
        .accessibilityAddTraits(.isButton)
    }
}

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

/// The bar at Home's foot (X2: "the bar, always there"): search and ask (the iPhone's ⌘K), the primary's message box, and
/// a task to give; while you write, the box's send in place of the give, the one filled button on the screen.
struct HomeBar: View {
    @Bindable var chat: ChatModel
    let client: NodeClient
    var composing: FocusState<Bool>.Binding
    let search: (() -> Void)?
    let give: (() -> Void)?
    let sent: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(alignment: .bottom, spacing: Space.s2) {
                if let search {
                    Button(action: search) {
                        Image(systemName: "magnifyingglass").font(.body.weight(.semibold)).frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Search, or ask")
                    .accessibilityIdentifier("bar.search")
                }
                TextField("Ask \(Primary.name)…", text: $chat.draft, axis: .vertical)
                    .plainField()
                    .id(chat.sent)
                    .lineLimit(1...5)
                    .focused(composing)
                    .sendsOnReturn(send)
                    .padding(.horizontal, Space.s4)
                    .padding(.vertical, 11)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22, style: .continuous))
                    .accessibilityIdentifier("composer")
                if chat.sendable {
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.body.weight(.bold)).foregroundStyle(Prominent.label()).frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("send")
                } else if let give {
                    Button(action: give) {
                        Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Give a task")
                    .accessibilityIdentifier("bar.give")
                }
            }
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.vertical, Space.s2)
        .readingWidth()
    }

    private func send() {
        guard !chat.answering, chat.sendable else { return }
        chat.send(with: client)
        composing.wrappedValue = false
        sent()
    }
}
