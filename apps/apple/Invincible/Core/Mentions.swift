import Foundation

/// Naming an agent with @ as you write to a room: the name being typed, and the agents it may be, completed to the
/// handle the node reads (TeamStore's `mentioned`: an agent's id, or the primary's).
enum Mentions {
    struct Seat: Equatable, Sendable {
        let id: String
        let name: String
    }

    /// What follows an @ at the end of what you've written (at its start, or after a space or a new line), or nil.
    static func typing(_ draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        let before = draft[..<at].last
        guard before == nil || before!.isWhitespace else { return nil }
        let word = draft[draft.index(after: at)...]
        guard word.count <= 32, word.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
        return String(word)
    }

    /// The seats a name being typed may be: those whose handle or name begins with it (all of them for a bare @),
    /// handles first, at most six.
    static func matches(_ typed: String, in seats: [Seat]) -> [Seat] {
        let q = typed.lowercased()
        let byHandle = seats.filter { $0.id.lowercased().hasPrefix(q) }
        let byName = seats.filter { !byHandle.contains($0) && $0.name.lowercased().hasPrefix(q) }
        return Array((byHandle + byName).prefix(6))
    }

    /// What you've written with the name being typed made the seat's handle, and a space after it.
    static func complete(_ draft: String, with seat: Seat) -> String {
        guard typing(draft) != nil, let at = draft.lastIndex(of: "@") else { return draft }
        return String(draft[..<at]) + "@\(seat.id) "
    }
}
