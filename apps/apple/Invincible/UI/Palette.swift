import SwiftUI

extension EnvironmentValues {
    /// Opens Search, or ask (⌘K), where the window has it: an iPad's, a Mac's.
    @Entry var openSearch: (() -> Void)? = nil
}

/*
 * Search, or ask (⌘K, the PWA's palette; T3 Code's, keyboard-first): type, and what matches is listed: the places, the
 * tasks by their titles and projects, the agents by name, a task to give, a new chat; and last, asking the primary what you
 * typed. Arrows move through them, Return opens the one chosen, Esc puts it away. On an iPad and a Mac.
 */
struct CommandPalette: View {
    let session: Session
    /// Goes to a place in the window.
    let go: (Place) -> Void
    /// Gives a task to the agents (nil: this device may not).
    var give: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var chosen = 0
    @FocusState private var typing: Bool

    struct Item: Identifiable {
        let id: String
        let title: String
        let detail: String
        let symbol: String
        let run: () -> Void
    }

    /// Whether what was typed is in any of these texts, whatever its case (nothing typed: it is).
    static func found(_ words: String, in texts: [String]) -> Bool {
        words.isEmpty || texts.contains { $0.localizedCaseInsensitiveContains(words) }
    }

    /// The places, each with its title, a line and its symbol, that what was typed finds, by their titles and lines. Needs
    /// you was the Inbox until 27 November 2026: "inbox" still finds it.
    static func places(matching words: String, needsYou: Int) -> [(place: Place, title: String, detail: String, symbol: String)] {
        let aka: [Place: String] = [.inbox: "Inbox"]
        let places: [(place: Place, title: String, detail: String, symbol: String)] = [
            (.home, "Home", "What needs you, and the work", "house"),
            (.primary, Primary.name, "Its conversation", "bubble.left.and.text.bubble.right"),
            (.agents, "Agents", "Your agents and their rooms", "person.3"),
            (.inbox, "Needs you", needsYou > 0 ? "\(needsYou) need\(needsYou == 1 ? "s" : "") you" : "Nothing needs you", "tray"),
            (.more, "Settings", "This device, its node and fleet", "gearshape"),
        ]
        return places.filter { found(words, in: [$0.title, $0.detail, aka[$0.place] ?? ""]) }
    }

    private var items: [Item] {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        func matches(_ texts: String...) -> Bool { Self.found(words, in: texts) }
        var out: [Item] = []
        for (place, title, detail, symbol) in Self.places(matching: words, needsYou: session.needsYou) {
            out.append(Item(id: "place:\(title)", title: title, detail: detail, symbol: symbol) { go(place) })
        }
        if let give, matches("Give a task", "New task") {
            out.append(Item(id: "give", title: "Give a task…", detail: "To the agent best suited to it, or to one by name", symbol: "square.stack.3d.up", run: give))
        }
        if session.can("chat"), matches("New chat") {
            out.append(Item(id: "new", title: "New chat", detail: "With \(Primary.name)", symbol: "square.and.pencil") {
                if !session.chat.answering { session.chat.startNew() }
                go(.primary)
            })
        }
        for row in session.attended?.byAttention ?? [] where matches(row.title, row.project.name, row.agent.name, row.word) {
            out.append(Item(id: "task:\(row.id)", title: row.title, detail: "\(row.project.name) · \(row.word) · \(row.agent.name)", symbol: "square.stack.3d.up") { go(.task(row.id)) })
        }
        for row in session.rows where matches(row.name) {
            out.append(Item(id: "agent:\(row.id)", title: row.name, detail: row.line, symbol: "person") { go(.agent(row.id)) })
        }
        if !words.isEmpty, session.can("chat"), !session.chat.answering {
            out.append(Item(id: "ask", title: "Ask \(Primary.name): “\(words)”", detail: "A new conversation with \(Primary.name)", symbol: "arrow.up.circle") {
                session.chat.startNew()
                session.chat.draft = words
                session.chat.send(with: session.client)
                go(.primary)
            })
        }
        return out
    }

    var body: some View {
        let items = items
        VStack(spacing: 0) {
            HStack(spacing: Space.s2) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search, or ask \(Primary.name)", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($typing)
                    .onSubmit { open(items) }
                    .onChange(of: query) { chosen = 0 }
                    .accessibilityLabel("Search, or ask \(Primary.name)")
            }
            .padding(Space.s4)
            Divider()
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            Button {
                                chosen = index
                                open(items)
                            } label: {
                                HStack(spacing: Space.s3) {
                                    Image(systemName: item.symbol).frame(width: 22).foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(item.title).lineLimit(1)
                                        Text(item.detail).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                    if index == chosen { Image(systemName: "return").font(.footnote).foregroundStyle(.tertiary) }
                                }
                                .padding(.horizontal, Space.s3)
                                .frame(minHeight: Metrics.touch)
                                .background(index == chosen ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 10, style: .continuous))
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .id(item.id)
                            .accessibilityAddTraits(index == chosen ? .isSelected : [])
                        }
                        if items.isEmpty {
                            Text("Nothing matches.").font(.subheadline).foregroundStyle(.secondary).padding(Space.s6)
                        }
                    }
                    .padding(Space.s2)
                }
                .onChange(of: chosen) { if items.indices.contains(chosen) { scroller.scrollTo(items[chosen].id) } }
            }
        }
        .frame(minWidth: 480, idealWidth: 560, minHeight: 360, idealHeight: 440)
        .onKeyPress(.downArrow) {
            chosen = min(items.count - 1, chosen + 1)
            return .handled
        }
        .onKeyPress(.upArrow) {
            chosen = max(0, chosen - 1)
            return .handled
        }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .onAppear { typing = true }
    }

    private func open(_ items: [Item]) {
        guard items.indices.contains(chosen) else { return }
        let item = items[chosen]
        dismiss()
        item.run()
    }
}
