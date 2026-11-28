import Foundation

/// A chat kept on the node (core's `ConversationSummary`), as the chats list shows it.
struct ConversationSummary: Decodable, Sendable, Identifiable, Equatable {
    /// What it waits on you for.
    struct Needs: Decodable, Sendable, Equatable {
        let approvals: Int
        let keys: Int
        let question: Bool
    }

    let id: String
    let title: String
    let project: String?
    /// The roster role it was asked as.
    let role: String
    let pinned: Bool
    let updatedAt: Double
    /// How many messages it holds.
    let count: Int
    /// working · waiting · queued · stopped · failed · done
    let state: String
    /// Messages of yours queued behind it, and why they're held (nil: they go when the turn before them ends).
    let queued: Int
    let held: String?
    let needs: Needs?
    /// An answer of its ended in it since you last read it, on any device (email's unread; absent from an older node).
    var unread: Bool? = nil
}

/// `POST /api/conversations/get`: a kept chat with its messages, and the turn the node is running in it, if any.
struct ConversationDetail: Decodable, Sendable {
    let id: String
    let title: String
    let role: String
    let pinned: Bool
    let messages: [StoredMessage]
    let turn: TurnView?
    /// Something it answered in it hasn't been read yet, on any device.
    var unread: Bool? = nil
    /// What you queued behind it, kept on the node, and why that is held when it is (absent from an older node's).
    var queue: [QueuedMessage]? = nil
    var held: String? = nil
}

/// A message of yours queued behind a kept chat (core's QueuedMessage): sent as its next turn when the one before it ends
/// well; until then yours to change, remove, or send now.
struct QueuedMessage: Decodable, Sendable, Equatable, Identifiable {
    let id: Int
    let text: String
    /// The role it'll be asked as (nil: the chat's own).
    var role: String? = nil
    let at: Double
    /// The device you queued it from, by name.
    var by: String? = nil
}

/// What the node says of a chat's queue after each change to it (queue, edit, remove, send now, resume).
struct QueueView: Decodable, Sendable {
    let queue: [QueuedMessage]
    let held: String?
    /// The turn the change began at once (it'd finished meanwhile, or room came free).
    var started: TurnView? = nil
}

/// A chat with an answer you haven't read yet, as `GET /api/turns` lists them (the newest answer first).
struct UnreadChat: Decodable, Sendable, Equatable {
    let id: String
    let title: String
    let answeredAt: Double
}

/// The chats list as the PWA shows it (`lib/chats.ts`, core's `chatStateWords`): pinned first, then by when each was
/// last active; each chat's state in words.
enum Chats {
    /// A pause long enough that a chat says when it went on (Grok Bot's small centred times between groups).
    static let markAfterMs = 15 * 60_000.0

    /// The turns a chat marks with when they were said, by id: the first said, then each said on another day than the one
    /// before it, or after a pause of a quarter of an hour or more. Answers are said under what they answer.
    static func timeMarks(_ turns: [ChatThread.Turn], calendar: Calendar = .current) -> [Int: Double] {
        var out: [Int: Double] = [:]
        var last: Double?
        for turn in turns {
            guard let at = turn.at else { continue }
            if let before = last {
                let day = { (ms: Double) in calendar.startOfDay(for: Date(timeIntervalSince1970: ms / 1000)) }
                if at - before >= markAfterMs || day(at) != day(before) { out[turn.id] = at }
            } else {
                out[turn.id] = at
            }
            last = at
        }
        return out
    }

    /// When, as a chat's mark says it: "Today 9:41", "Yesterday 18:20", the weekday and the time within the week, else
    /// the date and the time (in the calendar's time zone).
    static func timeMark(_ ms: Double, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let style = { (day: Date.FormatStyle.DateStyle, time: Date.FormatStyle.TimeStyle) in
            Date.FormatStyle(date: day, time: time, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        }
        let time = date.formatted(style(.omitted, .shortened))
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        switch days {
        case 0: return "Today \(time)"
        case 1: return "Yesterday \(time)"
        case 2..<7: return "\(date.formatted(style(.omitted, .omitted).weekday(.wide))) \(time)"
        default: return date.formatted(style(.abbreviated, .shortened))
        }
    }

    /// Whether a kept chat holds what isn't on screen (the PWA's `keptDiffers`): a message more or fewer, another in a
    /// place, or one that ended or changed since (another device asked in it, retried, or stopped it). By the node's own
    /// ids, states and words; a turn of this device's not yet told its kept id is matched by its words and state.
    /// A kept chat read again with no turn in it to watch: the thread to show, or nil when what's on screen is what the
    /// node keeps. A message of this device's the node never took (it refused it, or never heard it) is kept nowhere else:
    /// it stays at the end, with why and Retry, unless the node holds that question after all (the PWA's `shownAgain`).
    static func shownAgain(shown: [ChatThread.Turn], kept: [StoredMessage], role: String) -> ChatThread? {
        let lastAsked = kept.last { $0.role == "user" }
        var untaken: [ChatThread.Turn] = []
        if shown.count >= 2 {
            let asked = shown[shown.count - 2], answer = shown[shown.count - 1]
            if answer.role == .assistant, answer.status == .error, answer.sid == nil, asked.role == .user, asked.sid == nil, lastAsked?.content != asked.content {
                untaken = [asked, answer]
            }
        }
        guard keptDiffers(shown: Array(shown.dropLast(untaken.count)), kept: kept) else { return nil }
        var thread = ChatThread(kept: kept, role: role)
        thread.keep(untaken)
        return thread
    }

    static func keptDiffers(shown: [ChatThread.Turn], kept: [StoredMessage]) -> Bool {
        guard shown.count == kept.count else { return true }
        return zip(shown, kept).contains { turn, message in
            (turn.sid != nil && turn.sid != message.id) || turn.status.rawValue != message.status || turn.content != message.content
        }
    }

    struct Group: Equatable, Sendable {
        let label: String
        var items: [ConversationSummary]
    }

    /// Pinned first, then by when they were last active: today, yesterday, this week, earlier (midnight where `calendar` is).
    static func groups(_ list: [ConversationSummary], now: Date = .now, calendar: Calendar = .current) -> [Group] {
        let today = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
        let day = 86_400_000.0
        var groups = ["Pinned", "Today", "Yesterday", "This week", "Earlier"].map { Group(label: $0, items: []) }
        for chat in list.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            let at = chat.updatedAt
            let index = chat.pinned ? 0 : at >= today ? 1 : at >= today - day ? 2 : at >= today - 6 * day ? 3 : 4
            groups[index].items.append(chat)
        }
        return groups.filter { !$0.items.isEmpty }
    }

    /// Every word of the query in the title or the project (any case).
    static func filter(_ list: [ConversationSummary], query: String) -> [ConversationSummary] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return list }
        return list.filter { chat in
            let text = "\(chat.title) \(chat.project ?? "")".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }

    /// The chat the primary's row opens: the one last active (a pin doesn't make one more recent). Nil: none kept yet.
    static func mostRecent(_ list: [ConversationSummary]) -> ConversationSummary? {
        list.max { $0.updatedAt < $1.updatedAt }
    }

    /// A chat's state in words, for the list ("" when there's nothing to say: it's done).
    static func stateWords(state: String, queued: Int, held: String?, needs: ConversationSummary.Needs?) -> String {
        let waiting = queued > 0 ? "\(queued) queued\(held.map { ", held (\(holdWords($0)))" } ?? "")" : ""
        switch state {
        case "working": return waiting.isEmpty ? "Working" : "Working · \(waiting)"
        case "waiting": return "Needs you: \(needs.map(needsWords) ?? "a look")\(waiting.isEmpty ? "" : " · \(waiting)")"
        case "queued": return waiting.prefix(1).uppercased() + waiting.dropFirst()
        case "stopped": return "Stopped"
        case "failed": return "Failed"
        default: return ""
        }
    }

    static func stateWords(_ chat: ConversationSummary) -> String {
        stateWords(state: chat.state, queued: chat.queued, held: chat.held, needs: chat.needs)
    }

    static func holdWords(_ held: String) -> String {
        switch held {
        case "stopped": "you stopped it"
        case "error": "the turn before them failed"
        case "restart": "the node restarted"
        default: "the device that queued the next one is no longer paired, or may not see this chat"
        }
    }

    /// What a chat needs from you, in a few words ("an approval", "2 approvals and a key", "an answer").
    static func needsWords(_ needs: ConversationSummary.Needs) -> String {
        let count = { (n: Int, one: String, many: String) in n == 1 ? one : "\(n) \(many)" }
        return [
            needs.approvals > 0 ? count(needs.approvals, "an approval", "approvals") : "",
            needs.keys > 0 ? count(needs.keys, "a key", "keys") : "",
            needs.question && needs.approvals == 0 && needs.keys == 0 ? "an answer" : "",
        ].filter { !$0.isEmpty }.joined(separator: " and ")
    }
}
