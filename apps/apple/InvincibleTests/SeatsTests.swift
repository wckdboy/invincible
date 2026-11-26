import Foundation
import Testing
@testable import Invincible

/// Who sits where among the agents (the primary first, then the agents as the node lists them: the PWA's
/// lib/arrange.ts `seating`), and where each stands at a glance.
struct SeatsTests {
    let agents = Vectors.shared.agents

    @Test func thePrimaryComesFirstThenTheAgentsAsTheNodeListsThem() {
        #expect(Roster.seats(agents: ["ada", "writer", "lin"]) == ["primary", "ada", "writer", "lin"])
        #expect(Roster.seats(agents: []) == ["primary"])
        #expect(Roster.seats(agents: ["lin"]).first == Primary.handle)
    }

    @Test func aSnapshotFromThisNodeSaysNoOrderOfYoursAndNoOneWhoLeads() throws {
        // Arranging the agents went with the system Invincible succeeds: a node's word of either is passed over.
        let snapshot = try JSONDecoder().decode(TeamSnapshot.self, from: Data(#"{"agents":[],"rooms":[],"tasks":[],"deliveries":[],"order":["writer","ada"],"primary":"writer"}"#.utf8))
        #expect(snapshot.agents.isEmpty)
        let older = try JSONDecoder().decode(TeamSnapshot.self, from: Data(#"{"agents":[],"rooms":[],"tasks":[],"deliveries":[]}"#.utf8))
        #expect(older.seen == nil)
    }

    @Test func eachStateIsSaidInAWordButRest() {
        // The colour is never the only sign: every state the ring colours has its word, and rest says none.
        for state in [Standing.working, .needs, .failed, .paused, .queued, .verified] { #expect(state.word?.isEmpty == false, "\(state)") }
        #expect(Standing.resting.word == nil)
        // Marked where it needs you: what it waits for, and work gone wrong.
        let rows = Roster.rows(snapshot: agents.snapshot, asks: agents.asks, now: agents.now)
        for row in rows where row.standing == .needs || row.standing == .failed { #expect(row.needs, "\(row.id)") }
    }

    @Test func thePrimarySaysWhereItStandsToo() {
        #expect(Standing.of(PrimaryNow(PrimaryWork(needs: 2)), answering: false) == .needs)
        #expect(Standing.of(PrimaryNow(PrimaryWork(turns: ["The release plan"])), answering: false) == .working)
        #expect(Standing.of(PrimaryNow(PrimaryWork(needs: 0)), answering: false) == .resting)
        // Writing an answer here, which no node's line knows of yet, is work too; what needs you still comes first.
        #expect(Standing.of(PrimaryNow(PrimaryWork(needs: 0)), answering: true) == .working)
        #expect(Standing.of(PrimaryNow(PrimaryWork(answering: true, needs: 1)), answering: true) == .needs)
    }

    @Test func thePrimaryIsCalledWhatTheNodeNamesItAndInvincibleUntilThen() {
        defer { Primary.named(nil) }
        #expect(Primary.name == "Invincible")
        Primary.named("  Atlas \n")
        #expect(Primary.name == "Atlas")
        Primary.named("   ")
        #expect(Primary.name == "Invincible")
        Primary.named(String(repeating: "x", count: 80))
        #expect(Primary.name.count == 40)
        Primary.named(nil)
        #expect(Primary.name == "Invincible")
    }
}
