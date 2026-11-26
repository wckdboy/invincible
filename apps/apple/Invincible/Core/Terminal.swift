import Foundation

/*
 * A terminal in a sandbox on your node (an agent's VM): the node's record of one (core's TerminalView), what watching it
 * sends (core's TerminalEvent), what is typed sent in order (core's terminal-input.ts), and the addresses a sign-in
 * prints, picked out of what it shows so a phone can open them.
 */

/// A terminal open on the node.
struct TerminalRecord: Decodable, Sendable, Equatable {
    let id: String
    let sandbox: String
    let cols: Int
    let rows: Int
    /// Nil while its shell runs.
    let exitCode: Int?
}

/// What watching a terminal sends: what it shows (base64), and its shell's end.
enum TerminalEvent: Equatable, Sendable {
    case output(String)
    case exit(Int)

    init?(json: String) {
        struct Frame: Decodable { let type: String; let data: String?; let code: Int? }
        guard let frame = try? JSONDecoder().decode(Frame.self, from: Data(json.utf8)) else { return nil }
        switch frame.type {
        case "output": guard let data = frame.data else { return nil }; self = .output(data)
        case "exit": self = .exit(frame.code ?? 0)
        default: return nil
        }
    }
}

/// A terminal's size in characters.
struct TerminalSize: Codable, Sendable, Equatable { let cols: Int; let rows: Int }

/// One request's worth of what was typed, and the size it has now (core's TerminalInput).
struct TerminalInput: Encodable, Sendable, Equatable {
    var data: String?
    var size: TerminalSize?
}

/**
 * What is typed into a terminal, sent in order (core's `inputQueue`): one request at a time, and what is typed (or a new
 * size) while one is on its way goes next, together, the latest size only. A request that fails is told, and nothing
 * more is sent after it. A paste larger than one request goes in pieces, in order.
 */
@MainActor final class TerminalInputQueue {
    /// The most one request carries (the route's limit), in UTF-16 units as the node counts them.
    static let maxData = 65_536
    private let send: (TerminalInput) async throws -> Void
    private let failed: (any Error) -> Void
    private var typed = ""
    private var size: TerminalSize?
    private var sending = false
    private var broken = false

    init(send: @escaping (TerminalInput) async throws -> Void, failed: @escaping (any Error) -> Void) {
        self.send = send
        self.failed = failed
    }

    func type(_ data: String) { typed += data; flush() }
    func resize(_ next: TerminalSize) { size = next; flush() }
    var idle: Bool { !sending }

    private func flush() {
        guard !broken, !sending, !typed.isEmpty || size != nil else { return }
        // A piece never splits a character: it ends at the last whole one within the limit.
        var piece = ""
        var units = 0
        for character in typed {
            let count = String(character).utf16.count
            if units + count > Self.maxData { break }
            piece.append(character)
            units += count
        }
        typed.removeFirst(piece.count)
        let input = TerminalInput(data: piece.isEmpty ? nil : piece, size: size)
        size = nil
        sending = true
        Task {
            do {
                try await send(input)
                sending = false
                flush()
            } catch {
                sending = false
                broken = true
                failed(error)
            }
        }
    }
}

enum Terminals {
    /// What a terminal shows, as text: its escape sequences (colours, moves, titles) taken out.
    static func plain(_ text: String) -> String {
        text.replacing(#/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/#, with: "")
    }

    /// The web addresses in what a terminal showed, in order: a sign-in's page to open on the phone.
    static func links(in text: String) -> [URL] {
        plain(text).matches(of: #/https?:\/\/[^\s"'<>`]+/#).compactMap { match in
            let raw = String(match.output).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:)]}"))
            return URL(string: raw).flatMap { ["https", "http"].contains($0.scheme ?? "") && $0.host() != nil ? $0 : nil }
        }
    }
}
