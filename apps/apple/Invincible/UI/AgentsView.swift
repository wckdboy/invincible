import SwiftUI

/// Where a row of the agents leads.
enum Route: Hashable {
    case primary
    case agent(String)
    case room(String)
}

/// The agents: the primary first, then every agent as the node lists them (the PWA's lib/arrange.ts `seating`), each its
/// orb and one line of what it is doing, marked amber when only you can move it on (lib/roster.ts says what each line is).
/// On an iPad they can be cards instead of rows, as the device remembers.
struct AgentsView: View {
    let session: Session
    /// On an iPad, the row whose page the detail column shows; on an iPhone a row is pushed instead.
    var selection: Binding<Route?>? = nil
    /// Opens a page: one just made, say (on an iPhone it is pushed; on an iPad it is shown beside).
    var open: (Route) -> Void = { _ in }
    @State private var query = ""
    @State private var giving = false
    @State private var seating = false
    @State private var gathering = false
    /// Beside a sidebar that lists the agents (an iPad's, a Mac's), the team's own page is its board, every agent a
    /// card (the PWA's on a wide screen), until you choose its list.
    @AppStorage("agents.cards") private var asCards = true
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// An iPhone's: the primary's row shows its tab.
    @Environment(\.showPrimary) private var showPrimary

    private var words: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Cards are offered where there is room for them: the page beside a sidebar (an iPhone pushes its rows instead).
    private var cardsOffered: Bool { selection != nil }
    private var cards: Bool { cardsOffered && asCards }
    /// The head of the list: the primary.
    private var head: [String] { Array(session.seats.prefix(1)) }
    /// The agents under it, as the node lists them.
    private var rest: [String] { Array(session.seats.dropFirst(head.count)) }
    /// While you search, the agents it finds, in their seats' order.
    private func found(in rows: [String: RosterRow]) -> [String] {
        session.seats.filter { id in rows[id].map { $0.name.localizedStandardContains(words) || $0.line.localizedStandardContains(words) } ?? false }
    }

    private var rooms: [RoomRow] {
        let rows = session.roomRows
        guard !words.isEmpty else { return rows }
        return rows.filter { $0.name.localizedStandardContains(words) || $0.line.localizedStandardContains(words) }
    }

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var width
    #endif

    var body: some View {
        List(selection: selection) {
            if let trouble = session.trouble {
                Section { TroubleRow(trouble: trouble) }
            }
            if let since = session.keptSince {
                // A still line over what it speaks of, not a row of its own.
                Section { KeptLine(since: since, asking: session.asksAgain) }
                    .listRowBackground(Color.clear)
            }
            #if os(iOS)
            // What the model calls came to, against your budget (an iPad has it at its sidebar's foot).
            if width == .compact, session.usage != nil {
                Section { UsageMeterView(session: session) }
            }
            #endif
            agents
            if !rooms.isEmpty {
                Section(head: "Rooms") {
                    ForEach(rooms) { row in
                        NavigationLink(value: Route.room(row.id)) { RoomRowView(row: row, faces: faces(of: row), selected: chosen(.room(row.id))) }
                    }
                }
            }
        }
        // An iPad fills the selected row with the tint and writes its words in white: the ink does on light, but on dark
        // the ink is cream, and white on it couldn't be read; there the system's grey holds the selection. (Only the
        // list's own tint: its bar's buttons and its sheets keep the ink.)
        .tint(scheme == .dark ? Color.selectionOnDark : .ink)
        .hairlinePage()
        .screen("agents.screen")
        .placeTitle("Agents")
        .toolbar { bar }
        .sheet(isPresented: $giving) { GiveSheet(session: session) }
        .sheet(isPresented: $seating) { AgentEditor(session: session) { open(.agent($0.id)) } }
        .sheet(isPresented: $gathering) { RoomEditor(session: session) { open(.room($0.id)) } }
        .searchable(text: $query, prompt: "Agents")
        .refreshable { await session.refresh() }
        .overlay {
            if session.team == nil, session.kept == nil, session.teamProblem == nil, session.trouble == nil { ProgressView() }
        }
    }

    /// The primary and the agents: as cards; as rows, the primary above the agents; or what a search finds.
    @ViewBuilder private var agents: some View {
        // Each agent's row, worked out once for all of them.
        let rows = Dictionary(session.rows.map { ($0.id, $0) }) { first, _ in first }
        if cards {
            Section {
                CardGrid {
                    ForEach(words.isEmpty ? session.seats : found(in: rows), id: \.self) { id in card(id, rows) }
                }
            } footer: {
                footer
            }
        } else if words.isEmpty {
            Section {
                ForEach(head, id: \.self) { id in seat(id, rows) }
            }
            Section {
                ForEach(rest, id: \.self) { id in seat(id, rows) }
            } header: {
                if !rest.isEmpty { SectionHead(title: "Agents", count: rest.count) }
            } footer: {
                footer
            }
        } else {
            let matches = found(in: rows)
            Section {
                ForEach(matches, id: \.self) { id in seat(id, rows) }
            } header: {
                if !matches.isEmpty { SectionHead(title: "Agents", count: matches.count) }
            } footer: {
                footer
            }
        }
    }

    @ToolbarContentBuilder private var bar: some ToolbarContent {
        #if os(iOS)
        // (The place's title says what it is: no mark beside it says it again.)
        actions
        #else
        // (On a Mac the mark heads the sidebar, as the PWA's wide screen has it.)
        actions
        #endif
    }

    @ToolbarContentBuilder private var actions: some ToolbarContent {
        // The team's own work: given to it, the agent best suited takes it.
        ToolbarItem(placement: .barTrailing) {
            // (Given once the node has answered: never from the agents this device kept.)
            Button { giving = true } label: { Label("Give the agents a task", systemImage: "hammer") }
                .disabled(!session.can("fleet:admin") || session.team == nil || session.rows.isEmpty)
        }
        ToolbarItem(placement: .barTrailing) {
            Menu {
                Button { seating = true } label: { Label("New agent", systemImage: "person.badge.plus") }
                Button { gathering = true } label: { Label("New room", systemImage: "bubble.left.and.bubble.right") }
                    .disabled(session.rows.isEmpty)
            } label: {
                Label("Add", systemImage: "plus")
            }
            .disabled(!session.can("fleet:admin") || session.team == nil)
        }
        if cardsOffered {
            ToolbarItem(placement: .barTrailing) {
                Button { asCards.toggle() } label: {
                    Label(asCards ? "Show as a list" : "Show as cards", systemImage: asCards ? "list.bullet" : "square.grid.2x2")
                }
            }
        }
    }

    @ViewBuilder private var footer: some View {
        if let problem = session.teamProblem {
            PageNote(problem)
        } else if session.team != nil, session.rows.isEmpty {
            PageNote("No other agents yet. Add one with +: a name, a lasting job and a workspace of its own.")
        }
    }

    /// A seat as a row: the primary's chat, or an agent's page.
    @ViewBuilder private func seat(_ id: String, _ rows: [String: RosterRow]) -> some View {
        if id == "primary" {
            opening(.primary) {
                PrimaryRow(now: session.primary, standing: primaryStanding, selected: chosen(.primary))
            }
        } else if let row = rows[id] {
            opening(.agent(id)) {
                AgentRow(row: row, profile: session.drawn(id)?.avatar, selected: chosen(.agent(id)))
            }
        }
    }

    /// A row that opens its page. The primary's, on an iPhone, shows its own conversation.
    @ViewBuilder private func opening<Row: View>(_ route: Route, @ViewBuilder row: () -> Row) -> some View {
        if route == .primary, let showPrimary {
            Button(action: showPrimary, label: row).tint(.primary)
        } else {
            NavigationLink(value: route, label: row)
        }
    }

    /// A seat as a card: the same, with its face large.
    @ViewBuilder private func card(_ id: String, _ rows: [String: RosterRow]) -> some View {
        let route = id == "primary" ? Route.primary : Route.agent(id)
        Button { open(route) } label: {
            if id == "primary" {
                SeatCard(name: Primary.name, line: session.primary.line, needs: session.primary.tone == .warn, standing: primaryStanding, selected: chosen(route)) {
                    SeatFace(id: id, size: Metrics.cardFace, standing: primaryStanding)
                }
            } else if let row = rows[id] {
                SeatCard(name: row.name, line: row.line, needs: row.needs, standing: row.standing, selected: chosen(route)) {
                    SeatFace(id: id, profile: session.drawn(id)?.avatar, size: Metrics.cardFace, standing: row.standing)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var primaryStanding: Standing { session.primaryStanding }

    /// The row the detail column shows, on an iPad.
    private func chosen(_ route: Route) -> Bool { selection?.wrappedValue == route }

    /// A room's members' faces: each one's handle and its saved colour.
    private func faces(of row: RoomRow) -> [MemberFace] {
        row.members.map { MemberFace(id: $0, profile: session.drawn($0)?.avatar) }
    }
}

/// A row of the agents, whoever's it is: a face in the one column every face stands in, a name, and what it is doing
/// in a line or two (always as tall as two, so a row keeps its height when its line changes), marked in the primary's red
/// when it needs you. An agent's and the primary's say where they stand in a word beside the name (under it, at the largest
/// sizes).
struct RosterLine<Face: View>: View {
    let name: String
    let line: String
    let needs: Bool
    /// Where it stands, in a word; nil: a room, which has only its mark: when it needs you, or something there is new to you.
    var standing: Standing? = nil
    /// A room where something ended since you looked (its mark is green until you open it).
    var fresh = false
    /// It is the row an iPad shows selected. On the list's ink a coloured line was hard to read (3.3 to 1) and the
    /// system's secondary grey harder, so its line takes no colour of its own there and turns as its name does; the mark
    /// beside it still says it needs you.
    var selected = false
    @ViewBuilder let face: Face
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Space.s3) {
            face.frame(width: Metrics.rowSeat, height: Metrics.rowSeat)
            VStack(alignment: .leading, spacing: Space.line) {
                // Its word is always there, so a row is as tall whatever it says.
                if typeSize.isAccessibilitySize {
                    Text(name).font(.headline).lineLimit(1)
                    if let standing { chip(standing) }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        Text(name).font(.headline).lineLimit(1)
                        Spacer(minLength: 0)
                        if let standing { chip(standing).fixedSize() }
                    }
                }
                // Beside its chip, the line doesn't say the chip's word again.
                let said = standing?.beside(line) ?? line
                Group {
                    if selected { Text(said) } else { Text(said).foregroundStyle(needs ? Color.needs : .secondary) }
                }
                .font(.subheadline)
                .lineLimit(2, reservesSpace: true)
            }
            if standing == nil {
                Spacer(minLength: 0)
                if needs { NeedsMark() } else if fresh { NewMark() }
            }
        }
        .padding(.vertical, Space.s1)
        .accessibilityElement(children: .combine)
    }

    /// Its state in a word; at rest, which says none, the chip's place is kept, so a row is as tall whatever it says.
    @ViewBuilder private func chip(_ standing: Standing) -> some View {
        if let word = standing.shown {
            StateBadge(text: word, tone: standing.tone, selected: selected)
        } else {
            StateBadge(text: "Queued", tone: "neutral").hidden().accessibilityHidden(true)
        }
    }
}

struct PrimaryRow: View {
    let now: PrimaryNow
    var standing = Standing.resting
    var selected = false

    var body: some View {
        RosterLine(name: Primary.name, line: now.text, needs: now.tone == .warn, standing: standing, selected: selected) {
            SeatFace(id: "primary", size: Metrics.rowFace, standing: standing, selected: selected)
        }
    }
}

struct AgentRow: View {
    let row: RosterRow
    /// Its saved avatar: the colour you chose for its orb, if you did.
    var profile: JSONValue? = nil
    var selected = false

    var body: some View {
        RosterLine(name: row.name, line: row.line, needs: row.needs, standing: row.standing, selected: selected) {
            SeatFace(id: row.id, profile: profile, size: Metrics.rowFace, standing: row.standing, selected: selected)
        }
    }
}

/// A seat among the agents as a card, chosen on an iPad in place of the rows: the face large, its name, where it stands
/// in a word, and what it is doing in two lines (always as tall as two).
struct SeatCard<Face: View>: View {
    let name: String
    let line: String
    let needs: Bool
    let standing: Standing
    /// The seat the detail column shows: ringed in the ink.
    var selected = false
    @ViewBuilder let face: Face

    var body: some View {
        VStack(spacing: Space.s2) {
            // A little room under every face, so its name stands clear of it.
            face.padding(.bottom, Space.s2)
            Text(name).font(.headline).lineLimit(1)
            if let word = standing.shown {
                StateBadge(text: word, tone: standing.tone)
            } else {
                StateBadge(text: "Queued", tone: "neutral").hidden().accessibilityHidden(true)
            }
            // (An empty line reserves no room: a space does, so a card with nothing to say is as tall as the rest.)
            let said = standing.beside(line)
            Text(said.isEmpty ? " " : said)
                .font(.footnote)
                .foregroundStyle(needs ? Color.needs : .secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2, reservesSpace: true)
        }
        .padding(Space.s3)
        .frame(maxWidth: .infinity)
        .background(Color.raised, in: .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
        .overlay {
            if selected { RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).strokeBorder(Color.ink, lineWidth: 2) }
        }
        .contentShape(.rect(cornerRadius: Metrics.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Cards in as many columns as the list has room for, on the list's own ground rather than in a row of it.
private struct CardGrid<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.cardWidth), spacing: Space.s3, alignment: .top)], spacing: Space.s3) { content }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
    }
}

/// A face among the agents (the PWA's seat; 26 November 2026): its mark, still, as every mark in a row is ("i dont want
/// them to be too visually distractin"), in the room its ring took, so a row keeps its height. Where it stands is in its
/// mark's shape (the top slat in ink when it needs you, the bottom one red and loose when it failed, pale while queued,
/// grey while paused) and said beside it in a chip's words, never by a ring round its face.
struct SeatFace: View {
    /// An agent's handle, or `primary`.
    let id: String
    /// Its saved avatar: its mark.
    var profile: JSONValue? = nil
    let size: CGFloat
    let standing: Standing
    var selected = false

    var body: some View {
        let ring = size >= Metrics.cardFace ? Metrics.cardRing : Metrics.rowRing
        Group {
            if id == "primary" {
                // The primary itself is the I-beam.
                PrimaryOrb(size: size + 2 * ring, tone: Orb.Tone(standing))
            } else {
                AgentFace(id: id, profile: profile, size: size, mood: Orb.Mood(standing), still: true)
                    .padding(ring)
            }
        }
    }
}

extension Standing {
    /// As a badge takes it, in its ring's colour (lib/agent-state.ts' STATES).
    var tone: String {
        switch self {
        case .working: "work"
        case .needs: "needs"
        case .failed: "failed"
        case .verified, .unread: "ok"
        case .paused, .queued, .resting: "neutral"
        }
    }
}

/// The node is away, or won't take this device's requests: said plainly, with what to do.
/// While the node is a moment answering, the agents drawn is the one this device last saw (KeptTable): said in a
/// still line, so it is never taken for what the node says now.
struct KeptLine: View {
    let since: Date
    /// The node is being asked again (Session.asksAgain): not while it isn't this device's, when nothing is asked.
    var asking = true

    /// What it says: when the node last said it, and that it is asked again, where it is.
    nonisolated static func words(_ ago: String, asking: Bool) -> String {
        asking ? "As your node last said it, \(ago). Asking it again." : "As your node last said it, \(ago)."
    }

    var body: some View {
        // (Said again each minute, so how long ago stays true while the node is away.)
        TimelineView(.everyMinute) { moment in
            Label {
                Text(Self.words(ago(moment.date), asking: asking))
            } icon: {
                Image(systemName: "clock.arrow.circlepath")
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private func ago(_ now: Date) -> String {
        guard now.timeIntervalSince(since) >= 60 else { return "just now" }
        let words = RelativeDateTimeFormatter()
        words.unitsStyle = .full
        return words.localizedString(for: since, relativeTo: now)
    }
}

struct TroubleRow: View {
    let trouble: NodeError

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: trouble.unreachable ? "wifi.exclamationmark" : "lock.trianglebadge.exclamationmark").foregroundStyle(Color.danger)
        }
    }

    /// It names nothing of this device's: the node at its address isn't the one this device paired with (NodePin).
    private var notYours: Bool { trouble.notYourNode != nil }

    private var skew: TimeInterval? {
        trouble.serverTime.map { $0.timeIntervalSinceNow }.flatMap { abs($0) > 60 ? $0 : nil }
    }

    private var title: String {
        if notYours { return "This isn't the node this device paired with" }
        if trouble.unreachable { return "No connection to your node" }
        if skew != nil { return "This device's clock is off" }
        return trouble.status == 401 ? "The node doesn't accept this device" : "The node refused"
    }

    private var detail: String {
        if notYours { return "\(trouble.message) Nothing more is sent to it. If you set your node up anew at this address, forget this device in Settings, then pair it again." }
        if trouble.unreachable { return "\(trouble.message) On a phone, open the Tailscale app and check it says Connected." }
        if let skew { return "It is \(Int((abs(skew) / 60).rounded())) minutes from the node's. Set the date and time to set themselves, in Settings." }
        return trouble.status == 401 ? "It may have been removed from the fleet. Forget this device in Settings, then pair it again." : trouble.message
    }
}
