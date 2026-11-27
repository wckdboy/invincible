import SwiftUI
import Testing
@testable import Invincible

/// The roster marks the place on screen itself, on a quiet ground (RosterMark), never with a list's selection: on 27
/// November 2026 an iPad's sidebar drew its chosen row in the ink, white on a dark page, with white words on it. Which row
/// a place marks: its own; a task's, its agent's (your agent's own for one of its tasks); Everything else for the places it
/// lists; none for a Mac's own place.
@MainActor
struct RosterMarkingTests {
    let assignee: @MainActor (String) -> String? = { ["task-writer": "writer", "task-own": "primary"][$0] }

    @Test func eachPlaceMarksItsOwnRow() {
        for place in [Place.primary, .inbox, .home, .more, .everything, .agent("ada"), .room("forge")] {
            #expect(RosterList<EmptyView>.marked(place, assignee: assignee) == place, "\(place)")
        }
    }

    @Test func aTaskMarksItsAgentsRowAndAPlaceListedElsewhereMarksEverythingElse() {
        #expect(RosterList<EmptyView>.marked(.task("task-writer"), assignee: assignee) == .agent("writer"))
        #expect(RosterList<EmptyView>.marked(.task("task-own"), assignee: assignee) == .primary)
        #expect(RosterList<EmptyView>.marked(.task("task-gone"), assignee: assignee) == nil)
        for place in [Place.agents, .chats, .keys, .connectors] {
            #expect(RosterList<EmptyView>.marked(place, assignee: assignee) == .everything, "\(place)")
        }
        #expect(RosterList<EmptyView>.marked(.thisMac, assignee: assignee) == nil)
        #expect(RosterList<EmptyView>.marked(nil, assignee: assignee) == nil)
    }
}
