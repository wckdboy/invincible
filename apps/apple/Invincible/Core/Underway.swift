import Foundation

/// What is under way in a chat (core's `UnderwayView`, the PWA's lib/underway.ts): the tasks it gave agents from it that
/// haven't ended, and the looks it set itself there that wait.
struct UnderwayView: Decodable, Sendable, Equatable {
    struct Task: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        /// The agent's handle, and its name.
        let assignee: String
        let name: String
        /// queued · running
        let status: String
        let progress: String
        /// The agent's own conversation with you, where it works.
        let room: String
    }

    struct Look: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        /// When it looks again (ms since 1970).
        let at: Double
        let note: String
    }

    let tasks: [Task]
    let looks: [Look]

    static let none = UnderwayView(tasks: [], looks: [])
    var isEmpty: Bool { tasks.isEmpty && looks.isEmpty }
}

/// What is under way, in words: the PWA's lib/underway.ts, word for word.
enum UnderwayWords {
    /// A time as the row says it: "23:07" today, "Wed 25 Nov, 09:00" on another day.
    static func when(_ at: Date, now: Date = .now, zone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let time = format("HH:mm", zone).string(from: at)
        if calendar.isDate(at, inSameDayAs: now) { return time }
        return "\(format("EEE d MMM", zone).string(from: at)), \(time)"
    }

    private static func format(_ pattern: String, _ zone: TimeZone) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = zone
        f.dateFormat = pattern
        return f
    }

    /// A task's line: its agent, how it stands (its first line of progress, or at work; waiting its turn while queued).
    static func state(of task: UnderwayView.Task) -> String {
        if task.status == "queued" { return "waiting its turn" }
        let first = task.progress.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        return first.isEmpty ? "at work" : String(first.prefix(80))
    }

    /// A look's line: when it looks again, and what at.
    static func look(_ look: UnderwayView.Look, now: Date = .now, zone: TimeZone = .current) -> String {
        "Looking again at \(when(Date(timeIntervalSince1970: look.at / 1000), now: now, zone: zone)): \(look.note)"
    }

    /// A look of its come back, as the chat shows its message: when it said it would, and what at.
    static func looked(_ look: StoredMessage.Look, now: Date = .now, zone: TimeZone = .current) -> String {
        "It looked again, as it said at \(when(Date(timeIntervalSince1970: look.set / 1000), now: now, zone: zone)) it would: \(look.note)"
    }

    /// How soon to ask the node again (the PWA's nextLookMs): soon while a task is under way or it is answering; just
    /// after a look of its comes due, then soon until the node takes it (it is gone from the row then); else seldom.
    static func nextAsk(_ shown: UnderwayView, answering: Bool, now: Date = .now) -> Duration {
        if !shown.tasks.isEmpty || answering { return .seconds(5) }
        guard let soonest = shown.looks.map(\.at).min() else { return .seconds(30) }
        let ms = soonest - now.timeIntervalSince1970 * 1000
        return ms <= 0 ? .seconds(5) : .milliseconds(Int(min(30_000, ms + 1_000)))
    }
}
