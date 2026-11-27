import Foundation

/// A notification's payload as the node keeps it for a device that collects its own (the Mac app, from
/// `POST /api/notify/collect`), read as strictly as core's readNotifyPayload reads it (notify-payload.ts; the web app's
/// service worker and the Android app's NotifyPayload.kt the same), held to the vectors: exactly its fields, bounded,
/// nothing hidden in its words. Anything else is no payload of ours, and is shown only as `generic`.
struct NotifyPayload: Equatable, Sendable {
    let kind: String
    let title: String
    let body: String
    let open: String
    /// A kept chat to open (with `open` "chat").
    let conversation: String?
    /// An agent's task to open (with `open` "task"), and whether its work can be shipped from the notification.
    let task: String?
    let ship: Bool
    /// The same thing told again replaces its notification: its identifier where it shows.
    let tag: String
    /// An approval's own action (kind "approval"), answered from the notification: Approve… and Decline, or Decline alone.
    let action: String?
    let approvable: Bool

    static let titleMax = 60
    static let bodyMax = 140
    private static let kinds: Set<String> = ["needs-you", "approval", "finished", "question", "told", "summary", "limit", "test"]
    private static let opens: Set<String> = ["inbox", "chat", "overview", "settings", "task"]
    private static let fields: Set<String> = ["v", "kind", "title", "body", "open", "conversation", "task", "ship", "tag", "action", "approvable"]
    // The whole text and nothing else, as core's anchored patterns take it.
    private static let chatId = #"\Acv_[A-Za-z0-9_-]{22}\z"#
    private static let taskId = #"\Atask-[a-z0-9_-]{12}\z"#
    private static let actionId = #"\Aa_[A-Za-z0-9_-]{22}\z"#
    private static let tagId = #"\A[A-Za-z0-9._:-]{1,64}\z"#
    private static func valid(_ id: String, _ pattern: String) -> Bool { id.range(of: pattern, options: .regularExpression) != nil }

    /// What's shown when what came can't be read as one of ours (core's GENERIC_NOTIFICATION).
    static let generic = NotifyPayload(kind: "needs-you", title: "Invincible", body: "Something needs you. Open the app to see it.", open: "inbox", conversation: nil, task: nil, ship: false, tag: "primary", action: nil, approvable: false)

    /// A payload read strictly: exactly the fields above, bounded, nothing hidden in the text. Anything else is nil.
    static func read(_ raw: JSONValue?) -> NotifyPayload? {
        guard let p = raw?.object, p.keys.allSatisfy(fields.contains) else { return nil }
        guard p["v"] == .number(1), let kind = p["kind"]?.string, kinds.contains(kind) else { return nil }
        guard let title = p["title"]?.string, let body = p["body"]?.string, let tag = p["tag"]?.string, valid(tag, tagId) else { return nil }
        guard let open = p["open"]?.string, opens.contains(open) else { return nil }
        // Each of these, when it's there at all (even as null), is what it must be, where it may be.
        if let conversation = p["conversation"], !(conversation.string.map { valid($0, chatId) } == true && open == "chat") { return nil }
        if let task = p["task"], !(task.string.map { valid($0, taskId) } == true && open == "task") { return nil }
        if let ship = p["ship"], ship.bool == nil || p["task"] == nil { return nil }
        if let action = p["action"], !(action.string.map { valid($0, actionId) } == true && kind == "approval") { return nil }
        if let approvable = p["approvable"], approvable.bool == nil || p["action"] == nil { return nil }
        let cleanTitle = clean(title, max: titleMax)
        guard !cleanTitle.isEmpty, same(cleanTitle, title), same(clean(body, max: bodyMax), body) else { return nil }
        let task = p["task"]?.string
        let action = p["action"]?.string
        return NotifyPayload(
            kind: kind, title: title, body: body, open: open, conversation: p["conversation"]?.string, task: task,
            ship: task != nil && p["ship"]?.bool == true, tag: tag, action: action, approvable: action != nil && p["approvable"]?.bool == true)
    }

    /// Text as a notification may carry it (core's notifyClean): one line, nothing hidden, cut to `max` UTF-16 units with
    /// an ellipsis, as JavaScript counts them.
    static func clean(_ text: String, max: Int) -> String {
        var line: [UInt16] = []
        var gap = false
        for unit in text.utf16 {
            let u = hidden(unit) ? 0x20 : unit
            if space(u) {
                gap = true
            } else {
                if gap && !line.isEmpty { line.append(0x20) }
                gap = false
                line.append(u)
            }
        }
        guard line.count > max else { return String(decoding: line, as: UTF16.self) }
        var cut = Array(line.prefix(max - 1))
        while let last = cut.last, space(last) { cut.removeLast() }
        return String(decoding: cut, as: UTF16.self) + "…"
    }

    /// Control characters, bidirectional overrides and isolates, zero-width characters (core's HIDDEN): nothing a lock
    /// screen should act on.
    private static func hidden(_ u: UInt16) -> Bool {
        u <= 0x1F || (0x7F...0x9F).contains(u) || (0x200B...0x200F).contains(u) || (0x202A...0x202E).contains(u) || (0x2060...0x2069).contains(u) || u == 0xFEFF
    }

    /// JavaScript's white space and line ends (what its `\s` and `trim()` take).
    private static func space(_ u: UInt16) -> Bool {
        (0x09...0x0D).contains(u) || u == 0x20 || u == 0xA0 || u == 0x1680 || (0x2000...0x200A).contains(u) || u == 0x2028 || u == 0x2029
            || u == 0x202F || u == 0x205F || u == 0x3000 || u == 0xFEFF
    }

    /// The same text as JavaScript compares it, unit by unit (Swift's == would take canonically equal text as one).
    private static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
}

extension NotifyPayload {
    /// News: told without a sound or a banner over what you do (core's quiet kinds).
    var quiet: Bool { ["finished", "told", "limit"].contains(kind) }

    /// Its buttons (the node's APPLE_CATEGORY, as the iPhone is sent them): an approval's Approve… and Decline, its Decline
    /// alone (a delete, approved only where its name is typed), Ship it…, or none.
    var category: String? { action != nil ? (approvable ? Push.Button.approval : Push.Button.declineOnly) : ship ? Push.Button.ship : nil }

    /// Ours, as an iPhone's notification carries it (apns-send.ts applePayload's `invincible`): where a tap opens, the tag,
    /// and an approval's action or a task's ship, so Push reads a notification shown here as it reads one pushed there.
    var userInfo: [String: Any] {
        var ours: [String: Any] = ["v": 1, "kind": kind, "open": open, "tag": tag]
        if let conversation { ours["conversation"] = conversation }
        if let task {
            ours["task"] = task
            if ship { ours["ship"] = true }
        }
        if let action { ours["action"] = action }
        return ["invincible": ours]
    }
}
