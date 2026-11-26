import Foundation

/// A word said in a room of the agents (core's `TeamMessage`).
struct TeamMessage: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let room: String
    /// owner (you), primary, system, or an agent's id.
    let speaker: String
    let speakerName: String
    let text: String
    let createdAt: Double
    /// The files a message of yours carried (nil: none).
    var attachments: [AttachmentRef]? = nil
}

/// `POST /api/team/room`: a room with its words, its work and the replies on their way.
struct TeamRoomView: Decodable, Sendable {
    let id: String
    let name: String
    let members: [String]
    let direct: Bool
    let paused: Bool
    let messages: [TeamMessage]
    let tasks: [TeamTask]
    let deliveries: [TeamDelivery]
}

/**
 * An agent is one timeline: what was said and the tasks it was given, in the order they happened (the PWA's
 * lib/timeline.ts). A task sits where it was given and stays there while it runs and after it ends, so nothing in the
 * timeline moves under you. What a task's card says comes from lib/task-card.ts, and who said what from lib/team.ts.
 */
enum Timeline {
    enum Item: Identifiable, Sendable {
        case message(TeamMessage)
        case task(TeamTask)

        var id: String {
            switch self {
            case .message(let message): message.id
            case .task(let task): "task:\(task.id)"
            }
        }

        var at: Double {
            switch self {
            case .message(let message): message.createdAt
            case .task(let task): task.createdAt ?? task.updatedAt
            }
        }
    }

    /// `since`: where the words begin, when the node sent only the latest of them. Tasks that ended before it are left
    /// out with the words they went with; work still in hand is always there.
    static func items(messages: [TeamMessage], tasks: [TeamTask], since: Double? = nil) -> [Item] {
        var shown = tasks
        if let since {
            shown = tasks.filter { task in (task.createdAt ?? 0) >= since || ["proposed", "queued", "running"].contains(task.status) }
        }
        // The node lists tasks latest first: turned round, two given at the same moment keep the order they were given in.
        let all: [Item] = messages.map { Item.message($0) } + shown.reversed().map { Item.task($0) }
        // A stable sort: at the same moment, the words come before the work they asked for.
        let placed = all.enumerated().sorted { a, b in a.element.at != b.element.at ? a.element.at < b.element.at : a.offset < b.offset }
        return placed.map { $0.element }
    }

    /// The tasks a conversation's timeline holds: for an agent's own, every task given to it, wherever; for a room, the room's.
    static func tasks(room: (id: String, direct: Bool, members: [String]), all: [TeamTask]) -> [TeamTask] {
        let agent = room.direct && room.members.count == 1 ? room.members[0] : nil
        return all.filter { task in
            if let agent { return task.assignee == agent }
            return task.room == room.id
        }
    }

    /// Who said it, as the timeline names them.
    static func speaker(_ message: TeamMessage, agents: [Agent]) -> String {
        switch message.speaker {
        case "owner": return "You"
        case "primary": return "Your agent"
        case "system": return "The agents"
        default:
            if !message.speakerName.isEmpty { return message.speakerName }
            return agents.first { $0.id == message.speaker }?.name ?? message.speaker
        }
    }
}

/// What a task's card says, in words (lib/task-card.ts): where it stands, how it ended and why, what the agent said of
/// it, what can be done with it, who gave it to the agents, and what it kept.
enum TaskCard {
    enum Tone: String, Sendable { case ok, warn, danger, accent, neutral }
    enum Action: String, Sendable { case approve, decline, stop, resume, again, ship }

    /// Where it stands, toned as status is everywhere: green only for verified work.
    static func badge(_ task: TeamTask) -> (text: String, tone: Tone) {
        switch task.status {
        case "proposed": ("Waiting for you", .accent)
        case "queued": ("Queued", .neutral)
        case "running": ("Running", .accent)
        case "done": task.verified ? ("Verified", .ok) : ("Not verified", .warn)
        case "failed": ("Failed", .danger)
        case "stopped": ("Stopped", .neutral)
        case "interrupted": ("Interrupted", .warn)
        default: (task.status, .neutral)
        }
    }

    private static let runEnds = [
        "gave-up": "It gave up.",
        "unverified": "Not verified: its gates or the independent review did not pass.",
        "stopped": "It stopped before the work was done.",
    ]
    private static let unsaid = ["failed": "It failed without saying why.", "stopped": "Stopped.", "interrupted": "Interrupted. Review it before resuming.", "done": "The work was not independently verified."]
    /// As much of what the agent said as a card shows.
    private static let saidLength = 1000

    /// How it ended: why it wasn't verified (nil: it was), and what the agent said of it. Nil for work still in hand.
    static func end(_ task: TeamTask) -> (why: String?, said: String?)? {
        if ["proposed", "queued", "running"].contains(task.status) { return nil }
        let output = task.output ?? ""
        let summary = Markdown.trim(output.components(separatedBy: "\n\nReview:")[0])
        let units = Array(summary.utf16)
        let said: String? = summary.isEmpty || summary.hasPrefix("Review:") ? nil
            : units.count > saidLength ? String(decoding: units.prefix(saidLength - 1), as: UTF16.self) + "…" : summary
        if task.status == "done", task.verified { return (nil, said) }
        let error = task.error.map(Markdown.trim) ?? ""
        let why = error.isEmpty ? unsaid[task.status] : (runEnds[error] ?? error)
        return (why, said)
    }

    /// Where a try's lesson begins in a goal: replaced by the next try's, never piled up.
    private static let lastTime = "\n\nLast time ("

    /// What a task given again is asked: what was asked before, and when it ran and wasn't verified, what came of it (why,
    /// what the agent said of its work, what the independent review said), so the next try starts from there. Only the
    /// latest try's is kept; a task stopped, cut off or verified is asked again as it was (the PWA's againGoal).
    static func againGoal(_ task: TeamTask) -> String {
        let asked = task.goal.components(separatedBy: lastTime)[0]
        let ran = task.status == "failed" || (task.status == "done" && !task.verified)
        guard ran, let ended = end(task), let why = ended.why else { return asked }
        let reviewed = (task.output ?? "").components(separatedBy: "\n\nReview:")
        let review = reviewed.count > 1 ? Markdown.trim(reviewed[1].components(separatedBy: "\nWorkspace:")[0]) : ""
        var lines = ["\(asked)\(lastTime)\(task.id)), it ended without verified work: \(why)"]
        if let said = ended.said { lines.append("What it said of its work: \(cut(said, 600))") }
        // (A verdict alone, PASS or FAIL, says nothing more.)
        if review.utf16.contains(where: Markdown.isSpace) { lines.append("What the independent review said: \(cut(review, 1500))") }
        let units = Array(lines.joined(separator: "\n").utf16)
        return String(decoding: units.prefix(8000), as: UTF16.self)
    }

    private static func cut(_ text: String, _ max: Int) -> String {
        let units = Array(text.utf16)
        return units.count > max ? String(decoding: units.prefix(max - 1), as: UTF16.self) + "…" : text
    }

    /// A proposal approved or declined; work in hand stopped; work that ended unverified resumed or given again; verified
    /// work it kept shipped as a pull request (not a fix: that goes onto its own).
    static func actions(_ task: TeamTask) -> [Action] {
        if task.status == "proposed" { return [.approve, .decline] }
        if task.status == "queued" || task.status == "running" { return [.stop] }
        if task.status == "done" { return !task.verified ? [.again] : task.changes != nil && task.fix == nil && task.shipped == nil ? [.ship] : [] }
        return [.resume, .again]
    }

    /// Its pull request, once you shipped it (nil: not shipped from an app).
    static func shipped(_ task: TeamTask) -> (text: String, url: String)? {
        guard let shipped = task.shipped else { return nil }
        return (shipped.pr.map { "Pull request #\($0)" } ?? "Its pull request", shipped.url)
    }

    /// Sensitive mode for this task alone: the models every call of its work is held to (nil: not in it).
    static func sensitive(_ task: TeamTask) -> String? {
        guard let models = task.models, !models.isEmpty else { return nil }
        return "Sensitive mode: on \(models.joined(separator: ", ")) alone"
    }

    /// Who gave it to the agents rather than to an agent by name (nil: it was given by name).
    static func given(_ task: TeamTask) -> String? {
        switch task.givenBy {
        case "owner": "Given to the agents by you"
        case "primary": "Given to the agents by your agent"
        default: nil
        }
    }

    /// Who wrote it, when an agent did (nil: you or the primary gave it); `proposer` is that agent's name.
    static func proposed(_ task: TeamTask, proposer: String?) -> String? {
        guard let by = task.proposedBy else { return nil }
        return task.status == "proposed" ? "\(proposer ?? by) proposes this: it starts when you approve it" : "Proposed by \(proposer ?? by)"
    }

    /// How you stepped in on it, the north star's count (nil: you never did): core's interventionWords.
    static func stepped(_ task: TeamTask) -> String? {
        let kinds = ["approval", "message", "takeover", "stop", "resume", "again", "rewritten"]
        let number = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
        func count(_ n: Int) -> String { n < number.count ? number[n] : String(n) }
        let parts: [String] = kinds.compactMap { kind in
            guard let n = task.interventions?[kind], n > 0 else { return nil }
            switch kind {
            case "approval": return n == 1 ? "an approval" : "\(count(n)) approvals"
            case "message": return n == 1 ? "a message" : "\(count(n)) messages"
            case "takeover": return "its desktop taken over"
            case "stop": return n == 1 ? "a stop" : "\(count(n)) stops"
            case "resume": return n == 1 ? "a resume" : "\(count(n)) resumes"
            case "rewritten": return n == 1 ? "rewritten" : "rewritten \(count(n)) times"
            default: return n == 1 ? "given again" : "given again \(count(n)) times"
            }
        }
        guard let last = parts.last else { return nil }
        let words = parts.count == 1 ? last : "\(parts.dropLast().joined(separator: ", ")) and \(last)"
        return "You stepped in: \(words)"
    }

    /// What it kept of its changes (nil: nothing kept).
    static func kept(_ task: TeamTask) -> String? {
        task.changes.map { "\($0.files) file\($0.files == 1 ? "" : "s") changed" }
    }
}

extension TaskCard {
    /// The words an agent may end on that only claim what its proof says ("Verified.", "Done."): beside the proof they
    /// would say the verdict twice, and in the agent's voice, so a thread leaves them out.
    private static let bareClaims: Set<String> = ["verified", "done", "proven", "passed", "pass", "complete", "completed", "finished", "ok", "success", "succeeded"]

    /// What the agent said, as a thread shows it under its proof (I10: the verdict is the proof's alone): its own account
    /// as it said it, or nothing where it said no more than a verdict.
    static func saidBesideProof(_ said: String?) -> String? {
        guard let trimmed = said?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        let word = trimmed.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces))
        return bareClaims.contains(word) ? nil : trimmed
    }

    /// Why it ended as it did, beside its verdict's word, never that word again: "It gave up." beside Gave up says nothing,
    /// and "Not verified: its gates…" beside Not verified says only the rest.
    static func because(_ why: String?, verdict: String) -> String? {
        guard let why = why?.trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty else { return nil }
        let plain = { (text: String) in text.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces)) }
        var said = plain(why)
        if said.hasPrefix("it ") { said = String(said.dropFirst(3)) }
        if said == plain(verdict) { return nil }
        for joint in [":", " ·", " –", " —"] where why.lowercased().hasPrefix(verdict.lowercased() + joint) {
            let rest = why.dropFirst(verdict.count + joint.count).trimmingCharacters(in: .whitespaces)
            return rest.isEmpty ? nil : rest.prefix(1).uppercased() + rest.dropFirst()
        }
        return why
    }

    /// The one answer a thread offers in full (its prominent button), and the rest (its menu): a proposal approved, work
    /// cut short resumed, verified work shipped, work that wasn't verified given again; stopping, declining and the
    /// others a tap further. Work in hand or verified with nothing to ship has no answer in full.
    static func answers(_ task: TeamTask) -> (prominent: Action?, rest: [Action]) {
        switch task.status {
        case "proposed": return (.approve, [.decline])
        case "queued", "running": return (nil, [.stop])
        case "done":
            guard task.verified else { return (.again, []) }
            return (task.changes != nil && task.fix == nil && task.shipped == nil ? .ship : nil, [.again])
        case "failed": return (.again, [.resume])
        case "stopped", "interrupted": return (.resume, [.again])
        default: return (nil, actions(task))
        }
    }
}
