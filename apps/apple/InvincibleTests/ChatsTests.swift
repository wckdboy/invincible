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

/// A chat says when it went on, small and centred (the lead's ask of 28 November 2026, after Grok Bot): over its first
/// turn, then over each said on another day, or after a quarter of an hour's pause; answers under what they answer.
struct ChatTimeMarkTests {
    private func turn(_ id: Int, _ role: ChatThread.Turn.Role = .user, at: Double?) -> ChatThread.Turn {
        ChatThread.Turn(id: id, role: role, content: "\(id)", steps: [], status: .done, at: at)
    }

    @Test func aChatIsMarkedAtItsStartAtANewDayAndAfterAPause() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let morning = 1_795_600_000_000.0 - 1_795_600_000_000.0.truncatingRemainder(dividingBy: 86_400_000) + 9 * 3_600_000
        let minute = 60_000.0
        let turns = [
            turn(1, at: morning), turn(2, .assistant, at: nil),
            turn(3, at: morning + 14 * minute), turn(4, .assistant, at: nil),
            turn(5, at: morning + 29 * minute),
            turn(6, at: morning + 15 * 3_600_000),
            turn(7, at: morning + 24 * 3_600_000),
        ]
        #expect(Chats.timeMarks(turns, calendar: calendar) == [1: morning, 5: morning + 29 * minute, 7: morning + 24 * 3_600_000, 6: morning + 15 * 3_600_000])
        #expect(Chats.timeMarks([], calendar: calendar).isEmpty)
        #expect(Chats.timeMarks([turn(1, at: nil)], calendar: calendar).isEmpty)
    }

    @Test func aMarkSaysTheDayAsPeopleSayIt() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_US")
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 15)))
        let ms = { (date: Date) in date.timeIntervalSince1970 * 1000 }
        let morning = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 9, minute: 41)))
        #expect(Chats.timeMark(ms(morning), now: now, calendar: calendar, locale: locale).hasPrefix("Today 9:41"))
        let yesterday = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 27, hour: 18, minute: 20)))
        #expect(Chats.timeMark(ms(yesterday), now: now, calendar: calendar, locale: locale).hasPrefix("Yesterday 6:20"))
        let tuesday = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: 10)))
        #expect(Chats.timeMark(ms(tuesday), now: now, calendar: calendar, locale: locale).hasPrefix("Tuesday 10:00"))
        let october = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 2, hour: 10)))
        #expect(Chats.timeMark(ms(october), now: now, calendar: calendar, locale: locale).contains("Oct"))
    }

    /// A chat's marks as every app makes them (lib/chats.ts timeMarks and lib/time.ts timeMark, by the vectors' chatMarks):
    /// which of its messages are marked, an answer's unknown time never counting, and the mark's words for a phone in
    /// British English and one in Danish, in the app's English with the phone's region.
    @Test func aChatsMarksAreTheOnesEveryAppMakes() throws {
        let marks = Vectors.shared.chatMarks
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: marks.zone))
        let turns = marks.ats.enumerated().map { turn($0.offset, $0.element == nil ? .assistant : .user, at: $0.element) }
        #expect(Chats.timeMarks(turns, calendar: calendar).keys.sorted() == marks.marked)
        #expect(marks.devices.count == 2)
        let now = Date(timeIntervalSince1970: marks.now / 1000)
        for device in marks.devices {
            for item in device.cases {
                #expect(Chats.timeMark(item.at, now: now, calendar: calendar, locale: Locale(identifier: device.device)) == item.words, "\(device.device) \(item.at)")
            }
        }
    }
}
