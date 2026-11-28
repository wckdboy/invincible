import SwiftUI

#if os(iOS)
/// Pairing until this device is in the fleet; the app itself after.
struct RootView: View {
    let app: AppModel

    var body: some View {
        let _ = PerfProbe.shared.mark("root body")
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
/// window), your agent's chat with the drawer beside it; on an iPad, the drawer as a sidebar and its choice beside it.
struct MainView: View {
    let app: AppModel
    let session: Session
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var width

    var body: some View {
        let _ = PerfProbe.shared.mark("main body")
        Group {
            if width == .compact {
                PhoneRoot(app: app, session: session)
            } else {
                SplitPlaces(app: app, session: session)
            }
        }
        // An invincible: link (a task, an agent, an approval, a chat): opened over Home, as a notification is.
        .onOpenURL { url in if let destination = Push.link(url) { PushCenter.shared.opened = destination } }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            // Back in the app: the chat on screen as the node holds it now (an answer it was watching may have gone on).
            await session.chat.resume(with: session.client)
            // Notifications: Apple's token handed over again (it changes), what was answered elsewhere taken down here.
            Task { await PushCenter.shared.renew(session) }
            // Tasks' Live Activities kept up from here while a window is in front (the node does it otherwise).
            async let activities: Void = LiveActivities.shared.keepUp(session)
            await app.keepFresh(session)
            await activities
        }
    }
}

/// An iPhone's app (the owner's word of 28 November 2026: "make it as simple as the grokbot app or t3code ios app"): one
/// screen, your agent's chat, and the drawer beside it (Drawer.swift: New chat, Needs you, your agents, your chats by day,
/// Settings). What the drawer opens is pushed over the chat, and the screen's left edge goes back from it: an agent's or a
/// room's chat, Needs you, Settings; a task from a card. A notification you tap, or a link, opens where it leads.
struct PhoneRoot: View {
    let app: AppModel
    let session: Session
    @State private var path: [Place] = []
    @State private var drawer = false

    var body: some View {
        DrawerHost(open: $drawer, session: session, current: Self.current(path, chat: session.chat.conversation), pick: pick) {
            NavigationStack(path: $path) {
                ChatView(session: session, roster: { withAnimation(.spring(response: 0.32, dampingFraction: 0.9)) { drawer = true } }, forget: { try app.forget() })
                    .navigationDestination(for: Place.self) { place in destination(place) }
            }
        }
        .environment(\.showInbox) { path = [.inbox] }
        .environment(\.showPrimary) { path = [] }
        .environment(\.openPlace) { go($0) }
        .task(id: PushCenter.shared.opened) { await follow() }
        .onChange(of: path, initial: true) { PushCenter.shared.showing = Self.showing(path, chat: session.chat.conversation) }
        .onChange(of: session.chat.conversation) { PushCenter.shared.showing = Self.showing(path, chat: session.chat.conversation) }
    }

    /// A place, over your agent's chat (the chat itself, or one of the places the iPhone no longer has: back to it).
    private func go(_ place: Place) {
        switch place {
        case .primary, .home, .agents, .chats, .everything: path = []
        default: path.append(place)
        }
    }

    /// What the drawer chose: a chat on the chat's own screen, anything else over it.
    private func pick(_ choice: DrawerPick) {
        switch choice {
        case .newChat:
            if !session.chat.answering { session.chat.startNew() }
            path = []
        case .chat(let id):
            path = []
            Task { await session.chat.open(id, with: session.client) }
        case .needs: path = [.inbox]
        case .agent(let id): path = [.agent(id)]
        case .room(let id): path = [.room(id)]
        case .settings: path = [.more]
        }
    }

    @ViewBuilder private func destination(_ place: Place) -> some View {
        switch place {
        case .task(let id): TaskView(session: session, id: id)
        case .agent(let id): AgentView(session: session, id: id)
        case .room(let id): RoomView(session: session, id: id)
        case .inbox: InboxView(session: session)
        case .more, .thisMac: SettingsList(app: app, session: session)
        case .keys: KeysView(session: session)
        case .connectors: ConnectorsView(session: session)
        // (Places an iPhone no longer has, from an older link: the chat.)
        case .primary, .home, .agents, .chats, .everything: ChatView(session: session)
        }
    }

    /// A notification you tapped: its place over the chat, or the chat it names.
    private func follow() async {
        guard let opened = PushCenter.shared.opened else { return }
        PushCenter.shared.opened = nil
        drawer = false
        switch opened {
        case .inbox: path = [.inbox]
        case .settings: path = [.more]
        // The agents: the drawer, which lists them.
        case .overview:
            path = []
            drawer = true
        case .chat(let id):
            if let id { await session.chat.open(id, with: session.client) }
            path = []
        case .approval(let id):
            path = [.inbox]
            session.approvalToOpen = id
        case .task(let id): path = [.task(id)]
        case .agent(let id): path = [.agent(id)]
        case .ship(let id):
            path = [.task(id)]
            session.shipToOpen = id
        }
    }

    /// What the screen shows, as a notification would name it: the last place over the chat, or the chat itself.
    static func showing(_ path: [Place], chat: String?) -> Push.Destination? {
        (path.last ?? .primary).shown(chat: chat)
    }

    /// The drawer's row for what is on screen: the chat's own (or none, a new one), or the place over it.
    static func current(_ path: [Place], chat: String?) -> DrawerPick? {
        DrawerPick.of(path.last ?? .primary, chat: chat)
    }
}

/// An iPad's window (as T3 Code's on an iPad): the drawer as its sidebar, always there, and beside it what it chose, your
/// agent's chat first. Each window keeps its own place for the next launch, and the menus and their keys (PadCommands) act
/// in the one in front.
struct SplitPlaces: View {
    let app: AppModel
    let session: Session
    /// The place this window shows, kept with the window.
    @SceneStorage("place") private var kept = ""
    @State private var composerWanted = false

    private var place: Place {
        get {
            switch (try? JSONDecoder().decode(Place.self, from: Data(kept.utf8))) ?? .primary {
            // (Places an iPad no longer has, kept by an older window: the chat.)
            case .home, .agents, .chats, .everything: .primary
            case let place: place
            }
        }
        nonmutating set { kept = (try? JSONEncoder().encode(newValue)).map { String(decoding: $0, as: UTF8.self) } ?? "" }
    }

    var body: some View {
        NavigationSplitView {
            Drawer(session: session, current: DrawerPick.of(place, chat: session.chat.conversation), pick: pick)
                .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 380)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if session.reconnecting {
                        ReconnectingLine(session: session).padding(.horizontal, Space.s3).background(.bar)
                    } else if let trouble = session.trouble {
                        TroubleRow(trouble: trouble).font(.callout).padding(Space.s3).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
                    }
                }
        } detail: {
            NavigationStack { detail }
                // Each place starts at its own root.
                .id(place)
                .environment(\.composerWanted, $composerWanted)
                // An agent's workspace (its computer's, beside its chat) in a column of its own.
                .workspaceColumn(session: session, seat: place.workspaceSeat(session))
        }
        .environment(\.showInbox) { place = .inbox }
        .environment(\.openPlace) { place = $0 }
        .focusedSceneValue(\.placeActions, PlaceActions(newChat: newChat))
        .task(id: PushCenter.shared.opened) { await follow() }
    }

    @ViewBuilder private var detail: some View {
        switch place {
        case .task(let id): TaskView(session: session, id: id, wide: true)
        case .agent(let id): AgentView(session: session, id: id)
        case .room(let id): RoomView(session: session, id: id)
        case .inbox: InboxView(session: session)
        case .more, .thisMac: SettingsList(app: app, session: session)
        case .keys: KeysView(session: session)
        case .connectors: ConnectorsView(session: session)
        case .primary, .home, .agents, .chats, .everything: ChatView(session: session, forget: { try app.forget() })
        }
    }

    /// What the sidebar chose: a chat on the chat's own place, anything else in its place.
    private func pick(_ choice: DrawerPick) {
        switch choice {
        case .newChat: newChat?()
        case .chat(let id):
            place = .primary
            Task { await session.chat.open(id, with: session.client) }
        case .needs: place = .inbox
        case .agent(let id): place = .agent(id)
        case .room(let id): place = .room(id)
        case .settings: place = .more
        }
    }

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
        // The agents: the sidebar lists them, beside your agent's chat.
        case .overview: place = .primary
        case .chat(let id):
            place = .primary
            if let id { await session.chat.open(id, with: session.client) }
        case .approval(let id):
            place = .inbox
            session.approvalToOpen = id
        case .task(let id): place = .task(id)
        case .agent(let id): place = .agent(id)
        case .ship(let id):
            place = .task(id)
            session.shipToOpen = id
        }
    }
}

/// What the menus and their keys act on: the window in front (an iPad's windows each have their own place).
struct PlaceActions {
    /// A new chat with the primary: none while it is answering.
    let newChat: (() -> Void)?
}

extension FocusedValues {
    @Entry var placeActions: PlaceActions?
}

/// The menus an iPad shows (its menu bar, and what holding ⌘ lists): a new chat and a new window, in the window in front.
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
        }
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
