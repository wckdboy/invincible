#if os(iOS)
import ActivityKit
import Foundation
import Testing
@testable import Invincible

/// The team's one Live Activity (27 November 2026: one for each task opened stacked up on the Lock Screen): opening
/// another task in hand ends the one before at once and shows this one. Started here as the task's thread starts it.
@MainActor @Suite(.serialized) struct OneLiveActivityTests {
    private func task(_ id: String, title: String) throws -> TeamTask {
        let json: [String: Any] = [
            "id": id, "room": "room-a", "assignee": "tester", "title": title, "goal": "Make it so.", "dependsOn": [String](),
            "status": "running", "verified": false, "progress": "", "error": NSNull(), "updatedAt": 1, "changes": NSNull(),
        ]
        return try JSONDecoder().decode(TeamTask.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private var showing: [String] {
        Activity<TaskActivityAttributes>.activities.filter { $0.activityState == .active }.map(\.attributes.task)
    }

    @Test func anotherTaskOpenedEndsTheOneBeforeAndShowsItself() async throws {
        try #require(ActivityAuthorizationInfo().areActivitiesEnabled, "Live Activities are off on this simulator: nothing would be shown")
        for activity in Activity<TaskActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
        let tag = "sh.invincible.bot.tests.activity.\(UUID().uuidString)"
        defer { try? DeviceKey.delete(tag: tag) }
        // A node that isn't there: nothing listens on this port of this machine, so the tokens handed it go nowhere.
        let node = PairedNode(origin: try #require(URL(string: "http://127.0.0.1:9")), device: "c_test", name: "test", fleet: "f_test")
        let session = Session(key: try DeviceKey.create(tag: tag), node: node)
        let running = TaskActivityState(phase: "running", gates: ["running"], review: "waits", verdict: nil, gate: nil, at: 1)
        let first = try task("task-aaaaaaaaaaaa", title: "Speed up the ledger")
        let second = try task("task-bbbbbbbbbbbb", title: "Tidy the parser")
        LiveActivities.shared.start(first, agent: nil, state: running, session: session)
        LiveActivities.shared.start(second, agent: nil, state: running, session: session)
        let end = Date.now.addingTimeInterval(5)
        while showing != [second.id], Date.now < end { try await Task.sleep(for: .milliseconds(100)) }
        #expect(showing == [second.id], "on the Lock Screen at once: \(showing)")
        for activity in Activity<TaskActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    @Test func aTaskOpenedAgainEndsTheOnesAnAppFromBeforeLeftStacked() async throws {
        try #require(ActivityAuthorizationInfo().areActivitiesEnabled, "Live Activities are off on this simulator: nothing would be shown")
        for activity in Activity<TaskActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
        let tag = "sh.invincible.bot.tests.activity.\(UUID().uuidString)"
        defer { try? DeviceKey.delete(tag: tag) }
        let node = PairedNode(origin: try #require(URL(string: "http://127.0.0.1:9")), device: "c_test", name: "test", fleet: "f_test")
        let session = Session(key: try DeviceKey.create(tag: tag), node: node)
        let running = TaskActivityState(phase: "running", gates: ["running"], review: "waits", verdict: nil, gate: nil, at: 1)
        let first = try task("task-aaaaaaaaaaaa", title: "Speed up the ledger")
        // Two left showing, as an app from before kept one for each task opened.
        for id in [first.id, "task-cccccccccccc"] {
            _ = try Activity.request(attributes: TaskActivityAttributes(task: id, title: "A task", agentName: "Tester", colour: "#3abeff"), content: .init(state: running, staleDate: nil), pushType: nil)
        }
        #expect(showing.count == 2)
        LiveActivities.shared.start(first, agent: nil, state: running, session: session)
        let end = Date.now.addingTimeInterval(5)
        while showing != [first.id], Date.now < end { try await Task.sleep(for: .milliseconds(100)) }
        #expect(showing == [first.id], "on the Lock Screen at once: \(showing)")
        for activity in Activity<TaskActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}
#endif
