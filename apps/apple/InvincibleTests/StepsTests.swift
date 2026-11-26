import Foundation
import Testing
@testable import Invincible

extension Vectors {
    /// A task's work folded, and what proves it (the PWA's own lib/steps.ts): what each command was, the groups of three
    /// trails, their figures, "Worked for", each gate as its round left it, the reviewer, the live line, the proof and the
    /// cost line.
    struct StepCases: Decodable {
        struct Command: Decodable { let command: String; let kind: String; let path: String? }
        struct Group: Decodable {
            struct Item: Decodable { let text: String; let exit: Int? }
            let kind: String
            let text: String
            let items: [Item]
            let tone: String
            let from: Int
            let to: Int
            let at: Double
        }
        struct Summary: Decodable { let ms: Double; let commands: Int; let failed: Int; let read: Int; let edited: Int }
        struct Record: Decodable { let startedAt: Double; let endedAt: Double }
        struct SummaryCase: Decodable { let trail: String; let record: Record?; let summary: Summary }
        struct WorkedFor: Decodable { let ms: Double; let words: String }
        struct SummaryWords: Decodable { let summary: Summary; let words: String }
        struct Gate: Decodable { let command: String; let state: String; let exit: Int?; let ms: Double?; let said: String; let before: Int? }
        struct GateCase: Decodable { let trail: String; let gates: [String]; let running: Bool; let rows: [Gate] }
        struct Review: Decodable { let verdict: String; let notes: String; let at: Double }
        struct Live: Decodable {
            struct Shown: Decodable { let text: String; let command: Bool; let since: Double }
            let text: String?
            let live: Shown?
        }
        struct Proof: Decodable { let gates: [Gate]; let passed: Int; let review: Review?; let reviewer: String; let sameModel: Bool; let provesNothing: Bool }
        struct ProofCase: Decodable {
            struct Task: Decodable { let status: String; let gates: [String] }
            let trail: String
            let task: Task
            let proof: Proof
            let entries: [TrailEntry]?
        }
        struct Cost: Decodable { let budgetUsd: Double?; let record: TeamTask.Record?; let words: String }
        let commands: [Command]
        let trails: [String: [TrailEntry]]
        let groups: [String: [Group]]
        let summaries: [SummaryCase]
        let workedFor: [WorkedFor]
        let summaryWords: [SummaryWords]
        let gates: [GateCase]
        let reviews: [String: Review?]
        let sameModel: [String: Bool]
        let live: [Live]
        let proofs: [ProofCase]
        let prices: [String: Price]
        let costs: [Cost]
    }
}

/// A task's work as T3 Code folds it, and what proves it apart from what its agent says (lib/steps.ts; your word, 26
/// November 2026: "t3code style for the agents"), checked against the PWA's own output.
struct StepsTests {
    let steps = Vectors.shared.steps

    /// A trail by its name in the vectors: the three kept, none, and the first line of the full one alone.
    private func trail(_ name: String) -> [TrailEntry] {
        switch name {
        case "none": []
        case "one": Array(steps.trails["full"]!.prefix(1))
        default: steps.trails[name]!
        }
    }

    private func same(_ mine: Steps.GateRow, _ theirs: Vectors.StepCases.Gate) -> Bool {
        mine.command == theirs.command && mine.state.rawValue == theirs.state && mine.exit == theirs.exit && mine.ms == theirs.ms && mine.said == theirs.said && mine.before == theirs.before
    }

    @Test func eachCommandIsWhatTheAgentsToolsSayItIs() {
        #expect(steps.commands.count == 12)
        for item in steps.commands {
            let kind = Steps.commandKind(item.command)
            #expect(kind.kind.rawValue == item.kind && kind.path == item.path, "\(item.command)")
        }
    }

    @Test func theWorkFoldsAsThePWAFoldsIt() {
        for (name, theirs) in steps.groups {
            let mine = Steps.groups(trail(name))
            #expect(mine.count == theirs.count, "\(name)")
            for (group, want) in zip(mine, theirs) {
                #expect(group.kind.rawValue == want.kind && group.text == want.text && group.tone.rawValue == want.tone, "\(name) \(want.text)")
                #expect(group.from == want.from && group.to == want.to && group.at == want.at, "\(name) \(want.text)")
                #expect(group.items.map(\.text) == want.items.map(\.text) && group.items.map(\.exit) == want.items.map(\.exit), "\(name) \(want.text)")
            }
        }
        // What the agent thought aloud is not a step; the gates' list and the baseline are not either.
        #expect(!Steps.groups(trail("full")).contains { $0.text.hasPrefix("Thinking") })
    }

    @Test func itsFiguresAndWorkedForAreThePWAs() {
        for item in steps.summaries {
            let summary = Steps.summary(trail(item.trail), record: item.record.map { ($0.startedAt, $0.endedAt) })
            let want = item.summary
            #expect(summary == Steps.Summary(ms: want.ms, commands: want.commands, failed: want.failed, read: want.read, edited: want.edited), "\(item.trail)")
        }
        for item in steps.workedFor { #expect(Steps.workedFor(item.ms) == item.words, "\(item.ms)") }
        for item in steps.summaryWords {
            let s = item.summary
            #expect(Steps.summaryWords(Steps.Summary(ms: s.ms, commands: s.commands, failed: s.failed, read: s.read, edited: s.edited)) == item.words)
        }
    }

    @Test func eachGateIsAsItsLatestRoundLeftIt() {
        for item in steps.gates {
            let rows = Steps.gateRows(item.gates, trail(item.trail), running: item.running)
            #expect(rows.count == item.rows.count, "\(item.trail) \(item.running)")
            for (mine, theirs) in zip(rows, item.rows) { #expect(same(mine, theirs), "\(item.trail) \(theirs.command)") }
        }
    }

    @Test func theReviewersVerdictIsThePWAs() {
        for (name, theirs) in steps.reviews {
            let mine = Steps.review(trail(name))
            #expect(mine?.verdict == theirs?.verdict && mine?.notes == theirs?.notes && mine?.at == theirs?.at, "\(name)")
        }
        for (name, same) in steps.sameModel { #expect(Steps.sameModelReview(trail(name)) == same, "\(name)") }
    }

    @Test func theLiveLineIsThePWAs() {
        let at = Vectors.shared.work.now - 3 * 60_000
        for item in steps.live {
            let entries = item.text.map { [TrailEntry(n: 1, at: at, text: $0)] } ?? []
            let live = Steps.live(entries)
            #expect(live?.text == item.live?.text && live?.command == item.live?.command && live?.since == item.live?.since, "\(item.text ?? "none")")
        }
    }

    @Test func whatProvesItIsThePWAs() {
        for item in steps.proofs {
            let proof = Steps.proof(status: item.task.status, gates: item.task.gates, item.entries ?? trail(item.trail))
            let want = item.proof
            #expect(proof.gates.count == want.gates.count, "\(item.trail)")
            for (mine, theirs) in zip(proof.gates, want.gates) { #expect(same(mine, theirs), "\(item.trail)") }
            #expect(proof.passed == want.passed && proof.reviewer == want.reviewer, "\(item.trail) \(item.task.status)")
            #expect(proof.review?.verdict == want.review?.verdict && proof.review?.notes == want.review?.notes, "\(item.trail)")
            #expect(proof.sameModel == want.sameModel && proof.provesNothing == want.provesNothing, "\(item.trail) \(item.task.status)")
        }
    }

    @Test func whatItCostIsSaidAsThePWASaysIt() {
        #expect(steps.costs.count == 10)
        for item in steps.costs {
            #expect(Steps.costWords(budgetUsd: item.budgetUsd, record: item.record, prices: steps.prices) == item.words, "\(item.words)")
        }
    }

    @Test func moneyIsRoundedAsTheWebRoundsIt() {
        // An exact half goes up, as JavaScript's toFixed takes it (printf would take it to even).
        #expect(Spend.usd(0.125) == "$0.13")
        #expect(Spend.usd(0.375) == "$0.38")
        #expect(Spend.usd(10.25) == "$10.3")
        #expect(Spend.usd(100.5) == "$101")
        // What isn't exactly a half is rounded as its exact value says: 0.015 is a little under.
        #expect(Spend.usd(0.015) == "$0.01")
        #expect(Spend.usd(0.0042) == "$0.0042")
        #expect(Spend.usd(0) == "$0")
    }
}
