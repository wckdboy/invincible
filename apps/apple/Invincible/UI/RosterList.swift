import SwiftUI

/*
 * The roster (the owner's word of 27 November 2026: "something like t3code on desktop, and openmausbot/grokbot on
 * mobile"; the web's views/sidebar.ts): an iPhone's drawer, an iPad's sidebar and a Mac's, the same list in each. What
 * needs you first, with its count, always there (so its count coming moves nothing); then your agent, with its line;
 * then each agent (its glass with its state's dot, its name, its latest line muted, red when its work failed) and each
 * room. At its foot, pinned under the list as it scrolls (the web's), the work, Settings, everything else, and the
 * machine it talks to. The place on screen is its row, marked: a task's is its agent's.
 */
struct RosterList<Foot: View>: View {
    let session: Session
    /// The place on screen (nil: none of its rows).
    let current: Place?
    /// Goes to a place.
    let go: (Place) -> Void
    /// What a device puts under the rest: an iPhone's notifications, asked for once.
    let foot: Foot
    @Environment(\.openWindow) private var openWindow
    /// Whether a place can open in a window of its own: a Mac's, an iPad's (an iPhone has one window).
    @Environment(\.supportsMultipleWindows) private var windows

    init(session: Session, current: Place?, go: @escaping (Place) -> Void, @ViewBuilder foot: () -> Foot) {
        self.session = session
        self.current = current
        self.go = go
        self.foot = foot()
    }

    var body: some View {
        List(selection: Binding<Place?>(get: { RosterList.marked(current, assignee: assignee) }, set: { if let place = $0 { go(place) } })) {
            Section {
                if let since = session.keptSince {
                    KeptLine(since: since, asking: session.asksAgain).listRowBackground(Color.clear).selectionDisabled()
                }
                RosterNeeds(count: session.needsYou)
                    .rosterRow()
                    .tag(Place.inbox)
                    .accessibilityIdentifier("roster.needs")
                RosterPerson(name: "Your agent", line: session.primary.line, failed: false) {
                    GuardianFace(size: Self.face, standing: session.primaryStanding)
                }
                .rosterRow()
                .tag(Place.primary)
                .accessibilityIdentifier("roster.primary")
            }
            if !session.rows.isEmpty {
                Section("Agents") {
                    ForEach(session.rows) { row in
                        RosterPerson(name: row.name, line: row.standing.beside(row.line), failed: row.standing == .failed) {
                            AgentFace(id: row.id, profile: session.drawn(row.id)?.avatar, size: Self.face, mood: Orb.Mood(row.standing))
                        }
                        .rosterRow()
                        .tag(Place.agent(row.id))
                        .accessibilityIdentifier("roster.agent.\(row.id)")
                    }
                }
            }
            let rooms = session.roomRows
            if !rooms.isEmpty {
                Section("Rooms") {
                    ForEach(rooms) { room in
                        RosterPerson(name: room.name, line: room.line, failed: false) {
                            Image(systemName: "number").font(.body.weight(.medium)).foregroundStyle(.secondary)
                        }
                        .rosterRow()
                        .tag(Place.room(room.id))
                        .accessibilityIdentifier("roster.room.\(room.id)")
                    }
                }
            }
            Section { foot }
        }
        .listStyle(.sidebar)
        // Its first row close under what heads it (a sidebar's list leaves a header's height above a section without one).
        .contentMargins(.top, Space.s1, for: .scrollContent)
        // The list ends at its foot's hairline, never faintly under it.
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        // Its foot, pinned under the list as it scrolls (the web's roster-foot): a hairline, the places, the machine; the
        // list fades under it as a bar's edge does.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            let marked = RosterList.marked(current, assignee: assignee)
            VStack(alignment: .leading, spacing: 0) {
                Divider()
                RosterPlace(title: "Work", symbol: "square.stack.3d.up", current: marked == .home) { go(.home) }
                    .accessibilityIdentifier("roster.work")
                    .padding(.top, Space.s1)
                RosterPlace(title: "Settings", symbol: "gearshape", current: marked == .more) { go(.more) }
                    .accessibilityIdentifier("roster.settings")
                RosterPlace(title: "Everything else", symbol: "ellipsis.circle", current: marked == .everything) { go(.everything) }
                    .accessibilityIdentifier("roster.everything")
                MachineChip(session: session) { go(.more) }
                    .padding(.horizontal, Space.s2)
                    .padding(.vertical, Space.s2)
            }
            .padding(.horizontal, Space.s2)
        }
        // A chat, an agent or a room in a window of its own, where there are windows (an iPad's, a Mac's).
        .contextMenu(forSelectionType: Place.self) { places in
            if windows, let place = places.first, places.count == 1, let window = place.window(chat: session.chat.conversation) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") { openWindow(value: window) }
            }
        }
        // An agent's or a room's coming or going, as an animation of the list, never a jump.
        .animation(.snappy, value: session.rows.map(\.id) + session.roomRows.map(\.id))
        // (A container by that name, its rows their own: an identifier on a view that is no element of its own goes to
        // every element in it, its pinned foot's places too.)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roster")
    }

    /// The faces' size: an agent's glass, your agent's tile, a room's mark in the same box.
    static var face: CGFloat { 28 }

    /// Who has a task in hand (nil: a task not known here).
    private func assignee(_ task: String) -> String? { session.task(task)?.assignee }

    /// The row a place marks: its own, a task's agent's (your agent's own, for one of its tasks), and Everything else for
    /// the places it lists. Nil: none (a Mac's own places, its foot's).
    static func marked(_ place: Place?, assignee: (String) -> String?) -> Place? {
        switch place {
        case .task(let id): assignee(id).map(Place.seat)
        case .agents, .chats, .keys, .connectors: .everything
        case .thisMac: nil
        default: place
        }
    }
}

extension RosterList where Foot == EmptyView {
    init(session: Session, current: Place?, go: @escaping (Place) -> Void) {
        self.init(session: session, current: current, go: go) { EmptyView() }
    }
}

extension View {
    /// A row of the roster: no hairline between rows (the web's), and the room a row needs, no more.
    fileprivate func rosterRow() -> some View {
        listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: Space.line, leading: Space.s3, bottom: Space.line, trailing: Space.s3))
    }
}

/// What needs you, first and always there: its count in an ink badge while there is some, nothing beside it otherwise.
private struct RosterNeeds: View {
    let count: Int

    var body: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "tray")
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: RosterList<EmptyView>.face)
            Text("Needs you").font(.body.weight(.semibold)).lineLimit(1)
            Spacer(minLength: Space.s2)
            if count > 0 {
                Text("\(count)")
                    .font(.footnote.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Color.onAccent)
                    .padding(.horizontal, 7)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(Color.ink, in: .capsule)
            }
        }
        .frame(minHeight: Metrics.touch)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(count > 0 ? "Needs you: \(count)" : "Needs you: nothing")
    }
}

/// Someone in the roster, or a room: a face, a name, and its latest line under it, muted (red when its work failed).
private struct RosterPerson<Face: View>: View {
    let name: String
    let line: String
    let failed: Bool
    @ViewBuilder let face: Face
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Space.s3) {
            face.frame(width: RosterList<EmptyView>.face, height: RosterList<EmptyView>.face)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.body.weight(.semibold)).lineLimit(1)
                // Always a line high, so a row keeps its height as its line comes and goes.
                Text(line.isEmpty ? " " : line)
                    .font(.subheadline)
                    .foregroundStyle(failed ? AnyShapeStyle(Color.failed) : AnyShapeStyle(.secondary))
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            }
        }
        .padding(.vertical, Space.line)
        .help(line.isEmpty ? name : "\(name): \(line)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel(line.isEmpty ? name : "\(name): \(line)")
    }
}

/// One of the places at its foot: a glyph in the faces' column, and its name, quieter than the rows above (the web's);
/// the place on screen on a ground of its own, as a row of the list is marked.
private struct RosterPlace: View {
    let title: String
    let symbol: String
    let current: Bool
    let go: () -> Void

    var body: some View {
        Button(action: go) {
            HStack(spacing: Space.s3) {
                Image(systemName: symbol)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: RosterList<EmptyView>.face)
                Text(title).foregroundStyle(current ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s2)
            .frame(minHeight: Metrics.touch)
            .background(current ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 10, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

/// Your agent's mark with its state's dot, cut out of it as an agent's glass has its own (the web's guardianMark).
struct GuardianFace: View {
    let size: CGFloat
    let standing: Standing
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GlassCut(size: size, state: AgentGlass.state(MarkState(Orb.Mood(standing))), theme: scheme == .dark ? .dark : .light) {
            GuardianMark(size: size)
        }
    }
}
