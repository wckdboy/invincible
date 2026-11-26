import Foundation

/// What the message box does while the primary works, and the words around it (the PWA's lib/turns.ts, held to it by the
/// vectors' `composer`): what sending does, a side question typed into it, and what waits above it.
enum ComposerWords {
    /// What Return does while it works, on this device (Settings → Chat; steer unless you chose otherwise).
    enum Enter: String, Sendable { case steer, queue }
    enum Action: String, Sendable { case send, steer, queue }

    /// What sending does: with nothing running it sends; while it works, Return does what this device chose and ⌘ (or a
    /// modifier) with it the other; where nothing can be queued (a chat the node doesn't keep yet), both steer.
    static func action(busy: Bool, enter: Enter, modifier: Bool, canQueue: Bool) -> Action {
        guard busy else { return .send }
        guard canQueue else { return .steer }
        let chosen: Action = enter == .steer ? .steer : .queue
        return modifier ? (chosen == .steer ? .queue : .steer) : chosen
    }

    /// A side question typed into the box ("/btw how long will this take?"), or nil when it isn't one.
    static func aside(_ text: String) -> String? {
        let pattern = /^\s*\/(?:btw|aside)(?:\s+([\s\S]*))?$/.ignoresCase()
        guard let found = text.wholeMatch(of: pattern) else { return nil }
        return (found.1.map(String.init) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The line over messages sent to steer it that haven't reached it yet.
    static func steering(_ count: Int) -> String {
        "On \(count == 1 ? "its" : "their") way to it: it's told at its next safe point (a tool that's running finishes first)"
    }

    /// The queue's head: how many, and what becomes of them; held, why, and that nothing goes until you resume.
    static func queueHead(queued: Int, held: String?, busy: Bool) -> (count: String, rest: String) {
        let count = "\(queued) \(queued == 1 ? "message" : "messages")"
        if let held { return ("\(count) held", ": \(Chats.holdWords(held)). Nothing is sent until you resume.") }
        return ("\(count) queued", busy ? ": sent in order when it's done with this turn." : ": waiting for room on the node.")
    }

    /// Messages of yours that hadn't reached it when its turn ended: queued first and held in a kept chat, back in the box
    /// otherwise.
    static func undelivered(texts: Int, queued: Bool) -> (title: String, detail: String) {
        queued
            ? ("\(texts) \(texts == 1 ? "message" : "messages") didn't reach it before the turn ended", "Queued, first in line, and held until you resume.")
            : ("Your message didn't reach it before the turn ended", "It's back in the message box.")
    }

    /// The message box while it works.
    static func placeholder(canQueue: Bool) -> String { canQueue ? "Steer it, or queue what's next…" : "Steer it…" }

    /// A steer sent before the node has said which turn it is.
    static let justStarting = "It's only just starting: try again in a moment."

    /// A queue's change asked of a chat the node doesn't keep (a new one, until its first answer is kept).
    static let notKept = "This chat isn't kept, so nothing is queued behind it."

    /// Why files didn't go with a message sent while it works.
    static let filesWait = "Files go with your next message, once it's done: wait for it, or stop it first."

    /// A side question's note: what it's answered from, and that it changes nothing unless brought back.
    static func asideNote(working: Bool) -> String {
        working
            ? "Answered apart, from this chat and what it's said and done so far in this turn. It doesn't change what it's doing, and it never sees it unless you bring it back."
            : "Answered apart, from what this chat holds. It isn't added to the chat unless you bring it back."
    }

    /// What Bring back did: steered the turn under way, or joined the chat.
    static func broughtBack(_ how: String) -> String {
        how == "steered" ? "Brought back: it reaches it at its next safe point" : "Brought back: it's in the chat now"
    }

    /// What a side question's box suggests: about the work under way, or about what the chat holds.
    static func asidePlaceholder(working: Bool) -> String { working ? "e.g. What is it waiting on?" : "e.g. Which file was that in?" }

    /// While a side question's answer hasn't begun.
    static let asideAnswering = "Answering on the side…"

    /// The titles of what went wrong with a side question: its answer, and bringing it back.
    static let asideFailed = "It couldn't answer on the side"
    static let bringBackFailed = "Couldn't bring it back"

    /// A side question asked before there's anything to ask it about.
    static let nothingYet = (title: "Nothing to ask on the side yet", detail: "A side question is about a chat: ask something first.")
}
