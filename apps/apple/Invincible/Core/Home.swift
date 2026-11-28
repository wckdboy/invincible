import Foundation

/*
 * Home, as a chat app's list (the owner's word of 28 November 2026: "use grok bot as the app look/UX. like a chat app,
 * with the primary at the top, the other agents"): your agent pinned first, then the agents and the rooms by their latest
 * activity, each a row of its face, its name, one line of what it is doing or last did, when, and how much waits on you.
 * Pure, from what the app already reads (the agents' snapshot, the decisions waiting): nothing is asked for per row.
 */
enum Home {
    struct Row: Identifiable, Equatable, Sendable {
        enum Kind: Equatable, Sendable {
            case primary
            case agent
            case room
        }

        let kind: Kind
        /// Your agent's handle, an agent's, or a room's id.
        let id: String
        let name: String
        /// One line of what it is doing, or last did.
        let line: String
        /// When it last did something (ms); nil where that isn't known.
        let at: Double?
        /// What waits on you there (a room's: only whether something does, as 1).
        let needs: Int
        let standing: Standing
        /// Something ended there since you last looked: new to you until you open it.
        var unread = false
    }

    /// The rows, top to bottom: your agent pinned first, then the agents and the rooms, the latest activity first (none
    /// known: after every known one), ties as the node lists them.
    static func rows(primary: Row, agents: [RosterRow], rooms: [RoomRow], snapshot: TeamSnapshot?, needs: [String: Int]) -> [Row] {
        let agentRows: [Row] = agents.map { agent in
            let at: Double? = snapshot.flatMap { latest(agent: agent.id, room: agent.room, in: $0) }
            return Row(kind: .agent, id: agent.id, name: agent.name, line: agent.standing.beside(agent.line), at: at, needs: needs[agent.id] ?? 0, standing: agent.standing, unread: agent.unread)
        }
        let roomRows: [Row] = rooms.map { room in
            let at: Double? = snapshot?.rooms.first { $0.id == room.id }?.updatedAt
            return Row(kind: .room, id: room.id, name: room.name, line: room.line, at: at, needs: room.needs ? 1 : 0, standing: room.needs ? .needs : .resting, unread: room.unread)
        }
        let others = agentRows + roomRows
        let sorted = others.enumerated().sorted { (a: (offset: Int, element: Row), b: (offset: Int, element: Row)) -> Bool in
            switch (a.element.at, b.element.at) {
            case let (x?, y?) where x != y: x > y
            case (.some, nil): true
            case (nil, .some): false
            default: a.offset < b.offset
            }
        }
        return [primary] + sorted.map(\.element)
    }

    /// When an agent last did something: its tasks' latest change and its own conversation's.
    static func latest(agent: String, room: String?, in snapshot: TeamSnapshot) -> Double? {
        var times: [Double] = snapshot.tasks.filter { $0.assignee == agent }.map(\.updatedAt)
        if let room, let talk = snapshot.rooms.first(where: { $0.id == room })?.updatedAt { times.append(talk) }
        return times.max()
    }

    /// Your agent's line: what it is doing (answering, the turns and runs in hand), an answer you haven't read, else the
    /// latest words of your chat with it, or its title. What waits on you is the row's count, never said again here.
    static func primaryLine(_ work: PrimaryWork, latest: String?, title: String?) -> String {
        let inHand = work.turns.count + work.runs.count
        if work.answering { return (work.step?.isEmpty == false ? work.step : nil) ?? "Writing…" }
        if inHand > 1 { return "Working on \(inHand) things" }
        if let turn = work.turns.first { return turn.flatMap { $0.isEmpty ? nil : "Working in “\($0)”" } ?? "Working in a temporary chat" }
        if let run = work.runs.first { return "Working on: \(run.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")[0])" }
        if work.unread.count > 1 { return "\(work.unread.count) new answers" }
        if let fresh = work.unread.first { return fresh.flatMap { $0.isEmpty ? nil : "New answer in “\($0)”" } ?? "A new answer" }
        let said = latest.map { Self.firstLine($0) }.flatMap { $0.isEmpty ? nil : $0 }
        return said ?? title ?? "Start a chat"
    }

    /// The first line of what was said, its Markdown marks aside, as a list shows a message.
    static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        return line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#*_`>- "))
    }

    /// When, as a chat list says it: the time today, "Yesterday", the weekday within the week, else the date.
    static func when(_ ms: Double, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        // (In the calendar's own time zone, as its days are counted.)
        let style = { (day: Date.FormatStyle.DateStyle, time: Date.FormatStyle.TimeStyle) in
            Date.FormatStyle(date: day, time: time, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        }
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(style(.omitted, .shortened)) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 1 { return "Yesterday" }
        if days > 1 && days < 7 { return date.formatted(style(.omitted, .omitted).weekday(.wide)) }
        return date.formatted(style(.numeric, .omitted))
    }

    /// The rows whose name or line says these words, your agent kept first; every row when there are none.
    static func filter(_ rows: [Row], query: String) -> [Row] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return rows }
        return rows.filter { row in
            let text = "\(row.name) \(row.line)".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }
}
