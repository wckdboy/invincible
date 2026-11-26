import SwiftUI

/*
 * The wide window's places, a Mac's and an iPad's alike (docs/MAC.md), as T3 Code's three panes (your words, 26 November
 * 2026: "agent first (the primary), and project/tasks/coding t3code style for the agents"; the PWA's views/sidebar.ts): a
 * sidebar with Home and the primary pinned, its orb and what it is doing, then the work in one list by attention, every task a
 * row of three lines: what needs you (with what else waits in the Inbox), what is new to you, what is at work (folded),
 * what is settled (folded); at its foot the agents (the agents), the machine, and everything else. Beside it the
 * place chosen: Home, its conversation, a task's thread with its details beside it, the agents, an agent's or a room's
 * page, the Inbox, Settings. A chat, an agent or a room also opens in a window of its own.
 */

/// What the wide window shows (and what an iPhone pushes over Home): Home, the primary's chat, a task's thread, the
/// team, an agent's or a room's page, the Inbox, Settings (More), and on a Mac, This Mac (its node).
enum Place: Hashable, Codable {
    case home, primary, agents, inbox, more, thisMac
    /// Every one of the primary's chats, your keys, your connectors: the drawer's (an iPhone's), each a place of its own.
    case chats, keys, connectors
    case agent(String)
    case room(String)
    case task(String)

    init(_ route: Route) {
        switch route {
        case .primary: self = .primary
        case .agent(let id): self = .agent(id)
        case .room(let id): self = .room(id)
        }
    }

    /// A seat among the agents: the primary's chat, or an agent's page.
    static func seat(_ id: String) -> Place { id == "primary" ? .primary : .agent(id) }
}

/// What a window of its own shows: one of the primary's chats (by its id on the node), an agent's page, or a room's. Kept by
/// the system with the window, so it opens again where it was.
enum PlaceWindow: Hashable, Codable {
    case chat(String)
    case agent(String)
    case room(String)
}

/// The places, in a sidebar: Home and the primary, then the work by attention. Its foot is the window's to give as well: This
/// Mac, on a Mac.
struct PlacesSidebar<Foot: View>: View {
    @Binding var place: Place
    let session: Session
    /// What stands at its foot, under the agents and the machine: This Mac, on a Mac.
    let foot: Foot
    @Environment(\.openWindow) private var openWindow
    /// Whether a place can open in a window of its own: a Mac's, an iPad's (an iPhone has one window).
    @Environment(\.supportsMultipleWindows) private var windows
    /// The folded sections, as this device last left them.
    @AppStorage("sidebar.working") private var workingShown = false
    @AppStorage("sidebar.done") private var doneShown = false
    @State private var giving = false
    @Environment(\.openSearch) private var openSearch

    init(place: Binding<Place>, session: Session, @ViewBuilder foot: () -> Foot) {
        _place = place
        self.session = session
        self.foot = foot()
    }

    private var mayGive: Bool { session.can("fleet:admin") && session.can("chat") && session.team != nil && !session.rows.isEmpty }

    var body: some View {
        let work = session.attended
        // What needs you, one count everywhere (Session.needsYou): the rows that need you, and what waits in the Inbox beyond them.
        let beyond = work.map { session.needsBeyond($0) } ?? session.needsYou
        List(selection: Binding<Place?>(get: { place }, set: { if let chosen = $0 { place = chosen } })) {
            // The head: the app's mark and its wordmark, as the web's sidebar and Android's begin.
            Section {
                HStack(spacing: 9) {
                    AppMark(size: 20)
                    Wordmark()
                }
                .accessibilityElement(children: .combine)
                .listRowBackground(Color.clear)
            }
            if let openSearch {
                Section {
                    Button(action: openSearch) {
                        HStack(spacing: Space.s2) {
                            Image(systemName: "magnifyingglass")
                            Text("Search, or ask")
                            Spacer(minLength: Space.s2)
                            Text("⌘K").font(.footnote.monospaced()).foregroundStyle(.tertiary)
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, Space.s3)
                        .frame(minHeight: 36)
                        .background(.fill.quaternary, in: .rect(cornerRadius: 10, style: .continuous))
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: Space.s1, leading: Space.s2, bottom: Space.s1, trailing: Space.s2))
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("Search, or ask \(Primary.name)")
                    .accessibilityHint("Command K")
                }
            }
            Section {
                Label("Home", systemImage: "house").tag(Place.home)
                PrimaryPin(session: session, still: [Place.home, .primary, .agents].contains(place) || { if case .task = place { true } else { false } }())
                    .tag(Place.primary)
                #if os(macOS)
                BuildRow()
                #endif
            }
            if let work {
                // (The rows that need you, and each thing that waits in the Inbox beyond them: Home's count, whole.)
                let needs = session.needsYou
                if needs > 0 {
                    Section {
                        if beyond > 0 {
                            HStack {
                                Label("Inbox", systemImage: "tray")
                                Spacer(minLength: Space.s2)
                                Text("\(beyond) waiting").font(.subheadline.weight(.semibold)).foregroundStyle(Color.needs).monospacedDigit()
                            }
                            .tag(Place.inbox)
                        }
                        rows(work.needs)
                    } header: {
                        Text("Needs you · \(needs)").foregroundStyle(Color.needs).monospacedDigit()
                    }
                }
                if !work.active.isEmpty {
                    Section("Active") { rows(work.active) }
                }
                if !work.working.isEmpty {
                    Section(isExpanded: $workingShown) {
                        rows(work.working)
                    } header: {
                        Text("Working \(work.working.count)").monospacedDigit()
                    }
                }
                if !work.done.isEmpty {
                    Section(isExpanded: $doneShown) {
                        rows(work.done)
                    } header: {
                        Text("Done \(work.done.count)").monospacedDigit()
                    }
                }
                if work.byAttention.isEmpty {
                    Section {
                        Text("No tasks yet. Each task you or \(Primary.name) give an agent is a row here: what needs you first, then what is new, at work, and done.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        if mayGive { Button("Give a task") { giving = true } }
                    }
                }
            } else if let problem = session.teamProblem {
                Section {
                    Text("The work can't be read just now: \(problem)").font(.footnote).foregroundStyle(.secondary)
                    Button("Try again") { Task { await session.refresh() } }
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .listStyle(.sidebar)
        // A task's state moving it from one section to another, as an animation of the list, never a jump.
        .animation(.snappy, value: work.map { $0.byAttention.map(\.id) } ?? [])
        #if os(macOS)
        .contextMenu(forSelectionType: Place.self) { places in
            if let place = places.first, places.count == 1, windows, let window = window(for: place) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") { openWindow(value: window) }
            }
        } primaryAction: { places in
            // A double click opens it in a window of its own.
            if let place = places.first, let window = window(for: place) { openWindow(value: window) }
        }
        #else
        .contextMenu(forSelectionType: Place.self) { places in
            if let place = places.first, places.count == 1, windows, let window = window(for: place) {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") { openWindow(value: window) }
            }
        }
        #endif
        .toolbar {
            if mayGive {
                ToolbarItem(placement: .primaryAction) {
                    Button { giving = true } label: { Label("Give a task", systemImage: "square.and.pencil") }
                        .help("Give a task to the agent best suited to it, or to one by name")
                }
            }
        }
        .sheet(isPresented: $giving) { GiveSheet(session: session) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let trouble = session.trouble {
                    TroubleRow(trouble: trouble)
                        .font(.callout)
                        .padding(Space.s3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let since = session.keptSince {
                    KeptLine(since: since)
                        .padding(Space.s3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // What the model calls came to, against your budget.
                if session.usage != nil {
                    UsageMeterView(session: session)
                        .padding(.horizontal, Space.s4)
                        .padding(.vertical, Space.s2)
                }
                HStack(spacing: Space.s2) {
                    Button { place = .agents } label: {
                        Label(session.rows.isEmpty ? "Agents" : "Agents \(session.rows.count)", systemImage: "person.3")
                            .font(.footnote.weight(.medium))
                            .monospacedDigit()
                            .padding(.horizontal, Space.s2)
                            .frame(minHeight: 28)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.capsule)
                    .help("The agents: your agents and their rooms")
                    MachineChip(session: session) { place = .more }
                    Spacer(minLength: 0)
                    PlacesMenu(session: session, go: { place = $0 }, give: mayGive ? { giving = true } : nil)
                }
                .padding(.horizontal, Space.s3)
                .padding(.vertical, Space.s2)
                foot
            }
            .background(.bar)
        }
    }

    /// Rows of the work, each its task's thread.
    private func rows(_ rows: [WorkRow]) -> some View {
        ForEach(rows) { row in
            WorkRowView(row: row, face: 16, current: place == .task(row.id), dense: true)
                .tag(Place.task(row.id))
                .listRowInsets(EdgeInsets(top: Space.s2, leading: Space.s3, bottom: Space.s2, trailing: Space.s3))
        }
    }

    /// The window of its own a place opens in: the primary's chat on screen (once it is kept), an agent's page, a room's.
    private func window(for place: Place) -> PlaceWindow? {
        switch place {
        case .primary: session.chat.conversation.map(PlaceWindow.chat)
        case .agent(let id): .agent(id)
        case .room(let id): .room(id)
        case .home, .agents, .inbox, .more, .thisMac, .task, .chats, .keys, .connectors: nil
        }
    }
}

/// The primary's row, pinned: its orb, its name and what it is doing, in its state's colour. Its orb moves as it does, but is
/// still beside a page with an orb of its own in focus (Home's, its conversation's, a task's agent's, the team's).
struct PrimaryPin: View {
    let session: Session
    var still = false
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        let selected = prominence == .increased
        HStack(spacing: Space.s2) {
            PrimaryOrb(size: 34, tone: session.primaryTone, mood: still ? nil : session.primaryMood, key: "primary:side")
            VStack(alignment: .leading, spacing: 1) {
                Text(Primary.name).font(.headline)
                Text(session.primary.line)
                    .font(.footnote)
                    .foregroundStyle(selected ? AnyShapeStyle(.secondary) : AnyShapeStyle(tone))
                    .lineLimit(1)
            }
        }
        .padding(.vertical, Space.s1)
        .help("\(Primary.name): \(session.primary.line)")
        .accessibilityElement(children: .combine)
    }

    private var tone: Color {
        switch session.primaryTone {
        case .warn: .needs
        case .accent: .working
        case .ok: .done
        case .danger: .failed
        case .neutral: .secondary
        }
    }
}

extension Metrics {
    /// A face in a seat's row of the menu bar's team: smaller than a row's on an iPhone.
    static let sidebarFace: CGFloat = 32
    /// The column the sidebar's faces stand in, ring and all, so every name starts at one edge.
    static let sidebarSeat = sidebarFace + 2 * rowRing
}

/// A seat as the menu bar's team lists it (a Mac's): its face in the ring of where it stands (the one who leads with its mark on the ring's foot), its
/// name and its state in a word, and what it is doing in a line, in the primary's red when only you can move it on. Smaller
/// than an iPhone's row, as a sidebar is; on the row a focused sidebar shows selected, it is all in the selection's white,
/// its line's red too (the chip still says it needs you).
struct SidebarSeat: View {
    /// An agent's handle, or `primary`.
    let id: String
    /// Its saved avatar: the colour you chose for its orb, if you did.
    var profile: JSONValue? = nil
    let name: String
    let line: String
    let needs: Bool
    let standing: Standing
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        let selected = prominence == .increased
        HStack(spacing: Space.s2) {
            SeatFace(id: id, profile: profile, size: Metrics.sidebarFace, standing: standing, selected: selected)
                .frame(width: Metrics.sidebarSeat, height: Metrics.sidebarSeat)
            VStack(alignment: .leading, spacing: Space.line) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
                    Text(name).font(.headline).lineLimit(1)
                    Spacer(minLength: 0)
                    if let word = standing.word {
                        StateBadge(text: word, tone: standing.tone, selected: selected).fixedSize()
                    }
                }
                // Beside its chip, the line doesn't say the chip's word again; always a line high, so rows keep their height.
                let said = standing.beside(line)
                Text(said.isEmpty ? " " : said)
                    .font(.subheadline)
                    .foregroundStyle(needs && !selected ? AnyShapeStyle(Color.needs) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
        }
        .padding(.vertical, Space.s1)
        // Its whole line, where the sidebar cut it short.
        .help(line)
        .accessibilityElement(children: .combine)
    }
}

/// A window of its own: a chat, an agent or a room, its pages pushed in it.
struct PlaceWindowView: View {
    let session: Session
    let window: PlaceWindow

    var body: some View {
        NavigationStack {
            switch window {
            case .chat(let id): ChatWindow(session: session, id: id)
            case .agent(let id): AgentView(session: session, id: id)
            case .room(let id): RoomView(session: session, id: id)
            }
        }
        .workspaceColumn(session: session, seat: seat)
    }

    /// The workspace a window's page can show beside it: an agent's, or its computer's beside a chat of the primary's.
    private var seat: WorkspaceSeat? {
        switch window {
        case .chat: WorkspaceSeat(id: "primary", name: Primary.name)
        case .agent(let id): WorkspaceSeat(id: id, name: session.agent(id)?.name ?? id)
        case .room: nil
        }
    }
}

/// One of the primary's chats in a window of its own: its own conversation, beside the one in the main window.
private struct ChatWindow: View {
    let session: Session
    let id: String
    @State private var chat = ChatModel()
    @State private var opened = false

    var body: some View {
        Group {
            if opened { ChatView(session: session, chat: chat) } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .task {
            await chat.open(id, with: session.client)
            opened = true
            // It may be answering in it for another device: looked at again as the node says its turns changed.
            let stop = session.follow(["turns"], every: 5_000, gap: 1_000) { await chat.noticed(chats: nil, turns: session.turns, with: session.client) }
            await Session.held()
            stop()
        }
    }
}

#if os(macOS)
/// The Build window, from the sidebar: a workbench with the primary (docs/BUILD.md), in a window of its own.
private struct BuildRow: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button {
            openWindow(id: MacApp.build)
        } label: {
            Label("Build", systemImage: "hammer")
        }
        .buttonStyle(.plain)
        .help("Build with \(Primary.name) (⇧⌘B)")
    }
}
#endif
