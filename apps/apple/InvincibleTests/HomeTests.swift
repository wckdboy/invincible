import Foundation
import Testing
@testable import Invincible

/// Home as a chat app's list (the owner's word of 28 November 2026: Grok Bot's look): your agent pinned first, then the
/// agents and the rooms by their latest work, each row's line, its time as a chat list says it, and what waits on you in
/// whose chat.
struct HomeTests {
    let agents = Vectors.shared.agents

    private func primary(needs: Int = 0) -> Home.Row {
        Home.Row(kind: .primary, id: Primary.handle, name: "Your agent", line: "Start a chat", at: nil, needs: needs, standing: .resting)
    }

    @Test func yourAgentIsFirstThenTheLatestWorkFirst() throws {
        let snapshot = agents.snapshot
        let roster = Roster.rows(snapshot: snapshot, asks: agents.asks, now: agents.now)
        let rooms = Roster.roomRows(snapshot: snapshot)
        let rows = Home.rows(primary: primary(), agents: roster, rooms: rooms, snapshot: snapshot, needs: [:])
        #expect(rows.first?.kind == .primary)
        #expect(rows.count == 1 + roster.count + rooms.count)
        // The rest by when each last did something: none known after every known one.
        let times = rows.dropFirst().map(\.at)
        let known = times.compactMap(\.self)
        #expect(known == known.sorted(by: >))
        if let firstUnknown = times.firstIndex(where: { $0 == nil }) { #expect(times[firstUnknown...].allSatisfy { $0 == nil }) }
        // An agent's time is its tasks' latest change, or its own conversation's.
        for row in rows where row.kind == .agent {
            let latest = snapshot.tasks.filter { $0.assignee == row.id }.map(\.updatedAt).max()
            if let latest { #expect((row.at ?? 0) >= latest, "\(row.id)") }
        }
    }

    #if os(iOS)
    @MainActor @Test func whatWaitsOnYouIsCountedOnWhoseChatItWaitsIn() {
        let decisions = [
            Decision(id: "action:a", lead: .agent(id: "builder", avatar: nil), who: "", what: "", answer: nil, rest: [], open: {}),
            Decision(id: "task:t", lead: .agent(id: "builder", avatar: nil), who: "", what: "", answer: nil, rest: [], open: {}),
            Decision(id: "pairing:p", lead: .symbol("iphone"), who: "", what: "", answer: nil, rest: [], open: {}),
            Decision(id: "key:k", lead: .symbol("key"), who: "", what: "", answer: nil, rest: [], open: {}),
        ]
        #expect(HomeList.needs(decisions) == ["builder": 2, Primary.handle: 2])
        // In a chat: an agent's own approvals (its proposals are answered on its tasks' rows there); everything that is no
        // agent's in your agent's.
        #expect(NeedsCard.mine(decisions, agent: "builder").map(\.id) == ["action:a"])
        #expect(NeedsCard.mine(decisions, agent: nil).map(\.id) == ["pairing:p", "key:k"])
        #expect(NeedsCard.mine(decisions, agent: "writer").isEmpty)
    }
    #endif

    @Test func yourAgentsLineSaysWhatItIsDoingElseWhatWasLastSaid() {
        #expect(Home.primaryLine(PrimaryWork(answering: true, step: "Reading sync.ts"), latest: nil, title: nil) == "Reading sync.ts")
        #expect(Home.primaryLine(PrimaryWork(answering: true), latest: nil, title: nil) == "Writing…")
        #expect(Home.primaryLine(PrimaryWork(turns: ["Fix sync"]), latest: nil, title: nil) == "Working in “Fix sync”")
        #expect(Home.primaryLine(PrimaryWork(turns: ["a"], runs: ["b"]), latest: nil, title: nil) == "Working on 2 things")
        #expect(Home.primaryLine(PrimaryWork(unread: ["The release"]), latest: nil, title: nil) == "New answer in “The release”")
        // What waits on you is the row's count, never said again in its line.
        #expect(Home.primaryLine(PrimaryWork(needs: 3), latest: "## Done\nThe board is green.", title: "Release") == "Done")
        #expect(Home.primaryLine(PrimaryWork(), latest: nil, title: "Release") == "Release")
        #expect(Home.primaryLine(PrimaryWork(), latest: nil, title: nil) == "Start a chat")
    }

    @Test func aTimeIsSaidAsAChatListSaysIt() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_US")
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 15)))
        let ms = { (date: Date) in date.timeIntervalSince1970 * 1000 }
        let morning = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 9, minute: 41)))
        #expect(Home.when(ms(morning), now: now, calendar: calendar, locale: locale).contains("9:41"))
        let yesterday = try #require(calendar.date(byAdding: .day, value: -1, to: now))
        #expect(Home.when(ms(yesterday), now: now, calendar: calendar, locale: locale) == "Yesterday")
        let tuesday = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: 10)))
        #expect(Home.when(ms(tuesday), now: now, calendar: calendar, locale: locale) == "Tuesday")
        let october = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 2, hour: 10)))
        #expect(!Home.when(ms(october), now: now, calendar: calendar, locale: locale).isEmpty)
        #expect(Home.when(ms(october), now: now, calendar: calendar, locale: locale) != "Yesterday")
    }

    @Test func searchFindsRowsByTheirNameOrLineYourAgentAmongThem() {
        let rows = [
            primary(),
            Home.Row(kind: .agent, id: "builder", name: "Builder", line: "Sync survives a dropped connection", at: 2, needs: 0, standing: .working),
            Home.Row(kind: .room, id: "room-1", name: "Release", line: "Ops · Ship 0.4", at: 1, needs: 1, standing: .needs),
        ]
        #expect(Home.filter(rows, query: "").count == 3)
        #expect(Home.filter(rows, query: "sync").map(\.id) == ["builder"])
        #expect(Home.filter(rows, query: "RELEASE ship").map(\.id) == ["room-1"])
        #expect(Home.filter(rows, query: "your").map(\.id) == [Primary.handle])
        #expect(Home.filter(rows, query: "nothing like it").isEmpty)
    }

    @Test func aRuleIsSaidAsTheWebSaysIt() {
        #expect(Permissions.sentence(.init(does: "halt", words: ["*.lock"])) == "Halts the work when a word matches *.lock.")
        #expect(Permissions.sentence(.init(does: "refuse", words: [".env*", "migrations/**", "rm"])) == "Refuses the command when a word matches .env*, migrations/** or rm.")
        #expect(Permissions.sentence(.init(does: "check", words: ["*.ts"], run: "bunx tsc --noEmit")) == "Runs bunx tsc --noEmit after a command that succeeds, when a word matches *.ts.")
        #expect(Permissions.sentence(.init(does: "tell", words: [], contains: "deploy")) == "Tells you when a command has run, when it holds “deploy”.")
        #expect(Permissions.sentence(.init(does: "halt", words: ["git"], contains: "push --force")) == "Halts the work when a word matches git and it holds “push --force”.")
    }

    @Test func aSeatAndAGrantAreReadAsTheNodeWritesThem() throws {
        let seat = try JSONDecoder().decode(SeatView.self, from: Data(#"{"id":"seat-1","kind":"claude-subscription","vendor":"anthropic","label":"Claude","node":"n_a","provider":null,"runs":2,"plan":"max","method":null,"state":{"is":"ready","renewBy":null},"windows":[],"serves":[]}"#.utf8))
        #expect(seat.kindWords == "Claude plan")
        #expect(seat.stateWords == "Signed in · max")
        let grant = try JSONDecoder().decode(HandoffGrantView.self, from: Data(#"{"from":{"id":"n_a","name":"keep"},"to":{"id":"n_b","name":"ultra"},"terms":{"agents":["builder"],"budgetUsdPerDay":5},"via":null,"at":1,"by":{"id":"n_a","name":"keep"}}"#.utf8))
        #expect(Permissions.terms(grant) == "To builder · up to $5.00 a day")
        let rules = try JSONDecoder().decode([RuleView].self, from: Data(#"[{"name":"locks","rule":{"on":"command","does":"halt","words":["*.lock"]},"setAt":1,"setVia":null},{"name":"newer","rule":null,"setAt":2,"setVia":"d_x"}]"#.utf8))
        #expect(rules.map(\.name) == ["locks", "newer"])
        #expect(rules[1].rule == nil)
    }
}
