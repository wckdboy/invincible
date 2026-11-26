import Foundation
import Testing
@testable import Invincible

/// What an agent is doing, as its face shows it (`taskStep`, `avatarExpression`): checked against core's own output. (Its
/// colours were its orb's until O2: an agent's mark is AgentMarkTests'.)
struct AgentOrbTests {
    let agents = Vectors.shared.agents

    @Test func aRunningTasksLineShowsAsCoreSays() {
        #expect(!Vectors.shared.faces.steps.isEmpty)
        for item in Vectors.shared.faces.steps { #expect(AgentOrb.step(item.line) == item.step, "\(item.line)") }
    }

    @Test func whatEachAgentAtTheAgentsIsDoingIsThePWAs() {
        let rows = Roster.rows(snapshot: agents.snapshot, asks: agents.asks, now: agents.now)
        #expect(rows.map(\.id) == agents.rows.map(\.id))
        for (row, expected) in zip(rows, agents.rows) { #expect(row.expression == expected.expression, "\(row.id)") }
    }
}
