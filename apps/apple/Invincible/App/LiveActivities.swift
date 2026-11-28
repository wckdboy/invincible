#if os(iOS)
import ActivityKit
import Foundation

/**
 * The app's side of the team's Live Activity (I10; core's live-activity.ts): one at a time, for the task you gave from this
 * phone or opened in hand last, with how many of the team's other tasks are at work (27 November 2026: one for each task
 * opened stacked up on the Lock Screen). Another task's ends the one before at once. It tells it how its task stands while
 * the app is in front, and hands its node the activity's own push token, so the node keeps it up through Apple's push
 * service while the app isn't (`POST /api/notify/activity`; the node keeps one for each device, as the app does).
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

    /// The team's, for a task in hand (never for one that has ended, and only where this device lets Live Activities run):
    /// one already showing it is watched again; any other task's is ended at once (one an app from before left stacked
    /// too), its node told as its end is seen.
    func start(_ task: TeamTask, agent: Agent?, state: TaskActivityState, session: Session) {
        if let running = activity(for: task.id) {
            Self.endSoon(Self.showing(besides: task.id))
            watch(running, client: session.client)
            return
        }
        guard !state.ended, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        Self.endSoon(Self.showing(besides: task.id))
        let glass = AgentGlass.of(id: task.assignee, profile: agent?.avatar)
        let attributes = TaskActivityAttributes(task: task.id, title: task.title, agentName: agent?.name ?? task.assignee, colour: AgentMark.palette[glass.color].forms.light, shape: glass.shape)
        guard let started = try? Activity.request(attributes: attributes, content: .init(state: state, staleDate: Date.now.addingTimeInterval(3600)), pushType: .token) else { return }
        watch(started, client: session.client)
    }

    /// A task this device just gave (or opened in hand): its activity started, as it stands now.
    func begin(_ task: String, session: Session) {
        guard let given = session.task(task) else { return }
        let state = TaskActivityState.of(status: given.status, verified: given.verified, error: given.error, gates: given.gates ?? [], record: given.record, entries: [], at: Date.now.timeIntervalSince1970 * 1000, others: session.othersAtWork(besides: task))
        start(given, agent: session.drawn(given.assignee), state: state, session: session)
    }

    /// While a window of the app is in front: each activity told how its task stands as the session reads the agents again
    /// (it does as the node says they moved), its trail read for its gates only as its own task's entry moved (TrailMark),
    /// and watched again after a launch. Returns when the window leaves the front.
    func keepUp(_ session: Session) async {
        var threads: [String: TaskThread] = [:]
        var marks: [String: TrailMark] = [:]
        let pace = Paced(gap: 1_000, clock: .real) { [weak self] _ in
            guard let self else { return }
            for activity in Activity<TaskActivityAttributes>.activities {
                let id = activity.attributes.task
                guard let task = session.task(id) else { continue }
                watch(activity, client: session.client)
                let thread = threads[id] ?? TaskThread(task: task)
                threads[id] = thread
                let mark = TrailMark(task)
                if marks[id] != mark {
                    marks[id] = mark
                    await thread.readTrail(with: session.client)
                }
                await update(id, TaskActivityState.of(status: task.status, verified: task.verified, error: task.error, gates: task.gates ?? [], record: task.record, entries: thread.entries, at: Date.now.timeIntervalSince1970 * 1000, others: session.othersAtWork(besides: id)))
            }
        }
        // Each task's mark as the session read it: any task's moving can move how an activity stands (the others at work).
        let stop = watching({ session.team?.tasks.map(TrailMark.init) ?? [] }) { _ in pace.want(nil) }
        // Once as the window comes to the front, each activity watched again and told how its task stands.
        pace.want(nil)
        await Session.held()
        stop()
        pace.cancel()
    }

    /// How its task stands, told to its activity while the app is in front (when that changed); its end with its verdict,
    /// kept on the Lock Screen a quarter of an hour.
    func update(_ task: String, _ state: TaskActivityState) async {
        await Self.tell(task, state)
    }

    /// The other tasks' activities showing now, by their own ids: taken as a task's is started, before it is asked for, so
    /// the ending a start sets off never ends one a later start asked for (two tasks opened in quick turn ended both).
    private static func showing(besides task: String) -> [String] {
        Activity<TaskActivityAttributes>.activities.filter { $0.attributes.task != task }.map(\.id)
    }

    /// Those activities, ended at once (as it was before one for the team, one stayed for each task opened).
    private static func endSoon(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        Task { await end(ids) }
    }

    nonisolated private static func end(_ ids: [String]) async {
        for activity in Activity<TaskActivityAttributes>.activities where ids.contains(activity.id) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
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
