#if os(iOS)
import SwiftUI

/*
 * The drawer (the owner's word of 28 November 2026: "make it as simple as the grokbot app or t3code ios app"): your chats
 * with your agent, and your agents, as Grok's history is. On an iPhone it comes from the chat's drawer button or the
 * screen's left edge; on an iPad it is the sidebar. Top to bottom:
 * - search, which finds a chat by its words;
 * - New chat;
 * - Needs you with its count, while something does;
 * - your agents and rooms, each its own chat;
 * - your chats by day, pinned first (a swipe pins or deletes one);
 * - Settings at its foot.
 * Nothing else: no head, no other places, no section names but the days'.
 */

/// What the drawer chooses.
enum DrawerPick: Hashable {
    case newChat
    case chat(String)
    case needs
    case agent(String)
    case room(String)
    case settings

    /// The drawer's row for a place on screen: your agent's chat is its own chat's row (none while it is a new one).
    static func of(_ place: Place, chat: String?) -> DrawerPick? {
        switch place {
        case .primary: chat.map(DrawerPick.chat)
        case .agent(let id): .agent(id)
        case .room(let id): .room(id)
        case .inbox: .needs
        case .more, .thisMac, .keys, .connectors: .settings
        case .task, .home, .agents, .chats, .everything: nil
        }
    }
}

struct Drawer: View {
    let session: Session
    /// What is on screen: its row is marked.
    let current: DrawerPick?
    let pick: (DrawerPick) -> Void
    @State private var history = ChatHistory()
    @State private var query = ""
    @State private var deleting: ConversationSummary?
    @State private var push = PushCenter.shared

    /// The faces' size: an agent's glass, a room's mark.
    static let face: CGFloat = 28

    var body: some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let groups = Chats.groups(Chats.filter(history.chats ?? [], query: query))
        List {
            Section {
                row(.newChat, symbol: "square.and.pencil", title: "New chat")
                    .accessibilityIdentifier("roster.new")
                if session.needsYou > 0 {
                    row(.needs, symbol: "tray", title: "Needs you", count: session.needsYou)
                        .accessibilityIdentifier("roster.needs")
                }
            }
            // Your agents and rooms in one row of faces, as Grok Bot pins its bots and Messages its people: each its own chat,
            // a tap away, and your chats right under them.
            if !searching, !session.rows.isEmpty || !session.roomRows.isEmpty {
                Section {
                    DrawerFaces(session: session, current: current, pick: pick)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            ForEach(groups, id: \.label) { group in
                Section {
                    ForEach(group.items) { chat in chatRow(chat) }
                } header: {
                    Text(group.label).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(nil)
                }
            }
            if let problem = history.problem {
                Text(problem).font(.footnote).foregroundStyle(Color.danger).listRowBackground(Color.clear)
            } else if searching, groups.isEmpty, history.chats != nil {
                Text("No chat says “\(query)”.").font(.subheadline).foregroundStyle(.secondary).listRowBackground(Color.clear)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, Space.s1, for: .scrollContent)
        .safeAreaBar(edge: .top, spacing: 0) { DrawerSearch(text: $query) }
        .safeAreaBar(edge: .bottom, spacing: 0) { foot }
        // Read whenever it opens, and again as the chats change: a new one, an answer that named one.
        .task(id: "\(session.chat.conversation ?? "")|\(session.chat.answering)") { await history.load(session) }
        .refreshable { await history.load(session) }
        .confirmationDialog("Delete this chat?", isPresented: .init(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { chat in
            Button("Delete", role: .destructive) { Task { await history.delete(chat, session) } }
        } message: { chat in
            Text("“\(chat.title)” is gone for good, on \(session.whoami?.nodeName ?? session.node.nodeName ?? "your node"). If it's working in it, it stops.")
        }
        .animation(.snappy, value: session.rows.map(\.id) + session.roomRows.map(\.id))
        // (A container by that name, its rows their own: an identifier on a view that is no element of its own goes to
        // every element in it.)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roster")
    }

    /// A row that does something: a glyph in the faces' column, its name, and a count where one is due.
    private func row(_ choice: DrawerPick, symbol: String, title: String, count: Int = 0) -> some View {
        mark(choice) {
            HStack(spacing: Space.s3) {
                DrawerGlyph(symbol: symbol)
                Text(title).font(.body).foregroundStyle(.primary)
                Spacer(minLength: Space.s2)
                if count > 0 {
                    Text("\(count)")
                        .font(.footnote.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(Color.onAccent)
                        .padding(.horizontal, 7)
                        .frame(minWidth: 22, minHeight: 22)
                        .background(Color.ink, in: .capsule)
                        .accessibilityLabel("\(count)")
                }
            }
            .frame(minHeight: Metrics.touch)
        }
    }

    /// A row that chooses: marked on a quiet ground while what it chose is on screen, said so to VoiceOver.
    private func mark<Row: View>(_ choice: DrawerPick, @ViewBuilder _ row: () -> Row) -> some View {
        let here = choice == current
        return Button { pick(choice) } label: { row().contentShape(.rect) }
            .buttonStyle(.plain)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: Space.line, leading: Space.s3, bottom: Space.line, trailing: Space.s3))
            // (Every row on the drawer's own ground, the marked one's on its mark.)
            .listRowBackground(RosterMark().opacity(here ? 1 : 0))
            .accessibilityAddTraits(here ? .isSelected : [])
    }

    /// One of your chats: open it; swipe it or hold it to pin it or delete it.
    private func chatRow(_ chat: ConversationSummary) -> some View {
        mark(.chat(chat.id)) { DrawerChatRow(chat: chat) }
            .accessibilityIdentifier("roster.chat.\(chat.id)")
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { deleting = chat } label: { Label("Delete", systemImage: "trash") }
            }
            .swipeActions(edge: .leading) {
                Button { Task { await history.pin(chat, !chat.pinned, session) } } label: {
                    Label(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash" : "pin")
                }
                .tint(.ink)
            }
            .contextMenu {
                Button(chat.pinned ? "Unpin" : "Pin", systemImage: chat.pinned ? "pin.slash" : "pin") { Task { await history.pin(chat, !chat.pinned, session) } }
                Button("Delete…", systemImage: "trash", role: .destructive) { deleting = chat }
            }
    }

    /// Its foot: Settings, and, while notifications are off, a word to turn them on.
    private var foot: some View {
        VStack(spacing: 0) {
            Divider()
            if push.reach == .turnOn || push.reach == .settings {
                HStack(spacing: Space.s3) {
                    DrawerGlyph(symbol: "bell.slash")
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
                .padding(.horizontal, Space.s3)
            }
            Button { pick(.settings) } label: {
                HStack(spacing: Space.s3) {
                    DrawerGlyph(symbol: "gearshape")
                    Text("Settings").font(.body).foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: Metrics.touch)
                .padding(.horizontal, Space.s3)
                .background(RosterMark().opacity(current == .settings ? 1 : 0))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(current == .settings ? .isSelected : [])
            .accessibilityIdentifier("roster.settings")
            .padding(.bottom, Space.s1)
        }
    }
}

/// Your chats as the node keeps them: read when the drawer opens and as they change, pinned and deleted from it.
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

    func pin(_ chat: ConversationSummary, _ pinned: Bool, _ session: Session) async {
        struct Update: Encodable { let id: String; let pinned: Bool }
        do {
            _ = try await session.client.post("/api/conversations/update", Update(id: chat.id, pinned: pinned), as: JSONValue.self)
            await load(session)
        } catch {
            problem = error.localizedDescription
        }
    }

    func delete(_ chat: ConversationSummary, _ session: Session) async {
        struct Delete: Encodable { let id: String }
        do {
            _ = try await session.client.post("/api/conversations/delete", Delete(id: chat.id), as: JSONValue.self)
            session.chat.forget(chat.id)
            await load(session)
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// A chat in the drawer: its title, one line, as Grok's history has it; a dot in the ink while an answer in it is new to
/// you, a pin where it is pinned, and a small dot of its state while it works, waits on you or failed.
private struct DrawerChatRow: View {
    let chat: ConversationSummary

    var body: some View {
        HStack(spacing: Space.s2) {
            if chat.unread == true { Circle().fill(Color.ink).frame(width: 7, height: 7).accessibilityLabel("New answer") }
            if chat.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.secondary).accessibilityLabel("Pinned") }
            Text(chat.title).font(.body).foregroundStyle(.primary).lineLimit(1)
            Spacer(minLength: Space.s2)
            if let tone = Self.tone(chat.state) {
                Circle().fill(tone).frame(width: 6, height: 6).accessibilityLabel(Chats.stateWords(chat))
            }
        }
        .frame(minHeight: 40)
        .accessibilityElement(children: .combine)
    }

    /// Its state's dot: the ink while it works or waits on you, red where it failed; none at rest.
    static func tone(_ state: String?) -> Color? {
        switch state {
        case "working", "waiting": .ink
        case "failed": .danger
        default: nil
        }
    }
}

/// Your agents and rooms as faces in a row: each its glass (its state's dot on it) and its name under it, the one on
/// screen marked; a room its number sign. Each opens its own chat.
private struct DrawerFaces: View {
    let session: Session
    let current: DrawerPick?
    let pick: (DrawerPick) -> Void

    /// A face's size, and the width its name may take under it.
    static let size: CGFloat = 44
    static let width: CGFloat = 64

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: Space.s1) {
                ForEach(session.rows) { agent in
                    face(.agent(agent.id), name: agent.name, said: agent.standing.beside(agent.line)) {
                        AgentFace(id: agent.id, profile: session.drawn(agent.id)?.avatar, size: Self.size, mood: Orb.Mood(agent.standing))
                    }
                    .accessibilityIdentifier("roster.agent.\(agent.id)")
                }
                ForEach(session.roomRows) { room in
                    face(.room(room.id), name: room.name, said: room.line) {
                        Image(systemName: "number")
                            .font(.title3.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: Self.size, height: Self.size)
                            .background(.fill.tertiary, in: .circle)
                    }
                    .accessibilityIdentifier("roster.room.\(room.id)")
                }
            }
            .padding(.horizontal, Space.s2)
            .padding(.vertical, Space.s1)
        }
        .scrollClipDisabled()
    }

    private func face<Face: View>(_ choice: DrawerPick, name: String, said: String, @ViewBuilder _ face: () -> Face) -> some View {
        let here = choice == current
        return Button { pick(choice) } label: {
            VStack(spacing: Space.s1) {
                face().frame(width: Self.size, height: Self.size)
                Text(name)
                    .font(.caption.weight(here ? .semibold : .regular))
                    .foregroundStyle(here ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
            .frame(width: Self.width)
            .padding(.vertical, Space.s1)
            .background(RosterMark().opacity(here ? 1 : 0))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(said.isEmpty ? name : "\(name): \(said)")
        .accessibilityAddTraits(here ? .isSelected : [])
    }
}

/// The drawer's search: a field at its top, as Grok's is; it finds a chat by its words.
private struct DrawerSearch: View {
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search", text: $text)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier("roster.search")
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear the search")
            }
        }
        .font(.body)
        .padding(.horizontal, Space.s3)
        .frame(minHeight: 40)
        .background(.fill.tertiary, in: .capsule)
        .padding(.horizontal, Space.s3)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s1)
    }
}

/// A glyph in the drawer's column: every one fitted to the same box, so their middles and edges line up, growing with the
/// text.
private struct DrawerGlyph: View {
    let symbol: String
    @ScaledMetric(relativeTo: .body) private var box: CGFloat = 20

    var body: some View {
        Image(systemName: symbol)
            .resizable()
            .scaledToFit()
            .fontWeight(.regular)
            .foregroundStyle(.secondary)
            .frame(width: box, height: box)
            .frame(width: Drawer.face)
            .accessibilityHidden(true)
    }
}

/// The marked row's ground: a quiet round of its own, inset in its row, on any page (never the list's selection, which
/// read white on white in an iPad's dark sidebar).
struct RosterMark: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.fill.secondary)
            .padding(.horizontal, Space.s1 + Space.line)
            .padding(.vertical, 1)
    }
}

/// The chat's drawer button: it opens the drawer, and counts what needs you beside it.
struct DrawerButton: View {
    let needs: Int
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.s1) {
                Image(systemName: "line.3.horizontal").font(.body.weight(.medium))
                if needs > 0 {
                    Text("\(needs)")
                        .font(.footnote.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(Color.onAccent)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Color.ink, in: .capsule)
                }
            }
            .frame(minHeight: 30)
        }
        .accessibilityLabel("Chats and agents")
        .accessibilityValue(needs > 0 ? PrimaryNow.needsYou(needs) : "Nothing needs you")
        .accessibilityIdentifier("roster.open")
    }
}

/// The drawer over what is under it, from the left edge: what is under it dimmed, a tap on that or a swipe back to the
/// left closes it.
struct DrawerHost<Content: View>: View {
    @Binding var open: Bool
    let session: Session
    /// What is on screen under it: its row is marked.
    let current: DrawerPick?
    let pick: (DrawerPick) -> Void
    @ViewBuilder let content: Content
    @GestureState private var dragging: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ZStack(alignment: .leading) {
            content
            if open {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { close() }
                    .accessibilityLabel("Close the drawer")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
                // (Its width from the window's own, without a reader round what is under it: the chat lays out once. At
                // the accessibility sizes nearly all of it, where 340 points cut every name to a word.)
                let large = typeSize.isAccessibilitySize
                Drawer(session: session, current: current, pick: { choice in close(); pick(choice) })
                    .background(.background)
                    .containerRelativeFrame(.horizontal) { width, _ in large ? width * 0.94 : min(340, width * 0.86) }
                    .clipShape(.rect(bottomTrailingRadius: 24, topTrailingRadius: 24, style: .continuous))
                    .shadow(color: .black.opacity(0.18), radius: 24, x: 6)
                    .offset(x: min(0, dragging))
                    .gesture(DragGesture(minimumDistance: 12).updating($dragging) { value, state, _ in state = value.translation.width }.onEnded { value in
                        if value.translation.width < -110 { close() }
                    })
                    .transition(reduceMotion ? .opacity : .move(edge: .leading))
                    .ignoresSafeArea(edges: .bottom)
            }
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.9)) { open = false }
    }
}
#endif
