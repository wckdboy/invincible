import Foundation
import Testing
@testable import Invincible

/// The agents say what the PWA says (`apps/web/src/lib/roster.ts`, `lib/now.ts`): checked against its own output.
struct RosterTests {
    let vectors = Vectors.shared
    var agents: Vectors.AgentsSection { vectors.agents }

    @Test func everyAgentsLineAndMarkAreThePWAs() {
        let rows = Roster.rows(snapshot: agents.snapshot, asks: agents.asks)
        #expect(rows.map(\.id) == agents.rows.map(\.id))
        for (row, expected) in zip(rows, agents.rows) {
            #expect(row.line == expected.line, "\(row.id)")
            #expect(row.needs == expected.needs, "\(row.id)")
        }
    }

    @Test func everyAgentsStateIsThePWAs() {
        let rows = Roster.rows(snapshot: agents.snapshot, asks: agents.asks, now: agents.now)
        #expect(rows.map(\.id) == agents.rows.map(\.id))
        for (row, expected) in zip(rows, agents.rows) {
            #expect(row.standing.rawValue == expected.state, "\(row.id)")
        }
        for item in agents.primary {
            #expect(Standing.of(PrimaryNow(item.input), answering: false).rawValue == item.state, "\(item.text)")
        }
    }

    @Test func whatIsNewToYouIsWhatThePWASays() {
        let unread = vectors.unread
        let agents = Roster.rows(snapshot: unread.snapshot, asks: [], now: agents.now)
        let rooms = Roster.roomRows(snapshot: unread.snapshot)
        let expected = unread.rows
        #expect(agents.map(\.id) == expected.filter { $0.kind == "agent" }.map(\.id))
        for (row, want) in zip(agents, expected.filter { $0.kind == "agent" }) {
            #expect(row.unread == want.unread, "\(row.id)")
            #expect(row.standing.rawValue == want.state, "\(row.id)")
            #expect(row.line == want.line, "\(row.id)")
        }
        // (The PWA lists rooms the latest spoken in first, as the app does.)
        #expect(Set(rooms.map(\.id)) == Set(expected.filter { $0.kind == "room" }.map(\.id)))
        for room in rooms {
            let want = expected.first { $0.kind == "room" && $0.id == room.id }
            #expect(room.unread == want?.unread, "\(room.id)")
            #expect(room.needs == want?.needs, "\(room.id)")
        }
        // Both say something: some new, some not.
        #expect(expected.contains { $0.unread } && expected.contains { !$0.unread })
    }

    @Test func besideItsChipALineSaysWhatThePWASays() {
        #expect(!agents.besides.isEmpty)
        for item in agents.besides {
            #expect(Standing(rawValue: item.state)?.beside(item.line) == item.beside, "\(item.line)")
        }
    }

    @Test func anAgentsRowOpensItsOwnConversation() {
        let rows = Roster.rows(snapshot: agents.snapshot, asks: [])
        #expect(rows.first { $0.id == "ada" }?.room == "dm-ada")
        #expect(rows.first { $0.id == "dot" }?.room == nil)
    }

    @Test func primaryLineIsThePWAs() {
        for item in agents.primary {
            let now = PrimaryNow(item.input)
            #expect(now.text == item.text)
            #expect(now.tone.rawValue == item.tone, "\(item.text)")
            // As every app shows it: what needs you first when there is any (lib/now.ts's needsFirst).
            #expect(now.line == item.needsFirst, "\(item.text)")
        }
    }

    @Test func whatWaitsOnPrimaryIsTheInboxLessTheAgentsOwnAsks() {
        for item in agents.needs {
            #expect(Roster.primaryNeeds(inbox: item.inbox, asks: agents.asks, agents: item.agents) == item.needs)
        }
        #expect(Roster.agentOfCaller("arm:team.0123456789.max") == "max")
        #expect(Roster.agentOfCaller("arm:team.012345678.max") == nil)
        #expect(Roster.agentOfCaller("loop:morning") == nil)
    }
}
