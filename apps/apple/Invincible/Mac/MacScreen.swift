#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import UniformTypeIdentifiers

/**
 * This Mac's own screen, for the primary's computer when that is this Mac (docs/AGENTS.md): a picture of it, and its
 * pointer and keys. The node runs it as `Invincible --desktop <op>` (MacMain.swift), so what it does is the app's to be
 * allowed: macOS lets an app record the screen and control the Mac only once you turn it on in System Settings →
 * Privacy & Security (Screen & System Audio Recording, and Accessibility), and `--desktop allow` asks for both.
 *
 * Every place is said in the main display's points, as its picture is taken at that size: a click at a place in the
 * picture lands there, whatever the display's pixels are.
 */
enum MacScreen {
    struct Refused: LocalizedError {
        let errorDescription: String?
    }

    /// Whether macOS lets this app record the screen.
    static var mayRecord: Bool { CGPreflightScreenCaptureAccess() }
    /// Whether macOS lets this app control the Mac (the pointer and keys).
    static var mayControl: Bool { AXIsProcessTrusted() }

    /// Asks for both: macOS shows its own prompt, or lists Invincible in System Settings for you to turn on.
    static func ask() {
        _ = CGRequestScreenCaptureAccess()
        // (kAXTrustedCheckOptionPrompt's own value: the constant is a global Swift 6 won't share across threads.)
        let prompt = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(prompt)
    }

    /// The main display's size, in points.
    static var size: CGSize { CGDisplayBounds(CGMainDisplayID()).size }

    /// A picture of the main display at its size in points, as JPEG, the pointer drawn in.
    static func shot() async throws -> Data {
        guard mayRecord else { throw Refused(errorDescription: "macOS doesn't let Invincible record this Mac's screen yet: turn it on in System Settings → Privacy & Security → Screen & System Audio Recording.") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw Refused(errorDescription: "This Mac has no display to take a picture of.")
        }
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration)
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw Refused(errorDescription: "The picture couldn't be written.") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Refused(errorDescription: "The picture couldn't be written.") }
        return out as Data
    }

    // MARK: The pointer and keys

    private static func controlled() throws {
        guard mayControl else { throw Refused(errorDescription: "macOS doesn't let Invincible control this Mac yet: turn it on in System Settings → Privacy & Security → Accessibility.") }
    }

    /// A place on the main display, kept on it.
    static func point(_ x: Double, _ y: Double) -> CGPoint {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return CGPoint(x: min(max(x, 0), bounds.width - 1) + bounds.minX, y: min(max(y, 0), bounds.height - 1) + bounds.minY)
    }

    static func move(to at: CGPoint) throws {
        try controlled()
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    /// A click (`count` 2: a double click) with the left, right or middle button.
    static func click(at: CGPoint, button: String = "left", count: Int = 1) throws {
        try controlled()
        let (down, up, which): (CGEventType, CGEventType, CGMouseButton) = switch button {
        case "right": (.rightMouseDown, .rightMouseUp, .right)
        case "middle": (.otherMouseDown, .otherMouseUp, .center)
        default: (.leftMouseDown, .leftMouseUp, .left)
        }
        try move(to: at)
        for n in 1...max(1, count) {
            for type in [down, up] {
                let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: which)
                event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                event?.post(tap: .cghidEventTap)
                // (An app reads a press and its release as a click only with a moment between them.)
                usleep(12_000)
            }
        }
    }

    /// The wheel, in lines: positive `down` scrolls the page down.
    static func scroll(down: Int, right: Int = 0) throws {
        try controlled()
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(-down), wheel2: Int32(-right), wheel3: 0)?.post(tap: .cghidEventTap)
    }

    /// Text as typed, whatever the keyboard's layout: a few characters to each key event.
    static func type(_ text: String) throws {
        try controlled()
        let units = Array(text.utf16)
        var at = 0
        while at < units.count {
            let chunk = Array(units[at..<min(at + 16, units.count)])
            for keyDown in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown)
                event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                event?.post(tap: .cghidEventTap)
            }
            at += chunk.count
        }
    }

    /// A key, or a chord, by name, as xdotool says them on an agent's desktop: `Return`, `Tab`, `Escape`,
    /// `BackSpace`, `Down`, `ctrl+l`, `super+space` (`super`, `cmd` and `command` are ⌘; `alt` and `option` ⌥).
    static func key(_ chord: String) throws {
        try controlled()
        let (code, flags) = try parse(chord: chord)
        for keyDown in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: keyDown)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    /// A chord's key and what is held with it (`ctrl+shift+t`: T, with ⌃ and ⇧).
    static func parse(chord: String) throws -> (code: CGKeyCode, flags: CGEventFlags) {
        var flags: CGEventFlags = []
        var code: CGKeyCode?
        for part in chord.split(separator: "+", omittingEmptySubsequences: false).map({ String($0) }) {
            switch part.lowercased() {
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "super", "cmd", "command", "meta", "win": flags.insert(.maskCommand)
            default:
                guard code == nil, let found = keyCode(part) else {
                    throw Refused(errorDescription: code == nil ? "No key is called \(part.isEmpty ? "+" : part)." : "\(chord) names two keys: send one, with what is held.")
                }
                code = found
            }
        }
        guard let code else { throw Refused(errorDescription: "\(chord) names no key, only how to hold it.") }
        return (code, flags)
    }

    /// A key's code on a Mac (the ANSI layout's, which is where macOS's codes are fixed), by its xdotool or plain name.
    static func keyCode(_ name: String) -> CGKeyCode? {
        let named: [String: CGKeyCode] = [
            "return": 36, "enter": 36, "kp_enter": 76, "tab": 48, "space": 49, "escape": 53, "esc": 53,
            "backspace": 51, "delete": 117, "forwarddelete": 117,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "home": 115, "end": 119, "page_up": 116, "pageup": 116, "prior": 116, "page_down": 121, "pagedown": 121, "next": 121,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
            "minus": 27, "equal": 24, "comma": 43, "period": 47, "slash": 44, "semicolon": 41, "apostrophe": 39,
            "bracketleft": 33, "bracketright": 30, "backslash": 42, "grave": 50,
        ]
        let lower = name.lowercased()
        if let code = named[lower] { return code }
        let characters: [Character: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
            "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
            "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
            "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
        ]
        guard lower.count == 1, let character = lower.first else { return nil }
        return characters[character]
    }

    /// An address in its app (a web page in the default browser), or an app by its name.
    static func open(_ target: String) throws {
        if let url = URL(string: target), let scheme = url.scheme, ["http", "https", "file", "mailto"].contains(scheme.lowercased()) {
            guard NSWorkspace.shared.open(url) else { throw Refused(errorDescription: "\(target) couldn't be opened.") }
            return
        }
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) ?? appNamed(target) else {
            throw Refused(errorDescription: "No app here is called \(target).")
        }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }

    private static func appNamed(_ name: String) -> URL? {
        let wanted = name.hasSuffix(".app") ? name : "\(name).app"
        for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities"] {
            let url = URL(fileURLWithPath: folder).appending(path: wanted)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    // MARK: What the node runs

    /// What the node reads of it, as one line of JSON: the screen's size in points, whether macOS lets Invincible record
    /// it and control it, what is in front (and its bundle id), and a question of macOS's on the screen, if one is.
    static func status() -> String {
        struct Status: Encodable { let width: Int; let height: Int; let record: Bool; let control: Bool; let front: String; let frontId: String; let asking: String? }
        let status = Status(width: Int(size.width), height: Int(size.height), record: mayRecord, control: mayControl, front: front(), frontId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "", asking: asking())
        return (try? String(decoding: JSONEncoder().encode(status), as: UTF8.self)) ?? "{}"
    }

    /// The processes macOS asks its questions through: a permission's consent, Accessibility's, a password, Gatekeeper's.
    static let presenters: Set<String> = ["UserNotificationCenter", "universalAccessAuthWarn", "SecurityAgent", "CoreServicesUIAgent", "coreautha", "LocalAuthenticationRemoteService"]

    /// A question of macOS's on the screen now (a window of one of its presenters'): the presenter, or nil.
    static func asking() -> String? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in windows {
            if let owner = window[kCGWindowOwnerName as String] as? String, presenters.contains(owner) { return owner }
            if let pid = window[kCGWindowOwnerPID as String] as? pid_t, let name = NSRunningApplication(processIdentifier: pid)?.executableURL?.lastPathComponent, presenters.contains(name) { return name }
        }
        return nil
    }

    static let usage = "usage: Invincible --desktop status | allow | shot | click <x> <y> [left|right|middle|double] | move <x> <y> | scroll <up|down> [times] | type <base64> | key <key>… | open <address|app> | front"

    /**
     * `Invincible --desktop <op> …`, as the node runs it, in the words and places of an agent's `desktop` command (its
     * xdotool key names, a click's buttons, scrolling by the wheel's turns), so one way of working fits both: `status`
     * and `allow` print the status line, `shot` a JPEG in base64, `front` what is in front, the rest nothing. Typed text
     * comes as base64, so no shell or argument list reads it. Exit 0, 1 when it failed, 2 when it was refused or asked
     * wrongly (the reason on stderr).
     */
    @MainActor static func run(_ arguments: [String]) async -> Int32 {
        func refuse(_ why: String) -> Int32 {
            FileHandle.standardError.write(Data("\(why)\n".utf8))
            return 2
        }
        let rest = Array(arguments.dropFirst())
        func place() -> CGPoint? {
            guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]), x >= 0, y >= 0 else { return nil }
            return point(x, y)
        }
        do {
            switch arguments.first {
            case "status":
                print(status())
            case "allow":
                ask()
                print(status())
            case "shot":
                FileHandle.standardOutput.write(try await shot().base64EncodedData())
            case "front":
                print(front())
            case "click":
                guard let at = place() else { return refuse("click <x> <y> [left|right|middle|double]") }
                let button = rest.count > 2 ? rest[2] : "left"
                guard ["left", "right", "middle", "double"].contains(button) else { return refuse("click <x> <y> [left|right|middle|double]") }
                try click(at: at, button: button == "double" ? "left" : button, count: button == "double" ? 2 : 1)
            case "move":
                guard let at = place() else { return refuse("move <x> <y>") }
                try move(to: at)
            case "scroll":
                guard let direction = rest.first, direction == "up" || direction == "down" else { return refuse("scroll <up|down> [times]") }
                let times = rest.count > 1 ? Int(rest[1]) ?? 0 : 3
                guard (1...50).contains(times) else { return refuse("scroll <up|down> [times]: 1 to 50 turns") }
                // (A turn of the wheel is three lines, as on an agent's desktop.)
                try scroll(down: (direction == "down" ? 1 : -1) * times * 3)
            case "type":
                guard rest.count == 1, let data = Data(base64Encoded: rest[0]), let text = String(data: data, encoding: .utf8), !text.isEmpty else { return refuse("type <the text, in base64>") }
                try type(text)
            case "key":
                guard !rest.isEmpty else { return refuse("key <key>…") }
                for chord in rest {
                    try key(chord)
                }
            case "open":
                guard rest.count == 1 else { return refuse("open <address|app>") }
                try open(rest[0])
            default:
                return refuse(usage)
            }
        } catch let refused as Refused {
            return refuse(refused.errorDescription ?? "refused")
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            return 1
        }
        // (Events posted are delivered after this returns; a moment lets them land before the process ends.)
        try? await Task.sleep(for: .milliseconds(60))
        return 0
    }

    /// The app in front, and its front window's title (with Accessibility), for saying where things stand.
    static func front() -> String {
        guard let app = NSWorkspace.shared.frontmostApplication else { return "nothing in front" }
        var title = ""
        if mayControl {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            var window: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success, let window {
                var value: CFTypeRef?
                // swiftlint:disable:next force_cast
                if AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &value) == .success, let text = value as? String { title = text }
            }
        }
        return title.isEmpty ? (app.localizedName ?? "an app") : "\(app.localizedName ?? "an app"): \(title)"
    }
}
#endif
