import Foundation

/*
 * Steering an agent's running task, in words (the PWA's lib/steer.ts, held to it by the vectors' `steer`): while a task
 * runs its message box steers it (POST /api/team/steer: its run takes the words at its next safe point, and its reviewer
 * judges the work against them) or queues a message for after it (its agent answers once the task is done). Return does
 * what this device chose (Settings → Chat, as a chat's box does), ⌘ with it the other; each has its button too.
 */
enum SteerWords {
    /// The box's two actions while a task runs, in the web's words, and what each does.
    static let steer = "Steer this task"
    static let queue = "Queue for after it"
    static let steerTitle = "It takes your words at its next safe point: a command it's running finishes first"
    static let queueTitle = "A message, kept until this task is done: its agent answers then"
    /// The most a steer holds, in characters (core's TEAM_LIMITS.steer): more is queued for after it instead.
    static let limit = 4_000

    /// What sending does from a task's box: while it runs, steer or queue as Return and its modifier say; otherwise a message.
    static func action(running: Bool, enter: ComposerWords.Enter, modifier: Bool) -> ComposerWords.Action {
        ComposerWords.action(busy: running, enter: enter, modifier: modifier, canQueue: true)
    }

    /// The line under a task's box: while it runs, what the keys do now (a phone's buttons say it themselves); queued, when
    /// its agent answers a message (after this task: the node runs an agent's work in order). Otherwise nothing.
    static func hint(status: String, name: String, enter: ComposerWords.Enter, coarse: Bool, mac: Bool) -> String {
        if status == "queued" { return "\(name) answers after this task" }
        guard status == "running", !coarse else { return "" }
        let modifier = mac ? "⌘" : "Ctrl"
        return enter == .steer ? "Enter steers \(name) · \(modifier)+Enter queues for after it" : "Enter queues for after it · \(modifier)+Enter steers \(name)"
    }

    /// A steer as a line: whose words, then what they said (its first line).
    private static func line(_ steer: TeamTask.Steer) -> String {
        "\(steer.by == "owner" ? "You" : "Your agent"): \(steer.text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")[0])"
    }

    /// What is on its way to the work: what you and your agent said that its run hasn't taken yet, in order (nil: nothing,
    /// or it has ended).
    static func waiting(status: String, steers: [TeamTask.Steer]?, name: String) -> (title: String, lines: [String])? {
        guard status == "running" else { return nil }
        let waiting = (steers ?? []).filter { $0.taken == nil }
        return waiting.isEmpty ? nil : ("On its way to \(name), at its next safe point", waiting.map(line))
    }

    /// What an ended task never took: it ended before those words reached it (nil: nothing of the kind, or it hasn't ended).
    static func neverReached(status: String, steers: [TeamTask.Steer]?) -> (title: String, lines: [String])? {
        guard status == "done" || status == "failed" || status == "stopped" else { return nil }
        let never = (steers ?? []).filter { $0.taken == nil }
        return never.isEmpty ? nil : ("It ended before this reached it", never.map(line))
    }

    /// What its proof was judged against, in a line, from how many steers its latest review judged the work against (its
    /// trail's Steps.judgedWith) and the task's steers: "Judged against its brief and your steer". Nil: none, or no review.
    static func judgedLine(_ judged: Int?, steers: [TeamTask.Steer]) -> String? {
        guard let judged, judged > 0 else { return nil }
        let taken = steers.filter { $0.taken != nil }
        let these = Array(taken.prefix(judged))
        if these.count < judged { return "Judged against its brief and \(judged == 1 ? "a steer" : "\(judged) steers, in order")" }
        if judged < taken.count { return "Judged against its brief and the first \(judged == 1 ? "" : "\(judged) ")of its \(taken.count) steers" }
        let n = judged == 1 ? "steer" : "\(judged) steers"
        let order = judged > 1 ? ", in order" : ""
        if these.allSatisfy({ $0.by == "owner" }) { return "Judged against its brief and your \(n)\(order)" }
        if these.allSatisfy({ $0.by == "primary" }) { return "Judged against its brief and your agent's \(n)\(order)" }
        return "Judged against its brief and \(judged) steers, yours and your agent's\(order)"
    }
}
