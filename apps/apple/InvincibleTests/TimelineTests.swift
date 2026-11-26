import Foundation
import Testing
@testable import Invincible

/// An agent's page is the PWA's (`lib/timeline.ts`, `lib/task-card.ts`, `lib/team.ts`): the same words and work in the
/// same order, the same names for who said what, and each task's card saying what the PWA's says.
struct TimelineTests {
    let t = Vectors.shared.timelines

    @Test func wordsAndWorkStandInTheOrderTheyHappened() {
        let own = Timeline.tasks(room: ("dm-ada", true, ["ada"]), all: t.tasks)
        #expect(Timeline.items(messages: t.messages, tasks: own).map(\.id) == t.agent)
        // A room shared by several agents holds the room's own work, not each agent's everywhere.
        let shared = Timeline.tasks(room: ("dm-ada", false, ["ada", "bea"]), all: t.tasks)
        #expect(Timeline.items(messages: t.messages, tasks: shared).map(\.id) == t.room)
        // Words from a moment on: work that ended before it goes with the words before it; work in hand stays.
        #expect(Timeline.items(messages: t.messages, tasks: own, since: t.sinceAt).map(\.id) == t.since)
    }

    @Test func whoSaidItIsNamedAsThePWANamesThem() {
        let agents = Vectors.shared.agents.snapshot.agents
        #expect(t.messages.map { Timeline.speaker($0, agents: agents) } == t.speakers)
    }

    @Test func eachTasksCardSaysWhatThePWAsSays() {
        for (task, card) in zip(t.tasks, t.cards) {
            let badge = TaskCard.badge(task)
            #expect([badge.text, badge.tone.rawValue] == [card.badge.text, card.badge.tone], "\(task.id)")
            let end = TaskCard.end(task)
            #expect(end?.why == card.end?.why && end?.said == card.end?.said, "\(task.id)")
            #expect((end == nil) == (card.end == nil), "\(task.id)")
            #expect(TaskCard.actions(task).map(\.rawValue) == card.actions, "\(task.id)")
            #expect(TaskCard.given(task) == card.given, "\(task.id)")
            #expect(TaskCard.sensitive(task) == card.sensitive, "\(task.id)")
            #expect(TaskCard.kept(task) == card.kept, "\(task.id)")
            #expect(TaskCard.proposed(task, proposer: task.proposedBy == "ada" ? "Ada" : nil) == card.proposed, "\(task.id)")
            #expect(TaskCard.stepped(task) == card.stepped, "\(task.id)")
            #expect(TaskCard.shipped(task)?.text == card.shipped, "\(task.id)")
            #expect(TaskCard.againGoal(task) == card.again, "\(task.id)")
        }
        #expect(t.tasks.count == t.cards.count)
    }

    @Test func aTasksCommandsAreOneALineAndBounded() throws {
        #expect(try AgentRoom.gates(from: "  bun run check \n\n bun test a.ts\n").get() == ["bun run check", "bun test a.ts"])
        #expect(throws: NodeError.self) { try AgentRoom.gates(from: (1...17).map { "c\($0)" }.joined(separator: "\n")).get() }
        #expect(throws: NodeError.self) { try AgentRoom.gates(from: String(repeating: "x", count: 1001)).get() }
    }
}
