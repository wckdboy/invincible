import Foundation
import Observation
import Testing
@testable import Invincible

/// A task's trail is read again only as its own entry in the team's answer moves (the lead's rule of 28 November 2026,
/// the web's and Android's too): the node writes a trail line, the task's progress and its `updatedAt` in one
/// transaction, and `team` moves with every line of every task at work. TrailMark is what of a task moves with its trail;
/// `watching` acts on what the session read once it has landed (PerfTests.testATasksTrailIsReadOnlyAsItMoves counts the
/// reads against a dev node).
@MainActor
struct TrailMarkTests {
    private func task(_ id: String, status: String = "running", progress: String = "", updatedAt: Double = 1, interventions: [String: Int]? = nil) throws -> TeamTask {
        var json: [String: Any] = [
            "id": id, "room": "room-a", "assignee": "builder", "title": "Sync survives a dropped connection", "goal": "Make it resume.",
            "dependsOn": [String](), "status": status, "verified": false, "progress": progress, "error": NSNull(), "updatedAt": updatedAt,
        ]
        if let interventions { json["interventions"] = interventions }
        return try JSONDecoder().decode(TeamTask.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func aTasksMarkMovesWithItsOwnTrail() throws {
        let still = try TrailMark(task("task-a", progress: "Running · bun test", updatedAt: 10))
        #expect(try TrailMark(task("task-a", progress: "Running · bun test", updatedAt: 10)) == still)
        // A new line: its progress and its updatedAt, written with it.
        #expect(try TrailMark(task("task-a", progress: "Exit 0 · bun test", updatedAt: 11)) != still)
        // Its updatedAt alone (a line whose progress said the same), its status alone, how you stepped in.
        #expect(try TrailMark(task("task-a", progress: "Running · bun test", updatedAt: 12)) != still)
        #expect(try TrailMark(task("task-a", status: "done", progress: "Running · bun test", updatedAt: 10)) != still)
        #expect(try TrailMark(task("task-a", progress: "Running · bun test", updatedAt: 10, interventions: ["message": 1])) != still)
        // None at all and none counted are the same.
        #expect(try TrailMark(task("task-a", progress: "Running · bun test", updatedAt: 10, interventions: [:])) == still)
    }

    @Observable final class Box {
        var tasks: [TeamTask] = []
        var other = 0
    }

    /// Another task's lines move the team's answer, never this task's mark; this task's moving reaches the watcher once
    /// the answer holding it has landed, and nothing after it is stopped.
    @Test func aWatchActsOnlyOnItsOwnTasksMoves() async throws {
        let box = Box()
        box.tasks = [try task("task-a", progress: "Running · held", updatedAt: 5), try task("task-b", progress: "Running · step 1", updatedAt: 5)]
        var seen: [TrailMark?] = []
        let stop = watching({ box.tasks.first { $0.id == "task-a" }.map(TrailMark.init) }) { seen.append($0) }
        func settle() async { for _ in 0..<20 { await Task.yield() } }

        box.tasks = [try task("task-a", progress: "Running · held", updatedAt: 5), try task("task-b", progress: "Exit 0 · step 1", updatedAt: 6)]
        box.other += 1
        await settle()
        #expect(seen.isEmpty, "Another task's line moved this task's watch")

        box.tasks = [try task("task-a", progress: "Exit 0 · held", updatedAt: 7), try task("task-b", progress: "Exit 0 · step 1", updatedAt: 6)]
        await settle()
        #expect(seen.count == 1)
        #expect(seen.first??.progress == "Exit 0 · held")

        stop()
        box.tasks = [try task("task-a", status: "done", progress: "Review · pass", updatedAt: 8)]
        await settle()
        #expect(seen.count == 1, "A stopped watch acted")
    }
}
