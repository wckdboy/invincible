import SwiftUI

#if os(iOS)
/// Pairing until this device is in the fleet; the app itself after.
struct RootView: View {
    let app: AppModel

    var body: some View {
        Group {
            switch app.phase {
            case .loading:
                ProgressView()
            case .unpaired:
                JoinView(app: app)
            case .paired(let session):
                MainView(app: app, session: session)
            case .broken(let why):
                KeyUnreadable(why: why) { app.start() }
            }
        }
        .tint(.ink)
        .background(WindowTint())
        .background(ClosesKeyboard())
        // What the performance suite reads, when it launched the app to measure it (nothing otherwise).
        .overlay(alignment: .topLeading) { PerfProbeMark() }
        .task { app.start() }
    }
}

/// Gives the window it is in the ink as its tint. The root's .tint reaches what SwiftUI draws, but a sheet's rows are
/// first drawn with the window's own, which stayed system blue whatever the asset catalog's accent (iOS 26.1).
private struct WindowTint: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Probe() }
    func updateUIView(_ view: UIView, context: Context) {}

    final class Probe: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            window?.tintColor = UIColor(named: "AccentColor")
        }
    }
}

/// The paired app, asked again every few seconds while a window of it is in front. On an iPhone (and an iPad's narrow
/// window), Home with everything else pushed over it; on an iPad, a Mac's window: the work in a sidebar and the place
/// chosen beside it.
struct MainView: View {
    let app: AppModel
    let session: Session
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var width

    var body: some View {
        Group {
            if width == .compact {
                PhoneRoot(app: app, session: session)
            } else {
                SplitPlaces(app: app, session: session)
            }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            // Back in the app: the chat on screen as the node holds it now (an answer it was watching may have gone on).
            await session.chat.resume(with: session.client)
            // Notifications: Apple's token handed over again (it changes), what was answered elsewhere taken down here.
            Task { await PushCenter.shared.renew(session) }
            await app.keepFresh(session)
        }
    }
}

/// An iPhone's app (your words, 26 November 2026: "no tab bar, and Home is the primary"; "a '…' sheet for everything else"):
/// Home, and over it, as Messages shows a conversation, its conversation, a task's thread, the agents, an agent's or a
/// room's page, the Inbox or Settings. Everything the tabs held is a tap from Home: its header opens its conversation, "…"
/// holds the agents, the Inbox and Settings, and a notification you tap opens where it leads, over Home.
struct PhoneRoot: View {
    let app: AppModel
    let session: Session
    @State private var path: [Place] = []
    @State private var everything = false
    @State private var giving = false

    /// The agents are given a task from a device that may, with agents to take it, once the node has answered.
    private var mayGive: Bool { session.can("fleet:admin") && session.can("chat") && session.team != nil && !session.rows.isEmpty }

    var body: some View {
        NavigationStack(path: $path) {
            HomeView(session: session, go: go, everything: { everything = true }, give: mayGive ? { giving = true } : nil)
                .navigationDestination(for: Place.self) { place in destination(place) }
        }
        .sheet(isPresented: $everything) {
            EverythingSheet(session: session, give: mayGive ? { everything = false; giving = true } : nil) { place in
                everything = false
                go(place)
            }
        }
        .sheet(isPresented: $giving) { GiveSheet(session: session) }
        .environment(\.showInbox) { go(.inbox) }
        .environment(\.showPrimary) { go(.primary) }
        .task(id: PushCenter.shared.opened) { await follow() }
    }

    /// A place, over Home (Home itself: back to it).
    private func go(_ place: Place) {
        if place == .home { path = [] } else { path.append(place) }
    }

    @ViewBuilder private func destination(_ place: Place) -> some View {
        switch place {
        case .home: HomeView(session: session, go: go)
        case .primary: ChatView(session: session)
        case .task(let id): TaskView(session: session, id: id)
        case .agents: AgentsView(session: session) { path.append(Place($0)) }
        case .agent(let id): AgentView(session: session, id: id)
        case .room(let id): RoomView(session: session, id: id)
        case .inbox: InboxView(session: session)
        case .more, .thisMac: MoreView(app: app, session: session)
        }
    }

    /// A notification you tapped: where it leads, over Home.
    private func follow() async {
        guard let opened = PushCenter.shared.opened else { return }
        PushCenter.shared.opened = nil
        switch opened {
        case .inbox: path = [.inbox]
        case .settings: path = [.more]
        case .overview: path = [.agents]
        case .chat(let id):
            if let id { await session.chat.open(id, with: session.client) }
            path = [.primary]
        case .approval(let id):
            path = [.inbox]
            session.approvalToOpen = id
        }
    }
}

/// An iPad's window, as a Mac's: the places in a sidebar (Places.swift) and the place chosen beside them. Each window
/// keeps its own place for the next launch, and the menus and their keys (PadCommands) act in the one in front.
struct SplitPlaces: View {
    let app: AppModel
    let session: Session
    /// The place this window shows, kept with the window.
    @SceneStorage("place") private var kept = ""
    @State private var giving = false
    @State private var composerWanted = false
    /// Search, or ask (⌘K), and a task chosen there, given once the palette has gone.
    @State private var searching = false
    @State private var givingNext = false

    private var place: Place {
        get { (try? JSONDecoder().decode(Place.self, from: Data(kept.utf8))) ?? .home }
        nonmutating set { kept = (try? JSONEncoder().encode(newValue)).map { String(decoding: $0, as: UTF8.self) } ?? "" }
    }

    var body: some View {
        NavigationSplitView {
            PlacesSidebar(place: Binding(get: { place }, set: { place = $0 }), session: session) { EmptyView() }
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 400)
        } detail: {
            NavigationStack { detail }
                // Each place starts at its own root.
                .id(place)
                .environment(\.composerWanted, $composerWanted)
                // An agent's workspace (its computer's, beside its chat) in a column of its own.
                .workspaceColumn(session: session, seat: place.workspaceSeat(session))
        }
        .sheet(isPresented: $giving) { GiveSheet(session: session) }
        .sheet(isPresented: $searching, onDismiss: {
            if givingNext { givingNext = false; giving = true }
        }) {
            CommandPalette(session: session, go: { place = $0 }, give: mayGive ? { givingNext = true } : nil)
        }
        .environment(\.showInbox) { place = .inbox }
        .environment(\.openSearch) { searching = true }
        .focusedSceneValue(\.placeActions, PlaceActions(go: { place = $0 }, newChat: newChat, give: mayGive ? { giving = true } : nil, search: { searching = true }))
        .task(id: PushCenter.shared.opened) { await follow() }
    }

    @ViewBuilder private var detail: some View {
        switch place {
        case .home: HomeView(session: session, go: { place = $0 }, give: mayGive ? { giving = true } : nil)
        case .task(let id): TaskView(session: session, id: id, wide: true)
        case .primary: ChatView(session: session)
        case .agents: AgentsView(session: session, selection: board) { place = Place($0) }
        case .agent(let id): AgentView(session: session, id: id)
        case .room(let id): RoomView(session: session, id: id)
        case .inbox: InboxView(session: session)
        case .more, .thisMac: MoreView(app: app, session: session)
        }
    }

    /// The board's rows lead to their pages in this window: chosen there, they are chosen in the sidebar.
    private var board: Binding<Route?> {
        Binding(get: { nil }, set: { route in if let route { place = Place(route) } })
    }

    /// The agents are given a task from a device that may (as its board's own button asks), with agents to take it,
    /// once the node has answered (never from the agents this device kept).
    private var mayGive: Bool { session.can("fleet:admin") && session.team != nil && !session.rows.isEmpty }

    /// A new chat with the primary, its message box taking the keys; none while it is answering.
    private var newChat: (() -> Void)? {
        session.chat.answering ? nil : {
            place = .primary
            session.chat.startNew()
            composerWanted = true
        }
    }

    /// A notification you tapped: its place, and the primary's chat when it names one.
    private func follow() async {
        guard let opened = PushCenter.shared.opened else { return }
        PushCenter.shared.opened = nil
        switch opened {
        case .inbox: place = .inbox
        case .settings: place = .more
        case .overview: place = .agents
        case .chat(let id):
            place = .primary
            if let id { await session.chat.open(id, with: session.client) }
        case .approval(let id):
            place = .inbox
            session.approvalToOpen = id
        }
    }
}

/// What the menus and their keys act on: the window in front (an iPad's windows each have their own place).
struct PlaceActions {
    let go: (Place) -> Void
    /// A new chat with the primary: none while it is answering.
    let newChat: (() -> Void)?
    /// A task for the agents: none from a device that may not give one, or with no agent to take it.
    let give: (() -> Void)?
    /// Search, or ask (⌘K).
    var search: (() -> Void)? = nil
}

extension FocusedValues {
    @Entry var placeActions: PlaceActions?
}

/// The menus an iPad shows (its menu bar, and what holding ⌘ lists), as a Mac's: a new chat, a new window and a task for
/// the agents in File, Home and the four places in View, each acting in the window in front.
struct PadCommands: Commands {
    @FocusedValue(\.placeActions) private var actions
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Chat") { actions?.newChat?() }
                .keyboardShortcut("n")
                .disabled(actions?.newChat == nil)
            Button("New Window") { openWindow(id: InvincibleApp.main) }
                .keyboardShortcut("n", modifiers: [.command, .option])
            Button("Give the agents a Task…") { actions?.give?() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(actions?.give == nil)
            Button("Search or Ask…") { actions?.search?() }
                .keyboardShortcut("k")
                .disabled(actions?.search == nil)
        }
        CommandGroup(before: .sidebar) {
            place("Home", .home, "0")
            place(Primary.name, .primary, "1")
            place("Agents", .agents, "2")
            place("Inbox", .inbox, "3")
            place("More", .more, "4")
        }
    }

    private func place(_ name: String, _ place: Place, _ key: KeyEquivalent) -> some View {
        Button(name) { actions?.go(place) }
            .keyboardShortcut(key)
            .disabled(actions == nil)
    }
}

/// A window of its own on an iPad: a chat, an agent or a room (Places.swift), asked again every few seconds while it is
/// in front, as the main window is.
struct PlaceWindowRoot: View {
    let app: AppModel
    let window: PlaceWindow?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch app.phase {
            case .paired(let session):
                if let window {
                    PlaceWindowView(session: session, window: window)
                        .task(id: scenePhase == .active) {
                            guard scenePhase == .active else { return }
                            await app.keepFresh(session)
                        }
                }
            case .loading:
                ProgressView()
            case .unpaired, .broken:
                ContentUnavailableView("Not in a fleet", systemImage: "person.2.slash", description: Text("Join your fleet in Invincible's window first."))
            }
        }
        .tint(.ink)
        .background(WindowTint())
        .background(ClosesKeyboard())
        .task { app.start() }
    }
}

#endif

/// The Keychain couldn't be read: said as exactly that, never taken for "not paired", which would invite pairing over it.
struct KeyUnreadable: View {
    let why: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("This device's key can't be read", systemImage: "key.slash")
        } description: {
            Text(why)
        } actions: {
            Button("Try again", action: retry)
        }
    }
}

/// Where a row of the agents leads: the primary's chat, or an agent's page.
struct RouteView: View {
    let session: Session
    let route: Route

    var body: some View {
        switch route {
        case .primary: ChatView(session: session)
        case .agent(let id): AgentView(session: session, id: id)
        case .room(let id): RoomView(session: session, id: id)
        }
    }
}
