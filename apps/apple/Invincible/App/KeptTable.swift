import Foundation

/**
 * The last team this device saw, kept on it by the owner's word (21 November 2026), the record Invincible for Android
 * keeps (app/KeptTable.kt): drawn the moment the app opens and replaced by the node's first answer, so a slow connection
 * doesn't open on an empty table. It keeps what the agents draw and no more: the team as the node said it, in the
 * fields its roster reads (an agent's instructions, its working notes and the keys it may use, a task's brief, left out),
 * the chats' titles, which approvals wait (who asks and for which tool, never what a request holds) and how many things
 * wait for you. Only for the node and key it came from, and only ever looked at: whatever you change starts from the
 * node's word.
 */
enum KeptTable {
    static let version = 1

    /// What of `GET /api/team` the roster reads (Roster.rows, Roster.roomRows).
    static let parts = ["agents", "rooms", "tasks", "deliveries", "removed", "seen"]

    /// Of each list, the fields the roster reads and no others: an agent's standing instructions, its working notes, the
    /// keys it may use, a task's whole brief are not the team's.
    static let fields: [String: Set<String>] = [
        "agents": ["id", "name", "role", "enabled", "dailyTurns", "turnsToday", "createdBy", "avatar", "workspace"],
        "rooms": ["id", "name", "direct", "members", "updatedAt", "paused"],
        "tasks": ["id", "title", "assignee", "status", "verified", "updatedAt", "progress", "error", "changes", "proposedBy", "room", "dependsOn"],
        "deliveries": ["id", "agent", "status", "updatedAt", "error", "room"],
        "removed": ["id", "name"],
    ]

    /// What was kept, as it was said.
    struct Kept: Sendable {
        /// The team in the fields the roster reads: an agent's instructions and a task's brief come back empty.
        let team: TeamSnapshot
        /// Its chats under way, by title (nil: a temporary chat).
        let turns: [String?]
        /// Its chats with an answer you hadn't read, by title.
        let unread: [String]
        /// Which approvals waited: who asked, and for which tool.
        let asks: [Ask]
        /// How many things waited for you.
        let waiting: Int
        /// When the node said it, in milliseconds since 1970.
        let at: Double
    }

    /// The record kept for `node`, from what it last said: `team` is `GET /api/team`'s answer as it came.
    static func record(for node: PairedNode, team: Data, turns: [String?], unread: [String], asks: [Ask], waiting: Int, at: Double) -> Data? {
        guard let answer = (try? JSONSerialization.jsonObject(with: team)) as? [String: Any] else { return nil }
        let record: [String: Any] = [
            "v": version,
            "origin": node.origin.absoluteString,
            "device": node.device,
            "at": Int64(at),
            "team": trimmed(answer),
            "turns": turns.map { $0.map { $0 as Any } ?? NSNull() },
            "unread": unread.map { ["title": $0] },
            "asks": asks.map { ["by": $0.by, "connector": $0.connector ?? NSNull(), "tool": $0.tool ?? NSNull()] as [String: Any] },
            "waiting": waiting,
        ]
        return try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    }

    /// What was kept, if it is `node`'s, made with this key, in this version; anything else is nothing.
    static func read(_ data: Data, for node: PairedNode) -> Kept? {
        guard let kept = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              kept["v"] as? Int == version, kept["origin"] as? String == node.origin.absoluteString, kept["device"] as? String == node.device,
              var team = kept["team"] as? [String: Any] else { return nil }
        // What was never kept comes back empty: the agents draw neither.
        team["agents"] = (team["agents"] as? [[String: Any]])?.map { $0.merging(["instructions": "", "harness": ""]) { old, _ in old } }
        team["tasks"] = (team["tasks"] as? [[String: Any]])?.map { $0.merging(["goal": ""]) { old, _ in old } }
        guard let words = try? JSONSerialization.data(withJSONObject: team), let snapshot = try? JSONDecoder().decode(TeamSnapshot.self, from: words) else { return nil }
        let asks = (kept["asks"] as? [[String: Any]] ?? []).compactMap { ask in
            (ask["by"] as? String).map { Ask(by: $0, connector: ask["connector"] as? String, tool: ask["tool"] as? String) }
        }
        return Kept(
            team: snapshot,
            turns: (kept["turns"] as? [Any] ?? []).map { $0 as? String },
            unread: (kept["unread"] as? [[String: Any]] ?? []).compactMap { $0["title"] as? String },
            asks: asks,
            waiting: kept["waiting"] as? Int ?? 0,
            at: (kept["at"] as? NSNumber)?.doubleValue ?? 0
        )
    }

    /// The team as the roster reads it, and no more.
    private static func trimmed(_ team: [String: Any]) -> [String: Any] {
        var kept: [String: Any] = [:]
        for part in parts {
            guard let value = team[part] else { continue }
            guard let allowed = fields[part] else {
                kept[part] = value
                continue
            }
            // (A list that isn't one is left out, never kept whole.)
            guard let items = value as? [Any] else { continue }
            kept[part] = items.compactMap { ($0 as? [String: Any]).map { only($0, allowed) } }
        }
        return kept
    }

    /// An item with the fields it may keep (a task's changes: how many files, nothing of what they were).
    private static func only(_ item: [String: Any], _ allowed: Set<String>) -> [String: Any] {
        var kept = item.filter { allowed.contains($0.key) }
        if let changes = kept["changes"] as? [String: Any] { kept["changes"] = changes.filter { $0.key == "files" } }
        return kept
    }

    /// Where a device keeps it, and the one queue that writes and removes it. (What it remembers of the last write is
    /// touched only on that queue.)
    final class Store: @unchecked Sendable {
        /// An iPhone's or an iPad's: in the app's caches, never backed up (and the system may clear them), the file
        /// readable only while the device is unlocked. A Mac keeps none: its node is most often the Mac itself.
        static let here: Store? = {
            #if os(iOS)
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first.map { Store(file: $0.appending(path: "agents.json")) }
            #else
            nil
            #endif
        }()

        let file: URL
        /// Written whole or not at all, and readable only while the device is unlocked.
        static let writing: Data.WritingOptions = [.atomic, .completeFileProtection]
        /// One at a time, in order: a write still under way never brings back what forgetting the node took away.
        private let queue = DispatchQueue(label: "sh.invincible.bot.kept-table", qos: .utility)
        /// What was last written there (without its time), and when: written again when it changes, or ten minutes on.
        private var said: Data?
        private var saidAt: Double = 0

        init(file: URL) {
            self.file = file
        }

        /// What it holds for `node`, if anything.
        func load(for node: PairedNode) -> Kept? {
            (try? Data(contentsOf: file)).flatMap { KeptTable.read($0, for: node) }
        }

        /// What the node just said of the agents, kept for the next time the app opens (off the main thread).
        func keep(team: Data, for node: PairedNode, turns: [String?], unread: [String], asks: [Ask], waiting: Int, at now: Double = Date.now.timeIntervalSince1970 * 1000) {
            queue.async { [self] in
                guard let words = KeptTable.record(for: node, team: team, turns: turns, unread: unread, asks: asks, waiting: waiting, at: 0) else { return }
                if words == said, now - saidAt < 10 * 60_000 { return }
                guard let record = KeptTable.record(for: node, team: team, turns: turns, unread: unread, asks: asks, waiting: waiting, at: now),
                      (try? record.write(to: file, options: Self.writing)) != nil else { return }
                (said, saidAt) = (words, now)
            }
        }

        /// The kept team goes (another node, or none), after any write still under way.
        func forget() {
            queue.async { [self] in
                try? FileManager.default.removeItem(at: file)
                (said, saidAt) = (nil, 0)
            }
        }

        /// Returns once everything asked of it so far is done.
        func settle() {
            queue.sync {}
        }
    }
}
