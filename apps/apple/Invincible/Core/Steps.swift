import Foundation

/*
 * A task's work, folded (the PWA's lib/steps.ts, held to it by the vectors; T3 Code's "Worked for 2m 14s ›", its steps
 * grouped: "Read 6 files", "Edited 3 files", "Ran 4 commands"), and what proves it, told apart from what its agent says:
 * each gate's command and how it ended, and the reviewer's verdict, as the runner wrote them on the task's trail (POST
 * /api/team/trail), never the agent's own account. Pure, from the trail's lines as the node keeps them: each starts with
 * its step's mark, "Running · …", "Exit 0 · …", "Gate 1/2 · exit 0 · …", "Review · pass".
 */

/// One line of a task's trail, as the node keeps it: its number in order (from 1), when (ms), and the line.
struct TrailEntry: Codable, Equatable, Sendable {
    let n: Int
    let at: Double
    let text: String
}

enum Steps {
    enum Kind: String, Sendable { case plan, read, edit, run, submitted, gate, review, note, steer }
    enum Tone: String, Sendable { case neutral, ok, failed, warn }

    /// One line of the work, folded: a step of its own (its plan, a gate, the review, a note), or a run of steps alike.
    struct Group: Equatable, Sendable {
        struct Item: Equatable, Sendable {
            let text: String
            let exit: Int?
        }
        let kind: Kind
        /// The line it folds to: "Read 6 files in packages/link", "Edited sync.ts and resume.ts", "Ran 4 commands · 1 failed".
        let text: String
        /// What is in it, a line each (a command or a path, set in mono), with each command's exit where it is known.
        let items: [Item]
        let tone: Tone
        /// The trail's numbers it spans, and when it began.
        let from: Int
        let to: Int
        let at: Double
        /// A steer's: whose words they were, "owner" or "primary" (nil on every other step).
        var by: String? = nil
    }

    /// A steer on a task's trail (the PWA's TrailSteer): whose words, what they said, and the line it was taken at.
    struct TrailSteer: Equatable, Sendable {
        let by: String
        let text: String
        let n: Int
        let at: Double
    }

    struct Summary: Equatable, Sendable {
        /// From its first line to its last (or the runner's record of when it began and ended, where there is one).
        let ms: Double
        let commands: Int
        let failed: Int
        /// Files it read, and files it edited or wrote, each counted once.
        let read: Int
        let edited: Int
    }

    enum GateState: String, Sendable { case passed, failed, running, waiting }

    struct GateRow: Equatable, Sendable {
        let command: String
        let state: GateState
        let exit: Int?
        /// How long it took, from the line before its result to its result (nil: not run in this round).
        let ms: Double?
        /// What it printed, its first line that says anything.
        let said: String
        /// How it exited before any work (the gates run first): 0 means it passed already, so it shows nothing about the work.
        let before: Int?
    }

    struct Review: Equatable, Sendable {
        let verdict: String
        let notes: String
        let at: Double
    }

    /// A trail line read: its mark and what follows it.
    private enum Line {
        case plan(String)
        case command(String)
        case exit(Int)
        case gate(index: Int, of: Int, exit: Int, command: String, output: String)
        case gates([String])
        case gated
        case baseline([Int])
        case submitted(String)
        case review(verdict: String, notes: String)
        case thought
        case note(text: String, tone: Tone)
        /// Your words to it, or your agent's, where its run took them ("Steered · You: …").
        case steer(by: String, text: String)
        /// What the review after it judged the work against: its goal and this many steers ("Judged · …").
        case judged(steers: Int)
    }

    private static let noteTone: [String: Tone] = [
        "Tripwire": .warn, "Check": .neutral, "Audit": .neutral, "Budget": .warn, "Retry": .neutral, "Escalated": .warn, "Routed": .neutral,
        "Tests changed": .warn, "Contract": .neutral, "Steps": .neutral, "Lease": .warn, "No command to run": .neutral, "Review": .warn,
    ]

    /// A line of the trail, read by its mark.
    private static func read(_ text: String) -> Line {
        let lines = text.components(separatedBy: "\n")
        let head = lines[0]
        let rest = Array(lines.dropFirst())
        let body = rest.joined(separator: "\n")
        let at = head.range(of: " · ", options: .literal)
        let mark = at.map { String(head[..<$0.lowerBound]) } ?? head
        let said = at.map { String(head[$0.upperBound...]) } ?? ""
        let joined = { [said, body].filter { !$0.isEmpty }.joined(separator: "\n") }
        switch mark {
        case "Plan": return .plan(joined())
        case "Running": return .command(joined())
        case "Thinking": return .thought
        case "Submitted for review": return .submitted(said)
        case "Gates before the work":
            return .baseline(([said] + rest).compactMap { line in line.prefixMatch(of: #/[0-9]+\. exit (-?[0-9]+) · /#).flatMap { Int($0.1) } })
        default: break
        }
        if let exit = mark.wholeMatch(of: #/Exit (-?[0-9]+)/#), let code = Int(exit.1) { return .exit(code) }
        if let gate = mark.wholeMatch(of: #/Gate ([0-9]+)\/([0-9]+)/#), let after = said.wholeMatch(of: #/exit (-?[0-9]+) · ([\s\S]*)/#),
           let index = Int(gate.1), let of = Int(gate.2), let code = Int(after.1) {
            return .gate(index: index, of: of, exit: code, command: String(after.2), output: body)
        }
        if mark == "Gates" {
            // "Gates · 1. bun test\n2. bun run typecheck" (the list), or "Gates · all 2 passed" / "1 of 2 failed: back to the work".
            let listed = ([said] + rest).compactMap { line in line.wholeMatch(of: #/[0-9]+\. ([\s\S]+)/#).map { String($0.1) } }
            return listed.isEmpty ? .gated : .gates(listed)
        }
        if mark == "Review", said == "pass" || said == "revise" { return .review(verdict: said, notes: Markdown.trim(body)) }
        // (Whose words a steer was is the runner's to say: "You" or "Your agent", and nothing else.)
        if mark == "Steered" {
            let by: String? = said.hasPrefix("You: ") ? "owner" : said.hasPrefix("Your agent: ") ? "primary" : nil
            if let by { return .steer(by: by, text: [String(said.dropFirst(by == "owner" ? 5 : 12)), body].filter { !$0.isEmpty }.joined(separator: "\n")) }
        }
        if mark == "Judged", let judged = said.wholeMatch(of: #/against its goal and ([0-9]+) steers?, in order/#), let steers = Int(judged.1) { return .judged(steers: steers) }
        return .note(text: head, tone: noteTone[mark] ?? .neutral)
    }

    /// A shell word at the start of `text` ('quoted', as the tools quote a path, or bare), and what follows it.
    private static func word(_ text: String) -> (word: String, rest: String)? {
        let units = Array(text.utf16)
        let quote = UInt16(UInt8(ascii: "'")), backslash = UInt16(UInt8(ascii: "\\"))
        func string(_ slice: ArraySlice<UInt16>) -> String { String(decoding: slice, as: UTF16.self) }
        if units.first == quote {
            var out: [UInt16] = []
            var i = 1
            while true {
                guard let close = units[i...].firstIndex(of: quote) else { return nil }
                out += units[i..<close]
                // '\'' is a quote inside a quoted word.
                if close + 3 < units.count, units[close + 1] == backslash, units[close + 2] == quote, units[close + 3] == quote {
                    out.append(quote)
                    i = close + 4
                    continue
                }
                return (string(out[...]), string(units[(close + 1)...]))
            }
        }
        guard let end = units.firstIndex(where: Markdown.isSpace) ?? (units.isEmpty ? nil : units.endIndex), end > 0 else { return nil }
        return (string(units[..<end]), string(units[end...]))
    }

    /// What a command was, as the agent's own tools say their calls: a file read, edited or written, or a command run.
    static func commandKind(_ command: String) -> (kind: Kind, path: String?) {
        if let reading = command.wholeMatch(of: #/sed -n '[0-9]+,[0-9]+p' ([\s\S]+)/#), let path = word(String(reading.1)), Markdown.trim(path.rest).isEmpty {
            return (.read, path.word)
        }
        if let editing = command.wholeMatch(of: #/edit ([\s\S]+)/#), let path = word(String(editing.1)), path.rest.prefixMatch(of: #/( --all)? <<'/#) != nil {
            return (.edit, path.word)
        }
        if let writing = command.wholeMatch(of: #/cat > ([\s\S]+)/#), let path = word(String(writing.1)), path.rest.hasPrefix(" <<'") {
            return (.edit, path.word)
        }
        return (.run, nil)
    }

    private static func firstLine(_ text: String) -> String { Markdown.trim(Markdown.trim(text).components(separatedBy: "\n")[0]) }

    private static func baseName(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let last = trimmed.components(separatedBy: "/").last ?? ""
        return last.isEmpty ? path : last
    }

    private static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : many ?? "\(one)s")" }

    /// The folder every path is in, under the task's own workspace (nil: none in common, or only the workspace itself).
    private static func commonFolder(_ paths: [String]) -> String? {
        let parts = paths.map { path -> [String] in
            let inside = path.replacing(#/^\/work\/tasks\/task-[a-z0-9_-]{12}\//#, with: "", maxReplacements: 1)
            return Array(inside.components(separatedBy: "/").dropLast())
        }
        guard let first = parts.first else { return nil }
        var shared: [String] = []
        var i = 0
        while parts.allSatisfy({ i < $0.count && $0[i] == first[i] }) {
            shared.append(first[i])
            i += 1
        }
        let folder = shared.joined(separator: "/")
        return !folder.isEmpty && folder != "/" ? folder : nil
    }

    /// Names, as a sentence: "a.ts", "a.ts and b.ts", "a.ts, b.ts and c.ts"; more than three are counted.
    private static func named(_ names: [String]) -> String {
        if names.count > 3 { return "" }
        return names.count == 1 ? names[0] : "\(names.dropLast().joined(separator: ", ")) and \(names.last ?? "undefined")"
    }

    private struct Raw {
        let text: String
        var exit: Int?
        let path: String?
    }

    private static func groupText(_ kind: Kind, _ items: [Raw]) -> (text: String, tone: Tone) {
        if kind == .run {
            let failed = items.filter { $0.exit != nil && $0.exit != 0 }.count
            let text = items.count == 1 ? "Ran \(firstLine(items[0].text))" : "Ran \(plural(items.count, "command"))"
            guard failed > 0 else { return (text, .neutral) }
            return ("\(text) · \(failed == items.count && items.count == 1 ? "failed" : "\(failed) failed")", .warn)
        }
        var paths: [String] = []
        for item in items {
            let path = item.path ?? item.text
            if !paths.contains(path) { paths.append(path) }
        }
        let names = named(paths.map(baseName))
        let folder = commonFolder(paths)
        let verb = kind == .read ? "Read" : "Edited"
        return (!names.isEmpty ? "\(verb) \(names)" : "\(verb) \(plural(paths.count, "file"))\(folder.map { " in \($0)" } ?? "")", .neutral)
    }

    /// The work, folded: steps alike in a row become one group (reads, edits, commands), and the plan, each gate, the
    /// review and each note of the runner's stand alone, in the order they happened. What the agent thought aloud is not
    /// a step.
    static func groups(_ entries: [TrailEntry]) -> [Group] {
        var groups: [Group] = []
        var open: (kind: Kind, from: Int, to: Int, at: Double, raw: [Raw])?
        func close() {
            guard let shut = open else { return }
            let (text, tone) = groupText(shut.kind, shut.raw)
            groups.append(Group(kind: shut.kind, text: text, items: shut.raw.map { .init(text: $0.text, exit: $0.exit) }, tone: tone, from: shut.from, to: shut.to, at: shut.at))
            open = nil
        }
        for entry in entries {
            let line = read(entry.text)
            switch line {
            case .thought, .gates, .gated, .baseline, .judged:
                continue
            case .exit(let code):
                if var shut = open, let last = shut.raw.last, last.exit == nil {
                    shut.raw[shut.raw.count - 1].exit = code
                    shut.to = entry.n
                    open = shut
                }
                continue
            case .command(let command):
                let what = commandKind(command)
                if open == nil || open!.kind != what.kind {
                    close()
                    open = (what.kind, entry.n, entry.n, entry.at, [])
                }
                open!.raw.append(Raw(text: what.kind == .run ? firstLine(command) : (what.path ?? command), exit: nil, path: what.path))
                open!.to = entry.n
                continue
            default:
                break
            }
            close()
            func one(_ kind: Kind, _ text: String, _ tone: Tone, _ items: [Group.Item] = [], by: String? = nil) {
                groups.append(Group(kind: kind, text: text, items: items, tone: tone, from: entry.n, to: entry.n, at: entry.at, by: by))
            }
            switch line {
            case .plan(let text):
                one(.plan, "Planned the work", .neutral, text.components(separatedBy: "\n").filter { !Markdown.trim($0).isEmpty }.map { .init(text: Markdown.trim($0), exit: nil) })
            case .submitted:
                one(.submitted, "Submitted it for its gates and review", .neutral)
            case .gate(let index, let of, let exit, let command, _):
                one(.gate, "Gate \(index) of \(of) · \(exit == 0 ? "passed" : "failed, exit \(exit)")", exit == 0 ? .ok : .failed, [.init(text: command, exit: exit)])
            case .review(let verdict, let notes):
                one(.review, verdict == "pass" ? "The reviewer passed it" : "The reviewer sent it back", verdict == "pass" ? .ok : .warn, notes.isEmpty ? [] : [.init(text: firstLine(notes), exit: nil)])
            case .note(let text, let tone):
                one(.note, text, tone)
            case .steer(let by, let text):
                one(.steer, "\(by == "owner" ? "You" : "Your agent"): \(firstLine(text))", .neutral, [.init(text: text, exit: nil)], by: by)
            default:
                break
            }
        }
        close()
        return groups
    }

    /// The steers on a task's trail, in the order its run took them.
    static func steersOf(_ entries: [TrailEntry]) -> [TrailSteer] {
        entries.compactMap { entry in
            if case .steer(let by, let text) = read(entry.text) { return TrailSteer(by: by, text: text, n: entry.n, at: entry.at) }
            return nil
        }
    }

    /// How many steers the latest review judged the work against, as its runner said on the line just before it ("Judged ·
    /// against its goal and 2 steers, in order"): a run taken up again is told each steer anew, so its trail can hold one
    /// twice, and only the runner's count is right. No such line: none. Nil: no review yet.
    static func judgedWith(_ entries: [TrailEntry]) -> Int? {
        for i in entries.indices.reversed() {
            guard case .review = read(entries[i].text) else { continue }
            if i > entries.startIndex, case .judged(let steers) = read(entries[i - 1].text) { return steers }
            return 0
        }
        return nil
    }

    /// What the work came to in figures, for its folded line ("Worked for 6m 12s · ran 14 commands · edited 5 files").
    static func summary(_ entries: [TrailEntry], record: (startedAt: Double, endedAt: Double)? = nil) -> Summary {
        var commands = 0, failed = 0
        var read = Set<String>(), edited = Set<String>()
        var last: Kind?
        for entry in entries {
            switch Self.read(entry.text) {
            case .command(let command):
                let what = commandKind(command)
                last = what.kind
                if what.kind == .read { read.insert(what.path!) } else if what.kind == .edit { edited.insert(what.path!) } else { commands += 1 }
            case .exit(let code) where last == .run && code != 0:
                failed += 1
                last = nil
            default:
                break
            }
        }
        let ms = record.map { max(0, $0.endedAt - $0.startedAt) } ?? (entries.count > 1 ? max(0, entries[entries.count - 1].at - entries[0].at) : 0)
        return Summary(ms: ms, commands: commands, failed: failed, read: read.count, edited: edited.count)
    }

    /// A span of work as its folded line says it: "42s", "6m 12s", "1h 04m".
    static func workedFor(_ ms: Double) -> String {
        let seconds = max(0, Int(FieldOrb.jsRound(ms / 1000)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(pad(seconds % 60))s" }
        return "\(minutes / 60)h \(pad(minutes % 60))m"
    }

    private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// The folded line's figures after its time, as words: "ran 14 commands · edited 5 files".
    static func summaryWords(_ summary: Summary) -> String {
        [
            summary.commands > 0 ? "ran \(plural(summary.commands, "command"))" : nil,
            summary.edited > 0 ? "edited \(plural(summary.edited, "file"))" : summary.read > 0 ? "read \(plural(summary.read, "file"))" : nil,
        ].compactMap(\.self).joined(separator: " · ")
    }

    /// Each of a task's gates (`gates`: its commands, yours first) as its latest round left it, from the runner's lines:
    /// passed or failed with its exit and how long it took; running (the first without a result, while the task is at work
    /// and has been submitted); or waiting. With how each exited before any work: a gate that passed then shows nothing.
    static func gateRows(_ gates: [String], _ entries: [TrailEntry], running: Bool) -> [GateRow] {
        // The gates as the runner knows them (yours, and the planner's own), where its trail lists them.
        var commands = gates
        var before: [Int] = []
        var round = -1
        for (i, entry) in entries.enumerated() {
            switch read(entry.text) {
            case .gates(let listed): commands = listed
            case .baseline(let exits): before = exits
            case .submitted: round = i
            default: break
            }
        }
        var results: [Int: (exit: Int, ms: Double, said: String)] = [:]
        var lastAt = round >= 0 ? entries[round].at : 0
        if round >= 0 {
            for entry in entries[(round + 1)...] {
                if case .gate(let index, _, let exit, _, let output) = read(entry.text) {
                    results[index - 1] = (exit, max(0, entry.at - lastAt), firstSaid(output))
                    lastAt = entry.at
                }
            }
        }
        var next = running && round >= 0
        return commands.enumerated().map { i, command in
            let exitBefore = i < before.count ? before[i] : nil
            if let result = results[i] {
                return GateRow(command: command, state: result.exit == 0 ? .passed : .failed, exit: result.exit, ms: result.ms, said: result.said, before: exitBefore)
            }
            let state: GateState = next ? .running : .waiting
            next = false
            return GateRow(command: command, state: state, exit: nil, ms: nil, said: "", before: exitBefore)
        }
    }

    /// The first line of what a command printed that says something (not its exit, not "stderr:"; not the runner's own
    /// line, "exit 0" or "exit 0 · 12 ms", which the gate's row says already).
    private static func firstSaid(_ output: String) -> String {
        let line = output.components(separatedBy: "\n").map(Markdown.trim).first { line in
            !line.isEmpty && line != "stderr:" && line != "(no output)" && line.wholeMatch(of: #/exit -?[0-9]+( · [0-9]+ ms\b.*)?/#) == nil
        } ?? ""
        let units = Array(line.utf16)
        return units.count > 200 ? String(decoding: units.prefix(200), as: UTF16.self) : line
    }

    /// The reviewer's latest verdict, as the runner wrote it (nil: no review yet).
    static func review(_ entries: [TrailEntry]) -> Review? {
        for entry in entries.reversed() {
            if case .review(let verdict, let notes) = read(entry.text) { return Review(verdict: verdict, notes: notes, at: entry.at) }
        }
        return nil
    }

    /// Whether the review was by the same model that did the work after all (no other reviewer model could answer).
    static func sameModelReview(_ entries: [TrailEntry]) -> Bool { entries.contains { $0.text.hasPrefix("Review · by the same model") } }

    /// What a running task is doing this moment, as its live line says it: the command it runs (and since when), or the step.
    static func live(_ entries: [TrailEntry]) -> (text: String, command: Bool, since: Double)? {
        guard let last = entries.last else { return nil }
        switch read(last.text) {
        case .command(let command): return (firstLine(command), true, last.at)
        case .submitted: return ("Running its gates", false, last.at)
        case .gate(let index, let of, _, _, _): return (index < of ? "Running gate \(index + 1) of \(of)" : "The reviewer is reading it", false, last.at)
        case .plan: return ("Starting on its plan", false, last.at)
        case .review(let verdict, _): return (verdict == "pass" ? "Keeping its changes" : "Back to the work", false, last.at)
        case .exit: return ("Reading what it printed", false, last.at)
        case .thought: return ("Thinking", false, last.at)
        case .steer(let by, _): return (by == "owner" ? "Taking up your words" : "Taking up your agent's words", false, last.at)
        default: return ("Working", false, last.at)
        }
    }

    /// What proves a task, in one place: its gates as they stand, the reviewer's state, and the two ways a pass can say
    /// less than it seems (a review by the model that did the work; gates that passed before any work).
    struct Proof: Equatable, Sendable {
        let gates: [GateRow]
        let passed: Int
        let review: Review?
        /// passed or sent back: its verdict; reading: every gate of this round passed and the work is with it; waits: the
        /// gates come first; none: it never got there.
        let reviewer: String
        let sameModel: Bool
        /// Every gate passed before any work: none of them shows the work was done, and the reviewer decided alone.
        let provesNothing: Bool
    }

    static func proof(status: String, gates: [String], _ entries: [TrailEntry]) -> Proof {
        let running = status == "running"
        let rows = gateRows(gates, entries, running: running)
        let passed = rows.filter { $0.state == .passed }.count
        let review = review(entries)
        let reviewer = review.map { $0.verdict == "pass" ? "passed" : "sent back" } ?? (!running ? "none" : !rows.isEmpty && passed == rows.count ? "reading" : "waits")
        return Proof(gates: rows, passed: passed, review: review, reviewer: reviewer, sameModel: sameModelReview(entries), provesNothing: !rows.isEmpty && rows.allSatisfy { $0.before == 0 })
    }

    /// The facts a verdict is read from (the PWA's ProofFacts): each gate's exit at the end and before the work, the
    /// reviewer's last verdict, and whether that review was by the model that did the work.
    struct Facts: Equatable, Sendable {
        struct Gate: Equatable, Sendable {
            let exit: Int?
            let before: Int?
        }
        let gates: [Gate]
        let review: String?
        let sameModel: Bool
    }

    /// The facts its trail gives (the PWA's factsOfProof).
    static func facts(_ proof: Proof) -> Facts {
        Facts(gates: proof.gates.map { Facts.Gate(exit: $0.exit, before: $0.before) }, review: proof.review?.verdict, sameModel: proof.sameModel)
    }

    /// The facts its record keeps (the PWA's factsOfRecord); nil from a record made before they were kept.
    static func facts(record: TeamTask.Record?) -> Facts? {
        guard let proof = record?.proof else { return nil }
        return Facts(gates: proof.after.enumerated().map { Facts.Gate(exit: $0.element, before: $0.offset < proof.before.count ? proof.before[$0.offset] : nil) }, review: proof.review, sameModel: proof.sameModel)
    }

    enum Verdict: String, Sendable {
        case proven, reviewed, failed, rejected, gaveUp = "gave-up", stopped, unverified
    }

    /// A task's verdict in words that follow its proof, once it has ended (the PWA's verdictOf; the owner's word, 26
    /// November 2026: never "Verified" above a warning that its gates proved nothing): Proven, Reviewed, not proven
    /// (Reviewed where nothing says what its gates showed), Failed · gate 2, Sent back, Gave up, Stopped, Failed, Not
    /// verified. Nil while it is in hand.
    static func verdict(status: String, verified: Bool, error: String?, record: TeamTask.Record?, facts: Facts?) -> (word: String, verdict: Verdict)? {
        guard ["done", "failed", "stopped"].contains(status) else { return nil }
        let how = record?.ended ?? (error ?? "").trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")[0].trimmingCharacters(in: .whitespaces)
        if status == "stopped" || how == "stopped" { return ("Stopped", .stopped) }
        if status == "done", verified {
            guard let facts else { return ("Reviewed", .reviewed) }
            let shows = facts.gates.contains { $0.exit == 0 && $0.before != nil && $0.before != 0 }
            return shows && facts.review == "pass" && !facts.sameModel ? ("Proven", .proven) : ("Reviewed, not proven", .reviewed)
        }
        if let failing = facts?.gates.firstIndex(where: { $0.exit != nil && $0.exit != 0 }) { return ("Failed · gate \(failing + 1)", .failed) }
        if facts?.review == "revise" { return ("Sent back", .rejected) }
        if how == "gave-up" { return ("Gave up", .gaveUp) }
        return status == "failed" ? ("Failed", .failed) : ("Not verified", .unverified)
    }

    /// What a task cost, in a line: its money at your prices (a lower bound with "at least" when a call went uncounted, "no
    /// price" when a model that answered has none) against its budget, and how long it ran, as the runner recorded it.
    /// Before it has ended, its budget alone (the runner records its spend at the end).
    static func costWords(budgetUsd: Double?, record: TeamTask.Record?, prices: Spend.Prices) -> String {
        let budget = budgetUsd.map(Spend.usd)
        guard let record else { return budget.map { "budget \($0)" } ?? "" }
        let total = Spend.total(record.spent)
        let cost = Spend.cost(record.spent, prices)
        let money: String? = total.calls == 0 ? nil : total.unknown == total.calls ? "spend unknown" : !cost.unpriced.isEmpty ? "no price" : "\(cost.complete ? "" : "at least ")\(Spend.usd(cost.usd))"
        let spent: String? = money.map { money in budget.map { "\(money) of \($0)" } ?? money } ?? (budget.map { "budget \($0)" } ?? (total.calls == 0 ? "no model calls" : nil))
        // (A run of under half a second says no time: never "0s".)
        let ran = record.endedAt - record.startedAt
        return [spent, ran >= 500 ? workedFor(ran) : nil].compactMap(\.self).filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
