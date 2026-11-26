#if os(iOS)
import ActivityKit
import Foundation

/**
 * The app's side of a task's Live Activity (I10; core's live-activity.ts): it starts one when you give a task from this
 * phone or open one in hand, tells it how its task stands while the app is in front, and hands its node the activity's
 * own push token, so the node keeps it up through Apple's push service while the app isn't (`POST /api/notify/activity`).
 * Its title is given here, on the device: the node's pushes carry none. A node that doesn't know the route refuses the
 * token, and the activity is still kept up from here while the app is in front.
 */
@MainActor final class LiveActivities {
    static let shared = LiveActivities()
    /// The activities whose token and end are being watched (by their own id).
    private var watched = Set<String>()

    /// What the node is told of one: its task, its token in hex (nil: forget it), and the service its build answers to.
    private struct Kept: Encodable {
        let task: String
        let token: String?
        let environment: String
        // (A token of nil is said as null: the node's door takes no missing key.)
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(task, forKey: .task)
            try c.encode(token, forKey: .token)
            try c.encode(environment, forKey: .environment)
        }
        private enum CodingKeys: String, CodingKey { case task, token, environment }
    }

    /// A task's activity, while there is one.
    func activity(for task: String) -> Activity<TaskActivityAttributes>? {
        Activity<TaskActivityAttributes>.activities.first { $0.attributes.task == task }
    }

    /// One for a task in hand, once (never for one that has ended, and only where this device lets Live Activities run);
    /// one already running is watched again.
    func start(_ task: TeamTask, agent: Agent?, state: TaskActivityState, session: Session) {
        if let running = activity(for: task.id) {
            watch(running, client: session.client)
            return
        }
        guard !state.ended, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let mark = AgentMark.of(id: task.assignee, profile: agent?.avatar)
        let attributes = TaskActivityAttributes(task: task.id, title: task.title, agentName: agent?.name ?? task.assignee, colour: AgentMark.palette[mark.color].forms.light, form: mark.form)
        guard let started = try? Activity.request(attributes: attributes, content: .init(state: state, staleDate: Date.now.addingTimeInterval(3600)), pushType: .token) else { return }
        watch(started, client: session.client)
    }

    /// A task this device just gave (or opened in hand): its activity started, as it stands now.
    func begin(_ task: String, session: Session) {
        guard let given = session.task(task) else { return }
        let state = TaskActivityState.of(status: given.status, verified: given.verified, error: given.error, gates: given.gates ?? [], record: given.record, entries: [], at: Date.now.timeIntervalSince1970 * 1000)
        start(given, agent: session.drawn(given.assignee), state: state, session: session)
    }

    /// While a window of the app is in front: each activity told how its task stands as the node says the agents moved
    /// (its trail read for its gates), and watched again after a launch. Returns when the window leaves the front.
    func keepUp(_ session: Session) async {
        var threads: [String: TaskThread] = [:]
        let stop = session.follow(["team"], every: nil, gap: 1_000) { [weak self] in
            guard let self else { return }
            for activity in Activity<TaskActivityAttributes>.activities {
                let id = activity.attributes.task
                guard let task = session.task(id) else { continue }
                watch(activity, client: session.client)
                let thread = threads[id] ?? TaskThread(task: task)
                threads[id] = thread
                await thread.readTrail(with: session.client)
                await update(id, TaskActivityState.of(status: task.status, verified: task.verified, error: task.error, gates: task.gates ?? [], record: task.record, entries: thread.entries, at: Date.now.timeIntervalSince1970 * 1000))
            }
        }
        await Session.held()
        stop()
    }

    /// How its task stands, told to its activity while the app is in front (when that changed); its end with its verdict,
    /// kept on the Lock Screen a quarter of an hour.
    func update(_ task: String, _ state: TaskActivityState) async {
        await Self.tell(task, state)
    }

    /// (Away from the main actor: an activity isn't Sendable, so it is looked up where it is told.)
    nonisolated private static func tell(_ task: String, _ state: TaskActivityState) async {
        guard let activity = Activity<TaskActivityAttributes>.activities.first(where: { $0.attributes.task == task }) else { return }
        var shown = activity.content.state
        shown.at = state.at
        guard shown != state else { return }
        if state.ended {
            await activity.end(.init(state: state, staleDate: nil), dismissalPolicy: .after(Date.now.addingTimeInterval(15 * 60)))
        } else {
            await activity.update(.init(state: state, staleDate: Date.now.addingTimeInterval(3600)))
        }
    }

    /// Its push token handed to the node as Apple gives it (and gives it anew); forgotten there once it ends or is
    /// dismissed.
    private func watch(_ activity: Activity<TaskActivityAttributes>, client: NodeClient) {
        guard watched.insert(activity.id).inserted else { return }
        let task = activity.attributes.task
        let environment = PushCenter.shared.environment
        Task {
            for await token in activity.pushTokenUpdates {
                _ = try? await client.post("/api/notify/activity", Kept(task: task, token: Push.hex(token), environment: environment), as: JSONValue.self)
            }
        }
        Task {
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                _ = try? await client.post("/api/notify/activity", Kept(task: task, token: nil, environment: environment), as: JSONValue.self)
                watched.remove(activity.id)
                break
            }
        }
    }
}
#endif
