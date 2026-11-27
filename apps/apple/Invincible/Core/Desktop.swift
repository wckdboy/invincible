import CoreGraphics
import Foundation

/*
 * An agent's desktop, watched and taken over (POST /api/team/desktop), as the PWA's lib/desktop.ts reads it: where a
 * tap on the picture lands on the agent's own screen, what counts as an address for its browser, the picture the node
 * sends, and the node's refusal that a VM has no desktop.
 */

/// What comes back from every look and everything done: the screen as it then is, and its size in its own pixels; and
/// whether you have the desktop (`held`: nil when you don't, or from a VM whose image is older than take-over).
struct DesktopShot: Decodable, Sendable, Equatable {
    struct Shot: Decodable, Sendable, Equatable { let mediaType: String; let data: String }
    let shot: Shot
    let width: Int
    let height: Int
    var held: DesktopHold? = nil
}

/// One thing done on an agent's desktop, as the node takes it (core's DesktopAction).
enum DesktopAction: Encodable, Sendable, Equatable {
    case click(x: Int, y: Int)
    case scroll(up: Bool, times: Int)
    case type(String)
    case key(String)
    case open(String)

    private enum Keys: String, CodingKey { case `do`, x, y, direction, times, text, keys, address }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .click(let x, let y): try c.encode("click", forKey: .do); try c.encode(x, forKey: .x); try c.encode(y, forKey: .y)
        case .scroll(let up, let times): try c.encode("scroll", forKey: .do); try c.encode(up ? "up" : "down", forKey: .direction); try c.encode(times, forKey: .times)
        case .type(let text): try c.encode("type", forKey: .do); try c.encode(text, forKey: .text)
        case .key(let key): try c.encode("key", forKey: .do); try c.encode([key], forKey: .keys)
        case .open(let address): try c.encode("open", forKey: .do); try c.encode(address, forKey: .address)
        }
    }
}

enum Desktop {
    /// The keys offered beside the picture, by the names X gives them (lib/desktop.ts' DESKTOP_KEYS).
    static let keys: [(label: String, key: String)] = [("Return", "Return"), ("Tab", "Tab"), ("Escape", "Escape"), ("Backspace", "BackSpace")]

    /// A tap on the picture as a place on the agent's screen, in the screen's own pixels: `shown` is the picture as
    /// it is drawn. Nil for a tap beside it, or on a picture not drawn yet (lib/desktop.ts' `screenPoint`).
    static func point(tap: CGPoint, shown: CGRect, screen: (width: Int, height: Int)) -> (x: Int, y: Int)? {
        guard shown.width > 0, shown.height > 0 else { return nil }
        let across = (tap.x - shown.minX) / shown.width
        let down = (tap.y - shown.minY) / shown.height
        guard across >= 0, across <= 1, down >= 0, down <= 1 else { return nil }
        return (min(screen.width - 1, Int((across * CGFloat(screen.width)).rounded(.down))), min(screen.height - 1, Int((down * CGFloat(screen.height)).rounded(.down))))
    }

    /// An address as the desktop's browser takes it: http, https, file or about as written, a bare host with https;
    /// nil: not one (lib/desktop.ts' `desktopAddress`).
    static func address(_ text: String) -> String? {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty || typed.contains(where: \.isWhitespace) { return nil }
        let address: String?
        if typed.prefixMatch(of: #/(https?:\/\/|file:\/\/|about:)/#) != nil {
            address = typed
        } else if typed.prefixMatch(of: #/[a-zA-Z][a-zA-Z0-9+.\-]*:(?!\d)/#) != nil {
            // (A colon before a digit is a port, not a scheme: localhost:3000.)
            address = nil
        } else {
            address = "https://\(typed)"
        }
        return address.flatMap { $0.utf16.count <= 2000 ? $0 : nil }
    }

    /// The picture's bytes: a JPEG or a PNG in base64 of a screen with a size, and nothing else (lib/desktop.ts' `shotSource`).
    static func picture(_ view: DesktopShot) -> Data? {
        guard ["image/jpeg", "image/png"].contains(view.shot.mediaType), !view.shot.data.isEmpty,
              view.shot.data.wholeMatch(of: #/[A-Za-z0-9+\/]+={0,2}/#) != nil, view.width > 0, view.height > 0 else { return nil }
        return Data(base64Encoded: view.shot.data)
    }

    /// The node's refusal that this VM has no desktop (it says how to get one), told apart from every other.
    static func saysNoDesktop(_ error: any Error) -> Bool {
        guard let refusal = error as? NodeError else { return false }
        return refusal.status == 424 && refusal.message.contains("no desktop")
    }
}
