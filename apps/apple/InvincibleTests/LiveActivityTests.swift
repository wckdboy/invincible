import Foundation
import Testing
@testable import Invincible

/// A task on its Live Activity (I10): what the app tells its own activity while it's in front is what the node tells Apple
/// otherwise (the web lib's activityOf, the vectors' liveActivities), and the words its Lock Screen and Dynamic Island
/// say of it are the PWA's. What the node sends decodes as the activity's own state.
struct LiveActivityTests {
    @Test(arguments: Vectors.shared.liveActivities.map(\.name))
    func aTaskOnItsLiveActivityIsThePWAs(_ name: String) throws {
        let c = try #require(Vectors.shared.liveActivities.first { $0.name == name })
        let state = TaskActivityState.of(status: c.task.status, verified: c.task.verified, error: c.task.error, gates: c.task.gates, record: c.task.record, entries: c.entries, at: c.at, others: c.others)
        #expect(state == c.state)
        #expect(state.line == c.line)
        #expect(state.short == c.short)
        #expect(state.othersLine == c.othersLine)
    }

    @Test func theNodesContentStateIsTheActivitysOwn() throws {
        // As apns-send.ts sends it: `aps.content-state`, null where there is nothing to say.
        let pushed = #"{"phase":"ended","gates":["passed","failed"],"review":null,"verdict":"failed","gate":2,"at":1795700000000}"#
        let state = try JSONDecoder().decode(TaskActivityState.self, from: Data(pushed.utf8))
        #expect(state == TaskActivityState(phase: "ended", gates: ["passed", "failed"], review: nil, verdict: "failed", gate: 2, at: 1_795_700_000_000))
        #expect(state.line == "Failed · gate 2")
        #expect(state.failed)
        // A node from before says no count: nothing said of the team's other work. One that does says it.
        #expect(state.othersLine == "")
        let counted = try JSONDecoder().decode(TaskActivityState.self, from: Data(#"{"phase":"running","gates":["running"],"review":"waits","verdict":null,"gate":null,"others":3,"at":1795700000000}"#.utf8))
        #expect(counted.others == 3)
        #expect(counted.othersLine == "3 more at work")
    }
}
