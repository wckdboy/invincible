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
        /// When it last did something (ms); nil for your agent's, whose row says no time.
        let at: Double?
        /// What of it waits on you, for its capsule (0: nothing).
        let count: Int
        let standing: Standing
        /// Something ended there since you last looked: new to you until you open it.
        var unread = false

        /// Its key, as every app orders two at the same moment: `person:<handle>`, `room:<id>`.
        var key: String { kind == .room ? "room:\(id)" : "person:\(id)" }
    }

    /// Every agent and room for the list (the PWA's lib/roster.ts homeRows, held to it by the vectors' agents.home,
    /// rooms.home and unread.home): each with when it last did something (its work's last move or the last word in its
    /// conversation; a room's own last word or its work's; an agent that has done nothing yet, when it was made) and its
    /// count (each approval it asks for and each task proposed to it, a room's proposed in it, else one for anything else
    /// only you can move on there), the latest first and two at the same moment by their keys, so every app agrees. Your
    /// agent's own row, pinned above them, is the view's (PrimaryNow, Roster.primaryNeeds).
    static func rows(snapshot: TeamSnapshot, asks: [Ask], now: Double) -> [Row] {
        let agents: [Row] = Roster.rows(snapshot: snapshot, asks: asks, now: now).map { row in
            let jobs = agentJobs(snapshot, row.id)
            let own = row.room.flatMap { id in snapshot.rooms.first { $0.id == id } }
            let made = snapshot.agents.first { $0.id == row.id }?.createdAt ?? 0
            let waits = asks.filter { Roster.agentOfCaller($0.by) == row.id }.count + proposals(jobs)
            return Row(
                kind: .agent, id: row.id, name: row.name, line: row.standing.beside(row.line), at: latest(max(made, own?.updatedAt ?? 0), jobs),
                count: waits > 0 ? waits : (row.needs ? 1 : 0), standing: row.standing, unread: row.unread
            )
        }
        let rooms: [Row] = Roster.roomRows(snapshot: snapshot).map { row in
            let jobs = roomJobs(snapshot, row.id)
            let waits = proposals(jobs)
            let room = snapshot.rooms.first { $0.id == row.id }
            return Row(
                kind: .room, id: row.id, name: row.name, line: row.line, at: latest(room?.updatedAt ?? 0, jobs),
                count: waits > 0 ? waits : (row.needs ? 1 : 0), standing: row.needs ? .needs : .resting, unread: row.unread
            )
        }
        return (agents + rooms).sorted { a, b in
            let (x, y) = (a.at ?? 0, b.at ?? 0)
            return x != y ? x > y : a.key < b.key
        }
    }

    /// One of an agent's or a room's jobs: a task (proposed, or not) or a reply, as far as the list counts them.
    private struct Job {
        let updatedAt: Double
        let proposed: Bool
    }

    /// An agent's work: the tasks given to it, and its replies, wherever they are.
    private static func agentJobs(_ snapshot: TeamSnapshot, _ id: String) -> [Job] {
        snapshot.tasks.filter { $0.assignee == id }.map { Job(updatedAt: $0.updatedAt, proposed: $0.status == "proposed") }
            + snapshot.deliveries.filter { $0.agent == id }.map { Job(updatedAt: $0.updatedAt, proposed: false) }
    }

    /// A room's work: the tasks given in it, and the replies written there.
    private static func roomJobs(_ snapshot: TeamSnapshot, _ id: String) -> [Job] {
        snapshot.tasks.filter { $0.room == id }.map { Job(updatedAt: $0.updatedAt, proposed: $0.status == "proposed") }
            + snapshot.deliveries.filter { $0.room == id }.map { Job(updatedAt: $0.updatedAt, proposed: false) }
    }

    private static func latest(_ from: Double, _ jobs: [Job]) -> Double { jobs.reduce(from) { max($0, $1.updatedAt) } }
    private static func proposals(_ jobs: [Job]) -> Int { jobs.filter(\.proposed).count }

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
        // (A title of spaces says nothing: the chat is yet to be started.)
        let named = title.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        return said ?? named ?? "Start a chat"
    }

    /// The first line of what was said, its Markdown marks aside, as a list shows a message.
    static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        return line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#*_`>- "))
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
