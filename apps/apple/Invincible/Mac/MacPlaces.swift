#if os(macOS)
import SwiftUI

/// The main window once this Mac is paired: Home, the primary and the work in a sidebar (Places.swift), This Mac at its foot,
/// and the place chosen beside it (a task's thread with its details beside it); a chat, an agent or a room also opens in a
/// window of its own.
struct MacPlaces: View {
    @Bindable var mac: MacApp
    let session: Session
    @State private var givingNext = false

    var body: some View {
        NavigationSplitView {
            PlacesSidebar(place: $mac.place, session: session) { ThisMacFoot(mac: mac) }
                .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 380)
        } detail: {
            NavigationStack { detail }
                // Each place starts at its own root.
                .id(mac.place)
                .environment(\.composerWanted, $mac.composerWanted)
                // An agent's workspace (its computer's, beside its chat) in a column of its own.
                .workspaceColumn(session: session, seat: mac.place.workspaceSeat(session))
        }
        .sheet(isPresented: $mac.giving) { GiveSheet(session: session) }
        .sheet(isPresented: $mac.searching, onDismiss: {
            // A task chosen in the palette is given once the palette has gone.
            if givingNext { givingNext = false; mac.giving = true }
        }) {
            CommandPalette(session: session, go: { mac.place = $0 }, give: mayGive ? { givingNext = true } : nil)
        }
        .environment(\.showInbox) { mac.place = .inbox }
        .environment(\.openPlace) { mac.place = $0 }
        .environment(\.openSearch) { mac.searching = true }
        .task { await session.refresh() }
    }

    @ViewBuilder private var detail: some View {
        switch mac.place {
        case .home: HomeView(session: session, go: { mac.place = $0 }, give: mayGive ? { mac.giving = true } : nil)
        case .task(let id): TaskView(session: session, id: id, wide: true)
        case .primary: ChatView(session: session)
        case .agents: AgentsView(session: session, selection: board) { mac.place = Place($0) }
        case .agent(let id): AgentView(session: session, id: id)
        case .room(let id): RoomView(session: session, id: id)
        case .inbox: InboxView(session: session)
        case .more: MoreView(app: mac.app, session: session)
        case .thisMac: GroupedList { ThisMacSections(mac: mac) }.navigationTitle("This Mac")
        case .chats: AllChats(session: session) { mac.place = .primary }
        case .keys: KeysView(session: session)
        case .connectors: ConnectorsView(session: session)
        }
    }

    /// The agents are given a task from a Mac that may, with agents to take it, once the node has answered.
    private var mayGive: Bool { session.can("fleet:admin") && session.can("chat") && session.team != nil && !session.rows.isEmpty }

    /// The board's rows lead to their pages in this window: chosen there, they are chosen in the sidebar.
    private var board: Binding<Route?> {
        Binding(get: { nil }, set: { route in if let route { mac.place = Place(route) } })
    }
}
#endif
