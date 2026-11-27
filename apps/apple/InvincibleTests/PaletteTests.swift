import Testing
@testable import Invincible

/// Search, or ask (⌘K, on an iPad and a Mac): what's typed finds the places by their titles and lines, and Needs you
/// and the work, the Inbox and Home until 27 November 2026, by those names too.
@MainActor
struct PaletteTests {
    @Test func needsYouIsFoundByItsOldNameTheInboxToo() {
        for words in ["inbox", "Inbox", "INB", "box"] {
            #expect(CommandPalette.places(matching: words, needsYou: 0).map(\.place) == [.inbox], "\(words)")
        }
        // By its own name too, beside the work, whose line says what needs you.
        #expect(CommandPalette.places(matching: "needs you", needsYou: 0).map(\.place) == [.home, .inbox])
        // Nothing typed: every place, your agent's chat first, Needs you saying how many need you.
        let all = CommandPalette.places(matching: "", needsYou: 2)
        #expect(all.map(\.place) == [.primary, .home, .agents, .inbox, .more])
        #expect(all.first { $0.place == .inbox }?.detail == "2 need you")
    }

    @Test func theWorkIsFoundByItsOldNameHomeToo() {
        #expect(CommandPalette.places(matching: "home", needsYou: 0).map(\.place) == [.home])
        #expect(CommandPalette.places(matching: "work", needsYou: 0).map(\.place) == [.home])
    }
}
