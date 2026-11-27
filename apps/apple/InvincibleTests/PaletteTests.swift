import Testing
@testable import Invincible

/// Search, or ask (⌘K, on an iPad and a Mac): what's typed finds the places by their titles and lines, and Needs you,
/// the Inbox until 27 November 2026, by that name too.
@MainActor
struct PaletteTests {
    @Test func needsYouIsFoundByItsOldNameTheInboxToo() {
        for words in ["inbox", "Inbox", "INB", "box"] {
            #expect(CommandPalette.places(matching: words, needsYou: 0).map(\.place) == [.inbox], "\(words)")
        }
        // By its own name too, beside Home, whose line says what needs you.
        #expect(CommandPalette.places(matching: "needs you", needsYou: 0).map(\.place) == [.home, .inbox])
        // Nothing typed: every place, Needs you saying how many need you.
        let all = CommandPalette.places(matching: "", needsYou: 2)
        #expect(all.map(\.place) == [.home, .primary, .agents, .inbox, .more])
        #expect(all.first { $0.place == .inbox }?.detail == "2 need you")
    }
}
