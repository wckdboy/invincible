#if os(iOS)
import SwiftUI

/*
 * Home, as a chat app's list (the owner's word of 28 November 2026: "use grok bot as the app look/UX. like a chat app,
 * with the primary at the top, the other agents, and a settings menu"): your agent pinned first, then the agents and the
 * rooms by their latest activity (Home.swift), each row its face with its state, its name, one line of what it is doing
 * or last did, when, and how much waits on you there. A tap opens that one's chat. Its bar: Settings (the gear), the
 * app's name, and + for a new chat or a new agent. Pulled down, a search that finds them and your chats by their words.
 * On an iPhone it is where the app opens, each chat pushed over it; on an iPad it is the sidebar.
 */

/// What Home opens.
enum HomePick: Hashable {
    case primary
    case agent(String)
    case room(String)
    /// One of your chats with your agent, found by search.
    case chat(String)

    /// Home's row for a place on screen (none for a place no row stands for).
    static func of(_ place: Place) -> HomePick? {
        switch place {
        case .primary: .primary
        case .agent(let id): .agent(id)
        case .room(let id): .room(id)
        default: nil
        }
    }
}

struct HomeList: View {
    let session: Session
    /// What is on screen beside it (an iPad's): its row is marked.
    var current: HomePick? = nil
    /// The link's trouble said over it, where it is the screen (an iPhone's): a node that proves to be another,
    /// reconnecting, what went wrong. An iPad's sidebar says them at its foot, and its chat the refusal.
    var saysLink = false
    /// Its own head where the system's bar was (an iPhone's): the bar's glass items, large title and search drawer over
    /// the moving list made every fling late (PerfTests.testScrollHome, 45 ms a second against 15). An iPad's sidebar keeps
    /// the system's, with its sidebar button.
    var ownHead = false
    let open: (HomePick) -> Void
    let settings: () -> Void
    let newChat: () -> Void
    @State private var query = ""
    @State private var history = ChatHistory()
    @State private var creating = false
    @State private var push = PushCenter.shared

    /// A face's size in its row.
    static let face: CGFloat = 44

    var body: some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let rows = Home.filter(rows, query: query)
        let chats = searching ? Chats.filter(history.chats ?? [], query: query) : []
        container {
            if ownHead {
                // Its search, at the top of the list, scrolling away with it.
                HomeSearchField(text: $query)
                    .padding(EdgeInsets(top: Space.s1, leading: Metrics.margin, bottom: Space.s2, trailing: Metrics.margin))
            }
            ForEach(rows) { row in
                rowButton(row)
            }
            if searching && !chats.isEmpty {
                Section {
                    ForEach(chats) { chat in
                        mark(.chat(chat.id)) { HomeChatRow(chat: chat) }
                            .accessibilityIdentifier("home.chat.\(chat.id)")
                    }
                } header: {
                    Text("Chats").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(nil)
                        .padding(ownHead ? EdgeInsets(top: Space.s4, leading: Metrics.margin, bottom: Space.s1, trailing: Metrics.margin) : EdgeInsets())
                }
            } else if searching && rows.isEmpty && history.chats != nil {
                Text("Nothing says “\(query)”.").font(.subheadline).foregroundStyle(.secondary).listRowSeparator(.hidden)
                    .padding(ownHead ? EdgeInsets(top: Space.s2, leading: Metrics.margin, bottom: Space.s2, trailing: Metrics.margin) : EdgeInsets())
            }
            if !searching && (push.reach == .turnOn || push.reach == .settings) {
                notificationsOff.listRowSeparator(.hidden)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { if saysLink { link } }
        .navigationTitle("Invincible")
        .modifier(HomeBar(own: ownHead, query: $query, settings: settings) { newMenu })
        // Your chats are read only once you search them: nothing more is asked at rest.
        .task(id: searching) { if searching && history.chats == nil { await history.load(session) } }
        .sheet(isPresented: $creating) { AgentEditor(session: session) { open(.agent($0.id)) } }
        .task {
            // Your latest chat, read as the app opens (its row's line, and the chat ready when you open it); the list's
            // first frame with its rows is where a launch is usable.
            await session.chat.openLatest(with: session.client)
            PerfProbe.shared.usable()
        }
        // (A container by that name, its rows their own: an identifier on a view that is no element of its own goes to
        // every element in it.)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home")
    }

    /// Where the rows are: an iPhone's own stack in a scroll view, rows on the page with nothing around them; an iPad's
    /// sidebar a List, with its selection and separators. (A scroll's every XCUITest snapshot walked the List's cells, each
    /// a UIKit container sorted by its place, as well as their SwiftUI nodes: PerfTests.testScrollHome, profiled.)
    @ViewBuilder private func container<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if ownHead {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) { content() }
            }
            .scrollDismissesKeyboard(.immediately)
        } else {
            List { content() }.listStyle(.plain)
        }
    }

    /// + : a new chat with your agent, or a new agent where this device may make one.
    @ViewBuilder private var newMenu: some View {
        Button("New chat", systemImage: "square.and.pencil", action: newChat)
            .accessibilityIdentifier("home.new.chat")
        if session.can("fleet:admin") {
            Button("New agent", systemImage: "person.badge.plus") { creating = true }
                .accessibilityIdentifier("home.new.agent")
        }
    }

    /// The link's trouble: a node that proves to be another (with Try again; Settings forgets this device), else
    /// reconnecting, or what went wrong.
    @ViewBuilder private var link: some View {
        if let refused = ChatView.refusal(session.trouble) {
            NotYourNodeCard(trouble: refused, retry: { Task { await session.refresh() } }, forget: nil)
                .padding(.horizontal, Metrics.margin)
                .padding(.vertical, Space.s2)
        } else if Session.showsReconnecting(session.reconnecting, trouble: session.trouble) {
            ReconnectingLine(session: session).padding(.horizontal, Metrics.margin).background(.bar)
        } else if let trouble = session.trouble {
            TroubleRow(trouble: trouble).font(.callout).padding(.horizontal, Metrics.margin).padding(.vertical, Space.s2).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
        }
    }

    /// Every row: your agent's pinned first (its line, and what waits on you that is no agent's), then the agents' and the
    /// rooms' by when each last did something (Home.rows, the web's homeRows).
    private var rows: [Home.Row] {
        let chat = session.chat
        let latest = chat.thread.turns.last { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }?.content
        let primary = Home.Row(
            kind: .primary, id: Primary.handle, name: Primary.name,
            line: Home.primaryLine(session.primaryWork, latest: latest, title: chat.title),
            at: nil, count: session.primaryNeeds, standing: session.primaryStanding
        )
        return [primary] + session.homeRows
    }

    private func rowButton(_ row: Home.Row) -> some View {
        let pick: HomePick = switch row.kind {
        case .primary: .primary
        case .agent: .agent(row.id)
        case .room: .room(row.id)
        }
        return mark(pick) {
            HomeRowView(row: row) { face(row) }
        }
        .accessibilityIdentifier(row.kind == .primary ? "home.primary" : row.kind == .agent ? "home.agent.\(row.id)" : "home.room.\(row.id)")
    }

    @ViewBuilder private func face(_ row: Home.Row) -> some View {
        switch row.kind {
        case .primary:
            PrimaryOrb(size: Self.face, tone: session.primaryTone, mood: session.primaryMood)
        case .agent:
            AgentFace(id: row.id, profile: session.drawn(row.id)?.avatar, size: Self.face, mood: Orb.Mood(row.standing))
        case .room:
            Image(systemName: "number")
                .font(.title3.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: Self.face, height: Self.face)
                .background(.fill.tertiary, in: .circle)
        }
    }

    /// A row that chooses: marked on a quiet ground while what it chose is on screen beside it, said so to VoiceOver.
    private func mark<Row: View>(_ choice: HomePick, @ViewBuilder _ row: () -> Row) -> some View {
        let here = choice == current
        let insets = EdgeInsets(top: Space.s1, leading: Metrics.margin, bottom: Space.s1, trailing: Metrics.margin)
        return Button { open(choice) } label: { row().padding(ownHead ? insets : EdgeInsets()).contentShape(.rect) }
            .buttonStyle(.plain)
            .listRowInsets(insets)
            .listRowBackground(RosterMark().opacity(here ? 1 : 0))
            .accessibilityAddTraits(here ? .isSelected : [])
    }

    /// While notifications are off: a word to turn them on, so a finished task or a question reaches you.
    private var notificationsOff: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "bell.slash").foregroundStyle(.secondary).frame(width: Self.face)
            Text(push.reach == .settings ? "Notifications are off in Settings" : "Notifications are off").font(.subheadline).foregroundStyle(.secondary)
            Spacer(minLength: Space.s2)
            Button(push.reach == .settings ? "Open" : "Turn on") {
                if push.reach == .settings {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } else {
                    Task { try? await PushCenter.shared.turnOn(session) }
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.borderless)
            .frame(minHeight: Metrics.touch)
        }
        .padding(ownHead ? EdgeInsets(top: Space.s1, leading: Metrics.margin, bottom: Space.s1, trailing: Metrics.margin) : EdgeInsets())
        .listRowInsets(EdgeInsets(top: Space.s1, leading: Metrics.margin, bottom: Space.s1, trailing: Metrics.margin))
        .accessibilityIdentifier("home.notifications")
    }
}

/// Home's bar: its own head where it has one (an iPhone's: the system's bar hidden, its search a field in the list), else
/// the system's, its title, its search drawer, Settings and +.
private struct HomeBar<New: View>: ViewModifier {
    let own: Bool
    @Binding var query: String
    let settings: () -> Void
    @ViewBuilder let new: New

    func body(content: Content) -> some View {
        if own {
            content
                .toolbar(.hidden, for: .navigationBar)
                .safeAreaBar(edge: .top) { HomeHead(settings: settings) { new } }
        } else {
            content
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(action: settings) { Image(systemName: "gearshape") }
                            .accessibilityLabel("Settings")
                            .accessibilityIdentifier("home.settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu { new } label: { Image(systemName: "plus") }
                            .accessibilityLabel("New")
                            .accessibilityIdentifier("home.new")
                    }
                }
        }
    }
}

/// Home's own head (an iPhone's), where the system's bar was, at its sizes: Settings, the app's name, and + for a new chat
/// or a new agent, each on its own glass. The system's bar over the moving list (its title, its search drawer, its glass
/// items) is what a scroll's every accessibility snapshot walked (PerfTests.testScrollHome, profiled: three fifths of the
/// main thread's time); Work's own head was measured the same way (1.7 ms a second where the system's bar cost 10 to 14).
struct HomeHead<New: View>: View {
    let settings: () -> Void
    @ViewBuilder let new: New

    var body: some View {
        ZStack {
            Text("Invincible")
                .font(.headline)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 0) {
                Button(action: settings) { glyph("gearshape") }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("home.settings")
                Spacer(minLength: Space.s2)
                Menu { new } label: { glyph("plus") }
                    .menuIndicator(.hidden)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("New")
                    .accessibilityIdentifier("home.new")
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s1)
    }

    /// A button's symbol at the system bar's size (the body's, large) in a touch's box.
    private func glyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.body)
            .imageScale(.large)
            .foregroundStyle(.primary)
            .frame(width: Metrics.touch, height: Metrics.touch)
            .contentShape(.circle)
    }
}

/// Home's search, a field at the top of its list (an iPhone's, whose own head has no search drawer): it finds your agents,
/// your rooms and your chats by their words.
private struct HomeSearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier("home.search")
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, Space.s3)
        .frame(minHeight: 36)
        .background(.fill.tertiary, in: .capsule)
    }
}

/// One row of Home: its face, its name with when on its right, and its line with what waits on you on its right (an ink
/// capsule with the count), else a dot in the ink while something there is new to you.
struct HomeRowView<Face: View>: View {
    let row: Home.Row
    @ViewBuilder let face: Face

    var body: some View {
        HStack(spacing: Space.s3) {
            face.frame(width: HomeList.face, height: HomeList.face)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    Text(row.name).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Spacer(minLength: Space.s2)
                    if let at = row.at {
                        // (Said as the list is drawn, as a chat app's: "14:05" today, "Yesterday", "Thursday", "21/11/2026".)
                        Text(ListTime.words(at, now: Date.now.timeIntervalSince1970 * 1000)).font(.footnote).foregroundStyle(.tertiary).monospacedDigit().lineLimit(1)
                    }
                }
                HStack(alignment: .center, spacing: Space.s2) {
                    Text(row.line.isEmpty ? " " : row.line)
                        .font(.subheadline)
                        .foregroundStyle(row.standing == .failed ? AnyShapeStyle(Color.danger) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                    Spacer(minLength: Space.s2)
                    if row.count > 0 {
                        Text("\(row.count)")
                            .font(.footnote.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(Color.onAccent)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 22, minHeight: 22)
                            .background(Color.ink, in: .capsule)
                    } else if row.unread {
                        Circle().fill(Color.ink).frame(width: 9, height: 9)
                    }
                }
            }
        }
        .frame(minHeight: 64)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.name)
        .accessibilityValue([row.line, row.count > 0 ? PrimaryNow.needsYou(row.count) : nil, row.unread ? "New" : nil].compactMap(\.self).joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}

/// Your chats as the node keeps them: read when you search them.
@MainActor @Observable final class ChatHistory {
    private(set) var chats: [ConversationSummary]?
    private(set) var problem: String?

    private struct Listed: Decodable { let conversations: [ConversationSummary] }

    func load(_ session: Session) async {
        do {
            chats = try await session.client.get("/api/conversations", as: Listed.self).conversations
            problem = nil
        } catch {
            if !(error is CancellationError) { problem = "Your chats couldn't be read: \(error.localizedDescription)" }
            if chats == nil { chats = [] }
        }
    }
}

/// A chat found by search: its title, one line; a dot in the ink while an answer in it is new to you.
private struct HomeChatRow: View {
    let chat: ConversationSummary

    var body: some View {
        HStack(spacing: Space.s2) {
            if chat.unread == true { Circle().fill(Color.ink).frame(width: 7, height: 7).accessibilityLabel("New answer") }
            Text(chat.title).font(.body).foregroundStyle(.primary).lineLimit(1)
            Spacer(minLength: Space.s2)
            Text(ListTime.words(chat.updatedAt, now: Date.now.timeIntervalSince1970 * 1000)).font(.footnote).foregroundStyle(.tertiary).monospacedDigit().lineLimit(1)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// The row of what is on screen beside a sidebar: a quiet ground.
struct RosterMark: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.fill.secondary)
            .padding(.horizontal, Space.s1 + Space.line)
            .padding(.vertical, 1)
    }
}
#endif
