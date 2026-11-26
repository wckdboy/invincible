import Foundation
import Testing
@testable import Invincible

/// The chats list is the PWA's (`apps/web/src/lib/chats.ts`, core's `chatStateWords`): its headings, its order, and
/// each chat's state in the PWA's own words.
struct ChatsTests {
    let chats = Vectors.shared.chats

    @Test func pinnedFirstThenByWhenEachWasLastActive() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let groups = Chats.groups(chats.list, now: Date(timeIntervalSince1970: chats.now / 1000), calendar: utc)
        #expect(groups.map(\.label) == chats.groups.map(\.label))
        #expect(groups.map { $0.items.map(\.id) } == chats.groups.map(\.ids))
    }

    @Test func aChatChangedOnAnotherDeviceIsShownAgainWhereThePWAWouldShowItAgain() {
        let shown = ChatThread(kept: chats.changes.shown, role: "planner").turns
        for change in chats.changes.cases {
            #expect(Chats.keptDiffers(shown: shown, kept: change.kept) == change.differs, "\(change.name)")
        }
        // This device's own exchange, its kept ids not yet known on screen: matched by its words and state.
        let own = shown.map { turn in var unknown = turn; unknown.sid = nil; return unknown }
        for change in chats.changes.own {
            #expect(Chats.keptDiffers(shown: own, kept: change.kept) == change.differs, "\(change.name)")
        }
    }

    @Test func aSendTheNodeNeverTookStaysOnScreenWithWhyAsInThePWA() {
        #expect(!chats.changes.again.isEmpty)
        for item in chats.changes.again {
            var thread = ChatThread(kept: chats.changes.shown, role: "planner")
            thread.begin(question: chats.changes.refused.question, role: "planner")
            thread.fail(chats.changes.refused.error)
            let again = Chats.shownAgain(shown: thread.turns, kept: item.kept, role: "planner")
            #expect(again?.turns.map { [$0.role.rawValue, $0.content, $0.status.rawValue, $0.error ?? "-"] } == item.shown?.map { [$0.role, $0.content, $0.status, $0.error ?? "-"] }, "\(item.name)")
        }
    }

    @Test func eachChatsStateIsSaidInThePWAsWords() {
        for state in chats.states {
            #expect(Chats.stateWords(state: state.state, queued: state.queued, held: state.held, needs: state.needs) == state.words)
        }
    }

    @Test func searchFindsEveryWordInTheTitleAndPrimaryRowOpensTheLatest() {
        #expect(Chats.filter(chats.list, query: "  JUST  now ").map(\.id) == ["just-now"])
        #expect(Chats.filter(chats.list, query: "").count == chats.list.count)
        // A pin doesn't make a chat more recent.
        #expect(Chats.mostRecent(chats.list)?.id == "just-now")
        #expect(Chats.mostRecent([]) == nil)
    }
}
