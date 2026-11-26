import Foundation
import Testing
@testable import Invincible

/// Steering an agent's running task, as the PWA has it (lib/steer.ts and lib/steps.ts, the vectors' `steer`): what the
/// task's box does while it runs (steer, or queue for after it) and the line under it, what is on its way to the work and
/// what never reached it, what its proof was judged against, and the steers its trail holds, whose words each was.
struct SteerTests {
    /// The vectors' `steer` section, read apart from the rest (Vectors.swift reads the others).
    struct Cases: Decodable {
        struct Words: Decodable { let steer: String; let queue: String; let steerTitle: String; let queueTitle: String }
        struct Action: Decodable { let running: Bool; let enter: String; let modifier: Bool; let action: String }
        struct Hint: Decodable { let status: String; let name: String; let enter: String; let coarse: Bool; let mac: Bool; let hint: String }
        struct Said: Decodable { let title: String; let lines: [String] }
        struct TaskCase: Decodable {
            struct Task: Decodable { let status: String; let steers: [TeamTask.Steer] }
            let task: Task
            let name: String
            let waiting: Said?
            let never: Said?
        }
        struct Judged: Decodable { let judged: Int?; let steers: [TeamTask.Steer]; let line: String? }
        struct Group: Decodable {
            struct Item: Decodable { let text: String; let exit: Int? }
            let kind: String
            let text: String
            let items: [Item]
            let tone: String
            let from: Int
            let to: Int
            let at: Double
            let by: String?
        }
        struct Steer: Decodable { let by: String; let text: String; let n: Int; let at: Double }
        struct JudgedWith: Decodable { let entries: [TrailEntry]; let judged: Int? }
        struct Live: Decodable {
            struct Said: Decodable { let text: String; let command: Bool; let since: Double }
            let text: String
            let live: Said?
        }
        struct Stranger: Decodable { let text: String; let groups: [Group] }
        let words: Words
        let limit: Int
        let actions: [Action]
        let hints: [Hint]
        let tasks: [TaskCase]
        let judged: [Judged]
        let trail: [TrailEntry]
        let groups: [Group]
        let steers: [Steer]
        let judgedWith: [JudgedWith]
        let live: [Live]
        let strangers: [Stranger]
    }

    private struct File: Decodable { let steer: Cases }
    private final class Token {}

    let cases: Cases = {
        let url = Bundle(for: Token.self).url(forResource: "core-vectors", withExtension: "json")!
        return try! JSONDecoder().decode(File.self, from: Data(contentsOf: url)).steer
    }()

    private func same(_ group: Steps.Group, _ want: Cases.Group) -> Bool {
        group.kind.rawValue == want.kind && group.text == want.text && group.tone.rawValue == want.tone && group.from == want.from && group.to == want.to
            && group.at == want.at && group.by == want.by && group.items.map(\.text) == want.items.map(\.text) && group.items.map(\.exit) == want.items.map(\.exit)
    }

    @Test func theBoxsWordsAndWhatSendingDoesAreThePWAs() throws {
        #expect(SteerWords.steer == cases.words.steer)
        #expect(SteerWords.queue == cases.words.queue)
        #expect(SteerWords.steerTitle == cases.words.steerTitle)
        #expect(SteerWords.queueTitle == cases.words.queueTitle)
        #expect(SteerWords.limit == cases.limit)
        #expect(cases.actions.count == 8)
        for c in cases.actions {
            let enter = try #require(ComposerWords.Enter(rawValue: c.enter))
            #expect(SteerWords.action(running: c.running, enter: enter, modifier: c.modifier).rawValue == c.action, "running \(c.running) enter \(c.enter) modifier \(c.modifier)")
        }
    }

    @Test func theLineUnderTheBoxIsThePWAs() throws {
        #expect(cases.hints.count == 24)
        for c in cases.hints {
            let enter = try #require(ComposerWords.Enter(rawValue: c.enter))
            #expect(SteerWords.hint(status: c.status, name: c.name, enter: enter, coarse: c.coarse, mac: c.mac) == c.hint, "\(c.status) \(c.enter) coarse \(c.coarse) mac \(c.mac)")
        }
    }

    @Test func whatIsOnItsWayAndWhatNeverReachedItAreThePWAs() {
        #expect(cases.tasks.count == 7)
        for c in cases.tasks {
            let waiting = SteerWords.waiting(status: c.task.status, steers: c.task.steers, name: c.name)
            #expect(waiting?.title == c.waiting?.title && waiting?.lines == c.waiting?.lines, "waiting, \(c.task.status)")
            let never = SteerWords.neverReached(status: c.task.status, steers: c.task.steers)
            #expect(never?.title == c.never?.title && never?.lines == c.never?.lines, "never, \(c.task.status)")
        }
    }

    @Test func whatItsProofWasJudgedAgainstIsThePWAs() {
        #expect(cases.judged.count == 11)
        for c in cases.judged { #expect(SteerWords.judgedLine(c.judged, steers: c.steers) == c.line, "judged \(c.judged.map(String.init) ?? "nil") of \(c.steers.count)") }
    }

    @Test func aTrailsSteersAreItsStepsAsThePWAReadsThem() {
        let groups = Steps.groups(cases.trail)
        #expect(groups.count == cases.groups.count)
        for (group, want) in zip(groups, cases.groups) { #expect(same(group, want), "\(group.text) ≠ \(want.text)") }
        #expect(Steps.steersOf(cases.trail) == cases.steers.map { Steps.TrailSteer(by: $0.by, text: $0.text, n: $0.n, at: $0.at) })
        for c in cases.judgedWith { #expect(Steps.judgedWith(c.entries) == c.judged) }
        for c in cases.live {
            let live = Steps.live([TrailEntry(n: 1, at: 0, text: c.text)])
            #expect(live?.text == c.live?.text && live?.command == c.live?.command, "\(c.text)")
        }
        // Whose words a steer was is the runner's to say: any other line with its mark is a note.
        for c in cases.strangers {
            let groups = Steps.groups([TrailEntry(n: 1, at: 0, text: c.text)])
            #expect(groups.map(\.kind.rawValue) == c.groups.map(\.kind), "\(c.text)")
            #expect(groups.allSatisfy { $0.by == nil })
        }
    }
}
