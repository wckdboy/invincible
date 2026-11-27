import Foundation

/*
 * The agents, as the PWA's roster says it (apps/web/src/lib/roster.ts): the primary first (its line is lib/now.ts), then
 * each agent, every row one line of latest activity and a mark when it needs you. Worked out from what the app already
 * asks the node: the team as one snapshot and the approvals waiting. Nothing is asked for per row. (The PWA also shows
 * the last thing said in a conversation it has read; this app reads no conversation yet, so that line never comes.)
 */

/// An approval waiting for your answer: who asked, and for what.
struct Ask: Decodable, Sendable, Equatable {
    let by: String
    let connector: String?
    let tool: String?
}

struct RosterRow: Sendable, Equatable, Identifiable {
    /// The agent's handle.
    let id: String
    let name: String
    /// Its own conversation with you, when it has one.
    let room: String?
    let line: String
    /// Only you can move this on: a failure to read, an approval to give, work waiting on a pause.
    let needs: Bool
    /// What it is doing, as its orb shows it (AgentOrb.expression): asking when it asks for your approval, else
    /// what it is doing.
    var expression = "idle"
    /// Where it stands at a glance: the ring round its face, and the word beside its name.
    var standing = Standing.resting
    /// Something ended on its page since you last looked (a reply to you, a task's end): new to you until you open it.
    var unread = false
}

/// Where someone among the agents stands, at a glance (lib/agent-state.ts): the colour of the ring round its face, and
/// the word beside its name, so the colour is never the only sign. At work; it needs you (your approval of
/// work it proposes, work cut short for you to look at); its latest work failed; paused by you; work queued; work that
/// passed review a moment ago; at rest, which says no word: its line says what it is for. The PWA's, held to it by the
/// vectors.
enum Standing: String, Sendable, Equatable {
    case working, needs, failed, paused, queued, verified, unread, resting

    /// The chip's words (lib/agent-state.ts' STATES), short so a name keeps its room beside them; nil at rest.
    var word: String? {
        switch self {
        case .working: "Working"
        case .needs: "Needs you"
        case .failed: "Failed"
        case .paused: "Paused"
        case .queued: "Queued"
        // (Verified work is new to you until you look: never "Verified" over a verdict that may say it wasn't proven.)
        case .verified: "New"
        case .unread: "New"
        case .resting: nil
        }
    }

    /// The primary's, from its line (lib/agent-state.ts' primaryState): what needs you first, then work in hand or an answer
    /// it is writing here, then an answer of its you haven't read; at rest otherwise.
    static func of(_ now: PrimaryNow, answering: Bool) -> Standing {
        now.tone == .warn ? .needs : now.tone == .accent || answering ? .working : now.tone == .ok ? .unread : .resting
    }

    /// A line as it reads beside this state's chip (lib/agent-state.ts' `besideChip`): the chip's words aren't said
    /// twice. A line that begins with them ("Failed: “X”", "Paused · 2 waiting") loses them there, and one that is only
    /// them ("Paused") leaves the chip to say it (empty). Where no chip is shown, a line keeps them.
    func beside(_ line: String) -> String {
        guard let word else { return line }
        if line == word { return "" }
        for joint in [": ", " · "] where line.hasPrefix(word + joint) { return String(line.dropFirst(word.count + joint.count)) }
        return line
    }
}

/// A room of the agents: its agents' conversation together, and one line of where it stands (lib/roster.ts' room row).
struct RoomRow: Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let members: [String]
    let line: String
    let needs: Bool
    /// A reply or a task ended there since you last looked, on any device: new to you until you open it.
    var unread = false
}

enum Roster {
    /// The agent that filed an approval (`arm:team.<controller>.<handle>`), or nil when someone else asked.
    static func agentOfCaller(_ by: String) -> String? {
        by.wholeMatch(of: #/arm:team\.[a-f0-9]{10}\.([a-z][a-z0-9-]{0,31})/#).map { String($0.1) }
    }

    /// What waits for you that is no agent's: the Inbox's count, less the approvals that show on an agent's own row.
    static func primaryNeeds(inbox: Int, asks: [Ask], agents: [String]) -> Int {
        max(0, inbox - asks.filter { agents.contains(agentOfCaller($0.by) ?? "") }.count)
    }

    /// Every agent, as the node lists them. `now`: what "just now" is, in milliseconds, for a face that has just been pleased or concerned.
    static func rows(snapshot: TeamSnapshot, asks: [Ask], now: Double = Date.now.timeIntervalSince1970 * 1000) -> [RosterRow] {
        snapshot.agents.map { row(for: $0, in: snapshot, asks: asks, now: now) }
    }

    /// Who sits where among the agents, top to bottom (the PWA's lib/arrange.ts `seating`): the primary first, then the
    /// agents as the node lists them (by handle). The primary is in no list of yours.
    static func seats(agents: [String]) -> [String] { [Primary.handle] + agents }

    /// Every room that isn't an agent's own conversation with you, the latest spoken in first.
    static func roomRows(snapshot: TeamSnapshot) -> [RoomRow] {
        snapshot.rooms.filter { !$0.direct }.enumerated().sorted { a, b in
            a.element.updatedAt != b.element.updatedAt ? a.element.updatedAt > b.element.updatedAt : a.offset < b.offset
        }.map { roomRow(for: $0.element, in: snapshot) }
    }

    /// Who someone is, by their id: an agent by its name; the primary, who proposes work from your backlog, by its (lib/roster.ts' `named`).
    static func named(_ id: String, in snapshot: TeamSnapshot) -> String {
        id == "primary" ? "Your agent" : snapshot.agents.first { $0.id == id }?.name ?? id
    }

    private static func roomRow(for room: TeamRoom, in snapshot: TeamSnapshot) -> RoomRow {
        let nameOf = { (id: String) in named(id, in: snapshot) }
        let jobs = snapshot.tasks.filter { $0.room == room.id }.map(Job.task) + snapshot.deliveries.filter { $0.room == room.id }.map(Job.delivery)
        let fresh = endedSince(jobs, seen: snapshot.seen?["room:\(room.id)"], keeps: snapshot.seen != nil) != nil
        let say = { (line: String, needs: Bool) in RoomRow(id: room.id, name: room.name, members: room.members, line: line, needs: needs, unread: fresh) }

        if let line = proposing(jobs, by: nameOf) { return say(line, true) }

        let working = jobs.compactMap { $0.status == "running" ? $0.task : nil }
        if let first = working.first { return say("\(working.count > 1 ? "\(working.count) at work" : nameOf(first.assignee)) · \(first.title)", false) }
        let writing = jobs.compactMap { job -> TeamDelivery? in if case .delivery(let d) = job, d.status == "running" { d } else { nil } }
        if !writing.isEmpty { return say("\(writing.map { nameOf($0.agent) }.joined(separator: ", ")) \(writing.count > 1 ? "are" : "is") writing", false) }
        let last = latest(of: jobs)
        if let wrong = trouble(last, who: last.flatMap { job in if case .delivery(let d) = job { nameOf(d.agent) } else { nil } }) { return say(wrong, true) }
        let waiting = jobs.filter { $0.status == "queued" }.count
        if room.paused { return say(waiting > 0 ? "Paused · \(waiting) waiting" : "Paused", waiting > 0) }
        return say(room.members.map(nameOf).joined(separator: ", "), false)
    }

    private enum Job {
        case task(TeamTask)
        case delivery(TeamDelivery)

        var status: String { switch self { case .task(let t): t.status; case .delivery(let d): d.status } }
        var updatedAt: Double { switch self { case .task(let t): t.updatedAt; case .delivery(let d): d.updatedAt } }
        var error: String? { switch self { case .task(let t): t.error; case .delivery(let d): d.error } }
        var task: TeamTask? { if case .task(let t) = self { t } else { nil } }
        var room: String { switch self { case .task(let t): t.room; case .delivery(let d): d.room } }
    }

    /// The latest of `jobs` that ended (done or failed), if it ended after `seen` (`snapshot.seen`'s; `keeps` false: a
    /// node that keeps none), as lib/roster.ts' `endedSince`.
    private static func endedSince(_ jobs: [Job], seen: Double?, keeps: Bool) -> Job? {
        guard keeps, let ended = latest(of: jobs.filter { $0.status == "done" || $0.status == "failed" }), ended.updatedAt > (seen ?? 0) else { return nil }
        return ended
    }

    private static func row(for person: Agent, in snapshot: TeamSnapshot, asks: [Ask], now: Double) -> RosterRow {
        let room = snapshot.rooms.first { $0.direct && $0.members == [person.id] }
        let jobs = snapshot.tasks.filter { $0.assignee == person.id }.map(Job.task) + snapshot.deliveries.filter { $0.agent == person.id }.map(Job.delivery)
        let asked = asks.filter { agentOfCaller($0.by) == person.id }
        // Its face says what its line says: asking for your approval, over whatever else it has in hand.
        let asking = !asked.isEmpty || jobs.contains { $0.status == "proposed" && $0.task != nil }
        let expression = asking ? "asking" : AgentOrb.expression(of: person, in: snapshot, now: now)
        // New to you: what ended on its page (its tasks, its replies to you) since you last looked at it there.
        let fresh = endedSince(jobs.filter { $0.task != nil || $0.room == room?.id }, seen: snapshot.seen?["agent:\(person.id)"], keeps: snapshot.seen != nil)
        // At rest, its ring is green while something that ended there is new to you (verified work says so) and until you
        // look; from a node that keeps no such thing, while its work passed review a moment ago (its face is pleased).
        let rest: Standing = snapshot.seen != nil
            ? (fresh.map { $0.task?.verified == true ? .verified : .unread } ?? .resting)
            : expression == "pleased" ? .verified : .resting
        let say = { (line: String, needs: Bool, standing: Standing) in
            RosterRow(id: person.id, name: person.name, room: room?.id, line: line, needs: needs, expression: expression, standing: standing, unread: fresh != nil)
        }

        // What only you can answer comes first: it is what the row is marked for.
        if let ask = asked.first {
            return say("Asks for approval: \(ask.connector ?? "").\(ask.tool ?? "")\(asked.count > 1 ? ", and \(asked.count - 1) more" : "")", true, .needs)
        }
        if let line = proposing(jobs, by: { id in id == person.id ? nil : named(id, in: snapshot) }) { return say(line, true, .needs) }
        if let running = jobs.first(where: { $0.status == "running" && $0.task != nil })?.task {
            let progress = firstLine(running.progress)
            return say(progress.isEmpty ? "Working on \(titled(running))" : "\(running.title) · \(progress)", false, .working)
        }
        if jobs.contains(where: { $0.status == "running" }) { return say("Writing a reply", false, .working) }
        let last = latest(of: jobs)
        // (Work the node cut short is yours to look at before it resumes; work that failed is a failure.)
        if let wrong = trouble(last) { return say(wrong, true, last?.status == "interrupted" ? .needs : .failed) }
        let waiting = jobs.filter { $0.status == "queued" }.count
        let held = !person.enabled ? "Paused" : person.turnsToday >= person.dailyTurns ? "Daily allowance spent" : nil
        // Paused is yours to lift; a spent allowance renews by itself, and needs you only while work waits on it.
        if let held { return say(waiting > 0 ? "\(held) · \(waiting) waiting" : held, waiting > 0, !person.enabled ? .paused : waiting > 0 ? .needs : .resting) }
        if let task = jobs.first(where: { $0.status == "queued" && $0.task != nil })?.task {
            let blocking = dependencies(of: task, in: snapshot.tasks).first { !$0.satisfied }
            return say(blocking.map { "Waiting for “\($0.title)”" } ?? "Queued: \(titled(task))", false, .queued)
        }
        if waiting > 0 { return say("Reply queued", false, .queued) }
        if let task = latest(of: jobs.filter { $0.task != nil })?.task { return say(ended(task), false, rest) }
        let job = firstLine(person.instructions).isEmpty ? person.role : firstLine(person.instructions)
        return say(maker(of: person, in: snapshot).map { "Made by \($0) · \(job)" } ?? job, false, rest)
    }

    /// The first line of a text, trimmed (the PWA's `firstLine`).
    static func firstLine(_ text: String?) -> String {
        let first = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? ""
        return first.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func titled(_ task: TeamTask) -> String { "“\(task.title)”" }

    /// How a run said it ended, as a task keeps it, in words (lib/roster.ts' `ENDED`); any other reason, its first line.
    private static let ended = ["gave-up": "gave up", "unverified": "not verified"]

    private static func withWhy(_ line: String, _ why: String?) -> String {
        let reason = firstLine(why)
        return reason.isEmpty ? line : "\(line) · \(ended[reason] ?? reason)"
    }

    /// The latest by when it last moved; of two at once, the first.
    private static func latest(of jobs: [Job]) -> Job? {
        jobs.reduce(nil) { latest, job in latest.map { job.updatedAt > $0.updatedAt ? job : $0 } ?? job }
    }

    /// Work that went wrong and waits to be read, in a line (nil: it didn't, or it was a stop of your own). `who`: in a
    /// room, the agent whose reply it was.
    private static func trouble(_ job: Job?, who: String? = nil) -> String? {
        guard let job, job.status == "failed" || job.status == "interrupted" else { return nil }
        if job.status == "interrupted" { return "Interrupted: \(job.task.map(titled) ?? (who.map { "\($0)'s reply" } ?? "a reply")) · review it before resuming" }
        return job.task.map { withWhy("Failed: \(titled($0))", job.error) } ?? withWhy(who.map { "\($0) couldn't reply" } ?? "Couldn't reply", job.error)
    }

    /// What waits for your approval, in a line: who proposes the latest (`by` names them, nil: the row's own agent), and
    /// how many more there are (lib/roster.ts' `proposing`). Nil: nothing waits.
    private static func proposing(_ jobs: [Job], by: (String) -> String?) -> String? {
        let proposed = jobs.compactMap { $0.status == "proposed" ? $0.task : nil }.enumerated().sorted { a, b in
            a.element.updatedAt != b.element.updatedAt ? a.element.updatedAt > b.element.updatedAt : a.offset < b.offset
        }.map(\.element)
        guard let latest = proposed.first else { return nil }
        let who = latest.proposedBy.flatMap(by)
        return "\(who.map { "\($0) proposes" } ?? "Proposes") \(titled(latest))\(proposed.count > 1 ? ", and \(proposed.count - 1) more" : "")"
    }

    /// How a task ended, when that is the latest thing to say: its verdict as its proof allows (Steps.verdict, from its
    /// record), as its card and its thread say it, never "Verified" where its gates proved nothing (lib/roster.ts).
    private static func ended(_ task: TeamTask) -> String {
        if task.status == "stopped" { return "Stopped: \(titled(task))" }
        let kept = task.changes.map { " · \($0.files) file\($0.files == 1 ? "" : "s") kept" } ?? ""
        let word = Steps.verdict(status: task.status, verified: task.verified, error: task.error, record: task.record, facts: Steps.facts(record: task.record))?.word ?? TaskCard.badge(task).text
        return "\(word): \(titled(task))\(kept)"
    }

    /// A queued task can't run until every task before it completed and passed its checks.
    private static func dependencies(of task: TeamTask, in all: [TeamTask]) -> [(title: String, satisfied: Bool)] {
        task.dependsOn.map { id in
            let parent = all.first { $0.id == id }
            return (parent?.title ?? id, parent?.status == "done" && parent?.verified == true)
        }
    }

    /// Who made an agent, when that wasn't you: the primary, or the agent that did.
    private static func maker(of person: Agent, in snapshot: TeamSnapshot) -> String? {
        guard let by = person.createdBy, by != "owner" else { return nil }
        if by == "primary" { return "your agent" }
        return snapshot.agents.first { $0.id == by }?.name ?? snapshot.removed?.first { $0.id == by }?.name ?? by
    }
}

/// What the primary is doing, for its own row: what this app watches it write, the turns the node runs, the runs in
/// hand, and what waits for you (nil: not asked yet, so nothing is said of it).
struct PrimaryWork: Decodable, Sendable, Equatable {
    /// It is answering on this screen, at `step` (nil: only just started).
    var answering = false
    var step: String?
    /// The titles of the turns the node is running (nil: a temporary chat).
    var turns: [String?] = []
    var runs: [String] = []
    var needs: Int?
    /// The titles of its chats with an answer you haven't read yet, the newest first.
    var unread: [String?] = []

    init(answering: Bool = false, step: String? = nil, turns: [String?] = [], runs: [String] = [], needs: Int? = nil, unread: [String?] = []) {
        (self.answering, self.step, self.turns, self.runs, self.needs, self.unread) = (answering, step, turns, runs, needs, unread)
    }

    // As lib/now.ts's NowInput: `step` absent is "not answering here", and null is "only just started".
    private enum Keys: String, CodingKey { case step, turns, runs, needs, unread }
    private struct Turn: Decodable { let title: String? }
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        answering = container.contains(.step)
        step = try container.decodeIfPresent(String.self, forKey: .step)
        turns = try container.decode([Turn].self, forKey: .turns).map(\.title)
        runs = try container.decode([RunView].self, forKey: .runs).map(\.goal)
        needs = try container.decodeIfPresent(Int.self, forKey: .needs)
        unread = try container.decodeIfPresent([Turn].self, forKey: .unread)?.map(\.title) ?? []
    }
}

/// Its line (lib/now.ts's `primaryNow`): the work first, then what needs you; and as every app shows it (`line`).
struct PrimaryNow: Equatable, Sendable {
    /// `ok`: an answer of its waits for you to read it, and nothing else is going on.
    enum Tone: String, Sendable { case neutral, accent, warn, ok }
    let text: String
    let tone: Tone
    /// Its line as it is shown (lib/now.ts's `needsFirst`, 26 November 2026): when something needs you, that first, then
    /// what it is doing. The line is amber then, and a phone cuts its end: "Working on: Make syn…" in amber said one thing
    /// in words and another in colour, its "· 2 things need you" cut off. Otherwise `text`, word for word; the same tone.
    let line: String

    /// How much waits for you, as it's said everywhere.
    static func needsYou(_ n: Int) -> String { "\(n) \(n == 1 ? "thing needs" : "things need") you" }

    init(_ work: PrimaryWork) {
        let inHand = work.turns.count + work.runs.count
        let needs = (work.needs ?? 0) > 0 ? Self.needsYou(work.needs!) : nil
        var doing: String?
        if work.answering {
            doing = (work.step?.isEmpty == false ? work.step : nil) ?? "Starting"
        } else if inHand > 1 {
            doing = "Working on \(inHand) things"
        } else if let turn = work.turns.first {
            doing = turn.flatMap { $0.isEmpty ? nil : "Working in “\($0)”" } ?? "Working in a temporary chat"
        } else if let run = work.runs.first {
            doing = "Working on: \(run.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")[0])"
        }
        // An answer it finished while you were away, as an email you haven't opened.
        let fresh = work.unread.count > 1 ? "\(work.unread.count) new answers" : work.unread.first.map { title in title.flatMap { $0.isEmpty ? nil : "New answer in “\($0)”" } ?? "A new answer" }
        text = doing.map { [$0, needs].compactMap { $0 }.joined(separator: " · ") } ?? needs ?? fresh ?? (work.needs == 0 ? "Idle · nothing needs you" : "Idle")
        line = doing.flatMap { doing in needs.map { "\($0) · \(doing)" } } ?? text
        tone = needs != nil ? .warn : doing != nil ? .accent : fresh != nil ? .ok : .neutral
    }
}
