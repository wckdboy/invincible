import Foundation

/*
 * The work by attention (the PWA's lib/work.ts, held to it by the vectors; your word, 26 November 2026: "project/tasks/
 * coding t3code style for the agents"; T3 Code's sidebar, its rows in three lines, what needs you first): every task as
 * a row of three lines (its project and how it stands, its title, its agent and what it is doing or came to), in one of
 * four sections by what it asks of you:
 *
 *   needs    only you can move it on: a proposal to approve, work cut short to look at, its agent asking for your approval
 *            while it works, work queued behind an agent you paused;
 *   active   a result new to you: it ended (failed, or done) after you last looked at its agent or its room, on any
 *            device, as an email is unread (a node that keeps no such mark: for half a day after it ended);
 *   working  at work, or queued;
 *   done     settled: ended and seen, or stopped.
 *
 * A project is a repository: the one an agent works in, named by a project of yours with that repository where there is
 * one, else by the repository's own last part; an agent with no repository works on other work. Pure, from what the app
 * already has: the team as one snapshot, your projects, and the approvals waiting. The phone's Home and the wide window's
 * sidebar draw these rows.
 */

/// What a task asks of you, as the section its row is in.
enum Attention: String, CaseIterable, Sendable {
    case needs, active, working, done
}

/// A project as a row names it: its repository's address without its scheme (or `other`), its name, and the letter on
/// its badge ("" for other work).
struct WorkProject: Equatable, Hashable, Sendable, Decodable {
    let key: String
    let name: String
    let badge: String
}

/// A task as a row of three lines.
struct WorkRow: Equatable, Identifiable, Sendable {
    let id: String
    let room: String
    let title: String
    let project: WorkProject
    /// Its agent: handle, name and saved avatar (the colour you chose for its orb).
    let agent: Agent
    let state: Standing
    let attention: Attention
    /// How it stands in a word or two, at the end of its first line in its state's colour: "Allow?", "Failed · gate 2",
    /// "Verified", "Working · 4m", "Queued". Never colour alone: the word says it.
    let word: String
    /// Its state's tone (Standing.tone): work, needs, failed, ok or neutral.
    let tone: String
    /// How long since it last moved ("12m", "3h", "2d"); nil at work, whose word says how long it has been in hand.
    let age: String?
    /// Its third line, after its agent's name: what it is doing, or what it came to ("bun test packages/link", "5 files
    /// kept", "gave up"). Empty: nothing more to say.
    let detail: String
    /// The detail is a command or a path, set in mono.
    let mono: Bool
    /// When it last moved: the order within a section.
    let at: Double
    /// Once it has ended, its verdict in words that follow its proof (Steps.verdict, from its record): what its row says in
    /// place of `word`, so a row never says "Verified" where its gates proved nothing. Nil while it is in hand.
    var verdict: Verdict? = nil

    struct Verdict: Equatable, Sendable {
        let word: String
        let kind: Steps.Verdict
    }

    struct Agent: Equatable, Sendable {
        let id: String
        let name: String
        let avatar: JSONValue?
    }
}

/// The work by attention: each section's rows, and the projects with tasks (the busiest first) for the filters.
struct Attended: Equatable, Sendable {
    struct Project: Equatable, Hashable, Sendable, Decodable {
        let key: String
        let name: String
        let badge: String
        let count: Int
    }

    var needs: [WorkRow] = []
    var active: [WorkRow] = []
    var working: [WorkRow] = []
    var done: [WorkRow] = []
    var projects: [Project] = []

    subscript(_ attention: Attention) -> [WorkRow] {
        get {
            switch attention {
            case .needs: needs
            case .active: active
            case .working: working
            case .done: done
            }
        }
        set {
            switch attention {
            case .needs: needs = newValue
            case .active: active = newValue
            case .working: working = newValue
            case .done: done = newValue
            }
        }
    }

    /// Every row, in the order of attention: what needs you, what is new to you, what is at work, then what is settled.
    var byAttention: [WorkRow] { needs + active + working + done }

    /// The rows of one project alone (a filter), its sections as they were; every project's with none.
    func only(_ key: String?) -> Attended {
        guard let key else { return self }
        let only = { (rows: [WorkRow]) in rows.filter { $0.project.key == key } }
        return Attended(needs: only(needs), active: only(active), working: only(working), done: only(done), projects: projects)
    }
}

enum Work {
    private static let minute = 60_000.0
    /// How long a result stays new to you on a node that keeps no read marks.
    static let newForMs = 12 * 60 * minute

    /// A span of time as a row says it, short: "now", "4m", "3h", "2d".
    static func shortSpan(_ ms: Double) -> String {
        let minutes = (max(0, ms) / minute).rounded(.down)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(Int(minutes))m" }
        let hours = (minutes / 60).rounded(.down)
        if hours < 24 { return "\(Int(hours))h" }
        return "\(Int((hours / 24).rounded(.down)))d"
    }

    /// A moment as people read it (the PWA's lib/time.ts relativeTime): "just now", "4 min ago", "3 h ago", "yesterday",
    /// "Mon", "Nov 3"; ahead, "in a moment", "in 5 min", "in 3 h", "in 2 d". Said once, not counted down: it is read again
    /// as the page is drawn again, never a second at a time.
    static func relativeTime(_ ms: Double, now: Double = Date.now.timeIntervalSince1970 * 1000, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let hour = 60 * minute, day = 24 * hour
        let delta = now - ms, future = delta < 0, gone = abs(delta)
        func wrap(_ s: String) -> String { future ? "in \(s)" : "\(s) ago" }
        if gone < 45_000 { return future ? "in a moment" : "just now" }
        if gone < hour { return wrap("\(max(1, Int((gone / minute).jsRounded))) min") }
        if gone < day { return wrap("\(Int((gone / hour).jsRounded)) h") }
        let date = Date(timeIntervalSince1970: ms / 1000), today = Date(timeIntervalSince1970: now / 1000)
        if future { return gone < 7 * day ? "in \(Int((gone / day).jsRounded)) d" : shortDate(date, today, calendar, locale) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday" }
        if gone < 6 * day { return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar).weekday(.abbreviated)) }
        return shortDate(date, today, calendar, locale)
    }

    private static func shortDate(_ date: Date, _ now: Date, _ calendar: Calendar, _ locale: Locale) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar).month(.abbreviated).day()
        return calendar.isDate(date, equalTo: now, toGranularity: .year) ? date.formatted(style) : date.formatted(style.year())
    }

    /// The letter on a project's badge: its name's first letter or digit, as a capital ("" for none).
    static func badge(_ name: String) -> String {
        guard let first = name.unicodeScalars.first(where: isLetterOrNumber) else { return "" }
        return String(first).uppercased()
    }

    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: true
        default: false
        }
    }

    /// A repository's address as one key, however it was written (case of its host, `.git`, a trailing slash); nil for
    /// anything that isn't an https address with a path.
    static func projectKey(_ repo: String) -> String? {
        guard let url = URLComponents(string: Markdown.trim(repo)), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else { return nil }
        var path = url.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix(".git") { path.removeLast(4) }
        guard path.utf16.count > 1 else { return nil }
        let port = url.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? ""
        return host.lowercased() + port + path
    }

    static let other = WorkProject(key: "other", name: "Other work", badge: "")

    /// A project of yours as the work names one (core's ProjectView: its name, and its repository if it has one).
    struct Named: Equatable, Sendable, Decodable {
        let name: String
        let repo: String?

        init(name: String, repo: String?) {
            (self.name, self.repo) = (name, repo)
        }

        init(_ project: ProjectView) {
            (name, repo) = (project.name, project.repo)
        }
    }

    /// Each agent's project (by its repository, named by a project of yours with that repository), and other work's.
    static func projects(of agents: [Agent], named projects: [Named]) -> (String) -> WorkProject {
        var names: [String: String] = [:]
        for project in projects {
            // (As a Map is made: a later project with the same repository names it.)
            if let repo = project.repo, let key = projectKey(repo) { names[key] = project.name }
        }
        var of: [String: WorkProject] = [:]
        for agent in agents {
            guard let repository = agent.repository, let key = projectKey(repository) else {
                of[agent.id] = other
                continue
            }
            let name = names[key] ?? String(key.split(separator: "/", omittingEmptySubsequences: false).last ?? "")
            of[agent.id] = WorkProject(key: key, name: name, badge: badge(name))
        }
        return { of[$0] ?? other }
    }

    /// A task's state, as its row shows it: at work; waiting on you (proposed, or cut short and yours to look at); queued;
    /// failed; verified; stopped (paused); done without verification, at rest.
    static func state(_ task: TeamTask) -> Standing {
        switch task.status {
        case "running": .working
        case "proposed", "interrupted": .needs
        case "queued": .queued
        case "failed": .failed
        case "stopped": .paused
        case "done": task.verified ? .verified : .resting
        default: .resting
        }
    }

    /// How a run said it ended, in words; any other reason is its first line.
    private static let ended = ["gave-up": "gave up", "unverified": "not verified", "stopped": "stopped"]

    /// A text's first line, trimmed (`(text ?? "").trim().split("\n")[0].trim()`).
    static func firstLine(_ text: String?) -> String {
        Markdown.trim(Markdown.trim(text ?? "").components(separatedBy: "\n").first ?? "")
    }

    /// A string cut to `length` UTF-16 units less one, with an ellipsis, when it is longer than `length` (as the web cuts).
    private static func cut(_ text: String, _ length: Int) -> String {
        let units = Array(text.utf16)
        return units.count > length ? String(decoding: units.prefix(length - 1), as: UTF16.self) + "…" : text
    }

    /// What a task's latest line says it is doing, for its row: the command it runs (mono), else the step it is at.
    static func doingNow(_ progress: String) -> (text: String, mono: Bool) {
        let line = firstLine(progress)
        let parts = line.components(separatedBy: " · ")
        let mark = parts[0]
        let said = Markdown.trim(parts.dropFirst().joined(separator: " · "))
        switch mark {
        case "Running": return (said, true)
        case "Plan": return ("planning", false)
        case "Thinking": return ("thinking", false)
        case "Submitted for review": return ("its gates run", false)
        case "Review": return ("in review", false)
        case "Exit": return ("reading what it printed", false)
        default: break
        }
        if let gate = mark.wholeMatch(of: #/Gate ([0-9]+)\/([0-9]+)/#) { return ("gate \(gate.1) of \(gate.2)", false) }
        return (cut(line, 80), false)
    }

    /// The gate a failed task's latest line says it failed at (nil: it doesn't say).
    static func failedGate(_ progress: String) -> Int? {
        guard let gate = firstLine(progress).prefixMatch(of: #/Gate ([0-9]+)\/[0-9]+ · exit (-?[0-9]+)/#), gate.2 != "0" else { return nil }
        return Int(gate.1)
    }

    /// The work by attention, from the team, your projects and the approvals waiting (`asks`: one an agent filed is its
    /// running task's to show), at `now` (milliseconds).
    static func attended(agents: [Agent], tasks: [TeamTask], seen: [String: Double]?, projects named: [Named], asks: [Ask], now: Double) -> Attended {
        let byHandle = Dictionary(agents.map { ($0.id, $0) }) { _, last in last }
        let projectOf = projects(of: agents, named: named)
        let titles = Dictionary(tasks.map { ($0.id, $0.title) }) { _, last in last }
        // What an agent asks your approval for, while its task runs (an agent works one thing at a time).
        var asking: [String: [Ask]] = [:]
        for ask in asks {
            if let agent = Roster.agentOfCaller(ask.by) { asking[agent, default: []].append(ask) }
        }
        func seenAt(_ task: TeamTask) -> Double? {
            guard let seen else { return nil }
            return max(seen["agent:\(task.assignee)"] ?? 0, seen["room:\(task.room)"] ?? 0)
        }
        var out = Attended()
        struct Count { var project: WorkProject; var count = 0; var busy = 0; var at = 0.0 }
        var counts: [String: Count] = [:]
        var order: [String] = []
        for task in tasks {
            let agent = byHandle[task.assignee]
            let name = agent?.name ?? task.assignee
            let project = projectOf(task.assignee)
            let row = rowOf(task, name: name, paused: agent.map { !$0.enabled } ?? false, asks: task.status == "running" ? asking[task.assignee] ?? [] : [], seen: seenAt(task), now: now, titles: titles)
            out[row.attention].append(WorkRow(
                id: task.id, room: task.room, title: task.title, project: project, agent: .init(id: task.assignee, name: name, avatar: agent?.avatar),
                state: row.state, attention: row.attention, word: row.word, tone: row.state.tone, age: row.age, detail: row.detail, mono: row.mono, at: task.updatedAt,
                verdict: Steps.verdict(status: task.status, verified: task.verified, error: task.error, record: task.record, facts: Steps.facts(record: task.record)).map { WorkRow.Verdict(word: $0.word, kind: $0.verdict) }
            ))
            if counts[project.key] == nil { order.append(project.key) }
            var counted = counts[project.key] ?? Count(project: project)
            counted.count += 1
            counted.busy = max(counted.busy, row.attention == .needs ? 3 : row.attention == .active ? 2 : row.attention == .working ? 1 : 0)
            counted.at = max(counted.at, task.updatedAt)
            counts[project.key] = counted
        }
        let newest = { (a: WorkRow, b: WorkRow) -> Bool in a.at != b.at ? a.at > b.at : a.id < b.id }
        out.needs.sort(by: newest)
        out.active.sort(by: newest)
        out.done.sort(by: newest)
        // At work before queued, and each the latest first.
        out.working.sort { a, b in (a.state == .working) != (b.state == .working) ? a.state == .working : newest(a, b) }
        out.projects = order.compactMap { counts[$0] }
            .sorted { a, b in
                let (ao, bo) = (a.project.key == "other", b.project.key == "other")
                if ao != bo { return !ao }
                if a.busy != b.busy { return a.busy > b.busy }
                if a.at != b.at { return a.at > b.at }
                return a.project.name.localizedCompare(b.project.name) == .orderedAscending
            }
            .map { Attended.Project(key: $0.project.key, name: $0.project.name, badge: $0.project.badge, count: $0.count) }
        return out
    }

    private struct RowState {
        let state: Standing
        let attention: Attention
        let word: String
        let age: String?
        let detail: String
        let mono: Bool
    }

    private static func rowOf(_ task: TeamTask, name: String, paused: Bool, asks: [Ask], seen: Double?, now: Double, titles: [String: String]) -> RowState {
        let age = shortSpan(now - task.updatedAt)
        func say(_ state: Standing, _ attention: Attention, _ word: String, _ detail: String = "", _ mono: Bool = false, _ shownAge: String?? = .none) -> RowState {
            RowState(state: state, attention: attention, word: word, age: shownAge ?? age, detail: detail, mono: mono)
        }
        switch task.status {
        case "proposed":
            let by = task.proposedBy != nil && task.proposedBy != task.assignee ? "proposed for \(name)" : "proposed by its agent"
            return say(.needs, .needs, "Approve?", task.proposedBy != nil ? by : "waits for your approval")
        case "interrupted":
            return say(.needs, .needs, "Interrupted", "look at it before it resumes")
        case "running":
            let doing = doingNow(task.progress)
            if let ask = asks.first {
                let named = (ask.connector?.isEmpty == false && ask.tool?.isEmpty == false) ? "\(ask.connector!).\(ask.tool!)" : "asks for your approval"
                return say(.needs, .needs, "Allow?", named, ask.connector?.isEmpty == false)
            }
            let span = shortSpan(now - (task.createdAt ?? task.updatedAt))
            return say(.working, .working, span == "now" ? "Working" : "Working · \(span)", doing.text, doing.mono, .some(nil))
        case "queued":
            if paused { return say(.needs, .needs, "Agent paused", "resume \(name) to start it") }
            let waiting = task.dependsOn.lazy.compactMap { titles[$0] }.first
            return say(.queued, .working, "Queued", waiting.map { "after “\($0)”" } ?? "")
        case "stopped":
            return say(.paused, .done, "Stopped")
        default:
            break
        }
        // Ended: done (verified, or not), or failed. New to you until you look.
        let unread = seen.map { task.updatedAt > $0 } ?? (now - task.updatedAt < newForMs)
        let attention: Attention = unread ? .active : .done
        if task.status == "done" {
            let kept = task.changes.map { "\($0.files) file\($0.files == 1 ? "" : "s") kept" } ?? ""
            let detail = task.shipped.map { shipped in shipped.pr.map { "PR #\($0)" } ?? "shipped" } ?? kept
            return task.verified ? say(.verified, attention, "Verified", detail) : say(.resting, attention, "Not verified", detail)
        }
        let why = firstLine(task.error)
        let gate = failedGate(task.progress)
        return say(.failed, attention, gate.map { "Failed · gate \($0)" } ?? "Failed", ended[why] ?? cut(why, 60))
    }

    /// What waits in the Inbox beyond the task rows that ask for it: its count, less the approvals a needs row stands for
    /// (its agent asking for your approval as its task runs). Devices asking to join, keys it asked for, notices, its own asks.
    static func inboxBeyond(_ inbox: Int, asks: [Ask], needs: [WorkRow]) -> Int {
        let asking = Set(needs.filter { $0.word == "Allow?" }.map(\.agent.id))
        return max(0, inbox - asks.filter { asking.contains(Roster.agentOfCaller($0.by) ?? "") }.count)
    }

    /// What opening a task marks as read, on every device (POST /api/team/seen): its agent's page, when the task has ended
    /// and is the latest of that agent's results still new to you. Read marks are kept by agent and by room, as a time,
    /// so this settles that agent's older results too; an older result opened first marks nothing, and the newest still
    /// waits for you. Nil: nothing to mark (still in hand, already read, or a node that keeps no marks).
    static func seenOnOpen(_ id: String, tasks: [TeamTask], seen: [String: Double]?) -> String? {
        guard let task = tasks.first(where: { $0.id == id }), let seen, task.status == "done" || task.status == "failed" else { return nil }
        func seenAt(_ one: TeamTask) -> Double { max(seen["agent:\(one.assignee)"] ?? 0, seen["room:\(one.room)"] ?? 0) }
        let unread = tasks.filter { $0.assignee == task.assignee && ($0.status == "done" || $0.status == "failed") && $0.updatedAt > seenAt($0) }
        var newest: TeamTask?
        for one in unread where newest == nil || one.updatedAt > newest!.updatedAt { newest = one }
        return newest?.id == task.id ? task.assignee : nil
    }

    /// Home's line under the primary's name: how much needs you, first (the line is amber then, and its first words agree with
    /// its colour), and how many are at work; else its own line.
    static func atAGlance(_ work: Attended, needs: Int, its: String) -> (text: String, needs: Bool) {
        let atWork = work.working.filter { $0.state == .working }.count
        let parts = [needs > 0 ? "\(needs) need\(needs == 1 ? "s" : "") you" : nil, atWork > 0 ? "\(atWork) at work" : nil].compactMap(\.self)
        return parts.isEmpty ? (its, false) : (parts.joined(separator: " · "), needs > 0)
    }

    /// What an agent's tasks that ended since `since` cost at your prices, as their runner recorded them: its sum, and
    /// whether it is the whole of it. Nil: none of its tasks ended in that time with a model call counted.
    static func spentSince(_ tasks: [TeamTask], agent: String, since: Double, prices: Spend.Prices) -> (usd: Double, complete: Bool)? {
        let lines = tasks.filter { $0.assignee == agent && ($0.record?.endedAt ?? -.infinity) >= since }.flatMap { $0.record!.spent }
        guard lines.contains(where: { $0.calls > $0.unknown }) else { return nil }
        let cost = Spend.cost(lines, prices)
        return (cost.usd, cost.complete && cost.unpriced.isEmpty)
    }
}
