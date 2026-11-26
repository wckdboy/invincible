#if os(macOS)
import CoreGraphics
import Testing
@testable import Invincible

/// This Mac's screen as the primary's computer (Mac/MacScreen.swift): a key or a chord named as an agent's desktop names it
/// (xdotool's names), each on the Mac's own key and with what is held.
struct MacScreenTests {
    @Test func keysAreNamedAsAnAgentsDesktopNamesThem() throws {
        #expect(try MacScreen.parse(chord: "Return").code == 36)
        #expect(try MacScreen.parse(chord: "BackSpace").code == 51)
        #expect(try MacScreen.parse(chord: "Escape").code == 53)
        #expect(try MacScreen.parse(chord: "Down").code == 125)
        #expect(try MacScreen.parse(chord: "Page_Down").code == 121)
        let copy = try MacScreen.parse(chord: "super+c")
        #expect(copy.code == 8 && copy.flags == .maskCommand)
        let back = try MacScreen.parse(chord: "ctrl+shift+Tab")
        #expect(back.code == 48 && back.flags == [.maskControl, .maskShift])
        #expect(try MacScreen.parse(chord: "cmd+space").flags == .maskCommand)
        #expect(try MacScreen.parse(chord: "alt+F4").flags == .maskAlternate)
    }

    @Test func aChordWithNoKeyTwoKeysOrAnUnknownOneIsRefusedWithWhy() {
        #expect(throws: MacScreen.Refused.self) { try MacScreen.parse(chord: "ctrl") }
        #expect(throws: MacScreen.Refused.self) { try MacScreen.parse(chord: "Nope") }
        #expect(throws: MacScreen.Refused.self) { try MacScreen.parse(chord: "a+b") }
        #expect(throws: MacScreen.Refused.self) { try MacScreen.parse(chord: "") }
    }
}
#endif
